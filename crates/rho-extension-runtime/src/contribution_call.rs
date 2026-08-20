//! Exact-identity contribution call admission and result validation.
//!
//! This layer owns no broker authority. It binds one published manifest
//! declaration to one no-import Guest ABI V2 call, validates the input/output
//! schemas and budgets, and checks that every broker request uses a handle
//! supplied for that exact call.

use std::collections::BTreeMap;
use std::fmt;
use std::sync::OnceLock;
use std::time::Instant;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::{
    CapabilityId, ContributionInstanceIdentity, ContributionKind, ContributionStore, GuestStep,
    HostRequestId, ScopeId, WasmPluginHost,
};

pub const CONTRIBUTION_CALL_DEADLINE_MILLIS: u64 = 30_000;
pub const MAX_CONTRIBUTION_CALL_BYTES: usize = 256 * 1024;
pub const MAX_VIEWER_DOCUMENT_BYTES: usize = 1024 * 1024;
pub const MAX_CONTRIBUTION_CALL_HANDLES: usize = 64;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ContributionInvocationOrigin {
    UserCommand,
    AgentTool,
    TrustedSource,
    TrustedViewer,
    TrustedPanel,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ContributionCallErrorCode {
    MissingContribution,
    NotCallable,
    StaleIdentity,
    InvalidInput,
    InputTooLarge,
    InvalidHandleSet,
    HandleNotSupplied,
    DeadlineExceeded,
    SequenceViolation,
    HostRejected,
    InvalidOutput,
    OutputTooLarge,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ContributionCallError {
    pub code: ContributionCallErrorCode,
    message: String,
}

impl ContributionCallError {
    fn new(code: ContributionCallErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }

    pub fn message(&self) -> &str {
        &self.message
    }
}

impl fmt::Display for ContributionCallError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.message)
    }
}

impl std::error::Error for ContributionCallError {}

pub trait ContributionClock: Send + Sync {
    fn now_millis(&self) -> u64;
}

#[derive(Debug, Default)]
pub struct SystemContributionClock;

impl ContributionClock for SystemContributionClock {
    fn now_millis(&self) -> u64 {
        static ORIGIN: OnceLock<Instant> = OnceLock::new();
        u64::try_from(ORIGIN.get_or_init(Instant::now).elapsed().as_millis()).unwrap_or(u64::MAX)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ContributionCallProvenance {
    pub call_id: String,
    pub contribution_id: CapabilityId,
    pub contract_major: u64,
    pub project_id: ScopeId,
    pub plugin_id: crate::PluginId,
    pub package_digest: crate::PackageDigest,
    pub activation_generation: crate::ActivationGeneration,
    pub host_instance_id: crate::HostInstanceId,
    pub origin: ContributionInvocationOrigin,
    pub broker_steps: usize,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum ContributionCallOutcome {
    Completed {
        result: Value,
        provenance: ContributionCallProvenance,
    },
    Failed {
        code: String,
        provenance: ContributionCallProvenance,
    },
}

/// Trusted host input for one contribution admission. Debug output never
/// exposes the raw capability handles.
pub struct ContributionCallRequest {
    pub project_id: ScopeId,
    pub contribution_id: CapabilityId,
    pub origin: ContributionInvocationOrigin,
    pub input: Value,
    pub supplied_handles: BTreeMap<String, String>,
}

impl fmt::Debug for ContributionCallRequest {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ContributionCallRequest")
            .field("project_id", &self.project_id)
            .field("contribution_id", &self.contribution_id)
            .field("origin", &self.origin)
            .field("input", &self.input)
            .field("supplied_handles", &"<redacted>")
            .finish()
    }
}

/// Memory-only state for one admitted call. Custom Debug intentionally omits
/// the raw capability handle set.
pub struct ContributionCallSession {
    request_id: HostRequestId,
    call_id: String,
    identity: ContributionInstanceIdentity,
    contribution_id: CapabilityId,
    contract_major: u64,
    kind: ContributionKind,
    output_schema: crate::BoundedJsonSchema,
    origin: ContributionInvocationOrigin,
    deadline_millis: u64,
    supplied_handles: BTreeMap<String, String>,
    broker_steps: usize,
    waiting_for_broker: bool,
    terminal: bool,
}

impl fmt::Debug for ContributionCallSession {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ContributionCallSession")
            .field("request_id", &self.request_id)
            .field("call_id", &self.call_id)
            .field("identity", &self.identity)
            .field("contribution_id", &self.contribution_id)
            .field("contract_major", &self.contract_major)
            .field("origin", &self.origin)
            .field("deadline_millis", &self.deadline_millis)
            .field("supplied_handles", &"<redacted>")
            .field("broker_steps", &self.broker_steps)
            .field("waiting_for_broker", &self.waiting_for_broker)
            .field("terminal", &self.terminal)
            .finish()
    }
}

impl ContributionCallSession {
    pub fn request_id(&self) -> &HostRequestId {
        &self.request_id
    }

    pub fn call_id(&self) -> &str {
        &self.call_id
    }

    pub fn identity(&self) -> &ContributionInstanceIdentity {
        &self.identity
    }

    pub fn supplied_handles_are_live(&self, mut is_live: impl FnMut(&str) -> bool) -> bool {
        self.supplied_handles
            .values()
            .all(|handle_id| is_live(handle_id))
    }

    pub fn invalidate_before_publish(&mut self) {
        self.terminal = true;
        self.waiting_for_broker = false;
    }

    pub fn begin(
        registry: &ContributionStore,
        request: ContributionCallRequest,
        clock: &dyn ContributionClock,
        host: &mut WasmPluginHost,
    ) -> Result<(Self, GuestStep), ContributionCallError> {
        let ContributionCallRequest {
            project_id,
            contribution_id,
            origin,
            input,
            supplied_handles,
        } = request;
        validate_handle_set(&supplied_handles)?;
        let record = registry.get(&project_id, &contribution_id).ok_or_else(|| {
            ContributionCallError::new(
                ContributionCallErrorCode::MissingContribution,
                "contribution is not published for this project",
            )
        })?;
        if record.contribution.kind == ContributionKind::Skill {
            return Err(ContributionCallError::new(
                ContributionCallErrorCode::NotCallable,
                "declarative Skill contributions are not callable",
            ));
        }
        let identity = ContributionInstanceIdentity::new(
            record.project_id.clone(),
            record.plugin_id.clone(),
            record.package_digest.clone(),
            record.activation_generation,
            record.host_instance_id.clone(),
        );
        ensure_current_host(&identity, host)?;
        let input_bytes = encoded_len(&input, ContributionCallErrorCode::InvalidInput)?;
        let input_limit = MAX_CONTRIBUTION_CALL_BYTES;
        if input_bytes > input_limit {
            return Err(ContributionCallError::new(
                ContributionCallErrorCode::InputTooLarge,
                "contribution input exceeds its byte budget",
            ));
        }
        record
            .contribution
            .input_schema
            .as_ref()
            .ok_or_else(|| {
                ContributionCallError::new(
                    ContributionCallErrorCode::NotCallable,
                    "contribution has no input schema",
                )
            })?
            .validate_instance(&input)
            .map_err(|_| {
                ContributionCallError::new(
                    ContributionCallErrorCode::InvalidInput,
                    "contribution input does not match the declared schema",
                )
            })?;
        let output_schema = record.contribution.output_schema.clone().ok_or_else(|| {
            ContributionCallError::new(
                ContributionCallErrorCode::NotCallable,
                "contribution has no output schema",
            )
        })?;
        let now = clock.now_millis();
        let deadline_millis = now
            .checked_add(CONTRIBUTION_CALL_DEADLINE_MILLIS)
            .ok_or_else(|| {
                ContributionCallError::new(
                    ContributionCallErrorCode::DeadlineExceeded,
                    "contribution deadline cannot be represented",
                )
            })?;
        let request_id = HostRequestId::generate();
        let envelope = serde_json::json!({
            "contribution": {
                "id": record.contribution.capability,
                "contract_major": record.contribution.contract_major,
            },
            "project_id": record.project_id,
            "plugin_id": record.plugin_id,
            "package_digest": record.package_digest,
            "activation_generation": record.activation_generation,
            "host_instance_id": record.host_instance_id,
            "origin": origin,
            "input": input,
            "capability_handles": supplied_handles,
            "deadline_millis": CONTRIBUTION_CALL_DEADLINE_MILLIS,
        });
        let step = host
            .begin_contribution_call(request_id.clone(), envelope)
            .map_err(|error| {
                ContributionCallError::new(
                    ContributionCallErrorCode::HostRejected,
                    format!("contribution guest begin failed: {:?}", error.code),
                )
            })?;
        let call_id = guest_step_call_id(&step).to_string();
        let mut session = Self {
            request_id,
            call_id,
            identity,
            contribution_id,
            contract_major: record.contribution.contract_major,
            kind: record.contribution.kind,
            output_schema,
            origin,
            deadline_millis,
            supplied_handles,
            broker_steps: 0,
            waiting_for_broker: false,
            terminal: false,
        };
        if let Err(error) = session.accept_step(&step) {
            let _ = host.cancel_broker_call(&session.request_id);
            return Err(error);
        }
        Ok((session, step))
    }

    pub fn resume(
        &mut self,
        registry: &ContributionStore,
        broker_result: &Value,
        raw_result_bytes: usize,
        clock: &dyn ContributionClock,
        host: &mut WasmPluginHost,
    ) -> Result<GuestStep, ContributionCallError> {
        self.ensure_live(registry, clock, host)?;
        if self.terminal || !self.waiting_for_broker {
            return Err(ContributionCallError::new(
                ContributionCallErrorCode::SequenceViolation,
                "contribution call is not waiting for a broker result",
            ));
        }
        self.waiting_for_broker = false;
        let step = host
            .resume_contribution_call(&self.request_id, broker_result, raw_result_bytes)
            .map_err(|error| {
                ContributionCallError::new(
                    ContributionCallErrorCode::HostRejected,
                    format!("contribution guest resume failed: {:?}", error.code),
                )
            })?;
        if let Err(error) = self.accept_step(&step) {
            let _ = host.cancel_broker_call(&self.request_id);
            return Err(error);
        }
        Ok(step)
    }

    pub fn finish(
        &mut self,
        registry: &ContributionStore,
        step: &GuestStep,
        clock: &dyn ContributionClock,
        host: &mut WasmPluginHost,
    ) -> Result<ContributionCallOutcome, ContributionCallError> {
        self.ensure_live(registry, clock, host)?;
        if self.terminal {
            return Err(ContributionCallError::new(
                ContributionCallErrorCode::SequenceViolation,
                "contribution call already reached a terminal state",
            ));
        }
        if guest_step_call_id(step) != self.call_id {
            return Err(ContributionCallError::new(
                ContributionCallErrorCode::SequenceViolation,
                "contribution terminal call id does not match admission",
            ));
        }
        let provenance = self.provenance();
        let outcome = match step {
            GuestStep::Complete { result, .. } => {
                self.terminal = true;
                self.waiting_for_broker = false;
                validate_terminal_result(self.kind, &self.output_schema, result)?;
                ContributionCallOutcome::Completed {
                    result: result.clone(),
                    provenance,
                }
            }
            GuestStep::Error { code, .. } => {
                self.terminal = true;
                self.waiting_for_broker = false;
                ContributionCallOutcome::Failed {
                    code: code.clone(),
                    provenance,
                }
            }
            GuestStep::BrokerRequest { .. } => {
                return Err(ContributionCallError::new(
                    ContributionCallErrorCode::SequenceViolation,
                    "contribution call has not reached a terminal step",
                ));
            }
        };
        Ok(outcome)
    }

    pub fn cancel(&mut self, host: &mut WasmPluginHost) -> Result<bool, ContributionCallError> {
        if self.terminal {
            return Ok(false);
        }
        let cancelled = host.cancel_broker_call(&self.request_id).map_err(|error| {
            ContributionCallError::new(
                ContributionCallErrorCode::HostRejected,
                format!("contribution guest cancel failed: {:?}", error.code),
            )
        })?;
        self.terminal = true;
        self.waiting_for_broker = false;
        Ok(cancelled)
    }

    fn accept_step(&mut self, step: &GuestStep) -> Result<(), ContributionCallError> {
        if guest_step_call_id(step) != self.call_id {
            return Err(ContributionCallError::new(
                ContributionCallErrorCode::SequenceViolation,
                "contribution guest step has a mismatched call id",
            ));
        }
        match step {
            GuestStep::BrokerRequest {
                handle_id,
                permission,
                ..
            } => {
                if self.supplied_handles.get(permission) != Some(handle_id) {
                    return Err(ContributionCallError::new(
                        ContributionCallErrorCode::HandleNotSupplied,
                        "guest requested a handle not supplied for this call",
                    ));
                }
                self.broker_steps += 1;
                self.waiting_for_broker = true;
            }
            GuestStep::Complete { .. } | GuestStep::Error { .. } => {
                self.waiting_for_broker = false;
            }
        }
        Ok(())
    }

    fn ensure_live(
        &mut self,
        registry: &ContributionStore,
        clock: &dyn ContributionClock,
        host: &mut WasmPluginHost,
    ) -> Result<(), ContributionCallError> {
        if clock.now_millis() >= self.deadline_millis {
            let _ = host.cancel_broker_call(&self.request_id);
            self.terminal = true;
            self.waiting_for_broker = false;
            return Err(ContributionCallError::new(
                ContributionCallErrorCode::DeadlineExceeded,
                "contribution call exceeded its 30-second deadline",
            ));
        }
        ensure_current_host(&self.identity, host)?;
        let current = registry
            .get(&self.identity.project_id, &self.contribution_id)
            .is_some_and(|record| {
                record.plugin_id == self.identity.plugin_id
                    && record.package_digest == self.identity.package_digest
                    && record.activation_generation == self.identity.activation_generation
                    && record.host_instance_id == self.identity.host_instance_id
                    && record.contribution.contract_major == self.contract_major
            });
        if !current {
            let _ = host.cancel_broker_call(&self.request_id);
            self.terminal = true;
            self.waiting_for_broker = false;
            return Err(ContributionCallError::new(
                ContributionCallErrorCode::StaleIdentity,
                "contribution route changed before completion",
            ));
        }
        Ok(())
    }

    fn provenance(&self) -> ContributionCallProvenance {
        ContributionCallProvenance {
            call_id: self.call_id.clone(),
            contribution_id: self.contribution_id.clone(),
            contract_major: self.contract_major,
            project_id: self.identity.project_id.clone(),
            plugin_id: self.identity.plugin_id.clone(),
            package_digest: self.identity.package_digest.clone(),
            activation_generation: self.identity.activation_generation,
            host_instance_id: self.identity.host_instance_id.clone(),
            origin: self.origin,
            broker_steps: self.broker_steps,
        }
    }
}

fn validate_handle_set(handles: &BTreeMap<String, String>) -> Result<(), ContributionCallError> {
    if handles.len() > MAX_CONTRIBUTION_CALL_HANDLES {
        return Err(ContributionCallError::new(
            ContributionCallErrorCode::InvalidHandleSet,
            "contribution handle set exceeds its item budget",
        ));
    }
    for (permission, handle_id) in handles {
        let token = handle_id.strip_prefix("handle.").unwrap_or_default();
        if !matches!(
            permission.as_str(),
            "project.fs.read" | "workspace.r.inspect" | "network.fetch"
        ) || token.len() != 64
            || !token
                .bytes()
                .all(|byte| byte.is_ascii_digit() || matches!(byte, b'a'..=b'f'))
        {
            return Err(ContributionCallError::new(
                ContributionCallErrorCode::InvalidHandleSet,
                "contribution handle set is malformed",
            ));
        }
    }
    Ok(())
}

fn ensure_current_host(
    identity: &ContributionInstanceIdentity,
    host: &WasmPluginHost,
) -> Result<(), ContributionCallError> {
    let host_identity = host.identity();
    if host_identity.project_id() != &identity.project_id
        || host_identity.plugin_id() != &identity.plugin_id
        || host_identity.package_digest() != &identity.package_digest
        || host_identity.activation_generation() != identity.activation_generation
        || host_identity.host_instance_id() != &identity.host_instance_id
    {
        return Err(ContributionCallError::new(
            ContributionCallErrorCode::StaleIdentity,
            "contribution route does not match the live Wasm host",
        ));
    }
    Ok(())
}

fn validate_terminal_result(
    kind: ContributionKind,
    schema: &crate::BoundedJsonSchema,
    result: &Value,
) -> Result<(), ContributionCallError> {
    let bytes = encoded_len(result, ContributionCallErrorCode::InvalidOutput)?;
    if bytes > call_byte_limit(kind) {
        return Err(ContributionCallError::new(
            ContributionCallErrorCode::OutputTooLarge,
            "contribution output exceeds its byte budget",
        ));
    }
    schema.validate_instance(result).map_err(|_| {
        ContributionCallError::new(
            ContributionCallErrorCode::InvalidOutput,
            "contribution output does not match the declared schema",
        )
    })
}

fn call_byte_limit(kind: ContributionKind) -> usize {
    if matches!(kind, ContributionKind::Viewer | ContributionKind::Panel) {
        MAX_VIEWER_DOCUMENT_BYTES
    } else {
        MAX_CONTRIBUTION_CALL_BYTES
    }
}

fn encoded_len(
    value: &Value,
    code: ContributionCallErrorCode,
) -> Result<usize, ContributionCallError> {
    serde_json::to_vec(value)
        .map(|encoded| encoded.len())
        .map_err(|_| ContributionCallError::new(code, "contribution JSON could not be encoded"))
}

fn guest_step_call_id(step: &GuestStep) -> &str {
    match step {
        GuestStep::BrokerRequest { call_id, .. }
        | GuestStep::Complete { call_id, .. }
        | GuestStep::Error { call_id, .. } => call_id,
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use serde_json::json;

    use super::*;
    use crate::{
        ActivationGeneration, BoundedJsonSchema, BrokerCallIdSource, ContributionDeclaration,
        ContributionInstanceIdentity, ContributionKind, HOST_PROTOCOL_VERSION, HostFrame,
        HostInstanceId, HostMessage, HostResponse, P2_2_SMOKE_WASM, PackageDigest, PluginId,
        WasmHostIdentity,
    };

    #[derive(Debug)]
    struct FixedClock(std::sync::atomic::AtomicU64);

    impl FixedClock {
        fn new(value: u64) -> Self {
            Self(std::sync::atomic::AtomicU64::new(value))
        }

        fn set(&self, value: u64) {
            self.0.store(value, std::sync::atomic::Ordering::SeqCst);
        }
    }

    impl ContributionClock for FixedClock {
        fn now_millis(&self) -> u64 {
            self.0.load(std::sync::atomic::Ordering::SeqCst)
        }
    }

    #[derive(Debug)]
    struct FixedCallId;

    impl BrokerCallIdSource for FixedCallId {
        fn next_call_id(&self) -> u64 {
            42
        }
    }

    fn schema(value: Value) -> BoundedJsonSchema {
        BoundedJsonSchema::new(value).unwrap()
    }

    fn identity() -> ContributionInstanceIdentity {
        ContributionInstanceIdentity::new(
            ScopeId::new("project.fixture").unwrap(),
            PluginId::new("org.example.fixture").unwrap(),
            PackageDigest::from_inventory(&[(b"plugin.wasm", P2_2_SMOKE_WASM)]),
            ActivationGeneration::new(1).unwrap(),
            HostInstanceId::new("instance.fixture").unwrap(),
        )
    }

    fn declaration() -> ContributionDeclaration {
        ContributionDeclaration {
            id: CapabilityId::new("tool.fixture.read").unwrap(),
            kind: ContributionKind::Tool,
            contract_major: 1,
            label: "Read fixture".to_string(),
            purpose: "Read bounded fixture metadata".to_string(),
            input_schema: Some(schema(json!({"type": "object", "properties": {}}))),
            output_schema: Some(schema(json!({
                "type": "object",
                "properties": {"smoke": {"type": "boolean"}},
                "required": ["smoke"]
            }))),
            media_types: Vec::new(),
            skill_path: None,
            panel_slot: None,
        }
    }

    fn registry_fixture() -> ContributionStore {
        let mut registry = ContributionStore::new();
        let candidate = ContributionStore::stage(identity(), vec![declaration()]).unwrap();
        registry.publish(candidate, None).unwrap();
        registry
    }

    fn host_fixture() -> WasmPluginHost {
        let identity = identity();
        let mut host = WasmPluginHost::from_bytes_with_call_id_source(
            WasmHostIdentity::new(
                identity.project_id,
                identity.plugin_id,
                identity.package_digest,
                identity.activation_generation,
                identity.host_instance_id.clone(),
            ),
            P2_2_SMOKE_WASM,
            Arc::new(FixedCallId),
        )
        .unwrap();
        let frame = |message| HostFrame {
            instance_id: identity.host_instance_id.clone(),
            message,
        };
        assert!(matches!(
            host.handle_frame(frame(HostMessage::Hello {
                api_version: HOST_PROTOCOL_VERSION
            }))
            .unwrap(),
            Some(HostResponse::Ready { .. })
        ));
        assert_eq!(
            host.handle_frame(frame(HostMessage::Activate)).unwrap(),
            Some(HostResponse::Activated)
        );
        host
    }

    fn handles() -> BTreeMap<String, String> {
        BTreeMap::from([(
            "project.fs.read".to_string(),
            format!("handle.{}", "a".repeat(64)),
        )])
    }

    fn call_request(
        origin: ContributionInvocationOrigin,
        input: Value,
        supplied_handles: BTreeMap<String, String>,
    ) -> ContributionCallRequest {
        ContributionCallRequest {
            project_id: identity().project_id,
            contribution_id: CapabilityId::new("tool.fixture.read").unwrap(),
            origin,
            input,
            supplied_handles,
        }
    }

    #[test]
    fn exact_route_yields_resumes_and_validates_output() {
        let registry = registry_fixture();
        let mut host = host_fixture();
        let clock = FixedClock::new(100);
        let (mut session, first) = ContributionCallSession::begin(
            &registry,
            call_request(
                ContributionInvocationOrigin::AgentTool,
                json!({}),
                handles(),
            ),
            &clock,
            &mut host,
        )
        .unwrap();
        assert!(matches!(first, GuestStep::BrokerRequest { .. }));
        assert!(!format!("{session:?}").contains("handle.aaaa"));
        let terminal = session
            .resume(&registry, &json!({"ok": true}), 2, &clock, &mut host)
            .unwrap();
        let outcome = session
            .finish(&registry, &terminal, &clock, &mut host)
            .unwrap();
        assert!(matches!(outcome, ContributionCallOutcome::Completed { .. }));
        assert_eq!(
            session.finish(&registry, &terminal, &clock, &mut host),
            Err(ContributionCallError::new(
                ContributionCallErrorCode::SequenceViolation,
                "contribution call already reached a terminal state"
            ))
        );
    }

    #[test]
    fn stale_route_deadline_and_unsupplied_handle_withhold_results() {
        let mut registry = registry_fixture();
        let clock = FixedClock::new(100);
        let mut host = host_fixture();
        let (mut session, _) = ContributionCallSession::begin(
            &registry,
            call_request(
                ContributionInvocationOrigin::TrustedSource,
                json!({}),
                handles(),
            ),
            &clock,
            &mut host,
        )
        .unwrap();
        registry.unpublish(&identity()).unwrap();
        assert_eq!(
            session
                .resume(&registry, &json!({"ok": true}), 2, &clock, &mut host)
                .unwrap_err()
                .code,
            ContributionCallErrorCode::StaleIdentity
        );

        let registry = registry_fixture();
        let mut host = host_fixture();
        let (mut session, _) = ContributionCallSession::begin(
            &registry,
            call_request(
                ContributionInvocationOrigin::TrustedSource,
                json!({}),
                handles(),
            ),
            &clock,
            &mut host,
        )
        .unwrap();
        clock.set(100 + CONTRIBUTION_CALL_DEADLINE_MILLIS);
        assert_eq!(
            session
                .resume(&registry, &json!({"ok": true}), 2, &clock, &mut host)
                .unwrap_err()
                .code,
            ContributionCallErrorCode::DeadlineExceeded
        );

        let mut host = host_fixture();
        let error = ContributionCallSession::begin(
            &registry,
            call_request(
                ContributionInvocationOrigin::AgentTool,
                json!({}),
                BTreeMap::from([(
                    "project.fs.read".to_string(),
                    format!("handle.{}", "b".repeat(64)),
                )]),
            ),
            &FixedClock::new(1),
            &mut host,
        )
        .unwrap_err();
        assert_eq!(error.code, ContributionCallErrorCode::HandleNotSupplied);
    }

    #[test]
    fn input_output_and_identity_checks_fail_closed() {
        let registry = registry_fixture();
        let mut host = host_fixture();
        let error = ContributionCallSession::begin(
            &registry,
            call_request(
                ContributionInvocationOrigin::UserCommand,
                json!({"unknown": true}),
                handles(),
            ),
            &FixedClock::new(1),
            &mut host,
        )
        .unwrap_err();
        assert_eq!(error.code, ContributionCallErrorCode::InvalidInput);

        let wrong_identity = WasmHostIdentity::new(
            ScopeId::new("project.other").unwrap(),
            identity().plugin_id,
            identity().package_digest,
            identity().activation_generation,
            identity().host_instance_id,
        );
        let mut wrong_host = WasmPluginHost::from_bytes_with_call_id_source(
            wrong_identity,
            P2_2_SMOKE_WASM,
            Arc::new(FixedCallId),
        )
        .unwrap();
        let error = ContributionCallSession::begin(
            &registry,
            call_request(
                ContributionInvocationOrigin::UserCommand,
                json!({}),
                handles(),
            ),
            &FixedClock::new(1),
            &mut wrong_host,
        )
        .unwrap_err();
        assert_eq!(error.code, ContributionCallErrorCode::StaleIdentity);

        let output_schema = schema(json!({
            "type": "object",
            "properties": {"payload": {"type": "string", "maxLength": 2_000_000}},
            "required": ["payload"]
        }));
        let overhead = serde_json::to_vec(&json!({"payload": ""})).unwrap().len();
        for (kind, limit) in [
            (ContributionKind::Tool, MAX_CONTRIBUTION_CALL_BYTES),
            (ContributionKind::Viewer, MAX_VIEWER_DOCUMENT_BYTES),
        ] {
            let exact = json!({"payload": "x".repeat(limit - overhead)});
            assert_eq!(serde_json::to_vec(&exact).unwrap().len(), limit);
            assert!(validate_terminal_result(kind, &output_schema, &exact).is_ok());
            let over = json!({"payload": "x".repeat(limit + 1 - overhead)});
            assert_eq!(
                validate_terminal_result(kind, &output_schema, &over)
                    .unwrap_err()
                    .code,
                ContributionCallErrorCode::OutputTooLarge
            );
        }
    }
}
