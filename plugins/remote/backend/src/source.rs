use rho_plugin_sdk::protocol::*;
use rho_process_api::RunLocalArguments;
use rho_remote_api::{
    RemoteTarget, SlurmSourceArguments, SlurmSubmitArguments, validate_run_arguments,
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

pub const RUN: &str = "process.run_remote";
pub const PREPARE_RUN: &str = "process.prepare_remote";
pub const SUBMIT: &str = "slurm.submit";
pub const RECONCILE: &str = "slurm.reconcile";
pub const CANCEL: &str = "slurm.request_cancel";
pub const SNAPSHOT: &str = "slurm.snapshot";
pub fn prepared_operation(id: &str) -> Option<&'static str> {
    match id {
        PREPARE_RUN => Some(RUN),
        "slurm.prepare_submit" => Some(SUBMIT),
        "slurm.prepare_reconcile" => Some(RECONCILE),
        "slurm.prepare_cancel" => Some(CANCEL),
        _ => None,
    }
}
pub fn needs_source(id: &str) -> bool {
    matches!(
        id,
        RECONCILE | CANCEL | SNAPSHOT | "slurm.prepare_reconcile" | "slurm.prepare_cancel"
    )
}
pub fn scopes(id: &str) -> std::collections::BTreeSet<String> {
    let operation = prepared_operation(id).unwrap_or(id);
    let mut scopes = ["project.read".into()]
        .into_iter()
        .collect::<std::collections::BTreeSet<_>>();
    if operation == RUN {
        scopes.insert("remote.execute".into());
    } else if operation == SNAPSHOT {
        scopes.insert("slurm.read".into());
    } else if matches!(operation, SUBMIT | RECONCILE | CANCEL) {
        scopes.insert("slurm.write".into());
    }
    if needs_source(id) {
        scopes.insert("operation.read".into());
    }
    scopes
}
pub fn normalize(id: &str, value: Value) -> Result<Value, String> {
    match id {
        RUN => {
            let args: RunLocalArguments =
                serde_json::from_value(value).map_err(|e| e.to_string())?;
            validate_run_arguments(&args)?;
            Ok(json!(args))
        }
        SUBMIT => {
            let args: SlurmSubmitArguments =
                serde_json::from_value(value).map_err(|e| e.to_string())?;
            args.validate()?;
            Ok(json!(args))
        }
        RECONCILE | CANCEL | SNAPSHOT => {
            let args: SlurmSourceArguments =
                serde_json::from_value(value).map_err(|e| e.to_string())?;
            args.source_id()?;
            Ok(json!(args))
        }
        _ => Err("Unsupported remote capability".into()),
    }
}
pub fn original_source(value: &Value) -> Result<OperationId, String> {
    serde_json::from_value::<SlurmSourceArguments>(value.clone())
        .map_err(|e| e.to_string())?
        .source_id()
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SourceQualification {
    pub operation: OperationId,
    pub binding: ProviderBinding,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Qualification {
    pub project_root: String,
    pub remote_target: RemoteTarget,
    pub source: Option<SourceQualification>,
}
impl Qualification {
    pub fn validate(
        &self,
        call: &PluginCall,
        base: &Qualification,
        target_key: &str,
        source: Option<&OperationId>,
    ) -> Result<(), String> {
        if self.project_root != base.project_root || self.remote_target != base.remote_target {
            return Err("Remote qualification differs from the initialized project/target".into());
        }
        match (&self.source, source) {
            (None, None) => Ok(()),
            (Some(original), Some(source))
                if original.operation == *source
                    && original.binding.project == call.binding.project
                    && original.binding.provider.plugin == call.binding.provider.plugin
                    && original.binding.target.as_deref() == Some(target_key)
                    && original.binding.capability.id.as_str() == SUBMIT
                    && original.binding.capability.version == 2
                    && call.operation_id.as_deref() != Some(source.as_str()) =>
            {
                Ok(())
            }
            _ => Err("Remote recovery differs from its admitted original source".into()),
        }
    }
}
/// Read only a correlated, scoped operation.get observation. No private journal.
pub fn qualify_original(
    call: &PluginCall,
    source: &OperationId,
    base: &Qualification,
    target_key: &str,
    observation: &Value,
) -> Result<(Qualification, bool), String> {
    if observation["status"] != "ready" || observation["completeness"] != "complete" {
        return Err("Original submission observation is incomplete or unavailable".into());
    }
    let record = &observation["data"]["record"];
    let terminal = ["succeeded", "failed", "cancelled", "uncertain"]
        .iter()
        .any(|status| record["status"] == *status);
    if !terminal
        && !["accepted", "running", "reconciling"]
            .iter()
            .any(|status| record["status"] == *status)
    {
        return Err("Original submission is missing or has an unknown state".into());
    }
    let original = &record["operation"];
    let normalized = &original["normalized_arguments"];
    let binding: ProviderBinding = serde_json::from_value(normalized["binding"].clone())
        .map_err(|_| "Original submission has no retained provider binding")?;
    let mut qualification = base.clone();
    qualification.source = Some(SourceQualification {
        operation: source.clone(),
        binding,
    });
    qualification.validate(call, base, target_key, Some(source))?;
    let binding = &qualification.source.as_ref().unwrap().binding;
    if original["operation_id"] != source.as_str()
        || original["idempotency_scope"] != base.project_root
        || original["capability"] != json!(binding.capability)
        || original["admission"]["owner_context"]["binding"] != json!(binding)
        || original["admission"]["owner_context"]["qualification"] != json!(base)
    {
        return Err("Original submission lacks its matching admitted native target".into());
    }
    normalize(SUBMIT, normalized["arguments"].clone())?;
    Ok((qualification, terminal))
}
