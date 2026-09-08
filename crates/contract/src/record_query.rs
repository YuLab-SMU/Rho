use crate::{
    CapabilityDescriptor, CapabilityKind, CapabilityRef, NextRead, OperationId, OperationRecord,
    rebase_local_schema,
};
use schemars::{JsonSchema, schema_for};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, ts_rs::TS)]
#[serde(deny_unknown_fields)]
pub struct OperationGetArguments {
    pub operation_id: OperationId,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, ts_rs::TS)]
#[serde(deny_unknown_fields)]
pub struct OperationGetResult {
    /// Output/recovery are polymorphic according to this record's exact capability.
    pub record: Option<OperationRecord>,
    pub output_contract: Option<RecordedOperationContract>,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, ts_rs::TS)]
#[serde(deny_unknown_fields)]
pub struct RecordedOperationContract {
    pub capability: CapabilityRef,
    pub availability: RecordedContractAvailability,
    pub describe: Option<NextRead>,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, ts_rs::TS)]
#[serde(rename_all = "snake_case")]
pub enum RecordedContractAvailability {
    Registered,
    OwnerUnavailableInThisHost,
}

/// The registry supplies the only capability/schema source. Shared schema nodes
/// are interned once, and every known record branch fixes its capability identity.
pub fn operation_get_result_schema(descriptors: &[CapabilityDescriptor]) -> Value {
    let mut result = schema_for!(OperationGetResult).to_value();
    let mut nodes: Vec<Value> = vec![];
    let mut intern = |schema: &Value| -> Value {
        let index = nodes
            .iter()
            .position(|node| node == schema)
            .unwrap_or_else(|| {
                nodes.push(schema.clone());
                nodes.len() - 1
            });
        json!({"$ref":format!("#/$defs/record_payload_{index}")})
    };
    let mut known = vec![];
    let mut branches = vec![json!({"type":"null"})];
    for descriptor in descriptors
        .iter()
        .filter(|d| d.kind == CapabilityKind::Operation)
    {
        known.push(descriptor.capability.clone());
        let output = intern(&descriptor.output_schema);
        let recovery = intern(&descriptor.recovery_schema);
        branches.push(json!({"allOf":[
            {"$ref":"#/$defs/OperationRecord"},
            {"properties":{
                "operation":{"properties":{"capability":{"const":descriptor.capability}}},
                "output":{"anyOf":[{"type":"null"},output]},
                "recovery":recovery
            }}
        ]}));
    }
    let unavailable = if known.is_empty() {
        json!({})
    } else {
        json!({"not":{"enum":known}})
    };
    branches.push(json!({
        "description":"Historical output from an owner unavailable in this Host. Preserve the exact original value with its recorded capability identity; reading never starts that owner or a runtime.",
        "allOf":[{"$ref":"#/$defs/OperationRecord"},{"properties":{"operation":{"properties":{"capability":unavailable}}}}]
    }));
    result["properties"]["record"] = json!({"anyOf":branches});
    for (index, node) in nodes.into_iter().enumerate() {
        result["$defs"][format!("record_payload_{index}")] =
            rebase_local_schema(node, &format!("/$defs/record_payload_{index}"));
    }
    result
}
