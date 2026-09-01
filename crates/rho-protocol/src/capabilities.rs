use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::{
    execution::ExecutorKind,
    ids::CapabilityId,
    operation::{OperationContext, OperationResult},
    taxonomy::{DataClass, DestinationClass, EffectClass, RetryClass, TargetClass},
    versioning::CANONICAL_SCHEMA_VERSION,
};

pub const RUN_R_CAPABILITY: &str = "workspace.run_r";
pub const ENVIRONMENT_INSPECT_CAPABILITY: &str = "environment.inspect";
pub const ENVIRONMENT_EXPLAIN_INCIDENT_CAPABILITY: &str = "environment.explain_incident";
pub const ENVIRONMENT_PROPOSE_CHANGE_CAPABILITY: &str = "environment.propose_change";
pub const ENVIRONMENT_REQUEST_APPLY_PLAN_CAPABILITY: &str = "environment.request_apply_plan";
pub const ENVIRONMENT_OPERATION_INSPECT_CAPABILITY: &str = "environment.operation.inspect";
pub const RUN_R_EFFECT_CLASS: EffectClass = EffectClass::WorkspaceMutation;
pub const RUN_R_RETRY_CLASS: RetryClass = RetryClass::NonIdempotent;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct CapabilityDescriptor {
    pub schema_version: u16,
    pub id: CapabilityId,
    pub display_name: String,
    pub input_schema: Value,
    pub output_schema: Value,
    pub effect_class: EffectClass,
    pub retry_class: RetryClass,
    pub data_class: DataClass,
    pub target_class: TargetClass,
    pub allowed_executors: Vec<ExecutorKind>,
    pub requires_workspace: bool,
}

impl CapabilityDescriptor {
    // Keep policy dimensions explicit at construction; a positional typo is
    // caught by their distinct enum types and no partially valid descriptor exists.
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        id: CapabilityId,
        display_name: impl Into<String>,
        effect_class: EffectClass,
        retry_class: RetryClass,
        data_class: DataClass,
        target_class: TargetClass,
        allowed_executors: Vec<ExecutorKind>,
        requires_workspace: bool,
    ) -> Self {
        Self {
            schema_version: CANONICAL_SCHEMA_VERSION,
            id,
            display_name: display_name.into(),
            input_schema: Value::Object(Default::default()),
            output_schema: Value::Object(Default::default()),
            effect_class,
            retry_class,
            data_class,
            target_class,
            allowed_executors,
            requires_workspace,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct CapabilityRequest {
    pub schema_version: u16,
    pub capability_id: CapabilityId,
    pub operation: OperationContext,
    pub arguments: Value,
    pub data_class: DataClass,
    pub destination: DestinationClass,
}

impl CapabilityRequest {
    pub fn new(capability_id: CapabilityId, operation: OperationContext, arguments: Value) -> Self {
        Self {
            schema_version: CANONICAL_SCHEMA_VERSION,
            capability_id,
            operation,
            arguments,
            data_class: DataClass::ProjectConfidential,
            destination: DestinationClass::LocalWorkspace,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct CapabilityResponse {
    pub schema_version: u16,
    pub capability_id: CapabilityId,
    pub result: OperationResult,
    pub output: Value,
}

impl CapabilityResponse {
    pub fn new(capability_id: CapabilityId, result: OperationResult, output: Value) -> Self {
        Self {
            schema_version: CANONICAL_SCHEMA_VERSION,
            capability_id,
            result,
            output,
        }
    }
}

pub fn run_r_descriptor() -> CapabilityDescriptor {
    CapabilityDescriptor {
        schema_version: CANONICAL_SCHEMA_VERSION,
        id: CapabilityId::new(RUN_R_CAPABILITY).expect("static capability id is valid"),
        display_name: "Run R code in the authoritative Workspace".to_string(),
        input_schema: json!({
            "type": "object",
            "required": ["code"],
            "additionalProperties": false,
            "properties": {
                "code": { "type": "string", "minLength": 1 },
                "timeout_ms": { "type": "integer", "minimum": 1 },
                "expected_outputs": { "type": "array", "items": { "type": "string" } }
            }
        }),
        output_schema: json!({
            "type": "object",
            "required": ["revision_after", "diagnostics"],
            "additionalProperties": true,
            "properties": {
                "revision_after": { "type": "object" },
                "diagnostics": { "type": "array" },
                "artifacts": { "type": "array" }
            }
        }),
        effect_class: RUN_R_EFFECT_CLASS,
        retry_class: RUN_R_RETRY_CLASS,
        data_class: DataClass::ProjectConfidential,
        target_class: TargetClass::Workspace,
        allowed_executors: vec![ExecutorKind::Workspace],
        requires_workspace: true,
    }
}
