//! Native owners may normalize their arguments. Correlate their recorded result
//! with the original reverse request through plugins.delegated_operation instead
//! of treating normalized JSON as the original raw request or inventing a binding.
use rho_plugin_sdk::protocol::*;
use serde_json::{Value, json};

/// `expected` must come from the complete original delegated-operation query,
/// never from the returned record or model input.
pub(crate) fn operation_result(
    project_root: &str,
    instance: &PluginInstanceId,
    parent: &OperationId,
    capability: &CapabilityKey,
    expected: &OperationId,
    record: &Value,
) -> Result<(OperationId, Value), String> {
    let operation = &record["operation"];
    if operation["operation_id"] != expected.as_str()
        || operation["caller"]["kind"] != "plugin"
        || operation["caller"]["id"] != instance.as_str()
        || operation["causation_id"] != parent.as_str()
        || operation["idempotency_scope"] != project_root
        || operation["capability"] != json!(capability)
        || operation["preconditions"] != json!([])
        || !operation["normalized_arguments"].is_object()
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
        .any(|status| record["status"] == *status)
    {
        return Err("Host result differs from the original delegated Operation".into());
    }
    Ok((
        expected.clone(),
        json!({"operation_id":expected,"status":record["status"],"output":record["output"],
            "error":record["error"],"recovery":record["recovery"],"cancellation_requested":record["cancellation_requested"]}),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalized_host_result_requires_independently_correlated_original_identity() {
        let instance = PluginInstanceId::new("agent-one").unwrap();
        let parent = OperationId::new("original-send").unwrap();
        let expected = OperationId::new("original-checkpoint").unwrap();
        let capability = CapabilityKey {
            id: ContributionId::new("plugins.checkpoint").unwrap(),
            version: 1,
        };
        let record = json!({"operation":{"operation_id":expected,"caller":{"kind":"plugin","id":instance},
            "causation_id":parent,"idempotency_scope":"/original-project","capability":capability,
            "preconditions":[],"normalized_arguments":{"branch":"chosen","expected_head":"sha256:head","changes":{}}},
            "status":"succeeded","output":{"revision":"sha256:next"},"error":null,"recovery":null,
            "cancellation_requested":false});
        let verify = |record: &Value| {
            operation_result(
                "/original-project",
                &instance,
                &parent,
                &capability,
                &expected,
                record,
            )
        };
        assert_eq!(verify(&record).unwrap().1["output"], record["output"]);
        for (field, value) in [
            ("operation_id", json!("unrelated-operation")),
            ("caller", json!({"kind":"plugin","id":"another-instance"})),
            ("caller", json!({"kind":"local","id":"agent-one"})),
            ("causation_id", json!("another-send")),
            ("idempotency_scope", json!("/another-project")),
            ("capability", json!({"id":"scenarios.apply","version":1})),
            ("preconditions", json!([{"invented":true}])),
            ("normalized_arguments", Value::Null),
        ] {
            let mut wrong = record.clone();
            wrong["operation"][field] = value;
            assert!(verify(&wrong).is_err(), "{field}");
        }
        let mut wrong = record.clone();
        wrong["status"] = json!("completed");
        assert!(verify(&wrong).is_err());
        let mut pending = record.clone();
        pending["status"] = json!("uncertain");
        assert_eq!(verify(&pending).unwrap().1["status"], "uncertain");
    }
}
