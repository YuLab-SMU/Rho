use anyhow::Context;
use rho_core::ExecutionOrigin;
use rho_environment::{ProjectEnvironmentMode, classify_project_environment};
use rho_protocol::EnvironmentIncidentV1;
use rho_server::coordinator::dispatch_workspace_request;
use rho_server::workspace_lane::WorkspaceBrokerState;
use rho_store::{
    EnvironmentOperationJournalRecord, EnvironmentStateProjection, normalize_project_root,
};
use rho_ui_contract::{
    EnvironmentBindingViewV1, EnvironmentCheckpointViewV1, EnvironmentHealthStatusViewV1,
    EnvironmentHealthViewV1, EnvironmentIncidentViewV1, EnvironmentOperationViewV1,
    EnvironmentPlanActionViewV1, EnvironmentPlanReviewViewV1, EnvironmentWorkspaceViewV1,
    LocalEnvironmentObservationViewV1,
};
use rho_workspace::{
    WorkspaceEnvironmentObservation, WorkspaceEnvironmentProbeObservation,
    WorkspaceEnvironmentReobservation,
};
use serde::Serialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use tauri::State;

use crate::application_state::{active_context, active_session, store_executor};
use crate::startup_runtime::runtime_config;
use crate::{AppState, display_error};

fn enum_text(value: &impl Serialize) -> String {
    serde_json::to_value(value)
        .ok()
        .and_then(|value| value.as_str().map(str::to_string))
        .unwrap_or_else(|| "unknown".to_string())
}

const MAX_RENV_LOCK_OBSERVATION_BYTES: u64 = 16 * 1024 * 1024;

fn sha256_json(value: &impl Serialize) -> Result<String, String> {
    let bytes = serde_json::to_vec(value).map_err(display_error)?;
    Ok(format!("sha256:{:x}", Sha256::digest(bytes)))
}

fn bounded_file_digest(path: &std::path::Path) -> Option<String> {
    let metadata = std::fs::metadata(path).ok()?;
    if !metadata.is_file() || metadata.len() > MAX_RENV_LOCK_OBSERVATION_BYTES {
        return None;
    }
    let bytes = std::fs::read(path).ok()?;
    Some(format!("sha256:{:x}", Sha256::digest(bytes)))
}

fn local_environment_observation_from_probe(
    project_root: &std::path::Path,
    rscript: &std::path::Path,
    r_home: &str,
    r_version: &str,
    r_libs: &str,
    path_sep: &str,
) -> Result<LocalEnvironmentObservationViewV1, String> {
    let libraries = r_libs
        .split(path_sep)
        .map(str::trim)
        .filter(|path| !path.is_empty())
        .collect::<Vec<_>>();
    let mode = classify_project_environment(project_root, false);
    let project_mode = match mode {
        ProjectEnvironmentMode::NativeUser => "native_user",
        ProjectEnvironmentMode::ProjectRenv => "project_renv",
    };
    let runtime_selection_digest = sha256_json(&serde_json::json!({
        "rscript": rscript.to_string_lossy(),
        "r_home": r_home,
        "version": r_version,
    }))?;
    let library_stack_digest = sha256_json(&libraries)?;
    let lockfile_digest = (mode == ProjectEnvironmentMode::ProjectRenv)
        .then(|| bounded_file_digest(&project_root.join("renv.lock")))
        .flatten();
    let observation_digest = sha256_json(&serde_json::json!({
        "project_mode": project_mode,
        "runtime_selection_digest": runtime_selection_digest,
        "library_stack_digest": library_stack_digest,
        "lockfile_digest": lockfile_digest.as_deref(),
        "coverage": "runtime_and_library_paths",
    }))?;
    Ok(LocalEnvironmentObservationViewV1 {
        project_mode: project_mode.to_string(),
        runtime_version: r_version.to_string(),
        runtime_selection_digest,
        library_stack_digest,
        library_count: u32::try_from(libraries.len()).unwrap_or(u32::MAX),
        lockfile_digest,
        coverage: "runtime_and_library_paths".to_string(),
        package_inventory_status: "not_captured".to_string(),
        externally_mutable: true,
        source: "startup_runtime_probe".to_string(),
        observation_digest,
    })
}

fn environment_binding_view(state: &EnvironmentStateProjection) -> EnvironmentBindingViewV1 {
    EnvironmentBindingViewV1 {
        environment_id: state.environment.environment_id.as_str().to_string(),
        role: enum_text(&state.environment.role),
        target_id: state.environment.target_id.clone(),
        runtime_id: state.realization.runtime_id.as_str().to_string(),
        runtime_ownership: None,
        runtime_support_tier: None,
        desired_revision: state.desired.revision_id.as_str().to_string(),
        realization_revision: state.realization.revision_id.as_str().to_string(),
        receipt_id: state.receipt.receipt_id.as_str().to_string(),
        receipt_digest: state.binding.receipt_digest.as_str().to_string(),
        receipt_outcome: enum_text(&state.receipt.outcome),
        receipt_restart_required: state.receipt.restart_required,
        updated_at: state.updated_at.clone(),
    }
}

fn environment_plan_review(
    plan: &rho_protocol::MaterializedPackagePlanV1,
) -> EnvironmentPlanReviewViewV1 {
    let target_kind = match plan.body.environment.role {
        rho_protocol::EnvironmentRoleV1::Core => rho_protocol::LibraryLayerKindV1::RhoCoreSupport,
        rho_protocol::EnvironmentRoleV1::Project => rho_protocol::LibraryLayerKindV1::ProjectRenv,
        rho_protocol::EnvironmentRoleV1::NativeUser => rho_protocol::LibraryLayerKindV1::User,
    };
    let target_library = plan
        .body
        .library_stack
        .ordered_layers
        .iter()
        .find(|layer| layer.kind == target_kind)
        .expect("validated Environment plan has one role library layer");
    EnvironmentPlanReviewViewV1 {
        plan_id: plan.plan_id.as_str().to_string(),
        intent: enum_text(&plan.body.intent),
        environment_id: plan.body.environment.environment_id.as_str().to_string(),
        expected_desired_revision: plan
            .body
            .expected_before
            .desired_revision
            .as_str()
            .to_string(),
        expected_realization_revision: plan
            .body
            .expected_before
            .realization_revision
            .as_str()
            .to_string(),
        runtime_id: plan.body.runtime.runtime_id.as_str().to_string(),
        runtime_version: plan.body.runtime.requirement.exact_version.clone(),
        runtime_ownership: enum_text(&plan.body.runtime.ownership),
        runtime_support_tier: enum_text(&plan.body.runtime.support_tier),
        library_stack_digest: plan
            .body
            .library_stack
            .effective_digest
            .as_str()
            .to_string(),
        target_library_kind: enum_text(&target_library.kind),
        target_library_path: target_library.canonical_path.clone(),
        package_actions: plan
            .body
            .package_actions
            .iter()
            .map(|action| EnvironmentPlanActionViewV1 {
                package: action.package.clone(),
                action: enum_text(&action.kind),
                version: action.to_version.clone(),
                source: action.source.clone(),
                artifact_digest: action.artifact_digest.as_str().to_string(),
                artifact_byte_size: action.artifact_byte_size,
            })
            .collect(),
        native_actions: plan
            .body
            .native_requirement_actions
            .iter()
            .map(|action| {
                format!(
                    "{}:{}:{}",
                    action.provider, action.requirement, action.action
                )
            })
            .collect(),
        toolchain_actions: plan
            .body
            .toolchain_actions
            .iter()
            .map(|action| format!("{}:{}", action.tool, action.action))
            .collect(),
        network_intents: plan
            .body
            .network_intents
            .iter()
            .map(|intent| {
                format!(
                    "{}://{}:{} ({})",
                    intent.scheme, intent.host, intent.port, intent.purpose
                )
            })
            .collect(),
        secret_requirements: plan
            .body
            .secret_requirements
            .iter()
            .map(|requirement| {
                format!(
                    "{} for {} ({})",
                    requirement.secret_ref, requirement.purpose, requirement.audience
                )
            })
            .collect(),
        verification_probes: plan
            .body
            .verification_probes
            .iter()
            .map(|probe| format!("{}:{}={}", probe.probe_id, probe.kind, probe.expected))
            .collect(),
        restart_required: plan.body.restart_required,
        expires_at: plan.body.expires_at.clone(),
    }
}

fn environment_operation_view(
    journal: &EnvironmentOperationJournalRecord,
) -> EnvironmentOperationViewV1 {
    EnvironmentOperationViewV1 {
        operation_id: journal.operation_id.clone(),
        status: journal.status.clone(),
        reason: journal.reason.clone(),
        checkpoints: journal
            .checkpoints
            .iter()
            .map(|checkpoint| EnvironmentCheckpointViewV1 {
                name: checkpoint.name.clone(),
                reached_at: checkpoint.reached_at.clone(),
                digest: checkpoint
                    .digest
                    .as_ref()
                    .map(|digest| digest.as_str().to_string()),
            })
            .collect(),
        plan: environment_plan_review(&journal.plan),
        created_at: journal.created_at.clone(),
        updated_at: journal.updated_at.clone(),
    }
}

fn environment_incident_view(
    record: rho_store::EnvironmentIncidentRecord,
) -> EnvironmentIncidentViewV1 {
    EnvironmentIncidentViewV1 {
        incident_id: record.incident.incident_id,
        kind: record.incident.kind,
        subject: record.incident.subject,
        detail: record.incident.detail,
        status: record.status,
        detected_at: record.incident.detected_at,
        resolved_at: record.resolved_at,
    }
}

async fn workspace_identity(state: &AppState) -> (Option<String>, Option<String>) {
    let context = state.context.lock().await.clone();
    context.map_or((None, None), |context| {
        let identity = context.identity();
        (
            Some(identity.workspace_id.clone()),
            Some(identity.kernel_instance_id.clone()),
        )
    })
}

async fn sync_workspace_environment_state(
    state: &AppState,
    project_root: &str,
    authority: Option<&EnvironmentStateProjection>,
) -> Result<rho_workspace::WorkspaceEnvironmentStatus, String> {
    let mut runtime = state.workspace_environment.lock().await;
    let binding_state = runtime.state_for_project(project_root);
    if let Some(authority) = authority {
        let status = binding_state.status();
        if status.active_binding.as_ref() != Some(&authority.binding)
            && status.pending_binding.as_ref() != Some(&authority.binding)
        {
            binding_state
                .stage_verified_binding(authority.binding.clone(), &authority.receipt)
                .map_err(display_error)?;
        }
    }
    Ok(binding_state.status())
}

pub(crate) async fn environment_health_for_state(
    state: &AppState,
) -> Result<EnvironmentHealthViewV1, String> {
    let root = state.project_root.read().await.clone();
    let project_root = normalize_project_root(root.to_string_lossy().as_ref());
    let repository = store_executor(state)
        .await
        .map_err(display_error)?
        .environment_repository();
    let (authority, latest_operation, pending_plan, incidents) = tokio::try_join!(
        repository.current_state(project_root.clone()),
        repository.latest_operation(project_root.clone()),
        repository.latest_plan(project_root.clone()),
        repository.list_incidents(project_root.clone(), false, 200),
    )
    .map_err(display_error)?;
    let binding_state =
        sync_workspace_environment_state(state, &project_root, authority.as_ref()).await?;
    let (workspace_id, kernel_instance_id) = workspace_identity(state).await;
    let local_observation = runtime_config(state)
        .ok()
        .map(|config| {
            local_environment_observation_from_probe(
                &root,
                &config.rscript,
                &config.r_home,
                &config.r_version,
                &config.r_libs,
                &config.path_sep,
            )
        })
        .transpose()?;
    let status = match binding_state.phase {
        rho_workspace::WorkspaceEnvironmentPhase::Unbound
            if workspace_id.is_some() && local_observation.is_some() =>
        {
            EnvironmentHealthStatusViewV1::LocalReady
        }
        rho_workspace::WorkspaceEnvironmentPhase::Unbound => EnvironmentHealthStatusViewV1::Unbound,
        rho_workspace::WorkspaceEnvironmentPhase::Active => EnvironmentHealthStatusViewV1::Realized,
        rho_workspace::WorkspaceEnvironmentPhase::RestartRequired => {
            EnvironmentHealthStatusViewV1::RestartRequired
        }
        rho_workspace::WorkspaceEnvironmentPhase::ObservationRequired => {
            EnvironmentHealthStatusViewV1::ObservationRequired
        }
        rho_workspace::WorkspaceEnvironmentPhase::BlockedByIncident => {
            EnvironmentHealthStatusViewV1::BlockedByIncident
        }
    };
    let mut limitations = vec![
        "Authority realization and live Workspace activation are reported separately.".to_string(),
    ];
    if workspace_id.is_none() {
        limitations
            .push("Workspace R is not running; live activation cannot be observed.".to_string());
    }
    if authority.is_none() {
        limitations.push(
            "No formal Environment mutation receipt is recorded; the local observation is externally mutable."
                .to_string(),
        );
    }
    if local_observation
        .as_ref()
        .is_some_and(|observation| observation.package_inventory_status == "not_captured")
    {
        limitations.push(
            "Package inventory is not covered by the startup Runtime and library-path observation."
                .to_string(),
        );
    }
    Ok(EnvironmentHealthViewV1 {
        status,
        binding: authority.as_ref().map(environment_binding_view),
        local_observation,
        workspace: EnvironmentWorkspaceViewV1 {
            phase: enum_text(&binding_state.phase),
            workspace_id,
            kernel_instance_id,
            active_receipt_digest: binding_state
                .active_binding
                .as_ref()
                .map(|binding| binding.receipt_digest.as_str().to_string()),
            pending_receipt_digest: binding_state
                .pending_binding
                .as_ref()
                .map(|binding| binding.receipt_digest.as_str().to_string()),
            restart_required: binding_state.restart_required,
            reobserve_required: binding_state.reobserve_required,
        },
        pending_plan: pending_plan
            .as_ref()
            .map(|record| environment_plan_review(&record.plan)),
        latest_operation: latest_operation.as_ref().map(environment_operation_view),
        incidents: incidents
            .into_iter()
            .map(environment_incident_view)
            .collect(),
        limitations,
        observed_at: chrono::Utc::now().to_rfc3339(),
    })
}

pub(crate) async fn require_environment_execution_ready(state: &AppState) -> anyhow::Result<()> {
    let health = environment_health_for_state(state)
        .await
        .map_err(anyhow::Error::msg)?;
    if health.workspace.restart_required || health.workspace.reobserve_required {
        anyhow::bail!(
            "Workspace Environment is {}; restart/re-observe the exact receipt before execution",
            health.workspace.phase
        );
    }
    Ok(())
}

#[cfg_attr(test, specta::specta)]
#[tauri::command]
pub(crate) async fn environment_health(
    state: State<'_, AppState>,
) -> Result<EnvironmentHealthViewV1, String> {
    environment_health_for_state(&state).await
}

fn inventory_digest(value: &Value) -> String {
    value
        .get("inventory_digest")
        .and_then(Value::as_str)
        .map(str::to_string)
        .unwrap_or_else(|| {
            let bytes = serde_json::to_vec(value).unwrap_or_default();
            format!("sha256:{:x}", Sha256::digest(bytes))
        })
}

fn contains_namespace_failure(value: &Value) -> bool {
    match value {
        Value::Array(values) => values.iter().any(contains_namespace_failure),
        Value::Object(values) => {
            values.get("loadable").is_some_and(|value| value == false)
                || values
                    .get("status")
                    .and_then(Value::as_str)
                    .is_some_and(|status| status == "namespace_load_failure")
                || values.values().any(contains_namespace_failure)
        }
        Value::Null | Value::Bool(_) | Value::Number(_) | Value::String(_) => false,
    }
}

fn reobservation_incident(
    authority: &EnvironmentStateProjection,
    kind: &str,
    detail: String,
    detected_at: &str,
) -> EnvironmentIncidentV1 {
    let identity = format!(
        "{}:{kind}:{}:{detail}",
        authority.environment.environment_id.as_str(),
        authority.realization.revision_id.as_str()
    );
    EnvironmentIncidentV1 {
        incident_id: format!(
            "environment_incident_{:x}",
            Sha256::digest(identity.as_bytes())
        ),
        environment_id: authority.environment.environment_id.clone(),
        kind: kind.to_string(),
        subject: authority.environment.environment_id.as_str().to_string(),
        detail,
        observed_desired_revision: Some(authority.desired.revision_id.clone()),
        observed_realization_revision: Some(authority.realization.revision_id.clone()),
        detected_at: detected_at.to_string(),
    }
}

pub(crate) async fn record_environment_workspace_restart(
    state: &AppState,
    old_kernel: &str,
    new_kernel: &str,
) -> Result<bool, String> {
    let health = environment_health_for_state(state).await?;
    if !health.workspace.restart_required {
        return Ok(false);
    }
    let root = state.project_root.read().await.clone();
    let project_root = normalize_project_root(root.to_string_lossy().as_ref());
    let old_kernel = rho_protocol::KernelInstanceId::new(old_kernel).map_err(display_error)?;
    let new_kernel = rho_protocol::KernelInstanceId::new(new_kernel).map_err(display_error)?;
    let mut runtime = state.workspace_environment.lock().await;
    runtime
        .state_for_project(&project_root)
        .record_restart(&old_kernel, &new_kernel)
        .map_err(display_error)?;
    Ok(true)
}

pub(crate) async fn reobserve_environment_for_state(
    state: &AppState,
) -> Result<EnvironmentHealthViewV1, String> {
    let root = state.project_root.read().await.clone();
    let project_root = normalize_project_root(root.to_string_lossy().as_ref());
    let repository = store_executor(state)
        .await
        .map_err(display_error)?
        .environment_repository();
    let authority = repository
        .current_state(project_root.clone())
        .await
        .map_err(display_error)?
        .context("No verified Environment receipt is available to re-observe")
        .map_err(display_error)?;
    sync_workspace_environment_state(state, &project_root, Some(&authority)).await?;
    let session = active_session(state).await.map_err(display_error)?;
    let context = active_context(state).await.map_err(display_error)?;
    let identity = context.identity();
    let kernel_instance_id =
        rho_protocol::KernelInstanceId::new(identity.kernel_instance_id.clone())
            .map_err(display_error)?;
    let mut lane = context.lock().await;
    let WorkspaceBrokerState { broker, executor } = &mut *lane;
    let payload = json!({
        "arguments": { "limit": 2_000 },
        "expected_workspace": broker.identity()
    });
    let inventory = dispatch_workspace_request(
        "workspace.list_installed_packages",
        &payload,
        ExecutionOrigin::System,
        session.as_ref(),
        broker,
        executor,
    )
    .await
    .map_err(display_error)?;
    drop(lane);
    let observed_at = chrono::Utc::now().to_rfc3339();
    let observed_digest = inventory_digest(&inventory);
    let digest_matches = observed_digest == authority.realization.package_inventory_digest.as_str();
    let namespaces_load = !contains_namespace_failure(&inventory);
    let mut incidents = Vec::new();
    if !digest_matches {
        incidents.push(reobservation_incident(
            &authority,
            "realization_mismatch",
            format!(
                "Observed package inventory {observed_digest} differs from receipt realization {}.",
                authority.realization.package_inventory_digest.as_str()
            ),
            &observed_at,
        ));
    }
    if !namespaces_load {
        incidents.push(reobservation_incident(
            &authority,
            "namespace_load_failure",
            "At least one package namespace failed to load in the restarted Workspace.".to_string(),
            &observed_at,
        ));
    }
    for incident in &incidents {
        repository
            .record_incident(project_root.clone(), incident.clone())
            .await
            .map_err(display_error)?;
    }
    let observation = WorkspaceEnvironmentObservation {
        kernel_instance_id,
        binding: authority.binding.clone(),
        probes: vec![
            WorkspaceEnvironmentProbeObservation {
                probe_id: "workspace_package_inventory".to_string(),
                kind: "package_inventory_digest".to_string(),
                passed: digest_matches,
                detail: observed_digest,
            },
            WorkspaceEnvironmentProbeObservation {
                probe_id: "workspace_namespace_load".to_string(),
                kind: "namespace_load".to_string(),
                passed: namespaces_load,
                detail: if namespaces_load {
                    "All reported package namespaces are loadable.".to_string()
                } else {
                    "One or more reported package namespaces are not loadable.".to_string()
                },
            },
        ],
        incidents,
        observed_at,
    };
    let observation_kernel = observation.kernel_instance_id.clone();
    let mut runtime = state.workspace_environment.lock().await;
    let prior_incident_ids = runtime
        .state_for_project(&project_root)
        .status()
        .incidents
        .into_iter()
        .map(|incident| incident.incident_id)
        .collect::<Vec<_>>();
    let reobservation = runtime
        .state_for_project(&project_root)
        .reobserve(&observation_kernel, observation)
        .map_err(display_error)?;
    drop(runtime);
    if matches!(
        reobservation,
        WorkspaceEnvironmentReobservation::Activated { .. }
    ) {
        let resolved_at = chrono::Utc::now().to_rfc3339();
        for incident_id in prior_incident_ids {
            repository
                .resolve_incident(
                    project_root.clone(),
                    authority.environment.environment_id.as_str().to_string(),
                    incident_id,
                    resolved_at.clone(),
                )
                .await
                .map_err(display_error)?;
        }
    }
    environment_health_for_state(state).await
}

#[cfg_attr(test, specta::specta)]
#[tauri::command]
pub(crate) async fn environment_reobserve(
    state: State<'_, AppState>,
) -> Result<EnvironmentHealthViewV1, String> {
    reobserve_environment_for_state(&state).await
}

#[cfg(test)]
mod environment_realization_tests {
    use super::*;

    #[test]
    fn local_observation_classifies_native_and_renv_without_claiming_package_inventory() {
        let project = tempfile::tempdir().unwrap();
        let native = local_environment_observation_from_probe(
            project.path(),
            std::path::Path::new("/opt/R/bin/Rscript"),
            "/opt/R/lib/R",
            "R version 4.6.1",
            "/users/test/R/library:/opt/R/library",
            ":",
        )
        .unwrap();
        assert_eq!(native.project_mode, "native_user");
        assert_eq!(native.library_count, 2);
        assert_eq!(native.coverage, "runtime_and_library_paths");
        assert_eq!(native.package_inventory_status, "not_captured");
        assert!(native.externally_mutable);
        assert!(native.lockfile_digest.is_none());
        assert!(native.observation_digest.starts_with("sha256:"));

        std::fs::write(project.path().join("renv.lock"), b"{\"R\":{}}\n").unwrap();
        let renv = local_environment_observation_from_probe(
            project.path(),
            std::path::Path::new("/opt/R/bin/Rscript"),
            "/opt/R/lib/R",
            "R version 4.6.1",
            "/users/test/R/library:/opt/R/library",
            ":",
        )
        .unwrap();
        assert_eq!(renv.project_mode, "project_renv");
        assert!(renv.lockfile_digest.is_some());
        assert_ne!(renv.observation_digest, native.observation_digest);
    }

    #[test]
    fn workspace_inventory_observation_uses_explicit_digest_and_detects_namespace_failure() {
        let explicit = json!({
            "inventory_digest": format!("sha256:{}", "a".repeat(64)),
            "packages": [{"name": "DESeq2", "loadable": false}]
        });
        assert_eq!(
            inventory_digest(&explicit),
            format!("sha256:{}", "a".repeat(64))
        );
        assert!(contains_namespace_failure(&explicit));
        assert!(!contains_namespace_failure(&json!({
            "packages": [{"name": "DESeq2", "loadable": true}]
        })));
    }
}
