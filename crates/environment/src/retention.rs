use super::*;
use rho_contract::OperationStatus;

pub const CLEANUP_CAPABILITY: &str = "environment.cleanup";
#[derive(Debug, Clone, Copy, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum MaterialKind {
    Plan,
    Realization,
}
#[derive(Debug, Clone, Copy, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum MaterialAction {
    Quarantine,
    Restore,
    Purge,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct MaterialObject {
    pub path: String,
    pub fingerprint: String,
    pub bytes: u64,
    pub entries: u64,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct MaterialState {
    pub stage: Option<MaterialObject>,
    pub trash: Option<MaterialObject>,
    pub native_marker_present: bool,
    pub live_processes: Vec<u32>,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct MaterialChange {
    pub source_operation_id: String,
    pub cleanup_operation_id: String,
    pub action: MaterialAction,
    pub stage_path: String,
    pub trash_path: String,
    pub bytes: u64,
    pub recoverable: bool,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct RetentionView {
    pub source_operation_id: String,
    pub material: MaterialState,
    pub can_quarantine: bool,
    pub can_restore: bool,
    pub can_purge: bool,
    pub retained_reasons: Vec<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
struct SourceArguments {
    operation_id: String,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
struct CleanupArguments {
    operation_id: String,
    expected_fingerprint: String,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
struct TrashArguments {
    cleanup_operation_id: String,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
struct ChangeTrashArguments {
    cleanup_operation_id: String,
    expected_fingerprint: String,
}

#[async_trait]
pub trait EnvironmentUsage: Send + Sync {
    async fn protected_paths(&self) -> Result<Vec<String>, String>;
}
impl EnvironmentOwner {
    async fn material_source(
        &self,
        id: &str,
        caller: Option<&CallerIdentity>,
    ) -> Result<(OperationRecord, MaterialKind), HandlerError> {
        let record = self
            .records
            .get(id)
            .await
            .map_err(HandlerError::before_effect)?
            .ok_or_else(|| {
                HandlerError::before_effect("material source Operation was not found")
            })?;
        if record.operation.idempotency_scope.as_deref() != Some(self.runtime.root())
            || caller.is_some_and(|caller| caller != record.operation.principal())
        {
            return Err(HandlerError::before_effect(
                "material source is outside this project/caller scope",
            ));
        }
        let kind = match record.operation.capability.id.as_str() {
            PLAN_CAPABILITY => MaterialKind::Plan,
            REALIZE_CAPABILITY => MaterialKind::Realization,
            _ => {
                return Err(HandlerError::before_effect(
                    "only Environment plans and realizations own staging",
                ));
            }
        };
        Ok((record, kind))
    }
    async fn cleanup_source(
        &self,
        id: &str,
        caller: Option<&CallerIdentity>,
    ) -> Result<(OperationRecord, MaterialKind), HandlerError> {
        let record = self
            .records
            .get(id)
            .await
            .map_err(HandlerError::before_effect)?
            .ok_or_else(|| HandlerError::before_effect("cleanup Operation was not found"))?;
        if record.operation.capability.id != CLEANUP_CAPABILITY
            || !matches!(
                record.status,
                OperationStatus::Succeeded | OperationStatus::Uncertain
            )
            || record.operation.idempotency_scope.as_deref() != Some(self.runtime.root())
            || caller.is_some_and(|caller| caller != record.operation.principal())
        {
            return Err(HandlerError::before_effect(
                "invalid cleanup reference or scope",
            ));
        }
        let input: CleanupArguments =
            serde_json::from_value(record.operation.normalized_arguments).map_err(before)?;
        self.material_source(&input.operation_id, caller).await
    }
    async fn reference_paths(&self) -> Result<Vec<String>, String> {
        let mut paths = self.active_library.iter().cloned().collect::<Vec<_>>();
        if let Some(usage) = &self.usage {
            paths.extend(usage.protected_paths().await?);
        } else if self.has_workspace {
            return Err("live Workspace usage cannot be observed".into());
        }
        for name in [PLAN_CAPABILITY, REALIZE_CAPABILITY] {
            let cap = CapabilityRef::new(name, 1).map_err(|error| error.to_string())?;
            let mut cursor = None;
            let mut complete = false;
            for _ in 0..128 {
                let page = self
                    .records
                    .successful_outputs(self.runtime.root(), &cap, cursor.as_deref(), 32)
                    .await?;
                for output in page.outputs {
                    if name == PLAN_CAPABILITY {
                        let plan: EnvironmentPlan =
                            serde_json::from_value(output).map_err(|error| error.to_string())?;
                        paths.extend(plan.local_sources.into_iter().map(|source| source.path));
                    } else {
                        let receipt: EnvironmentRealization =
                            serde_json::from_value(output).map_err(|error| error.to_string())?;
                        paths.extend([receipt.library_path, receipt.renv_lockfile]);
                    }
                }
                cursor = page.next_id;
                if cursor.is_none() {
                    complete = true;
                    break;
                }
            }
            if !complete {
                return Err("reference scan exceeded its bounded page count".into());
            }
        }
        Ok(paths)
    }
    async fn retention_view(
        &self,
        source: &OperationRecord,
        kind: MaterialKind,
        cleanup_id: Option<&str>,
    ) -> Result<RetentionView, HandlerError> {
        let mut reasons = Vec::new();
        if !matches!(
            source.status,
            OperationStatus::Failed | OperationStatus::Cancelled
        ) {
            reasons.push(
                "Successful outputs, live attempts and uncertain recovery material are retained."
                    .into(),
            );
        }
        let material = self
            .runtime
            .material_state(source.operation.operation_id.as_str(), kind, cleanup_id)
            .await
            .map_err(before)?;
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
            match self.reference_paths().await {
                Ok(paths) => {
                    if material
                        .stage
                        .iter()
                        .chain(material.trash.iter())
                        .any(|item| paths.iter().any(|path| paths_overlap(&item.path, path)))
                    {
                        reasons.push("A successful plan/realization or live R library/namespace still references this material.".into());
                    }
                }
                Err(error) => reasons.push(format!("Cannot establish reference safety: {error}")),
            }
        }
        let allowed = reasons.is_empty();
        Ok(RetentionView {
            source_operation_id: source.operation.operation_id.as_str().into(),
            can_quarantine: allowed && material.stage.is_some() && material.trash.is_none(),
            can_restore: allowed && material.trash.is_some() && material.stage.is_none(),
            can_purge: allowed && material.trash.is_some() && material.stage.is_none(),
            material,
            retained_reasons: reasons,
        })
    }
}
fn paths_overlap(left: &str, right: &str) -> bool {
    let left = std::path::Path::new(left);
    let right = std::path::Path::new(right);
    left.starts_with(right) || right.starts_with(left)
}
pub struct RetentionQuery {
    owner: Arc<EnvironmentOwner>,
    trash: bool,
    descriptor: CapabilityDescriptor,
}
impl RetentionQuery {
    pub fn new(owner: Arc<EnvironmentOwner>, trash: bool) -> Self {
        let id = if trash {
            "environment.cleanup_status"
        } else {
            "environment.retention"
        };
        Self {
            owner,
            trash,
            descriptor: CapabilityDescriptor {
                kind: CapabilityKind::Query,
                capability: CapabilityRef::new(id, 1).unwrap(),
                documentation: rho_contract::builtin_documentation(id),
                recovery_schema: serde_json::json!({"type":"null"}),
                domain: "environment".into(),
                input_schema: if trash {
                    schema_for!(TrashArguments).to_value()
                } else {
                    schema_for!(SourceArguments).to_value()
                },
                output_schema: schema_for!(RetentionView).to_value(),
                required_scopes: BTreeSet::from([ENVIRONMENT_READ_SCOPE.into()]),
                potential_effects: BTreeSet::new(),
                idempotency: IdempotencyClass::Pure,
                retry: RetryClass::Safe,
                cancellation: CancellationClass::Unsupported,
            },
        }
    }
}
#[async_trait]
impl QueryHandler for RetentionQuery {
    fn descriptor(&self) -> &CapabilityDescriptor {
        &self.descriptor
    }
    fn normalize_arguments(&self, value: &Value) -> Result<Value, OperationError> {
        let id = if self.trash {
            serde_json::from_value::<TrashArguments>(value.clone())
                .map_err(invalid)?
                .cleanup_operation_id
        } else {
            serde_json::from_value::<SourceArguments>(value.clone())
                .map_err(invalid)?
                .operation_id
        };
        rho_contract::OperationId::new(id).map_err(invalid)?;
        Ok(value.clone())
    }
    async fn query(&self, value: &Value) -> Result<QuerySnapshot, OperationError> {
        let mut reply = QuerySnapshot {
            next_reads: Vec::new(),
            diagnostics: Vec::new(),
            target: self.owner.target(),
            source: "environment/materials".into(),
            observed_at_ms: SystemClock.now_ms()?,
            status: QueryStatus::Busy,
            completeness: ObservationCompleteness::Partial,
            data: None,
            notices: Vec::new(),
        };
        let Ok(_lane) = self.owner.lane.try_lock() else {
            return Ok(reply);
        };
        let (source, kind, cleanup_id) = if self.trash {
            let input: TrashArguments = serde_json::from_value(value.clone()).map_err(invalid)?;
            let (source, kind) = self
                .owner
                .cleanup_source(&input.cleanup_operation_id, None)
                .await
                .map_err(|error| invalid(error.message))?;
            (source, kind, Some(input.cleanup_operation_id))
        } else {
            let input: SourceArguments = serde_json::from_value(value.clone()).map_err(invalid)?;
            let (source, kind) = self
                .owner
                .material_source(&input.operation_id, None)
                .await
                .map_err(|error| invalid(error.message))?;
            (source, kind, None)
        };
        match self
            .owner
            .retention_view(&source, kind, cleanup_id.as_deref())
            .await
        {
            Ok(view) => {
                reply.status = QueryStatus::Ready;
                reply.data = Some(serde_json::to_value(view).map_err(invalid)?);
            }
            Err(error) => {
                reply.status = QueryStatus::Unavailable;
                reply.notices.push(error.message);
            }
        }
        Ok(reply)
    }
}
pub struct RetentionHandler {
    owner: Arc<EnvironmentOwner>,
    action: MaterialAction,
    descriptor: CapabilityDescriptor,
}
impl RetentionHandler {
    pub fn new(owner: Arc<EnvironmentOwner>, action: MaterialAction) -> Self {
        let id = match action {
            MaterialAction::Quarantine => CLEANUP_CAPABILITY,
            MaterialAction::Restore => "environment.restore_cleanup",
            MaterialAction::Purge => "environment.purge_cleanup",
        };
        Self {
            owner,
            action,
            descriptor: CapabilityDescriptor {
                kind: CapabilityKind::Operation,
                capability: CapabilityRef::new(id, 1).unwrap(),
                documentation: rho_contract::builtin_documentation(id),
                recovery_schema: serde_json::json!({"type":"null"}),
                domain: "environment".into(),
                input_schema: if matches!(action, MaterialAction::Quarantine) {
                    schema_for!(CleanupArguments).to_value()
                } else {
                    schema_for!(ChangeTrashArguments).to_value()
                },
                output_schema: schema_for!(MaterialChange).to_value(),
                required_scopes: BTreeSet::from([ENVIRONMENT_WRITE_SCOPE.into()]),
                potential_effects: BTreeSet::from([
                    EffectHint::MaySpawnProcess,
                    EffectHint::MayWriteProject,
                ]),
                idempotency: IdempotencyClass::CallerScoped,
                retry: RetryClass::ReconcileFirst,
                cancellation: CancellationClass::Unsupported,
            },
        }
    }
}
#[async_trait]
impl OperationHandler for RetentionHandler {
    fn descriptor(&self) -> &CapabilityDescriptor {
        &self.descriptor
    }
    fn idempotency_scope(&self) -> Option<String> {
        Some(self.owner.runtime.root().into())
    }
    fn resolve_target(&self, _: &Value) -> Result<TargetRef, OperationError> {
        Ok(self.owner.target())
    }
    fn normalize_arguments(&self, value: &Value) -> Result<Value, OperationError> {
        let (id, digest) = if matches!(self.action, MaterialAction::Quarantine) {
            let args: CleanupArguments = serde_json::from_value(value.clone()).map_err(invalid)?;
            (args.operation_id, args.expected_fingerprint)
        } else {
            let args: ChangeTrashArguments =
                serde_json::from_value(value.clone()).map_err(invalid)?;
            (args.cleanup_operation_id, args.expected_fingerprint)
        };
        rho_contract::OperationId::new(id).map_err(invalid)?;
        if !digest.starts_with("sha256:")
            || digest.len() != 71
            || !digest[7..].chars().all(|c| c.is_ascii_hexdigit())
        {
            return Err(invalid("a preview fingerprint is required"));
        }
        Ok(value.clone())
    }
    async fn execute(&self, operation: &Operation) -> Result<CommitPlan, HandlerError> {
        if !operation.preconditions.is_empty() {
            return Err(before("material operations use their preview fingerprint"));
        }
        let (source, kind, cleanup_id, fingerprint) =
            if matches!(self.action, MaterialAction::Quarantine) {
                let args: CleanupArguments =
                    serde_json::from_value(operation.normalized_arguments.clone())
                        .map_err(before)?;
                let (source, kind) = self
                    .owner
                    .material_source(&args.operation_id, Some(operation.principal()))
                    .await?;
                (
                    source,
                    kind,
                    operation.operation_id.as_str().to_string(),
                    args.expected_fingerprint,
                )
            } else {
                let args: ChangeTrashArguments =
                    serde_json::from_value(operation.normalized_arguments.clone())
                        .map_err(before)?;
                let (source, kind) = self
                    .owner
                    .cleanup_source(&args.cleanup_operation_id, Some(operation.principal()))
                    .await?;
                (
                    source,
                    kind,
                    args.cleanup_operation_id,
                    args.expected_fingerprint,
                )
            };
        if !matches!(
            source.status,
            OperationStatus::Failed | OperationStatus::Cancelled
        ) {
            return Err(before(
                "successful, live and uncertain source materials are retained",
            ));
        }
        let _lane = self.owner.lane.lock().await;
        let view = self
            .owner
            .retention_view(&source, kind, Some(&cleanup_id))
            .await?;
        let allowed = match self.action {
            MaterialAction::Quarantine => view.can_quarantine,
            MaterialAction::Restore => view.can_restore,
            MaterialAction::Purge => view.can_purge,
        };
        if !allowed {
            return Err(before(format!(
                "material retained: {:?}",
                view.retained_reasons
            )));
        }
        let changed = self
            .owner
            .runtime
            .change_material(
                source.operation.operation_id.as_str(),
                kind,
                &cleanup_id,
                self.action,
                &fingerprint,
            )
            .await?;
        let mut plan = CommitPlan::succeeded(
            serde_json::to_value(&changed)
                .map_err(|error| HandlerError::after_possible_effect(error.to_string(), None))?,
        );
        plan.events.push(PlannedEvent { kind: "environment.material_changed".into(), payload: json!({"source_operation_id":changed.source_operation_id,"action":changed.action}) });
        Ok(plan)
    }
}
fn before(error: impl std::fmt::Display) -> HandlerError {
    HandlerError::before_effect(error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn references_protect_ancestors_and_descendants_not_string_prefix_neighbors() {
        assert!(paths_overlap(
            "/state/realizations/one",
            "/state/realizations/one/library/pkg"
        ));
        assert!(paths_overlap(
            "/state/realizations/one/library",
            "/state/realizations/one"
        ));
        assert!(!paths_overlap(
            "/state/realizations/one",
            "/state/realizations/one-other/library"
        ));
    }
}
