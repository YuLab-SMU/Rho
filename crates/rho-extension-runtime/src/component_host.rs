//! Typed host boundary for the additive `rho:plugin@1` Component ABI.
//!
//! The Component world has no imports. Admission and generated binding
//! type-checking happen before a Store exists; instantiation and every call then
//! run under the same fuel, epoch and StoreLimits policy as the core ABI host.

use std::panic::{AssertUnwindSafe, catch_unwind};

use wasmtime::component::{Component, Linker};
use wasmtime::{Store, StoreLimits, StoreLimitsBuilder, Trap};

use crate::{
    DEFAULT_WASM_FUEL, HOST_PROTOCOL_VERSION, HostFrame, HostInstanceState, HostMessage,
    HostProtocolError, HostProtocolErrorCode, HostResponse, MAX_ECHO_PAYLOAD_BYTES,
    MAX_WASM_MEMORY_BYTES, MAX_WASM_TABLE_ELEMENTS, PackageDigest, WasmHostIdentity,
    wasm_host::build_engine,
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

/// One typed Component lifecycle instance. The desktop does not select this
/// host until the later dual-ABI routing package is complete.
pub struct ComponentPluginHost {
    identity: WasmHostIdentity,
    component_digest: PackageDigest,
    engine: wasmtime::Engine,
    runtime: Option<ComponentRuntime>,
    state: HostInstanceState,
    negotiated_version: Option<u64>,
}

impl std::fmt::Debug for ComponentPluginHost {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("ComponentPluginHost")
            .field("identity", &self.identity)
            .field("component_digest", &self.component_digest)
            .field("state", &self.state)
            .field("negotiated_version", &self.negotiated_version)
            .field("runtime_present", &self.runtime.is_some())
            .finish_non_exhaustive()
    }
}

impl ComponentPluginHost {
    pub fn from_bytes(
        identity: WasmHostIdentity,
        component_bytes: &[u8],
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
            .map_err(|error| protocol_error(classify_component_error(&error)))?;

        Ok(Self {
            identity,
            component_digest: digest,
            engine,
            runtime: Some(ComponentRuntime { store, bindings }),
            state: HostInstanceState::Created,
            negotiated_version: None,
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
            HostMessage::Cancel { .. } => {
                Err(protocol_error(HostProtocolErrorCode::UnknownRequest))
            }
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
        self.state = HostInstanceState::Disposed;
        Ok(Some(HostResponse::Disposed))
    }

    fn call_guest<T>(
        &mut self,
        operation: impl FnOnce(&mut ComponentRuntime) -> wasmtime::Result<T>,
    ) -> Result<T, HostProtocolError> {
        let Some(runtime) = self.runtime.as_mut() else {
            return Err(invalid_state(self.state));
        };
        if prepare_component_store(&mut runtime.store).is_err() {
            return self.fail(HostProtocolErrorCode::ResourceLimit);
        }
        let result = catch_unwind(AssertUnwindSafe(|| operation(runtime)));
        match result {
            Ok(Ok(value)) => Ok(value),
            Ok(Err(error)) => self.fail(classify_component_error(&error)),
            Err(_) => self.fail(HostProtocolErrorCode::GuestTrap),
        }
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
        self.state = HostInstanceState::Quarantined;
        Err(protocol_error(code))
    }
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

fn classify_component_error(error: &wasmtime::Error) -> HostProtocolErrorCode {
    if let Some(trap) = error.downcast_ref::<Trap>() {
        return match trap {
            Trap::OutOfFuel => HostProtocolErrorCode::FuelExhausted,
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
