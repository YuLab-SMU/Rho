#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod agent_llm;
mod application_lifecycle;
mod application_state;
mod check_runtime;
mod commands;
mod digest;
mod git;
mod git_commands;
mod git_review;
mod internal_extensions;
mod platform;
mod plugin_surface_runtime;
mod project;
mod project_transition;
mod resource_registry;
mod runtime_registry;
mod shell;
mod startup_runtime;
mod studio_runtime;
mod surface_runtime;
mod ui_profile;
mod ui_runtime;
mod update;
mod workspace_lifecycle;
mod workspace_plugins;

use application_lifecycle::shutdown_application;
pub(crate) use application_state::AppState;
#[cfg(test)]
use application_state::{active_context, persist_workspace_identity, store_executor};
#[cfg(test)]
use commands::agent_execution::{AgentTaskEntry, agent_turn_admission_error};
#[cfg(test)]
use digest::text_sha256;
use internal_extensions::*;
use project_transition::*;
use startup_runtime::*;
use workspace_lifecycle::*;

#[cfg(test)]
use commands::agent_execution::interrupt_all_agent_tasks;
#[cfg(test)]
use commands::agent_execution::{agent_retry_source, cancel_agent_turn_state};
use commands::agent_files::AgentFileMutationRegistry;
#[cfg(test)]
use commands::agent_files::recover_incomplete_agent_file_mutations;
#[cfg(test)]
use commands::agent_files::{
    AgentFileApplyRequest, AgentFileApplyTestControl, AgentFileUndoRequest,
    PersistedAgentFileProposal, append_agent_file_mutation_event, apply_agent_file_edit_state,
    classify_agent_file_postwrite_failure, classify_agent_file_write_failure,
    ensure_agent_file_proposal_turn_terminal, persist_agent_file_mutation_event_to_store,
    undo_agent_file_edit_state, validate_persisted_agent_file_proposal_structure,
};
#[cfg(test)]
use commands::render::RenderJobState;
use commands::render::render_job_is_terminal;
#[cfg(test)]
use commands::render::{attach_render_artifact, finish_render_job, reconcile_render_job};
#[cfg(test)]
use commands::workspace::ExtensionWorkspaceSnapshotAdapter;
use commands::workspace::expected_workspace;
#[cfg(test)]
use commands::workspace::{
    ExecuteRequest, ExecuteSourceRange, snapshot_workspace_with_state,
    validate_execute_source_range_shape,
};

use std::collections::{BTreeMap, HashMap};
use std::path::Path;
#[cfg(windows)]
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, RwLock as SyncRwLock};
use std::time::Duration;

use agent_llm::AgentModelTestControl;
#[cfg(test)]
use agent_llm::{
    AgentContextCapacityRequest, AgentLlmSettingsView, AgentModelProfile, AgentProviderProfile,
};
use anyhow::{Context, Result, anyhow, bail, ensure};
#[cfg(test)]
use project::durable_project_root;
#[cfg(test)]
use project::{MAX_VIEWER_FILE_BYTES, MAX_VIEWER_HTML_BYTES};
use project::{ProjectSessionStore, default_project_root, read_viewer_file};
use rho_core::{BrokerState, ExecutionOrigin};
use rho_extension_runtime::{
    BoundedJson, CapabilityDeclaration, DiagnosticSink, DisposeOutcome, ExtensionDiagnostic,
    ExtensionHost, InternalExtensionRuntimeMode, LifecycleDeadlines,
};
use rho_kernel::{ArkLaunchConfig, ArkSession, KernelEvent};
use rho_server::coordinator::{
    AgentRuntimeAdapters, AgentWorkspaceLane, PendingApprovalRegistry, bootstrap_bridge,
    dispatch_workspace_request, dispatch_workspace_request_with_execution_id, run_agent_turn,
};
use rho_server::workspace_lane::WorkspaceBrokerLane;
use rho_store::{
    AgentTurnDraft, AgentTurnEventDraft, RunSummary, Store, StoreExecutor, normalize_project_root,
};
use serde_json::{Value, json};
use tauri::Manager;
use tokio::sync::{Mutex, RwLock};
use uuid::Uuid;

#[cfg(test)]
#[path = "agent_contract_tests.rs"]
mod agent_contract_tests;

#[cfg(test)]
#[path = "main_tests.rs"]
mod tests;

async fn smoke_test(include_agent: bool) -> Result<Value> {
    let smoke_directory = tempfile::Builder::new()
        .prefix("rho-desktop-smoke-")
        .tempdir()
        .context("creating isolated desktop smoke directory")?;
    let smoke_root = smoke_directory.path().to_path_buf();
    let data_dir = smoke_root.join("data");
    let project_a_root = smoke_root.join("project-a");
    let project_b_root = smoke_root.join("project-b");
    std::fs::create_dir_all(&project_a_root)?;
    std::fs::create_dir_all(&project_b_root)?;
    let ark = development_ark_path()?;
    let config = prepare_runtime_files(data_dir, ark)?;
    git::set_process_path(config.process_path.clone());
    let mut session = ArkSession::launch(&ArkLaunchConfig::new(&config.kernelspec)).await?;
    let mut store = Store::open(&config.store_path)?;
    let mut broker = BrokerState::new("desktop_smoke");
    store.set_project_root(Some(project_a_root.to_string_lossy().as_ref()))?;
    store.save_identity(broker.identity())?;
    let executor = StoreExecutor::open(&config.store_path).await?;
    bootstrap_bridge(&session, &mut broker, &executor, &config.bridge_package).await?;
    set_smoke_project_root(
        &session,
        &mut broker,
        &mut store,
        &executor,
        &project_a_root,
    )
    .await?;
    let mut interrupt_requested = false;
    session
        .execute_with_options(
            "Sys.sleep(30)",
            |event| {
                interrupt_requested |= matches!(event.event, KernelEvent::InterruptRequested);
                Ok(())
            },
            |prompt, _| bail!("unexpected smoke-test input request: {prompt}"),
            Some(Duration::from_millis(150)),
        )
        .await?;
    ensure!(
        interrupt_requested,
        "desktop smoke did not request an Ark interrupt"
    );
    session
        .execute("stopifnot(identical(1L + 1L, 2L))", |_| Ok(()))
        .await?;
    let execute_payload = json!({
        "arguments": {
            "code": "rho_desktop_smoke <- data.frame(x = 1:5, y = (1:5)^2); plot(rho_desktop_smoke$x, rho_desktop_smoke$y, pch = 19)"
        },
        "expected_workspace": broker.identity()
    });
    let execution = dispatch_workspace_request(
        "workspace.execute",
        &execute_payload,
        ExecutionOrigin::User,
        &session,
        &mut broker,
        &executor,
    )
    .await?;
    let snapshot_payload = json!({
        "arguments": {},
        "expected_workspace": broker.identity()
    });
    let snapshot = dispatch_workspace_request(
        "workspace.snapshot",
        &snapshot_payload,
        ExecutionOrigin::System,
        &session,
        &mut broker,
        &executor,
    )
    .await?;
    let viewer_identity = broker.identity().clone();
    let inspect_data_payload = json!({
        "arguments": {
            "object_name": "rho_desktop_smoke"
        },
        "expected_workspace": viewer_identity
    });
    let inspect_data = dispatch_workspace_request(
        "workspace.inspect_data_object",
        &inspect_data_payload,
        ExecutionOrigin::System,
        &session,
        &mut broker,
        &executor,
    )
    .await?;
    let view_token = inspect_data["execution"]["view_token"]
        .as_str()
        .context("desktop smoke viewer did not return view_token")?
        .to_string();
    let page_payload = json!({
        "arguments": {
            "object_name": "rho_desktop_smoke",
            "view_token": view_token,
            "view_kind": "table",
            "view_key": "table",
            "row_offset": 0,
            "row_limit": 5,
            "column_offset": 0,
            "column_limit": 2
        },
        "expected_workspace": viewer_identity
    });
    let page = dispatch_workspace_request(
        "workspace.read_data_view",
        &page_payload,
        ExecutionOrigin::System,
        &session,
        &mut broker,
        &executor,
    )
    .await?;
    let page_row_count = page["execution"]["page"]["rows"]
        .as_array()
        .map(|rows| rows.len())
        .unwrap_or_default();
    ensure!(
        page_row_count > 0,
        "desktop smoke data viewer returned no rows"
    );
    let page_columns = page["execution"]["page"]["columns"]
        .as_array()
        .context("desktop smoke data viewer columns were not an array")?;
    let first_page_row = page["execution"]["page"]["rows"]
        .as_array()
        .and_then(|rows| rows.first())
        .context("desktop smoke data viewer did not return a first row")?;
    let first_page_cells = first_page_row["cells"]
        .as_array()
        .context("desktop smoke data viewer cells were not an array")?;
    let first_page_cell_states = first_page_row["cell_states"]
        .as_array()
        .context("desktop smoke data viewer cell states were not an array")?;
    ensure!(
        first_page_cells.len() == page_columns.len()
            && first_page_cell_states.len() == page_columns.len(),
        "desktop smoke data viewer row arrays were not aligned with columns"
    );
    let mutate_payload = json!({
        "arguments": {
            "code": "rho_desktop_smoke$z <- rho_desktop_smoke$x + rho_desktop_smoke$y"
        },
        "expected_workspace": broker.identity()
    });
    let _ = dispatch_workspace_request(
        "workspace.execute",
        &mutate_payload,
        ExecutionOrigin::User,
        &session,
        &mut broker,
        &executor,
    )
    .await?;
    let stale_page = dispatch_workspace_request(
        "workspace.read_data_view",
        &page_payload,
        ExecutionOrigin::System,
        &session,
        &mut broker,
        &executor,
    )
    .await;
    ensure!(
        stale_page.is_err(),
        "desktop smoke stale data viewer request unexpectedly succeeded"
    );
    let plot_count = execution["events"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|event| event["type"] == "display_data")
        .count();
    let object_found = snapshot["execution"]["objects"]
        .as_array()
        .into_iter()
        .flatten()
        .any(|object| object["name"] == "rho_desktop_smoke");
    ensure!(plot_count > 0, "desktop smoke test did not receive a plot");
    ensure!(
        object_found,
        "desktop smoke object was absent from Environment"
    );
    let project_a = normalize_project_root(project_a_root.to_string_lossy().as_ref());
    let initial_a_runs = store.list_runs(&project_a, Some(10))?;
    let project_a_run = initial_a_runs
        .iter()
        .find(|run| run.request_type == "workspace.execute")
        .context("desktop smoke did not persist a project A execution run")?
        .run_id
        .clone();

    set_smoke_project_root(
        &session,
        &mut broker,
        &mut store,
        &executor,
        &project_b_root,
    )
    .await?;
    let project_b_payload = json!({
        "arguments": {
            "code": "rho_desktop_smoke_b <- data.frame(group = c('b1', 'b2'), value = c(10, 20))"
        },
        "expected_workspace": broker.identity()
    });
    let _ = dispatch_workspace_request(
        "workspace.execute",
        &project_b_payload,
        ExecutionOrigin::User,
        &session,
        &mut broker,
        &executor,
    )
    .await?;
    let project_b = normalize_project_root(project_b_root.to_string_lossy().as_ref());
    let project_b_runs = store.list_runs(&project_b, Some(10))?;
    let project_b_run = project_b_runs
        .iter()
        .find(|run| run.request_type == "workspace.execute")
        .context("desktop smoke did not persist a project B execution run")?
        .run_id
        .clone();
    ensure!(
        store.get_run_detail(&project_a, &project_b_run)?.is_none(),
        "project B run leaked into project A detail lookup"
    );
    ensure!(
        store.get_run_detail(&project_b, &project_a_run)?.is_none(),
        "project A run leaked into project B detail lookup"
    );

    session.shutdown().await?;
    let session = Arc::new(ArkSession::launch(&ArkLaunchConfig::new(&config.kernelspec)).await?);
    let mut broker = BrokerState::new("desktop_smoke_restart");
    store.save_identity(broker.identity())?;
    bootstrap_bridge(&session, &mut broker, &executor, &config.bridge_package).await?;
    set_smoke_project_root(
        &session,
        &mut broker,
        &mut store,
        &executor,
        &project_a_root,
    )
    .await?;
    let restart_payload = json!({
        "arguments": {
            "code": "rho_desktop_restart <- nrow(rho_desktop_smoke)"
        },
        "expected_workspace": broker.identity()
    });
    let _ = dispatch_workspace_request(
        "workspace.execute",
        &restart_payload,
        ExecutionOrigin::User,
        &session,
        &mut broker,
        &executor,
    )
    .await?;
    let project_a_runs_after_restart = store.list_runs(&project_a, Some(10))?;
    let project_a_restart_run = project_a_runs_after_restart
        .iter()
        .find(|run| {
            run.request_type == "workspace.execute"
                && run.code_preview.contains("rho_desktop_restart")
        })
        .context("desktop smoke restart execution was not recorded under project A")?
        .run_id
        .clone();
    ensure!(
        store
            .get_run_detail(&project_b, &project_a_restart_run)?
            .is_none(),
        "project A restart run leaked into project B after Workspace R restart"
    );

    let context = Arc::new(WorkspaceBrokerLane::new(broker, executor.clone()));
    let extension_runtime = smoke_extension_runtime(
        Arc::clone(&session),
        Arc::clone(&context),
        &config.store_path,
        &project_a_root,
    )
    .await?;
    let phase2_wasm_host = smoke_wasm_plugin_host(&config.store_path, &project_a_root)?;
    let agent = if include_agent {
        let turn_id = format!("smoke_turn_{}", Uuid::new_v4());
        let conversation_id = format!("conversation_{turn_id}");
        let prompt =
            "请检查 rho_desktop_smoke 对象，告诉我它有多少行和多少列。不要修改工作区。".to_string();
        let resolved_model = agent_llm::resolve_model_for_turn(&config.data_dir, None, "ask")?;
        let agent_project_root;
        {
            let context_guard = context.lock().await;
            let identity = context_guard.broker.identity().clone();
            agent_project_root = store
                .active_project_root()?
                .context("Cannot run Agent smoke without an active project identity")?;
            store.create_agent_turn(&AgentTurnDraft {
                turn_id: turn_id.clone(),
                project_root: agent_project_root.clone(),
                mode: "ask".to_string(),
                prompt: prompt.clone(),
                model: resolved_model.effective_model_ref.clone(),
                workspace_id: identity.workspace_id,
                state_revision_before: identity.state_revision as i64,
                project_revision_before: identity.project_revision as i64,
            })?;
            store.append_agent_turn_event(&AgentTurnEventDraft {
                turn_id: turn_id.clone(),
                event_type: "agent.user_prompt".to_string(),
                title: "You".to_string(),
                body: Some(prompt.clone()),
                status: "completed".to_string(),
                tool: None,
                request_id: None,
                code: None,
                details_json: serde_json::to_string(
                    &json!({"prompt": prompt.clone(), "mode": "ask"}),
                )?,
            })?;
        }
        let agent_store = StoreExecutor::open(&config.store_path)
            .await?
            .agent_repository();
        let result = run_agent_turn(
            session.as_ref(),
            context.clone(),
            agent_store,
            agent_project_root,
            config.rscript.clone(),
            Some(config.process_path.clone()),
            config.agent_package.clone(),
            resolved_model.effective_model_ref.clone(),
            Some(resolved_model.runtime_profile),
            None,
            None,
            prompt,
            "ask".to_string(),
            turn_id,
            conversation_id,
            Arc::new(AgentWorkspaceLane::default()),
            Arc::new(PendingApprovalRegistry::default()),
            Arc::new(PendingApprovalRegistry::default()),
            false,
            None,
            None,
            None,
            AgentRuntimeAdapters::default(),
            Vec::new(),
        )
        .await?;
        let completed = result["events"]
            .as_array()
            .into_iter()
            .flatten()
            .any(|event| event["type"] == "chat.message_completed");
        ensure!(completed, "desktop Agent turn omitted its final message");
        Some(json!({"completed": true, "model": result["model"]}))
    } else {
        None
    };
    #[cfg(unix)]
    let crash_recovered = {
        session.terminate_process_group().await?;
        drop(session);
        let mut recovered = ArkSession::launch(&ArkLaunchConfig::new(&config.kernelspec)).await?;
        recovered
            .execute("stopifnot(identical(2L + 2L, 4L))", |_| Ok(()))
            .await?;
        recovered.shutdown().await?;
        true
    };
    #[cfg(not(unix))]
    let crash_recovered = {
        let mut session = Arc::try_unwrap(session)
            .map_err(|_| anyhow!("extension smoke retained the restarted Ark session"))?;
        session.shutdown().await?;
        false
    };
    let report = {
        let context = context.lock().await;
        json!({
            "type": "rho_desktop_smoke",
            "workspace": context.broker.identity(),
            "plot_count": plot_count,
            "environment_object_found": object_found,
            "data_view_rows": page_row_count,
            "stale_view_rejected": true,
            "project_switch_isolated": true,
            "workspace_restart_project_isolated": true,
            "extension_runtime": extension_runtime,
            "phase2_wasm_host": phase2_wasm_host,
            "interrupt_recovered": interrupt_requested,
            "crash_recovered": crash_recovered,
            "project_a_run_count": initial_a_runs.len(),
            "project_b_run_count": project_b_runs.len(),
            "agent": agent,
            "event_count": store.event_count()?,
            "python_required": false
        })
    };
    Ok(report)
}

fn smoke_wasm_plugin_host(store_path: &Path, project_root: &Path) -> Result<Value> {
    use rho_extension_runtime::{
        ActivationGeneration, BrokerCallIdSource, CapabilityId, ContributionCallOutcome,
        ContributionCallRequest, ContributionCallSession, ContributionClock, ContributionError,
        ContributionInstanceIdentity, ContributionInvocationOrigin, ContributionStore,
        GrantRequest, GrantSource, GrantStore, GuestStep, HostFrame, HostInstanceId,
        HostInstanceState, HostMessage, HostProtocolErrorCode, HostRequestId, HostResponse,
        P2_1_SMOKE_WASM, P2_1_WASI_IMPORT_SMOKE_WASM, P2_2_SMOKE_WASM, PackageDigest,
        PermissionConstraints, PermissionKind, PluginId, PluginVersion, RuntimeKind, ScopeId,
        ViewerDocumentV1, WasmHostIdentity, WasmPluginHost, WorkspacePluginManifest,
    };
    use rho_store::{
        PluginLifecycleMutationService, PluginLifecycleQueryService, PluginPermissionDecision,
        PluginPermissionDecisionDraft, PluginPermissionMutationOutcome,
        PluginPermissionMutationService, PluginPermissionQueryService,
        PluginPermissionRequestDraft,
    };

    #[derive(Debug)]
    struct SmokeCallId;
    impl BrokerCallIdSource for SmokeCallId {
        fn next_call_id(&self) -> u64 {
            42
        }
    }

    #[derive(Debug)]
    struct SmokeClock;
    impl ContributionClock for SmokeClock {
        fn now_millis(&self) -> u64 {
            100
        }
    }

    let identity = WasmHostIdentity::new(
        ScopeId::new("project.installed-smoke")?,
        PluginId::new("org.yulab.rho.phase2-smoke")?,
        PackageDigest::from_inventory(&[(b"dist/plugin.wasm", P2_1_SMOKE_WASM)]),
        ActivationGeneration::new(1)?,
        HostInstanceId::generate(),
    );
    let mut host = WasmPluginHost::from_bytes(identity, P2_1_SMOKE_WASM)
        .map_err(|error| anyhow!("creating installed P2-1 Wasm host: {error:?}"))?;
    let make_frame = |host: &WasmPluginHost, message| HostFrame {
        instance_id: host.identity().host_instance_id().clone(),
        message,
    };
    ensure!(
        host.handle_frame(make_frame(
            &host,
            HostMessage::Hello {
                api_version: rho_extension_runtime::HOST_PROTOCOL_VERSION,
            },
        ))
        .map_err(|error| anyhow!("negotiating installed P2-1 Wasm host: {error:?}"))?
            == Some(HostResponse::Ready {
                api_version: rho_extension_runtime::HOST_PROTOCOL_VERSION,
            }),
        "installed P2-1 Wasm host did not negotiate V1"
    );
    ensure!(
        host.handle_frame(make_frame(&host, HostMessage::Activate))
            .map_err(|error| anyhow!("activating installed P2-1 Wasm host: {error:?}"))?
            == Some(HostResponse::Activated),
        "installed P2-1 Wasm host did not activate"
    );
    let request_id = HostRequestId::new("request.installed-smoke")?;
    ensure!(
        host.handle_frame(make_frame(
            &host,
            HostMessage::Echo {
                request_id: request_id.clone(),
                payload: "Rho P2 Wasm".to_string(),
            },
        ))
        .map_err(|error| anyhow!("calling installed P2-1 Wasm host: {error:?}"))?
            == Some(HostResponse::EchoResult {
                request_id,
                payload: "Rho P2 Wasm".to_string(),
            }),
        "installed P2-1 Wasm host echo diverged"
    );
    ensure!(
        host.handle_frame(make_frame(&host, HostMessage::Heartbeat))
            .map_err(|error| anyhow!("heartbeating installed P2-1 Wasm host: {error:?}"))?
            == Some(HostResponse::HeartbeatAck),
        "installed P2-1 Wasm host heartbeat failed"
    );
    ensure!(
        host.handle_frame(make_frame(&host, HostMessage::Quiesce))
            .map_err(|error| anyhow!("quiescing installed P2-1 Wasm host: {error:?}"))?
            == Some(HostResponse::Quiesced),
        "installed P2-1 Wasm host did not quiesce"
    );
    ensure!(
        host.handle_frame(make_frame(&host, HostMessage::Dispose))
            .map_err(|error| anyhow!("disposing installed P2-1 Wasm host: {error:?}"))?
            == Some(HostResponse::Disposed)
            && host.state() == HostInstanceState::Disposed,
        "installed P2-1 Wasm host did not dispose"
    );

    let forbidden_identity = WasmHostIdentity::new(
        ScopeId::new("project.installed-smoke")?,
        PluginId::new("org.yulab.rho.phase2-wasi-probe")?,
        PackageDigest::from_inventory(&[(b"dist/plugin.wasm", P2_1_WASI_IMPORT_SMOKE_WASM)]),
        ActivationGeneration::new(1)?,
        HostInstanceId::generate(),
    );
    let wasi_error = WasmPluginHost::from_bytes(forbidden_identity, P2_1_WASI_IMPORT_SMOKE_WASM)
        .expect_err("installed P2-1 Wasm host accepted a WASI import");
    ensure!(
        wasi_error.code == HostProtocolErrorCode::ForbiddenImport,
        "installed P2-1 Wasm host rejected WASI with the wrong error"
    );

    let v2_host_instance = HostInstanceId::generate();
    let v2_identity = WasmHostIdentity::new(
        ScopeId::new("project.installed-smoke")?,
        PluginId::new("org.yulab.rho.phase2-v2-smoke")?,
        PackageDigest::from_inventory(&[(b"dist/plugin.wasm", P2_2_SMOKE_WASM)]),
        ActivationGeneration::new(2)?,
        v2_host_instance.clone(),
    );
    let mut v2_host = WasmPluginHost::from_bytes_with_call_id_source(
        v2_identity,
        P2_2_SMOKE_WASM,
        Arc::new(SmokeCallId),
    )
    .map_err(|error| anyhow!("creating installed P2-2 Wasm host: {error:?}"))?;
    ensure!(
        v2_host.guest_abi_version() == 2,
        "installed P2-2 ABI is not V2"
    );
    ensure!(
        v2_host
            .handle_frame(HostFrame {
                instance_id: v2_host_instance.clone(),
                message: HostMessage::Hello {
                    api_version: rho_extension_runtime::HOST_PROTOCOL_VERSION,
                },
            })
            .map_err(|error| anyhow!("negotiating installed P2-2 Wasm host: {error:?}"))?
            == Some(HostResponse::Ready {
                api_version: rho_extension_runtime::HOST_PROTOCOL_VERSION,
            }),
        "installed P2-2 Wasm host negotiation failed"
    );
    ensure!(
        v2_host
            .handle_frame(HostFrame {
                instance_id: v2_host_instance.clone(),
                message: HostMessage::Activate,
            })
            .map_err(|error| anyhow!("activating installed P2-2 Wasm host: {error:?}"))?
            == Some(HostResponse::Activated),
        "installed P2-2 Wasm host activation failed"
    );
    let v2_request = HostRequestId::new("request.installed-v2-smoke")?;
    let yielded = v2_host
        .begin_broker_call(v2_request.clone(), json!({"smoke": true}))
        .map_err(|error| anyhow!("yielding installed P2-2 broker call: {error:?}"))?;
    ensure!(
        matches!(yielded, GuestStep::BrokerRequest { .. })
            && !format!("{yielded:?}").contains("handle."),
        "installed P2-2 broker yield was not typed and redacted"
    );
    ensure!(
        matches!(
            v2_host
                .resume_broker_call(&v2_request, &json!({"ok": false}), 0)
                .map_err(|error| anyhow!("resuming installed P2-2 broker call: {error:?}"))?,
            GuestStep::Complete { .. }
        ),
        "installed P2-2 broker resume did not complete"
    );

    let now_millis = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0);
    let constraints = PermissionConstraints {
        paths: vec!["data/**/*.csv".to_string()],
        max_bytes: Some(1024),
        ..Default::default()
    };
    let mut grants = GrantStore::new();
    let handle = grants.grant(GrantRequest {
        durable_grant_id: "grant.installed-smoke".to_string(),
        normalized_project_root: "/tmp/rho-installed-smoke".to_string(),
        plugin_id: PluginId::new("org.yulab.rho.phase2-v2-smoke")?,
        plugin_version: PluginVersion::parse("1.0.0")?,
        runtime_kind: RuntimeKind::Wasm,
        host_instance_id: v2_host_instance,
        package_digest: PackageDigest::from_inventory(&[(b"dist/plugin.wasm", P2_2_SMOKE_WASM)]),
        project_id: ScopeId::new("project.installed-smoke")?,
        scope_id: ScopeId::new("project.installed-smoke")?,
        activation_generation: ActivationGeneration::new(2)?,
        permission: PermissionKind::ProjectFsRead,
        constraints_digest: constraints.digest()?,
        constraints,
        grant_source: GrantSource::Project,
        policy_revision: 1,
        workspace: None,
        expires_at_millis: now_millis + 60_000,
    })?;
    ensure!(
        handle.id.len() == "handle.".len() + 64 && !format!("{handle:?}").contains(&handle.id),
        "installed P2-2 handle is not 256-bit and redacted"
    );
    ensure!(
        grants.revoke_durable_grant("grant.installed-smoke")
            && !grants.has_live_durable_grant("grant.installed-smoke"),
        "installed P2-2 revoke did not remove live authority"
    );

    let normalized_project_root = normalize_project_root(project_root.to_string_lossy().as_ref());
    let package_digest = PackageDigest::from_inventory(&[(b"dist/plugin.wasm", P2_2_SMOKE_WASM)]);
    let persisted_constraints = PermissionConstraints {
        paths: vec!["data/**/*.csv".to_string()],
        max_bytes: Some(1024),
        ..Default::default()
    };
    let constraints_json = persisted_constraints.canonical_json()?;
    let constraints_digest = persisted_constraints.digest()?;
    let mut persisted = Store::open(store_path)?;
    PluginPermissionMutationService::new(&mut persisted).create_request(
        &normalized_project_root,
        &PluginPermissionRequestDraft {
            request_id: "request.installed-smoke".to_string(),
            project_root: normalized_project_root.clone(),
            plugin_id: "org.yulab.rho.phase2-v2-smoke".to_string(),
            plugin_version: "1.0.0".to_string(),
            package_digest: package_digest.to_string(),
            runtime_kind: "wasm".to_string(),
            permission: "project.fs.read".to_string(),
            constraints_json,
            constraints_digest,
            purpose_text: Some("Installed P2-2 smoke".to_string()),
            expected_project_revision: 1,
        },
    )?;
    let durable_grant_id = "grant.persisted-installed-smoke";
    let decision = PluginPermissionMutationService::new(&mut persisted).resolve_request(
        &normalized_project_root,
        &PluginPermissionDecisionDraft {
            request_id: "request.installed-smoke".to_string(),
            project_root: normalized_project_root.clone(),
            expected_project_revision: 1,
            decision: PluginPermissionDecision::AllowOnce,
            reason_code: None,
            grant_id: Some(durable_grant_id.to_string()),
            policy_revision: Some(1),
            expires_at: Some((chrono::Utc::now() + chrono::Duration::minutes(4)).to_rfc3339()),
        },
    )?;
    ensure!(
        decision == PluginPermissionMutationOutcome::Applied,
        "installed P2-2 durable grant decision was not applied"
    );
    ensure!(
        PluginPermissionMutationService::new(&mut persisted).revoke_grant(
            &normalized_project_root,
            durable_grant_id,
            "installed_smoke_revoke",
        )? == PluginPermissionMutationOutcome::Applied,
        "installed P2-2 durable revoke was not applied"
    );
    let persisted_events = PluginPermissionQueryService::new(&persisted)
        .list_events(&normalized_project_root, Some(20))?;
    ensure!(
        persisted_events
            .iter()
            .any(|event| event.event_type == "request_granted")
            && persisted_events
                .iter()
                .any(|event| event.event_type == "grant_revoked"),
        "installed P2-2 durable audit events are incomplete"
    );
    ensure!(
        !serde_json::to_string(&persisted_events)?.contains("handle."),
        "installed P2-2 durable audit exposed a raw handle"
    );

    let empty_schema = json!({"type": "object", "properties": {}});
    let manifest = WorkspacePluginManifest::parse(&serde_json::to_vec(&json!({
        "schemaVersion": 2,
        "id": "org.yulab.rho.phase2-contribution-smoke",
        "name": "Installed contribution smoke",
        "version": "1.0.0",
        "apiVersion": "^1.0",
        "runtime": {"kind": "wasm", "entry": "dist/plugin.wasm", "scope": "project"},
        "provides": [
            {"capability": "tool.installed.smoke", "contract_major": 1},
            {"capability": "ui.panel.installed_smoke", "contract_major": 1}
        ],
        "contributions": [
            {
                "id": "tool.installed.smoke", "kind": "tool", "contractMajor": 1,
                "label": "Installed smoke", "purpose": "Exercise the packaged contribution proxy",
                "inputSchema": empty_schema,
                "outputSchema": {
                    "type": "object",
                    "properties": {"smoke": {"type": "boolean"}},
                    "required": ["smoke"]
                }
            },
            {
                "id": "ui.panel.installed_smoke", "kind": "panel", "contractMajor": 1,
                "label": "Installed details", "purpose": "Exercise the named project Panel",
                "inputSchema": empty_schema, "outputSchema": empty_schema,
                "panelSlot": "plugin_details"
            }
        ]
    }))?)?;
    let p23_project = ScopeId::new("project.installed-contribution-smoke")?;
    let p23_plugin = manifest.id.clone();
    let p23_digest = PackageDigest::from_inventory(&[(b"dist/plugin.wasm", P2_2_SMOKE_WASM)]);
    let p23_host_id = HostInstanceId::new("instance.installed-contribution-smoke")?;
    let p23_generation = ActivationGeneration::new(3)?;
    let p23_identity = ContributionInstanceIdentity::new(
        p23_project.clone(),
        p23_plugin.clone(),
        p23_digest.clone(),
        p23_generation,
        p23_host_id.clone(),
    );
    let candidate = ContributionStore::stage(p23_identity.clone(), manifest.contributions.clone())
        .map_err(|error| anyhow!("staging installed P2-3 contributions: {error:?}"))?;
    let mut contribution_store = ContributionStore::new();
    contribution_store
        .publish(candidate, None)
        .map_err(|error| anyhow!("publishing installed P2-3 contributions: {error:?}"))?;
    ensure!(
        contribution_store.list(&p23_project).len() == 2,
        "installed P2-3 contribution publication is incomplete"
    );
    let stale_candidate = ContributionStore::stage(
        ContributionInstanceIdentity::new(
            p23_project.clone(),
            p23_plugin.clone(),
            p23_digest.clone(),
            ActivationGeneration::new(4)?,
            HostInstanceId::new("instance.installed-stale-candidate")?,
        ),
        manifest.contributions.clone(),
    )
    .map_err(|error| anyhow!("staging installed stale P2-3 candidate: {error:?}"))?;
    ensure!(
        contribution_store.publish(stale_candidate, None)
            == Err(ContributionError::ExpectedOldMismatch),
        "installed P2-3 expected-old CAS accepted a stale candidate"
    );
    let mut p23_host = WasmPluginHost::from_bytes_with_call_id_source(
        WasmHostIdentity::new(
            p23_project.clone(),
            p23_plugin,
            p23_digest,
            p23_generation,
            p23_host_id.clone(),
        ),
        P2_2_SMOKE_WASM,
        Arc::new(SmokeCallId),
    )
    .map_err(|error| anyhow!("creating installed P2-3 Wasm host: {error:?}"))?;
    ensure!(
        matches!(
            p23_host.handle_frame(HostFrame {
                instance_id: p23_host_id.clone(),
                message: HostMessage::Hello {
                    api_version: rho_extension_runtime::HOST_PROTOCOL_VERSION
                }
            }),
            Ok(Some(HostResponse::Ready { .. }))
        ) && matches!(
            p23_host.handle_frame(HostFrame {
                instance_id: p23_host_id,
                message: HostMessage::Activate
            }),
            Ok(Some(HostResponse::Activated))
        ),
        "installed P2-3 contribution host did not activate"
    );
    let (mut p23_call, p23_first) = ContributionCallSession::begin(
        &contribution_store,
        ContributionCallRequest {
            project_id: p23_project.clone(),
            contribution_id: CapabilityId::new("tool.installed.smoke")?,
            origin: ContributionInvocationOrigin::AgentTool,
            input: json!({}),
            supplied_handles: BTreeMap::from([(
                "project.fs.read".to_string(),
                format!("handle.{}", "a".repeat(64)),
            )]),
        },
        &SmokeClock,
        &mut p23_host,
    )
    .map_err(|error| anyhow!("beginning installed P2-3 contribution call: {error:?}"))?;
    ensure!(
        matches!(p23_first, GuestStep::BrokerRequest { .. }),
        "installed P2-3 contribution did not yield to the broker"
    );
    let p23_terminal = p23_call
        .resume(
            &contribution_store,
            &json!({"ok": true}),
            2,
            &SmokeClock,
            &mut p23_host,
        )
        .map_err(|error| anyhow!("resuming installed P2-3 contribution call: {error:?}"))?;
    let p23_outcome = p23_call
        .finish(
            &contribution_store,
            &p23_terminal,
            &SmokeClock,
            &mut p23_host,
        )
        .map_err(|error| anyhow!("finishing installed P2-3 contribution call: {error:?}"))?;
    ensure!(
        matches!(
            p23_outcome,
            ContributionCallOutcome::Completed { ref result, .. }
                if result == &json!({"smoke": true})
        ),
        "installed P2-3 contribution result failed schema validation"
    );
    let viewer_document = ViewerDocumentV1::parse(json!({
        "contract": rho_extension_runtime::PLUGIN_VIEWER_DOCUMENT_CONTRACT,
        "title": "Installed plugin details",
        "blocks": [{
            "kind": "text",
            "text": "<script>packaged text only</script>"
        }]
    }))?;
    ensure!(
        viewer_document.blocks.len() == 1,
        "installed P2-3 ViewerDocument did not validate"
    );
    contribution_store
        .unpublish(&p23_identity)
        .map_err(|error| anyhow!("tearing down installed P2-3 contributions: {error:?}"))?;
    ensure!(
        contribution_store.list(&p23_project).is_empty(),
        "installed P2-3 contribution teardown left a live route"
    );

    let p24_root = tempfile::tempdir()?;
    let p24_project = p24_root.path().join("project");
    let p24_data = p24_root.path().join("data");
    let p24_plugin = p24_project.join(".rho/plugins/installed-smoke");
    std::fs::create_dir_all(p24_plugin.join("dist"))?;
    std::fs::create_dir_all(&p24_data)?;
    std::fs::write(p24_plugin.join("dist/plugin.wasm"), P2_1_SMOKE_WASM)?;
    std::fs::write(
        p24_plugin.join("rho-plugin.json"),
        serde_json::to_vec(&json!({
            "schemaVersion": 1,
            "id": "org.yulab.rho.phase2-durable-enable-smoke",
            "name": "Durable enable smoke",
            "version": "1.0.0",
            "apiVersion": "^1.0",
            "runtime": {"kind": "wasm", "entry": "dist/plugin.wasm", "scope": "project"}
        }))?,
    )?;
    let p24_project_root =
        normalize_project_root(p24_project.canonicalize()?.to_string_lossy().as_ref());
    let p24_context = crate::workspace_plugins::PluginRuntimeContext {
        app_data_dir: p24_data.clone(),
        project_root: p24_project_root.clone(),
        project_revision: 1,
        project_scope_id: ScopeId::new("project.installed-durable-enable-smoke")?,
        workspace: None,
    };
    let mut p24_store = Store::open(p24_root.path().join("rho.sqlite"))?;
    let p24_registry = crate::workspace_plugins::PendingPluginPermissionRegistry::default();
    let p24_enabled = p24_registry.request_enable(
        &p24_context,
        "org.yulab.rho.phase2-durable-enable-smoke",
        &mut p24_store,
    )?;
    ensure!(
        p24_enabled.status == "enabled" && p24_enabled.transition_id.is_some(),
        "installed P2-4 durable first enable did not complete"
    );
    let p24_state = PluginLifecycleQueryService::new(&p24_store)
        .get_state(
            &p24_project_root,
            "org.yulab.rho.phase2-durable-enable-smoke",
        )?
        .context("installed P2-4 lifecycle state is missing")?;
    ensure!(
        p24_state.desired_state == "enabled"
            && p24_state.observed_state == "active"
            && p24_state.accepted_digest.is_some()
            && p24_state.pending_digest.is_none()
            && p24_state.last_activation_generation == 1,
        "installed P2-4 durable lifecycle truth is incomplete"
    );
    let p24_transition = PluginLifecycleQueryService::new(&p24_store)
        .get_transition(
            &p24_project_root,
            p24_enabled.transition_id.as_deref().unwrap_or_default(),
        )?
        .context("installed P2-4 lifecycle transition is missing")?;
    ensure!(
        p24_transition.phase == "completed" && p24_transition.status == "completed",
        "installed P2-4 transition did not reach durable completion"
    );
    let p24_cached = rho_server::plugin_package_cache::PluginPackageCache::new(&p24_data)
        .load_exact(
            &p24_project_root,
            "org.yulab.rho.phase2-durable-enable-smoke",
            p24_state.accepted_digest.as_deref().unwrap_or_default(),
        )?;
    ensure!(
        p24_cached.file_bytes("dist/plugin.wasm") == Some(P2_1_SMOKE_WASM),
        "installed P2-4 immutable cache read-back diverged"
    );
    drop(p24_registry);
    let p24_restarted = crate::workspace_plugins::PendingPluginPermissionRegistry::default();
    let p24_restart_report = p24_restarted.reconcile_project(&p24_context, &mut p24_store);
    ensure!(
        p24_restart_report.reactivated == 1,
        "installed P2-4 restart did not reconstruct the exact enabled package"
    );
    let p24_restarted_state = PluginLifecycleQueryService::new(&p24_store)
        .get_state(
            &p24_project_root,
            "org.yulab.rho.phase2-durable-enable-smoke",
        )?
        .context("installed P2-4 restarted lifecycle state is missing")?;
    ensure!(
        p24_restarted_state.observed_state == "active"
            && p24_restarted_state.last_activation_generation == 2,
        "installed P2-4 restart reused or lost activation generation"
    );
    let p24_disabled = p24_restarted.disable(
        &p24_context,
        "org.yulab.rho.phase2-durable-enable-smoke",
        &mut p24_store,
    )?;
    ensure!(
        p24_disabled.status == "disabled"
            && p24_disabled.route_closed
            && p24_disabled.host_disposed
            && p24_disabled.errors.is_empty(),
        "installed P2-4 explicit Disable did not complete exact teardown"
    );
    let p24_disabled_state = PluginLifecycleQueryService::new(&p24_store)
        .get_state(
            &p24_project_root,
            "org.yulab.rho.phase2-durable-enable-smoke",
        )?
        .context("installed P2-4 disabled lifecycle state is missing")?;
    ensure!(
        p24_disabled_state.desired_state == "disabled"
            && p24_disabled_state.observed_state == "disabled",
        "installed P2-4 explicit Disable did not persist terminal truth"
    );
    let p24_reenabled = p24_restarted.request_enable(
        &p24_context,
        "org.yulab.rho.phase2-durable-enable-smoke",
        &mut p24_store,
    )?;
    ensure!(
        p24_reenabled.status == "enabled",
        "installed P2-4 exact package could not re-enable after Disable"
    );
    let p24_boundary = p24_restarted.teardown_project(&p24_context, "shutdown", &mut p24_store);
    ensure!(
        p24_boundary.attempted == 1 && p24_boundary.completed == 1 && p24_boundary.forced == 0,
        "installed P2-4 shutdown boundary did not reuse exact teardown"
    );
    let p24_stopped_state = PluginLifecycleQueryService::new(&p24_store)
        .get_state(
            &p24_project_root,
            "org.yulab.rho.phase2-durable-enable-smoke",
        )?
        .context("installed P2-4 stopped lifecycle state is missing")?;
    ensure!(
        p24_stopped_state.desired_state == "enabled"
            && p24_stopped_state.observed_state == "stopped",
        "installed P2-4 boundary teardown lost enabled intent or stopped truth"
    );
    let p24_boundary_reactivation = p24_restarted.reconcile_project(&p24_context, &mut p24_store);
    ensure!(
        p24_boundary_reactivation.reactivated == 1,
        "installed P2-4 stopped boundary did not reconstruct exactly"
    );
    for expected_crash_count in 1..=3 {
        let crash = p24_restarted.quarantine_timed_out_plugin(
            &p24_context,
            "org.yulab.rho.phase2-durable-enable-smoke",
            &mut p24_store,
        )?;
        ensure!(
            crash.crash_count == expected_crash_count
                && crash.blocked == (expected_crash_count == 3),
            "installed P2-4 crash loop count/block state diverged"
        );
        if expected_crash_count < 3 {
            ensure!(
                p24_restarted
                    .retry(
                        &p24_context,
                        "org.yulab.rho.phase2-durable-enable-smoke",
                        &mut p24_store,
                    )?
                    .status
                    == "enabled",
                "installed P2-4 Retry did not create fresh authority"
            );
        }
    }
    ensure!(
        p24_restarted
            .retry(
                &p24_context,
                "org.yulab.rho.phase2-durable-enable-smoke",
                &mut p24_store,
            )
            .is_err(),
        "installed P2-4 blocked crash loop accepted Retry"
    );
    ensure!(
        p24_restarted
            .disable(
                &p24_context,
                "org.yulab.rho.phase2-durable-enable-smoke",
                &mut p24_store,
            )?
            .status
            == "disabled",
        "installed P2-4 blocked plugin could not be explicitly disabled"
    );
    ensure!(
        p24_restarted
            .request_enable(
                &p24_context,
                "org.yulab.rho.phase2-durable-enable-smoke",
                &mut p24_store,
            )?
            .status
            == "enabled",
        "installed P2-4 reviewed crash loop could not re-enable exactly"
    );
    let p24_uninstall_state = PluginLifecycleQueryService::new(&p24_store)
        .get_state(
            &p24_project_root,
            "org.yulab.rho.phase2-durable-enable-smoke",
        )?
        .context("installed P2-4 Uninstall state is missing")?;
    let p24_uninstalled = p24_restarted.uninstall(
        &p24_context,
        &crate::workspace_plugins::WorkspacePluginUninstallInput {
            plugin_id: "org.yulab.rho.phase2-durable-enable-smoke".to_string(),
            directory_name: "installed-smoke".to_string(),
            package_digest: p24_uninstall_state
                .accepted_digest
                .clone()
                .context("installed P2-4 Uninstall accepted digest is missing")?,
            expected_project_revision: p24_context.project_revision,
            confirmed: true,
        },
        &mut p24_store,
    )?;
    let p24_uninstalled_state = PluginLifecycleQueryService::new(&p24_store)
        .get_state(
            &p24_project_root,
            "org.yulab.rho.phase2-durable-enable-smoke",
        )?
        .context("installed P2-4 durable Uninstalled state is missing")?;
    let p24_tombstone = PluginLifecycleQueryService::new(&p24_store)
        .get_tombstone(&p24_project_root, &p24_uninstalled.tombstone_id)?
        .context("installed P2-4 recoverable tombstone is missing")?;
    ensure!(
        p24_uninstalled.status == "uninstalled"
            && p24_uninstalled.route_closed
            && p24_uninstalled_state.desired_state == "uninstalled"
            && p24_uninstalled_state.observed_state == "uninstalled"
            && !p24_plugin.exists()
            && p24_tombstone.restored_at.is_none(),
        "installed P2-4 recoverable Uninstall truth diverged"
    );
    let p24_restored = p24_restarted.restore(
        &p24_context,
        &crate::workspace_plugins::WorkspacePluginRestoreInput {
            tombstone_id: p24_uninstalled.tombstone_id.clone(),
            expected_project_revision: p24_context.project_revision,
        },
        &mut p24_store,
    )?;
    let p24_restored_state = PluginLifecycleQueryService::new(&p24_store)
        .get_state(
            &p24_project_root,
            "org.yulab.rho.phase2-durable-enable-smoke",
        )?
        .context("installed P2-4 restored lifecycle state is missing")?;
    ensure!(
        p24_restored.status == "disabled"
            && p24_plugin.is_dir()
            && p24_restored_state.desired_state == "disabled"
            && p24_restored_state.observed_state == "disabled"
            && p24_restored_state.last_host_session_id.is_none()
            && PluginPermissionQueryService::new(&p24_store)
                .list_grants(&p24_project_root, Some(100), Some("active"))?
                .is_empty(),
        "installed P2-4 Restore created authority or non-disabled truth"
    );
    ensure!(
        p24_restarted
            .request_enable(
                &p24_context,
                "org.yulab.rho.phase2-durable-enable-smoke",
                &mut p24_store,
            )?
            .status
            == "enabled",
        "installed P2-4 restored package could not be explicitly re-enabled"
    );
    p24_restarted.invalidate_project(&p24_project_root);
    let p24_manifest_path = p24_plugin.join("rho-plugin.json");
    let p24_original_manifest = std::fs::read(&p24_manifest_path)?;
    let mut p24_changed_manifest: Value = serde_json::from_slice(&p24_original_manifest)?;
    p24_changed_manifest["version"] = json!("2.0.0");
    std::fs::write(
        &p24_manifest_path,
        serde_json::to_vec(&p24_changed_manifest)?,
    )?;
    let p24_changed_report = p24_restarted.reconcile_project(&p24_context, &mut p24_store);
    ensure!(
        p24_changed_report.update_pending == 1,
        "installed P2-4 changed package did not remain update-pending"
    );
    let p24_changed_list = p24_restarted.list(&p24_context, &mut p24_store)?;
    ensure!(
        p24_changed_list
            .plugins
            .iter()
            .any(|plugin| plugin.status == "update_pending"),
        "installed P2-4 trusted projection hid update-pending state"
    );
    let p24_update_project = p24_root.path().join("update-project");
    let p24_update_plugin = p24_update_project.join(".rho/plugins/update-smoke");
    std::fs::create_dir_all(p24_update_plugin.join("dist"))?;
    std::fs::write(p24_update_plugin.join("dist/plugin.wasm"), P2_1_SMOKE_WASM)?;
    let p24_update_manifest = p24_update_plugin.join("rho-plugin.json");
    std::fs::write(
        &p24_update_manifest,
        serde_json::to_vec(&json!({
            "schemaVersion": 1,
            "id": "org.yulab.rho.phase2-update-smoke",
            "name": "Update smoke",
            "version": "1.0.0",
            "apiVersion": "^1.0",
            "runtime": {"kind": "wasm", "entry": "dist/plugin.wasm", "scope": "project"}
        }))?,
    )?;
    let p24_update_root = normalize_project_root(
        p24_update_project
            .canonicalize()?
            .to_string_lossy()
            .as_ref(),
    );
    let p24_update_context = crate::workspace_plugins::PluginRuntimeContext {
        app_data_dir: p24_data.clone(),
        project_root: p24_update_root.clone(),
        project_revision: 1,
        project_scope_id: ScopeId::new("project.installed-update-smoke")?,
        workspace: None,
    };
    let p24_update_registry = crate::workspace_plugins::PendingPluginPermissionRegistry::default();
    ensure!(
        p24_update_registry
            .request_enable(
                &p24_update_context,
                "org.yulab.rho.phase2-update-smoke",
                &mut p24_store,
            )?
            .status
            == "enabled",
        "installed P2-4 Update fixture did not enable"
    );
    let p24_update_old = PluginLifecycleQueryService::new(&p24_store)
        .get_state(&p24_update_root, "org.yulab.rho.phase2-update-smoke")?
        .context("installed P2-4 Update old state is missing")?;
    let p24_update_old_digest = p24_update_old
        .accepted_digest
        .clone()
        .context("installed P2-4 Update old digest is missing")?;
    let mut p24_update_changed: Value =
        serde_json::from_slice(&std::fs::read(&p24_update_manifest)?)?;
    p24_update_changed["version"] = json!("2.0.0");
    std::fs::write(
        &p24_update_manifest,
        serde_json::to_vec(&p24_update_changed)?,
    )?;
    let p24_update_candidate =
        rho_extension_runtime::discover_workspace_plugins(&p24_update_project)?
            .context("installed P2-4 Update candidate discovery is missing")?
            .plugins
            .into_iter()
            .find(|plugin| plugin.manifest.id.as_str() == "org.yulab.rho.phase2-update-smoke")
            .context("installed P2-4 Update candidate is missing")?;
    let p24_updated = p24_update_registry.request_update(
        &p24_update_context,
        &crate::workspace_plugins::WorkspacePluginUpdateInput {
            plugin_id: "org.yulab.rho.phase2-update-smoke".to_string(),
            expected_old_digest: p24_update_old_digest.clone(),
            candidate_digest: p24_update_candidate.digest.to_string(),
            expected_project_revision: p24_update_context.project_revision,
        },
        &mut p24_store,
    )?;
    let p24_updated_state = PluginLifecycleQueryService::new(&p24_store)
        .get_state(&p24_update_root, "org.yulab.rho.phase2-update-smoke")?
        .context("installed P2-4 Update terminal state is missing")?;
    ensure!(
        p24_updated.status == "enabled"
            && p24_updated_state.accepted_digest.as_deref()
                == Some(p24_update_candidate.digest.as_str())
            && p24_updated_state.rollback_digest.as_deref() == Some(p24_update_old_digest.as_str())
            && p24_updated_state.pending_digest.is_none()
            && p24_updated_state.last_activation_generation
                > p24_update_old.last_activation_generation
            && p24_updated_state.last_host_session_id != p24_update_old.last_host_session_id,
        "installed P2-4 exact Update did not commit fresh pointer/runtime truth"
    );
    let p24_rolled_back = p24_update_registry.request_rollback(
        &p24_update_context,
        &crate::workspace_plugins::WorkspacePluginRollbackInput {
            plugin_id: "org.yulab.rho.phase2-update-smoke".to_string(),
            expected_current_digest: p24_update_candidate.digest.to_string(),
            rollback_digest: p24_update_old_digest.clone(),
            expected_project_revision: p24_update_context.project_revision,
        },
        &mut p24_store,
    )?;
    let p24_rollback_state = PluginLifecycleQueryService::new(&p24_store)
        .get_state(&p24_update_root, "org.yulab.rho.phase2-update-smoke")?
        .context("installed P2-4 Rollback terminal state is missing")?;
    ensure!(
        p24_rolled_back.status == "enabled"
            && p24_rollback_state.accepted_digest.as_deref()
                == Some(p24_update_old_digest.as_str())
            && p24_rollback_state.rollback_digest.as_deref()
                == Some(p24_update_candidate.digest.as_str())
            && p24_rollback_state.last_activation_generation
                > p24_updated_state.last_activation_generation
            && p24_rollback_state.last_host_session_id != p24_updated_state.last_host_session_id
            && rho_extension_runtime::discover_workspace_plugins(&p24_update_project)?
                .context("installed Rollback source discovery disappeared")?
                .plugins
                .iter()
                .any(|plugin| plugin.digest == p24_update_candidate.digest),
        "installed P2-4 exact Rollback did not preserve source or fresh pointer truth"
    );
    p24_update_registry.invalidate_project(&p24_update_root);
    let p24_rollback_restart = crate::workspace_plugins::PendingPluginPermissionRegistry::default();
    let p24_rollback_restart_report =
        p24_rollback_restart.reconcile_project(&p24_update_context, &mut p24_store);
    ensure!(
        p24_rollback_restart_report.reactivated == 1,
        "installed P2-4 Rollback restart did not reconstruct accepted cache"
    );
    let p24_rollback_restart_state = PluginLifecycleQueryService::new(&p24_store)
        .get_state(&p24_update_root, "org.yulab.rho.phase2-update-smoke")?
        .context("installed P2-4 Rollback restart state is missing")?;
    ensure!(
        p24_rollback_restart_state.accepted_digest.as_deref()
            == Some(p24_update_old_digest.as_str())
            && p24_rollback_restart_state.rollback_digest.as_deref()
                == Some(p24_update_candidate.digest.as_str())
            && p24_rollback_restart_state.last_activation_generation
                > p24_rollback_state.last_activation_generation
            && p24_rollback_restart
                .list(&p24_update_context, &mut p24_store)?
                .plugins
                .iter()
                .any(|plugin| plugin.status == "update_pending"),
        "installed P2-4 Rollback restart lost accepted cache or Update-pending source truth"
    );
    let p24_recovery_project = p24_root.path().join("recovery-project");
    let p24_recovery_plugin = p24_recovery_project.join(".rho/plugins/recovery-smoke");
    std::fs::create_dir_all(p24_recovery_plugin.join("dist"))?;
    std::fs::write(
        p24_recovery_plugin.join("dist/plugin.wasm"),
        P2_1_SMOKE_WASM,
    )?;
    std::fs::write(
        p24_recovery_plugin.join("rho-plugin.json"),
        serde_json::to_vec(&json!({
            "schemaVersion": 1,
            "id": "org.yulab.rho.phase2-recovery-smoke",
            "name": "Recovery smoke",
            "version": "1.0.0",
            "apiVersion": "^1.0",
            "runtime": {"kind": "wasm", "entry": "dist/plugin.wasm", "scope": "project"}
        }))?,
    )?;
    let p24_recovery_root = normalize_project_root(
        p24_recovery_project
            .canonicalize()?
            .to_string_lossy()
            .as_ref(),
    );
    let p24_recovery_context = crate::workspace_plugins::PluginRuntimeContext {
        app_data_dir: p24_data.clone(),
        project_root: p24_recovery_root.clone(),
        project_revision: 0,
        project_scope_id: ScopeId::new("project.installed-recovery-smoke")?,
        workspace: None,
    };
    let p24_recovery_registry =
        crate::workspace_plugins::PendingPluginPermissionRegistry::default();
    p24_recovery_registry.request_enable(
        &p24_recovery_context,
        "org.yulab.rho.phase2-recovery-smoke",
        &mut p24_store,
    )?;
    p24_recovery_registry.disable(
        &p24_recovery_context,
        "org.yulab.rho.phase2-recovery-smoke",
        &mut p24_store,
    )?;
    let p24_recovery_state = PluginLifecycleQueryService::new(&p24_store)
        .get_state(&p24_recovery_root, "org.yulab.rho.phase2-recovery-smoke")?
        .context("installed P2-4 recovery state is missing")?;
    PluginLifecycleMutationService::new(&mut p24_store).request_transition(
        &p24_recovery_root,
        &rho_store::WorkspacePluginTransitionDraft {
            transition_id: "transition.uninstall.installed-recovery".to_string(),
            project_root: p24_recovery_root.clone(),
            plugin_id: "org.yulab.rho.phase2-recovery-smoke".to_string(),
            kind: "uninstall".to_string(),
            request_event_type: "user_requested".to_string(),
            desired_state: "uninstalled".to_string(),
            expected_old_digest: p24_recovery_state.accepted_digest,
            candidate_digest: None,
            rollback_digest: None,
            backup_path_key: Some("trash.installed-recovery".to_string()),
        },
    )?;
    let first_recovery =
        p24_recovery_registry.reconcile_project(&p24_recovery_context, &mut p24_store);
    let mut recovery_revision = BrokerState::new("plugin_recovery_smoke");
    if first_recovery.project_files_changed {
        recovery_revision.project_changed();
    }
    let second_recovery =
        p24_recovery_registry.reconcile_project(&p24_recovery_context, &mut p24_store);
    if second_recovery.project_files_changed {
        recovery_revision.project_changed();
    }
    ensure!(
        first_recovery.recovered_uninstalls == 1
            && first_recovery.project_files_changed
            && second_recovery.recovered_uninstalls == 0
            && !second_recovery.project_files_changed
            && recovery_revision.identity().project_revision == 1
            && !p24_recovery_plugin.exists(),
        "installed P2-4 Uninstall recovery or once-only revision diverged"
    );
    let p24_retention_project = p24_root.path().join("retention-project");
    let p24_retention_plugin = p24_retention_project.join(".rho/plugins/retention-smoke");
    std::fs::create_dir_all(p24_retention_plugin.join("dist"))?;
    std::fs::write(
        p24_retention_plugin.join("dist/plugin.wasm"),
        P2_1_SMOKE_WASM,
    )?;
    std::fs::write(
        p24_retention_plugin.join("rho-plugin.json"),
        serde_json::to_vec(&json!({
            "schemaVersion": 1,
            "id": "org.yulab.rho.phase2-retention-smoke",
            "name": "Retention smoke",
            "version": "1.0.0",
            "apiVersion": "^1.0",
            "runtime": {"kind": "wasm", "entry": "dist/plugin.wasm", "scope": "project"}
        }))?,
    )?;
    let p24_retention_root = normalize_project_root(
        p24_retention_project
            .canonicalize()?
            .to_string_lossy()
            .as_ref(),
    );
    let p24_retention_context = crate::workspace_plugins::PluginRuntimeContext {
        app_data_dir: p24_data.clone(),
        project_root: p24_retention_root.clone(),
        project_revision: 1,
        project_scope_id: ScopeId::new("project.installed-retention-smoke")?,
        workspace: None,
    };
    let p24_retention_registry =
        crate::workspace_plugins::PendingPluginPermissionRegistry::default();
    ensure!(
        p24_retention_registry
            .request_enable(
                &p24_retention_context,
                "org.yulab.rho.phase2-retention-smoke",
                &mut p24_store,
            )?
            .status
            == "enabled",
        "installed P2-4 retention fixture did not enable"
    );
    let p24_retention_state = PluginLifecycleQueryService::new(&p24_store)
        .get_state(&p24_retention_root, "org.yulab.rho.phase2-retention-smoke")?
        .context("installed P2-4 retention lifecycle state is missing")?;
    let p24_retention_uninstall = p24_retention_registry.uninstall(
        &p24_retention_context,
        &crate::workspace_plugins::WorkspacePluginUninstallInput {
            plugin_id: "org.yulab.rho.phase2-retention-smoke".to_string(),
            directory_name: "retention-smoke".to_string(),
            package_digest: p24_retention_state
                .accepted_digest
                .clone()
                .context("installed P2-4 retention accepted digest is missing")?,
            expected_project_revision: p24_retention_context.project_revision,
            confirmed: true,
        },
        &mut p24_store,
    )?;
    let p24_retention_tombstone = PluginLifecycleQueryService::new(&p24_store)
        .get_tombstone(&p24_retention_root, &p24_retention_uninstall.tombstone_id)?
        .context("installed P2-4 retention tombstone is missing")?;
    let p24_sibling = p24_root.path().join("sibling-project/.rho/plugins/keep");
    std::fs::create_dir_all(&p24_sibling)?;
    std::fs::write(p24_sibling.join("sentinel.txt"), b"keep")?;
    let retention_service = rho_server::plugin_retention::PluginTrashRetentionService::new();
    let expired = retention_service.expire(
        &mut p24_store,
        &p24_retention_root,
        &p24_retention_tombstone.moved_at,
        1,
    )?;
    ensure!(
        expired.expired.len() == 1 && expired.expired[0].retention_class == "expired",
        "installed P2-4 retention expiry did not select the exact tombstone"
    );
    let p24_purge_draft = rho_store::WorkspacePluginPurgeDraft {
        project_root: p24_retention_root.clone(),
        tombstone_id: p24_retention_tombstone.tombstone_id.clone(),
        plugin_id: p24_retention_tombstone.plugin_id.clone(),
        package_digest: p24_retention_tombstone.package_digest.clone(),
        backup_path_key: p24_retention_tombstone.backup_path_key.clone(),
        original_directory_name: p24_retention_tombstone.original_directory_name.clone(),
    };
    ensure!(
        PluginLifecycleMutationService::new(&mut p24_store)
            .request_purge(&p24_retention_root, &p24_purge_draft)?
            .tombstone
            .retention_class
            == "purge_pending",
        "installed P2-4 purge-pending truth was not durable before deletion"
    );
    let p24_purge_recovery =
        p24_retention_registry.reconcile_project(&p24_retention_context, &mut p24_store);
    let p24_purged = PluginLifecycleQueryService::new(&p24_store)
        .get_tombstone(&p24_retention_root, &p24_retention_tombstone.tombstone_id)?
        .context("installed P2-4 recovered purge tombstone is missing")?;
    ensure!(
        p24_purge_recovery.recovered_purges == 1
            && p24_purge_recovery.project_files_changed
            && p24_purged.deleted_at.is_some()
            && p24_purged.retention_class == "expired"
            && !p24_retention_plugin.exists()
            && p24_sibling.join("sentinel.txt").is_file(),
        "installed P2-4 exact purge damaged sibling truth or missed terminal tombstone"
    );
    let p24_purge_replay = retention_service.purge_exact_tombstone(
        &mut p24_store,
        &p24_retention_root,
        &p24_retention_tombstone.tombstone_id,
    )?;
    ensure!(
        p24_purge_replay.file_outcome
            == rho_server::plugin_package_trash::PluginPackageOwnershipOutcome::AlreadyPurged,
        "installed P2-4 exact purge replay was not idempotent"
    );

    let mut report = json!({
        "runtime": "wasmtime-38.0.4",
        "guest_abi": 1,
        "guest_echo": true,
        "heartbeat": true,
        "disposed": true,
        "wasi_rejected": true,
        "imports_exposed": 0,
        "guest_abi_v2": 2,
        "broker_yield_resume": true,
        "grant_handle_bits": 256,
        "raw_handle_redacted": true,
        "revoke_enforced": true,
        "durable_permission_lane": true,
        "durable_raw_handle_absent": true,
        "manifest_v2": 2,
        "contribution_publish_cas": true,
        "contribution_call_proxy": true,
        "viewer_document_v1": true,
        "panel_slot": "plugin_details",
        "contribution_teardown": true,
        "schema_v14_lifecycle": true,
        "exact_package_cache": true,
        "durable_first_enable": true,
        "durable_activation_generation": 1,
        "durable_completion_after_routing": true,
        "restart_reactivated": true,
        "restart_generation": 2,
        "restart_authority_fresh": true,
        "changed_package_update_pending": true,
        "explicit_disable": true,
        "disable_route_closed": true,
        "disable_host_disposed": true,
        "disable_terminal_durable": true,
        "boundary_teardown_reused": true,
        "boundary_enabled_intent_preserved": true,
        "boundary_reactivated": true,
        "crash_state_durable": true,
        "heartbeat_timeout_classified": true,
        "retry_fresh_authority": true,
        "third_crash_blocked": true,
    });
    report["recoverable_uninstall"] = json!(true);
    report["uninstall_tombstone_atomic"] = json!(true);
    report["uninstall_package_in_trash"] = json!(true);
    report["restore_disabled_no_authority"] = json!(true);
    report["retention_expired"] = json!(true);
    report["purge_pending_durable"] = json!(true);
    report["exact_trash_purged"] = json!(true);
    report["purge_tombstone_terminal"] = json!(true);
    report["purge_sibling_project_preserved"] = json!(true);
    report["purge_replay_idempotent"] = json!(true);
    report["update_local_candidate_only"] = json!(true);
    report["update_expected_old_cas"] = json!(true);
    report["update_pointer_durable"] = json!(true);
    report["update_generation_fresh"] = json!(true);
    report["rollback_exact_cache_only"] = json!(true);
    report["rollback_fresh_authority"] = json!(true);
    report["rollback_pointer_reversed"] = json!(true);
    report["rollback_source_unchanged"] = json!(true);
    report["rollback_restart_cached"] = json!(true);
    report["recovery_purge_pending"] = json!(true);
    report["recovery_incomplete_uninstall"] = json!(true);
    report["recovery_project_revision_once"] = json!(true);
    Ok(report)
}

async fn smoke_extension_runtime(
    session: Arc<ArkSession>,
    context: Arc<WorkspaceBrokerLane>,
    store_path: &Path,
    project_root: &Path,
) -> Result<Value> {
    let diagnostics: Arc<dyn DiagnosticSink> = Arc::new(|_: ExtensionDiagnostic| {});
    let mode_value = match std::env::var("RHO_INTERNAL_EXTENSION_RUNTIME") {
        Ok(value) => Some(value),
        Err(std::env::VarError::NotPresent) => None,
        Err(std::env::VarError::NotUnicode(_)) => Some("invalid_non_unicode".to_string()),
    };
    let mode = InternalExtensionRuntimeMode::parse(mode_value.as_deref(), diagnostics.as_ref());
    let host_capabilities = vec![
        CapabilityDeclaration::new(runs_broker_capability_id(), 1),
        CapabilityDeclaration::new(workspace_probe_broker_capability_id(), 1),
    ];
    let canonical_project_root = project_root.canonicalize()?;
    std::fs::write(
        canonical_project_root.join("rho-extension-smoke.html"),
        "<!doctype html><title>Rho extension smoke</title>",
    )?;
    let direct_viewer = read_viewer_file(&canonical_project_root, "rho-extension-smoke.html")?;
    ensure!(
        direct_viewer.contract == "rho.viewer_file.v1" && direct_viewer.media_type == "text/html",
        "direct project file viewer smoke failed"
    );

    if mode == InternalExtensionRuntimeMode::Legacy {
        let host = ExtensionHost::new_with_host_capabilities(
            mode,
            host_capabilities,
            diagnostics,
            LifecycleDeadlines::default(),
        )?;
        ensure!(
            host.scopes()
                .application()
                .registry()
                .resolve_project_file_viewer(&project_file_viewer_capability_id())
                .is_err(),
            "legacy smoke unexpectedly activated the project file viewer plugin"
        );
        ensure!(
            host.scopes()
                .application()
                .registry()
                .resolve_application_surfaces()?
                .factories()
                .is_empty(),
            "legacy smoke unexpectedly activated an application Surface"
        );
        let shutdown = host.shutdown().await;
        ensure!(
            shutdown.outcome == DisposeOutcome::Disposed,
            "legacy extension host did not shut down cleanly"
        );
        return Ok(json!({
            "mode": "legacy",
            "candidate_exercised": false,
            "legacy_override_exercised": true,
            "direct_viewer": true,
            "clean_shutdown": true,
        }));
    }

    let host = Arc::new(
        ExtensionHost::new_with_application_plugins(
            mode,
            host_capabilities,
            internal_plugins_for_scope(&rho_extension_runtime::ScopePolicy::application_kind()),
            Arc::new(rho_extension_runtime::RejectingBrokerFacade),
            diagnostics,
            LifecycleDeadlines::default(),
        )
        .await?,
    );
    let application = host.scopes().application();
    let surfaces = application.registry().resolve_application_surfaces()?;
    ensure!(
        surfaces.factories().iter().any(|factory| {
            factory.definition.surface_id.as_str() == "rho.surface-playground"
                && factory.activation_generation == 1
        }),
        "candidate application Surface contribution is missing"
    );
    drop(surfaces);
    let viewer = application
        .registry()
        .resolve_project_file_viewer(&project_file_viewer_capability_id())?;
    ensure!(
        viewer
            .contribution()
            .supported_media_types()
            .iter()
            .any(|value| value == direct_viewer.media_type),
        "candidate viewer contribution omitted HTML"
    );
    drop(viewer);

    let normalized_project_root =
        normalize_project_root(canonical_project_root.to_string_lossy().as_ref());
    let run_repository = StoreExecutor::open(store_path).await?.run_repository();
    let project = host
        .build_project_candidate(
            extension_project_scope_id(&normalized_project_root)?,
            internal_plugins_for_scope(&rho_extension_runtime::ScopePolicy::project_kind()),
            Arc::new(RunHistoryBrokerFacade::new(
                run_repository,
                normalized_project_root.clone(),
            )),
        )
        .await?;
    host.publish_project_candidate(None, project.clone())
        .await?;
    let workspace_identity = context.identity();
    let workspace = host
        .build_workspace_candidate(
            &project,
            extension_workspace_scope_id(&project, workspace_identity.as_ref())?,
            internal_plugins_for_scope(&rho_extension_runtime::ScopePolicy::workspace_kind()),
            Arc::new(WorkspaceSnapshotBrokerFacade {
                session: Arc::clone(&session),
                context: Arc::clone(&context),
            }),
        )
        .await?;
    host.publish_workspace_candidate(None, workspace.clone())
        .await?;

    let snapshot_request =
        BoundedJson::generic(serde_json::to_value(WorkspaceOperation::Snapshot {
            expected_workspace: expected_workspace(workspace_identity.as_ref()),
            origin: ExecutionOrigin::System,
            execution_id: None,
        })?)?;
    let snapshot = workspace
        .registry()
        .call_workspace_tool(&workspace_snapshot_tool_capability_id(), snapshot_request)
        .await?;
    host.scopes().validate_workspace_current(&snapshot.scope)?;
    let snapshot_value = snapshot.payload.into_value();
    ensure!(
        snapshot_value["workspace"]["kernel_instance_id"] == workspace_identity.kernel_instance_id,
        "candidate Workspace Snapshot returned a different kernel identity"
    );

    let run_request = BoundedJson::generic(json!({ "limit": null }))?;
    let candidate_runs = project
        .registry()
        .call_source(&run_history_source_capability_id(), run_request)
        .await?;
    host.scopes()
        .validate_project_current(&candidate_runs.scope)?;
    let candidate_runs: Vec<RunSummary> =
        serde_json::from_value(candidate_runs.payload.into_value())?;
    let executor = context.lock().await.executor.clone();
    let direct_runs = executor
        .run_repository()
        .list_runs(normalized_project_root.clone(), None)
        .await?;
    ensure!(
        serde_json::to_value(&candidate_runs)? == serde_json::to_value(&direct_runs)?,
        "candidate Run History diverged from Store authority"
    );

    let replacement = host
        .build_workspace_candidate(
            &project,
            extension_workspace_scope_id(&project, &workspace_identity)?,
            internal_plugins_for_scope(&rho_extension_runtime::ScopePolicy::workspace_kind()),
            Arc::new(WorkspaceSnapshotBrokerFacade {
                session,
                context: Arc::clone(&context),
            }),
        )
        .await?;
    host.publish_workspace_candidate(Some(workspace.clone()), replacement)
        .await?;
    ensure!(
        workspace
            .registry()
            .call_workspace_tool(
                &workspace_snapshot_tool_capability_id(),
                BoundedJson::generic(json!({}))?,
            )
            .await
            .is_err(),
        "old Workspace extension generation remained routable"
    );
    let shutdown = host.shutdown().await;
    ensure!(
        shutdown.outcome == DisposeOutcome::Disposed,
        "candidate extension host did not shut down cleanly"
    );
    Ok(json!({
        "mode": "candidate",
        "candidate_exercised": true,
        "legacy_override_exercised": false,
        "run_history_parity": true,
        "workspace_snapshot_typed": true,
        "viewer_host_injected": true,
        "application_surface_registered": true,
        "old_workspace_rejected": true,
        "clean_shutdown": true,
    }))
}

async fn set_smoke_project_root(
    session: &ArkSession,
    broker: &mut BrokerState,
    store: &mut Store,
    executor: &StoreExecutor,
    root: &Path,
) -> Result<()> {
    store.set_project_root(Some(root.to_string_lossy().as_ref()))?;
    let payload = json!({
        "arguments": {
            "code": workspace_project_root_code(root)?
        },
        "expected_workspace": broker.identity()
    });
    let _ = dispatch_workspace_request(
        "workspace.set_project_root",
        &payload,
        ExecutionOrigin::System,
        session,
        broker,
        executor,
    )
    .await?;
    Ok(())
}

fn main() {
    // On Linux, WebKitGTK's DMABUF renderer fails to allocate GBM buffers on
    // NVIDIA proprietary graphics stacks, leaving the webview blank. Default
    // to the software renderer unless the environment already overrides it.
    if cfg!(target_os = "linux") && std::env::var_os("WEBKIT_DISABLE_DMABUF_RENDERER").is_none() {
        // SAFETY: this runs at the top of main() before any additional
        // threads are spawned, so no concurrent environment access exists.
        unsafe { std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1") };
    }
    std::panic::set_hook(Box::new(|information| {
        write_startup_log(&format!("Rho desktop panic: {information}"));
    }));
    let arguments = std::env::args().collect::<Vec<_>>();
    let smoke_agent = arguments.iter().any(|argument| argument == "--smoke-agent");
    if smoke_agent || arguments.iter().any(|argument| argument == "--smoke-test") {
        let runtime = tokio::runtime::Runtime::new().expect("creating smoke-test runtime");
        match runtime.block_on(smoke_test(smoke_agent)) {
            Ok(report) => {
                println!("{}", serde_json::to_string_pretty(&report).unwrap());
                return;
            }
            Err(error) => {
                eprintln!("Rho desktop smoke test failed: {error:#}");
                std::process::exit(1);
            }
        }
    }
    let run_result = tauri::Builder::default()
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
            let data_dir = app
                .path()
                .app_local_data_dir()
                .context("resolving Rho application data directory")?;
            initialize_startup_log(&data_dir);
            write_startup_log("Rho desktop shell setup started");
            let ark = locate_ark(app)?;
            let project_store = ProjectSessionStore::new(data_dir.clone()).map_err(|error| {
                write_startup_log(&format!("Rho project session setup failed: {error:#}"));
                error
            })?;
            let ui_profile =
                ui_profile::ProjectUiProfileState::new(data_dir.clone()).map_err(|error| {
                    write_startup_log(&format!("Rho UI Profile setup failed: {error:#}"));
                    error
                })?;
            let selected_rscript = load_selected_rscript(&data_dir);
            let extension_host =
                tauri::async_runtime::block_on(desktop_extension_host()).map_err(|error| {
                    write_startup_log(&format!("Internal extension host setup failed: {error:#}"));
                    error
                })?;
            app.manage(AppState {
                data_dir,
                ark,
                config: SyncRwLock::new(None),
                selected_rscript: SyncRwLock::new(selected_rscript),
                startup: SyncRwLock::new(StartupView {
                    phase: "shell_ready".to_string(),
                    busy: false,
                    runtime: None,
                    issue: None,
                }),
                project_store,
                project_root: RwLock::new(default_project_root()),
                project_watcher: Mutex::new(None),
                session: RwLock::new(None),
                context: Mutex::new(None),
                store_executor: tokio::sync::OnceCell::new(),
                approvals: Arc::new(PendingApprovalRegistry::default()),
                environment_approvals: Arc::new(PendingApprovalRegistry::default()),
                project_transition_gate: Arc::new(Mutex::new(())),
                extension_host,
                plugin_permissions: crate::workspace_plugins::PendingPluginPermissionRegistry::new(
                ),
                agent_tasks: Arc::new(Mutex::new(HashMap::new())),
                agent_workspace_lane: Arc::new(AgentWorkspaceLane::default()),
                agent_file_mutations: Arc::new(AgentFileMutationRegistry::default()),
                #[cfg(test)]
                agent_file_apply_test_control: AgentFileApplyTestControl::default(),
                agent_llm_test_control: AgentModelTestControl::default(),
                switch_test_control: SwitchTestControl::default(),
                shutdown_started: AtomicBool::new(false),
                render_jobs: Arc::new(Mutex::new(HashMap::new())),
                render_tasks: Arc::new(Mutex::new(HashMap::new())),
                surface_runtime: surface_runtime::SurfaceRuntimeState::default(),
                plugin_surface_runtime: plugin_surface_runtime::PluginSurfaceRuntimeState::default(
                ),
                check_runtime: check_runtime::CheckRuntimeState::default(),
                studio_runtime: studio_runtime::StudioRuntimeState::default(),
                runtime_registry: runtime_registry::RuntimeRegistryState::default(),
                resource_registry: resource_registry::ResourceRegistryState::default(),
                ui_profile,
                ui_runtime: ui_runtime::UiRuntimeState::default(),
            });
            app.manage(shell::NativeUpdaterState::new());
            let heartbeat_app = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                monitor_workspace_plugin_heartbeats(heartbeat_app).await;
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            shell::app_info,
            shell::check_for_updates,
            shell::install_native_update,
            shell::open_rho_website,
            shell::show_rho_license,
            commands::startup::startup_status,
            commands::startup::startup_bootstrap,
            commands::startup::startup_choose_rscript,
            commands::startup::startup_diagnostics,
            commands::startup::startup_open_log_directory,
            commands::startup::agent_runtime_status,
            commands::startup::agent_runtime_retry,
            ui_runtime::ui_kernel_snapshot,
            ui_runtime::ui_set_selection,
            surface_runtime::surface_list,
            surface_runtime::surface_open,
            surface_runtime::surface_update,
            surface_runtime::surface_close,
            surface_runtime::surface_suspend,
            surface_runtime::surface_resume,
            plugin_surface_runtime::plugin_surface_document,
            plugin_surface_runtime::plugin_surface_event,
            check_runtime::check_project_run,
            check_runtime::check_result,
            studio_runtime::studio_scene,
            studio_runtime::studio_apply,
            studio_runtime::studio_undo,
            studio_runtime::studio_redo,
            ui_profile::ui_profile_snapshot,
            ui_profile::ui_profile_set_mode,
            ui_profile::ui_profile_select_scene,
            ui_profile::ui_profile_select_page,
            ui_profile::ui_profile_page_apply,
            ui_profile::ui_profile_page_export,
            ui_profile::ui_profile_scene_duplicate,
            ui_profile::ui_profile_scene_save,
            ui_profile::ui_profile_scene_rename,
            ui_profile::ui_profile_scene_delete,
            ui_profile::ui_profile_scene_reset,
            runtime_registry::runtime_list,
            runtime_registry::runtime_create,
            runtime_registry::runtime_attach,
            runtime_registry::runtime_detach,
            runtime_registry::runtime_interrupt,
            runtime_registry::runtime_restart,
            runtime_registry::runtime_stop,
            runtime_registry::runtime_execution_start,
            runtime_registry::runtime_execution_get,
            runtime_registry::runtime_execution_list,
            runtime_registry::runtime_output_search,
            runtime_registry::runtime_output_policy_get,
            runtime_registry::runtime_output_policy_update,
            runtime_registry::runtime_output_page,
            runtime_registry::runtime_output_reference,
            runtime_registry::runtime_output_prune,
            runtime_registry::runtime_execution_delete,
            runtime_registry::runtime_output_follow,
            resource_registry::resource_list,
            resource_registry::resource_resolve,
            resource_registry::resource_read,
            resource_registry::resource_update_draft,
            resource_registry::resource_save,
            resource_registry::resource_reload,
            resource_registry::resource_rename,
            resource_registry::resource_delete,
            commands::startup::workspace_start,
            commands::startup::workspace_status,
            commands::project_session::project_state,
            commands::project_session::project_mark_files_changed,
            commands::project_session::project_open,
            commands::project_session::project_pick_directory,
            commands::project_session::project_restore_session,
            commands::project_session::project_save_session,
            commands::project_session::project_read_file,
            commands::project_session::viewer_read_file,
            commands::project_session::project_write_file,
            commands::project_session::project_create_file,
            commands::project_session::project_delete_file,
            commands::agent_files::apply_agent_file_edit,
            commands::agent_files::undo_agent_file_edit,
            commands::workspace::execute_r,
            commands::workspace::snapshot_workspace,
            commands::workspace::inspect_object,
            commands::workspace::inspect_data_object,
            commands::workspace::read_data_view,
            commands::render::render_document,
            commands::render::render_document_job,
            commands::render::render_job_status,
            commands::render::cancel_render_job,
            commands::environment::request_environment_operation_preview,
            commands::environment::list_environment_operation_requests,
            commands::environment::get_environment_operation_request,
            commands::environment::respond_environment_operation,
            commands::environment::list_installed_packages,
            commands::environment::list_lockfile_packages,
            commands::plugins::list_workspace_plugins,
            commands::plugins::get_workspace_plugin_transition,
            commands::plugins::request_workspace_plugin_enable,
            commands::plugins::disable_workspace_plugin,
            commands::plugins::retry_workspace_plugin,
            commands::plugins::accept_workspace_plugin_update,
            commands::plugins::rollback_workspace_plugin,
            commands::plugins::uninstall_workspace_plugin,
            commands::plugins::restore_workspace_plugin,
            commands::plugins::list_plugin_permission_requests,
            commands::plugins::get_plugin_permission_request,
            commands::plugins::respond_plugin_permission,
            commands::plugins::list_plugin_grants,
            commands::plugins::revoke_plugin_grant,
            commands::plugins::list_plugin_contributions,
            commands::plugins::invoke_plugin_command,
            commands::plugins::open_plugin_viewer,
            commands::plugins::get_plugin_panel_document,
            commands::runs::list_runs,
            commands::artifacts::list_plot_artifacts,
            commands::artifacts::read_plot_artifact,
            commands::artifacts::export_plot_artifact,
            commands::artifacts::export_data_view_artifact,
            commands::artifacts::list_artifact_records,
            commands::artifacts::get_artifact_record,
            commands::artifacts::prune_plot_payloads,
            commands::artifacts::get_project_retention_summary,
            commands::project_session::list_project_skills,
            commands::artifacts::clear_artifact_records,
            commands::artifacts::clear_plot_artifacts,
            commands::runs::list_problems,
            commands::runs::get_run_detail,
            commands::runs::compare_runs,
            commands::runs::audit_reproducibility,
            commands::editor::editor_package_functions,
            commands::editor::editor_function_help,
            commands::editor::editor_function_documentation,
            commands::editor::editor_lint_file,
            commands::editor::editor_format_source,
            commands::editor::editor_goto_definition,
            commands::editor::editor_find_project_references,
            commands::editor::editor_discover_chunks,
            commands::runs::retry_run,
            commands::agent_execution::run_agent,
            commands::agent_execution::agent_context_preview,
            commands::agent_llm::agent_llm_settings,
            commands::agent_llm::agent_llm_save_provider,
            commands::agent_llm::agent_llm_delete_provider,
            commands::agent_llm::agent_llm_set_credential,
            commands::agent_llm::agent_llm_delete_credential,
            commands::agent_llm::agent_llm_save_model,
            commands::agent_llm::agent_llm_set_context_capacity,
            commands::agent_llm::agent_llm_delete_model,
            commands::agent_llm::agent_llm_select_model,
            commands::agent_llm::agent_llm_save_capability_route,
            commands::agent_llm::agent_llm_delete_capability_route,
            commands::agent_llm::agent_llm_declare_model_capabilities,
            commands::agent_llm::agent_llm_refresh_credentials,
            commands::agent_llm::agent_llm_test_model,
            commands::agent_llm::agent_llm_cancel_test,
            commands::agent_llm::agent_llm_catalog,
            commands::agent_llm::agent_llm_discover_models,
            commands::agent_conversation::list_agent_conversations,
            commands::agent_conversation::create_agent_conversation,
            commands::agent_conversation::list_agent_turns,
            commands::agent_execution::retry_agent_turn,
            commands::agent_conversation::delete_agent_conversation,
            commands::agent_execution::clear_agent_history,
            commands::agent_execution::list_approval_requests,
            commands::agent_execution::get_agent_turn_detail,
            commands::agent_execution::respond_approval,
            commands::runtime_control::interrupt_r,
            commands::runtime_control::cancel_run,
            commands::agent_execution::cancel_agent_turn,
            commands::runtime_control::restart_workspace,
            git_commands::git_status,
            git_commands::git_log,
            git_commands::git_diff,
            git_commands::git_stage,
            git_commands::git_commit,
            git_commands::git_diff_unified,
            git_commands::git_hunk_stage,
            git_commands::git_hunk_unstage,
            git_commands::git_restore_file,
            git_commands::git_unstage_file,
            git_commands::git_staged_revision,
            git_commands::git_list_conflicts,
            git_commands::git_resolve_conflict,
            commands::runtime_control::targets_status,
            commands::evidence::resolve_doi,
            commands::evidence::create_evidence_entry,
            commands::evidence::list_evidence_entries,
            commands::evidence::get_evidence_entry,
            commands::evidence::delete_evidence_entry,
            commands::evidence::create_evidence_claim,
            commands::evidence::list_evidence_claims,
            commands::evidence::review_evidence_claim,
            commands::evidence::delete_evidence_claim,
        ])
        .build(tauri::generate_context!());
    match run_result {
        Ok(app) => {
            app.run(|app_handle, event| {
                if let tauri::RunEvent::ExitRequested { api, code, .. } = event
                    && code.is_none()
                {
                    api.prevent_exit();
                    let state = app_handle.state::<AppState>();
                    if state.shutdown_started.swap(true, Ordering::SeqCst) {
                        return;
                    }

                    let app_handle = app_handle.clone();
                    tauri::async_runtime::spawn(async move {
                        let state = app_handle.state::<AppState>();
                        let _ = shutdown_application(&state).await;
                        app_handle.exit(0);
                    });
                }
            });
        }
        Err(error) => {
            let detail = format!("Rho desktop could not start: {error:#}");
            write_startup_log(&detail);
            let _ = rfd::MessageDialog::new()
                .set_title("Rho could not start")
                .set_description(format!(
                    "Rho could not open its interface.\n\n{error}\n\nDiagnostic log:\n{}",
                    startup_log_path().display()
                ))
                .set_level(rfd::MessageLevel::Error)
                .set_buttons(rfd::MessageButtons::Ok)
                .show();
        }
    }
}
