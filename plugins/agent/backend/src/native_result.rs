//! Verify the scientific owner record shared by native and component Agent tools.
use rho_plugin_sdk::protocol::*;
use serde_json::{Value, json};

pub(crate) const NORMALIZED: &str = "Normalized owner request needs original Host correlation";
pub(crate) fn operation_result(
    project: &str,
    instance: &PluginInstanceId,
    parent: &OperationId,
    request: &PluginRequest,
    record: &Value,
) -> Result<(OperationId, Value), String> {
    verify(project, instance, parent, request, None, record)
}

/// The independently observed Host reverse-request mapping binds this exact
/// original request to `expected`. Owners may normalize arguments/targets; that
/// never permits changing the immutable provider, project or capability.
pub(crate) fn correlated_operation_result(
    project: &str,
    instance: &PluginInstanceId,
    parent: &OperationId,
    request: &PluginRequest,
    expected: &OperationId,
    record: &Value,
) -> Result<(OperationId, Value), String> {
    verify(project, instance, parent, request, Some(expected), record)
}

fn verify(
    project: &str,
    instance: &PluginInstanceId,
    parent: &OperationId,
    request: &PluginRequest,
    expected: Option<&OperationId>,
    record: &Value,
) -> Result<(OperationId, Value), String> {
    let operation = &record["operation"];
    let id = OperationId::new(
        operation["operation_id"]
            .as_str()
            .ok_or("Original native Operation identity is missing")?,
    )
    .map_err(|_| "Invalid native Operation identity")?;
    let normalized: PluginRequest =
        serde_json::from_value(operation["normalized_arguments"].clone())
            .map_err(|_| "Invalid admitted plugin request")?;
    let original_request_matches = match expected {
        Some(expected) => &id == expected,
        None => true,
    };
    if !original_request_matches
        || normalized.binding.provider != request.binding.provider
        || normalized.binding.project != request.binding.project
        || normalized.binding.capability != request.binding.capability
        || normalized.preconditions != request.preconditions
        || operation["caller"]["kind"] != "plugin"
        || operation["caller"]["id"] != instance.as_str()
        || operation["causation_id"] != parent.as_str()
        || operation["idempotency_scope"] != project
        || operation["capability"] != json!(request.binding.capability)
        || operation["admission"]["owner_context"]["binding"] != json!(normalized.binding)
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
    if expected.is_none() && normalized != *request {
        return Err(NORMALIZED.into());
    }
    Ok((
        id.clone(),
        json!({"operation_id":id,"status":record["status"],"output":record["output"],"error":record["error"],"recovery":record["recovery"],"cancellation_requested":record["cancellation_requested"]}),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalization_needs_original_identity_and_retains_provider_scope() {
        let caller = PluginInstanceId::new("agent-one").unwrap();
        let parent = OperationId::new("send-one").unwrap();
        let expected = OperationId::new("process-one").unwrap();
        let request: PluginRequest = serde_json::from_value(json!({
            "binding":{"provider":{"instance":"process-owner","plugin":"org.rho.process",
                "revision":format!("sha256:{}", "a".repeat(64)),"artifact":format!("sha256:{}", "b".repeat(64))},
                "project":"project-one","capability":{"id":"process.run_local","version":2},"target":null},
            "arguments":{"program":"/usr/bin/printf"},"preconditions":null
        })).unwrap();
        let record = json!({"operation":{"operation_id":expected,"caller":{"kind":"plugin","id":caller},
            "causation_id":parent,"idempotency_scope":"/project","capability":request.binding.capability,
            "normalized_arguments":request,"admission":{"owner_context":{"binding":request.binding}}},
            "status":"succeeded","output":{"exit_code":0},"error":null,"recovery":null,"cancellation_requested":false});
        assert!(operation_result("/project", &caller, &parent, &request, &record).is_ok());
        let mut normalized = record.clone();
        normalized["operation"]["normalized_arguments"]["binding"]["target"] = json!("/project");
        normalized["operation"]["normalized_arguments"]["arguments"]["args"] = json!([]);
        normalized["operation"]["admission"]["owner_context"]["binding"] =
            normalized["operation"]["normalized_arguments"]["binding"].clone();
        assert!(operation_result("/project", &caller, &parent, &request, &normalized).is_err());
        let verify = |value: &Value| {
            correlated_operation_result("/project", &caller, &parent, &request, &expected, value)
        };
        assert_eq!(
            verify(&normalized).unwrap().1["output"],
            json!({"exit_code":0})
        );
        for (field, value) in [
            ("operation_id", json!("different-operation")),
            ("caller", json!({"kind":"plugin","id":"another-agent"})),
            ("causation_id", json!("another-send")),
            ("idempotency_scope", json!("/another-project")),
            ("capability", json!({"id":"process.run_local","version":1})),
        ] {
            let mut wrong = normalized.clone();
            wrong["operation"][field] = value;
            assert!(verify(&wrong).is_err(), "{field}");
        }
        for (field, value) in [
            (
                "provider",
                json!({"instance":"another-process","plugin":"org.rho.process",
                "revision":format!("sha256:{}", "a".repeat(64)),"artifact":format!("sha256:{}", "b".repeat(64))}),
            ),
            ("project", json!("another-project")),
            ("capability", json!({"id":"process.run_local","version":1})),
        ] {
            let mut wrong = normalized.clone();
            wrong["operation"]["normalized_arguments"]["binding"][field] = value;
            wrong["operation"]["admission"]["owner_context"]["binding"] =
                wrong["operation"]["normalized_arguments"]["binding"].clone();
            assert!(verify(&wrong).is_err(), "{field}");
        }
        let mut wrong = normalized.clone();
        wrong["operation"]["normalized_arguments"]["preconditions"] = json!({"invented":true});
        assert!(verify(&wrong).is_err());
        let mut wrong = normalized.clone();
        wrong["operation"]["admission"]["owner_context"]["binding"] = json!(request.binding);
        assert!(verify(&wrong).is_err());
        wrong = normalized.clone();
        wrong["status"] = json!("completed");
        assert!(verify(&wrong).is_err());
        normalized["status"] = json!("uncertain");
        assert_eq!(
            verify(&normalized).unwrap().1["status"],
            "uncertain",
            "Identity is not a claim of terminal success"
        );
    }
}
