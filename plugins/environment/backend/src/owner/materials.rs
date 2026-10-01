//! Material policy belongs to Environment. Host observations supply identities,
//! visibility and original records; they never decide whether a library is unused.
use super::*;
use serde::{Deserialize, Serialize};

mod references;
#[cfg(test)]
mod tests;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct MaterialSource {
    operation: OperationId,
    binding: ProviderBinding,
    status: String,
}
impl MaterialSource {
    fn kind(&self) -> MaterialKind {
        if self.binding.capability.id.as_str() == source::PLAN {
            MaterialKind::Plan
        } else {
            MaterialKind::Realization
        }
    }
    fn eligible(&self) -> bool {
        matches!(self.status.as_str(), "failed" | "cancelled")
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct MaterialQualification {
    scope: NativeScope,
    source: MaterialSource,
    cleanup: Option<MaterialSource>,
}

fn ready_record(observation: &Value) -> Result<&Value, String> {
    if observation["status"] != "ready" || observation["completeness"] != "complete" {
        return Err("Original material operation is unavailable or incomplete".into());
    }
    observation["data"]
        .get("record")
        .filter(|record| record.is_object())
        .ok_or_else(|| "Original material operation is missing".into())
}

impl Owner {
    fn material_record(
        &self,
        call: &PluginCall,
        id: &OperationId,
        record: &Value,
    ) -> Result<MaterialSource, String> {
        let operation = &record["operation"];
        let binding: ProviderBinding =
            serde_json::from_value(operation["normalized_arguments"]["binding"].clone())
                .map_err(error)?;
        let admission = &operation["admission"]["owner_context"];
        let status = record["status"]
            .as_str()
            .ok_or("Original material outcome is missing")?;
        if operation["operation_id"] != id.as_str()
            || operation["idempotency_scope"] != self.root
            || operation["capability"] != json!(binding.capability)
            || admission["binding"] != json!(binding)
            || admission["qualification"]["scope"] != json!(self.scope()?)
            || binding.project != call.binding.project
            || binding.provider.plugin != call.binding.provider.plugin
            || binding.target != self.target
            || binding.capability.version != 2
            || !matches!(
                binding.capability.id.as_str(),
                source::PLAN | source::REALIZE | source::CLEANUP
            )
            || !matches!(
                status,
                "accepted" | "running" | "succeeded" | "failed" | "cancelled" | "uncertain"
            )
        {
            return Err("Original material record differs from its admitted project, provider or native scope".into());
        }
        source::normalize(
            binding.capability.id.as_str(),
            operation["normalized_arguments"]["arguments"].clone(),
        )?;
        Ok(MaterialSource {
            operation: id.clone(),
            binding,
            status: status.into(),
        })
    }

    async fn material_source(
        &self,
        call: &PluginCall,
        action: &str,
        args: &Value,
        observation: Value,
    ) -> Result<MaterialQualification, String> {
        let id =
            source::source_id(action, args)?.ok_or("Original material identity is required")?;
        let record = ready_record(&observation)?;
        let first = self.material_record(call, &id, record)?;
        let (original, cleanup) = if matches!(
            action,
            source::CLEANUP_STATUS | source::RESTORE | source::PURGE
        ) {
            if first.binding.capability.id.as_str() != source::CLEANUP
                || !matches!(first.status.as_str(), "succeeded" | "uncertain")
            {
                return Err(
                    "Cleanup status requires the original successful or unconfirmed quarantine"
                        .into(),
                );
            }
            let admitted: MaterialQualification = serde_json::from_value(
                record["operation"]["admission"]["owner_context"]["qualification"].clone(),
            )
            .map_err(error)?;
            let input: EnvironmentCleanupArguments = serde_json::from_value(
                record["operation"]["normalized_arguments"]["arguments"].clone(),
            )
            .map_err(error)?;
            if admitted.scope != *self.scope()?
                || admitted.cleanup.is_some()
                || !admitted.source.eligible()
                || admitted.source.operation.as_str() != input.operation_id
            {
                return Err("Original quarantine lacks its exact admitted material source".into());
            }
            let source = self
                .reads
                .query(
                    call.request.clone(),
                    "operation.get",
                    json!({"operation_id":input.operation_id}),
                )
                .await?;
            let source =
                self.material_record(call, &admitted.source.operation, ready_record(&source)?)?;
            if source != admitted.source {
                return Err("Quarantined material source changed after admission".into());
            }
            (source, Some(first))
        } else {
            (first, None)
        };
        if !matches!(
            original.binding.capability.id.as_str(),
            source::PLAN | source::REALIZE
        ) {
            return Err("Only an original Environment plan or realization owns staging".into());
        }
        Ok(MaterialQualification {
            scope: self.scope()?.clone(),
            source: original,
            cleanup,
        })
    }

    pub(super) async fn prepare_material(
        &self,
        call: &PluginCall,
        action: &str,
        args: &Value,
        observation: Value,
    ) -> Result<Value, String> {
        let qualified = self
            .material_source(call, action, args, observation)
            .await?;
        let _lane = self.lane.try_lock().map_err(
            |_| "Environment work or original settlement is pending; retry material inspection",
        )?;
        self.common(call)?;
        let view = self
            .material_view(
                call,
                &qualified,
                qualified.cleanup.as_ref().map(|s| s.operation.as_str()),
            )
            .await?;
        self.common(call)?;
        if !source::material_operation(action) {
            return Ok(json!(view));
        }
        validate_change(action, args, &view)?;
        Ok(json!(PluginPreflightResult {
            arguments: args.clone(),
            target: self.target.clone(),
            owner_context: json!(qualified)
        }))
    }

    pub(super) fn material_qualification(
        &self,
        call: &PluginCall,
    ) -> Result<MaterialQualification, String> {
        self.common(call)?;
        let action = call.binding.capability.id.as_str();
        let qualified: MaterialQualification =
            serde_json::from_value(call.owner_context.clone()).map_err(error)?;
        let args = source::normalize(action, call.arguments.clone())?;
        let same_owner = |source: &MaterialSource| {
            source.binding.project == call.binding.project
                && source.binding.provider.plugin == call.binding.provider.plugin
                && source.binding.target == self.target
                && source.binding.capability.version == 2
                && call.operation_id.as_deref() != Some(source.operation.as_str())
        };
        if !source::material_operation(action)
            || call.operation_id.is_none()
            || call.binding.target != self.target
            || qualified.scope != *self.scope()?
            || !qualified.source.eligible()
            || !same_owner(&qualified.source)
            || !matches!(
                qualified.source.binding.capability.id.as_str(),
                source::PLAN | source::REALIZE
            )
        {
            return Err(
                "Material operation changed its admitted original source or native scope".into(),
            );
        }
        if action == source::CLEANUP {
            if qualified.cleanup.is_some()
                || args["operation_id"] != qualified.source.operation.as_str()
            {
                return Err("Quarantine source differs from admission".into());
            }
        } else {
            let cleanup = qualified
                .cleanup
                .as_ref()
                .ok_or("Original quarantine is required")?;
            if !same_owner(cleanup)
                || cleanup.binding.capability.id.as_str() != source::CLEANUP
                || !matches!(cleanup.status.as_str(), "succeeded" | "uncertain")
                || args["cleanup_operation_id"] != cleanup.operation.as_str()
            {
                return Err("Quarantine identity differs from admission".into());
            }
        }
        Ok(qualified)
    }

    pub(super) async fn perform_material(
        &self,
        call: &PluginCall,
        id: &OperationId,
        cancellation: watch::Receiver<bool>,
    ) -> Result<(EnvironmentReportKind, Value, Option<bool>), EnvironmentOwnerError> {
        let qualified = self
            .material_qualification(call)
            .map_err(EnvironmentOwnerError::before_effect)?;
        let action = call.binding.capability.id.as_str();
        let source = source::source_id(action, &call.arguments)
            .map_err(EnvironmentOwnerError::before_effect)?
            .unwrap();
        let observation = self
            .reads
            .query(
                call.request.clone(),
                "operation.get",
                json!({"operation_id":source}),
            )
            .await
            .map_err(EnvironmentOwnerError::before_effect)?;
        let current = self
            .material_source(call, action, &call.arguments, observation)
            .await
            .map_err(EnvironmentOwnerError::before_effect)?;
        if current != qualified {
            return Err(EnvironmentOwnerError::before_effect(
                "Original material qualification changed",
            ));
        }
        let cleanup = qualified
            .cleanup
            .as_ref()
            .map(|s| s.operation.as_str())
            .unwrap_or(id.as_str());
        let view = self
            .material_view(call, &qualified, Some(cleanup))
            .await
            .map_err(EnvironmentOwnerError::before_effect)?;
        validate_change(action, &call.arguments, &view)
            .map_err(EnvironmentOwnerError::before_effect)?;
        self.common(call)
            .map_err(EnvironmentOwnerError::before_effect)?;
        if *cancellation.borrow() {
            return Err(EnvironmentOwnerError::before_effect(
                "Material change did not start before its control channel ended",
            ));
        }
        let action = match action {
            source::CLEANUP => MaterialAction::Quarantine,
            source::RESTORE => MaterialAction::Restore,
            _ => MaterialAction::Purge,
        };
        let changed = self
            .native()
            .map_err(EnvironmentOwnerError::before_effect)?
            .change_material(
                qualified.source.operation.as_str(),
                qualified.source.kind(),
                cleanup,
                action,
                call.arguments["expected_fingerprint"].as_str().unwrap(),
            )
            .await?;
        Ok((EnvironmentReportKind::Material, json!(changed), None))
    }

    async fn material_view(
        &self,
        call: &PluginCall,
        qualified: &MaterialQualification,
        cleanup: Option<&str>,
    ) -> Result<RetentionView, String> {
        self.common(call)?;
        let material = self
            .native()?
            .material_state(
                qualified.source.operation.as_str(),
                qualified.source.kind(),
                cleanup,
            )
            .await?;
        let mut reasons = Vec::new();
        if !qualified.source.eligible() {
            reasons.push(
                "Successful outputs, live attempts and uncertain recovery material are retained."
                    .into(),
            );
        }
        if !material.native_marker_present {
            reasons.push("No native reference proves the attempt's process cleanup.".into());
        }
        if !material.live_processes.is_empty() {
            reasons.push("Native processes are still using the attempt.".into());
        }
        if material.stage.is_some() && material.trash.is_some() {
            reasons.push(
                "Both original and quarantined material exist; resolve the conflict explicitly."
                    .into(),
            );
        }
        if reasons.is_empty() {
            let paths = self.native()?.material_reference_paths(
                qualified.source.operation.as_str(),
                qualified.source.kind(),
                cleanup,
            )?;
            if let Err(reason) = self
                .check_material_references(
                    call,
                    &paths,
                    qualified.cleanup.as_ref().map(|s| &s.operation),
                )
                .await
            {
                reasons.push(format!("Cannot establish reference safety: {reason}"));
            }
        }
        self.common(call)?;
        let allowed = reasons.is_empty();
        Ok(RetentionView {
            source_operation_id: qualified.source.operation.to_string(),
            can_quarantine: allowed && material.stage.is_some() && material.trash.is_none(),
            can_restore: allowed && material.trash.is_some() && material.stage.is_none(),
            can_purge: allowed && material.trash.is_some() && material.stage.is_none(),
            material,
            retained_reasons: reasons,
        })
    }
}

fn validate_change(action: &str, args: &Value, view: &RetentionView) -> Result<(), String> {
    let (allowed, item) = match action {
        source::CLEANUP => (view.can_quarantine, view.material.stage.as_ref()),
        source::RESTORE => (view.can_restore, view.material.trash.as_ref()),
        source::PURGE => (view.can_purge, view.material.trash.as_ref()),
        _ => return Err("Unsupported material action".into()),
    };
    if !allowed {
        return Err(format!(
            "Material is retained: {}",
            view.retained_reasons.join("; ")
        ));
    }
    if item.is_none_or(|item| args["expected_fingerprint"] != item.fingerprint) {
        return Err("Material changed since its exact preview".into());
    }
    Ok(())
}
