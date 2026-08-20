//! Executable Phase 2 Wasm host (P2-1).
//!
//! The guest receives no imports. In particular this module never links WASI,
//! filesystem, network, process, environment, credential, Tauri, Broker,
//! Workspace R, or Agent R functions. Each plugin owns a separate Wasmtime
//! engine so epoch cancellation cannot cross plugin or project identities.

use std::collections::BTreeSet;
use std::panic::{AssertUnwindSafe, catch_unwind};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use wasmtime::{
    Config, Engine, Instance, Linker, Memory, Module, Store, StoreLimits, StoreLimitsBuilder, Trap,
    TypedFunc,
};

use crate::{
    ActivationGeneration, HOST_PROTOCOL_VERSION, HostFrame, HostInstanceId, HostInstanceState,
    HostMessage, HostProtocolError, HostProtocolErrorCode, HostRequestId, HostResponse,
    MAX_ECHO_PAYLOAD_BYTES, PackageDigest, PluginId, ScopeId,
};

/// Maximum binary core-Wasm bytes admitted before compilation.
pub const MAX_WASM_MODULE_BYTES: usize = 4 * 1024 * 1024;
/// Maximum linear-memory bytes available to one plugin instance.
pub const MAX_WASM_MEMORY_BYTES: usize = 2 * 1024 * 1024;
/// Maximum table elements available to one plugin instance.
pub const MAX_WASM_TABLE_ELEMENTS: usize = 1024;
/// Deterministic fuel assigned to instantiation and every guest call.
pub const DEFAULT_WASM_FUEL: u64 = 1_000_000;
/// Maximum exact request ids that may be cancelled before dispatch.
pub const MAX_PENDING_WASM_CANCELLATIONS: usize = 256;

/// Binary Guest ABI V1 fixture compiled into packaged smoke tests. It exports
/// only the six P2-1 ABI items and imports nothing.
pub const P2_1_SMOKE_WASM: &[u8] = &[
    0, 97, 115, 109, 1, 0, 0, 0, 1, 16, 3, 96, 1, 127, 1, 127, 96, 2, 127, 127, 1, 126, 96, 0, 1,
    127, 3, 6, 5, 0, 1, 2, 2, 2, 5, 4, 1, 1, 1, 1, 7, 80, 6, 6, 109, 101, 109, 111, 114, 121, 2, 0,
    12, 114, 104, 111, 95, 97, 99, 116, 105, 118, 97, 116, 101, 0, 0, 8, 114, 104, 111, 95, 101,
    99, 104, 111, 0, 1, 13, 114, 104, 111, 95, 104, 101, 97, 114, 116, 98, 101, 97, 116, 0, 2, 11,
    114, 104, 111, 95, 113, 117, 105, 101, 115, 99, 101, 0, 3, 11, 114, 104, 111, 95, 100, 105,
    115, 112, 111, 115, 101, 0, 4, 10, 34, 5, 4, 0, 65, 0, 11, 12, 0, 32, 0, 173, 66, 32, 134, 32,
    1, 173, 132, 11, 4, 0, 65, 0, 11, 4, 0, 65, 0, 11, 4, 0, 65, 0, 11, 0, 20, 4, 110, 97, 109,
    101, 2, 13, 1, 1, 2, 0, 3, 112, 116, 114, 1, 3, 108, 101, 110,
];

/// Binary module that requests one WASI import. Packaged smoke tests require
/// the real production host to reject it before instantiation.
pub const P2_1_WASI_IMPORT_SMOKE_WASM: &[u8] = &[
    0, 97, 115, 109, 1, 0, 0, 0, 1, 4, 1, 96, 0, 0, 2, 34, 1, 22, 119, 97, 115, 105, 95, 115, 110,
    97, 112, 115, 104, 111, 116, 95, 112, 114, 101, 118, 105, 101, 119, 49, 7, 102, 100, 95, 114,
    101, 97, 100, 0, 0,
];

const GUEST_MEMORY_EXPORT: &str = "memory";
const GUEST_ACTIVATE_EXPORT: &str = "rho_activate";
const GUEST_ECHO_EXPORT: &str = "rho_echo";
const GUEST_HEARTBEAT_EXPORT: &str = "rho_heartbeat";
const GUEST_QUIESCE_EXPORT: &str = "rho_quiesce";
const GUEST_DISPOSE_EXPORT: &str = "rho_dispose";

/// Exact identity bound to one executable Wasm host.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WasmHostIdentity {
    project_id: ScopeId,
    plugin_id: PluginId,
    package_digest: PackageDigest,
    activation_generation: ActivationGeneration,
    host_instance_id: HostInstanceId,
}

impl WasmHostIdentity {
    pub fn new(
        project_id: ScopeId,
        plugin_id: PluginId,
        package_digest: PackageDigest,
        activation_generation: ActivationGeneration,
        host_instance_id: HostInstanceId,
    ) -> Self {
        Self {
            project_id,
            plugin_id,
            package_digest,
            activation_generation,
            host_instance_id,
        }
    }

    pub fn project_id(&self) -> &ScopeId {
        &self.project_id
    }

    pub fn plugin_id(&self) -> &PluginId {
        &self.plugin_id
    }

    pub fn package_digest(&self) -> &PackageDigest {
        &self.package_digest
    }

    pub fn activation_generation(&self) -> ActivationGeneration {
        self.activation_generation
    }

    pub fn host_instance_id(&self) -> &HostInstanceId {
        &self.host_instance_id
    }
}

struct WasmStoreState {
    limits: StoreLimits,
}

struct WasmRuntime {
    store: Store<WasmStoreState>,
    _instance: Instance,
    memory: Memory,
    activate: TypedFunc<i32, i32>,
    echo: TypedFunc<(i32, i32), i64>,
    heartbeat: TypedFunc<(), i32>,
    quiesce: TypedFunc<(), i32>,
    dispose: TypedFunc<(), i32>,
}

#[derive(Default)]
struct CancellationInner {
    active: Option<HostRequestId>,
    pending: BTreeSet<HostRequestId>,
}

struct CancellationState {
    inner: Mutex<CancellationInner>,
    cancelled: AtomicBool,
}

impl CancellationState {
    fn new() -> Self {
        Self {
            inner: Mutex::new(CancellationInner::default()),
            cancelled: AtomicBool::new(false),
        }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, CancellationInner> {
        self.inner
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }
}

/// Broker-owned exact-request cancellation handle.
#[derive(Clone)]
pub struct WasmCancellationHandle {
    engine: Engine,
    state: Arc<CancellationState>,
}

impl WasmCancellationHandle {
    /// Interrupt only the exact request currently running in this host.
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

/// One no-WASI/no-import Wasm instance implementing Guest ABI V1.
pub struct WasmPluginHost {
    identity: WasmHostIdentity,
    module_digest: PackageDigest,
    engine: Engine,
    runtime: Option<WasmRuntime>,
    state: HostInstanceState,
    negotiated_version: Option<u64>,
    cancellation: Arc<CancellationState>,
}

impl std::fmt::Debug for WasmPluginHost {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("WasmPluginHost")
            .field("identity", &self.identity)
            .field("module_digest", &self.module_digest)
            .field("state", &self.state)
            .field("negotiated_version", &self.negotiated_version)
            .field("runtime_present", &self.runtime.is_some())
            .finish_non_exhaustive()
    }
}

impl WasmPluginHost {
    /// Compile and instantiate an exact binary module under P2-1 limits.
    ///
    /// Callers may construct this host only after explicit enablement. The
    /// module cannot import any host API, and instantiation (including a Wasm
    /// start function) consumes the same bounded fuel as an ordinary call.
    pub fn from_bytes(
        identity: WasmHostIdentity,
        module_bytes: &[u8],
    ) -> Result<Self, HostProtocolError> {
        if module_bytes.len() > MAX_WASM_MODULE_BYTES {
            return Err(protocol_error(HostProtocolErrorCode::ModuleTooLarge));
        }

        let engine = build_engine()?;
        let module_digest =
            PackageDigest::from_inventory(&[(b"guest-v1.wasm".as_slice(), module_bytes)]);
        let module = catch_unwind(AssertUnwindSafe(|| Module::new(&engine, module_bytes)))
            .map_err(|_| protocol_error(HostProtocolErrorCode::InvalidModule))?
            .map_err(|_| protocol_error(HostProtocolErrorCode::InvalidModule))?;
        if module.imports().next().is_some() {
            return Err(protocol_error(HostProtocolErrorCode::ForbiddenImport));
        }

        let limits = StoreLimitsBuilder::new()
            .memory_size(MAX_WASM_MEMORY_BYTES)
            .table_elements(MAX_WASM_TABLE_ELEMENTS)
            .instances(1)
            .tables(1)
            .memories(1)
            .trap_on_grow_failure(true)
            .build();
        let mut store = Store::new(&engine, WasmStoreState { limits });
        store.limiter(|state| &mut state.limits);
        prepare_store(&mut store)?;

        let linker = Linker::new(&engine);
        let instance = catch_unwind(AssertUnwindSafe(|| linker.instantiate(&mut store, &module)))
            .map_err(|_| protocol_error(HostProtocolErrorCode::GuestTrap))?
            .map_err(|error| protocol_error(classify_wasmtime_error(&error, false)))?;
        let runtime = bind_guest_abi(store, instance)?;

        Ok(Self {
            identity,
            module_digest,
            engine,
            runtime: Some(runtime),
            state: HostInstanceState::Created,
            negotiated_version: None,
            cancellation: Arc::new(CancellationState::new()),
        })
    }

    pub fn identity(&self) -> &WasmHostIdentity {
        &self.identity
    }

    pub fn state(&self) -> HostInstanceState {
        self.state
    }

    pub fn module_digest(&self) -> &PackageDigest {
        &self.module_digest
    }

    pub fn cancellation_handle(&self) -> WasmCancellationHandle {
        WasmCancellationHandle {
            engine: self.engine.clone(),
            state: Arc::clone(&self.cancellation),
        }
    }

    /// Quarantine this exact host after its broker-owned heartbeat supervisor
    /// reaches the timeout. Returns `false` when teardown already completed.
    pub fn quarantine_for_timeout(&mut self) -> bool {
        if matches!(
            self.state,
            HostInstanceState::Disposed | HostInstanceState::Quarantined
        ) {
            return false;
        }
        self.runtime.take();
        self.clear_cancellation();
        self.state = HostInstanceState::Quarantined;
        true
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
            HostMessage::Cancel { request_id } => self.cancel_before_dispatch(request_id),
            HostMessage::Quiesce => self.quiesce(),
            HostMessage::Dispose => self.dispose(),
        }
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
        let status = self.call_guest(|runtime| {
            runtime
                .activate
                .call(&mut runtime.store, HOST_PROTOCOL_VERSION as i32)
        })?;
        self.require_success(status)?;
        self.state = HostInstanceState::Active;
        Ok(Some(HostResponse::Activated))
    }

    fn echo(
        &mut self,
        request_id: HostRequestId,
        payload: String,
    ) -> Result<Option<HostResponse>, HostProtocolError> {
        self.echo_with_hook(request_id, payload, || {})
    }

    fn echo_with_hook(
        &mut self,
        request_id: HostRequestId,
        payload: String,
        before_call: impl FnOnce(),
    ) -> Result<Option<HostResponse>, HostProtocolError> {
        if self.state != HostInstanceState::Active {
            return Err(invalid_state(self.state));
        }
        if payload.len() > MAX_ECHO_PAYLOAD_BYTES {
            return Err(protocol_error(HostProtocolErrorCode::PayloadTooLarge));
        }
        if !self.begin_request(&request_id) {
            return Err(protocol_error(HostProtocolErrorCode::Cancelled));
        }

        let bytes = payload.as_bytes();
        let Some(runtime) = self.runtime.as_mut() else {
            return Err(invalid_state(self.state));
        };
        let write_result = runtime.memory.write(&mut runtime.store, 0, bytes);
        if write_result.is_err() {
            self.finish_request(&request_id);
            return self.fail(HostProtocolErrorCode::InvalidGuestOutput);
        }

        let packed = self.call_guest_with_hook(
            |runtime| {
                runtime
                    .echo
                    .call(&mut runtime.store, (0, bytes.len() as i32))
            },
            before_call,
        );
        self.finish_request(&request_id);
        let packed = packed?;

        let response = match self.read_guest_response(packed) {
            Ok(response) => response,
            Err(code) => return self.fail(code),
        };
        Ok(Some(HostResponse::EchoResult {
            request_id,
            payload: response,
        }))
    }

    fn heartbeat(&mut self) -> Result<Option<HostResponse>, HostProtocolError> {
        if self.state != HostInstanceState::Active {
            return Err(invalid_state(self.state));
        }
        let status = self.call_guest(|runtime| runtime.heartbeat.call(&mut runtime.store, ()))?;
        self.require_success(status)?;
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
        let status = self.call_guest(|runtime| runtime.quiesce.call(&mut runtime.store, ()))?;
        self.require_success(status)?;
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
        let result = self
            .call_guest(|runtime| runtime.dispose.call(&mut runtime.store, ()))
            .and_then(|status| self.require_success(status));
        if result.is_err() {
            self.runtime.take();
            return result.map(|_| None);
        }
        self.runtime.take();
        self.clear_cancellation();
        self.state = HostInstanceState::Disposed;
        Ok(Some(HostResponse::Disposed))
    }

    fn call_guest<T>(
        &mut self,
        operation: impl FnOnce(&mut WasmRuntime) -> wasmtime::Result<T>,
    ) -> Result<T, HostProtocolError> {
        self.call_guest_with_hook(operation, || {})
    }

    fn call_guest_with_hook<T>(
        &mut self,
        operation: impl FnOnce(&mut WasmRuntime) -> wasmtime::Result<T>,
        before_call: impl FnOnce(),
    ) -> Result<T, HostProtocolError> {
        let cancelled = self.cancellation.cancelled.load(Ordering::SeqCst);
        if cancelled {
            return self.fail(HostProtocolErrorCode::Cancelled);
        }
        let Some(runtime) = self.runtime.as_mut() else {
            return Err(invalid_state(self.state));
        };
        if prepare_store(&mut runtime.store).is_err() {
            return self.fail(HostProtocolErrorCode::ResourceLimit);
        }
        before_call();
        let result = catch_unwind(AssertUnwindSafe(|| operation(runtime)));
        match result {
            Ok(Ok(value)) => Ok(value),
            Ok(Err(error)) => {
                let cancelled = self.cancellation.cancelled.load(Ordering::SeqCst);
                self.fail(classify_wasmtime_error(&error, cancelled))
            }
            Err(_) => self.fail(HostProtocolErrorCode::GuestTrap),
        }
    }

    fn require_success(&mut self, status: i32) -> Result<(), HostProtocolError> {
        if status == 0 {
            Ok(())
        } else {
            self.fail(HostProtocolErrorCode::GuestRejected)
        }
    }

    fn read_guest_response(&mut self, packed: i64) -> Result<String, HostProtocolErrorCode> {
        let packed = packed as u64;
        let pointer = (packed >> 32) as u32 as usize;
        let length = (packed & u32::MAX as u64) as u32 as usize;
        if length > MAX_ECHO_PAYLOAD_BYTES {
            return Err(HostProtocolErrorCode::PayloadTooLarge);
        }
        let Some(runtime) = self.runtime.as_mut() else {
            return Err(HostProtocolErrorCode::InvalidStateTransition);
        };
        let end = pointer
            .checked_add(length)
            .ok_or(HostProtocolErrorCode::InvalidGuestOutput)?;
        if end > runtime.memory.data_size(&runtime.store) {
            return Err(HostProtocolErrorCode::InvalidGuestOutput);
        }
        let mut bytes = vec![0; length];
        runtime
            .memory
            .read(&runtime.store, pointer, &mut bytes)
            .map_err(|_| HostProtocolErrorCode::InvalidGuestOutput)?;
        String::from_utf8(bytes).map_err(|_| HostProtocolErrorCode::InvalidGuestOutput)
    }

    fn begin_request(&mut self, request_id: &HostRequestId) -> bool {
        self.cancellation.cancelled.store(false, Ordering::SeqCst);
        let mut inner = self.cancellation.lock();
        if inner.pending.remove(request_id) {
            return false;
        }
        if inner.active.is_some() {
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

    fn fail<T>(&mut self, code: HostProtocolErrorCode) -> Result<T, HostProtocolError> {
        self.runtime.take();
        self.clear_cancellation();
        self.state = HostInstanceState::Quarantined;
        Err(protocol_error(code))
    }
}

fn build_engine() -> Result<Engine, HostProtocolError> {
    let mut config = Config::new();
    config
        .consume_fuel(true)
        .epoch_interruption(true)
        .wasm_memory64(false)
        .wasm_multi_memory(false)
        .wasm_tail_call(false)
        .wasm_simd(false)
        .wasm_relaxed_simd(false)
        .wasm_bulk_memory(false)
        .max_wasm_stack(512 * 1024);
    Engine::new(&config).map_err(|_| protocol_error(HostProtocolErrorCode::InvalidModule))
}

fn prepare_store(store: &mut Store<WasmStoreState>) -> Result<(), HostProtocolError> {
    store
        .set_fuel(DEFAULT_WASM_FUEL)
        .map_err(|_| protocol_error(HostProtocolErrorCode::ResourceLimit))?;
    store.set_epoch_deadline(1);
    Ok(())
}

fn bind_guest_abi(
    mut store: Store<WasmStoreState>,
    instance: Instance,
) -> Result<WasmRuntime, HostProtocolError> {
    let memory = instance
        .get_memory(&mut store, GUEST_MEMORY_EXPORT)
        .ok_or_else(|| missing_export(GUEST_MEMORY_EXPORT))?;
    let activate = typed_export::<i32, i32>(&instance, &mut store, GUEST_ACTIVATE_EXPORT)?;
    let echo = typed_export::<(i32, i32), i64>(&instance, &mut store, GUEST_ECHO_EXPORT)?;
    let heartbeat = typed_export::<(), i32>(&instance, &mut store, GUEST_HEARTBEAT_EXPORT)?;
    let quiesce = typed_export::<(), i32>(&instance, &mut store, GUEST_QUIESCE_EXPORT)?;
    let dispose = typed_export::<(), i32>(&instance, &mut store, GUEST_DISPOSE_EXPORT)?;
    Ok(WasmRuntime {
        store,
        _instance: instance,
        memory,
        activate,
        echo,
        heartbeat,
        quiesce,
        dispose,
    })
}

fn typed_export<Params, Results>(
    instance: &Instance,
    store: &mut Store<WasmStoreState>,
    name: &'static str,
) -> Result<TypedFunc<Params, Results>, HostProtocolError>
where
    Params: wasmtime::WasmParams,
    Results: wasmtime::WasmResults,
{
    if instance.get_export(&mut *store, name).is_none() {
        return Err(missing_export(name));
    }
    instance
        .get_typed_func::<Params, Results>(&mut *store, name)
        .map_err(|_| protocol_error(HostProtocolErrorCode::InvalidExport))
}

fn missing_export(_: &'static str) -> HostProtocolError {
    protocol_error(HostProtocolErrorCode::MissingExport)
}

fn classify_wasmtime_error(
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

#[cfg(test)]
mod tests {
    use super::*;

    fn wasm(wat: &str) -> Vec<u8> {
        wat::parse_str(wat).unwrap()
    }

    fn valid_wasm() -> Vec<u8> {
        P2_1_SMOKE_WASM.to_vec()
    }

    fn identity(project: &str, digest: char) -> WasmHostIdentity {
        WasmHostIdentity::new(
            ScopeId::new(project).unwrap(),
            PluginId::new("org.example.plugin").unwrap(),
            PackageDigest::parse(digest.to_string().repeat(64)).unwrap(),
            ActivationGeneration::new(1).unwrap(),
            HostInstanceId::generate(),
        )
    }

    fn frame(host: &WasmPluginHost, message: HostMessage) -> HostFrame {
        HostFrame {
            instance_id: host.identity().host_instance_id().clone(),
            message,
        }
    }

    fn activate(host: &mut WasmPluginHost) {
        assert_eq!(
            host.handle_frame(frame(
                host,
                HostMessage::Hello {
                    api_version: HOST_PROTOCOL_VERSION,
                },
            ))
            .unwrap(),
            Some(HostResponse::Ready {
                api_version: HOST_PROTOCOL_VERSION,
            })
        );
        assert_eq!(
            host.handle_frame(frame(host, HostMessage::Activate))
                .unwrap(),
            Some(HostResponse::Activated)
        );
    }

    #[test]
    fn valid_guest_lifecycle_and_unicode_echo() {
        let mut host =
            WasmPluginHost::from_bytes(identity("project.a", 'a'), &valid_wasm()).unwrap();
        assert_eq!(host.identity().project_id().as_str(), "project.a");
        assert_eq!(host.identity().plugin_id().as_str(), "org.example.plugin");
        assert_eq!(host.identity().package_digest().as_str(), "a".repeat(64));
        assert_eq!(host.identity().activation_generation().get(), 1);
        let module_digest = host.module_digest().clone();
        activate(&mut host);
        let request_id = HostRequestId::new("request.echo").unwrap();
        assert_eq!(
            host.handle_frame(frame(
                &host,
                HostMessage::Echo {
                    request_id: request_id.clone(),
                    payload: "Rho 科学".to_string(),
                },
            ))
            .unwrap(),
            Some(HostResponse::EchoResult {
                request_id,
                payload: "Rho 科学".to_string(),
            })
        );
        assert_eq!(
            host.handle_frame(frame(&host, HostMessage::Heartbeat))
                .unwrap(),
            Some(HostResponse::HeartbeatAck)
        );
        assert_eq!(
            host.handle_frame(frame(&host, HostMessage::Quiesce))
                .unwrap(),
            Some(HostResponse::Quiesced)
        );
        assert_eq!(
            host.handle_frame(frame(&host, HostMessage::Dispose))
                .unwrap(),
            Some(HostResponse::Disposed)
        );
        assert_eq!(host.state(), HostInstanceState::Disposed);
        assert_eq!(host.module_digest(), &module_digest);
        assert_eq!(
            host.handle_frame(frame(&host, HostMessage::Heartbeat))
                .unwrap_err()
                .code,
            HostProtocolErrorCode::InvalidStateTransition
        );
    }

    #[test]
    fn rejects_module_size_malformed_imports_and_wasi() {
        assert_eq!(
            WasmPluginHost::from_bytes(
                identity("project.a", 'a'),
                &vec![0; MAX_WASM_MODULE_BYTES + 1],
            )
            .unwrap_err()
            .code,
            HostProtocolErrorCode::ModuleTooLarge
        );
        assert_eq!(
            WasmPluginHost::from_bytes(identity("project.a", 'a'), b"not wasm")
                .unwrap_err()
                .code,
            HostProtocolErrorCode::InvalidModule
        );
        for namespace in [
            "wasi_snapshot_preview1",
            "rho_fs",
            "rho_network",
            "rho_process",
            "rho_credential",
            "rho_tauri",
            "rho_workspace_r",
            "rho_agent_r",
            "env",
        ] {
            let module = wasm(&format!(r#"(module (import "{namespace}" "open" (func)))"#));
            assert_eq!(
                WasmPluginHost::from_bytes(identity("project.a", 'a'), &module)
                    .unwrap_err()
                    .code,
                HostProtocolErrorCode::ForbiddenImport,
                "namespace {namespace}"
            );
        }
        assert_eq!(
            WasmPluginHost::from_bytes(identity("project.a", 'b'), P2_1_WASI_IMPORT_SMOKE_WASM,)
                .unwrap_err()
                .code,
            HostProtocolErrorCode::ForbiddenImport
        );
    }

    #[test]
    fn rejects_missing_or_wrong_guest_abi_exports() {
        let missing_memory = wasm(
            r#"(module
                (func (export "rho_activate") (param i32) (result i32) i32.const 0)
                (func (export "rho_echo") (param i32 i32) (result i64) i64.const 0)
                (func (export "rho_heartbeat") (result i32) i32.const 0)
                (func (export "rho_quiesce") (result i32) i32.const 0)
                (func (export "rho_dispose") (result i32) i32.const 0))"#,
        );
        assert_eq!(
            WasmPluginHost::from_bytes(identity("project.a", 'a'), &missing_memory)
                .unwrap_err()
                .code,
            HostProtocolErrorCode::MissingExport
        );

        let wrong_signature = String::from_utf8(valid_wasm()).err();
        assert!(wrong_signature.is_some(), "fixture must be binary Wasm");
        let wrong_signature = wasm(
            r#"(module
                (memory (export "memory") 1 1)
                (func (export "rho_activate") (result i32) i32.const 0)
                (func (export "rho_echo") (param i32 i32) (result i64) i64.const 0)
                (func (export "rho_heartbeat") (result i32) i32.const 0)
                (func (export "rho_quiesce") (result i32) i32.const 0)
                (func (export "rho_dispose") (result i32) i32.const 0))"#,
        );
        assert_eq!(
            WasmPluginHost::from_bytes(identity("project.a", 'a'), &wrong_signature)
                .unwrap_err()
                .code,
            HostProtocolErrorCode::InvalidExport
        );
    }

    #[test]
    fn unsupported_wasm_features_fail_before_guest_activation() {
        for module in [
            wasm(r#"(module (memory i64 1))"#),
            wasm(r#"(module (memory 1 1 shared))"#),
            wasm(r#"(module (memory 1) (memory 1))"#),
        ] {
            assert_eq!(
                WasmPluginHost::from_bytes(identity("project.a", 'a'), &module)
                    .unwrap_err()
                    .code,
                HostProtocolErrorCode::InvalidModule
            );
        }
    }

    #[test]
    fn payload_and_returned_memory_ranges_are_bounded() {
        let mut host =
            WasmPluginHost::from_bytes(identity("project.a", 'a'), &valid_wasm()).unwrap();
        activate(&mut host);
        let error = host
            .handle_frame(frame(
                &host,
                HostMessage::Echo {
                    request_id: HostRequestId::new("request.large").unwrap(),
                    payload: "x".repeat(MAX_ECHO_PAYLOAD_BYTES + 1),
                },
            ))
            .unwrap_err();
        assert_eq!(error.code, HostProtocolErrorCode::PayloadTooLarge);
        assert_eq!(host.state(), HostInstanceState::Active);

        let invalid_range = wasm(
            r#"(module
                (memory (export "memory") 1 1)
                (func (export "rho_activate") (param i32) (result i32) i32.const 0)
                (func (export "rho_echo") (param i32 i32) (result i64)
                    i64.const 281474976710657)
                (func (export "rho_heartbeat") (result i32) i32.const 0)
                (func (export "rho_quiesce") (result i32) i32.const 0)
                (func (export "rho_dispose") (result i32) i32.const 0))"#,
        );
        let mut host =
            WasmPluginHost::from_bytes(identity("project.a", 'b'), &invalid_range).unwrap();
        activate(&mut host);
        let error = host
            .handle_frame(frame(
                &host,
                HostMessage::Echo {
                    request_id: HostRequestId::new("request.range").unwrap(),
                    payload: "x".to_string(),
                },
            ))
            .unwrap_err();
        assert_eq!(error.code, HostProtocolErrorCode::InvalidGuestOutput);
        assert_eq!(host.state(), HostInstanceState::Quarantined);

        let oversized_response = wasm(
            r#"(module
                (memory (export "memory") 1 1)
                (func (export "rho_activate") (param i32) (result i32) i32.const 0)
                (func (export "rho_echo") (param i32 i32) (result i64)
                    i64.const 16385)
                (func (export "rho_heartbeat") (result i32) i32.const 0)
                (func (export "rho_quiesce") (result i32) i32.const 0)
                (func (export "rho_dispose") (result i32) i32.const 0))"#,
        );
        let mut host =
            WasmPluginHost::from_bytes(identity("project.a", 'c'), &oversized_response).unwrap();
        activate(&mut host);
        let error = host
            .handle_frame(frame(
                &host,
                HostMessage::Echo {
                    request_id: HostRequestId::new("request.response-large").unwrap(),
                    payload: "x".to_string(),
                },
            ))
            .unwrap_err();
        assert_eq!(error.code, HostProtocolErrorCode::PayloadTooLarge);
        assert_eq!(host.state(), HostInstanceState::Quarantined);

        let invalid_utf8 = wasm(
            r#"(module
                (memory (export "memory") 1 1)
                (func (export "rho_activate") (param i32) (result i32) i32.const 0)
                (func (export "rho_echo") (param i32 i32) (result i64)
                    i32.const 0
                    i32.const 255
                    i32.store8
                    i64.const 1)
                (func (export "rho_heartbeat") (result i32) i32.const 0)
                (func (export "rho_quiesce") (result i32) i32.const 0)
                (func (export "rho_dispose") (result i32) i32.const 0))"#,
        );
        let mut host =
            WasmPluginHost::from_bytes(identity("project.a", 'd'), &invalid_utf8).unwrap();
        activate(&mut host);
        let error = host
            .handle_frame(frame(
                &host,
                HostMessage::Echo {
                    request_id: HostRequestId::new("request.utf8").unwrap(),
                    payload: "x".to_string(),
                },
            ))
            .unwrap_err();
        assert_eq!(error.code, HostProtocolErrorCode::InvalidGuestOutput);
        assert_eq!(host.state(), HostInstanceState::Quarantined);
    }

    #[test]
    fn memory_growth_start_execution_and_activation_are_bounded() {
        let oversized_memory = wasm(
            r#"(module
                (memory (export "memory") 33 33)
                (func (export "rho_activate") (param i32) (result i32) i32.const 0)
                (func (export "rho_echo") (param i32 i32) (result i64) i64.const 0)
                (func (export "rho_heartbeat") (result i32) i32.const 0)
                (func (export "rho_quiesce") (result i32) i32.const 0)
                (func (export "rho_dispose") (result i32) i32.const 0))"#,
        );
        assert_eq!(
            WasmPluginHost::from_bytes(identity("project.a", 'a'), &oversized_memory)
                .unwrap_err()
                .code,
            HostProtocolErrorCode::ResourceLimit
        );

        let grow = wasm(
            r#"(module
                (memory (export "memory") 1)
                (func (export "rho_activate") (param i32) (result i32) i32.const 0)
                (func (export "rho_echo") (param i32 i32) (result i64)
                    i32.const 64
                    memory.grow
                    drop
                    i64.const 0)
                (func (export "rho_heartbeat") (result i32) i32.const 0)
                (func (export "rho_quiesce") (result i32) i32.const 0)
                (func (export "rho_dispose") (result i32) i32.const 0))"#,
        );
        let mut host = WasmPluginHost::from_bytes(identity("project.a", 'b'), &grow).unwrap();
        activate(&mut host);
        let error = host
            .handle_frame(frame(
                &host,
                HostMessage::Echo {
                    request_id: HostRequestId::new("request.grow").unwrap(),
                    payload: "x".to_string(),
                },
            ))
            .unwrap_err();
        assert_eq!(error.code, HostProtocolErrorCode::ResourceLimit);
        assert_eq!(host.state(), HostInstanceState::Quarantined);

        let start_loop = wasm(
            r#"(module
                (memory (export "memory") 1 1)
                (func $start (loop $forever br $forever))
                (start $start)
                (func (export "rho_activate") (param i32) (result i32) i32.const 0)
                (func (export "rho_echo") (param i32 i32) (result i64) i64.const 0)
                (func (export "rho_heartbeat") (result i32) i32.const 0)
                (func (export "rho_quiesce") (result i32) i32.const 0)
                (func (export "rho_dispose") (result i32) i32.const 0))"#,
        );
        assert_eq!(
            WasmPluginHost::from_bytes(identity("project.a", 'c'), &start_loop)
                .unwrap_err()
                .code,
            HostProtocolErrorCode::FuelExhausted
        );

        let rejected = wasm(
            r#"(module
                (memory (export "memory") 1 1)
                (func (export "rho_activate") (param i32) (result i32) i32.const 7)
                (func (export "rho_echo") (param i32 i32) (result i64) i64.const 0)
                (func (export "rho_heartbeat") (result i32) i32.const 0)
                (func (export "rho_quiesce") (result i32) i32.const 0)
                (func (export "rho_dispose") (result i32) i32.const 0))"#,
        );
        let mut host = WasmPluginHost::from_bytes(identity("project.a", 'd'), &rejected).unwrap();
        assert!(
            host.handle_frame(frame(
                &host,
                HostMessage::Hello {
                    api_version: HOST_PROTOCOL_VERSION,
                },
            ))
            .is_ok()
        );
        assert_eq!(
            host.handle_frame(frame(&host, HostMessage::Activate))
                .unwrap_err()
                .code,
            HostProtocolErrorCode::GuestRejected
        );
        assert_eq!(host.state(), HostInstanceState::Quarantined);
    }

    #[test]
    fn trap_and_fuel_exhaustion_quarantine_only_the_failing_project() {
        let trap = wasm(
            r#"(module
                (memory (export "memory") 1 1)
                (func (export "rho_activate") (param i32) (result i32) i32.const 0)
                (func (export "rho_echo") (param i32 i32) (result i64) unreachable)
                (func (export "rho_heartbeat") (result i32) i32.const 0)
                (func (export "rho_quiesce") (result i32) i32.const 0)
                (func (export "rho_dispose") (result i32) i32.const 0))"#,
        );
        let infinite = wasm(
            r#"(module
                (memory (export "memory") 1 1)
                (func (export "rho_activate") (param i32) (result i32) i32.const 0)
                (func (export "rho_echo") (param i32 i32) (result i64)
                    (loop $forever br $forever)
                    i64.const 0)
                (func (export "rho_heartbeat") (result i32) i32.const 0)
                (func (export "rho_quiesce") (result i32) i32.const 0)
                (func (export "rho_dispose") (result i32) i32.const 0))"#,
        );
        let mut host_a = WasmPluginHost::from_bytes(identity("project.a", 'a'), &trap).unwrap();
        let mut host_b =
            WasmPluginHost::from_bytes(identity("project.b", 'b'), &valid_wasm()).unwrap();
        activate(&mut host_a);
        activate(&mut host_b);
        let error = host_a
            .handle_frame(frame(
                &host_a,
                HostMessage::Echo {
                    request_id: HostRequestId::new("request.trap").unwrap(),
                    payload: "x".to_string(),
                },
            ))
            .unwrap_err();
        assert_eq!(error.code, HostProtocolErrorCode::GuestTrap);
        assert_eq!(host_a.state(), HostInstanceState::Quarantined);
        assert_eq!(
            host_a
                .handle_frame(frame(&host_a, HostMessage::Heartbeat))
                .unwrap_err()
                .code,
            HostProtocolErrorCode::InvalidStateTransition
        );
        assert_eq!(host_b.state(), HostInstanceState::Active);

        let mut host_a = WasmPluginHost::from_bytes(identity("project.a", 'c'), &infinite).unwrap();
        activate(&mut host_a);
        let error = host_a
            .handle_frame(frame(
                &host_a,
                HostMessage::Echo {
                    request_id: HostRequestId::new("request.fuel").unwrap(),
                    payload: "x".to_string(),
                },
            ))
            .unwrap_err();
        assert_eq!(error.code, HostProtocolErrorCode::FuelExhausted);
        assert_eq!(host_a.state(), HostInstanceState::Quarantined);
        assert_eq!(
            host_b
                .handle_frame(frame(
                    &host_b,
                    HostMessage::Echo {
                        request_id: HostRequestId::new("request.ok").unwrap(),
                        payload: "still alive".to_string(),
                    },
                ))
                .unwrap(),
            Some(HostResponse::EchoResult {
                request_id: HostRequestId::new("request.ok").unwrap(),
                payload: "still alive".to_string(),
            })
        );
    }

    #[test]
    fn exact_request_cancellation_works_before_and_during_call() {
        let mut host =
            WasmPluginHost::from_bytes(identity("project.a", 'a'), &valid_wasm()).unwrap();
        activate(&mut host);
        let cancelled = HostRequestId::new("request.pre").unwrap();
        assert_eq!(
            host.handle_frame(frame(
                &host,
                HostMessage::Cancel {
                    request_id: cancelled.clone(),
                },
            ))
            .unwrap(),
            None
        );
        assert_eq!(
            host.handle_frame(frame(
                &host,
                HostMessage::Echo {
                    request_id: cancelled,
                    payload: "not run".to_string(),
                },
            ))
            .unwrap_err()
            .code,
            HostProtocolErrorCode::Cancelled
        );
        assert_eq!(host.state(), HostInstanceState::Active);

        let infinite = wasm(
            r#"(module
                (memory (export "memory") 1 1)
                (func (export "rho_activate") (param i32) (result i32) i32.const 0)
                (func (export "rho_echo") (param i32 i32) (result i64)
                    (loop $forever br $forever)
                    i64.const 0)
                (func (export "rho_heartbeat") (result i32) i32.const 0)
                (func (export "rho_quiesce") (result i32) i32.const 0)
                (func (export "rho_dispose") (result i32) i32.const 0))"#,
        );
        let mut host = WasmPluginHost::from_bytes(identity("project.a", 'b'), &infinite).unwrap();
        activate(&mut host);
        let request_id = HostRequestId::new("request.live").unwrap();
        let handle = host.cancellation_handle();
        assert!(!handle.cancel_inflight(&HostRequestId::new("request.wrong").unwrap()));
        let error = host
            .echo_with_hook(request_id.clone(), "cancel".to_string(), || {
                assert!(handle.cancel_inflight(&request_id));
            })
            .unwrap_err();
        assert_eq!(error.code, HostProtocolErrorCode::Cancelled);
        assert_eq!(host.state(), HostInstanceState::Quarantined);
    }

    #[test]
    fn instance_identity_and_pending_cancellation_are_bounded() {
        let mut host =
            WasmPluginHost::from_bytes(identity("project.a", 'a'), &valid_wasm()).unwrap();
        activate(&mut host);
        let wrong = HostFrame {
            instance_id: HostInstanceId::new("instance.foreign").unwrap(),
            message: HostMessage::Heartbeat,
        };
        assert_eq!(
            host.handle_frame(wrong).unwrap_err().code,
            HostProtocolErrorCode::UnknownInstance
        );
        for index in 0..MAX_PENDING_WASM_CANCELLATIONS {
            host.handle_frame(frame(
                &host,
                HostMessage::Cancel {
                    request_id: HostRequestId::new(format!("request.{index}")).unwrap(),
                },
            ))
            .unwrap();
        }
        let error = host
            .handle_frame(frame(
                &host,
                HostMessage::Cancel {
                    request_id: HostRequestId::new("request.overflow").unwrap(),
                },
            ))
            .unwrap_err();
        assert_eq!(error.code, HostProtocolErrorCode::ResourceLimit);
        assert_eq!(host.state(), HostInstanceState::Active);
    }

    #[test]
    fn host_is_send_and_exposes_no_import_surface() {
        fn assert_send<T: Send>() {}
        assert_send::<WasmPluginHost>();
        let engine = build_engine().unwrap();
        let module = Module::new(&engine, valid_wasm()).unwrap();
        assert_eq!(module.imports().count(), 0);
    }

    #[test]
    fn heartbeat_timeout_quarantines_only_the_exact_host() {
        let mut host_a =
            WasmPluginHost::from_bytes(identity("project.a", 'a'), P2_1_SMOKE_WASM).unwrap();
        let mut host_b =
            WasmPluginHost::from_bytes(identity("project.b", 'b'), P2_1_SMOKE_WASM).unwrap();
        activate(&mut host_a);
        activate(&mut host_b);
        let now = std::time::Instant::now();
        let supervisor = crate::HeartbeatSupervisor::new_at(
            std::time::Duration::from_secs(1),
            std::time::Duration::from_secs(2),
            now,
        );
        assert!(supervisor.should_quarantine_at(now + std::time::Duration::from_secs(3)));
        assert!(host_a.quarantine_for_timeout());
        assert_eq!(host_a.state(), HostInstanceState::Quarantined);
        assert_eq!(host_b.state(), HostInstanceState::Active);
        assert!(!host_a.quarantine_for_timeout());
    }

    #[test]
    fn guest_dispose_failure_drops_runtime_and_stays_non_routable() {
        let dispose_trap = wasm(
            r#"(module
                (memory (export "memory") 1 1)
                (func (export "rho_activate") (param i32) (result i32) i32.const 0)
                (func (export "rho_echo") (param i32 i32) (result i64) i64.const 0)
                (func (export "rho_heartbeat") (result i32) i32.const 0)
                (func (export "rho_quiesce") (result i32) i32.const 0)
                (func (export "rho_dispose") (result i32) unreachable))"#,
        );
        let mut host =
            WasmPluginHost::from_bytes(identity("project.a", 'a'), &dispose_trap).unwrap();
        activate(&mut host);
        assert_eq!(
            host.handle_frame(frame(&host, HostMessage::Dispose))
                .unwrap_err()
                .code,
            HostProtocolErrorCode::GuestTrap
        );
        assert_eq!(host.state(), HostInstanceState::Quarantined);
        assert_eq!(
            host.handle_frame(frame(&host, HostMessage::Heartbeat))
                .unwrap_err()
                .code,
            HostProtocolErrorCode::InvalidStateTransition
        );
    }
}
