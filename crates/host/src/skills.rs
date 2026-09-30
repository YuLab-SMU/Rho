//! Shared Host composition/control glue. Source enablement only enters through native launch configuration.
use crate::NextHost;
use async_trait::async_trait;
use rho_adapter_skills::{FilesystemSkillSource, HostDiscoveredSkillSource};
use rho_application::{ApplicationError, ApplicationOwner};
use rho_contract::*;
use rho_operation::OperationError;
use rho_skills::{MethodBindingPort, SkillCapabilityPort, SkillOwner, SkillSource};
use schemars::schema_for;
use serde_json::json;
use std::{
    collections::BTreeSet,
    path::{Path, PathBuf},
    sync::Arc,
};

struct ApplicationMethods(Arc<ApplicationOwner>);
#[async_trait]
impl MethodBindingPort for ApplicationMethods {
    async fn method_bindings(
        &self,
        context: &CallContext,
    ) -> Result<Vec<ApplicationMethodBinding>, String> {
        self.0
            .method_bindings(context)
            .map_err(|error| error.to_string())
    }
    async fn record_skill_read(
        &self,
        context: &CallContext,
        receipt: &ApplicationSkillReadReceipt,
    ) -> Result<(), String> {
        self.0
            .record_skill_read(context, receipt)
            .map_err(|error| error.to_string())
    }
}
fn local_principal() -> Result<String, OperationError> {
    serde_json::to_string(NextHost::local_context().principal())
        .map_err(|e| OperationError::InvalidInput(e.to_string()))
}
fn user_home() -> Result<PathBuf, OperationError> {
    let variable = if cfg!(windows) { "USERPROFILE" } else { "HOME" };
    std::env::var_os(variable)
        .filter(|path| !path.is_empty())
        .map(PathBuf::from)
        .ok_or_else(|| {
            OperationError::Unavailable(format!(
                "{variable} is unavailable; cannot discover the current user's standard Skills"
            ))
        })
}
pub(crate) fn compose(
    project: &str,
    app: Arc<ApplicationOwner>,
    capabilities: Arc<dyn SkillCapabilityPort>,
    manifest: Option<&Path>,
    exclusions: Vec<PathBuf>,
) -> Result<Arc<SkillOwner>, OperationError> {
    let home = user_home()?;
    let native = FilesystemSkillSource::new(Path::new(project), Some(&home))?
        .with_excluded_paths(exclusions.clone())?;
    let mut sources: Vec<Arc<dyn SkillSource>> = vec![Arc::new(native)];
    if let Some(path) = manifest {
        let source = HostDiscoveredSkillSource::from_manifest(
            Path::new(project),
            local_principal()?,
            path,
            exclusions,
        )?;
        source.validate_for_project()?;
        sources.push(Arc::new(source));
    }
    Ok(Arc::new(SkillOwner::new(
        project.into(),
        sources,
        Arc::new(ApplicationMethods(app)),
        capabilities,
    )?))
}
/// Candidates include future SQLite sidecars. Adapters retain lexical and resolved exclusions.
pub(crate) fn protected_path_candidates(database: &Path) -> Vec<PathBuf> {
    let application = database.with_extension("studio.sqlite");
    let preferences = database
        .parent()
        .unwrap_or(Path::new("."))
        .join("runtime-preferences.sqlite");
    let mut paths = vec![
        database.to_path_buf(),
        rho_plugins::repository_path(database),
        application.clone(),
        preferences.clone(),
    ];
    for store in [application, preferences] {
        for suffix in ["-journal", "-wal", "-shm"] {
            let mut path = store.as_os_str().to_os_string();
            path.push(suffix);
            paths.push(path.into());
        }
    }
    let mut journals = vec![database.to_path_buf()];
    if let Ok(canonical) = database.canonicalize() {
        journals.push(canonical);
    }
    for journal in journals {
        paths.push(journal.clone());
        for suffix in [".host.lock", "-journal", "-wal", "-shm"] {
            let mut path = journal.as_os_str().to_os_string();
            path.push(suffix);
            paths.push(path.into());
        }
    }
    paths.sort();
    paths.dedup();
    paths
}
/// Caller holds the shared method-binding gate across this validation and Application CAS write.
pub(crate) async fn bind_method(
    owner: &SkillOwner,
    app: &ApplicationOwner,
    context: &CallContext,
    expected_version: Option<&str>,
    binding: &ApplicationMethodBinding,
) -> Result<ApplicationMethodBinding, OperationError> {
    context.validate()?;
    let required = BTreeSet::from(["application.control".to_string(), "skill.read".to_string()]);
    let missing = required
        .difference(&context.scopes)
        .cloned()
        .collect::<Vec<_>>();
    if !missing.is_empty() {
        return Err(OperationError::AccessDenied {
            capability: "application.bind_method@1".into(),
            missing,
        });
    }
    if let Some(target) = &binding.target {
        target.validate()?;
    }
    if let Some(previous) = app
        .method_bindings(context)
        .map_err(application_error)?
        .into_iter()
        .find(|previous| previous.binding_id == binding.binding_id)
    {
        if previous == *binding {
            return Ok(previous);
        }
        if previous.source_ref != binding.source_ref
            || previous.working_directory != binding.working_directory
            || previous.external_task_ref != binding.external_task_ref
        {
            return Err(OperationError::InvalidInput("A binding's method source and work scope are stable. Use a new binding ID for a different source/scope; clear an existing exclusion explicitly in its original scope.".into()));
        }
    }
    for capability in &binding.required_capabilities {
        capability.validate()?;
    }
    owner.validate_binding(context, binding).await?;
    app.write_method_binding(context, expected_version, binding)
        .map_err(application_error)?;
    let persisted = app
        .method_bindings(context)
        .map_err(application_error)?
        .into_iter()
        .find(|b| b.binding_id == binding.binding_id)
        .ok_or_else(|| {
            OperationError::Storage("Application binding disappeared after its CAS write".into())
        })?;
    if persisted != *binding {
        return Err(OperationError::ContentChanged(
            "Application binding changed before confirmation; inspect host.resolve_context".into(),
        ));
    }
    Ok(persisted)
}
fn application_error(error: ApplicationError) -> OperationError {
    match error {
        ApplicationError::Conflict | ApplicationError::RequestConflict => {
            OperationError::ContentChanged(error.to_string())
        }
        ApplicationError::Budget(message) => OperationError::BudgetExceeded(message),
        ApplicationError::Storage(message) => OperationError::Storage(message),
        ApplicationError::InvalidInput(message) => OperationError::InvalidInput(message),
        _ => OperationError::Unavailable(error.to_string()),
    }
}
pub(crate) fn bind_method_descriptor() -> CapabilityDescriptor {
    CapabilityDescriptor {kind:CapabilityKind::Control,capability:CapabilityRef::new("application.bind_method",1).unwrap(),domain:"application".into(),input_schema:schema_for!(BindMethodRequest).to_value(),output_schema:schema_for!(ApplicationMethodBinding).to_value(),recovery_schema:json!({"type":"null"}),required_scopes:BTreeSet::from(["application.control".into(),"skill.read".into()]),potential_effects:BTreeSet::new(),idempotency:IdempotencyClass::CallerScoped,retry:RetryClass::ReconcileFirst,cancellation:CancellationClass::Unsupported,documentation:CapabilityDocumentation {summary:"Record an explicit method choice or exclusion using application version preconditions".into(),purpose:"Associate exact Skill resources with the caller's project/task/target without changing the Skill or scheduling scientific work".into(),when_to_use:vec!["The user or external Agent explicitly selects, excludes, or updates a method binding".into()],limitations:vec!["Host-disabled/rejected sources and ancestor exclusions cannot be bypassed by child selections".into(),"Native source enablement is trusted launch metadata and cannot be published through this control".into(),"A binding records a declaration, not proof that a method was followed".into()],owner:"Application owner; Skills validates method identities and known conditions".into(),effects:"CAS-write one application metadata binding; no Skill file change, scientific operation, runtime startup or execution".into(),retry_rule:"After a lost acknowledgement read host.resolve_context and compare the original binding ID/version; do not overwrite a newer version".into(),cancellation_rule:"Atomic application metadata write; cancellation does not roll back a confirmed binding".into(),preconditions:vec![CapabilityPrecondition {parameter:"expected_version".into(),requirement:"Null for a new binding; otherwise the exact current version returned by application context resolution".into(),read_from:Some(CapabilityRef::new("host.resolve_context",1).unwrap())},CapabilityPrecondition {parameter:"binding.skill_ref".into(),requirement:"Current content-bound Skill reference with matching source and resource digests".into(),read_from:Some(CapabilityRef::new("skill.list",1).unwrap())}],examples:vec![CapabilityExample {arguments:json!({"expected_version":null,"binding":{"binding_id":"method-example","version":"method-v1","working_directory":".","external_goal_ref":null,"external_task_ref":"task-example","external_actor_ref":null,"skill_ref":format!("skill-source:{}:{}:{}","0".repeat(64),"0".repeat(16),"0".repeat(64)),"source_ref":format!("skill-source:{}","0".repeat(64)),"resources":[],"modules":["workspace"],"capabilities":[],"required_capabilities":[],"target":null,"excluded":false}}),result_explanation:"Returns the exact persisted binding only after source/condition validation and CAS success. Replace the illustrative Skill/source identities with current discovered references.".into()}],related_capabilities:vec![CapabilityRef::new("skill.list",1).unwrap(),CapabilityRef::new("skill.read",1).unwrap(),CapabilityRef::new("host.resolve_context",1).unwrap()],related_skills:vec![],position_units:vec!["working_directory is a normalized project-relative path; resource hashes identify original bytes".into()]}}
}
