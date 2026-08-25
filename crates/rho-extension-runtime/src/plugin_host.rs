//! Explicit dual-ABI guest-host facade.
//!
//! ABI selection is supplied by validated Manifest V4 data. The facade never
//! probes bytes or retries a failed construction through the other ABI.

use std::sync::Arc;

use serde_json::Value;

use crate::{
    BrokerCallIdSource, ComponentCancellationHandle, ComponentPluginHost, GuestStep, HostFrame,
    HostInstanceState, HostProtocolError, HostRequestId, HostResponse, RuntimeAbi,
    WasmCancellationHandle, WasmHostIdentity, WasmPluginHost,
};

pub trait GuestCallHost {
    fn identity(&self) -> &WasmHostIdentity;
    fn state(&self) -> HostInstanceState;
    fn begin_contribution_call(
        &mut self,
        request_id: HostRequestId,
        request: Value,
    ) -> Result<GuestStep, HostProtocolError>;
    fn resume_contribution_call(
        &mut self,
        request_id: &HostRequestId,
        result: &Value,
        raw_result_bytes: usize,
    ) -> Result<GuestStep, HostProtocolError>;
    fn cancel_broker_call(&mut self, request_id: &HostRequestId)
    -> Result<bool, HostProtocolError>;
}

impl GuestCallHost for WasmPluginHost {
    fn identity(&self) -> &WasmHostIdentity {
        WasmPluginHost::identity(self)
    }

    fn state(&self) -> HostInstanceState {
        WasmPluginHost::state(self)
    }

    fn begin_contribution_call(
        &mut self,
        request_id: HostRequestId,
        request: Value,
    ) -> Result<GuestStep, HostProtocolError> {
        WasmPluginHost::begin_contribution_call(self, request_id, request)
    }

    fn resume_contribution_call(
        &mut self,
        request_id: &HostRequestId,
        result: &Value,
        raw_result_bytes: usize,
    ) -> Result<GuestStep, HostProtocolError> {
        WasmPluginHost::resume_contribution_call(self, request_id, result, raw_result_bytes)
    }

    fn cancel_broker_call(
        &mut self,
        request_id: &HostRequestId,
    ) -> Result<bool, HostProtocolError> {
        WasmPluginHost::cancel_broker_call(self, request_id)
    }
}

impl GuestCallHost for ComponentPluginHost {
    fn identity(&self) -> &WasmHostIdentity {
        ComponentPluginHost::identity(self)
    }

    fn state(&self) -> HostInstanceState {
        ComponentPluginHost::state(self)
    }

    fn begin_contribution_call(
        &mut self,
        request_id: HostRequestId,
        request: Value,
    ) -> Result<GuestStep, HostProtocolError> {
        ComponentPluginHost::begin_contribution_call(self, request_id, request)
    }

    fn resume_contribution_call(
        &mut self,
        request_id: &HostRequestId,
        result: &Value,
        raw_result_bytes: usize,
    ) -> Result<GuestStep, HostProtocolError> {
        ComponentPluginHost::resume_contribution_call(self, request_id, result, raw_result_bytes)
    }

    fn cancel_broker_call(
        &mut self,
        request_id: &HostRequestId,
    ) -> Result<bool, HostProtocolError> {
        ComponentPluginHost::cancel_broker_call(self, request_id)
    }
}

pub enum PluginGuestHost {
    CoreV2(Box<WasmPluginHost>),
    ComponentV1(Box<ComponentPluginHost>),
}

impl std::fmt::Debug for PluginGuestHost {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::CoreV2(host) => formatter.debug_tuple("CoreV2").field(host).finish(),
            Self::ComponentV1(host) => formatter.debug_tuple("ComponentV1").field(host).finish(),
        }
    }
}

impl PluginGuestHost {
    pub fn from_runtime_abi_with_call_id_source(
        abi: RuntimeAbi,
        identity: WasmHostIdentity,
        guest_bytes: &[u8],
        broker_call_id_source: Arc<dyn BrokerCallIdSource>,
    ) -> Result<Self, HostProtocolError> {
        match abi {
            RuntimeAbi::CoreV2 => WasmPluginHost::from_bytes_with_call_id_source(
                identity,
                guest_bytes,
                broker_call_id_source,
            )
            .map(Box::new)
            .map(Self::CoreV2),
            RuntimeAbi::ComponentV1 => ComponentPluginHost::from_bytes_with_call_id_source(
                identity,
                guest_bytes,
                broker_call_id_source,
            )
            .map(Box::new)
            .map(Self::ComponentV1),
        }
    }

    pub fn runtime_abi(&self) -> RuntimeAbi {
        match self {
            Self::CoreV2(_) => RuntimeAbi::CoreV2,
            Self::ComponentV1(_) => RuntimeAbi::ComponentV1,
        }
    }

    pub fn supports_guest_calls(&self) -> bool {
        match self {
            Self::CoreV2(host) => host.guest_abi_version() == crate::GUEST_ABI_V2,
            Self::ComponentV1(_) => true,
        }
    }

    pub fn identity(&self) -> &WasmHostIdentity {
        match self {
            Self::CoreV2(host) => host.identity(),
            Self::ComponentV1(host) => host.identity(),
        }
    }

    pub fn state(&self) -> HostInstanceState {
        match self {
            Self::CoreV2(host) => host.state(),
            Self::ComponentV1(host) => host.state(),
        }
    }

    pub fn handle_frame(
        &mut self,
        frame: HostFrame,
    ) -> Result<Option<HostResponse>, HostProtocolError> {
        match self {
            Self::CoreV2(host) => host.handle_frame(frame),
            Self::ComponentV1(host) => host.handle_frame(frame),
        }
    }

    pub fn broker_call_active(&self) -> bool {
        match self {
            Self::CoreV2(host) => host.broker_call_active(),
            Self::ComponentV1(host) => host.broker_call_active(),
        }
    }

    pub fn active_broker_request_id(&self) -> Option<HostRequestId> {
        match self {
            Self::CoreV2(host) => host.active_broker_request_id(),
            Self::ComponentV1(host) => host.active_broker_request_id(),
        }
    }

    pub fn begin_broker_call(
        &mut self,
        request_id: HostRequestId,
        request: Value,
    ) -> Result<GuestStep, HostProtocolError> {
        match self {
            Self::CoreV2(host) => host.begin_broker_call(request_id, request),
            Self::ComponentV1(host) => host.begin_broker_call(request_id, request),
        }
    }

    pub fn resume_broker_call(
        &mut self,
        request_id: &HostRequestId,
        result: &Value,
        raw_result_bytes: usize,
    ) -> Result<GuestStep, HostProtocolError> {
        match self {
            Self::CoreV2(host) => host.resume_broker_call(request_id, result, raw_result_bytes),
            Self::ComponentV1(host) => {
                host.resume_broker_call(request_id, result, raw_result_bytes)
            }
        }
    }

    pub fn begin_contribution_call(
        &mut self,
        request_id: HostRequestId,
        request: Value,
    ) -> Result<GuestStep, HostProtocolError> {
        GuestCallHost::begin_contribution_call(self, request_id, request)
    }

    pub fn resume_contribution_call(
        &mut self,
        request_id: &HostRequestId,
        result: &Value,
        raw_result_bytes: usize,
    ) -> Result<GuestStep, HostProtocolError> {
        GuestCallHost::resume_contribution_call(self, request_id, result, raw_result_bytes)
    }

    pub fn cancel_broker_call(
        &mut self,
        request_id: &HostRequestId,
    ) -> Result<bool, HostProtocolError> {
        GuestCallHost::cancel_broker_call(self, request_id)
    }

    pub fn quarantine_for_timeout(&mut self) -> bool {
        match self {
            Self::CoreV2(host) => host.quarantine_for_timeout(),
            Self::ComponentV1(host) => host.quarantine_for_timeout(),
        }
    }

    pub fn cancellation_handle(&self) -> PluginCancellationHandle {
        match self {
            Self::CoreV2(host) => PluginCancellationHandle::CoreV2(host.cancellation_handle()),
            Self::ComponentV1(host) => {
                PluginCancellationHandle::ComponentV1(host.cancellation_handle())
            }
        }
    }
}

impl GuestCallHost for PluginGuestHost {
    fn identity(&self) -> &WasmHostIdentity {
        PluginGuestHost::identity(self)
    }

    fn state(&self) -> HostInstanceState {
        PluginGuestHost::state(self)
    }

    fn begin_contribution_call(
        &mut self,
        request_id: HostRequestId,
        request: Value,
    ) -> Result<GuestStep, HostProtocolError> {
        match self {
            Self::CoreV2(host) => host.begin_contribution_call(request_id, request),
            Self::ComponentV1(host) => host.begin_contribution_call(request_id, request),
        }
    }

    fn resume_contribution_call(
        &mut self,
        request_id: &HostRequestId,
        result: &Value,
        raw_result_bytes: usize,
    ) -> Result<GuestStep, HostProtocolError> {
        match self {
            Self::CoreV2(host) => {
                host.resume_contribution_call(request_id, result, raw_result_bytes)
            }
            Self::ComponentV1(host) => {
                host.resume_contribution_call(request_id, result, raw_result_bytes)
            }
        }
    }

    fn cancel_broker_call(
        &mut self,
        request_id: &HostRequestId,
    ) -> Result<bool, HostProtocolError> {
        match self {
            Self::CoreV2(host) => host.cancel_broker_call(request_id),
            Self::ComponentV1(host) => host.cancel_broker_call(request_id),
        }
    }
}

#[derive(Clone)]
pub enum PluginCancellationHandle {
    CoreV2(WasmCancellationHandle),
    ComponentV1(ComponentCancellationHandle),
}

impl PluginCancellationHandle {
    pub fn cancel_inflight(&self, request_id: &HostRequestId) -> bool {
        match self {
            Self::CoreV2(handle) => handle.cancel_inflight(request_id),
            Self::ComponentV1(handle) => handle.cancel_inflight(request_id),
        }
    }

    pub fn is_inflight(&self, request_id: &HostRequestId) -> bool {
        match self {
            Self::CoreV2(handle) => handle.is_inflight(request_id),
            Self::ComponentV1(handle) => handle.is_inflight(request_id),
        }
    }
}
