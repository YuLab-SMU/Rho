//! Typed host boundary for the additive `rho:plugin@1` Component ABI.
//!
//! The Component world has no imports. Admission and generated binding
//! type-checking happen before a Store exists; instantiation and every call then
//! run under the same fuel, epoch and StoreLimits policy as the core ABI host.

use std::collections::BTreeSet;
use std::panic::{AssertUnwindSafe, catch_unwind};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use serde_json::Value;
use wasmtime::component::{Component, Linker};
use wasmtime::{Store, StoreLimits, StoreLimitsBuilder, Trap};

use crate::{
    BrokerCallIdSource, DEFAULT_WASM_FUEL, GuestStep, HOST_PROTOCOL_VERSION, HostFrame,
    HostInstanceState, HostMessage, HostProtocolError, HostProtocolErrorCode, HostRequestId,
    HostResponse, MAX_ECHO_PAYLOAD_BYTES, MAX_GUEST_BROKER_RESULT_BYTES,
    MAX_GUEST_BROKER_RESUME_BYTES, MAX_GUEST_BROKER_STEPS, MAX_GUEST_CONTRIBUTION_ENVELOPE_BYTES,
    MAX_GUEST_CONTRIBUTION_RETURN_BYTES, MAX_GUEST_STEP_BYTES, MAX_PENDING_WASM_CANCELLATIONS,
    MAX_WASM_MEMORY_BYTES, MAX_WASM_TABLE_ELEMENTS, OsBrokerCallIdSource, PackageDigest,
    WasmHostIdentity,
    wasm_host::{build_engine, step_digest, step_is_terminal, validate_guest_step},
};

pub const COMPONENT_ABI_V1: u64 = 1;
pub const MAX_WASM_COMPONENT_BYTES: usize = crate::MAX_WASM_MODULE_BYTES;
/// One guest module plus the canonical adapter/fixup module emitted for this
/// no-import world; any additional module instance is rejected.
pub const MAX_WASM_COMPONENT_INSTANCES: usize = 2;

/// Bindings generated from the repository-owned `rho:plugin@1.0.0` world.
/// WIT owns only the guest/host value contract and grants no host imports.
pub mod bindings {
    wasmtime::component::bindgen!({
        path: "wit",
        world: "plugin",
    });
}

/// A compiled, zero-import Component that has passed the pre-execution binary
/// boundary. Typed export validation occurs when constructing a lifecycle host.
pub struct AdmittedComponentPlugin {
    component: Component,
    engine: wasmtime::Engine,
    digest: PackageDigest,
}

impl std::fmt::Debug for AdmittedComponentPlugin {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("AdmittedComponentPlugin")
            .field("digest", &self.digest)
            .finish_non_exhaustive()
    }
}

impl AdmittedComponentPlugin {
    pub fn from_bytes(component_bytes: &[u8]) -> Result<Self, HostProtocolError> {
        if component_bytes.len() > MAX_WASM_COMPONENT_BYTES {
            return Err(protocol_error(HostProtocolErrorCode::ModuleTooLarge));
        }

        let engine = build_engine()?;
        let component = catch_unwind(AssertUnwindSafe(|| {
            Component::from_binary(&engine, component_bytes)
        }))
        .map_err(|_| protocol_error(HostProtocolErrorCode::InvalidModule))?
        .map_err(|_| protocol_error(HostProtocolErrorCode::InvalidModule))?;

        if component.component_type().imports(&engine).next().is_some() {
            return Err(protocol_error(HostProtocolErrorCode::ForbiddenImport));
        }

        let digest = PackageDigest::from_inventory(&[(
            b"guest-v1.component.wasm".as_slice(),
            component_bytes,
        )]);
        Ok(Self {
            component,
            engine,
            digest,
        })
    }

    pub fn digest(&self) -> &PackageDigest {
        &self.digest
    }
}

struct ComponentStoreState {
    limits: StoreLimits,
}

struct ComponentRuntime {
    store: Store<ComponentStoreState>,
    bindings: bindings::Plugin,
}

struct ComponentBrokerCallState {
    request_id: HostRequestId,
    call_id: String,
    steps: usize,
    cumulative_result_bytes: usize,
    last_step_digest: String,
}

#[derive(Default)]
struct ComponentCancellationInner {
    active: Option<HostRequestId>,
    pending: BTreeSet<HostRequestId>,
}

struct ComponentCancellationState {
    inner: Mutex<ComponentCancellationInner>,
    cancelled: AtomicBool,
}

impl ComponentCancellationState {
    fn new() -> Self {
        Self {
            inner: Mutex::new(ComponentCancellationInner::default()),
            cancelled: AtomicBool::new(false),
        }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, ComponentCancellationInner> {
        self.inner
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }
}

#[derive(Clone)]
pub struct ComponentCancellationHandle {
    engine: wasmtime::Engine,
    state: Arc<ComponentCancellationState>,
}

impl ComponentCancellationHandle {
    pub fn cancel_inflight(&self, request_id: &HostRequestId) -> bool {
        let inner = self.state.lock();
        if inner.active.as_ref() != Some(request_id) {
            return false;
        }
        self.state.cancelled.store(true, Ordering::SeqCst);
        self.engine.increment_epoch();
        drop(inner);
        true
    }

    pub fn is_inflight(&self, request_id: &HostRequestId) -> bool {
        self.state.lock().active.as_ref() == Some(request_id)
    }
}

/// One typed Component lifecycle instance. The desktop does not select this
/// host until the later dual-ABI routing package is complete.
pub struct ComponentPluginHost {
    identity: WasmHostIdentity,
    component_digest: PackageDigest,
    engine: wasmtime::Engine,
    runtime: Option<ComponentRuntime>,
    state: HostInstanceState,
    negotiated_version: Option<u64>,
    broker_call: Option<ComponentBrokerCallState>,
    broker_call_id_source: Arc<dyn BrokerCallIdSource>,
    cancellation: Arc<ComponentCancellationState>,
}

impl std::fmt::Debug for ComponentPluginHost {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("ComponentPluginHost")
            .field("identity", &self.identity)
            .field("component_digest", &self.component_digest)
            .field("state", &self.state)
            .field("negotiated_version", &self.negotiated_version)
            .field("broker_call_active", &self.broker_call.is_some())
            .field("runtime_present", &self.runtime.is_some())
            .finish_non_exhaustive()
    }
}

impl ComponentPluginHost {
    pub fn from_bytes(
        identity: WasmHostIdentity,
        component_bytes: &[u8],
    ) -> Result<Self, HostProtocolError> {
        Self::from_bytes_with_call_id_source(
            identity,
            component_bytes,
            Arc::new(OsBrokerCallIdSource),
        )
    }

    pub fn from_bytes_with_call_id_source(
        identity: WasmHostIdentity,
        component_bytes: &[u8],
        broker_call_id_source: Arc<dyn BrokerCallIdSource>,
    ) -> Result<Self, HostProtocolError> {
        let admitted = AdmittedComponentPlugin::from_bytes(component_bytes)?;
        let AdmittedComponentPlugin {
            component,
            engine,
            digest,
        } = admitted;

        // Link/type-check all generated exports before allocating guest Store
        // state or executing Component initialization.
        let linker = Linker::new(&engine);
        let instance_pre = linker
            .instantiate_pre(&component)
            .map_err(|_| protocol_error(HostProtocolErrorCode::InvalidExport))?;
        let plugin_pre = bindings::PluginPre::new(instance_pre)
            .map_err(|_| protocol_error(HostProtocolErrorCode::InvalidExport))?;

        let limits = StoreLimitsBuilder::new()
            .memory_size(MAX_WASM_MEMORY_BYTES)
            .table_elements(MAX_WASM_TABLE_ELEMENTS)
            .instances(MAX_WASM_COMPONENT_INSTANCES)
            .tables(1)
            .memories(1)
            .trap_on_grow_failure(true)
            .build();
        let mut store = Store::new(&engine, ComponentStoreState { limits });
        store.limiter(|state| &mut state.limits);
        prepare_component_store(&mut store)?;
        let bindings = catch_unwind(AssertUnwindSafe(|| plugin_pre.instantiate(&mut store)))
            .map_err(|_| protocol_error(HostProtocolErrorCode::GuestTrap))?
            .map_err(|error| protocol_error(classify_component_error(&error, false)))?;

        Ok(Self {
            identity,
            component_digest: digest,
            engine,
            runtime: Some(ComponentRuntime { store, bindings }),
            state: HostInstanceState::Created,
            negotiated_version: None,
            broker_call: None,
            broker_call_id_source,
            cancellation: Arc::new(ComponentCancellationState::new()),
        })
    }

    pub fn identity(&self) -> &WasmHostIdentity {
        &self.identity
    }

    pub fn component_digest(&self) -> &PackageDigest {
        &self.component_digest
    }

    pub fn state(&self) -> HostInstanceState {
        self.state
    }

    pub fn broker_call_active(&self) -> bool {
        self.broker_call.is_some()
    }

    pub fn active_broker_request_id(&self) -> Option<HostRequestId> {
        self.broker_call
            .as_ref()
            .map(|active| active.request_id.clone())
    }

    pub fn cancellation_handle(&self) -> ComponentCancellationHandle {
        ComponentCancellationHandle {
            engine: self.engine.clone(),
            state: Arc::clone(&self.cancellation),
        }
    }

    pub fn begin_broker_call(
        &mut self,
        request_id: HostRequestId,
        request: Value,
    ) -> Result<GuestStep, HostProtocolError> {
        self.begin_broker_call_bounded(
            request_id,
            request,
            MAX_GUEST_STEP_BYTES,
            MAX_GUEST_STEP_BYTES,
        )
    }

    pub fn begin_contribution_call(
        &mut self,
        request_id: HostRequestId,
        request: Value,
    ) -> Result<GuestStep, HostProtocolError> {
        self.begin_broker_call_bounded(
            request_id,
            request,
            MAX_GUEST_CONTRIBUTION_ENVELOPE_BYTES,
            MAX_GUEST_CONTRIBUTION_RETURN_BYTES,
        )
    }

    fn begin_broker_call_bounded(
        &mut self,
        request_id: HostRequestId,
        request: Value,
        maximum_input_bytes: usize,
        maximum_return_bytes: usize,
    ) -> Result<GuestStep, HostProtocolError> {
        if self.state != HostInstanceState::Active {
            return Err(invalid_state(self.state));
        }
        if self.broker_call.is_some() {
            return self.fail(HostProtocolErrorCode::BrokerSequenceViolation);
        }
        if !self.begin_request(&request_id) {
            return Err(protocol_error(HostProtocolErrorCode::Cancelled));
        }
        let call_id = format!("call.{:016x}", self.broker_call_id_source.next_call_id());
        let envelope = serde_json::to_vec(&serde_json::json!({
            "call_id": call_id,
            "request": request,
        }))
        .map_err(|_| protocol_error(HostProtocolErrorCode::InvalidBrokerStep))?;
        if envelope.len() > maximum_input_bytes {
            self.finish_request(&request_id);
            return Err(protocol_error(HostProtocolErrorCode::PayloadTooLarge));
        }
        let request_json = serde_json::to_string(&request)
            .map_err(|_| protocol_error(HostProtocolErrorCode::InvalidBrokerStep))?;
        let raw_step = self.call_guest(|runtime| {
            runtime.bindings.rho_plugin_guest_calls().call_begin(
                &mut runtime.store,
                &call_id,
                &request_json,
            )
        })?;
        let (step, encoded) = match decode_component_step(raw_step, &call_id, maximum_return_bytes)
        {
            Ok(step) => step,
            Err(code) => return self.fail(code),
        };
        if step_is_terminal(&step) {
            self.finish_request(&request_id);
        } else {
            self.broker_call = Some(ComponentBrokerCallState {
                request_id,
                call_id,
                steps: 1,
                cumulative_result_bytes: 0,
                last_step_digest: step_digest(&encoded),
            });
        }
        Ok(step)
    }

    pub fn resume_broker_call(
        &mut self,
        request_id: &HostRequestId,
        result: &Value,
        raw_result_bytes: usize,
    ) -> Result<GuestStep, HostProtocolError> {
        self.resume_broker_call_bounded(request_id, result, raw_result_bytes, MAX_GUEST_STEP_BYTES)
    }

    pub fn resume_contribution_call(
        &mut self,
        request_id: &HostRequestId,
        result: &Value,
        raw_result_bytes: usize,
    ) -> Result<GuestStep, HostProtocolError> {
        self.resume_broker_call_bounded(
            request_id,
            result,
            raw_result_bytes,
            MAX_GUEST_CONTRIBUTION_RETURN_BYTES,
        )
    }

    fn resume_broker_call_bounded(
        &mut self,
        request_id: &HostRequestId,
        result: &Value,
        raw_result_bytes: usize,
        maximum_return_bytes: usize,
    ) -> Result<GuestStep, HostProtocolError> {
        let Some(active) = self.broker_call.as_ref() else {
            return self.fail(HostProtocolErrorCode::BrokerSequenceViolation);
        };
        let active_request_id = active.request_id.clone();
        let active_steps = active.steps;
        let active_cumulative = active.cumulative_result_bytes;
        let call_id = active.call_id.clone();
        let previous_digest = active.last_step_digest.clone();
        if &active_request_id != request_id {
            return self.fail(HostProtocolErrorCode::BrokerSequenceViolation);
        }
        if active_steps >= MAX_GUEST_BROKER_STEPS {
            return self.fail(HostProtocolErrorCode::BrokerStepLimit);
        }
        let cumulative = match active_cumulative
            .checked_add(raw_result_bytes)
            .filter(|total| *total <= MAX_GUEST_BROKER_RESULT_BYTES)
        {
            Some(cumulative) => cumulative,
            None => return self.fail(HostProtocolErrorCode::BrokerResultLimit),
        };
        let result_json = serde_json::to_string(result)
            .map_err(|_| protocol_error(HostProtocolErrorCode::InvalidBrokerStep))?;
        if result_json.len() > MAX_GUEST_BROKER_RESUME_BYTES {
            return self.fail(HostProtocolErrorCode::BrokerResultLimit);
        }
        let raw_step = self.call_guest(|runtime| {
            runtime.bindings.rho_plugin_guest_calls().call_resume(
                &mut runtime.store,
                &call_id,
                &result_json,
            )
        })?;
        let (step, encoded) = match decode_component_step(raw_step, &call_id, maximum_return_bytes)
        {
            Ok(step) => step,
            Err(code) => return self.fail(code),
        };
        let digest = step_digest(&encoded);
        if matches!(step, GuestStep::BrokerRequest { .. }) && digest == previous_digest {
            return self.fail(HostProtocolErrorCode::BrokerSequenceViolation);
        }
        if step_is_terminal(&step) {
            self.broker_call = None;
            self.finish_request(request_id);
        } else if let Some(active) = self.broker_call.as_mut() {
            active.steps += 1;
            active.cumulative_result_bytes = cumulative;
            active.last_step_digest = digest;
        }
        Ok(step)
    }

    pub fn cancel_broker_call(
        &mut self,
        request_id: &HostRequestId,
    ) -> Result<bool, HostProtocolError> {
        let Some(active) = self.broker_call.as_ref() else {
            return Ok(false);
        };
        if &active.request_id != request_id {
            return self.fail(HostProtocolErrorCode::BrokerSequenceViolation);
        }
        let call_id = active.call_id.clone();
        let result = self.call_guest(|runtime| {
            runtime
                .bindings
                .rho_plugin_guest_calls()
                .call_cancel(&mut runtime.store, &call_id)
        })?;
        let cancelled = self.require_guest_success(result)?;
        if !cancelled {
            return self.fail(HostProtocolErrorCode::BrokerSequenceViolation);
        }
        self.broker_call = None;
        self.finish_request(request_id);
        Ok(true)
    }

    pub fn handle_frame(
        &mut self,
        frame: HostFrame,
    ) -> Result<Option<HostResponse>, HostProtocolError> {
        if &frame.instance_id != self.identity.host_instance_id() {
            return Err(protocol_error(HostProtocolErrorCode::UnknownInstance));
        }
        if matches!(
            self.state,
            HostInstanceState::Disposed | HostInstanceState::Quarantined
        ) {
            return Err(invalid_state(self.state));
        }

        match frame.message {
            HostMessage::Hello { api_version } => self.hello(api_version),
            HostMessage::Activate => self.activate(),
            HostMessage::Echo {
                request_id,
                payload,
            } => self.echo(request_id, payload),
            HostMessage::Heartbeat => self.heartbeat(),
            HostMessage::Quiesce => self.quiesce(),
            HostMessage::Dispose => self.dispose(),
            HostMessage::Cancel { request_id } => self.cancel_before_dispatch(request_id),
        }
    }

    pub fn quarantine_for_timeout(&mut self) -> bool {
        if matches!(
            self.state,
            HostInstanceState::Disposed | HostInstanceState::Quarantined
        ) {
            return false;
        }
        self.engine.increment_epoch();
        self.runtime.take();
        self.broker_call = None;
        self.clear_cancellation();
        self.state = HostInstanceState::Quarantined;
        true
    }

    fn hello(&mut self, api_version: u64) -> Result<Option<HostResponse>, HostProtocolError> {
        if self.state != HostInstanceState::Created {
            return Err(invalid_state(self.state));
        }
        if api_version != HOST_PROTOCOL_VERSION {
            return Err(protocol_error(HostProtocolErrorCode::VersionMismatch));
        }
        self.negotiated_version = Some(api_version);
        self.state = HostInstanceState::Ready;
        Ok(Some(HostResponse::Ready { api_version }))
    }

    fn activate(&mut self) -> Result<Option<HostResponse>, HostProtocolError> {
        if self.state != HostInstanceState::Ready
            || self.negotiated_version != Some(HOST_PROTOCOL_VERSION)
        {
            return Err(invalid_state(self.state));
        }
        let result = self.call_guest(|runtime| {
            runtime
                .bindings
                .rho_plugin_lifecycle()
                .call_activate(&mut runtime.store, HOST_PROTOCOL_VERSION)
        })?;
        self.require_guest_success(result)?;
        self.state = HostInstanceState::Active;
        Ok(Some(HostResponse::Activated))
    }

    fn echo(
        &mut self,
        request_id: crate::HostRequestId,
        payload: String,
    ) -> Result<Option<HostResponse>, HostProtocolError> {
        if self.state != HostInstanceState::Active {
            return Err(invalid_state(self.state));
        }
        if payload.len() > MAX_ECHO_PAYLOAD_BYTES {
            return Err(protocol_error(HostProtocolErrorCode::PayloadTooLarge));
        }
        let result = self.call_guest(|runtime| {
            runtime
                .bindings
                .rho_plugin_lifecycle()
                .call_echo(&mut runtime.store, &payload)
        })?;
        let response = self.require_guest_success(result)?;
        if response.len() > MAX_ECHO_PAYLOAD_BYTES {
            return self.fail(HostProtocolErrorCode::PayloadTooLarge);
        }
        Ok(Some(HostResponse::EchoResult {
            request_id,
            payload: response,
        }))
    }

    fn heartbeat(&mut self) -> Result<Option<HostResponse>, HostProtocolError> {
        if self.state != HostInstanceState::Active {
            return Err(invalid_state(self.state));
        }
        let result = self.call_guest(|runtime| {
            runtime
                .bindings
                .rho_plugin_lifecycle()
                .call_heartbeat(&mut runtime.store)
        })?;
        self.require_guest_success(result)?;
        Ok(Some(HostResponse::HeartbeatAck))
    }

    fn cancel_before_dispatch(
        &mut self,
        request_id: HostRequestId,
    ) -> Result<Option<HostResponse>, HostProtocolError> {
        if self.state != HostInstanceState::Active && self.state != HostInstanceState::Quiescing {
            return Err(invalid_state(self.state));
        }
        let mut inner = self.cancellation.lock();
        if inner.pending.len() >= MAX_PENDING_WASM_CANCELLATIONS
            && !inner.pending.contains(&request_id)
        {
            return Err(protocol_error(HostProtocolErrorCode::ResourceLimit));
        }
        inner.pending.insert(request_id);
        Ok(None)
    }

    fn quiesce(&mut self) -> Result<Option<HostResponse>, HostProtocolError> {
        if self.state != HostInstanceState::Active && self.state != HostInstanceState::Ready {
            return Err(invalid_state(self.state));
        }
        let result = self.call_guest(|runtime| {
            runtime
                .bindings
                .rho_plugin_lifecycle()
                .call_quiesce(&mut runtime.store)
        })?;
        self.require_guest_success(result)?;
        self.state = HostInstanceState::Quiescing;
        Ok(Some(HostResponse::Quiesced))
    }

    fn dispose(&mut self) -> Result<Option<HostResponse>, HostProtocolError> {
        if !matches!(
            self.state,
            HostInstanceState::Ready | HostInstanceState::Active | HostInstanceState::Quiescing
        ) {
            return Err(invalid_state(self.state));
        }
        self.state = HostInstanceState::Disposing;
        let result = self.call_guest(|runtime| {
            runtime
                .bindings
                .rho_plugin_lifecycle()
                .call_dispose(&mut runtime.store)
        })?;
        self.require_guest_success(result)?;
        self.runtime.take();
        self.broker_call = None;
        self.clear_cancellation();
        self.state = HostInstanceState::Disposed;
        Ok(Some(HostResponse::Disposed))
    }

    fn call_guest<T>(
        &mut self,
        operation: impl FnOnce(&mut ComponentRuntime) -> wasmtime::Result<T>,
    ) -> Result<T, HostProtocolError> {
        if self.cancellation.cancelled.load(Ordering::SeqCst) {
            return self.fail(HostProtocolErrorCode::Cancelled);
        }
        let Some(runtime) = self.runtime.as_mut() else {
            return Err(invalid_state(self.state));
        };
        if prepare_component_store(&mut runtime.store).is_err() {
            return self.fail(HostProtocolErrorCode::ResourceLimit);
        }
        let result = catch_unwind(AssertUnwindSafe(|| operation(runtime)));
        match result {
            Ok(Ok(value)) => Ok(value),
            Ok(Err(error)) => {
                let cancelled = self.cancellation.cancelled.load(Ordering::SeqCst);
                self.fail(classify_component_error(&error, cancelled))
            }
            Err(_) => self.fail(HostProtocolErrorCode::GuestTrap),
        }
    }

    fn begin_request(&mut self, request_id: &HostRequestId) -> bool {
        self.cancellation.cancelled.store(false, Ordering::SeqCst);
        let mut inner = self.cancellation.lock();
        if inner.pending.remove(request_id) || inner.active.is_some() {
            return false;
        }
        inner.active = Some(request_id.clone());
        true
    }

    fn finish_request(&self, request_id: &HostRequestId) {
        let mut inner = self.cancellation.lock();
        if inner.active.as_ref() == Some(request_id) {
            inner.active = None;
        }
        self.cancellation.cancelled.store(false, Ordering::SeqCst);
    }

    fn clear_cancellation(&self) {
        let mut inner = self.cancellation.lock();
        inner.active = None;
        inner.pending.clear();
        self.cancellation.cancelled.store(false, Ordering::SeqCst);
    }

    fn require_guest_success<T>(
        &mut self,
        result: Result<T, String>,
    ) -> Result<T, HostProtocolError> {
        match result {
            Ok(value) => Ok(value),
            Err(_) => self.fail(HostProtocolErrorCode::GuestRejected),
        }
    }

    fn fail<T>(&mut self, code: HostProtocolErrorCode) -> Result<T, HostProtocolError> {
        self.runtime.take();
        self.broker_call = None;
        self.clear_cancellation();
        self.state = HostInstanceState::Quarantined;
        Err(protocol_error(code))
    }
}

fn decode_component_step(
    step: bindings::exports::rho::plugin::guest_calls::GuestStep,
    expected_call_id: &str,
    maximum_terminal_bytes: usize,
) -> Result<(GuestStep, String), HostProtocolErrorCode> {
    use bindings::exports::rho::plugin::guest_calls::GuestStep as ComponentGuestStep;

    let step = match step {
        ComponentGuestStep::BrokerRequest(request) => {
            if combined_string_bytes(&[
                &request.call_id,
                &request.handle_id,
                &request.permission,
                &request.operation,
                &request.args_json,
            ])? > MAX_GUEST_STEP_BYTES
            {
                return Err(HostProtocolErrorCode::PayloadTooLarge);
            }
            GuestStep::BrokerRequest {
                call_id: request.call_id,
                handle_id: request.handle_id,
                permission: request.permission,
                operation: request.operation,
                args: serde_json::from_str(&request.args_json)
                    .map_err(|_| HostProtocolErrorCode::InvalidBrokerStep)?,
            }
        }
        ComponentGuestStep::Complete(completion) => {
            if combined_string_bytes(&[&completion.call_id, &completion.result_json])?
                > maximum_terminal_bytes
            {
                return Err(HostProtocolErrorCode::PayloadTooLarge);
            }
            GuestStep::Complete {
                call_id: completion.call_id,
                result: serde_json::from_str(&completion.result_json)
                    .map_err(|_| HostProtocolErrorCode::InvalidBrokerStep)?,
            }
        }
        ComponentGuestStep::Error(error) => {
            if combined_string_bytes(&[&error.call_id, &error.code])? > MAX_GUEST_STEP_BYTES {
                return Err(HostProtocolErrorCode::PayloadTooLarge);
            }
            GuestStep::Error {
                call_id: error.call_id,
                code: error.code,
            }
        }
    };
    let encoded =
        serde_json::to_string(&step).map_err(|_| HostProtocolErrorCode::InvalidBrokerStep)?;
    validate_guest_step(
        &step,
        encoded.len(),
        expected_call_id,
        maximum_terminal_bytes,
    )?;
    Ok((step, encoded))
}

fn combined_string_bytes(values: &[&str]) -> Result<usize, HostProtocolErrorCode> {
    values.iter().try_fold(0usize, |total, value| {
        total
            .checked_add(value.len())
            .ok_or(HostProtocolErrorCode::PayloadTooLarge)
    })
}

fn prepare_component_store(
    store: &mut Store<ComponentStoreState>,
) -> Result<(), HostProtocolError> {
    store
        .set_fuel(DEFAULT_WASM_FUEL)
        .map_err(|_| protocol_error(HostProtocolErrorCode::ResourceLimit))?;
    store.set_epoch_deadline(1);
    Ok(())
}

fn classify_component_error(
    error: &wasmtime::Error,
    cancellation_requested: bool,
) -> HostProtocolErrorCode {
    if let Some(trap) = error.downcast_ref::<Trap>() {
        return match trap {
            Trap::OutOfFuel => HostProtocolErrorCode::FuelExhausted,
            Trap::Interrupt if cancellation_requested => HostProtocolErrorCode::Cancelled,
            Trap::Interrupt => HostProtocolErrorCode::Timeout,
            Trap::AllocationTooLarge => HostProtocolErrorCode::ResourceLimit,
            _ => HostProtocolErrorCode::GuestTrap,
        };
    }
    HostProtocolErrorCode::ResourceLimit
}

fn protocol_error(code: HostProtocolErrorCode) -> HostProtocolError {
    HostProtocolError {
        code,
        message: None,
    }
}

fn invalid_state(state: HostInstanceState) -> HostProtocolError {
    HostProtocolError {
        code: HostProtocolErrorCode::InvalidStateTransition,
        message: Some(format!("invalid transition from {state:?}")),
    }
}
