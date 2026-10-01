//! Original source records come from a correlated, principal-scoped Host read.
use rho_environment_api::*;
use rho_plugin_sdk::protocol::*;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::BTreeSet;

pub const PLAN: &str = "environment.plan";
pub const REALIZE: &str = "environment.realize";
pub const VERIFY: &str = "environment.verify";
pub const RECONCILE: &str = "environment.reconcile";
pub const REFRESH: &str = "environment.refresh";
pub const OBSERVE: &str = "environment.observe";
pub const LIBRARY: &str = "environment.library";
pub const STATUS: &str = "environment.status";
pub const RETENTION: &str = "environment.retention";
pub const CLEANUP_STATUS: &str = "environment.cleanup_status";
pub const CLEANUP: &str = "environment.cleanup";
pub const RESTORE: &str = "environment.restore_cleanup";
pub const PURGE: &str = "environment.purge_cleanup";
pub const MAX_REPORT_BYTES: u64 = 4 * 1024 * 1024;

pub fn material_operation(id: &str) -> bool {
    matches!(id, CLEANUP | RESTORE | PURGE)
}
pub fn material_capability(id: &str) -> bool {
    material_operation(id) || matches!(id, RETENTION | CLEANUP_STATUS)
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct NativeScope {
    pub project_root: String,
    pub rscript: String,
    pub storage_root: String,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Source {
    pub operation: OperationId,
    pub binding: ProviderBinding,
    pub report: Option<ResourceReference>,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Qualification {
    pub scope: NativeScope,
    pub source: Option<Source>,
}
#[derive(Serialize, Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct Empty {}

pub fn prepared_operation(id: &str) -> Option<&'static str> {
    match id {
        "environment.prepare_plan" => Some(PLAN),
        "environment.prepare_realize" => Some(REALIZE),
        "environment.prepare_verify" => Some(VERIFY),
        "environment.prepare_reconcile" => Some(RECONCILE),
        "environment.prepare_refresh" => Some(REFRESH),
        "environment.prepare_cleanup" => Some(CLEANUP),
        "environment.prepare_restore_cleanup" => Some(RESTORE),
        "environment.prepare_purge_cleanup" => Some(PURGE),
        _ => None,
    }
}
pub fn scopes(id: &str) -> BTreeSet<String> {
    let id = prepared_operation(id).unwrap_or(id);
    let mut scopes: BTreeSet<String> = [
        "project.read".into(),
        if matches!(id, STATUS | OBSERVE | LIBRARY | RETENTION | CLEANUP_STATUS) {
            "environment.read".into()
        } else {
            "environment.write".into()
        },
    ]
    .into();
    if matches!(id, REALIZE | VERIFY | RECONCILE | OBSERVE | LIBRARY) {
        scopes.insert("operation.read".into());
    }
    if matches!(id, REALIZE | VERIFY | OBSERVE | LIBRARY) {
        scopes.insert("resources.read".into());
    }
    if material_capability(id) {
        scopes.extend(
            [
                "operation.read",
                "resources.read",
                "plugins.read",
                "project.references.read",
                "workspace.read",
            ]
            .map(str::to_owned),
        );
    }
    scopes
}
pub fn normalize(id: &str, value: Value) -> Result<Value, String> {
    let invalid = |e: serde_json::Error| e.to_string();
    Ok(match id {
        PLAN => {
            let args: PlanArguments = serde_json::from_value(value).map_err(invalid)?;
            args.validate()?;
            json!(args)
        }
        REALIZE => {
            let args: RealizeArguments = serde_json::from_value(value).map_err(invalid)?;
            OperationId::new(&args.plan_operation_id).map_err(|e| e.to_string())?;
            json!(args)
        }
        VERIFY | LIBRARY => {
            let args: VerifyArguments = serde_json::from_value(value).map_err(invalid)?;
            OperationId::new(&args.realization_operation_id).map_err(|e| e.to_string())?;
            json!(args)
        }
        RECONCILE => {
            let args: ReconcileArguments = serde_json::from_value(value).map_err(invalid)?;
            OperationId::new(&args.operation_id).map_err(|e| e.to_string())?;
            json!(args)
        }
        RETENTION => {
            let args: EnvironmentSourceArguments =
                serde_json::from_value(value).map_err(invalid)?;
            OperationId::new(&args.operation_id).map_err(|e| e.to_string())?;
            json!(args)
        }
        CLEANUP_STATUS => {
            let args: EnvironmentTrashArguments = serde_json::from_value(value).map_err(invalid)?;
            OperationId::new(&args.cleanup_operation_id).map_err(|e| e.to_string())?;
            json!(args)
        }
        CLEANUP => {
            let args: EnvironmentCleanupArguments =
                serde_json::from_value(value).map_err(invalid)?;
            OperationId::new(&args.operation_id).map_err(|e| e.to_string())?;
            ContentDigest::new(&args.expected_fingerprint).map_err(|e| e.to_string())?;
            json!(args)
        }
        RESTORE | PURGE => {
            let args: EnvironmentChangeTrashArguments =
                serde_json::from_value(value).map_err(invalid)?;
            OperationId::new(&args.cleanup_operation_id).map_err(|e| e.to_string())?;
            ContentDigest::new(&args.expected_fingerprint).map_err(|e| e.to_string())?;
            json!(args)
        }
        OBSERVE => {
            let args: ObserveArguments = serde_json::from_value(value).map_err(invalid)?;
            if !(1..=500).contains(&args.limit) {
                return Err("Environment observation limit must be 1–500".into());
            }
            if let Some(id) = &args.realization_operation_id {
                OperationId::new(id).map_err(|e| e.to_string())?;
            }
            json!(args)
        }
        REFRESH | STATUS => {
            serde_json::from_value::<Empty>(value).map_err(invalid)?;
            json!({})
        }
        _ => return Err("Unsupported Environment capability".into()),
    })
}
pub fn source_id(id: &str, value: &Value) -> Result<Option<OperationId>, String> {
    let normalized = normalize(id, value.clone())?;
    let key = match id {
        REALIZE => "plan_operation_id",
        VERIFY | OBSERVE | LIBRARY => "realization_operation_id",
        RECONCILE => "operation_id",
        RETENTION | CLEANUP => "operation_id",
        CLEANUP_STATUS | RESTORE | PURGE => "cleanup_operation_id",
        _ => return Ok(None),
    };
    normalized[key]
        .as_str()
        .map(|id| OperationId::new(id).map_err(|e| e.to_string()))
        .transpose()
}
fn source_capability(action: &str, original: &str) -> bool {
    match action {
        REALIZE => original == PLAN,
        VERIFY | OBSERVE | LIBRARY => original == REALIZE,
        RECONCILE => matches!(original, PLAN | REALIZE | VERIFY | REFRESH),
        _ => false,
    }
}
impl Qualification {
    pub fn validate(
        &self,
        call: &PluginCall,
        scope: &NativeScope,
        target: &str,
        action: &str,
        args: &Value,
    ) -> Result<(), String> {
        if self.scope != *scope {
            return Err("Environment qualification changed its native scope".into());
        }
        let id = source_id(action, args)?;
        match (&self.source, id) {
            (None, None) => Ok(()),
            (Some(source), Some(id))
                if source.operation == id
                    && source.binding.project == call.binding.project
                    && source.binding.provider.plugin == call.binding.provider.plugin
                    && source.binding.target.as_deref() == Some(target)
                    && source.binding.capability.version == 2
                    && source_capability(action, source.binding.capability.id.as_str())
                    && call.operation_id.as_deref() != Some(id.as_str()) =>
            {
                if action == RECONCILE {
                    if source.report.is_some() {
                        return Err("Native reconciliation does not consume a report".into());
                    }
                } else {
                    let report = source.report.as_ref().ok_or("Source report is missing")?;
                    validate_report(report, &source.binding)?;
                }
                Ok(())
            }
            _ => Err("Environment source differs from its admitted original operation".into()),
        }
    }
}
pub fn validate_report(
    report: &ResourceReference,
    binding: &ProviderBinding,
) -> Result<(), String> {
    if report.owner != binding.provider
        || report.media_type != "application/json"
        || report.bytes == 0
        || report.bytes > MAX_REPORT_BYTES
    {
        return Err("Environment report differs from its original owner or bounds".into());
    }
    Ok(())
}
pub fn qualify(
    call: &PluginCall,
    scope: &NativeScope,
    target: &str,
    action: &str,
    args: &Value,
    observation: &Value,
) -> Result<Qualification, String> {
    let id = source_id(action, args)?.ok_or("No original Environment operation was requested")?;
    if observation["status"] != "ready" || observation["completeness"] != "complete" {
        return Err("Original Environment operation is unavailable or incomplete".into());
    }
    let record = &observation["data"]["record"];
    if if action == RECONCILE {
        !["succeeded", "failed", "cancelled", "uncertain"]
            .iter()
            .any(|s| record["status"] == *s)
    } else {
        record["status"] != "succeeded"
    } {
        return Err("Original Environment operation has no suitable terminal outcome".into());
    }
    let original = &record["operation"];
    let binding: ProviderBinding =
        serde_json::from_value(original["normalized_arguments"]["binding"].clone())
            .map_err(|_| "Original Environment binding is unavailable")?;
    let admitted = &original["admission"]["owner_context"];
    if original["operation_id"] != id.as_str()
        || original["idempotency_scope"] != scope.project_root
        || original["capability"] != json!(binding.capability)
        || admitted["binding"] != json!(binding)
        || admitted["qualification"]["scope"] != json!(scope)
    {
        return Err("Original Environment operation lacks matching admitted native scope".into());
    }
    normalize(
        binding.capability.id.as_str(),
        original["normalized_arguments"]["arguments"].clone(),
    )?;
    let report = if action == RECONCILE {
        None
    } else {
        let result: EnvironmentResult = serde_json::from_value(record["output"].clone())
            .map_err(|_| "Original Environment result is unavailable")?;
        let expected = if action == REALIZE {
            EnvironmentReportKind::Plan
        } else {
            EnvironmentReportKind::Realization
        };
        if result.operation != id
            || result.kind != expected
            || (expected == EnvironmentReportKind::Realization && result.verified != Some(true))
        {
            return Err("Original Environment report has another identity or kind".into());
        }
        Some(result.report)
    };
    let qualified = Qualification {
        scope: scope.clone(),
        source: Some(Source {
            operation: id,
            binding,
            report,
        }),
    };
    qualified.validate(call, scope, target, action, args)?;
    Ok(qualified)
}
