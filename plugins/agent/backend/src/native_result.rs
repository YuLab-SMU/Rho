//! Verify the scientific owner record shared by native and component Agent tools.
use rho_plugin_sdk::protocol::*;
use serde_json::{Value, json};
pub(crate) fn operation_result(
    project: &str,
    instance: &PluginInstanceId,
    parent: &OperationId,
    request: &PluginRequest,
    record: &Value,
) -> Result<(OperationId, Value), String> {
    let operation = &record["operation"];
    let id = OperationId::new(
        operation["operation_id"]
            .as_str()
            .ok_or("Original native Operation identity is missing")?,
    )
    .map_err(|_| "Invalid native Operation identity")?;
    if operation["caller"]["kind"] != "plugin"
        || operation["caller"]["id"] != instance.as_str()
        || operation["causation_id"] != parent.as_str()
        || operation["idempotency_scope"] != project
        || operation["capability"] != json!(request.binding.capability)
        || operation["normalized_arguments"]["binding"] != json!(request.binding)
        || operation["normalized_arguments"]["arguments"] != request.arguments
        || operation["normalized_arguments"]["preconditions"] != request.preconditions
        || operation["admission"]["owner_context"]["binding"] != json!(request.binding)
        || ![
            "accepted",
            "running",
            "reconciling",
            "succeeded",
            "failed",
            "cancelled",
            "uncertain",
        ]
        .iter()
        .any(|state| record["status"] == *state)
    {
        return Err(
            "Native tool result differs from the original admitted binding, scope or parent".into(),
        );
    }
    Ok((
        id.clone(),
        json!({"operation_id":id,"status":record["status"],"output":record["output"],"error":record["error"],"recovery":record["recovery"],"cancellation_requested":record["cancellation_requested"]}),
    ))
}
