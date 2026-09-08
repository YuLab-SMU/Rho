//! Shared recovery is evidence, never authorization to repeat an operation.
use crate::{CapabilityRef, ObservationCompleteness, OperationOutcome};
use schemars::{JsonSchema, schema_for};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, ts_rs::TS)]
#[serde(deny_unknown_fields)]
pub struct ObserveOwnerRecovery {
    pub action: ObserveOwnerAction,
    pub automatic_reexecution: bool,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema, ts_rs::TS)]
#[serde(rename_all = "snake_case")]
pub enum ObserveOwnerAction {
    ObserveOwnerBeforeAnyRetry,
}
impl Default for ObserveOwnerRecovery {
    fn default() -> Self {
        Self {
            action: ObserveOwnerAction::ObserveOwnerBeforeAnyRetry,
            automatic_reexecution: false,
        }
    }
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, ts_rs::TS)]
#[serde(
    tag = "previous_status",
    rename_all = "snake_case",
    deny_unknown_fields
)]
pub enum HostRestartRecovery {
    Accepted { action: BeforeStartRecoveryAction },
    Running { action: AfterStartRecoveryAction },
    Reconciling { action: AfterStartRecoveryAction },
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, ts_rs::TS)]
#[serde(rename_all = "snake_case")]
pub enum BeforeStartRecoveryAction {
    SafeToSubmitWithANewClientRequestId,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, ts_rs::TS)]
#[serde(rename_all = "snake_case")]
pub enum AfterStartRecoveryAction {
    OwnerReconciliationRequired,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, ts_rs::TS)]
#[serde(deny_unknown_fields)]
pub struct ContractFailureRecovery {
    pub kind: ContractFailureKind,
    pub capability: CapabilityRef,
    pub automatic_reexecution: bool,
    pub execution_started: bool,
    pub violations: Vec<OwnerContractViolation>,
    /// Original uncommitted values. These are unvalidated evidence, not domain facts.
    pub candidate: UncommittedOwnerResult,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema, ts_rs::TS)]
#[serde(rename_all = "snake_case")]
pub enum ContractFailureKind {
    OwnerContractViolation,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, ts_rs::TS)]
#[serde(deny_unknown_fields)]
pub struct OwnerContractViolation {
    pub field: String,
    pub message: String,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, ts_rs::TS)]
#[serde(deny_unknown_fields)]
pub struct UncommittedOwnerResult {
    pub outcome: OperationOutcome,
    /// Exact original owner output, which failed its recorded capability contract.
    pub output: Option<Value>,
    pub error: Option<String>,
    /// Exact original recovery material, retained even when malformed.
    pub recovery: Option<Value>,
    pub facts: Vec<UncommittedFact>,
    pub effect_observations: Vec<UncommittedEffectObservation>,
    pub events: Vec<UncommittedEvent>,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, ts_rs::TS)]
#[serde(deny_unknown_fields)]
pub struct UncommittedFact {
    pub domain: String,
    pub schema: String,
    pub key: String,
    /// Unvalidated original fact payload; this recovery document does not commit it.
    pub value: Value,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, ts_rs::TS)]
#[serde(deny_unknown_fields)]
pub struct UncommittedEffectObservation {
    pub kind: String,
    pub source: String,
    /// Unvalidated original owner observation, retained solely for investigation.
    pub detail: Value,
    pub observed_at_ms: i64,
    pub completeness: ObservationCompleteness,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, ts_rs::TS)]
#[serde(deny_unknown_fields)]
pub struct UncommittedEvent {
    pub kind: String,
    /// Unvalidated original event; it has not been published to the scientific outbox.
    pub payload: Value,
}

/// Embed a whole schema as one local definition without mixing unrelated $defs.
/// All references remain local to the newly composed document.
pub fn rebase_local_schema(mut schema: Value, pointer: &str) -> Value {
    fn rewrite(value: &mut Value, pointer: &str) {
        match value {
            Value::Object(object) => {
                // A composed contract has one document identity and dialect.
                object.remove("$id");
                object.remove("$schema");
                if let Some(Value::String(reference)) = object.get_mut("$ref") {
                    if reference == "#" {
                        *reference = format!("#{pointer}");
                    } else if reference.starts_with("#/") {
                        *reference = format!("#{pointer}{}", &reference[1..]);
                    }
                }
                for child in object.values_mut() {
                    rewrite(child, pointer);
                }
            }
            Value::Array(values) => {
                for child in values {
                    rewrite(child, pointer);
                }
            }
            _ => (),
        }
    }
    rewrite(&mut schema, pointer);
    schema
}

/// Native owners supply their own schema; registration composes this same public
/// schema before compiling its validator and advertising the capability.
pub fn operation_recovery_schema(native: Value) -> Value {
    let mut observe = schema_for!(ObserveOwnerRecovery).to_value();
    observe["properties"]["automatic_reexecution"] = json!({"const":false});
    let mut fault = schema_for!(ContractFailureRecovery).to_value();
    fault["properties"]["automatic_reexecution"] = json!({"const":false});
    json!({
        "$schema":"https://json-schema.org/draft/2020-12/schema",
        "$defs":{
            "native_recovery":rebase_local_schema(native,"/$defs/native_recovery"),
            "observe_owner":rebase_local_schema(observe,"/$defs/observe_owner"),
            "contract_failure":rebase_local_schema(fault,"/$defs/contract_failure"),
            "host_restart":rebase_local_schema(schema_for!(HostRestartRecovery).to_value(),"/$defs/host_restart")
        },
        "anyOf":[{"type":"null"},{"$ref":"#/$defs/native_recovery"},{"$ref":"#/$defs/observe_owner"},{"$ref":"#/$defs/contract_failure"},{"$ref":"#/$defs/host_restart"}]
    })
}
