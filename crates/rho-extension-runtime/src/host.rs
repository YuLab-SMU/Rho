//! Versioned typed host protocol for the Phase 2 isolated plugin host (P2-1).
//!
//! This module defines the message envelope, the per-instance state machine,
//! and the synthetic fixture surface. It has **no** filesystem, network,
//! Workspace R, process, credential, or Tauri capability. A plugin instance
//! only ever receives bounded typed messages and a synthetic echo/diagnostic
//! call; no privileged broker façade is exposed at this stage.
//!
//! P2-1 is host-neutral: it does not bind to a specific Web Worker or Wasm
//! runtime. The stable contract is the typed message set plus the
//! broker-supervised lifecycle below.

use std::collections::BTreeMap;
use std::time::Duration;

use serde::{Deserialize, Deserializer, Serialize, de};

use crate::ExtensionError;

/// Current host protocol version. The protocol is versioned separately from
/// the application and public Workbench Protocol.
pub const HOST_PROTOCOL_VERSION: u64 = 1;

/// Maximum encoded bytes for a single host protocol frame before it is
/// rejected. Everything over the wire is length-limited before deserialization.
pub const MAX_HOST_FRAME_BYTES: usize = 64 * 1024;

/// Maximum bytes of a synthetic echo/diagnostic payload.
pub const MAX_ECHO_PAYLOAD_BYTES: usize = 16 * 1024;

/// Default heartbeat interval for liveness supervision.
pub const DEFAULT_HEARTBEAT_INTERVAL: Duration = Duration::from_secs(30);

/// Default heartbeat timeout; a plugin that misses this window is quarantined.
pub const DEFAULT_HEARTBEAT_TIMEOUT: Duration = Duration::from_secs(60);

/// Opaque, host-generated instance identifier carried on every frame.
/// The host validates it; a plugin never chooses its own identity.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize)]
#[serde(transparent)]
pub struct HostInstanceId(String);

impl HostInstanceId {
    pub fn new(value: impl Into<String>) -> Result<Self, ExtensionError> {
        validate_opaque_id(value.into(), "host instance id").map(Self)
    }

    pub fn generate() -> Self {
        Self(format!("instance.{}", uuid::Uuid::new_v4().simple()))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl<'de> Deserialize<'de> for HostInstanceId {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let value = String::deserialize(deserializer)?;
        Self::new(value).map_err(de::Error::custom)
    }
}

/// Opaque, host-generated request identifier for call/response correlation.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize)]
#[serde(transparent)]
pub struct HostRequestId(String);

impl HostRequestId {
    pub fn new(value: impl Into<String>) -> Result<Self, ExtensionError> {
        validate_opaque_id(value.into(), "host request id").map(Self)
    }

    pub fn generate() -> Self {
        Self(format!("request.{}", uuid::Uuid::new_v4().simple()))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl<'de> Deserialize<'de> for HostRequestId {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let value = String::deserialize(deserializer)?;
        Self::new(value).map_err(de::Error::custom)
    }
}

fn validate_opaque_id(value: String, name: &str) -> Result<String, ExtensionError> {
    if value.is_empty() || value.len() > crate::MAX_IDENTIFIER_BYTES {
        return Err(ExtensionError::ManifestValidation {
            reason: format!(
                "{name} must contain 1..={} bytes",
                crate::MAX_IDENTIFIER_BYTES
            ),
        });
    }
    if !value.bytes().all(|byte| {
        byte.is_ascii_lowercase() || byte.is_ascii_digit() || matches!(byte, b'.' | b'_' | b'-')
    }) {
        return Err(ExtensionError::ManifestValidation {
            reason: format!("{name} contains invalid characters"),
        });
    }
    Ok(value)
}

/// The bounded, typed host protocol messages.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
pub enum HostMessage {
    /// `hello` negotiates the API version a plugin understands.
    Hello { api_version: u64 },
    /// `activate` asks the plugin to activate with zero privileged capability.
    Activate,
    /// `echo` is the only synthetic capability surface available in P2-1.
    Echo {
        request_id: HostRequestId,
        payload: String,
    },
    /// `heartbeat` is the liveness ping the host sends.
    Heartbeat,
    /// `quiesce` asks the plugin to stop accepting new work.
    Quiesce,
    /// `dispose` asks the plugin to release everything.
    Dispose,
    /// `cancel` cancels a specific in-flight request.
    Cancel { request_id: HostRequestId },
}

/// The plugin's typed response to a host message.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
pub enum HostResponse {
    /// `ready` acknowledges hello with the negotiated version.
    Ready { api_version: u64 },
    /// `activated` acknowledges activation.
    Activated,
    /// `echo_result` returns the bounded echo payload.
    EchoResult {
        request_id: HostRequestId,
        payload: String,
    },
    /// `heartbeat_ack` acknowledges a heartbeat ping.
    HeartbeatAck,
    /// `quiesced` acknowledges quiesce.
    Quiesced,
    /// `disposed` acknowledges dispose.
    Disposed,
    /// `error` reports a stable, non-sensitive error code.
    Error(HostProtocolError),
}

/// Stable, non-sensitive protocol error codes.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum HostProtocolErrorCode {
    /// The frame could not be decoded.
    MalformedFrame,
    /// The instance id did not match the active host session.
    UnknownInstance,
    /// A message arrived for an unnegotiated protocol version.
    VersionMismatch,
    /// The payload exceeded its bound.
    PayloadTooLarge,
    /// A message arrived in a state where it is invalid.
    InvalidStateTransition,
    /// A deadline or heartbeat timeout elapsed.
    Timeout,
    /// The request id was unknown or already completed.
    UnknownRequest,
    /// The binary module exceeded the pre-compilation byte bound.
    ModuleTooLarge,
    /// The module was not valid core WebAssembly.
    InvalidModule,
    /// The module requested an import; P2-1 exposes none.
    ForbiddenImport,
    /// A required Guest ABI V1 export was absent.
    MissingExport,
    /// A Guest ABI V1 export had the wrong type.
    InvalidExport,
    /// A Wasm store resource limit rejected the operation.
    ResourceLimit,
    /// The deterministic Wasm fuel budget was exhausted.
    FuelExhausted,
    /// Guest execution trapped or the runtime contained a panic.
    GuestTrap,
    /// Guest memory or a returned pointer/length was invalid.
    InvalidGuestOutput,
    /// Guest ABI V2 returned a malformed, mismatched, or unsupported step.
    InvalidBrokerStep,
    /// Guest ABI V2 repeated or reordered a call transition.
    BrokerSequenceViolation,
    /// A Guest ABI V2 call exceeded its bounded step count.
    BrokerStepLimit,
    /// Broker results exceeded the cumulative per-call byte budget.
    BrokerResultLimit,
    /// The guest returned a non-zero ABI status.
    GuestRejected,
    /// The exact request was cancelled by the broker.
    Cancelled,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct HostProtocolError {
    pub code: HostProtocolErrorCode,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

/// The broker-supervised lifecycle state of a single host instance.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HostInstanceState {
    /// Created but not yet negotiated.
    Created,
    /// Protocol version negotiated; no capability granted.
    Ready,
    /// Activation completed; still zero privileged capability.
    Active,
    /// No new calls admitted; in-flight calls drain.
    Quiescing,
    /// Effects are being released.
    Disposing,
    /// Terminated; no message is routable.
    Disposed,
    /// Terminated unexpectedly (crash/hang); quarantined.
    Quarantined,
}

/// A validated, bounded host protocol frame: `(instance_id, message)`.
///
/// The frame is an envelope; deserialization enforces the byte bound before any
/// semicolon-level validation runs.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct HostFrame {
    pub instance_id: HostInstanceId,
    pub message: HostMessage,
}

impl HostFrame {
    pub fn decode(bytes: &[u8]) -> Result<Self, ExtensionError> {
        if bytes.len() > MAX_HOST_FRAME_BYTES {
            return Err(ExtensionError::ManifestValidation {
                reason: format!("host frame exceeds {MAX_HOST_FRAME_BYTES} bytes"),
            });
        }
        serde_json::from_slice(bytes).map_err(|error| ExtensionError::ManifestParse {
            message: error.to_string(),
        })
    }
}

/// A synthetic echo/diagnostic fixture host instance.
///
/// This is the only runtime surface P2-1 exposes. It owns no privileged
/// capability and never touches files, network, Workspace R, process,
/// credentials, or Tauri. It exists to prove the lifecycle and protocol
/// machinery end to end.
pub struct SyntheticEchoHost {
    instance_id: HostInstanceId,
    state: HostInstanceState,
    negotiated_version: Option<u64>,
    /// Responses produced for in-flight echo requests, keyed by request id.
    inflight: BTreeMap<HostRequestId, String>,
}

impl SyntheticEchoHost {
    pub fn new() -> Self {
        Self::with_instance_id(HostInstanceId::generate())
    }

    pub fn with_instance_id(instance_id: HostInstanceId) -> Self {
        Self {
            instance_id,
            state: HostInstanceState::Created,
            negotiated_version: None,
            inflight: BTreeMap::new(),
        }
    }

    pub fn state(&self) -> HostInstanceState {
        self.state
    }

    pub fn instance_id(&self) -> &HostInstanceId {
        &self.instance_id
    }

    /// Validate the host-owned instance identity before dispatching a message.
    /// Stale or cross-instance frames never reach the state machine.
    pub fn handle_frame(
        &mut self,
        frame: HostFrame,
    ) -> Result<Option<HostResponse>, HostProtocolError> {
        if frame.instance_id != self.instance_id {
            return Err(HostProtocolError {
                code: HostProtocolErrorCode::UnknownInstance,
                message: None,
            });
        }
        self.handle_message(frame.message)
    }

    /// Advance the state machine in response to a validated host message.
    ///
    /// Responses are deterministic and never depend on ambient state.
    fn handle_message(
        &mut self,
        message: HostMessage,
    ) -> Result<Option<HostResponse>, HostProtocolError> {
        match message {
            HostMessage::Hello { api_version } => {
                if self.state != HostInstanceState::Created {
                    return Err(invalid_state(self.state));
                }
                if api_version != HOST_PROTOCOL_VERSION {
                    return Err(HostProtocolError {
                        code: HostProtocolErrorCode::VersionMismatch,
                        message: None,
                    });
                }
                self.negotiated_version = Some(api_version);
                self.state = HostInstanceState::Ready;
                Ok(Some(HostResponse::Ready { api_version }))
            }
            HostMessage::Activate => {
                if self.state != HostInstanceState::Ready {
                    return Err(invalid_state(self.state));
                }
                self.state = HostInstanceState::Active;
                Ok(Some(HostResponse::Activated))
            }
            HostMessage::Echo {
                request_id,
                payload,
            } => {
                if self.state != HostInstanceState::Active {
                    return Err(invalid_state(self.state));
                }
                if payload.len() > MAX_ECHO_PAYLOAD_BYTES {
                    return Err(HostProtocolError {
                        code: HostProtocolErrorCode::PayloadTooLarge,
                        message: None,
                    });
                }
                // Echo is synthetic; no capability is consulted.
                if self.inflight.contains_key(&request_id) {
                    return Err(HostProtocolError {
                        code: HostProtocolErrorCode::UnknownRequest,
                        message: None,
                    });
                }
                self.inflight.insert(request_id.clone(), payload.clone());
                self.inflight.remove(&request_id);
                Ok(Some(HostResponse::EchoResult {
                    request_id,
                    payload,
                }))
            }
            HostMessage::Cancel { request_id } => {
                if self.state != HostInstanceState::Active
                    && self.state != HostInstanceState::Quiescing
                {
                    return Err(invalid_state(self.state));
                }
                if self.inflight.remove(&request_id).is_none() {
                    return Err(HostProtocolError {
                        code: HostProtocolErrorCode::UnknownRequest,
                        message: None,
                    });
                }
                Ok(None)
            }
            HostMessage::Heartbeat => {
                if self.state == HostInstanceState::Disposed
                    || self.state == HostInstanceState::Quarantined
                {
                    return Err(invalid_state(self.state));
                }
                Ok(Some(HostResponse::HeartbeatAck))
            }
            HostMessage::Quiesce => {
                if self.state != HostInstanceState::Active && self.state != HostInstanceState::Ready
                {
                    return Err(invalid_state(self.state));
                }
                self.state = HostInstanceState::Quiescing;
                Ok(Some(HostResponse::Quiesced))
            }
            HostMessage::Dispose => {
                if !matches!(
                    self.state,
                    HostInstanceState::Ready
                        | HostInstanceState::Active
                        | HostInstanceState::Quiescing
                ) {
                    return Err(invalid_state(self.state));
                }
                self.state = HostInstanceState::Disposing;
                self.inflight.clear();
                self.state = HostInstanceState::Disposed;
                Ok(Some(HostResponse::Disposed))
            }
        }
    }

    /// Force quarantine, revoking any in-flight state without executing code.
    pub fn quarantine(&mut self) {
        self.inflight.clear();
        self.state = HostInstanceState::Quarantined;
    }
}

impl Default for SyntheticEchoHost {
    fn default() -> Self {
        Self::new()
    }
}

fn invalid_state(state: HostInstanceState) -> HostProtocolError {
    HostProtocolError {
        code: HostProtocolErrorCode::InvalidStateTransition,
        message: Some(format!("invalid transition from {state:?}")),
    }
}

/// A broker-owned heartbeat supervisor that quarantines a host whose liveness
/// acknowledgement has not arrived within the timeout window. It holds no
/// privileged capability; it only flips a flag.
#[derive(Debug)]
pub struct HeartbeatSupervisor {
    last_ack: std::time::Instant,
    interval: Duration,
    timeout: Duration,
    quarantined: bool,
}

impl HeartbeatSupervisor {
    pub fn new(interval: Duration, timeout: Duration) -> Self {
        Self::new_at(interval, timeout, std::time::Instant::now())
    }

    pub fn new_at(interval: Duration, timeout: Duration, now: std::time::Instant) -> Self {
        Self {
            last_ack: now,
            interval,
            timeout,
            quarantined: false,
        }
    }

    pub fn record_ack(&mut self) {
        self.record_ack_at(std::time::Instant::now());
    }

    pub fn record_ack_at(&mut self, now: std::time::Instant) {
        self.last_ack = now;
    }

    /// Returns `true` when the instance must be quarantined for a missed
    /// heartbeat window. Pure and deterministic with respect to elapsed time.
    pub fn should_quarantine(&self) -> bool {
        self.should_quarantine_at(std::time::Instant::now())
    }

    pub fn should_quarantine_at(&self, now: std::time::Instant) -> bool {
        !self.quarantined
            && now
                .checked_duration_since(self.last_ack)
                .is_some_and(|elapsed| elapsed > self.timeout)
    }

    pub fn interval(&self) -> Duration {
        self.interval
    }

    pub fn is_quarantined(&self) -> bool {
        self.quarantined
    }

    pub fn set_quarantined(&mut self) {
        self.quarantined = true;
    }
}

/// A bounded synthetic fixture for `send_message`, enforcing the frame byte
/// bound while remaining transport-agnostic.
pub fn encode_host_frame(frame: &HostFrame) -> Result<Vec<u8>, ExtensionError> {
    let encoded = serde_json::to_vec(frame).map_err(|error| ExtensionError::ManifestParse {
        message: error.to_string(),
    })?;
    if encoded.len() > MAX_HOST_FRAME_BYTES {
        return Err(ExtensionError::ManifestValidation {
            reason: format!("host frame exceeds {MAX_HOST_FRAME_BYTES} bytes"),
        });
    }
    Ok(encoded)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn instance_id() -> HostInstanceId {
        HostInstanceId::new("instance.1").unwrap()
    }

    fn request_id() -> HostRequestId {
        HostRequestId::new("r1").unwrap()
    }

    fn dispatch(
        host: &mut SyntheticEchoHost,
        message: HostMessage,
    ) -> Result<Option<HostResponse>, HostProtocolError> {
        host.handle_frame(HostFrame {
            instance_id: host.instance_id().clone(),
            message,
        })
    }

    #[test]
    fn hello_then_activate_then_echo() {
        let mut host = SyntheticEchoHost::new();
        assert_eq!(host.state(), HostInstanceState::Created);

        let ready = dispatch(&mut host, HostMessage::Hello { api_version: 1 })
            .unwrap()
            .unwrap();
        assert_eq!(ready, HostResponse::Ready { api_version: 1 });
        assert_eq!(host.state(), HostInstanceState::Ready);

        let activated = dispatch(&mut host, HostMessage::Activate).unwrap().unwrap();
        assert_eq!(activated, HostResponse::Activated);
        assert_eq!(host.state(), HostInstanceState::Active);

        let echo = host
            .handle_frame(HostFrame {
                instance_id: host.instance_id().clone(),
                message: HostMessage::Echo {
                    request_id: request_id(),
                    payload: "hello".to_string(),
                },
            })
            .unwrap()
            .unwrap();
        assert_eq!(
            echo,
            HostResponse::EchoResult {
                request_id: request_id(),
                payload: "hello".to_string(),
            }
        );
    }

    #[test]
    fn rejects_version_mismatch() {
        let mut host = SyntheticEchoHost::new();
        let err = dispatch(&mut host, HostMessage::Hello { api_version: 2 }).unwrap_err();
        assert_eq!(err.code, HostProtocolErrorCode::VersionMismatch);
    }

    #[test]
    fn rejects_activate_before_hello() {
        let mut host = SyntheticEchoHost::new();
        let err = dispatch(&mut host, HostMessage::Activate).unwrap_err();
        assert_eq!(err.code, HostProtocolErrorCode::InvalidStateTransition);
    }

    #[test]
    fn rejects_oversized_echo_payload() {
        let mut host = SyntheticEchoHost::new();
        dispatch(&mut host, HostMessage::Hello { api_version: 1 }).unwrap();
        dispatch(&mut host, HostMessage::Activate).unwrap();
        let payload = "x".repeat(MAX_ECHO_PAYLOAD_BYTES + 1);
        let err = host
            .handle_frame(HostFrame {
                instance_id: host.instance_id().clone(),
                message: HostMessage::Echo {
                    request_id: request_id(),
                    payload,
                },
            })
            .unwrap_err();
        assert_eq!(err.code, HostProtocolErrorCode::PayloadTooLarge);
    }

    #[test]
    fn quarantine_drops_inflight_and_blocks_messages() {
        let mut host = SyntheticEchoHost::new();
        dispatch(&mut host, HostMessage::Hello { api_version: 1 }).unwrap();
        dispatch(&mut host, HostMessage::Activate).unwrap();
        host.quarantine();
        assert_eq!(host.state(), HostInstanceState::Quarantined);
        let err = dispatch(&mut host, HostMessage::Heartbeat).unwrap_err();
        assert_eq!(err.code, HostProtocolErrorCode::InvalidStateTransition);
    }

    #[test]
    fn heartbeat_supervisor_quarantines_after_timeout() {
        let start = std::time::Instant::now();
        let supervisor =
            HeartbeatSupervisor::new_at(Duration::from_millis(1), Duration::from_millis(1), start);
        assert!(!supervisor.should_quarantine_at(start));
        assert!(supervisor.should_quarantine_at(start + Duration::from_millis(2)));
    }

    #[test]
    fn frame_round_trip_respects_byte_bound() {
        let frame = HostFrame {
            instance_id: instance_id(),
            message: HostMessage::Echo {
                request_id: request_id(),
                payload: "ok".to_string(),
            },
        };
        let bytes = encode_host_frame(&frame).unwrap();
        let decoded = HostFrame::decode(&bytes).unwrap();
        assert_eq!(decoded, frame);
    }

    #[test]
    fn cross_instance_frame_is_rejected_before_dispatch() {
        let mut host = SyntheticEchoHost::with_instance_id(instance_id());
        let err = host
            .handle_frame(HostFrame {
                instance_id: HostInstanceId::new("instance.other").unwrap(),
                message: HostMessage::Hello { api_version: 1 },
            })
            .unwrap_err();
        assert_eq!(err.code, HostProtocolErrorCode::UnknownInstance);
        assert_eq!(host.state(), HostInstanceState::Created);
    }

    #[test]
    fn frame_rejects_unknown_nested_fields_and_invalid_ids() {
        let bytes = br#"{
            "instance_id":"instance.1",
            "message":{"type":"hello","api_version":1,"ambient_authority":true}
        }"#;
        assert!(HostFrame::decode(bytes).is_err());

        let invalid = br#"{"instance_id":"","message":{"type":"activate"}}"#;
        assert!(HostFrame::decode(invalid).is_err());
    }
}
