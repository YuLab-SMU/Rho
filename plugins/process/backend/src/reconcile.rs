//! Qualification comes from a scoped authoritative Host observation, never a
//! supplied PID, a development manifest or the plugin's own result database.
use rho_plugin_sdk::protocol::*;
use rho_process_api::{ReconcileProcessArguments, RunLocalArguments};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

pub const PREPARE: &str = "process.prepare_reconcile";
pub const EXECUTE: &str = "process.reconcile";

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Qualification {
    pub project_root: String,
    pub source_operation: OperationId,
    pub source_binding: ProviderBinding,
}

fn args(value: &Value) -> Result<OperationId, String> {
    let args: ReconcileProcessArguments =
        serde_json::from_value(value.clone()).map_err(|error| error.to_string())?;
    OperationId::new(args.operation_id).map_err(|error| error.to_string())
}
fn common(call: &PluginCall, root: &str) -> Result<(), String> {
    if !["project.read", "process.run_local", "operation.read"]
        .iter()
        .all(|scope| call.scopes.contains(*scope))
        || call
            .binding
            .target
            .as_deref()
            .is_some_and(|target| target != root)
        || !(call.preconditions.is_null() || call.preconditions == json!([]))
    {
        return Err("Reconciliation requires its exact project and declared scopes, without arbitrary preconditions".into());
    }
    Ok(())
}
pub fn request(call: &PluginCall, root: &str) -> Result<OperationId, String> {
    common(call, root)?;
    if call.binding.capability.id.as_str() != PREPARE
        || call.binding.capability.version != 2
        || call.operation_id.is_some()
        || !call.owner_context.is_null()
        || !call.preconditions.is_null()
    {
        return Err("Invalid reconciliation preflight".into());
    }
    let prepare: PluginPreflightRequest =
        serde_json::from_value(call.arguments.clone()).map_err(|error| error.to_string())?;
    if prepare.capability.id.as_str() != EXECUTE
        || prepare.capability.version != 2
        || prepare
            .target
            .as_deref()
            .is_some_and(|target| target != root)
        || !(prepare.preconditions.is_null() || prepare.preconditions == json!([]))
    {
        return Err("Unsupported reconciliation capability, target or preconditions".into());
    }
    args(&prepare.arguments)
}

impl Qualification {
    fn validate(&self, call: &PluginCall, root: &str, source: &OperationId) -> Result<(), String> {
        if self.project_root != root
            || self.source_operation != *source
            || self.source_binding.project != call.binding.project
            || self.source_binding.provider.plugin != call.binding.provider.plugin
            || self.source_binding.target.as_deref() != Some(root)
            || self.source_binding.capability.id.as_str() != "process.run_local"
            || self.source_binding.capability.version != 2
            || call.operation_id.as_deref() == Some(source.as_str())
        {
            return Err(
                "Reconciliation differs from its original project, provider family or operation"
                    .into(),
            );
        }
        Ok(())
    }
}

/// `observation` is a correlated operation.get reply under this active parent's
/// principal/project authority. Only the published fields needed here are read;
/// no private core DTO or alternative journal is imported.
pub fn prepare(call: &PluginCall, root: &str, observation: Value) -> Result<Value, String> {
    let source = request(call, root)?;
    if observation["status"] != "ready" || observation["completeness"] != "complete" {
        return Err("Original operation observation is incomplete or unavailable".into());
    }
    let record = &observation["data"]["record"];
    if !["succeeded", "failed", "cancelled", "uncertain"]
        .iter()
        .any(|status| record["status"] == *status)
    {
        return Err("Reconciliation requires a visible terminal original operation".into());
    }
    let original = &record["operation"];
    let normalized = &original["normalized_arguments"];
    let binding: ProviderBinding = serde_json::from_value(normalized["binding"].clone())
        .map_err(|_| "Original operation has no valid retained provider binding")?;
    let qualification = Qualification {
        project_root: root.into(),
        source_operation: source.clone(),
        source_binding: binding,
    };
    qualification.validate(call, root, &source)?;
    if original["operation_id"] != source.as_str()
        || original["idempotency_scope"] != root
        || original["capability"] != json!(qualification.source_binding.capability)
        || original["admission"]["owner_context"]["binding"] != json!(qualification.source_binding)
        || original["admission"]["owner_context"]["qualification"] != json!({"project_root":root})
    {
        return Err("Original operation lacks matching admitted native scope".into());
    }
    let run: RunLocalArguments = serde_json::from_value(normalized["arguments"].clone())
        .map_err(|_| "Original operation lacks a valid local-process request")?;
    run.validate()?;
    Ok(json!(PluginPreflightResult {
        arguments: json!(ReconcileProcessArguments {
            operation_id: source.to_string()
        }),
        target: Some(root.into()),
        owner_context: json!(qualification),
    }))
}

pub fn admitted(call: &PluginCall, root: &str) -> Result<Qualification, String> {
    common(call, root)?;
    if call.binding.capability.id.as_str() != EXECUTE
        || call.binding.capability.version != 2
        || call.binding.target.as_deref() != Some(root)
        || call.operation_id.is_none()
    {
        return Err("Invalid admitted reconciliation".into());
    }
    let source = args(&call.arguments)?;
    let qualification: Qualification = serde_json::from_value(call.owner_context.clone())
        .map_err(|_| "Original reconciliation qualification is missing or malformed")?;
    qualification.validate(call, root, &source)?;
    Ok(qualification)
}

#[cfg(test)]
mod tests {
    use super::*;
    const ROOT: &str = "/original/project";
    fn fixture() -> (PluginCall, Value) {
        let provider: InstanceRef = serde_json::from_value(json!({"plugin":"org.rho.process","instance":"new-process","revision":format!("sha256:{}","a".repeat(64)),"artifact":format!("sha256:{}","b".repeat(64))})).unwrap();
        let call = PluginCall {
            request: RequestId::new("prepare").unwrap(),
            binding: ProviderBinding {
                capability: CapabilityKey {
                    id: ContributionId::new(PREPARE).unwrap(),
                    version: 2,
                },
                provider,
                project: ProjectId::new("project").unwrap(),
                target: None,
            },
            principal: PrincipalId::new("principal").unwrap(),
            scopes: [
                "project.read".into(),
                "process.run_local".into(),
                "operation.read".into(),
            ]
            .into(),
            arguments: json!({"capability":{"id":EXECUTE,"version":2},"arguments":{"operation_id":"original-run"},"target":null,"preconditions":null}),
            preconditions: Value::Null,
            owner_context: Value::Null,
            operation_id: None,
        };
        let mut binding = call.binding.clone();
        binding.provider.instance = PluginInstanceId::new("old-process").unwrap();
        binding.provider.revision = RevisionId::new(format!("sha256:{}", "c".repeat(64))).unwrap();
        binding.capability.id = ContributionId::new("process.run_local").unwrap();
        binding.target = Some(ROOT.into());
        let observation = json!({"status":"ready","completeness":"complete","data":{"record":{
            "status":"uncertain", "operation":{
                "operation_id":"original-run","idempotency_scope":ROOT,"capability":binding.capability,
                "normalized_arguments":{"binding":binding,"arguments":{"program":"/bin/true"}},
                "admission":{"owner_context":{"binding":binding,"qualification":{"project_root":ROOT}}}
            }
        }}});
        (call, observation)
    }
    fn invocation(mut call: PluginCall, prepared: Value) -> PluginCall {
        call.operation_id = Some("new-reconciliation".into());
        call.binding.capability.id = ContributionId::new(EXECUTE).unwrap();
        call.binding.target = Some(ROOT.into());
        call.arguments = prepared["arguments"].clone();
        call.owner_context = prepared["owner_context"].clone();
        call
    }
    #[test]
    fn terminal_original_from_an_older_instance_is_frozen_without_retargeting() {
        let (call, original) = fixture();
        let prepared = prepare(&call, ROOT, original.clone()).unwrap();
        let source = admitted(&invocation(call, prepared), ROOT).unwrap();
        assert_eq!(source.source_operation.as_str(), "original-run");
        assert_eq!(
            source.source_binding.provider.instance.as_str(),
            "old-process"
        );
        assert_eq!(
            source.source_binding.provider.revision.as_str(),
            format!("sha256:{}", "c".repeat(64))
        );
        assert_eq!(original["data"]["record"]["status"], "uncertain");
    }
    #[test]
    fn unavailable_active_foreign_or_unqualified_originals_cannot_authorize_signals() {
        let (call, original) = fixture();
        for (pointer, replacement) in [
            ("/status", json!("unavailable")),
            ("/completeness", json!("partial")),
            ("/data/record", Value::Null),
            ("/data/record/status", json!("running")),
            ("/data/record/status", json!("accepted")),
            ("/data/record/status", json!("reconciling")),
            ("/data/record/operation/operation_id", json!("another-run")),
            (
                "/data/record/operation/idempotency_scope",
                json!("/another/project"),
            ),
            ("/data/record/operation/capability/version", json!(1)),
            (
                "/data/record/operation/normalized_arguments/binding/project",
                json!("foreign-project"),
            ),
            (
                "/data/record/operation/normalized_arguments/binding/target",
                json!("/another/project"),
            ),
            (
                "/data/record/operation/normalized_arguments/binding/provider/plugin",
                json!("org.other.process"),
            ),
            (
                "/data/record/operation/normalized_arguments/arguments/program",
                json!(""),
            ),
            (
                "/data/record/operation/admission/owner_context/qualification/project_root",
                json!("/another/project"),
            ),
            (
                "/data/record/operation/admission/owner_context/binding/provider/instance",
                json!("substitute"),
            ),
        ] {
            let mut value = original.clone();
            *value.pointer_mut(pointer).unwrap() = replacement;
            assert!(prepare(&call, ROOT, value).is_err(), "accepted {pointer}");
        }
    }
    #[test]
    fn caller_arguments_and_admission_cannot_replace_original_scope_or_pid() {
        let (call, observation) = fixture();
        let prepared = prepare(&call, ROOT, observation).unwrap();
        let mut missing = call.clone();
        missing.scopes.remove("operation.read");
        assert!(request(&missing, ROOT).is_err());
        let mut pid = call.clone();
        pid.arguments["arguments"]["pid"] = json!(1234);
        assert!(request(&pid, ROOT).is_err());
        let mut call = invocation(call, prepared);
        let original = call.clone();
        call.arguments["operation_id"] = json!("replacement-run");
        assert!(admitted(&call, ROOT).is_err());
        let mut call = original.clone();
        call.preconditions = json!([{"pid":1234}]);
        assert!(admitted(&call, ROOT).is_err());
        let mut call = original.clone();
        call.owner_context["project_root"] = json!("/replacement");
        assert!(admitted(&call, ROOT).is_err());
        let mut call = original;
        call.operation_id = Some("original-run".into());
        assert!(admitted(&call, ROOT).is_err());
    }
}
