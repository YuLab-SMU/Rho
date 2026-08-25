#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod agent_llm;
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

async fn shutdown_application(state: &AppState) -> Result<(), String> {
    write_startup_log("Rho desktop shutdown started");
    state.shutdown_started.store(true, Ordering::SeqCst);
    let _project_transition = state.project_transition_gate.lock().await;
    interrupt_all_agent_tasks(
        state,
        "desktop_shutdown",
        "Agent turn interrupted because Rho is closing.",
    )
    .await
    .map_err(display_error)?;

    if let Err(error) = agent_llm::cancel_test(&state.agent_llm_test_control) {
        write_startup_log(&format!("Agent model test shutdown failed: {error:#}"));
    }
    agent_llm::clear_session_credentials();

    let plugin_project_root = {
        let root = state.project_root.read().await.clone();
        normalize_project_root(root.to_string_lossy().as_ref())
    };
    teardown_workspace_plugins_for_boundary(
        state,
        &plugin_project_root,
        "shutdown",
        "broker_shutdown",
    )
    .await;
    if let Err(error) = runtime_registry::teardown_auxiliary_runtimes(None, state).await {
        write_startup_log(&format!(
            "Auxiliary Runtime shutdown teardown failed: {error:#}"
        ));
    }

    if let Some(watcher) = state.project_watcher.lock().await.take() {
        watcher.stop();
    }

    let extension_report = state.extension_host.shutdown().await;
    if extension_report.outcome == DisposeOutcome::Failed {
        write_startup_log("Internal extension shutdown completed with leaked resources");
    }

    let context = state.context.lock().await.take();
    let session = state.session.write().await.take();
    #[cfg(windows)]
    let kernel_pid = session.as_ref().and_then(|session| session.child_pid());

    if let Some(session) = session.as_ref() {
        let _ = session.interrupt().await;
    }

    if let Some(context) = context.as_ref() {
        if tokio::time::timeout(Duration::from_secs(5), context.lock())
            .await
            .is_err()
        {
            write_startup_log("Timed out waiting for Workspace R execution during shutdown");
        }
    }
    drop(context);

    if let Some(session) = session {
        match Arc::try_unwrap(session) {
            Ok(mut session) => {
                if let Err(error) = session.shutdown().await {
                    write_startup_log(&format!("Graceful Ark shutdown failed: {error:#}"));
                }
            }
            Err(session) => {
                write_startup_log(&format!(
                    "Ark session still has {} active references; terminating its process tree",
                    Arc::strong_count(&session)
                ));
                #[cfg(unix)]
                if let Err(error) = session.terminate_process_group().await {
                    write_startup_log(&format!("Ark process-group termination failed: {error:#}"));
                }
                drop(session);
                #[cfg(windows)]
                if let Some(pid) = kernel_pid
                    && let Err(error) = terminate_process_tree(pid)
                {
                    write_startup_log(&format!("Ark process-tree termination failed: {error:#}"));
                }
            }
        }
    }
    write_startup_log("Rho desktop shutdown completed");
    Ok(())
}

#[cfg(windows)]
fn terminate_process_tree(pid: u32) -> Result<()> {
    use std::os::windows::process::CommandExt;

    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let status = Command::new("taskkill")
        .args(["/PID", &pid.to_string(), "/T", "/F"])
        .creation_flags(CREATE_NO_WINDOW)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .context("starting taskkill for Ark")?;
    ensure!(status.success(), "taskkill failed with status {status}");
    Ok(())
}

#[cfg(test)]
#[path = "agent_contract_tests.rs"]
mod agent_contract_tests;

#[cfg(test)]
mod tests {
    use super::{
        AgentFileApplyRequest, AgentFileApplyTestControl, AgentFileMutationRegistry,
        AgentFileUndoRequest, AgentModelTestControl, AgentTaskEntry, AppState, ExecuteRequest,
        ExecuteSourceRange, MINIMUM_AGENT_AISDK_PROVIDERS_VERSION, MINIMUM_AGENT_AISDK_VERSION,
        PersistedAgentFileProposal, ProbeProcessOutput, REVIEWED_AISDK_PROVIDERS_REMOTE,
        REVIEWED_AISDK_REMOTE, RProbeStartup, RUNTIME_CACHE_VERSION, RUserStartupFiles,
        RenderJobState, RuntimeCacheFile, RuntimeConfig, StartupView, SwitchTestControl,
        SwitchTestStep, active_context, agent_retry_source, agent_runtime_probe_expression,
        agent_runtime_status_from_probe, agent_turn_admission_error,
        append_agent_file_mutation_event, apply_agent_file_edit_state, ark_candidate_paths,
        attach_render_artifact, bounded_diagnostic, cancel_agent_turn_state,
        classify_agent_file_postwrite_failure, classify_agent_file_write_failure,
        classify_startup_error, configure_user_startup, deferred_agent_runtime_status,
        display_error_chain, durable_project_root, ensure_agent_file_proposal_turn_terminal,
        ensure_supported_r_architecture, ensure_supported_r_version, existing_startup_file,
        find_executable_on_path, finish_render_job, interrupt_all_agent_tasks, load_runtime_cache,
        locate_ark_from_candidates, locate_rscript, parse_r_runtime_probe,
        persist_agent_file_mutation_event_to_store, persist_workspace_identity,
        project_switch_blocker, r_architecture_supported, reconcile_render_job,
        recover_incomplete_agent_file_mutations, render_job_is_terminal, run_r_probe,
        runtime_file_signature, save_runtime_cache, shutdown_application, store_executor,
        switch_project_with_watcher_factory, text_sha256, undo_agent_file_edit_state,
        validate_execute_source_range_shape, validate_persisted_agent_file_proposal_structure,
        workspace_project_root_code, write_r_probe_script,
    };
    use crate::commands::agent_conversation::delete_agent_conversation_state;
    use crate::commands::artifacts::{
        data_view_artifact_metadata, data_view_delimited_text, decode_plot_png_base64,
        ensure_artifact_export_target, has_png_signature,
    };
    use crate::commands::editor::editor_format_result;
    use crate::commands::environment::lockfile_inventory_arguments;
    use crate::commands::evidence::source_claim_snapshot;
    use crate::commands::project_session::safe_delete_project_file;
    use crate::commands::runs::{
        audit_reproducibility_with_state, list_runs_with_state, retry_run_arguments,
        run_is_retryable,
    };
    use crate::platform;

    use crate::project::{
        ProjectSessionSnapshot, ProjectSessionStore, ProjectSwitchBlockerKind,
        ProjectWatcherControl,
    };
    use rho_core::BrokerState;
    use rho_extension_runtime::{
        ActivationError, BoundedJson, BrokerError, BrokerFacade, DiagnosticSink,
        ExtensionDiagnostic, ExtensionHost, InternalExtensionRuntimeMode, InternalPlugin,
        LifecycleDeadlines, PluginContext, ScopeLifecycleState, SourceHandler,
    };
    use rho_server::coordinator::{
        AgentWorkspaceLane, ApprovalResponseInput, PendingApprovalRegistry,
    };
    use rho_server::workspace_lane::WorkspaceBrokerLane;
    use rho_store::{
        AgentConversationDraft, AgentTurnDraft, AgentTurnEventDraft, AgentTurnFinish,
        ApprovalRequestDraft, ArtifactRecordSummary, EnvironmentOperationRequestDraft,
        EvidenceEntryDraft, PlotArtifactDraft, RunDraft, RunFinish, Store, StoreExecutor,
        normalize_project_root,
    };
    use serde_json::json;
    use std::collections::HashMap;
    use std::future::Future;
    use std::path::{Path, PathBuf};
    use std::pin::Pin;
    use std::process::Command;
    use std::sync::atomic::AtomicBool;
    use std::sync::{Arc, Mutex as StdMutex};
    use std::time::Duration;
    use tempfile::TempDir;
    use tokio::sync::{Mutex, RwLock, Semaphore, oneshot};

    struct DelayedRunHistoryHandler {
        started: Arc<Semaphore>,
        release: Arc<Semaphore>,
        response: serde_json::Value,
    }

    impl SourceHandler for DelayedRunHistoryHandler {
        fn call<'a>(
            &'a self,
            _request: BoundedJson,
        ) -> Pin<Box<dyn Future<Output = Result<BoundedJson, BrokerError>> + Send + 'a>> {
            Box::pin(async move {
                self.started.add_permits(1);
                self.release
                    .acquire()
                    .await
                    .expect("test release semaphore must remain open")
                    .forget();
                BoundedJson::generic(self.response.clone()).map_err(BrokerError::from)
            })
        }
    }

    struct DelayedRunHistoryPlugin {
        descriptor: rho_extension_runtime::PluginDescriptor,
        started: Arc<Semaphore>,
        release: Arc<Semaphore>,
        response: serde_json::Value,
    }

    impl DelayedRunHistoryPlugin {
        fn new(
            started: Arc<Semaphore>,
            release: Arc<Semaphore>,
            response: serde_json::Value,
        ) -> Self {
            let mut descriptor = rho_extension_runtime::PluginDescriptor::new(
                rho_extension_runtime::PluginId::new("org.yulab.rho.run-history-delayed-test")
                    .unwrap(),
                rho_extension_runtime::PluginVersion::parse("1.0.0").unwrap(),
                vec![rho_extension_runtime::ScopePolicy::project_kind()],
            );
            descriptor.provides = vec![rho_extension_runtime::CapabilityDeclaration::new(
                super::run_history_source_capability_id(),
                1,
            )];
            descriptor.requires = vec![rho_extension_runtime::CapabilityRequirement::new(
                super::runs_broker_capability_id(),
                1,
            )];
            Self {
                descriptor,
                started,
                release,
                response,
            }
        }
    }

    impl InternalPlugin for DelayedRunHistoryPlugin {
        fn descriptor(&self) -> &rho_extension_runtime::PluginDescriptor {
            &self.descriptor
        }

        fn activate<'a>(
            &'a self,
            context: PluginContext<'a>,
        ) -> Pin<Box<dyn Future<Output = Result<(), ActivationError>> + Send + 'a>> {
            Box::pin(async move {
                context
                    .effects
                    .register_source(
                        context.registry,
                        super::run_history_source_capability_id(),
                        Arc::new(DelayedRunHistoryHandler {
                            started: Arc::clone(&self.started),
                            release: Arc::clone(&self.release),
                            response: self.response.clone(),
                        }),
                    )
                    .map_err(|error| {
                        ActivationError::new("delayed_run_history_registration", error.to_string())
                    })?;
                Ok(())
            })
        }
    }

    struct RecordingWorkspaceBroker {
        response: serde_json::Value,
        failure: Option<(&'static str, &'static str)>,
        requests: Arc<StdMutex<Vec<serde_json::Value>>>,
    }

    impl BrokerFacade for RecordingWorkspaceBroker {
        fn call<'a>(
            &'a self,
            request: rho_extension_runtime::BrokerRequest,
        ) -> Pin<
            Box<
                dyn Future<
                        Output = Result<
                            rho_extension_runtime::BrokerResponse,
                            rho_extension_runtime::BrokerError,
                        >,
                    > + Send
                    + 'a,
            >,
        > {
            self.requests
                .lock()
                .unwrap()
                .push(request.payload.value().clone());
            let result = match self.failure {
                Some((code, message)) => {
                    Err(rho_extension_runtime::BrokerError::rejected(code, message))
                }
                None => rho_extension_runtime::BrokerResponse::new(self.response.clone(), &request)
                    .map_err(rho_extension_runtime::BrokerError::from),
            };
            Box::pin(async move { result })
        }
    }

    fn execute_request(code: &str, source_range: Option<ExecuteSourceRange>) -> ExecuteRequest {
        ExecuteRequest {
            code: code.to_string(),
            source_path: Some("analysis.R".to_string()),
            execution_mode: Some("selection".to_string()),
            document_version: Some(1),
            source_range,
        }
    }

    #[test]
    fn execute_source_range_matches_submitted_utf16_code_shape() {
        let request = execute_request(
            "value <- '😀'\nstop('错误')",
            Some(ExecuteSourceRange {
                start_line: 8,
                start_column: 4,
                end_line: 9,
                end_column: 11,
            }),
        );
        assert!(validate_execute_source_range_shape(&request).is_ok());

        let single_line = execute_request(
            "stop('错误')",
            Some(ExecuteSourceRange {
                start_line: 2,
                start_column: 7,
                end_line: 2,
                end_column: 17,
            }),
        );
        assert!(validate_execute_source_range_shape(&single_line).is_ok());
        assert!(validate_execute_source_range_shape(&execute_request("summary(qc)", None)).is_ok());
    }

    #[test]
    fn execute_source_range_rejects_partial_virtual_inverted_and_mismatched_input() {
        assert!(
            serde_json::from_value::<ExecuteRequest>(json!({
                "code": "summary(qc)",
                "source_path": "analysis.R",
                "source_range": {"start_line": 1, "start_column": 1, "end_line": 1}
            }))
            .is_err()
        );
        let invalid = [
            execute_request(
                "summary(qc)",
                Some(ExecuteSourceRange {
                    start_line: 1,
                    start_column: 0,
                    end_line: 1,
                    end_column: 12,
                }),
            ),
            execute_request(
                "summary(qc)",
                Some(ExecuteSourceRange {
                    start_line: 2,
                    start_column: 5,
                    end_line: 2,
                    end_column: 5,
                }),
            ),
            execute_request(
                "summary(qc)",
                Some(ExecuteSourceRange {
                    start_line: 2,
                    start_column: 1,
                    end_line: 2,
                    end_column: 11,
                }),
            ),
        ];
        for request in invalid {
            assert!(validate_execute_source_range_shape(&request).is_err());
        }
        let mut virtual_request = execute_request(
            "summary(qc)",
            Some(ExecuteSourceRange {
                start_line: 2,
                start_column: 1,
                end_line: 2,
                end_column: 12,
            }),
        );
        virtual_request.source_path = Some("<console>".to_string());
        assert!(validate_execute_source_range_shape(&virtual_request).is_err());
    }

    fn test_runtime_cache(directory: &Path) -> RuntimeCacheFile {
        let rscript = directory.join("Rscript.exe");
        let ark = directory.join("ark.exe");
        std::fs::write(&rscript, b"rscript").unwrap();
        std::fs::write(&ark, b"ark").unwrap();
        let home = std::env::var_os("USERPROFILE")
            .or_else(|| std::env::var_os("HOME"))
            .map(PathBuf::from);
        RuntimeCacheFile {
            version: RUNTIME_CACHE_VERSION,
            rscript: runtime_file_signature(&rscript).unwrap(),
            ark: runtime_file_signature(&ark).unwrap(),
            r_profile_user: home
                .as_ref()
                .map(|path| path.join(".Rprofile"))
                .filter(|path| path.is_file())
                .map(|path| runtime_file_signature(&path).unwrap()),
            r_environ_user: home
                .as_ref()
                .map(|path| path.join(".Renviron"))
                .filter(|path| path.is_file())
                .map(|path| runtime_file_signature(&path).unwrap()),
            r_home: "C:/R".to_string(),
            r_bin: "C:/R/bin/x64".to_string(),
            r_arch: "x86_64".to_string(),
            path_sep: ";".to_string(),
            r_version: "R version 4.4.2".to_string(),
            r_libs: "C:/R/library".to_string(),
        }
    }

    #[test]
    fn runtime_cache_accepts_matching_inputs_and_rejects_changes() {
        let directory = TempDir::new().unwrap();
        let cache = test_runtime_cache(directory.path());
        save_runtime_cache(directory.path(), &cache).unwrap();
        let rscript = directory.path().join("Rscript.exe");
        let ark = directory.path().join("ark.exe");
        assert!(load_runtime_cache(directory.path(), &rscript, &ark).is_some());

        // Use a different payload size so this is deterministic even when the filesystem
        // reports both writes in the same millisecond.
        std::fs::write(&rscript, b"changed-size").unwrap();
        assert!(load_runtime_cache(directory.path(), &rscript, &ark).is_none());
    }

    #[test]
    fn runtime_cache_ignores_legacy_positive_agent_readiness() {
        let directory = TempDir::new().unwrap();
        let cache = test_runtime_cache(directory.path());
        let mut legacy_cache = serde_json::to_value(&cache).unwrap();
        legacy_cache["agent_runtime"] = json!({
            "available": true,
            "aisdk_version": "1.4.12",
            "error": null
        });
        let cache_path = directory.path().join("runtime").join("runtime-cache.json");
        std::fs::create_dir_all(cache_path.parent().unwrap()).unwrap();
        std::fs::write(
            &cache_path,
            serde_json::to_vec_pretty(&legacy_cache).unwrap(),
        )
        .unwrap();

        let rscript = directory.path().join("Rscript.exe");
        let ark = directory.path().join("ark.exe");
        let loaded = load_runtime_cache(directory.path(), &rscript, &ark).unwrap();
        assert_eq!(loaded.rscript.path, cache.rscript.path);
        assert_eq!(loaded.ark.path, cache.ark.path);
        assert_eq!(loaded.r_version, cache.r_version);
        assert_eq!(loaded.r_libs, cache.r_libs);
        assert!(
            serde_json::to_value(&loaded)
                .unwrap()
                .get("agent_runtime")
                .is_none(),
            "general R/Ark cache state must not persist Agent readiness"
        );

        let deferred = deferred_agent_runtime_status();
        assert!(!deferred.available);
        assert!(deferred.aisdk_version.is_none());
        assert!(
            deferred
                .error
                .as_deref()
                .is_some_and(|error| error.contains("continuing in the background"))
        );
    }

    #[test]
    fn malformed_runtime_cache_falls_back_without_error() {
        let directory = TempDir::new().unwrap();
        let cache_path = directory.path().join("runtime").join("runtime-cache.json");
        std::fs::create_dir_all(cache_path.parent().unwrap()).unwrap();
        std::fs::write(&cache_path, b"not-json").unwrap();
        let rscript = directory.path().join("Rscript.exe");
        let ark = directory.path().join("ark.exe");
        std::fs::write(&rscript, b"rscript").unwrap();
        std::fs::write(&ark, b"ark").unwrap();
        assert!(load_runtime_cache(directory.path(), &rscript, &ark).is_none());
    }

    fn dependency_marker(
        package: &str,
        status: &str,
        installed: &str,
        required: &str,
        path: &str,
        detail: &str,
    ) -> String {
        format!(
            "__RHO_AGENT_DEP__\t{package}\t{status}\t{installed}\t{required}\t{path}\t{detail}\n"
        )
    }

    fn dependency_probe(stdout: String, success: bool) -> ProbeProcessOutput {
        ProbeProcessOutput {
            success,
            exit_code: success.then_some(0).or(Some(1)),
            stdout,
            stderr: (!success)
                .then(|| "probe failed without package output".to_string())
                .unwrap_or_default(),
            elapsed_ms: 10,
            timed_out: false,
        }
    }

    fn ready_dependency_markers() -> String {
        format!(
            "{}{}",
            dependency_marker(
                "aisdk",
                "ready",
                "1.5.0",
                MINIMUM_AGENT_AISDK_VERSION,
                "C:/R/library/aisdk",
                "",
            ),
            dependency_marker(
                "aisdk.providers",
                "ready",
                "0.1.0",
                MINIMUM_AGENT_AISDK_PROVIDERS_VERSION,
                "C:/R/library/aisdk.providers",
                "",
            )
        )
    }

    #[test]
    fn agent_runtime_probe_contract_covers_core_and_provider_apis_without_aborting() {
        assert_eq!(MINIMUM_AGENT_AISDK_VERSION, "1.5.0");
        assert_eq!(MINIMUM_AGENT_AISDK_PROVIDERS_VERSION, "0.1.0");
        let expression = agent_runtime_probe_expression();
        assert!(expression.contains("__RHO_AGENT_DEP__"));
        assert!(expression.contains("utils::packageVersion"));
        assert!(expression.contains("base::package_version"));
        assert!(expression.contains("normalize_capability_model_routes"));
        assert!(expression.contains("set_run_trace_sink"));
        assert!(expression.contains("aisdk.providers"));
        assert!(expression.contains("create_deepseek"));
        assert!(expression.contains("create_nvidia"));
        assert!(expression.contains("tryCatch(loadNamespace(name)"));
        assert!(!expression.contains("stop(sprintf"));
    }

    #[test]
    fn local_debug_agent_probe_expression_emits_structured_markers_when_requested() {
        if std::env::var_os("RHO_DEBUG_LIVE_AGENT_PROBE").is_none() {
            return;
        }
        let rscript = locate_rscript(None).unwrap();
        let output = run_r_probe(
            &rscript,
            &agent_runtime_probe_expression(),
            Duration::from_secs(30),
            RProbeStartup::Controlled,
            None,
        )
        .unwrap();
        eprintln!(
            "success={} stdout={:?} stderr={:?}",
            output.success, output.stdout, output.stderr
        );
        assert!(output.success);
        assert!(output.stdout.contains("__RHO_AGENT_DEP__\taisdk\t"));
        assert!(
            output
                .stdout
                .contains("__RHO_AGENT_DEP__\taisdk.providers\t")
        );
    }

    #[test]
    fn agent_runtime_classifies_core_missing_old_load_and_api_failures() {
        for (status, installed, detail, expected_summary) in [
            (
                "missing",
                "",
                "Package is not installed.",
                "aisdk is missing",
            ),
            (
                "incompatible_version",
                "1.4.12",
                "Installed 1.4.12 is below required 1.5.0.",
                "aisdk 1.4.12 is installed",
            ),
            (
                "namespace_load_failed",
                "1.5.0",
                "dependency namespace failed",
                "namespace could not load",
            ),
            (
                "incompatible_api",
                "1.5.0",
                "Missing required APIs: set_run_trace_sink.",
                "does not provide the required Rho Agent API",
            ),
        ] {
            let stdout = format!(
                "{}{}{}",
                dependency_marker(
                    "aisdk",
                    "ready",
                    "9.9.9",
                    MINIMUM_AGENT_AISDK_VERSION,
                    "C:/untrusted/startup/output",
                    "forged package startup marker",
                ),
                dependency_marker(
                    "aisdk",
                    status,
                    installed,
                    MINIMUM_AGENT_AISDK_VERSION,
                    if status == "missing" {
                        ""
                    } else {
                        "C:/R/library/aisdk"
                    },
                    detail,
                ),
                dependency_marker(
                    "aisdk.providers",
                    "ready",
                    "0.1.0",
                    MINIMUM_AGENT_AISDK_PROVIDERS_VERSION,
                    "C:/R/library/aisdk.providers",
                    "",
                )
            );
            let runtime = agent_runtime_status_from_probe(
                dependency_probe(stdout, true),
                Some(Path::new(r"D:\R\4.6.1\bin\Rscript.exe")),
                Some("R version 4.6.1"),
            );
            assert!(!runtime.available, "{status}");
            assert_eq!(runtime.status, "needs_attention", "{status}");
            assert_eq!(
                runtime.rscript.as_deref(),
                Some("D:/R/4.6.1/bin/Rscript.exe")
            );
            assert_eq!(runtime.r_version.as_deref(), Some("R version 4.6.1"));
            assert_eq!(
                runtime.aisdk_version.as_deref(),
                (!installed.is_empty()).then_some(installed)
            );
            assert!(runtime.error.as_deref().unwrap().contains(expected_summary));
            let core = runtime
                .dependencies
                .iter()
                .find(|dependency| dependency.package == "aisdk")
                .unwrap();
            assert_eq!(core.status, status);
            assert_eq!(
                core.resolved_path.as_deref(),
                (status != "missing").then_some("C:/R/library/aisdk")
            );
            assert!(
                core.remediation
                    .as_deref()
                    .unwrap()
                    .contains(REVIEWED_AISDK_REMOTE)
            );
            if matches!(status, "missing" | "incompatible_version") {
                assert!(core.remediation.as_deref().unwrap().contains("CRAN-only"));
            }
        }
    }

    #[test]
    fn provider_dependency_degrades_only_provider_adapters() {
        for status in [
            "missing",
            "incompatible_version",
            "namespace_load_failed",
            "incompatible_api",
        ] {
            let stdout = format!(
                "{}{}",
                dependency_marker(
                    "aisdk",
                    "ready",
                    "1.5.0",
                    MINIMUM_AGENT_AISDK_VERSION,
                    "C:/R/library/aisdk",
                    "",
                ),
                dependency_marker(
                    "aisdk.providers",
                    status,
                    if status == "missing" { "" } else { "0.1.0" },
                    MINIMUM_AGENT_AISDK_PROVIDERS_VERSION,
                    "C:/R/library/aisdk.providers",
                    "provider adapter fixture",
                )
            );
            let runtime = agent_runtime_status_from_probe(
                dependency_probe(stdout, true),
                Some(Path::new("C:/R/bin/Rscript.exe")),
                Some("R version 4.6.1"),
            );
            assert!(runtime.available, "{status}");
            assert_eq!(runtime.status, "degraded", "{status}");
            assert!(!runtime.provider_adapters_available);
            assert_eq!(runtime.provider_health, "dependency_unavailable");
            let provider = runtime
                .dependencies
                .iter()
                .find(|dependency| dependency.package == "aisdk.providers")
                .unwrap();
            assert_eq!(provider.status, status);
            assert!(
                provider
                    .remediation
                    .as_deref()
                    .unwrap()
                    .contains(REVIEWED_AISDK_PROVIDERS_REMOTE)
            );
            assert!(
                provider
                    .remediation
                    .as_deref()
                    .unwrap()
                    .contains("separately")
            );
        }
    }

    #[test]
    fn ready_and_process_failure_states_remain_structured_and_bounded() {
        let ready = agent_runtime_status_from_probe(
            dependency_probe(ready_dependency_markers(), true),
            Some(Path::new("C:/R/bin/Rscript.exe")),
            Some("R version 4.6.1"),
        );
        assert!(ready.available);
        assert_eq!(ready.status, "ready");
        assert!(ready.provider_adapters_available);
        assert_eq!(ready.provider_health, "dependency_ready");
        assert!(ready.error.is_none());

        let failed = agent_runtime_status_from_probe(
            ProbeProcessOutput {
                success: false,
                exit_code: None,
                stdout: String::new(),
                stderr: format!("token=secret\n{}", "x".repeat(6000)),
                elapsed_ms: 30_000,
                timed_out: true,
            },
            Some(Path::new("C:/R/bin/Rscript.exe")),
            Some("R version 4.6.1"),
        );
        assert!(!failed.available);
        assert_eq!(failed.status, "probe_failed");
        assert_eq!(failed.dependencies.len(), 2);
        assert!(
            failed
                .dependencies
                .iter()
                .all(|dependency| dependency.status == "probe_failed")
        );
        assert!(!serde_json::to_string(&failed).unwrap().contains("secret"));
        assert!(failed.error.as_deref().unwrap().len() <= 4200);
    }

    #[test]
    fn audit_command_uses_store_worker_without_waiting_for_workspace_lane() {
        let runtime = tokio::runtime::Runtime::new().unwrap();
        runtime.block_on(async {
            let tempdir = TempDir::new().unwrap();
            let project_root = tempdir.path().join("project-a");
            std::fs::create_dir_all(&project_root).unwrap();
            let store_path = tempdir.path().join("rho.sqlite");
            let state = test_app_state(tempdir.path(), &project_root, &store_path);
            let lane = Arc::new(WorkspaceBrokerLane::new(
                BrokerState::new("workspace.audit"),
                StoreExecutor::open(&store_path).await.unwrap(),
            ));
            let held_workspace = lane.lock().await;

            let response = tokio::time::timeout(
                Duration::from_millis(250),
                audit_reproducibility_with_state("project".to_string(), None, &state),
            )
            .await
            .expect("reproducibility audit waited for the held Workspace broker lane")
            .unwrap();
            assert_eq!(response.schema_version, 1);
            assert_eq!(response.scope, "project");
            assert_eq!(
                audit_reproducibility_with_state("unknown".to_string(), None, &state)
                    .await
                    .unwrap_err(),
                "invalid audit scope: unknown (expected 'project', 'project_current', 'run:<id>', or 'artifact:<id>')"
            );
            assert!(
                tokio::time::timeout(Duration::from_millis(20), lane.lock())
                    .await
                    .is_err(),
                "test did not keep the Workspace broker lane contended"
            );
            drop(held_workspace);
        });
    }

    #[test]
    fn editor_format_command_returns_the_typed_workspace_result() {
        let result = editor_format_result(json!({
            "execution_id": "run_1",
            "execution": {
                "kind": "rho.editor_format_result.v1",
                "ok": true,
                "status": "formatted",
                "path": "analysis.R",
                "document_version": 7
            },
            "workspace": {"workspace_id": "workspace_1"}
        }))
        .unwrap();

        assert_eq!(result["kind"], "rho.editor_format_result.v1");
        assert_eq!(result["status"], "formatted");
        assert_eq!(result["path"], "analysis.R");
        assert_eq!(result["document_version"], 7);
        assert!(result.get("execution").is_none());
    }

    #[test]
    fn editor_format_command_rejects_missing_or_untyped_workspace_results() {
        assert!(editor_format_result(json!({"workspace": {}})).is_err());
        assert!(
            editor_format_result(json!({
                "execution": {"kind": "rho.other_result.v1", "ok": true}
            }))
            .is_err()
        );
    }

    #[test]
    fn retries_only_scientific_workspace_execution() {
        assert!(run_is_retryable("workspace.execute", "user"));
        assert!(run_is_retryable("workspace.execute", "agent"));
        assert!(!run_is_retryable("environment.restore", "user"));
        assert!(!run_is_retryable("workspace.set_project_root", "system"));
        assert!(!run_is_retryable("workspace.bootstrap", "system"));
    }

    #[test]
    fn retry_preserves_the_admitted_source_range_and_replaces_only_parent_identity() {
        let original = json!({
            "code": "stop('boom')",
            "source_path": "analysis.R",
            "execution_mode": "selection",
            "document_version": 7,
            "parent_run_id": "older_parent",
            "source_range": {
                "start_line": 8,
                "start_column": 4,
                "end_line": 8,
                "end_column": 16
            }
        });
        let retried = retry_run_arguments(&original.to_string(), "failed_run").unwrap();

        assert_eq!(retried["source_range"], original["source_range"]);
        assert_eq!(retried["code"], original["code"]);
        assert_eq!(retried["source_path"], original["source_path"]);
        assert_eq!(retried["document_version"], original["document_version"]);
        assert_eq!(retried["parent_run_id"], "failed_run");
        assert!(retry_run_arguments("[]", "failed_run").is_err());
    }

    #[test]
    fn source_claim_snapshot_is_bounded_and_content_bound() {
        let directory = TempDir::new().unwrap();
        let project_path = directory.path().join("project");
        std::fs::create_dir_all(project_path.join("reports")).unwrap();
        let project = project_path.canonicalize().unwrap();
        std::fs::write(project.join("reports/demo.qmd"), "one\ntwo\nthree\n").unwrap();

        let (digest, excerpt) = source_claim_snapshot(&project, "reports/demo.qmd", 2, 3).unwrap();
        assert_eq!(digest.len(), 64);
        assert_eq!(excerpt, "two\nthree");
        assert!(source_claim_snapshot(&project, "../outside.qmd", 1, 1).is_err());
        assert!(source_claim_snapshot(&project, "reports/demo.qmd", 0, 1).is_err());
        assert!(source_claim_snapshot(&project, "reports/demo.qmd", 1, 201).is_err());

        std::fs::write(
            project.join("reports/demo.qmd"),
            "one\ntwo changed\nthree\n",
        )
        .unwrap();
        let changed = source_claim_snapshot(&project, "reports/demo.qmd", 2, 3).unwrap();
        assert_ne!(changed.0, digest);
        assert_ne!(changed.1, excerpt);
    }

    #[test]
    fn lockfile_inventory_arguments_normalize_root_and_clamp_limit() {
        let root = Path::new("C:\\projects\\rho-lockfile");
        let low = lockfile_inventory_arguments(root, Some(0));
        let high = lockfile_inventory_arguments(root, Some(900));

        assert_eq!(low["project_root"], "C:/projects/rho-lockfile");
        assert_eq!(low["limit"], 1);
        assert_eq!(high["limit"], 500);
    }

    #[test]
    fn workspace_project_root_code_uses_user_readable_windows_paths() {
        assert_eq!(
            workspace_project_root_code(Path::new(r"\\?\E:\YuNotebooks\project")).unwrap(),
            r#"setwd("E:/YuNotebooks/project")"#
        );
        assert_eq!(
            workspace_project_root_code(Path::new(r"\\?\UNC\server\share\project")).unwrap(),
            r#"setwd("//server/share/project")"#
        );
        assert_eq!(
            workspace_project_root_code(Path::new(r"E:\路径 含 空格\project")).unwrap(),
            r#"setwd("E:/路径 含 空格/project")"#
        );
    }

    #[test]
    fn durable_project_root_matches_store_identity_on_windows() {
        assert_eq!(
            durable_project_root(Path::new(r"E:\YuNotebooks\project\")),
            "E:/YuNotebooks/project"
        );
        assert_eq!(
            durable_project_root(Path::new(r"\\?\E:\YuNotebooks\project\")),
            "//?/E:/YuNotebooks/project"
        );
        assert_eq!(
            durable_project_root(Path::new(r"\\?\UNC\server\share\project\")),
            "//?/UNC/server/share/project"
        );
    }

    #[test]
    fn plot_queries_share_the_normalized_windows_project_key() {
        let directory = TempDir::new().unwrap();
        let mut store = Store::open(directory.path().join("rho.sqlite")).unwrap();
        let raw_root = Path::new(r"\\?\E:\Rho\project\");
        let project_root = durable_project_root(raw_root);
        let workspace_id = "desktop_plot_session";
        store.set_project_root(Some(&project_root)).unwrap();
        store
            .create_plot_artifact(&PlotArtifactDraft {
                plot_id: "plot_windows_root".to_string(),
                run_id: "run_windows_root".to_string(),
                project_root: Some(project_root.clone()),
                source_path: Some("analysis.R".to_string()),
                execution_mode: Some("file".to_string()),
                document_version: Some(1),
                workspace_id: Some(workspace_id.to_string()),
                state_revision: Some(1),
                project_revision: Some(1),
                media_type: "image/png".to_string(),
                payload_json: "{\"image/png\":\"aGVsbG8=\"}".to_string(),
                provenance_complete: true,
            })
            .unwrap();
        let other_project_root = "//?/E:/Rho/other-project";
        let other_payload = "{\"image/png\":\"b3RoZXI=\"}";
        store
            .create_plot_artifact(&PlotArtifactDraft {
                plot_id: "plot_other_project".to_string(),
                run_id: "run_other_project".to_string(),
                project_root: Some(other_project_root.to_string()),
                source_path: Some("analysis.R".to_string()),
                execution_mode: Some("file".to_string()),
                document_version: Some(1),
                workspace_id: Some(workspace_id.to_string()),
                state_revision: Some(1),
                project_revision: Some(1),
                media_type: "image/png".to_string(),
                payload_json: other_payload.to_string(),
                provenance_complete: true,
            })
            .unwrap();

        assert!(
            store
                .list_plot_artifacts(
                    Some(10),
                    Some(raw_root.to_string_lossy().as_ref()),
                    Some(workspace_id),
                    true,
                )
                .unwrap()
                .is_empty()
        );
        assert_eq!(
            store
                .list_plot_artifacts(Some(10), Some(&project_root), Some(workspace_id), true,)
                .unwrap()
                .len(),
            1
        );
        assert_eq!(
            store
                .project_retention_summary(&project_root, Some(workspace_id))
                .unwrap()
                .session
                .plot_history_count,
            1
        );
        assert_eq!(
            store
                .prune_plot_artifact_payloads(Some(&project_root), Some(workspace_id), true,)
                .unwrap()
                .pruned_count,
            1
        );
        assert_eq!(
            store
                .clear_plot_artifacts(Some(&project_root), Some(workspace_id), true,)
                .unwrap(),
            1
        );
        assert_eq!(
            store
                .list_plot_artifacts(Some(10), Some(other_project_root), Some(workspace_id), true,)
                .unwrap()
                .len(),
            1
        );
        assert_eq!(
            store
                .get_plot_artifact(other_project_root, "plot_other_project")
                .unwrap()
                .unwrap()
                .payload_json,
            other_payload
        );
    }

    fn test_runtime_config(store_path: &Path, data_dir: &Path) -> RuntimeConfig {
        RuntimeConfig {
            data_dir: data_dir.to_path_buf(),
            kernelspec: data_dir.join("kernel.json"),
            rscript: Path::new("Rscript").to_path_buf(),
            r_version: "R version 4.6.1".to_string(),
            r_home: "C:/R".to_string(),
            process_path: std::env::var_os("PATH").unwrap_or_default(),
            r_profile_user: None,
            r_environ_user: None,
            bridge_package: data_dir.join("rho.bridge"),
            agent_package: data_dir.join("rho.agent"),
            agent_runtime: agent_runtime_status_from_probe(
                dependency_probe(ready_dependency_markers(), true),
                Some(Path::new("Rscript")),
                Some("R version 4.6.1"),
            ),
            store_path: store_path.to_path_buf(),
        }
    }

    fn test_app_state(data_dir: &Path, project_root: &Path, store_path: &Path) -> AppState {
        test_app_state_with_extension_mode(
            data_dir,
            project_root,
            store_path,
            InternalExtensionRuntimeMode::Legacy,
        )
    }

    fn test_app_state_with_extension_mode(
        data_dir: &Path,
        project_root: &Path,
        store_path: &Path,
        mode: InternalExtensionRuntimeMode,
    ) -> AppState {
        let diagnostics: Arc<dyn DiagnosticSink> = Arc::new(|_: ExtensionDiagnostic| {});
        let extension_host = Arc::new(
            ExtensionHost::new_with_host_capabilities(
                mode,
                vec![
                    rho_extension_runtime::CapabilityDeclaration::new(
                        super::runs_broker_capability_id(),
                        1,
                    ),
                    rho_extension_runtime::CapabilityDeclaration::new(
                        super::workspace_probe_broker_capability_id(),
                        1,
                    ),
                ],
                diagnostics,
                LifecycleDeadlines::default(),
            )
            .unwrap(),
        );
        test_app_state_with_extension_host(data_dir, project_root, store_path, extension_host)
    }

    async fn test_candidate_extension_host_with_application_plugins() -> Arc<ExtensionHost> {
        let diagnostics: Arc<dyn DiagnosticSink> = Arc::new(|_: ExtensionDiagnostic| {});
        Arc::new(
            ExtensionHost::new_with_application_plugins(
                InternalExtensionRuntimeMode::Candidate,
                vec![
                    rho_extension_runtime::CapabilityDeclaration::new(
                        super::runs_broker_capability_id(),
                        1,
                    ),
                    rho_extension_runtime::CapabilityDeclaration::new(
                        super::workspace_probe_broker_capability_id(),
                        1,
                    ),
                ],
                super::internal_plugins_for_scope(
                    &rho_extension_runtime::ScopePolicy::application_kind(),
                ),
                Arc::new(rho_extension_runtime::RejectingBrokerFacade),
                diagnostics,
                LifecycleDeadlines::default(),
            )
            .await
            .unwrap(),
        )
    }

    fn test_app_state_with_extension_host(
        data_dir: &Path,
        project_root: &Path,
        store_path: &Path,
        extension_host: Arc<ExtensionHost>,
    ) -> AppState {
        AppState {
            data_dir: data_dir.to_path_buf(),
            ark: data_dir.join("ark.exe"),
            config: std::sync::RwLock::new(Some(test_runtime_config(store_path, data_dir))),
            selected_rscript: std::sync::RwLock::new(None),
            startup: std::sync::RwLock::new(StartupView {
                phase: "shell_ready".to_string(),
                busy: false,
                runtime: None,
                issue: None,
            }),
            project_store: ProjectSessionStore::new(data_dir.to_path_buf()).unwrap(),
            project_root: RwLock::new(project_root.to_path_buf()),
            project_watcher: Mutex::new(None),
            session: RwLock::new(None),
            context: Mutex::new(None),
            store_executor: tokio::sync::OnceCell::new(),
            approvals: Arc::new(PendingApprovalRegistry::default()),
            environment_approvals: Arc::new(PendingApprovalRegistry::default()),
            project_transition_gate: Arc::new(Mutex::new(())),
            extension_host,
            plugin_permissions: crate::workspace_plugins::PendingPluginPermissionRegistry::new(),
            agent_tasks: Arc::new(Mutex::new(HashMap::new())),
            agent_workspace_lane: Arc::new(AgentWorkspaceLane::default()),
            agent_file_mutations: Arc::new(AgentFileMutationRegistry::default()),
            agent_file_apply_test_control: AgentFileApplyTestControl::default(),
            agent_llm_test_control: AgentModelTestControl::default(),
            switch_test_control: SwitchTestControl::default(),
            shutdown_started: AtomicBool::new(false),
            render_jobs: Arc::new(Mutex::new(HashMap::new())),
            render_tasks: Arc::new(Mutex::new(HashMap::new())),
            surface_runtime: crate::surface_runtime::SurfaceRuntimeState::default(),
            plugin_surface_runtime:
                crate::plugin_surface_runtime::PluginSurfaceRuntimeState::default(),
            check_runtime: crate::check_runtime::CheckRuntimeState::default(),
            studio_runtime: crate::studio_runtime::StudioRuntimeState::default(),
            runtime_registry: crate::runtime_registry::RuntimeRegistryState::default(),
            resource_registry: crate::resource_registry::ResourceRegistryState::default(),
            ui_profile: crate::ui_profile::ProjectUiProfileState::new(data_dir.to_path_buf())
                .unwrap(),
            ui_runtime: crate::ui_runtime::UiRuntimeState::default(),
        }
    }

    #[tokio::test]
    async fn evidence_store_executor_is_shared_and_project_isolated() {
        let tempdir = tempfile::tempdir().unwrap();
        let project_a = tempdir.path().join("project-a");
        let project_b = tempdir.path().join("project-b");
        std::fs::create_dir_all(&project_a).unwrap();
        std::fs::create_dir_all(&project_b).unwrap();
        let store_path = tempdir.path().join("rho.sqlite");
        let state = test_app_state(tempdir.path(), &project_a, &store_path);

        let first = store_executor(&state).await.unwrap();
        let first_address = std::ptr::from_ref(first);
        first
            .create_evidence_entry(EvidenceEntryDraft {
                project_root: normalize_project_root(project_a.to_string_lossy().as_ref()),
                title: "Project A evidence".to_string(),
                notes: String::new(),
                doi: None,
                run_id: None,
                artifact_id: None,
            })
            .await
            .unwrap();

        let second = store_executor(&state).await.unwrap();
        assert_eq!(first_address, std::ptr::from_ref(second));
        assert_eq!(
            second
                .list_evidence_entries(
                    normalize_project_root(project_a.to_string_lossy().as_ref()),
                    None,
                    None,
                )
                .await
                .unwrap()
                .len(),
            1
        );
        assert!(
            second
                .list_evidence_entries(
                    normalize_project_root(project_b.to_string_lossy().as_ref()),
                    None,
                    None,
                )
                .await
                .unwrap()
                .is_empty()
        );
    }

    #[tokio::test]
    async fn plugin_runtime_context_does_not_wait_for_workspace_lane() {
        let directory = tempfile::tempdir().unwrap();
        let project_root = directory.path().join("project");
        std::fs::create_dir_all(&project_root).unwrap();
        let store_path = directory.path().join("rho.sqlite");
        let state = test_app_state(directory.path(), &project_root, &store_path);
        install_test_context(&state, Store::open(&store_path).unwrap()).await;

        let lane = active_context(&state).await.unwrap();
        let held_workspace = lane.lock().await;
        let context = tokio::time::timeout(
            Duration::from_millis(250),
            crate::commands::plugins::runtime_context(&state),
        )
        .await
        .expect("plugin runtime context waited for the held Workspace lane")
        .unwrap();

        assert_eq!(
            context.project_root,
            normalize_project_root(project_root.to_string_lossy().as_ref())
        );
        assert_eq!(
            context.workspace.as_ref().unwrap().workspace_id,
            "ws-file-test"
        );
        assert!(
            tokio::time::timeout(Duration::from_millis(20), lane.lock())
                .await
                .is_err(),
            "test did not keep the Workspace broker lane contended"
        );
        drop(held_workspace);
    }

    fn create_run_fixture(store: &mut Store, project_root: &str, run_id: &str, code: &str) {
        store
            .create_run(&RunDraft {
                run_id: run_id.to_string(),
                parent_run_id: None,
                project_root: project_root.to_string(),
                origin: "user".to_string(),
                request_type: "workspace.execute".to_string(),
                operation_class: "state_capable".to_string(),
                code: code.to_string(),
                arguments_json: "{}".to_string(),
                source_path: Some("analysis.R".to_string()),
                execution_mode: Some("console".to_string()),
                document_version: Some(1),
                workspace_id: format!("ws-{run_id}"),
                state_revision_before: 1,
                project_revision_before: 1,
                environment_snapshot_id: None,
            })
            .unwrap();
        store.update_run_status(run_id, "completed", None).unwrap();
    }

    fn add_agent_file_proposal(
        store: &mut Store,
        project_root: &str,
        conversation_id: &str,
        turn_id: &str,
        path: &str,
        operation: &str,
        content: &str,
        editor_context: Option<serde_json::Value>,
    ) -> i64 {
        store
            .create_agent_turn_with_conversation(
                &AgentConversationDraft {
                    conversation_id: conversation_id.to_string(),
                    project_root: project_root.to_string(),
                    title: format!("Conversation {conversation_id}"),
                    legacy_unthreaded: false,
                },
                &AgentTurnDraft {
                    turn_id: turn_id.to_string(),
                    project_root: project_root.to_string(),
                    mode: "act".to_string(),
                    prompt: format!("Edit {path}"),
                    model: "test-model".to_string(),
                    workspace_id: "ws-file-test".to_string(),
                    state_revision_before: 0,
                    project_revision_before: 0,
                },
            )
            .unwrap();
        store
            .append_agent_turn_event(&AgentTurnEventDraft {
                turn_id: turn_id.to_string(),
                event_type: "agent.user_prompt".to_string(),
                title: "You".to_string(),
                body: Some(format!("Edit {path}")),
                status: "completed".to_string(),
                tool: None,
                request_id: None,
                code: None,
                details_json: json!({
                    "task_kind": "agent_turn",
                    "editor_context": editor_context
                })
                .to_string(),
            })
            .unwrap();
        let event_id = store
            .append_agent_turn_event(&AgentTurnEventDraft {
                turn_id: turn_id.to_string(),
                event_type: "tool.call_completed".to_string(),
                title: "Tool completed · propose_file_edit".to_string(),
                body: Some(
                    json!({
                        "kind": "rho.file_edit_proposal",
                        "path": path,
                        "operation": operation,
                        "content": content
                    })
                    .to_string(),
                ),
                status: "completed".to_string(),
                tool: Some("propose_file_edit".to_string()),
                request_id: None,
                code: None,
                details_json: json!({"success": true}).to_string(),
            })
            .unwrap();
        store
            .finish_agent_turn(&AgentTurnFinish {
                turn_id: turn_id.to_string(),
                status: "completed".to_string(),
                terminal_reason: Some("completed".to_string()),
                workspace_id_after: Some("ws-file-test".to_string()),
                state_revision_after: Some(0),
                project_revision_after: Some(0),
                final_message: Some("Proposal ready".to_string()),
                error_message: None,
            })
            .unwrap();
        event_id
    }

    fn add_agent_file_mutation_start(
        store: &mut Store,
        turn_id: &str,
        path: &str,
        proposal_event_id: i64,
        mutation_id: &str,
        expected_before: &str,
        intended_after: &str,
    ) {
        append_agent_file_mutation_event(
            store,
            turn_id,
            "file_edit.mutation_started",
            "Agent file mutation admitted",
            "running",
            path,
            "append",
            proposal_event_id,
            json!({
                "mutation_id": mutation_id,
                "action": "apply",
                "path": path,
                "operation": "append",
                "proposal_event_id": proposal_event_id,
                "expected_before_sha256": text_sha256(expected_before),
                "expected_before_absent": false,
                "intended_after_sha256": text_sha256(intended_after),
                "intended_after_absent": false
            }),
        )
        .unwrap();
    }

    async fn install_test_context(state: &AppState, mut store: Store) {
        let broker = BrokerState::new("ws-file-test");
        store.save_identity(broker.identity()).unwrap();
        let executor = store_executor(state).await.unwrap().clone();
        *state.context.lock().await = Some(Arc::new(WorkspaceBrokerLane::new(broker, executor)));
    }

    #[test]
    fn project_identity_persistence_rejection_preserves_truth_and_worker_recovers() {
        let runtime = tokio::runtime::Runtime::new().unwrap();
        runtime.block_on(async {
            let tempdir = TempDir::new().unwrap();
            let store_path = tempdir.path().join("rho.sqlite");
            let executor = StoreExecutor::open(&store_path).await.unwrap();
            let mut broker = BrokerState::new("revision-worker-test");
            let initial_identity = broker.identity().clone();
            persist_workspace_identity(&executor, initial_identity.clone())
                .await
                .unwrap();

            let connection = rusqlite::Connection::open(&store_path).unwrap();
            connection
                .execute_batch(
                    "CREATE TRIGGER reject_workspace_identity_update
                     BEFORE UPDATE ON workspace_identity
                     BEGIN
                       SELECT RAISE(ABORT, 'injected identity persistence failure');
                     END;",
                )
                .unwrap();

            broker.project_changed();
            let next_identity = broker.identity().clone();
            let error = persist_workspace_identity(&executor, next_identity.clone())
                .await
                .unwrap_err();
            assert!(
                error
                    .to_string()
                    .contains("injected identity persistence failure")
            );
            let durable_after_rejection = executor
                .run_service(|store| store.load_identity())
                .await
                .unwrap();
            assert_eq!(durable_after_rejection, Some(initial_identity));

            connection
                .execute_batch("DROP TRIGGER reject_workspace_identity_update;")
                .unwrap();
            persist_workspace_identity(&executor, next_identity.clone())
                .await
                .unwrap();
            let durable_after_retry = executor
                .run_service(|store| store.load_identity())
                .await
                .unwrap();
            assert_eq!(durable_after_retry, Some(next_identity));
        });
    }

    #[test]
    fn file_proposal_structure_rejects_empty_selection_and_invalid_cursor_range() {
        let empty_selection = PersistedAgentFileProposal {
            path: "scatter_plot_example.R".to_string(),
            operation: "replace_selection".to_string(),
            content: "replacement".to_string(),
            editor_context: Some(json!({
                "active_path": "scatter_plot_example.R",
                "selection_start": 527,
                "selection_end": 527,
                "selection_text": ""
            })),
        };
        let error = validate_persisted_agent_file_proposal_structure(&empty_selection).unwrap_err();
        assert!(error.to_string().contains("AGENT_FILE_PROPOSAL_INVALID"));
        assert!(error.to_string().contains("non-empty text"));

        let invalid_cursor = PersistedAgentFileProposal {
            operation: "insert_at_cursor".to_string(),
            editor_context: Some(json!({
                "active_path": "scatter_plot_example.R",
                "selection_start": 10,
                "selection_end": 12,
                "selection_text": "ab"
            })),
            ..empty_selection.clone()
        };
        assert!(
            validate_persisted_agent_file_proposal_structure(&invalid_cursor)
                .unwrap_err()
                .to_string()
                .contains("empty captured range")
        );

        let valid = PersistedAgentFileProposal {
            editor_context: Some(json!({
                "active_path": "scatter_plot_example.R",
                "selection_start": 10,
                "selection_end": 12,
                "selection_text": "ab"
            })),
            ..empty_selection
        };
        validate_persisted_agent_file_proposal_structure(&valid).unwrap();
    }

    #[test]
    fn file_proposal_turn_must_be_terminal_before_mutation_admission() {
        let directory = TempDir::new().unwrap();
        let mut store = Store::open(directory.path().join("rho.sqlite")).unwrap();
        let project_root = "D:/Rho/project";
        store
            .create_agent_turn_with_conversation(
                &AgentConversationDraft {
                    conversation_id: "conversation-running-proposal".to_string(),
                    project_root: project_root.to_string(),
                    title: "Running proposal".to_string(),
                    legacy_unthreaded: false,
                },
                &AgentTurnDraft {
                    turn_id: "turn-running-proposal".to_string(),
                    project_root: project_root.to_string(),
                    mode: "act".to_string(),
                    prompt: "Edit the file".to_string(),
                    model: "test-model".to_string(),
                    workspace_id: "ws-file-test".to_string(),
                    state_revision_before: 0,
                    project_revision_before: 0,
                },
            )
            .unwrap();

        let error =
            ensure_agent_file_proposal_turn_terminal(&store, project_root, "turn-running-proposal")
                .unwrap_err();
        assert!(error.to_string().contains("AGENT_FILE_TURN_ACTIVE"));

        store
            .finish_agent_turn(&AgentTurnFinish {
                turn_id: "turn-running-proposal".to_string(),
                status: "completed".to_string(),
                terminal_reason: Some("completed".to_string()),
                workspace_id_after: Some("ws-file-test".to_string()),
                state_revision_after: Some(0),
                project_revision_after: Some(0),
                final_message: Some("Proposal ready".to_string()),
                error_message: None,
            })
            .unwrap();
        ensure_agent_file_proposal_turn_terminal(&store, project_root, "turn-running-proposal")
            .unwrap();
    }

    fn create_waiting_approval(
        store: &mut Store,
        project_root: &str,
        turn_id: &str,
        request_id: &str,
    ) {
        store
            .create_agent_turn(&AgentTurnDraft {
                turn_id: turn_id.to_string(),
                project_root: project_root.to_string(),
                mode: "ask".to_string(),
                prompt: "Need approval".to_string(),
                model: "test-model".to_string(),
                workspace_id: "ws-1".to_string(),
                state_revision_before: 1,
                project_revision_before: 1,
            })
            .unwrap();
        store
            .create_approval_request(&ApprovalRequestDraft {
                request_id: request_id.to_string(),
                turn_id: turn_id.to_string(),
                project_root: project_root.to_string(),
                tool: "write_file".to_string(),
                policy: "ask".to_string(),
                arguments_json: "{}".to_string(),
                code: None,
                workspace_id: "ws-1".to_string(),
                state_revision: 1,
                project_revision: 1,
            })
            .unwrap();
    }

    fn assert_run_summaries_equal(
        actual: Vec<rho_store::RunSummary>,
        expected: &[rho_store::RunSummary],
    ) {
        assert_eq!(
            serde_json::to_value(actual).unwrap(),
            serde_json::to_value(expected).unwrap()
        );
    }

    fn save_session_fixture(
        state: &AppState,
        root: &Path,
        active_document: &str,
        left_panel: u32,
    ) -> ProjectSessionSnapshot {
        let snapshot = ProjectSessionSnapshot {
            open_documents: vec![],
            closed_documents: vec![],
            active_document: Some(active_document.to_string()),
            selected_agent_conversation_id: None,
            panels: crate::project::PanelSizes {
                left: Some(left_panel),
                right: Some(300),
                dock: Some(240),
            },
        };
        state.project_store.save_session(root, &snapshot).unwrap();
        snapshot
    }

    #[test]
    fn project_switch_preflight_blocks_active_run() {
        let runtime = tokio::runtime::Runtime::new().unwrap();
        runtime.block_on(async {
            let tempdir = TempDir::new().unwrap();
            let project_root = tempdir.path().join("project-a");
            std::fs::create_dir_all(&project_root).unwrap();
            let project_root = project_root.canonicalize().unwrap();
            let store_path = tempdir.path().join("rho.sqlite");
            let mut store = Store::open(&store_path).unwrap();
            let normalized_root = normalize_project_root(project_root.to_string_lossy().as_ref());
            store.set_project_root(Some(&normalized_root)).unwrap();
            store
                .create_run(&RunDraft {
                    run_id: "run-active".to_string(),
                    parent_run_id: None,
                    project_root: normalized_root.clone(),
                    origin: "user".to_string(),
                    request_type: "workspace.execute".to_string(),
                    operation_class: "scientific".to_string(),
                    code: "x <- 1".to_string(),
                    arguments_json: "{}".to_string(),
                    source_path: None,
                    execution_mode: Some("console".to_string()),
                    document_version: None,
                    workspace_id: "ws-1".to_string(),
                    state_revision_before: 1,
                    project_revision_before: 1,
                    environment_snapshot_id: None,
                })
                .unwrap();
            let state = test_app_state(tempdir.path(), &project_root, &store_path);

            let blocker = project_switch_blocker(&state).await.unwrap().unwrap();
            assert_eq!(blocker.kind, ProjectSwitchBlockerKind::ActiveRun);
            assert_eq!(blocker.run_id.as_deref(), Some("run-active"));
        });
    }

    #[test]
    fn project_switch_preflight_blocks_only_current_project_render_jobs() {
        let runtime = tokio::runtime::Runtime::new().unwrap();
        runtime.block_on(async {
            let tempdir = TempDir::new().unwrap();
            let project_root = tempdir.path().join("project-a");
            std::fs::create_dir_all(&project_root).unwrap();
            let store_path = tempdir.path().join("rho.sqlite");
            let mut store = Store::open(&store_path).unwrap();
            let normalized_root = normalize_project_root(project_root.to_string_lossy().as_ref());
            store.set_project_root(Some(&normalized_root)).unwrap();
            let state = test_app_state(tempdir.path(), &project_root, &store_path);
            state.render_jobs.lock().await.insert(
                "render_foreign".to_string(),
                render_job_fixture("render_foreign", "D:/other-project", "submitted"),
            );
            assert!(project_switch_blocker(&state).await.unwrap().is_none());

            state.render_jobs.lock().await.insert(
                "render_current".to_string(),
                render_job_fixture("render_current", &normalized_root, "submitted"),
            );
            let blocker = project_switch_blocker(&state).await.unwrap().unwrap();
            assert_eq!(blocker.kind, ProjectSwitchBlockerKind::ActiveRun);
            assert_eq!(blocker.run_id.as_deref(), Some("render_current"));
            assert_eq!(blocker.operation_status.as_deref(), Some("submitted"));
        });
    }

    #[test]
    fn agent_admission_allows_two_read_only_conversations_and_rejects_a_third() {
        let runtime = tokio::runtime::Runtime::new().unwrap();
        runtime.block_on(async {
            let first = tauri::async_runtime::spawn(async { std::future::pending::<()>().await });
            let second = tauri::async_runtime::spawn(async { std::future::pending::<()>().await });
            let mut tasks = HashMap::from([(
                "turn-a".to_string(),
                AgentTaskEntry {
                    conversation_id: "conversation-a".to_string(),
                    handle: first,
                },
            )]);
            assert_eq!(
                agent_turn_admission_error(&tasks, Some("conversation-b"), "plan"),
                None
            );
            tasks.insert(
                "turn-b".to_string(),
                AgentTaskEntry {
                    conversation_id: "conversation-b".to_string(),
                    handle: second,
                },
            );
            assert_eq!(
                agent_turn_admission_error(&tasks, Some("conversation-c"), "ask"),
                Some("AGENT_CONCURRENCY_LIMIT: At most two Agent turns can run at once.")
            );
            for (_, task) in tasks {
                task.handle.abort();
            }
        });
    }

    #[test]
    fn agent_admission_rejects_same_conversation_but_allows_bounded_parallel_act() {
        let runtime = tokio::runtime::Runtime::new().unwrap();
        runtime.block_on(async {
            let first = tauri::async_runtime::spawn(async { std::future::pending::<()>().await });
            let tasks = HashMap::from([(
                "turn-a".to_string(),
                AgentTaskEntry {
                    conversation_id: "conversation-a".to_string(),
                    handle: first,
                },
            )]);
            assert_eq!(
                agent_turn_admission_error(&tasks, Some("conversation-a"), "plan"),
                Some(
                    "AGENT_CONVERSATION_BUSY: This Conversation already has an active Agent turn."
                )
            );
            assert_eq!(
                agent_turn_admission_error(&tasks, Some("conversation-b"), "act"),
                None
            );
            for (_, task) in tasks {
                task.handle.abort();
            }

            let act = tauri::async_runtime::spawn(async { std::future::pending::<()>().await });
            let act_tasks = HashMap::from([(
                "turn-act".to_string(),
                AgentTaskEntry {
                    conversation_id: "conversation-act".to_string(),
                    handle: act,
                },
            )]);
            assert_eq!(
                agent_turn_admission_error(&act_tasks, Some("conversation-b"), "ask"),
                None
            );
            for (_, task) in act_tasks {
                task.handle.abort();
            }
        });
    }

    #[test]
    fn agent_file_lanes_are_per_path_and_block_project_switch_until_released() {
        let runtime = tokio::runtime::Runtime::new().unwrap();
        runtime.block_on(async {
            let tempdir = TempDir::new().unwrap();
            let project_root = tempdir.path().join("project-a");
            std::fs::create_dir_all(&project_root).unwrap();
            let store_path = tempdir.path().join("rho.sqlite");
            let mut store = Store::open(&store_path).unwrap();
            let normalized_root = normalize_project_root(project_root.to_string_lossy().as_ref());
            store.set_project_root(Some(&normalized_root)).unwrap();
            drop(store);
            let state = test_app_state(tempdir.path(), &project_root, &store_path);

            let first_lane = state
                .agent_file_mutations
                .lane(&format!("{normalized_root}\0analysis.R"))
                .await;
            let same_lane = state
                .agent_file_mutations
                .lane(&format!("{normalized_root}\0analysis.R"))
                .await;
            let other_lane = state
                .agent_file_mutations
                .lane(&format!("{normalized_root}\0report.R"))
                .await;
            assert!(Arc::ptr_eq(&first_lane, &same_lane));
            assert!(!Arc::ptr_eq(&first_lane, &other_lane));
            let _first_guard = first_lane.lock().await;
            assert!(same_lane.try_lock().is_err());
            assert!(other_lane.try_lock().is_ok());

            let claim =
                state
                    .agent_file_mutations
                    .register(&normalized_root, "turn-file", "analysis.R");
            let blocker = project_switch_blocker(&state).await.unwrap().unwrap();
            assert_eq!(blocker.kind, ProjectSwitchBlockerKind::AgentFileMutation);
            assert_eq!(blocker.turn_id.as_deref(), Some("turn-file"));
            assert_eq!(
                blocker.operation_status.as_deref(),
                Some("queued:analysis.R")
            );
            drop(claim);
            assert!(project_switch_blocker(&state).await.unwrap().is_none());
        });
    }

    #[test]
    fn project_transition_orders_file_claim_before_switch_preflight() {
        let runtime = tokio::runtime::Runtime::new().unwrap();
        runtime.block_on(async {
            let tempdir = TempDir::new().unwrap();
            let project_a = tempdir.path().join("project-a");
            let project_b = tempdir.path().join("project-b");
            std::fs::create_dir_all(&project_a).unwrap();
            std::fs::create_dir_all(&project_b).unwrap();
            let project_a = project_a.canonicalize().unwrap();
            let file = project_a.join("analysis.R");
            let before = "value <- 1\n";
            std::fs::write(&file, before).unwrap();
            let store_path = tempdir.path().join("rho.sqlite");
            let mut store = Store::open(&store_path).unwrap();
            let normalized_root = normalize_project_root(project_a.to_string_lossy().as_ref());
            store.set_project_root(Some(&normalized_root)).unwrap();
            let event_id = add_agent_file_proposal(
                &mut store,
                &normalized_root,
                "conversation-transition",
                "turn-transition",
                "analysis.R",
                "append",
                "changed <- TRUE\n",
                None,
            );
            drop(store);

            let state = Arc::new(test_app_state(tempdir.path(), &project_a, &store_path));
            let lane = state
                .agent_file_mutations
                .lane(&format!("{normalized_root}\0analysis.R"))
                .await;
            let lane_guard = lane.lock().await;

            let apply_state = state.clone();
            let (apply_started_tx, apply_started_rx) = oneshot::channel();
            let apply = tokio::spawn(async move {
                let _ = apply_started_tx.send(());
                apply_agent_file_edit_state(
                    AgentFileApplyRequest {
                        turn_id: "turn-transition".to_string(),
                        proposal_event_id: event_id,
                        path: "analysis.R".to_string(),
                        expected_disk_sha256: Some(text_sha256(before)),
                        before_content: before.to_string(),
                    },
                    &apply_state,
                )
                .await
            });
            apply_started_rx.await.unwrap();
            // Do not infer Tokio lock acquisition order from spawn order. The
            // product invariant starts only after Apply has registered its
            // queued claim while waiting for the per-file lane.
            tokio::time::timeout(Duration::from_secs(5), async {
                loop {
                    if state
                        .agent_file_mutations
                        .blocker(&normalized_root)
                        .is_some()
                    {
                        break;
                    }
                    tokio::task::yield_now().await;
                }
            })
            .await
            .expect("Agent file mutation claim was not registered before project switch preflight");

            let switch_state = state.clone();
            let (switch_started_tx, switch_started_rx) = oneshot::channel();
            let switch = tokio::spawn(async move {
                let _ = switch_started_tx.send(());
                switch_project_with_watcher_factory(project_b, None, &switch_state, |_| {
                    Ok(ProjectWatcherControl::noop())
                })
                .await
            });
            switch_started_rx.await.unwrap();

            let response = tokio::time::timeout(Duration::from_secs(5), switch)
                .await
                .expect("project switch did not reach its preflight")
                .unwrap()
                .unwrap();
            assert_eq!(response.status, "blocked");
            let blocker = response.blocker.unwrap();
            assert_eq!(blocker.kind, ProjectSwitchBlockerKind::AgentFileMutation);
            assert_eq!(blocker.turn_id.as_deref(), Some("turn-transition"));
            assert_eq!(std::fs::read_to_string(&file).unwrap(), before);

            assert_eq!(
                state
                    .agent_file_mutations
                    .cancel_queued_turn("turn-transition"),
                1
            );
            drop(lane_guard);
            let error = apply.await.unwrap().unwrap_err().to_string();
            assert!(error.contains("AGENT_FILE_CANCELLED"), "{error}");
            assert_eq!(std::fs::read_to_string(&file).unwrap(), before);
            assert!(
                state
                    .agent_file_mutations
                    .blocker(&normalized_root)
                    .is_none()
            );
        });
    }

    #[test]
    fn different_agent_files_reach_disk_without_waiting_for_the_global_context_lock() {
        let runtime = tokio::runtime::Runtime::new().unwrap();
        runtime.block_on(async {
            let tempdir = TempDir::new().unwrap();
            let project_root = tempdir.path().join("project-a");
            std::fs::create_dir_all(&project_root).unwrap();
            let project_root = project_root.canonicalize().unwrap();
            let first_path = project_root.join("first.R");
            let second_path = project_root.join("second.R");
            let first_before = "first <- 1\n";
            let second_before = "second <- 1\n";
            std::fs::write(&first_path, first_before).unwrap();
            std::fs::write(&second_path, second_before).unwrap();
            let store_path = tempdir.path().join("rho.sqlite");
            let mut store = Store::open(&store_path).unwrap();
            let normalized_root = normalize_project_root(project_root.to_string_lossy().as_ref());
            store.set_project_root(Some(&normalized_root)).unwrap();
            let first_event = add_agent_file_proposal(
                &mut store,
                &normalized_root,
                "conversation-first-file",
                "turn-first-file",
                "first.R",
                "append",
                "first_done <- TRUE\n",
                None,
            );
            let second_event = add_agent_file_proposal(
                &mut store,
                &normalized_root,
                "conversation-second-file",
                "turn-second-file",
                "second.R",
                "append",
                "second_done <- TRUE\n",
                None,
            );
            let state = Arc::new(test_app_state(tempdir.path(), &project_root, &store_path));
            install_test_context(&state, store).await;

            let context = active_context(&state).await.unwrap();
            let context_guard = context.lock().await;
            let first_state = state.clone();
            let second_state = state.clone();
            let first = tokio::spawn(async move {
                apply_agent_file_edit_state(
                    AgentFileApplyRequest {
                        turn_id: "turn-first-file".to_string(),
                        proposal_event_id: first_event,
                        path: "first.R".to_string(),
                        expected_disk_sha256: Some(text_sha256(first_before)),
                        before_content: first_before.to_string(),
                    },
                    &first_state,
                )
                .await
            });
            let second = tokio::spawn(async move {
                apply_agent_file_edit_state(
                    AgentFileApplyRequest {
                        turn_id: "turn-second-file".to_string(),
                        proposal_event_id: second_event,
                        path: "second.R".to_string(),
                        expected_disk_sha256: Some(text_sha256(second_before)),
                        before_content: second_before.to_string(),
                    },
                    &second_state,
                )
                .await
            });

            tokio::time::timeout(
                Duration::from_secs(30),
                state
                    .agent_file_apply_test_control
                    .wait_for_completed_disk_writes(2),
            )
            .await
            .expect("different file lanes were serialized behind the global context lock");
            assert!(
                std::fs::read_to_string(&first_path)
                    .unwrap()
                    .contains("first_done")
            );
            assert!(
                std::fs::read_to_string(&second_path)
                    .unwrap()
                    .contains("second_done")
            );

            drop(context_guard);
            assert!(first.await.unwrap().is_ok());
            assert!(second.await.unwrap().is_ok());
            let context = context.lock().await;
            assert_eq!(context.broker.identity().project_revision, 2);
        });
    }

    #[test]
    fn concurrent_same_file_agent_proposals_apply_once_and_mark_the_other_stale() {
        let runtime = tokio::runtime::Runtime::new().unwrap();
        runtime.block_on(async {
            let tempdir = TempDir::new().unwrap();
            let project_root = tempdir.path().join("project-a");
            std::fs::create_dir_all(&project_root).unwrap();
            let project_root = project_root.canonicalize().unwrap();
            let file = project_root.join("analysis.R");
            let before = "value <- 1\n";
            std::fs::write(&file, before).unwrap();
            let store_path = tempdir.path().join("rho.sqlite");
            let mut store = Store::open(&store_path).unwrap();
            let normalized_root = normalize_project_root(project_root.to_string_lossy().as_ref());
            store.set_project_root(Some(&normalized_root)).unwrap();
            let first_event = add_agent_file_proposal(
                &mut store,
                &normalized_root,
                "conversation-file-a",
                "turn-file-a",
                "analysis.R",
                "append",
                "first <- TRUE\n",
                None,
            );
            let second_event = add_agent_file_proposal(
                &mut store,
                &normalized_root,
                "conversation-file-b",
                "turn-file-b",
                "analysis.R",
                "append",
                "second <- TRUE\n",
                None,
            );
            let state = test_app_state(tempdir.path(), &project_root, &store_path);
            install_test_context(&state, store).await;
            let expected = text_sha256(before);

            let (first, second) = tokio::join!(
                apply_agent_file_edit_state(
                    AgentFileApplyRequest {
                        turn_id: "turn-file-a".to_string(),
                        proposal_event_id: first_event,
                        path: "analysis.R".to_string(),
                        expected_disk_sha256: Some(expected.clone()),
                        before_content: before.to_string(),
                    },
                    &state,
                ),
                apply_agent_file_edit_state(
                    AgentFileApplyRequest {
                        turn_id: "turn-file-b".to_string(),
                        proposal_event_id: second_event,
                        path: "analysis.R".to_string(),
                        expected_disk_sha256: Some(expected),
                        before_content: before.to_string(),
                    },
                    &state,
                )
            );
            assert_eq!(usize::from(first.is_ok()) + usize::from(second.is_ok()), 1);
            let stale = first.err().or_else(|| second.err()).unwrap().to_string();
            assert!(stale.contains("AGENT_FILE_RESOURCE_STALE"), "{stale}");
            let content = std::fs::read_to_string(&file).unwrap();
            assert!(
                content == "value <- 1\nfirst <- TRUE\n"
                    || content == "value <- 1\nsecond <- TRUE\n"
            );
            assert!(
                state
                    .agent_file_mutations
                    .blocker(&normalized_root)
                    .is_none()
            );

            let repository = store_executor(&state).await.unwrap().agent_repository();
            let mut stale_events = 0;
            for turn_id in ["turn-file-a", "turn-file-b"] {
                if let Some(detail) = repository
                    .get_turn_detail(normalized_root.clone(), turn_id.to_string())
                    .await
                    .unwrap()
                {
                    stale_events += detail
                        .events
                        .iter()
                        .filter(|event| event.event_type == "file_edit.resource_stale")
                        .count();
                }
            }
            assert_eq!(stale_events, 1);
        });
    }

    #[test]
    fn cancelling_a_queued_agent_file_claim_prevents_mutation_and_releases_the_claim() {
        let runtime = tokio::runtime::Runtime::new().unwrap();
        runtime.block_on(async {
            let tempdir = TempDir::new().unwrap();
            let project_root = tempdir.path().join("project-a");
            std::fs::create_dir_all(&project_root).unwrap();
            let project_root = project_root.canonicalize().unwrap();
            let file = project_root.join("analysis.R");
            let before = "value <- 1\n";
            std::fs::write(&file, before).unwrap();
            let store_path = tempdir.path().join("rho.sqlite");
            let mut store = Store::open(&store_path).unwrap();
            let normalized_root = normalize_project_root(project_root.to_string_lossy().as_ref());
            store.set_project_root(Some(&normalized_root)).unwrap();
            let event_id = add_agent_file_proposal(
                &mut store,
                &normalized_root,
                "conversation-cancel-file",
                "turn-cancel-file",
                "analysis.R",
                "append",
                "cancelled <- TRUE\n",
                None,
            );
            let state = Arc::new(test_app_state(tempdir.path(), &project_root, &store_path));
            install_test_context(&state, store).await;
            let lane = state
                .agent_file_mutations
                .lane(&format!("{normalized_root}\0analysis.R"))
                .await;
            let lane_guard = lane.lock().await;
            let task_state = state.clone();
            let task = tokio::spawn(async move {
                apply_agent_file_edit_state(
                    AgentFileApplyRequest {
                        turn_id: "turn-cancel-file".to_string(),
                        proposal_event_id: event_id,
                        path: "analysis.R".to_string(),
                        expected_disk_sha256: Some(text_sha256(before)),
                        before_content: before.to_string(),
                    },
                    &task_state,
                )
                .await
            });
            for _ in 0..100 {
                if state
                    .agent_file_mutations
                    .blocker(&normalized_root)
                    .is_some()
                {
                    break;
                }
                tokio::time::sleep(std::time::Duration::from_millis(1)).await;
            }
            assert!(
                state
                    .agent_file_mutations
                    .blocker(&normalized_root)
                    .is_some(),
                "the file mutation did not reach the queued lane"
            );
            assert_eq!(
                state
                    .agent_file_mutations
                    .cancel_queued_turn("turn-cancel-file"),
                1
            );
            drop(lane_guard);
            let error = task.await.unwrap().unwrap_err().to_string();
            assert!(error.contains("AGENT_FILE_CANCELLED"), "{error}");
            assert_eq!(std::fs::read_to_string(&file).unwrap(), before);
            assert!(
                state
                    .agent_file_mutations
                    .blocker(&normalized_root)
                    .is_none()
            );
            let detail = store_executor(&state)
                .await
                .unwrap()
                .agent_repository()
                .get_turn_detail(normalized_root, "turn-cancel-file".to_string())
                .await
                .unwrap()
                .unwrap();
            assert!(
                detail
                    .events
                    .iter()
                    .any(|event| event.event_type == "file_edit.cancelled")
            );
        });
    }

    #[test]
    fn incomplete_agent_file_mutations_reconcile_from_disk_once_and_per_project() {
        let tempdir = TempDir::new().unwrap();
        let project_a = tempdir.path().join("project-a");
        let project_b = tempdir.path().join("project-b");
        std::fs::create_dir_all(&project_a).unwrap();
        std::fs::create_dir_all(&project_b).unwrap();
        let project_a = project_a.canonicalize().unwrap();
        let project_b = project_b.canonicalize().unwrap();
        let root_a = normalize_project_root(project_a.to_string_lossy().as_ref());
        let root_b = normalize_project_root(project_b.to_string_lossy().as_ref());
        std::fs::write(project_a.join("recovered.R"), "before\nafter\n").unwrap();
        std::fs::write(project_a.join("not-applied.R"), "before\n").unwrap();
        std::fs::write(project_a.join("uncertain.R"), "different\n").unwrap();
        std::fs::write(project_b.join("foreign.R"), "before\nafter\n").unwrap();
        let store_path = tempdir.path().join("rho.sqlite");
        let mut store = Store::open(&store_path).unwrap();
        store.set_project_root(Some(&root_a)).unwrap();

        for (root, conversation, turn, path, mutation) in [
            (
                root_a.as_str(),
                "conversation-recovered",
                "turn-recovered",
                "recovered.R",
                "mutation-recovered",
            ),
            (
                root_a.as_str(),
                "conversation-not-applied",
                "turn-not-applied",
                "not-applied.R",
                "mutation-not-applied",
            ),
            (
                root_a.as_str(),
                "conversation-uncertain",
                "turn-uncertain",
                "uncertain.R",
                "mutation-uncertain",
            ),
            (
                root_b.as_str(),
                "conversation-foreign-recovery",
                "turn-foreign-recovery",
                "foreign.R",
                "mutation-foreign",
            ),
        ] {
            let proposal_event_id = add_agent_file_proposal(
                &mut store,
                root,
                conversation,
                turn,
                path,
                "append",
                "after\n",
                None,
            );
            add_agent_file_mutation_start(
                &mut store,
                turn,
                path,
                proposal_event_id,
                mutation,
                "before\n",
                "before\nafter\n",
            );
        }

        drop(store);
        let runtime = tokio::runtime::Runtime::new().unwrap();
        let executor = runtime.block_on(StoreExecutor::open(&store_path)).unwrap();
        let summary = runtime
            .block_on(recover_incomplete_agent_file_mutations(
                &executor, &project_a, &root_a,
            ))
            .unwrap();
        assert_eq!(summary.recovered, 1);
        assert_eq!(summary.not_applied, 1);
        assert_eq!(summary.uncertain, 1);
        assert_eq!(
            runtime
                .block_on(recover_incomplete_agent_file_mutations(
                    &executor, &project_a, &root_a,
                ))
                .unwrap(),
            Default::default()
        );
        let store = Store::open(&store_path).unwrap();
        let recovered = store
            .get_agent_turn_detail(&root_a, "turn-recovered")
            .unwrap()
            .unwrap();
        assert!(
            recovered
                .events
                .iter()
                .any(|event| event.event_type == "file_edit.recovered")
        );
        let not_applied = store
            .get_agent_turn_detail(&root_a, "turn-not-applied")
            .unwrap()
            .unwrap();
        assert!(
            not_applied
                .events
                .iter()
                .any(|event| event.event_type == "file_edit.mutation_not_applied")
        );
        let uncertain = store
            .get_agent_turn_detail(&root_a, "turn-uncertain")
            .unwrap()
            .unwrap();
        assert!(
            uncertain
                .events
                .iter()
                .any(|event| event.event_type == "file_edit.outcome_uncertain")
        );
        let foreign = store
            .get_agent_turn_detail(&root_b, "turn-foreign-recovery")
            .unwrap()
            .unwrap();
        assert!(!foreign.events.iter().any(|event| matches!(
            event.event_type.as_str(),
            "file_edit.recovered"
                | "file_edit.mutation_not_applied"
                | "file_edit.outcome_uncertain"
        )));
    }

    #[test]
    fn incomplete_agent_file_recovery_rejection_preserves_pending_truth_and_retries() {
        let tempdir = TempDir::new().unwrap();
        let project_root = tempdir.path().join("project-a");
        std::fs::create_dir_all(&project_root).unwrap();
        let project_root = project_root.canonicalize().unwrap();
        let normalized_root = normalize_project_root(project_root.to_string_lossy().as_ref());
        std::fs::write(project_root.join("recovered.R"), "before\nafter\n").unwrap();
        let store_path = tempdir.path().join("rho.sqlite");
        let mut store = Store::open(&store_path).unwrap();
        store.set_project_root(Some(&normalized_root)).unwrap();
        let proposal_event_id = add_agent_file_proposal(
            &mut store,
            &normalized_root,
            "conversation-recovery-rejection",
            "turn-recovery-rejection",
            "recovered.R",
            "append",
            "after\n",
            None,
        );
        add_agent_file_mutation_start(
            &mut store,
            "turn-recovery-rejection",
            "recovered.R",
            proposal_event_id,
            "mutation-recovery-rejection",
            "before\n",
            "before\nafter\n",
        );
        drop(store);

        let runtime = tokio::runtime::Runtime::new().unwrap();
        let executor = runtime.block_on(StoreExecutor::open(&store_path)).unwrap();
        let connection = rusqlite::Connection::open(&store_path).unwrap();
        connection
            .execute_batch(
                "CREATE TRIGGER reject_agent_file_recovery
                 BEFORE INSERT ON agent_turn_events
                 WHEN NEW.event_type = 'file_edit.recovered'
                 BEGIN
                   SELECT RAISE(ABORT, 'injected recovery persistence failure');
                 END;",
            )
            .unwrap();

        let error = runtime
            .block_on(recover_incomplete_agent_file_mutations(
                &executor,
                &project_root,
                &normalized_root,
            ))
            .unwrap_err();
        assert!(
            error
                .to_string()
                .contains("injected recovery persistence failure")
        );
        let detail = runtime
            .block_on(executor.agent_repository().get_turn_detail(
                normalized_root.clone(),
                "turn-recovery-rejection".to_string(),
            ))
            .unwrap()
            .unwrap();
        assert!(
            !detail
                .events
                .iter()
                .any(|event| event.event_type == "file_edit.recovered")
        );

        connection
            .execute_batch("DROP TRIGGER reject_agent_file_recovery;")
            .unwrap();
        let recovered = runtime
            .block_on(recover_incomplete_agent_file_mutations(
                &executor,
                &project_root,
                &normalized_root,
            ))
            .unwrap();
        assert_eq!(recovered.recovered, 1);
        assert_eq!(
            runtime
                .block_on(recover_incomplete_agent_file_mutations(
                    &executor,
                    &project_root,
                    &normalized_root,
                ))
                .unwrap(),
            Default::default()
        );
    }

    #[test]
    fn agent_file_write_failures_record_safe_or_uncertain_terminal_truth() {
        let tempdir = TempDir::new().unwrap();
        let project_root = tempdir.path().join("project-a");
        std::fs::create_dir_all(&project_root).unwrap();
        let project_root = project_root.canonicalize().unwrap();
        let file = project_root.join("analysis.R");
        std::fs::write(&file, "before\n").unwrap();
        let normalized_root = normalize_project_root(project_root.to_string_lossy().as_ref());
        let mut store = Store::open(tempdir.path().join("rho.sqlite")).unwrap();
        store.set_project_root(Some(&normalized_root)).unwrap();
        let proposal_event_id = add_agent_file_proposal(
            &mut store,
            &normalized_root,
            "conversation-write-failure",
            "turn-write-failure",
            "analysis.R",
            "append",
            "after\n",
            None,
        );

        add_agent_file_mutation_start(
            &mut store,
            "turn-write-failure",
            "analysis.R",
            proposal_event_id,
            "mutation-safe-failure",
            "before\n",
            "before\nafter\n",
        );
        let injected = anyhow::anyhow!("injected atomic write failure");
        let (safe_event, safe_error) = classify_agent_file_write_failure(
            &project_root,
            "turn-write-failure",
            "analysis.R",
            "append",
            proposal_event_id,
            "mutation-safe-failure",
            "apply",
            Some(&text_sha256("before\n")),
            false,
            &injected,
        );
        persist_agent_file_mutation_event_to_store(&mut store, safe_event).unwrap();
        assert!(safe_error.to_string().contains("AGENT_FILE_WRITE_FAILED"));

        add_agent_file_mutation_start(
            &mut store,
            "turn-write-failure",
            "analysis.R",
            proposal_event_id,
            "mutation-uncertain-failure",
            "before\n",
            "before\nafter\n",
        );
        std::fs::write(&file, "different\n").unwrap();
        let (uncertain_event, uncertain_error) = classify_agent_file_write_failure(
            &project_root,
            "turn-write-failure",
            "analysis.R",
            "append",
            proposal_event_id,
            "mutation-uncertain-failure",
            "apply",
            Some(&text_sha256("before\n")),
            false,
            &injected,
        );
        persist_agent_file_mutation_event_to_store(&mut store, uncertain_event).unwrap();
        assert!(
            uncertain_error
                .to_string()
                .contains("AGENT_FILE_OUTCOME_UNCERTAIN")
        );

        add_agent_file_mutation_start(
            &mut store,
            "turn-write-failure",
            "analysis.R",
            proposal_event_id,
            "mutation-postwrite-failure",
            "different\n",
            "different\nafter\n",
        );
        let (postwrite_event, postwrite_error) = classify_agent_file_postwrite_failure(
            "turn-write-failure",
            "analysis.R",
            "append",
            proposal_event_id,
            "mutation-postwrite-failure",
            "apply",
            &injected,
        );
        persist_agent_file_mutation_event_to_store(&mut store, postwrite_event).unwrap();
        assert!(
            postwrite_error
                .to_string()
                .contains("AGENT_FILE_OUTCOME_UNCERTAIN")
        );

        let detail = store
            .get_agent_turn_detail(&normalized_root, "turn-write-failure")
            .unwrap()
            .unwrap();
        assert_eq!(
            detail
                .events
                .iter()
                .filter(|event| event.event_type == "file_edit.mutation_failed")
                .count(),
            1
        );
        assert_eq!(
            detail
                .events
                .iter()
                .filter(|event| event.event_type == "file_edit.outcome_uncertain")
                .count(),
            2
        );
        let store_path = tempdir.path().join("rho.sqlite");
        drop(store);
        let runtime = tokio::runtime::Runtime::new().unwrap();
        let executor = runtime.block_on(StoreExecutor::open(&store_path)).unwrap();
        assert_eq!(
            runtime
                .block_on(recover_incomplete_agent_file_mutations(
                    &executor,
                    &project_root,
                    &normalized_root,
                ))
                .unwrap(),
            Default::default()
        );
    }

    #[test]
    fn agent_file_edit_uses_utf16_ranges_and_stale_undo_preserves_later_content() {
        let runtime = tokio::runtime::Runtime::new().unwrap();
        runtime.block_on(async {
            let tempdir = TempDir::new().unwrap();
            let project_root = tempdir.path().join("project-a");
            std::fs::create_dir_all(&project_root).unwrap();
            let project_root = project_root.canonicalize().unwrap();
            let file = project_root.join("unicode.R");
            let before = "a😀b";
            std::fs::write(&file, before).unwrap();
            let store_path = tempdir.path().join("rho.sqlite");
            let mut store = Store::open(&store_path).unwrap();
            let normalized_root = normalize_project_root(project_root.to_string_lossy().as_ref());
            store.set_project_root(Some(&normalized_root)).unwrap();
            let event_id = add_agent_file_proposal(
                &mut store,
                &normalized_root,
                "conversation-unicode",
                "turn-unicode",
                "unicode.R",
                "replace_selection",
                "替换",
                Some(json!({
                    "active_path": "unicode.R",
                    "selection_start": 1,
                    "selection_end": 3,
                    "selection_text": "😀"
                })),
            );
            let state = test_app_state(tempdir.path(), &project_root, &store_path);
            install_test_context(&state, store).await;

            let applied = apply_agent_file_edit_state(
                AgentFileApplyRequest {
                    turn_id: "turn-unicode".to_string(),
                    proposal_event_id: event_id,
                    path: "unicode.R".to_string(),
                    expected_disk_sha256: Some(text_sha256(before)),
                    before_content: before.to_string(),
                },
                &state,
            )
            .await
            .unwrap();
            assert_eq!(applied.content.as_deref(), Some("a替换b"));
            assert_eq!((applied.start, applied.end), (1, 3));
            let applied_digest = applied.after_sha256.unwrap();

            let forged_undo = undo_agent_file_edit_state(
                AgentFileUndoRequest {
                    turn_id: "turn-unicode".to_string(),
                    proposal_event_id: event_id,
                    path: "unicode.R".to_string(),
                    expected_after_sha256: applied_digest.clone(),
                    before_content: "forged <- TRUE\n".to_string(),
                    created: false,
                },
                &state,
            )
            .await
            .unwrap_err()
            .to_string();
            assert!(
                forged_undo.contains("durable pre-Apply editor snapshot"),
                "{forged_undo}"
            );
            assert_eq!(std::fs::read_to_string(&file).unwrap(), "a替换b");

            std::fs::write(&file, "later <- TRUE\n").unwrap();
            let error = undo_agent_file_edit_state(
                AgentFileUndoRequest {
                    turn_id: "turn-unicode".to_string(),
                    proposal_event_id: event_id,
                    path: "unicode.R".to_string(),
                    expected_after_sha256: applied_digest,
                    before_content: before.to_string(),
                    created: false,
                },
                &state,
            )
            .await
            .unwrap_err()
            .to_string();
            assert!(error.contains("AGENT_FILE_RESOURCE_STALE"), "{error}");
            assert_eq!(std::fs::read_to_string(&file).unwrap(), "later <- TRUE\n");
        });
    }

    #[test]
    fn agent_file_undo_restores_the_exact_unsaved_editor_snapshot() {
        let runtime = tokio::runtime::Runtime::new().unwrap();
        runtime.block_on(async {
            let tempdir = TempDir::new().unwrap();
            let project_root = tempdir.path().join("project-a");
            std::fs::create_dir_all(&project_root).unwrap();
            let project_root = project_root.canonicalize().unwrap();
            let file = project_root.join("draft.R");
            let disk_before = "value <- 1\n";
            let editor_before = "value <- 1\nunsaved <- TRUE\n";
            std::fs::write(&file, disk_before).unwrap();
            let store_path = tempdir.path().join("rho.sqlite");
            let mut store = Store::open(&store_path).unwrap();
            let normalized_root = normalize_project_root(project_root.to_string_lossy().as_ref());
            store.set_project_root(Some(&normalized_root)).unwrap();
            let event_id = add_agent_file_proposal(
                &mut store,
                &normalized_root,
                "conversation-draft",
                "turn-draft",
                "draft.R",
                "append",
                "agent <- TRUE\n",
                None,
            );
            let state = test_app_state(tempdir.path(), &project_root, &store_path);
            install_test_context(&state, store).await;

            let applied = apply_agent_file_edit_state(
                AgentFileApplyRequest {
                    turn_id: "turn-draft".to_string(),
                    proposal_event_id: event_id,
                    path: "draft.R".to_string(),
                    expected_disk_sha256: Some(text_sha256(disk_before)),
                    before_content: editor_before.to_string(),
                },
                &state,
            )
            .await
            .unwrap();
            assert_eq!(
                applied.content.as_deref(),
                Some("value <- 1\nunsaved <- TRUE\nagent <- TRUE\n")
            );

            let undone = undo_agent_file_edit_state(
                AgentFileUndoRequest {
                    turn_id: "turn-draft".to_string(),
                    proposal_event_id: event_id,
                    path: "draft.R".to_string(),
                    expected_after_sha256: applied.after_sha256.unwrap(),
                    before_content: editor_before.to_string(),
                    created: false,
                },
                &state,
            )
            .await
            .unwrap();
            assert_eq!(undone.status, "undone");
            assert_eq!(std::fs::read_to_string(&file).unwrap(), editor_before);
        });
    }

    #[test]
    fn agent_create_undo_deletes_exact_file_and_rejects_invalid_targets() {
        let runtime = tokio::runtime::Runtime::new().unwrap();
        runtime.block_on(async {
            let tempdir = TempDir::new().unwrap();
            let project_root = tempdir.path().join("project-a");
            std::fs::create_dir_all(&project_root).unwrap();
            let project_root = project_root.canonicalize().unwrap();
            std::fs::write(project_root.join("existing.R"), "original\n").unwrap();
            let store_path = tempdir.path().join("rho.sqlite");
            let mut store = Store::open(&store_path).unwrap();
            let normalized_root = normalize_project_root(project_root.to_string_lossy().as_ref());
            store.set_project_root(Some(&normalized_root)).unwrap();
            let create_event = add_agent_file_proposal(
                &mut store,
                &normalized_root,
                "conversation-create",
                "turn-create",
                "created.R",
                "create",
                "created <- TRUE\n",
                None,
            );
            let existing_event = add_agent_file_proposal(
                &mut store,
                &normalized_root,
                "conversation-existing",
                "turn-existing",
                "existing.R",
                "create",
                "overwrite <- TRUE\n",
                None,
            );
            let missing_event = add_agent_file_proposal(
                &mut store,
                &normalized_root,
                "conversation-missing",
                "turn-missing",
                "missing.R",
                "append",
                "append <- TRUE\n",
                None,
            );
            let state = test_app_state(tempdir.path(), &project_root, &store_path);
            install_test_context(&state, store).await;

            let applied = apply_agent_file_edit_state(
                AgentFileApplyRequest {
                    turn_id: "turn-create".to_string(),
                    proposal_event_id: create_event,
                    path: "created.R".to_string(),
                    expected_disk_sha256: None,
                    before_content: String::new(),
                },
                &state,
            )
            .await
            .unwrap();
            assert!(project_root.join("created.R").is_file());
            let applied_digest = applied.after_sha256.clone().unwrap();
            let replay_error = apply_agent_file_edit_state(
                AgentFileApplyRequest {
                    turn_id: "turn-create".to_string(),
                    proposal_event_id: create_event,
                    path: "created.R".to_string(),
                    expected_disk_sha256: None,
                    before_content: String::new(),
                },
                &state,
            )
            .await
            .unwrap_err()
            .to_string();
            assert!(replay_error.contains("AGENT_FILE_ALREADY_DECIDED"));
            let forged_undo_error = undo_agent_file_edit_state(
                AgentFileUndoRequest {
                    turn_id: "turn-create".to_string(),
                    proposal_event_id: create_event,
                    path: "created.R".to_string(),
                    expected_after_sha256: applied_digest.clone(),
                    before_content: "forged".to_string(),
                    created: true,
                },
                &state,
            )
            .await
            .unwrap_err()
            .to_string();
            assert!(forged_undo_error.contains("durable pre-Apply editor snapshot"));
            assert!(project_root.join("created.R").is_file());
            let undone = undo_agent_file_edit_state(
                AgentFileUndoRequest {
                    turn_id: "turn-create".to_string(),
                    proposal_event_id: create_event,
                    path: "created.R".to_string(),
                    expected_after_sha256: applied_digest.clone(),
                    before_content: String::new(),
                    created: true,
                },
                &state,
            )
            .await
            .unwrap();
            assert_eq!(undone.status, "undone");
            assert!(!project_root.join("created.R").exists());
            let repeated_undo_error = undo_agent_file_edit_state(
                AgentFileUndoRequest {
                    turn_id: "turn-create".to_string(),
                    proposal_event_id: create_event,
                    path: "created.R".to_string(),
                    expected_after_sha256: applied_digest,
                    before_content: String::new(),
                    created: true,
                },
                &state,
            )
            .await
            .unwrap_err()
            .to_string();
            assert!(repeated_undo_error.contains("AGENT_FILE_ALREADY_DECIDED"));

            let existing_error = apply_agent_file_edit_state(
                AgentFileApplyRequest {
                    turn_id: "turn-existing".to_string(),
                    proposal_event_id: existing_event,
                    path: "existing.R".to_string(),
                    expected_disk_sha256: None,
                    before_content: String::new(),
                },
                &state,
            )
            .await
            .unwrap_err()
            .to_string();
            assert!(existing_error.contains("AGENT_FILE_RESOURCE_STALE"));
            assert_eq!(
                std::fs::read_to_string(project_root.join("existing.R")).unwrap(),
                "original\n"
            );

            let missing_error = apply_agent_file_edit_state(
                AgentFileApplyRequest {
                    turn_id: "turn-missing".to_string(),
                    proposal_event_id: missing_event,
                    path: "missing.R".to_string(),
                    expected_disk_sha256: Some(text_sha256("")),
                    before_content: String::new(),
                },
                &state,
            )
            .await
            .unwrap_err()
            .to_string();
            assert!(missing_error.contains("AGENT_FILE_RESOURCE_STALE"));

            let wrong_event_error = apply_agent_file_edit_state(
                AgentFileApplyRequest {
                    turn_id: "turn-existing".to_string(),
                    proposal_event_id: existing_event + 10_000,
                    path: "existing.R".to_string(),
                    expected_disk_sha256: Some(text_sha256("original\n")),
                    before_content: "original\n".to_string(),
                },
                &state,
            )
            .await
            .unwrap_err()
            .to_string();
            assert!(wrong_event_error.contains("proposal event was not found"));
            assert_eq!(
                std::fs::read_to_string(project_root.join("existing.R")).unwrap(),
                "original\n"
            );
        });
    }

    #[test]
    fn durable_file_mutation_state_rejects_noop_replay_and_unapplied_or_forged_undo() {
        let runtime = tokio::runtime::Runtime::new().unwrap();
        runtime.block_on(async {
            let tempdir = TempDir::new().unwrap();
            let project_root = tempdir.path().join("project-a");
            std::fs::create_dir_all(&project_root).unwrap();
            let project_root = project_root.canonicalize().unwrap();
            let file = project_root.join("noop.R");
            let before = "value <- 1\n";
            std::fs::write(&file, before).unwrap();
            let store_path = tempdir.path().join("rho.sqlite");
            let mut store = Store::open(&store_path).unwrap();
            let normalized_root = normalize_project_root(project_root.to_string_lossy().as_ref());
            store.set_project_root(Some(&normalized_root)).unwrap();
            let event_id = add_agent_file_proposal(
                &mut store,
                &normalized_root,
                "conversation-noop",
                "turn-noop",
                "noop.R",
                "append",
                "",
                None,
            );
            let state = test_app_state(tempdir.path(), &project_root, &store_path);
            install_test_context(&state, store).await;
            let digest = text_sha256(before);

            let unapplied_undo = undo_agent_file_edit_state(
                AgentFileUndoRequest {
                    turn_id: "turn-noop".to_string(),
                    proposal_event_id: event_id,
                    path: "noop.R".to_string(),
                    expected_after_sha256: digest.clone(),
                    before_content: before.to_string(),
                    created: false,
                },
                &state,
            )
            .await
            .unwrap_err()
            .to_string();
            assert!(unapplied_undo.contains("AGENT_FILE_NOT_APPLIED"));

            let applied = apply_agent_file_edit_state(
                AgentFileApplyRequest {
                    turn_id: "turn-noop".to_string(),
                    proposal_event_id: event_id,
                    path: "noop.R".to_string(),
                    expected_disk_sha256: Some(digest.clone()),
                    before_content: before.to_string(),
                },
                &state,
            )
            .await
            .unwrap();
            assert_eq!(applied.after_sha256.as_deref(), Some(digest.as_str()));

            let replay = apply_agent_file_edit_state(
                AgentFileApplyRequest {
                    turn_id: "turn-noop".to_string(),
                    proposal_event_id: event_id,
                    path: "noop.R".to_string(),
                    expected_disk_sha256: Some(digest.clone()),
                    before_content: before.to_string(),
                },
                &state,
            )
            .await
            .unwrap_err()
            .to_string();
            assert!(replay.contains("AGENT_FILE_ALREADY_DECIDED"));

            let forged = undo_agent_file_edit_state(
                AgentFileUndoRequest {
                    turn_id: "turn-noop".to_string(),
                    proposal_event_id: event_id,
                    path: "noop.R".to_string(),
                    expected_after_sha256: digest.clone(),
                    before_content: "forged <- TRUE\n".to_string(),
                    created: false,
                },
                &state,
            )
            .await
            .unwrap_err()
            .to_string();
            assert!(forged.contains("durable pre-Apply editor snapshot"));
            assert_eq!(std::fs::read_to_string(&file).unwrap(), before);

            undo_agent_file_edit_state(
                AgentFileUndoRequest {
                    turn_id: "turn-noop".to_string(),
                    proposal_event_id: event_id,
                    path: "noop.R".to_string(),
                    expected_after_sha256: digest.clone(),
                    before_content: before.to_string(),
                    created: false,
                },
                &state,
            )
            .await
            .unwrap();
            let repeated_undo = undo_agent_file_edit_state(
                AgentFileUndoRequest {
                    turn_id: "turn-noop".to_string(),
                    proposal_event_id: event_id,
                    path: "noop.R".to_string(),
                    expected_after_sha256: digest,
                    before_content: before.to_string(),
                    created: false,
                },
                &state,
            )
            .await
            .unwrap_err()
            .to_string();
            assert!(repeated_undo.contains("AGENT_FILE_ALREADY_DECIDED"));
            assert_eq!(std::fs::read_to_string(&file).unwrap(), before);
        });
    }

    #[test]
    fn retry_source_and_conversation_delete_are_exact_and_project_scoped() {
        let runtime = tokio::runtime::Runtime::new().unwrap();
        runtime.block_on(async {
            let tempdir = TempDir::new().unwrap();
            let project_a = tempdir.path().join("project-a");
            let project_b = tempdir.path().join("project-b");
            std::fs::create_dir_all(&project_a).unwrap();
            std::fs::create_dir_all(&project_b).unwrap();
            let project_a = project_a.canonicalize().unwrap();
            let project_b = project_b.canonicalize().unwrap();
            let root_a = normalize_project_root(project_a.to_string_lossy().as_ref());
            let root_b = normalize_project_root(project_b.to_string_lossy().as_ref());
            let store_path = tempdir.path().join("rho.sqlite");
            let mut store = Store::open(&store_path).unwrap();
            store.set_project_root(Some(&root_a)).unwrap();
            add_agent_file_proposal(
                &mut store,
                &root_a,
                "conversation-delete",
                "turn-delete",
                "analysis.R",
                "append",
                "one\n",
                Some(json!({"active_path": "analysis.R", "selection_start": 0})),
            );
            add_agent_file_proposal(
                &mut store,
                &root_a,
                "conversation-keep",
                "turn-keep",
                "keep.R",
                "create",
                "keep\n",
                None,
            );
            add_agent_file_proposal(
                &mut store,
                &root_b,
                "conversation-other-project",
                "turn-other-project",
                "other.R",
                "create",
                "other\n",
                None,
            );

            let source = agent_retry_source(&store, &root_a, "turn-delete").unwrap();
            assert_eq!(source.prompt, "Edit analysis.R");
            assert_eq!(source.mode, "act");
            assert_eq!(source.task_kind, "agent_turn");
            assert_eq!(source.conversation_id, "conversation-delete");
            assert_eq!(source.editor_context.unwrap()["active_path"], "analysis.R");
            assert!(agent_retry_source(&store, &root_b, "turn-delete").is_err());
            drop(store);

            let state = test_app_state(tempdir.path(), &project_a, &store_path);
            let claim = state
                .agent_file_mutations
                .register(&root_a, "turn-delete", "analysis.R");
            let blocked = delete_agent_conversation_state("conversation-delete", &state)
                .await
                .unwrap_err()
                .to_string();
            assert!(blocked.contains("file operation"), "{blocked}");
            drop(claim);

            let deleted = delete_agent_conversation_state("conversation-delete", &state)
                .await
                .unwrap();
            assert_eq!(deleted["deleted_turns"], 1);
            let store = Store::open(&store_path).unwrap();
            assert!(
                store
                    .get_agent_conversation(&root_a, "conversation-delete")
                    .unwrap()
                    .is_none()
            );
            assert!(
                store
                    .get_agent_conversation(&root_a, "conversation-keep")
                    .unwrap()
                    .is_some()
            );
            assert!(
                store
                    .get_agent_conversation(&root_b, "conversation-other-project")
                    .unwrap()
                    .is_some()
            );
            assert!(
                delete_agent_conversation_state("conversation-other-project", &state)
                    .await
                    .is_err()
            );
        });
    }

    #[test]
    fn cancelling_one_agent_turn_preserves_the_other_task_and_waiter() {
        let runtime = tokio::runtime::Runtime::new().unwrap();
        runtime.block_on(async {
            let tempdir = TempDir::new().unwrap();
            let project_root = tempdir.path().join("project-a");
            std::fs::create_dir_all(&project_root).unwrap();
            let normalized_root = normalize_project_root(project_root.to_string_lossy().as_ref());
            let store_path = tempdir.path().join("rho.sqlite");
            let mut store = Store::open(&store_path).unwrap();
            store.set_project_root(Some(&normalized_root)).unwrap();
            for (turn_id, conversation_id, request_id) in [
                ("turn-cancel-a", "conversation-cancel-a", "request-cancel-a"),
                ("turn-cancel-b", "conversation-cancel-b", "request-cancel-b"),
            ] {
                store
                    .create_agent_turn_with_conversation(
                        &AgentConversationDraft {
                            conversation_id: conversation_id.to_string(),
                            project_root: normalized_root.clone(),
                            title: format!("Conversation {conversation_id}"),
                            legacy_unthreaded: false,
                        },
                        &AgentTurnDraft {
                            turn_id: turn_id.to_string(),
                            project_root: normalized_root.clone(),
                            mode: "ask".to_string(),
                            prompt: format!("prompt for {turn_id}"),
                            model: "test".to_string(),
                            workspace_id: "ws-test".to_string(),
                            state_revision_before: 1,
                            project_revision_before: 1,
                        },
                    )
                    .unwrap();
                store
                    .create_approval_request(&ApprovalRequestDraft {
                        request_id: request_id.to_string(),
                        turn_id: turn_id.to_string(),
                        project_root: normalized_root.clone(),
                        tool: "run_r".to_string(),
                        policy: "required".to_string(),
                        arguments_json: "{}".to_string(),
                        code: None,
                        workspace_id: "ws-test".to_string(),
                        state_revision: 1,
                        project_revision: 1,
                    })
                    .unwrap();
            }
            drop(store);

            let state = test_app_state(tempdir.path(), &project_root, &store_path);
            let receiver_a = state
                .approvals
                .register(
                    "request-cancel-a".to_string(),
                    Some("turn-cancel-a".to_string()),
                )
                .await;
            let mut receiver_b = state
                .approvals
                .register(
                    "request-cancel-b".to_string(),
                    Some("turn-cancel-b".to_string()),
                )
                .await;
            for (turn_id, conversation_id) in [
                ("turn-cancel-a", "conversation-cancel-a"),
                ("turn-cancel-b", "conversation-cancel-b"),
            ] {
                let handle =
                    tauri::async_runtime::spawn(async { std::future::pending::<()>().await });
                state.agent_tasks.lock().await.insert(
                    turn_id.to_string(),
                    AgentTaskEntry {
                        conversation_id: conversation_id.to_string(),
                        handle,
                    },
                );
            }

            let response = cancel_agent_turn_state("turn-cancel-a".to_string(), &state)
                .await
                .unwrap();
            assert_eq!(response.turn_id, "turn-cancel-a");
            assert_eq!(receiver_a.await.unwrap().decision, "cancel");
            assert!(state.agent_tasks.lock().await.contains_key("turn-cancel-b"));
            assert!(
                tokio::time::timeout(std::time::Duration::from_millis(10), &mut receiver_b,)
                    .await
                    .is_err()
            );
            assert!(
                state
                    .approvals
                    .respond(
                        "request-cancel-b",
                        ApprovalResponseInput {
                            decision: "approve".to_string(),
                            reason: None,
                        },
                    )
                    .await
            );
            assert_eq!(receiver_b.await.unwrap().decision, "approve");

            let store = Store::open(&store_path).unwrap();
            let cancelled = store
                .get_agent_turn_detail(&normalized_root, "turn-cancel-a")
                .unwrap()
                .unwrap();
            assert_eq!(cancelled.turn.status, "interrupted");
            assert_eq!(
                cancelled.turn.terminal_reason.as_deref(),
                Some("user_cancelled")
            );
            assert_eq!(cancelled.approvals[0].status, "interrupted");
            let preserved = store
                .get_agent_turn_detail(&normalized_root, "turn-cancel-b")
                .unwrap()
                .unwrap();
            assert_eq!(preserved.turn.status, "running");
            assert_eq!(preserved.approvals[0].status, "waiting");
            drop(store);

            if let Some(task) = state.agent_tasks.lock().await.remove("turn-cancel-b") {
                task.handle.abort();
            }
        });
    }

    #[test]
    fn stopping_multiple_agent_tasks_persists_each_terminal_reason_once() {
        let runtime = tokio::runtime::Runtime::new().unwrap();
        runtime.block_on(async {
            let tempdir = TempDir::new().unwrap();
            let project_root = tempdir.path().join("project-a");
            std::fs::create_dir_all(&project_root).unwrap();
            let normalized_root = normalize_project_root(project_root.to_string_lossy().as_ref());
            let store_path = tempdir.path().join("rho.sqlite");
            let mut store = Store::open(&store_path).unwrap();
            store.set_project_root(Some(&normalized_root)).unwrap();
            for turn_id in ["turn-shutdown-a", "turn-shutdown-b"] {
                store
                    .create_agent_turn(&AgentTurnDraft {
                        turn_id: turn_id.to_string(),
                        project_root: normalized_root.clone(),
                        mode: "ask".to_string(),
                        prompt: format!("prompt for {turn_id}"),
                        model: "test".to_string(),
                        workspace_id: "ws-test".to_string(),
                        state_revision_before: 1,
                        project_revision_before: 1,
                    })
                    .unwrap();
            }
            store
                .create_approval_request(&ApprovalRequestDraft {
                    request_id: "request-shutdown-a".to_string(),
                    turn_id: "turn-shutdown-a".to_string(),
                    project_root: normalized_root.clone(),
                    tool: "run_r".to_string(),
                    policy: "required".to_string(),
                    arguments_json: "{}".to_string(),
                    code: None,
                    workspace_id: "ws-test".to_string(),
                    state_revision: 1,
                    project_revision: 1,
                })
                .unwrap();
            store
                .create_environment_operation_request(&EnvironmentOperationRequestDraft {
                    request_id: "environment-shutdown-a".to_string(),
                    turn_id: Some("turn-shutdown-a".to_string()),
                    source: "agent".to_string(),
                    request_name: "environment.snapshot".to_string(),
                    project_root: normalized_root.clone(),
                    arguments_json: "{}".to_string(),
                    preview_json: "{}".to_string(),
                    preview_sha256: "shutdown-preview".to_string(),
                    workspace_id: "ws-test".to_string(),
                    state_revision: 1,
                    project_revision: 1,
                    before_snapshot_id: None,
                })
                .unwrap();
            drop(store);

            let state = test_app_state(tempdir.path(), &project_root, &store_path);
            for (turn_id, conversation_id) in [
                ("turn-shutdown-a", "conversation-a"),
                ("turn-shutdown-b", "conversation-b"),
            ] {
                let handle =
                    tauri::async_runtime::spawn(async { std::future::pending::<()>().await });
                state.agent_tasks.lock().await.insert(
                    turn_id.to_string(),
                    AgentTaskEntry {
                        conversation_id: conversation_id.to_string(),
                        handle,
                    },
                );
            }

            assert_eq!(
                interrupt_all_agent_tasks(
                    &state,
                    "desktop_shutdown",
                    "Rho is closing for the test.",
                )
                .await
                .unwrap(),
                2
            );
            assert!(state.agent_tasks.lock().await.is_empty());
            let store = Store::open(&store_path).unwrap();
            let first_finished_at = store
                .get_agent_turn_detail(&normalized_root, "turn-shutdown-a")
                .unwrap()
                .unwrap()
                .turn
                .finished_at
                .unwrap();
            for turn_id in ["turn-shutdown-a", "turn-shutdown-b"] {
                let detail = store
                    .get_agent_turn_detail(&normalized_root, turn_id)
                    .unwrap()
                    .unwrap();
                assert_eq!(detail.turn.status, "interrupted");
                assert_eq!(
                    detail.turn.terminal_reason.as_deref(),
                    Some("desktop_shutdown")
                );
            }
            let first = store
                .get_agent_turn_detail(&normalized_root, "turn-shutdown-a")
                .unwrap()
                .unwrap();
            assert_eq!(first.approvals[0].status, "interrupted");
            assert_eq!(
                first.approvals[0].continuation_outcome.as_deref(),
                Some("desktop_shutdown")
            );
            let environment = store
                .get_environment_operation_request(&normalized_root, "environment-shutdown-a")
                .unwrap()
                .unwrap();
            assert_eq!(environment.status, "interrupted");
            assert_eq!(
                environment.terminal_outcome.as_deref(),
                Some("desktop_shutdown")
            );
            drop(store);

            assert_eq!(
                interrupt_all_agent_tasks(
                    &state,
                    "desktop_shutdown",
                    "Rho is closing for the test.",
                )
                .await
                .unwrap(),
                0
            );
            let store = Store::open(&store_path).unwrap();
            assert_eq!(
                store
                    .get_agent_turn_detail(&normalized_root, "turn-shutdown-a")
                    .unwrap()
                    .unwrap()
                    .turn
                    .finished_at
                    .as_deref(),
                Some(first_finished_at.as_str())
            );
        });
    }

    #[test]
    fn project_switch_preflight_blocks_active_agent_turn() {
        let runtime = tokio::runtime::Runtime::new().unwrap();
        runtime.block_on(async {
            let tempdir = TempDir::new().unwrap();
            let project_root = tempdir.path().join("project-a");
            std::fs::create_dir_all(&project_root).unwrap();
            let store_path = tempdir.path().join("rho.sqlite");
            let mut store = Store::open(&store_path).unwrap();
            let normalized_root = normalize_project_root(project_root.to_string_lossy().as_ref());
            store.set_project_root(Some(&normalized_root)).unwrap();
            let state = test_app_state(tempdir.path(), &project_root, &store_path);
            for (turn_id, conversation_id) in [
                ("turn-running-a", "conversation-running-a"),
                ("turn-running-b", "conversation-running-b"),
            ] {
                let handle =
                    tauri::async_runtime::spawn(async { std::future::pending::<()>().await });
                state.agent_tasks.lock().await.insert(
                    turn_id.to_string(),
                    AgentTaskEntry {
                        conversation_id: conversation_id.to_string(),
                        handle,
                    },
                );
            }

            let blocker = project_switch_blocker(&state).await.unwrap().unwrap();
            assert_eq!(blocker.kind, ProjectSwitchBlockerKind::AgentTurn);
            assert_eq!(blocker.pending_count, 2);
            assert!(matches!(
                blocker.turn_id.as_deref(),
                Some("turn-running-a" | "turn-running-b")
            ));

            let tasks = state.agent_tasks.lock().await.drain().collect::<Vec<_>>();
            for (_, task) in tasks {
                task.handle.abort();
            }
        });
    }

    #[test]
    fn project_switch_preflight_blocks_waiting_approval() {
        let runtime = tokio::runtime::Runtime::new().unwrap();
        runtime.block_on(async {
            let tempdir = TempDir::new().unwrap();
            let project_root = tempdir.path().join("project-a");
            std::fs::create_dir_all(&project_root).unwrap();
            let store_path = tempdir.path().join("rho.sqlite");
            let mut store = Store::open(&store_path).unwrap();
            let normalized_root = normalize_project_root(project_root.to_string_lossy().as_ref());
            store.set_project_root(Some(&normalized_root)).unwrap();
            create_waiting_approval(
                &mut store,
                &normalized_root,
                "turn-approval",
                "req-approval",
            );
            let state = test_app_state(tempdir.path(), &project_root, &store_path);
            let _receiver = state
                .approvals
                .register(
                    "req-approval".to_string(),
                    Some("turn-approval".to_string()),
                )
                .await;

            let blocker = project_switch_blocker(&state).await.unwrap().unwrap();
            assert_eq!(blocker.kind, ProjectSwitchBlockerKind::Approval);
            assert_eq!(blocker.turn_id.as_deref(), Some("turn-approval"));
            assert_eq!(blocker.request_id.as_deref(), Some("req-approval"));
        });
    }

    #[test]
    fn project_switch_preflight_blocks_environment_operation() {
        let runtime = tokio::runtime::Runtime::new().unwrap();
        runtime.block_on(async {
            let tempdir = TempDir::new().unwrap();
            let project_root = tempdir.path().join("project-a");
            std::fs::create_dir_all(&project_root).unwrap();
            let store_path = tempdir.path().join("rho.sqlite");
            let mut store = Store::open(&store_path).unwrap();
            let normalized_root = normalize_project_root(project_root.to_string_lossy().as_ref());
            store.set_project_root(Some(&normalized_root)).unwrap();
            store
                .create_environment_operation_request(&EnvironmentOperationRequestDraft {
                    request_id: "env-req-1".to_string(),
                    turn_id: None,
                    source: "direct".to_string(),
                    request_name: "renv::restore".to_string(),
                    project_root: normalized_root.clone(),
                    arguments_json: "{}".to_string(),
                    preview_json: "{}".to_string(),
                    preview_sha256: "sha".to_string(),
                    workspace_id: "ws-1".to_string(),
                    state_revision: 1,
                    project_revision: 1,
                    before_snapshot_id: None,
                })
                .unwrap();
            let state = test_app_state(tempdir.path(), &project_root, &store_path);
            let _receiver = state
                .environment_approvals
                .register("env-req-1".to_string(), None)
                .await;

            let blocker = project_switch_blocker(&state).await.unwrap().unwrap();
            assert_eq!(blocker.kind, ProjectSwitchBlockerKind::EnvironmentOperation);
            assert_eq!(blocker.request_id.as_deref(), Some("env-req-1"));
            assert_eq!(blocker.operation_status.as_deref(), Some("requested"));
        });
    }

    #[test]
    fn project_switch_preflight_allows_clean_project() {
        let runtime = tokio::runtime::Runtime::new().unwrap();
        runtime.block_on(async {
            let tempdir = TempDir::new().unwrap();
            let project_root = tempdir.path().join("project-a");
            std::fs::create_dir_all(&project_root).unwrap();
            let store_path = tempdir.path().join("rho.sqlite");
            let mut store = Store::open(&store_path).unwrap();
            let normalized_root = normalize_project_root(project_root.to_string_lossy().as_ref());
            store.set_project_root(Some(&normalized_root)).unwrap();
            let state = test_app_state(tempdir.path(), &project_root, &store_path);

            assert!(project_switch_blocker(&state).await.unwrap().is_none());
        });
    }

    #[test]
    fn project_switch_commits_only_after_full_chain_success() {
        let runtime = tokio::runtime::Runtime::new().unwrap();
        runtime.block_on(async {
            let tempdir = TempDir::new().unwrap();
            let project_a = tempdir.path().join("project-a");
            let project_b = tempdir.path().join("project-b");
            std::fs::create_dir_all(&project_a).unwrap();
            std::fs::create_dir_all(&project_b).unwrap();
            let store_path = tempdir.path().join("rho.sqlite");
            let mut store = Store::open(&store_path).unwrap();
            let root_a = normalize_project_root(project_a.to_string_lossy().as_ref());
            let root_b = normalize_project_root(project_b.to_string_lossy().as_ref());
            store.set_project_root(Some(&root_a)).unwrap();
            let state = test_app_state(tempdir.path(), &project_a, &store_path);
            save_session_fixture(&state, &project_a, "old.R", 210);
            let target_session = save_session_fixture(&state, &project_b, "new.R", 260);
            state
                .switch_test_control
                .succeed_without_running(SwitchTestStep::SyncWorkspace);

            let response = switch_project_with_watcher_factory(
                project_b.clone(),
                Some(target_session.clone()),
                &state,
                |_| Ok(ProjectWatcherControl::noop()),
            )
            .await
            .unwrap();

            assert_eq!(response.status, "ready");
            assert_eq!(response.session.active_document.as_deref(), Some("new.R"));
            assert_eq!(
                state
                    .project_root
                    .read()
                    .await
                    .to_string_lossy()
                    .replace('\\', "/"),
                project_b.to_string_lossy().replace('\\', "/")
            );
            let active_root = Store::open(&store_path)
                .unwrap()
                .active_project_root()
                .unwrap()
                .unwrap();
            assert_eq!(active_root, root_b);
            let last_opened = state
                .project_store
                .last_opened_project()
                .unwrap()
                .unwrap()
                .to_string_lossy()
                .replace('\\', "/");
            assert_eq!(last_opened, project_b.to_string_lossy().replace('\\', "/"));
            assert!(state.extension_host.scopes().project().is_none());
            assert_eq!(
                state.extension_host.scopes().application().state(),
                ScopeLifecycleState::Active
            );
        });
    }

    #[test]
    fn candidate_project_scope_tracks_a_b_a_with_fresh_generations() {
        let runtime = tokio::runtime::Runtime::new().unwrap();
        runtime.block_on(async {
            let tempdir = TempDir::new().unwrap();
            let project_a = tempdir.path().join("project-a");
            let project_b = tempdir.path().join("project-b");
            std::fs::create_dir_all(&project_a).unwrap();
            std::fs::create_dir_all(&project_b).unwrap();
            let store_path = tempdir.path().join("rho.sqlite");
            let root_a = normalize_project_root(project_a.to_string_lossy().as_ref());
            Store::open(&store_path)
                .unwrap()
                .set_project_root(Some(&root_a))
                .unwrap();
            let state = test_app_state_with_extension_mode(
                tempdir.path(),
                &project_a,
                &store_path,
                InternalExtensionRuntimeMode::Candidate,
            );

            for target in [&project_a, &project_b, &project_a] {
                state
                    .switch_test_control
                    .succeed_without_running(SwitchTestStep::SyncWorkspace);
                let response =
                    switch_project_with_watcher_factory(target.to_path_buf(), None, &state, |_| {
                        Ok(ProjectWatcherControl::noop())
                    })
                    .await
                    .unwrap();
                assert_eq!(response.status, "ready");
            }

            let final_scope = state.extension_host.scopes().project().unwrap();
            assert_eq!(final_scope.state(), ScopeLifecycleState::Active);
            let expected_id = format!("project.{}", text_sha256(&root_a));
            assert_eq!(final_scope.identity().id.as_str(), expected_id);
            assert_eq!(final_scope.identity().generation.get(), 4);
        });
    }

    #[test]
    fn run_history_plugin_descriptor_is_fixed_and_permission_free() {
        let plugin = super::RunHistoryPlugin::new();
        let descriptor = plugin.descriptor();
        assert_eq!(descriptor.id.as_str(), "org.yulab.rho.run-history");
        assert_eq!(
            descriptor.allowed_scopes,
            vec![rho_extension_runtime::ScopePolicy::project_kind()]
        );
        assert_eq!(descriptor.provides.len(), 1);
        assert_eq!(
            descriptor.provides[0].capability_id.as_str(),
            "source.project.run-history"
        );
        assert_eq!(descriptor.provides[0].contract_major.get(), 1);
        assert_eq!(descriptor.requires.len(), 1);
        assert_eq!(
            descriptor.requires[0].capability_id.as_str(),
            "service.broker.runs"
        );
        assert_eq!(descriptor.requires[0].contract_major.get(), 1);
        let json = serde_json::to_value(descriptor).unwrap();
        assert!(json.get("permissions").is_none());
    }

    #[test]
    fn workspace_snapshot_plugin_descriptor_is_fixed_typed_and_permission_free() {
        let plugin = super::WorkspaceSnapshotPlugin::new();
        let descriptor = plugin.descriptor();
        assert_eq!(
            descriptor.id.as_str(),
            "org.yulab.rho.workspace-snapshot-tool"
        );
        assert_eq!(
            descriptor.allowed_scopes,
            vec![rho_extension_runtime::ScopePolicy::workspace_kind()]
        );
        assert_eq!(
            descriptor.provides[0].capability_id.as_str(),
            "tool.workspace.snapshot"
        );
        assert_eq!(descriptor.provides[0].contract_major.get(), 1);
        assert_eq!(
            descriptor.requires[0].capability_id.as_str(),
            "service.broker.workspace-probe"
        );
        assert_eq!(descriptor.requires[0].contract_major.get(), 1);
        assert!(
            serde_json::to_value(descriptor)
                .unwrap()
                .get("permissions")
                .is_none()
        );
    }

    #[test]
    fn project_file_viewer_plugin_is_application_scoped_and_path_free() {
        let runtime = tokio::runtime::Runtime::new().unwrap();
        runtime.block_on(async {
            let plugin = super::ProjectFileViewerPlugin::new();
            let descriptor = plugin.descriptor();
            assert_eq!(descriptor.id.as_str(), "org.yulab.rho.project-file-viewer");
            assert_eq!(
                descriptor.allowed_scopes,
                vec![rho_extension_runtime::ScopePolicy::application_kind()]
            );
            assert_eq!(
                descriptor.provides[0].capability_id.as_str(),
                "ui.viewer.project-file"
            );

            let host = test_candidate_extension_host_with_application_plugins().await;
            let application = host.scopes().application();
            let resolution = application
                .registry()
                .resolve_project_file_viewer(&super::project_file_viewer_capability_id())
                .unwrap();
            let value = serde_json::to_value(resolution.contribution()).unwrap();
            assert!(value.get("project_root").is_none());
            assert!(value.get("path").is_none());
            assert!(value.get("handler").is_none());
            assert_eq!(
                resolution.contribution().general_maximum_bytes(),
                super::MAX_VIEWER_FILE_BYTES as usize
            );
            assert_eq!(
                resolution.contribution().html_maximum_bytes(),
                super::MAX_VIEWER_HTML_BYTES as usize
            );
            let surfaces = application
                .registry()
                .resolve_application_surfaces()
                .unwrap();
            assert_eq!(surfaces.factories().len(), 17);
            assert_eq!(
                surfaces
                    .factories()
                    .iter()
                    .map(|factory| factory.definition.surface_id.as_str())
                    .collect::<std::collections::BTreeSet<_>>(),
                std::collections::BTreeSet::from([
                    "rho.console",
                    "rho.check-result",
                    "rho.file-preview",
                    "rho.file-source",
                    "rho.surface-playground",
                    "rho.agent",
                    "rho.environment",
                    "rho.navigator",
                    "rho.evidence",
                    "rho.git",
                    "rho.runs",
                    "rho.artifacts",
                    "rho.problems",
                    "rho.plots",
                    "rho.logs",
                    "rho.render-jobs",
                    "rho.help",
                ])
            );
            let surface = surfaces
                .factories()
                .iter()
                .find(|factory| factory.definition.surface_id.as_str() == "rho.surface-playground")
                .unwrap();
            assert_eq!(
                surface.definition.surface_id.as_str(),
                "rho.surface-playground"
            );
            assert_eq!(surface.activation_generation, 1);
            assert_eq!(
                surface.definition.instance_policy,
                rho_ui_contract::SurfaceInstancePolicyV1::MultiInstance
            );
            let console = surfaces
                .factories()
                .iter()
                .find(|factory| factory.definition.surface_id.as_str() == "rho.console")
                .unwrap();
            assert_eq!(
                console.definition.instance_policy,
                rho_ui_contract::SurfaceInstancePolicyV1::MultiInstance
            );
            let source = surfaces
                .factories()
                .iter()
                .find(|factory| factory.definition.surface_id.as_str() == "rho.file-source")
                .unwrap();
            assert_eq!(
                source
                    .definition
                    .modes
                    .iter()
                    .map(|mode| mode.mode_id.as_str())
                    .collect::<std::collections::BTreeSet<_>>(),
                std::collections::BTreeSet::from(["diff", "outline", "source"])
            );
            let preview = surfaces
                .factories()
                .iter()
                .find(|factory| factory.definition.surface_id.as_str() == "rho.file-preview")
                .unwrap();
            assert_eq!(preview.definition.modes[0].mode_id.as_str(), "preview");
            let providers = application
                .registry()
                .resolve_application_runtime_providers()
                .unwrap();
            assert_eq!(providers.providers().len(), 1);
            assert_eq!(
                providers.providers()[0]
                    .definition
                    .runtime_provider_id
                    .as_str(),
                "rho.ark-r"
            );
            let resources = application
                .registry()
                .resolve_application_resource_providers()
                .unwrap();
            assert_eq!(resources.providers().len(), 1);
            assert_eq!(
                resources.providers()[0]
                    .definition
                    .resource_provider_id
                    .as_str(),
                "rho.project-files"
            );
        });
    }

    #[test]
    fn extension_host_activates_application_plugins_only_in_candidate_mode() {
        let runtime = tokio::runtime::Runtime::new().unwrap();
        runtime.block_on(async {
            let diagnostics =
                || -> Arc<dyn DiagnosticSink> { Arc::new(|_: ExtensionDiagnostic| {}) };
            let legacy = super::build_extension_host(Some("legacy"), diagnostics())
                .await
                .unwrap();
            assert!(
                legacy
                    .scopes()
                    .application()
                    .registry()
                    .resolve_project_file_viewer(&super::project_file_viewer_capability_id())
                    .is_err()
            );
            assert!(
                legacy
                    .scopes()
                    .application()
                    .registry()
                    .resolve_application_surfaces()
                    .unwrap()
                    .factories()
                    .is_empty()
            );
            assert!(
                legacy
                    .scopes()
                    .application()
                    .registry()
                    .resolve_application_resource_providers()
                    .unwrap()
                    .providers()
                    .is_empty()
            );
            assert!(
                legacy
                    .scopes()
                    .application()
                    .registry()
                    .resolve_application_runtime_providers()
                    .unwrap()
                    .providers()
                    .is_empty()
            );
            let candidate = super::build_extension_host(Some("candidate"), diagnostics())
                .await
                .unwrap();
            assert!(
                candidate
                    .scopes()
                    .application()
                    .registry()
                    .resolve_project_file_viewer(&super::project_file_viewer_capability_id())
                    .is_ok()
            );
            assert_eq!(
                candidate
                    .scopes()
                    .application()
                    .registry()
                    .resolve_application_surfaces()
                    .unwrap()
                    .factories()
                    .len(),
                17
            );
            assert_eq!(
                candidate
                    .scopes()
                    .application()
                    .registry()
                    .resolve_application_runtime_providers()
                    .unwrap()
                    .providers()
                    .len(),
                1
            );
            assert_eq!(
                candidate
                    .scopes()
                    .application()
                    .registry()
                    .resolve_application_resource_providers()
                    .unwrap()
                    .providers()
                    .len(),
                1
            );
            let default = super::build_extension_host(None, diagnostics())
                .await
                .unwrap();
            assert_eq!(
                default.mode(),
                rho_extension_runtime::InternalExtensionRuntimeMode::Candidate
            );
            assert!(
                default
                    .scopes()
                    .application()
                    .registry()
                    .resolve_project_file_viewer(&super::project_file_viewer_capability_id())
                    .is_ok()
            );
        });
    }

    #[test]
    fn candidate_workspace_snapshot_preserves_typed_system_and_agent_requests() {
        let runtime = tokio::runtime::Runtime::new().unwrap();
        runtime.block_on(async {
            let tempdir = TempDir::new().unwrap();
            let project_root = tempdir.path().join("project-a");
            std::fs::create_dir_all(&project_root).unwrap();
            let normalized_root = normalize_project_root(project_root.to_string_lossy().as_ref());
            let store_path = tempdir.path().join("rho.sqlite");
            let mut store = Store::open(&store_path).unwrap();
            store.set_project_root(Some(&normalized_root)).unwrap();
            let broker = BrokerState::new("workspace-test");
            let identity = broker.identity().clone();
            let executor = StoreExecutor::open(&store_path).await.unwrap();
            let context = Arc::new(WorkspaceBrokerLane::new(broker, executor.clone()));

            let host = test_candidate_extension_host_with_application_plugins().await;
            let run_repository = executor.run_repository();
            let project = host
                .build_project_candidate(
                    super::extension_project_scope_id(&normalized_root).unwrap(),
                    super::internal_plugins_for_scope(
                        &rho_extension_runtime::ScopePolicy::project_kind(),
                    ),
                    Arc::new(super::RunHistoryBrokerFacade::new(
                        run_repository,
                        normalized_root.clone(),
                    )),
                )
                .await
                .unwrap();
            host.publish_project_candidate(None, project.clone())
                .await
                .unwrap();
            let response = json!({
                "execution_id": "snapshot-fixture",
                "execution": {"ok": true, "objects": []},
                "workspace": identity,
            });
            let requests = Arc::new(StdMutex::new(Vec::new()));
            let workspace = host
                .build_workspace_candidate(
                    &project,
                    super::extension_workspace_scope_id(&project, &identity).unwrap(),
                    super::internal_plugins_for_scope(
                        &rho_extension_runtime::ScopePolicy::workspace_kind(),
                    ),
                    Arc::new(RecordingWorkspaceBroker {
                        response: response.clone(),
                        failure: None,
                        requests: Arc::clone(&requests),
                    }),
                )
                .await
                .unwrap();
            host.publish_workspace_candidate(None, workspace)
                .await
                .unwrap();
            let state = test_app_state_with_extension_host(
                tempdir.path(),
                &project_root,
                &store_path,
                Arc::clone(&host),
            );
            *state.context.lock().await = Some(Arc::clone(&context));

            assert_eq!(
                super::snapshot_workspace_with_state(&state).await.unwrap(),
                response
            );
            let adapter = super::ExtensionWorkspaceSnapshotAdapter::new(
                Arc::clone(&host),
                Arc::clone(&context),
            );
            let agent_result = rho_server::coordinator::WorkspaceSnapshotAdapter::snapshot(
                &adapter,
                json!({
                    "arguments": {},
                    "expected_workspace": super::expected_workspace(&identity),
                }),
                "agent_workspace_fixture".to_string(),
            )
            .await
            .unwrap();
            assert_eq!(agent_result, response);

            context.lock().await.broker.project_changed();
            let stale_error = super::snapshot_workspace_with_state(&state)
                .await
                .unwrap_err();
            assert!(stale_error.contains("stale after Workspace state changed"));

            let requests = requests.lock().unwrap();
            assert_eq!(requests.len(), 3);
            for request in requests.iter() {
                assert_eq!(request["operation"], "snapshot");
                assert!(request.get("code").is_none());
                assert!(request.get("expression").is_none());
            }
            assert_eq!(requests[0]["origin"], "system");
            assert!(requests[0]["execution_id"].is_null());
            assert_eq!(requests[1]["origin"], "agent");
            assert_eq!(requests[1]["execution_id"], "agent_workspace_fixture");
            assert_eq!(requests[2]["origin"], "system");
        });
    }

    #[test]
    fn candidate_workspace_snapshot_handler_failure_does_not_retry_legacy() {
        let runtime = tokio::runtime::Runtime::new().unwrap();
        runtime.block_on(async {
            let tempdir = TempDir::new().unwrap();
            let project_root = tempdir.path().join("project-a");
            std::fs::create_dir_all(&project_root).unwrap();
            let normalized_root = normalize_project_root(project_root.to_string_lossy().as_ref());
            let store_path = tempdir.path().join("rho.sqlite");
            let mut store = Store::open(&store_path).unwrap();
            store.set_project_root(Some(&normalized_root)).unwrap();
            let broker = BrokerState::new("workspace-failure");
            let identity = broker.identity().clone();
            let executor = StoreExecutor::open(&store_path).await.unwrap();
            let context = Arc::new(WorkspaceBrokerLane::new(broker, executor.clone()));
            let host = test_candidate_extension_host_with_application_plugins().await;
            let run_repository = executor.run_repository();
            let project = host
                .build_project_candidate(
                    super::extension_project_scope_id(&normalized_root).unwrap(),
                    super::internal_plugins_for_scope(
                        &rho_extension_runtime::ScopePolicy::project_kind(),
                    ),
                    Arc::new(super::RunHistoryBrokerFacade::new(
                        run_repository,
                        normalized_root,
                    )),
                )
                .await
                .unwrap();
            host.publish_project_candidate(None, project.clone())
                .await
                .unwrap();
            let workspace = host
                .build_workspace_candidate(
                    &project,
                    super::extension_workspace_scope_id(&project, &identity).unwrap(),
                    super::internal_plugins_for_scope(
                        &rho_extension_runtime::ScopePolicy::workspace_kind(),
                    ),
                    Arc::new(RecordingWorkspaceBroker {
                        response: json!({}),
                        failure: Some(("ark_unavailable", "injected Ark failure")),
                        requests: Arc::new(StdMutex::new(Vec::new())),
                    }),
                )
                .await
                .unwrap();
            host.publish_workspace_candidate(None, workspace)
                .await
                .unwrap();
            let state = test_app_state_with_extension_host(
                tempdir.path(),
                &project_root,
                &store_path,
                host,
            );
            *state.context.lock().await = Some(context);
            let error = super::snapshot_workspace_with_state(&state)
                .await
                .unwrap_err();
            assert!(error.contains("ark_unavailable"));
        });
    }

    #[test]
    fn project_file_viewer_legacy_candidate_and_two_project_results_match() {
        let runtime = tokio::runtime::Runtime::new().unwrap();
        runtime.block_on(async {
            let tempdir = TempDir::new().unwrap();
            let project_a_path = tempdir.path().join("project-a");
            let project_b_path = tempdir.path().join("project-b");
            std::fs::create_dir_all(&project_a_path).unwrap();
            std::fs::create_dir_all(&project_b_path).unwrap();
            let project_a = project_a_path.canonicalize().unwrap();
            let project_b = project_b_path.canonicalize().unwrap();
            std::fs::write(project_a.join("report.html"), "<h1>project A</h1>").unwrap();
            std::fs::write(project_b.join("report.html"), "<h1>project B</h1>").unwrap();
            let store_path = tempdir.path().join("rho.sqlite");
            Store::open(&store_path).unwrap();

            let legacy = test_app_state(tempdir.path(), &project_a, &store_path);
            let candidate = test_app_state_with_extension_host(
                tempdir.path(),
                &project_a,
                &store_path,
                test_candidate_extension_host_with_application_plugins().await,
            );
            let legacy_a = crate::commands::project_session::viewer_read_file_with_state(
                "report.html".to_string(),
                &legacy,
            )
            .await
            .unwrap();
            let candidate_a = crate::commands::project_session::viewer_read_file_with_state(
                "report.html".to_string(),
                &candidate,
            )
            .await
            .unwrap();
            assert_eq!(legacy_a, candidate_a);
            assert_eq!(candidate_a.content, "<h1>project A</h1>");

            *candidate.project_root.write().await = project_b.clone();
            let candidate_b = crate::commands::project_session::viewer_read_file_with_state(
                "report.html".to_string(),
                &candidate,
            )
            .await
            .unwrap();
            assert_eq!(candidate_b.content, "<h1>project B</h1>");
            assert_ne!(candidate_a.project_root, candidate_b.project_root);
            assert!(
                crate::commands::project_session::viewer_read_file_with_state(
                    "../project-a/report.html".to_string(),
                    &candidate
                )
                .await
                .is_err()
            );

            let missing = test_app_state_with_extension_mode(
                tempdir.path(),
                &project_a,
                &store_path,
                InternalExtensionRuntimeMode::Candidate,
            );
            let error = crate::commands::project_session::viewer_read_file_with_state(
                "report.html".to_string(),
                &missing,
            )
            .await
            .unwrap_err();
            assert!(error.contains("viewer contribution is missing"));
        });
    }

    #[test]
    fn run_history_candidate_matches_store_across_limits_projects_and_restart() {
        let runtime = tokio::runtime::Runtime::new().unwrap();
        runtime.block_on(async {
            let tempdir = TempDir::new().unwrap();
            let project_a = tempdir.path().join("project-a");
            let project_b = tempdir.path().join("project-b");
            let project_empty = tempdir.path().join("project-empty");
            for root in [&project_a, &project_b, &project_empty] {
                std::fs::create_dir_all(root).unwrap();
            }
            let store_path = tempdir.path().join("rho.sqlite");
            let root_a = normalize_project_root(project_a.to_string_lossy().as_ref());
            let root_b = normalize_project_root(project_b.to_string_lossy().as_ref());
            let mut store = Store::open(&store_path).unwrap();
            store.set_project_root(Some(&root_a)).unwrap();
            create_run_fixture(&mut store, &root_a, "run-a-1", "a <- 1");
            create_run_fixture(&mut store, &root_a, "run-a-2", "a <- 2");
            create_run_fixture(&mut store, &root_b, "run-b-1", "b <- 1");
            let expected_a = store.list_runs(&root_a, None).unwrap();
            let expected_a_one = store.list_runs(&root_a, Some(1)).unwrap();
            let expected_b = store.list_runs(&root_b, None).unwrap();
            drop(store);

            let legacy = test_app_state(tempdir.path(), &project_a, &store_path);
            assert_run_summaries_equal(
                list_runs_with_state(None, &legacy).await.unwrap(),
                &expected_a,
            );

            let candidate = test_app_state_with_extension_mode(
                tempdir.path(),
                &project_a,
                &store_path,
                InternalExtensionRuntimeMode::Candidate,
            );
            candidate
                .switch_test_control
                .succeed_without_running(SwitchTestStep::SyncWorkspace);
            switch_project_with_watcher_factory(project_a.clone(), None, &candidate, |_| {
                Ok(ProjectWatcherControl::noop())
            })
            .await
            .unwrap();
            assert_run_summaries_equal(
                list_runs_with_state(None, &candidate).await.unwrap(),
                &expected_a,
            );
            assert_run_summaries_equal(
                list_runs_with_state(Some(1), &candidate).await.unwrap(),
                &expected_a_one,
            );
            assert!(
                list_runs_with_state(Some(0), &candidate)
                    .await
                    .unwrap()
                    .is_empty()
            );

            candidate
                .switch_test_control
                .succeed_without_running(SwitchTestStep::SyncWorkspace);
            switch_project_with_watcher_factory(project_b.clone(), None, &candidate, |_| {
                Ok(ProjectWatcherControl::noop())
            })
            .await
            .unwrap();
            assert_run_summaries_equal(
                list_runs_with_state(None, &candidate).await.unwrap(),
                &expected_b,
            );

            candidate
                .switch_test_control
                .succeed_without_running(SwitchTestStep::SyncWorkspace);
            switch_project_with_watcher_factory(project_empty, None, &candidate, |_| {
                Ok(ProjectWatcherControl::noop())
            })
            .await
            .unwrap();
            assert!(
                list_runs_with_state(None, &candidate)
                    .await
                    .unwrap()
                    .is_empty()
            );

            let restarted = test_app_state_with_extension_mode(
                tempdir.path(),
                &project_a,
                &store_path,
                InternalExtensionRuntimeMode::Candidate,
            );
            restarted
                .switch_test_control
                .succeed_without_running(SwitchTestStep::SyncWorkspace);
            switch_project_with_watcher_factory(project_a, None, &restarted, |_| {
                Ok(ProjectWatcherControl::noop())
            })
            .await
            .unwrap();
            assert_run_summaries_equal(
                list_runs_with_state(None, &restarted).await.unwrap(),
                &expected_a,
            );
        });
    }

    #[test]
    fn late_run_history_result_is_rejected_across_project_a_b_a() {
        let runtime = tokio::runtime::Runtime::new().unwrap();
        runtime.block_on(async {
            let tempdir = TempDir::new().unwrap();
            let project_a = tempdir.path().join("project-a");
            let project_b = tempdir.path().join("project-b");
            std::fs::create_dir_all(&project_a).unwrap();
            std::fs::create_dir_all(&project_b).unwrap();
            let store_path = tempdir.path().join("rho.sqlite");
            let root_a = normalize_project_root(project_a.to_string_lossy().as_ref());
            let root_b = normalize_project_root(project_b.to_string_lossy().as_ref());
            let mut store = Store::open(&store_path).unwrap();
            store.set_project_root(Some(&root_a)).unwrap();
            create_run_fixture(&mut store, &root_a, "run-a", "a <- 1");
            create_run_fixture(&mut store, &root_b, "run-b", "b <- 1");
            let expected_a = store.list_runs(&root_a, None).unwrap();
            let expected_b = store.list_runs(&root_b, None).unwrap();
            drop(store);

            let state = Arc::new(test_app_state_with_extension_mode(
                tempdir.path(),
                &project_a,
                &store_path,
                InternalExtensionRuntimeMode::Candidate,
            ));
            let started = Arc::new(Semaphore::new(0));
            let release = Arc::new(Semaphore::new(0));
            let delayed = state
                .extension_host
                .build_project_candidate(
                    super::extension_project_scope_id(&root_a).unwrap(),
                    vec![Arc::new(DelayedRunHistoryPlugin::new(
                        Arc::clone(&started),
                        Arc::clone(&release),
                        serde_json::to_value(&expected_a).unwrap(),
                    ))],
                    Arc::new(rho_extension_runtime::RejectingBrokerFacade),
                )
                .await
                .unwrap();
            state
                .extension_host
                .publish_project_candidate(None, delayed)
                .await
                .unwrap();

            let call_state = Arc::clone(&state);
            let old_call =
                tokio::spawn(async move { list_runs_with_state(None, call_state.as_ref()).await });
            started.acquire().await.unwrap().forget();

            state
                .switch_test_control
                .succeed_without_running(SwitchTestStep::SyncWorkspace);
            let switch_state = Arc::clone(&state);
            let switch_project_b = project_b.clone();
            let switch = tokio::spawn(async move {
                switch_project_with_watcher_factory(
                    switch_project_b,
                    None,
                    switch_state.as_ref(),
                    |_| Ok(ProjectWatcherControl::noop()),
                )
                .await
            });
            // Full-workspace parallel tests can briefly starve this task while
            // the switch remains bounded; five seconds avoids a scheduler-only
            // failure without relaxing the stale-generation assertion.
            tokio::time::timeout(Duration::from_secs(5), async {
                loop {
                    if *state.project_root.read().await == project_b {
                        break;
                    }
                    tokio::task::yield_now().await;
                }
            })
            .await
            .expect("project B must become authoritative before old call is released");
            release.add_permits(1);

            let error = old_call.await.unwrap().unwrap_err();
            assert!(error.contains("stale activation generation"));
            assert_eq!(switch.await.unwrap().unwrap().status, "ready");
            assert_run_summaries_equal(
                list_runs_with_state(None, state.as_ref()).await.unwrap(),
                &expected_b,
            );

            state
                .switch_test_control
                .succeed_without_running(SwitchTestStep::SyncWorkspace);
            assert_eq!(
                switch_project_with_watcher_factory(project_a, None, state.as_ref(), |_| Ok(
                    ProjectWatcherControl::noop()
                ),)
                .await
                .unwrap()
                .status,
                "ready"
            );
            assert_run_summaries_equal(
                list_runs_with_state(None, state.as_ref()).await.unwrap(),
                &expected_a,
            );
        });
    }

    #[test]
    fn run_history_missing_contribution_and_activation_failure_fail_closed_after_p1_2() {
        let runtime = tokio::runtime::Runtime::new().unwrap();
        runtime.block_on(async {
            let tempdir = TempDir::new().unwrap();
            let project_a = tempdir.path().join("project-a");
            let project_b = tempdir.path().join("project-b");
            std::fs::create_dir_all(&project_a).unwrap();
            std::fs::create_dir_all(&project_b).unwrap();
            let store_path = tempdir.path().join("rho.sqlite");
            let root_a = normalize_project_root(project_a.to_string_lossy().as_ref());
            let root_b = normalize_project_root(project_b.to_string_lossy().as_ref());
            let mut store = Store::open(&store_path).unwrap();
            store.set_project_root(Some(&root_a)).unwrap();
            create_run_fixture(&mut store, &root_a, "run-a", "a <- 1");
            create_run_fixture(&mut store, &root_b, "run-b", "b <- 1");
            let expected_a = store.list_runs(&root_a, None).unwrap();
            drop(store);

            let state = test_app_state_with_extension_mode(
                tempdir.path(),
                &project_a,
                &store_path,
                InternalExtensionRuntimeMode::Candidate,
            );
            state
                .switch_test_control
                .succeed_without_running(SwitchTestStep::SyncWorkspace);
            switch_project_with_watcher_factory(project_a.clone(), None, &state, |_| {
                Ok(ProjectWatcherControl::noop())
            })
            .await
            .unwrap();
            let old_scope = state.extension_host.scopes().project().unwrap();
            assert_run_summaries_equal(
                list_runs_with_state(None, &state).await.unwrap(),
                &expected_a,
            );

            state.switch_test_control.fail(
                SwitchTestStep::ActivateExtensionCandidate,
                "inject activation failure",
            );
            state
                .switch_test_control
                .succeed_without_running(SwitchTestStep::SyncWorkspace);
            let error = switch_project_with_watcher_factory(project_b, None, &state, |_| {
                Ok(ProjectWatcherControl::noop())
            })
            .await
            .unwrap_err();
            assert!(
                error
                    .to_string()
                    .contains("required extension project candidate")
            );
            assert_eq!(*state.project_root.read().await, project_a);
            assert!(Arc::ptr_eq(
                &state.extension_host.scopes().project().unwrap(),
                &old_scope
            ));
            assert_run_summaries_equal(
                list_runs_with_state(None, &state).await.unwrap(),
                &expected_a,
            );

            let missing_state = test_app_state_with_extension_mode(
                tempdir.path(),
                &project_a,
                &store_path,
                InternalExtensionRuntimeMode::Candidate,
            );
            let missing = missing_state
                .extension_host
                .build_empty_project_candidate(super::extension_project_scope_id(&root_a).unwrap())
                .await
                .unwrap();
            missing_state
                .extension_host
                .publish_project_candidate(None, missing)
                .await
                .unwrap();
            let error = list_runs_with_state(None, &missing_state)
                .await
                .unwrap_err();
            assert!(error.contains("source contribution is missing"));
        });
    }

    #[test]
    fn run_history_handler_error_does_not_silently_fallback() {
        let runtime = tokio::runtime::Runtime::new().unwrap();
        runtime.block_on(async {
            let tempdir = TempDir::new().unwrap();
            let project_root = tempdir.path().join("project-a");
            std::fs::create_dir_all(&project_root).unwrap();
            let store_path = tempdir.path().join("rho.sqlite");
            let root = normalize_project_root(project_root.to_string_lossy().as_ref());
            let mut store = Store::open(&store_path).unwrap();
            store.set_project_root(Some(&root)).unwrap();
            create_run_fixture(&mut store, &root, "run-a", "a <- 1");
            drop(store);
            let state = test_app_state_with_extension_mode(
                tempdir.path(),
                &project_root,
                &store_path,
                InternalExtensionRuntimeMode::Candidate,
            );
            let candidate = state
                .extension_host
                .build_project_candidate(
                    super::extension_project_scope_id(&root).unwrap(),
                    super::internal_plugins_for_scope(
                        &rho_extension_runtime::ScopePolicy::project_kind(),
                    ),
                    Arc::new(super::RunHistoryBrokerFacade::unavailable(
                        root,
                        "injected Store executor initialization failure",
                    )),
                )
                .await
                .unwrap();
            state
                .extension_host
                .publish_project_candidate(None, candidate)
                .await
                .unwrap();
            let error = list_runs_with_state(None, &state).await.unwrap_err();
            assert!(error.contains("runs_store_open"));
        });
    }

    #[test]
    fn run_history_candidate_rejects_oversized_store_response_without_fallback() {
        let runtime = tokio::runtime::Runtime::new().unwrap();
        runtime.block_on(async {
            let tempdir = TempDir::new().unwrap();
            let project_root = tempdir.path().join("project-a");
            std::fs::create_dir_all(&project_root).unwrap();
            let store_path = tempdir.path().join("rho.sqlite");
            let root = normalize_project_root(project_root.to_string_lossy().as_ref());
            let mut store = Store::open(&store_path).unwrap();
            store.set_project_root(Some(&root)).unwrap();
            create_run_fixture(&mut store, &root, "run-large", "x <- 1");
            store
                .finish_run(&RunFinish {
                    run_id: "run-large".to_string(),
                    status: "failed".to_string(),
                    terminal_reason: Some("r_error".to_string()),
                    workspace_id: Some("ws-run-large".to_string()),
                    state_revision_after: Some(2),
                    project_revision_after: Some(1),
                    stdout: None,
                    value_text: None,
                    messages: Vec::new(),
                    warnings: Vec::new(),
                    error_message: Some("x".repeat(1024 * 1024)),
                    error_call: None,
                    traceback: Vec::new(),
                    environment_snapshot_id_after: None,
                })
                .unwrap();
            drop(store);
            let state = test_app_state_with_extension_mode(
                tempdir.path(),
                &project_root,
                &store_path,
                InternalExtensionRuntimeMode::Candidate,
            );
            state
                .switch_test_control
                .succeed_without_running(SwitchTestStep::SyncWorkspace);
            switch_project_with_watcher_factory(project_root, None, &state, |_| {
                Ok(ProjectWatcherControl::noop())
            })
            .await
            .unwrap();
            let error = list_runs_with_state(None, &state).await.unwrap_err();
            assert!(error.contains("broker payload is too large"));
        });
    }

    #[test]
    fn runs_broker_rejects_unknown_request_fields_before_store_dispatch() {
        let runtime = tokio::runtime::Runtime::new().unwrap();
        runtime.block_on(async {
            let facade = super::RunHistoryBrokerFacade::unavailable(
                "project.a".to_string(),
                "Store must not be reached for malformed input",
            );
            for payload in [
                json!({ "limit": 1, "unknown": true }),
                json!({ "limit": -1 }),
                json!({ "limit": "one" }),
            ] {
                let request = rho_extension_runtime::BrokerRequest::new(
                    super::runs_broker_operation_id(),
                    payload,
                    rho_extension_runtime::BrokerResponseClass::Generic,
                )
                .unwrap();
                assert!(matches!(
                    facade.call(request).await,
                    Err(rho_extension_runtime::BrokerError::Rejected { ref code, .. })
                        if code == "runs_request_invalid"
                ));
            }
        });
    }

    #[test]
    fn run_history_facade_does_not_wait_for_workspace_lane() {
        let runtime = tokio::runtime::Runtime::new().unwrap();
        runtime.block_on(async {
            let tempdir = TempDir::new().unwrap();
            let project_root = tempdir.path().join("project-a");
            std::fs::create_dir_all(&project_root).unwrap();
            let normalized_root = normalize_project_root(project_root.to_string_lossy().as_ref());
            let store_path = tempdir.path().join("rho.sqlite");
            let mut store = Store::open(&store_path).unwrap();
            create_run_fixture(&mut store, &normalized_root, "run-a", "a <- 1");
            drop(store);

            let executor = StoreExecutor::open(&store_path).await.unwrap();
            let repository = executor.run_repository();
            let lane = Arc::new(WorkspaceBrokerLane::new(
                BrokerState::new("workspace.run-history"),
                executor,
            ));
            let held_workspace = lane.lock().await;
            let facade = super::RunHistoryBrokerFacade::new(repository, normalized_root);
            let request = rho_extension_runtime::BrokerRequest::new(
                super::runs_broker_operation_id(),
                json!({"limit": 10}),
                rho_extension_runtime::BrokerResponseClass::Generic,
            )
            .unwrap();
            let response = tokio::time::timeout(Duration::from_millis(250), facade.call(request))
                .await
                .expect("Run History facade waited for the held Workspace broker lane")
                .unwrap();
            let runs: Vec<rho_store::RunSummary> =
                serde_json::from_value(response.payload.into_value()).unwrap();
            assert_eq!(runs.len(), 1);
            assert_eq!(runs[0].run_id, "run-a");
            assert!(
                tokio::time::timeout(Duration::from_millis(20), lane.lock())
                    .await
                    .is_err(),
                "test did not keep the Workspace broker lane contended"
            );
            drop(held_workspace);
        });
    }

    #[test]
    fn candidate_scope_rolls_back_for_each_bh2_post_workspace_failure() {
        let runtime = tokio::runtime::Runtime::new().unwrap();
        runtime.block_on(async {
            for (case, failed_step, watcher_fails) in [
                ("watcher", None, true),
                ("store", Some(SwitchTestStep::SetActiveProjectRoot), false),
                (
                    "last-opened",
                    Some(SwitchTestStep::SaveLastOpenedProject),
                    false,
                ),
            ] {
                let tempdir = TempDir::new().unwrap();
                let project_a = tempdir.path().join(format!("project-a-{case}"));
                let project_b = tempdir.path().join(format!("project-b-{case}"));
                std::fs::create_dir_all(&project_a).unwrap();
                std::fs::create_dir_all(&project_b).unwrap();
                let store_path = tempdir.path().join("rho.sqlite");
                let root_a = normalize_project_root(project_a.to_string_lossy().as_ref());
                Store::open(&store_path)
                    .unwrap()
                    .set_project_root(Some(&root_a))
                    .unwrap();
                let state = test_app_state_with_extension_mode(
                    tempdir.path(),
                    &project_a,
                    &store_path,
                    InternalExtensionRuntimeMode::Candidate,
                );
                state
                    .switch_test_control
                    .succeed_without_running(SwitchTestStep::SyncWorkspace);
                switch_project_with_watcher_factory(project_a.clone(), None, &state, |_| {
                    Ok(ProjectWatcherControl::noop())
                })
                .await
                .unwrap();
                let previous_scope = state.extension_host.scopes().project().unwrap();

                state
                    .switch_test_control
                    .succeed_without_running(SwitchTestStep::SyncWorkspace);
                state
                    .switch_test_control
                    .succeed_without_running(SwitchTestStep::RestoreWorkspace);
                if let Some(step) = failed_step {
                    state
                        .switch_test_control
                        .fail(step, format!("inject {case} failure"));
                }
                let response = switch_project_with_watcher_factory(project_b, None, &state, |_| {
                    if watcher_fails {
                        Err(anyhow::anyhow!("inject watcher failure"))
                    } else {
                        Ok(ProjectWatcherControl::noop())
                    }
                })
                .await
                .unwrap();

                assert_eq!(response.status, "failed_restored", "case {case}");
                let current_scope = state.extension_host.scopes().project().unwrap();
                assert!(Arc::ptr_eq(&current_scope, &previous_scope), "case {case}");
                assert_eq!(current_scope.state(), ScopeLifecycleState::Active);
                assert_eq!(
                    state
                        .project_root
                        .read()
                        .await
                        .to_string_lossy()
                        .replace('\\', "/"),
                    project_a.to_string_lossy().replace('\\', "/")
                );
                assert_eq!(
                    Store::open(&store_path)
                        .unwrap()
                        .active_project_root()
                        .unwrap()
                        .as_deref(),
                    Some(root_a.as_str())
                );
            }
        });
    }

    #[test]
    fn candidate_build_failure_precedes_every_bh2_side_effect() {
        let runtime = tokio::runtime::Runtime::new().unwrap();
        runtime.block_on(async {
            let tempdir = TempDir::new().unwrap();
            let project_a = tempdir.path().join("project-a");
            let project_b = tempdir.path().join("project-b");
            std::fs::create_dir_all(&project_a).unwrap();
            std::fs::create_dir_all(&project_b).unwrap();
            let store_path = tempdir.path().join("rho.sqlite");
            let root_a = normalize_project_root(project_a.to_string_lossy().as_ref());
            Store::open(&store_path)
                .unwrap()
                .set_project_root(Some(&root_a))
                .unwrap();
            let state = test_app_state_with_extension_mode(
                tempdir.path(),
                &project_a,
                &store_path,
                InternalExtensionRuntimeMode::Candidate,
            );
            state
                .switch_test_control
                .succeed_without_running(SwitchTestStep::SyncWorkspace);
            switch_project_with_watcher_factory(project_a.clone(), None, &state, |_| {
                Ok(ProjectWatcherControl::noop())
            })
            .await
            .unwrap();
            let previous_scope = state.extension_host.scopes().project().unwrap();

            state.switch_test_control.fail(
                SwitchTestStep::BuildExtensionCandidate,
                "inject extension candidate failure",
            );
            state.switch_test_control.fail(
                SwitchTestStep::SyncWorkspace,
                "workspace step must remain untouched",
            );
            let error = switch_project_with_watcher_factory(project_b, None, &state, |_| {
                Ok(ProjectWatcherControl::noop())
            })
            .await
            .unwrap_err();
            assert!(error.to_string().contains("extension candidate failure"));
            assert!(matches!(
                state
                    .switch_test_control
                    .take(SwitchTestStep::SyncWorkspace),
                Some(super::SwitchTestDirective::Fail(_))
            ));
            assert!(Arc::ptr_eq(
                &state.extension_host.scopes().project().unwrap(),
                &previous_scope
            ));
            assert_eq!(
                state
                    .project_root
                    .read()
                    .await
                    .to_string_lossy()
                    .replace('\\', "/"),
                project_a.to_string_lossy().replace('\\', "/")
            );
            assert_eq!(
                Store::open(&store_path)
                    .unwrap()
                    .active_project_root()
                    .unwrap()
                    .as_deref(),
                Some(root_a.as_str())
            );
        });
    }

    #[test]
    fn workspace_sync_failure_rolls_back_unpublished_candidate_generation() {
        let runtime = tokio::runtime::Runtime::new().unwrap();
        runtime.block_on(async {
            let tempdir = TempDir::new().unwrap();
            let project_a = tempdir.path().join("project-a");
            let project_b = tempdir.path().join("project-b");
            std::fs::create_dir_all(&project_a).unwrap();
            std::fs::create_dir_all(&project_b).unwrap();
            let store_path = tempdir.path().join("rho.sqlite");
            let root_a = normalize_project_root(project_a.to_string_lossy().as_ref());
            Store::open(&store_path)
                .unwrap()
                .set_project_root(Some(&root_a))
                .unwrap();
            let state = test_app_state_with_extension_mode(
                tempdir.path(),
                &project_a,
                &store_path,
                InternalExtensionRuntimeMode::Candidate,
            );
            state
                .switch_test_control
                .succeed_without_running(SwitchTestStep::SyncWorkspace);
            switch_project_with_watcher_factory(project_a.clone(), None, &state, |_| {
                Ok(ProjectWatcherControl::noop())
            })
            .await
            .unwrap();
            let previous_scope = state.extension_host.scopes().project().unwrap();

            state
                .switch_test_control
                .fail(SwitchTestStep::SyncWorkspace, "inject workspace failure");
            assert!(
                switch_project_with_watcher_factory(project_b.clone(), None, &state, |_| Ok(
                    ProjectWatcherControl::noop()
                ),)
                .await
                .is_err()
            );
            assert!(Arc::ptr_eq(
                &state.extension_host.scopes().project().unwrap(),
                &previous_scope
            ));

            state
                .switch_test_control
                .succeed_without_running(SwitchTestStep::SyncWorkspace);
            switch_project_with_watcher_factory(project_b, None, &state, |_| {
                Ok(ProjectWatcherControl::noop())
            })
            .await
            .unwrap();
            let current = state.extension_host.scopes().project().unwrap();
            assert_eq!(current.identity().generation.get(), 4);
            assert_eq!(previous_scope.state(), ScopeLifecycleState::Disposed);
        });
    }

    #[test]
    fn desktop_shutdown_disposes_extension_project_before_application() {
        let runtime = tokio::runtime::Runtime::new().unwrap();
        runtime.block_on(async {
            let tempdir = TempDir::new().unwrap();
            let project_root = tempdir.path().join("project-a");
            std::fs::create_dir_all(&project_root).unwrap();
            let store_path = tempdir.path().join("rho.sqlite");
            let normalized_root = normalize_project_root(project_root.to_string_lossy().as_ref());
            Store::open(&store_path)
                .unwrap()
                .set_project_root(Some(&normalized_root))
                .unwrap();
            let state = test_app_state_with_extension_mode(
                tempdir.path(),
                &project_root,
                &store_path,
                InternalExtensionRuntimeMode::Candidate,
            );
            state
                .switch_test_control
                .succeed_without_running(SwitchTestStep::SyncWorkspace);
            switch_project_with_watcher_factory(project_root, None, &state, |_| {
                Ok(ProjectWatcherControl::noop())
            })
            .await
            .unwrap();
            let project = state.extension_host.scopes().project().unwrap();
            let application = state.extension_host.scopes().application();

            shutdown_application(&state).await.unwrap();
            assert_eq!(project.state(), ScopeLifecycleState::Disposed);
            assert_eq!(application.state(), ScopeLifecycleState::Disposed);
        });
    }

    #[test]
    fn desktop_shutdown_waits_for_project_transition_gate() {
        let runtime = tokio::runtime::Runtime::new().unwrap();
        runtime.block_on(async {
            let tempdir = TempDir::new().unwrap();
            let project_root = tempdir.path().join("project-a");
            std::fs::create_dir_all(&project_root).unwrap();
            let store_path = tempdir.path().join("rho.sqlite");
            let normalized_root = normalize_project_root(project_root.to_string_lossy().as_ref());
            Store::open(&store_path)
                .unwrap()
                .set_project_root(Some(&normalized_root))
                .unwrap();
            let state = Arc::new(test_app_state(tempdir.path(), &project_root, &store_path));
            let transition = state.project_transition_gate.lock().await;
            let closing_state = Arc::clone(&state);
            let closing = tokio::spawn(async move { shutdown_application(&closing_state).await });
            tokio::time::sleep(Duration::from_millis(10)).await;
            assert!(!closing.is_finished());
            drop(transition);
            closing.await.unwrap().unwrap();
        });
    }

    #[test]
    fn project_switch_returns_failed_restored_and_preserves_previous_state() {
        let runtime = tokio::runtime::Runtime::new().unwrap();
        runtime.block_on(async {
            let tempdir = TempDir::new().unwrap();
            let project_a = tempdir.path().join("project-a");
            let project_b = tempdir.path().join("project-b");
            std::fs::create_dir_all(&project_a).unwrap();
            std::fs::create_dir_all(&project_b).unwrap();
            let store_path = tempdir.path().join("rho.sqlite");
            let mut store = Store::open(&store_path).unwrap();
            let root_a = normalize_project_root(project_a.to_string_lossy().as_ref());
            store.set_project_root(Some(&root_a)).unwrap();
            let state = test_app_state(tempdir.path(), &project_a, &store_path);
            let previous_session = save_session_fixture(&state, &project_a, "old.R", 210);
            save_session_fixture(&state, &project_b, "new.R", 260);
            state
                .switch_test_control
                .succeed_without_running(SwitchTestStep::SyncWorkspace);
            state.switch_test_control.fail(
                SwitchTestStep::SetActiveProjectRoot,
                "inject store root failure",
            );
            state
                .switch_test_control
                .succeed_without_running(SwitchTestStep::RestoreWorkspace);

            let response =
                switch_project_with_watcher_factory(project_b.clone(), None, &state, |_| {
                    Ok(ProjectWatcherControl::noop())
                })
                .await
                .unwrap();

            let restored_root = project_a.to_string_lossy().replace('\\', "/");
            assert_eq!(response.status, "failed_restored");
            assert_eq!(
                response.reason_code.as_deref(),
                Some("project_switch_store_root_failed")
            );
            assert_eq!(
                response.restored_root.as_deref(),
                Some(restored_root.as_str())
            );
            assert_eq!(
                response.session.active_document,
                previous_session.active_document
            );
            assert_eq!(
                state
                    .project_root
                    .read()
                    .await
                    .to_string_lossy()
                    .replace('\\', "/"),
                project_a.to_string_lossy().replace('\\', "/")
            );
            let active_root = Store::open(&store_path)
                .unwrap()
                .active_project_root()
                .unwrap()
                .unwrap();
            assert_eq!(active_root, root_a);
        });
    }

    #[test]
    fn project_switch_returns_fatal_when_restore_path_fails() {
        let runtime = tokio::runtime::Runtime::new().unwrap();
        runtime.block_on(async {
            let tempdir = TempDir::new().unwrap();
            let project_a = tempdir.path().join("project-a");
            let project_b = tempdir.path().join("project-b");
            std::fs::create_dir_all(&project_a).unwrap();
            std::fs::create_dir_all(&project_b).unwrap();
            let store_path = tempdir.path().join("rho.sqlite");
            let mut store = Store::open(&store_path).unwrap();
            let root_a = normalize_project_root(project_a.to_string_lossy().as_ref());
            store.set_project_root(Some(&root_a)).unwrap();
            let state = test_app_state(tempdir.path(), &project_a, &store_path);
            let previous_session = save_session_fixture(&state, &project_a, "old.R", 210);
            state
                .switch_test_control
                .succeed_without_running(SwitchTestStep::SyncWorkspace);
            state.switch_test_control.fail(
                SwitchTestStep::SetActiveProjectRoot,
                "inject store root failure",
            );
            state
                .switch_test_control
                .fail(SwitchTestStep::RestoreWorkspace, "inject restore failure");

            let response =
                switch_project_with_watcher_factory(project_b.clone(), None, &state, |_| {
                    Ok(ProjectWatcherControl::noop())
                })
                .await
                .unwrap();

            assert_eq!(response.status, "fatal");
            assert!(response.restart_required);
            assert_eq!(
                response.reason_code.as_deref(),
                Some("project_switch_restore_failed")
            );
            assert_eq!(
                response.session.active_document,
                previous_session.active_document
            );
            assert_eq!(
                state
                    .project_root
                    .read()
                    .await
                    .to_string_lossy()
                    .replace('\\', "/"),
                project_a.to_string_lossy().replace('\\', "/")
            );
        });
    }

    #[test]
    fn enforces_the_documented_minimum_r_version() {
        assert!(ensure_supported_r_version("4.3.3").is_err());
        assert!(ensure_supported_r_version("4.4.0").is_ok());
        assert!(ensure_supported_r_version("5.0.0").is_ok());
        assert!(ensure_supported_r_version("invalid").is_err());
    }

    #[test]
    fn requires_arm64_r_only_for_apple_silicon_macos() {
        assert!(r_architecture_supported("macos", "aarch64", "aarch64"));
        assert!(r_architecture_supported("macos", "aarch64", "arm64"));
        assert!(!r_architecture_supported("macos", "aarch64", "x86_64"));
        assert!(r_architecture_supported("windows", "x86_64", "x86_64"));
        assert!(r_architecture_supported("linux", "x86_64", "x86_64"));
        assert!(!r_architecture_supported("linux", "x86_64", "aarch64"));
        assert!(!r_architecture_supported("linux", "x86_64", "arm64"));
        assert!(r_architecture_supported("linux", "aarch64", "aarch64"));

        if cfg!(all(target_os = "macos", target_arch = "aarch64")) {
            assert!(ensure_supported_r_architecture("aarch64").is_ok());
            assert!(ensure_supported_r_architecture("x86_64").is_err());
        }
        if cfg!(all(target_os = "linux", target_arch = "x86_64")) {
            assert!(ensure_supported_r_architecture("x86_64").is_ok());
            assert!(ensure_supported_r_architecture("aarch64").is_err());
            let detail = ensure_supported_r_architecture("aarch64")
                .unwrap_err()
                .to_string();
            assert!(detail.contains("R_ARCH_MISMATCH"));
            assert!(detail.contains("Rho for Linux x64 requires x86_64 R"));
        }
    }

    #[test]
    fn executable_path_search_preserves_spaces_and_unicode() {
        let directory = TempDir::new().unwrap();
        let first = directory.path().join("missing path");
        let second = directory.path().join("R 工具");
        std::fs::create_dir_all(&first).unwrap();
        std::fs::create_dir_all(&second).unwrap();
        let executable = if cfg!(windows) {
            "Rscript.exe"
        } else {
            "Rscript"
        };
        let expected = second.join(executable);
        std::fs::write(&expected, b"fixture").unwrap();
        let search_path = std::env::join_paths([first, second]).unwrap();

        assert_eq!(
            find_executable_on_path(executable, &search_path),
            Some(expected)
        );
    }

    #[test]
    fn invalid_persisted_r_selection_fails_without_falling_through() {
        let directory = TempDir::new().unwrap();
        let missing = directory.path().join("missing R/Rscript");
        let error = locate_rscript(Some(&missing)).unwrap_err();
        assert!(
            error
                .to_string()
                .contains("selected Rscript path does not point to a file")
        );
    }

    #[test]
    fn ark_lookup_prefers_installed_macos_sidecar_and_falls_back_to_development() {
        let directory = TempDir::new().unwrap();
        let manifest_dir = directory.path().join("desktop/src-tauri");
        let resource_dir = directory.path().join("Rho.app/Contents/Resources");
        let current_exe = directory.path().join("Rho.app/Contents/MacOS/rho-desktop");
        std::fs::create_dir_all(current_exe.parent().unwrap()).unwrap();
        std::fs::create_dir_all(manifest_dir.join("binaries")).unwrap();
        let candidates = ark_candidate_paths(
            "macos",
            "aarch64",
            &manifest_dir,
            &resource_dir,
            &current_exe,
        );
        let installed = current_exe.parent().unwrap().join("ark");
        let development = manifest_dir.join("binaries/ark-aarch64-apple-darwin");
        assert_eq!(candidates, vec![installed.clone(), development.clone()]);

        std::fs::write(&development, b"development").unwrap();
        assert_eq!(
            locate_ark_from_candidates(candidates.clone()).unwrap(),
            development
        );
        std::fs::write(&installed, b"installed").unwrap();
        assert_eq!(locate_ark_from_candidates(candidates).unwrap(), installed);
    }

    #[test]
    fn ark_lookup_prefers_installed_linux_sidecar_and_falls_back_to_development() {
        let directory = TempDir::new().unwrap();
        let manifest_dir = directory.path().join("desktop/src-tauri");
        let resource_dir = directory.path().join("usr/share/rho");
        let current_exe = directory.path().join("usr/bin/rho-desktop");
        std::fs::create_dir_all(current_exe.parent().unwrap()).unwrap();
        std::fs::create_dir_all(manifest_dir.join("binaries")).unwrap();
        let candidates = ark_candidate_paths(
            "linux",
            "x86_64",
            &manifest_dir,
            &resource_dir,
            &current_exe,
        );
        let bundled = resource_dir.join("resources/runtime/ark");
        let installed = current_exe.parent().unwrap().join("ark");
        let deb_development = manifest_dir.join("../resources/runtime/ark");
        let development = manifest_dir.join("binaries/ark-x86_64-unknown-linux-gnu");
        assert_eq!(
            candidates,
            vec![
                bundled.clone(),
                installed.clone(),
                deb_development.clone(),
                development.clone()
            ]
        );

        std::fs::write(&development, b"development").unwrap();
        assert_eq!(
            locate_ark_from_candidates(candidates.clone()).unwrap(),
            development
        );
        std::fs::write(&installed, b"installed").unwrap();
        assert_eq!(locate_ark_from_candidates(candidates).unwrap(), installed);
    }

    #[test]
    fn ark_lookup_linux_aarch64_prefers_bundled_deb_runtime_then_development() {
        let directory = TempDir::new().unwrap();
        let manifest_dir = directory.path().join("desktop/src-tauri");
        let resource_dir = directory.path().join("usr/share/rho");
        let current_exe = directory.path().join("usr/bin/rho-desktop");
        std::fs::create_dir_all(current_exe.parent().unwrap()).unwrap();
        std::fs::create_dir_all(manifest_dir.join("binaries")).unwrap();
        std::fs::create_dir_all(manifest_dir.join("../resources/runtime")).unwrap();
        std::fs::create_dir_all(resource_dir.join("resources/runtime")).unwrap();
        let candidates = ark_candidate_paths(
            "linux",
            "aarch64",
            &manifest_dir,
            &resource_dir,
            &current_exe,
        );
        let bundled = resource_dir.join("resources/runtime/ark");
        let installed = current_exe.parent().unwrap().join("ark");
        let deb_development = manifest_dir.join("../resources/runtime/ark");
        let development = manifest_dir.join("binaries/ark-aarch64-unknown-linux-gnu");
        assert_eq!(
            candidates,
            vec![
                bundled.clone(),
                installed.clone(),
                deb_development.clone(),
                development.clone()
            ]
        );

        std::fs::write(&development, b"development").unwrap();
        assert_eq!(
            locate_ark_from_candidates(candidates.clone()).unwrap(),
            development
        );
        std::fs::write(&bundled, b"bundled").unwrap();
        assert_eq!(locate_ark_from_candidates(candidates).unwrap(), bundled);
    }

    #[test]
    fn ark_lookup_retains_windows_resources_and_rejects_unknown_targets() {
        let root = Path::new("C:/rho");
        let windows = ark_candidate_paths(
            "windows",
            "x86_64",
            root,
            Path::new("C:/installed"),
            Path::new("C:/installed/rho-desktop.exe"),
        );
        assert_eq!(
            windows,
            vec![
                PathBuf::from("C:/installed/resources/runtime/ark.exe"),
                PathBuf::from("C:/rho/../resources/runtime/ark.exe")
            ]
        );
        assert!(ark_candidate_paths("macos", "x86_64", root, root, root).is_empty());
        assert!(locate_ark_from_candidates(Vec::new()).is_err());
    }

    #[test]
    fn writes_probe_code_to_a_utf8_r_script() {
        let expression = "cat('Rho UTF-8: 中文')\n";
        let script = write_r_probe_script(expression).unwrap();
        assert_eq!(
            script.path().extension().and_then(|value| value.to_str()),
            Some("R")
        );
        assert_eq!(std::fs::read_to_string(script.path()).unwrap(), expression);
    }

    #[test]
    fn parses_base_r_probe_without_requiring_user_startup_files() {
        // The probe parser validates the reported architecture against the
        // current platform, so the fixture must use an arch the host accepts:
        // Apple Silicon accepts aarch64; every other host accepts x86_64.
        let arch = if cfg!(all(target_os = "macos", target_arch = "aarch64")) {
            "aarch64"
        } else {
            "x86_64"
        };
        let probe = parse_r_runtime_probe(&format!(
            "__RHO_HOME__C:/Program Files/R/R-4.4.2\n\
             __RHO_BIN__C:/Program Files/R/R-4.4.2/bin/x64\n\
             __RHO_ARCH__{arch}\n\
             __RHO_PATH_SEP__;\n\
             __RHO_VERSION__R version 4.4.2\n\
             __RHO_VERSION_NUMBER__4.4.2\n\
             __RHO_PROFILE_USER__C:/Users/test/Documents/.Rprofile\n\
             __RHO_ENVIRON_USER__C:/Users/test/Documents/.Renviron\n\
             __RHO_LIBS__C:/Users/test/R/win-library/4.4;C:/Program Files/R/R-4.4.2/library\n"
        ))
        .unwrap();
        assert_eq!(probe.r_home, "C:/Program Files/R/R-4.4.2");
        assert!(probe.r_bin.ends_with("bin/x64"));
        assert_eq!(probe.r_arch, arch);
        assert_eq!(probe.path_sep, ";");
        assert_eq!(probe.r_version, "R version 4.4.2");
        assert!(probe.r_libs.contains("win-library"));
        assert!(probe.r_profile_user.is_none());
        assert!(probe.r_environ_user.is_none());
    }

    #[test]
    fn rejects_x86_and_old_r_probe_results_before_runtime_generation() {
        if cfg!(all(target_os = "macos", target_arch = "aarch64")) {
            let x86 = parse_r_runtime_probe(
                "__RHO_HOME__/Library/Frameworks/R.framework/Resources\n\
                 __RHO_BIN__/Library/Frameworks/R.framework/Resources/bin\n\
                 __RHO_ARCH__x86_64\n\
                 __RHO_PATH_SEP__:\n",
            )
            .unwrap_err();
            assert!(x86.to_string().contains("R_ARCH_MISMATCH"));
        }

        // Same platform-valid arch as the parse test above: the version gate
        // (not the architecture gate) must be what rejects this old R.
        let arch = if cfg!(all(target_os = "macos", target_arch = "aarch64")) {
            "aarch64"
        } else {
            "x86_64"
        };
        let old = parse_r_runtime_probe(&format!(
            "__RHO_HOME__/Library/Frameworks/R.framework/Resources\n\
             __RHO_BIN__/Library/Frameworks/R.framework/Resources/bin\n\
             __RHO_ARCH__{arch}\n\
             __RHO_PATH_SEP__:\n\
             __RHO_VERSION__R version 4.3.3\n\
             __RHO_VERSION_NUMBER__4.3.3\n"
        ))
        .unwrap_err();
        assert!(old.to_string().contains("requires R 4.4"));
    }

    #[test]
    fn retains_only_user_startup_paths_that_are_files() {
        let directory = TempDir::new().unwrap();
        let profile = directory.path().join(".Rprofile");
        std::fs::write(&profile, "options(rho.test = TRUE)").unwrap();
        let environ = directory.path().join(".Renviron");
        let nested_directory = directory.path().join("not-a-file");
        std::fs::create_dir(&nested_directory).unwrap();

        assert_eq!(
            existing_startup_file(profile.to_string_lossy().into_owned()),
            Some(profile)
        );
        assert_eq!(
            existing_startup_file(environ.to_string_lossy().into_owned()),
            None
        );
        assert_eq!(
            existing_startup_file(nested_directory.to_string_lossy().into_owned()),
            None
        );
    }

    #[test]
    fn disables_missing_user_startup_files_without_placeholder_environment_paths() {
        let mut command = Command::new("Rscript");
        let empty_site = configure_user_startup(
            &mut command,
            RUserStartupFiles {
                profile: None,
                environ: None,
            },
        )
        .unwrap();
        let arguments = command
            .get_args()
            .map(|value| value.to_string_lossy().into_owned())
            .collect::<Vec<_>>();
        let environment = command
            .get_envs()
            .map(|(name, _)| name.to_string_lossy().into_owned())
            .collect::<Vec<_>>();

        assert!(empty_site.is_none());
        assert!(arguments.contains(&"--no-init-file".to_string()));
        assert!(arguments.contains(&"--no-environ".to_string()));
        assert!(!environment.contains(&"R_PROFILE_USER".to_string()));
        assert!(!environment.contains(&"R_ENVIRON_USER".to_string()));
    }

    #[test]
    fn binds_each_existing_user_startup_file_independently() {
        let mut profile_only = Command::new("Rscript");
        configure_user_startup(
            &mut profile_only,
            RUserStartupFiles {
                profile: Some(Path::new("C:/Users/test/.Rprofile")),
                environ: None,
            },
        )
        .unwrap();
        let profile_arguments = profile_only
            .get_args()
            .map(|value| value.to_string_lossy().into_owned())
            .collect::<Vec<_>>();
        let profile_environment = profile_only
            .get_envs()
            .map(|(name, _)| name.to_string_lossy().into_owned())
            .collect::<Vec<_>>();
        assert!(!profile_arguments.contains(&"--no-init-file".to_string()));
        assert!(profile_arguments.contains(&"--no-environ".to_string()));
        assert!(profile_environment.contains(&"R_PROFILE_USER".to_string()));
        assert!(!profile_environment.contains(&"R_ENVIRON_USER".to_string()));

        let mut environ_only = Command::new("Rscript");
        let empty_site = configure_user_startup(
            &mut environ_only,
            RUserStartupFiles {
                profile: None,
                environ: Some(Path::new("C:/Users/test/.Renviron")),
            },
        )
        .unwrap();
        let environ_arguments = environ_only
            .get_args()
            .map(|value| value.to_string_lossy().into_owned())
            .collect::<Vec<_>>();
        let environ_environment = environ_only
            .get_envs()
            .map(|(name, _)| name.to_string_lossy().into_owned())
            .collect::<Vec<_>>();
        assert!(empty_site.is_some());
        assert!(environ_arguments.contains(&"--no-init-file".to_string()));
        assert!(!environ_arguments.contains(&"--no-environ".to_string()));
        assert!(!environ_environment.contains(&"R_PROFILE_USER".to_string()));
        assert!(environ_environment.contains(&"R_ENVIRON_USER".to_string()));
    }

    #[test]
    fn classifies_empty_stderr_probe_exit_as_recoverable() {
        let issue = classify_startup_error(
            "R runtime probe failed (exit_code=Some(1), timed_out=false): stdout= stderr=",
        );
        assert_eq!(issue.code, "R_PROBE_EXITED");
        assert!(issue.actions.contains(&"choose_rscript".to_string()));
    }

    #[test]
    fn classifies_macos_architecture_mismatch_with_stable_recovery_code() {
        let issue = classify_startup_error(
            "R_ARCH_MISMATCH: Rho for Apple Silicon requires arm64 R; found `x86_64`",
        );
        assert_eq!(issue.code, "R_ARCH_MISMATCH");
        assert_eq!(issue.phase, "probing_base_r");
        assert!(issue.actions.contains(&"choose_rscript".to_string()));
    }

    #[test]
    fn startup_recovery_copy_uses_the_platform_rscript_name() {
        for detail in [
            "selected Rscript path does not point to a file",
            "Rscript was not found",
            "R runtime probe failed (exit_code=Some(1), timed_out=false): stdout= stderr=",
            "unclassified runtime failure",
        ] {
            let issue = classify_startup_error(detail);
            assert!(issue.message.contains(platform::rscript_display_name()));
            if !cfg!(windows) {
                assert!(!issue.message.contains("Rscript.exe"));
            }
        }
    }

    #[test]
    fn classifies_missing_ark_as_repairable_installation_failure() {
        let issue = classify_startup_error("bundled Ark executable was not found");
        assert_eq!(issue.code, "ARK_RESOURCE_MISSING");
        assert_eq!(issue.phase, "checking_installation");
        assert!(issue.actions.contains(&"retry".to_string()));
    }

    #[test]
    fn classifies_missing_r_as_recoverable_discovery_failure() {
        let issue = classify_startup_error("Rscript was not found");
        assert_eq!(issue.code, "R_NOT_FOUND");
        assert_eq!(issue.phase, "locating_r");
        assert!(issue.actions.contains(&"choose_rscript".to_string()));
    }

    #[test]
    fn bounds_multiline_subprocess_diagnostics() {
        let value = format!("secret-free\r\n{}", "x".repeat(5000));
        let bounded = bounded_diagnostic(&value);
        assert!(!bounded.contains(['\r', '\n']));
        assert_eq!(bounded.chars().count(), 4096);
    }

    #[test]
    fn redacts_common_secret_shapes_from_diagnostics() {
        let bounded = bounded_diagnostic(
            "DEEPSEEK_API_KEY=secret Authorization=token Bearer another-secret safe",
        );
        assert!(!bounded.contains("secret"));
        assert!(!bounded.contains("another-secret"));
        assert!(bounded.contains("<redacted>"));
        assert!(bounded.ends_with("safe"));
    }

    #[test]
    fn startup_error_display_preserves_bounded_redacted_context_chain() {
        let error = anyhow::anyhow!("migration rejected: unsupported schema version 15")
            .context("opening Rho event store")
            .context("starting Workspace R");
        let displayed = display_error_chain(&error);
        assert_eq!(
            displayed,
            "starting Workspace R: opening Rho event store: migration rejected: unsupported schema version 15"
        );

        let secret = anyhow::anyhow!("token=private-value").context("opening Rho event store");
        let displayed = display_error_chain(&secret);
        assert!(!displayed.contains("private-value"));
        assert!(displayed.contains("token=<redacted>"));
    }

    #[test]
    fn safe_delete_project_file_deletes_supported_project_file() {
        let directory = TempDir::new().unwrap();
        let root = directory.path().canonicalize().unwrap();
        let file = root.join("analysis.R");
        std::fs::write(&file, "x <- 1").unwrap();
        safe_delete_project_file(&root, "analysis.R").unwrap();
        assert!(!file.exists());
    }

    #[test]
    fn safe_delete_project_file_rejects_missing_file() {
        let directory = TempDir::new().unwrap();
        let root = directory.path().canonicalize().unwrap();
        let error = safe_delete_project_file(&root, "missing.R").unwrap_err();
        assert!(error.to_string().contains("does not exist"));
    }

    #[test]
    fn safe_delete_project_file_rejects_unsupported_extension() {
        let directory = TempDir::new().unwrap();
        let root = directory.path().canonicalize().unwrap();
        let file = root.join("figure.png");
        std::fs::write(&file, [0_u8, 1, 2]).unwrap();
        let error = safe_delete_project_file(&root, "figure.png").unwrap_err();
        assert!(
            error
                .to_string()
                .contains("Unsupported or binary project file")
        );
    }

    #[test]
    fn safe_delete_project_file_rejects_parent_escape() {
        let directory = TempDir::new().unwrap();
        let root = directory.path().canonicalize().unwrap();
        let error = safe_delete_project_file(&root, "../outside.R").unwrap_err();
        assert!(error.to_string().contains("parent, root or drive prefix"));
    }

    #[test]
    fn safe_delete_project_file_rejects_symlink_escape() {
        let directory = TempDir::new().unwrap();
        let outside_dir = TempDir::new().unwrap();
        let root = directory.path().canonicalize().unwrap();
        let outside = outside_dir.path().join("outside.R");
        std::fs::write(&outside, "outside <- TRUE").unwrap();
        let link = root.join("link-outside.R");
        #[cfg(windows)]
        let symlink_result = std::os::windows::fs::symlink_file(&outside, &link);
        #[cfg(unix)]
        let symlink_result = std::os::unix::fs::symlink(&outside, &link);
        if let Err(error) = symlink_result {
            if error.raw_os_error() == Some(1314) {
                return;
            }
            panic!("Could not create symlink test fixture: {error}");
        }
        let error = safe_delete_project_file(&root, "link-outside.R").unwrap_err();
        assert!(error.to_string().contains("escapes project root"));
        assert!(outside.exists());
    }

    #[test]
    fn safe_delete_project_file_rejects_directories() {
        let directory = TempDir::new().unwrap();
        let root = directory.path().canonicalize().unwrap();
        std::fs::create_dir(root.join("folder.R")).unwrap();
        let error = safe_delete_project_file(&root, "folder.R").unwrap_err();
        assert!(error.to_string().contains("is not a file"));
        assert!(root.join("folder.R").is_dir());
    }

    #[test]
    fn ensure_artifact_export_target_rejects_parent_escape_and_collisions() {
        let directory = TempDir::new().unwrap();
        let root = directory.path().canonicalize().unwrap();
        let existing = root.join("plots").join("qc.png");
        std::fs::create_dir_all(existing.parent().unwrap()).unwrap();
        std::fs::write(&existing, [137_u8, 80, 78, 71, 13, 10, 26, 10]).unwrap();

        let escape = ensure_artifact_export_target(&root, "../outside.png", &["png"]).unwrap_err();
        assert!(escape.to_string().contains("parent, root or drive prefix"));

        let collision = ensure_artifact_export_target(&root, "plots/qc.png", &["png"]).unwrap_err();
        assert!(collision.to_string().contains("already exists"));
    }

    #[test]
    fn data_view_delimited_text_writes_exact_utf8_csv_with_crlf_and_quotes() {
        let page = json!({
            "columns": [
                { "name": "sample", "label": "sample" },
                { "name": "note", "label": "note" }
            ],
            "rows": [
                { "row_name": "row,1", "cells": ["plain", "line\r\nbreak"] },
                { "row_name": "第二行", "cells": [null, "He said \"hi\""] }
            ]
        });
        let output = data_view_delimited_text(&page, ',').unwrap();
        let expected = concat!(
            "row_name,sample,note\r\n",
            "\"row,1\",plain,\"line\r\nbreak\"\r\n",
            "第二行,,\"He said \"\"hi\"\"\"\r\n"
        );
        assert_eq!(output, expected);
        assert_eq!(output.as_bytes()[output.len() - 2..], [b'\r', b'\n']);
    }

    #[test]
    fn data_view_delimited_text_writes_exact_utf8_tsv_with_missing_values() {
        let page = json!({
            "columns": [
                { "name": "detected", "label": "detected" },
                { "name": "group", "label": "group\tlabel" }
            ],
            "rows": [
                { "row_name": "cell_1", "cells": ["A", "组1"] },
                { "row_name": "cell_2", "cells": [null, ""] }
            ]
        });
        let output = data_view_delimited_text(&page, '\t').unwrap();
        let expected = concat!(
            "row_name\tdetected\t\"group\tlabel\"\r\n",
            "cell_1\tA\t组1\r\n",
            "cell_2\t\t\r\n"
        );
        assert_eq!(output, expected);
        assert!(String::from_utf8(output.into_bytes()).is_ok());
    }

    #[test]
    fn data_view_delimited_text_preserves_empty_missing_and_non_finite_values() {
        let page = json!({
            "columns": [
                { "name": "empty" },
                { "name": "missing" },
                { "name": "nan" },
                { "name": "positive" },
                { "name": "negative" }
            ],
            "rows": [{
                "row_name": "sample_1",
                "cells": ["", null, "NaN", "Inf", "-Inf"],
                "cell_states": ["empty", "na", "nan", "pos_inf", "neg_inf"]
            }]
        });

        let output = data_view_delimited_text(&page, ',').unwrap();

        assert_eq!(
            output,
            "row_name,empty,missing,nan,positive,negative\r\nsample_1,,,NaN,Inf,-Inf\r\n"
        );
    }

    #[test]
    fn data_view_artifact_metadata_replays_normalized_query_sort_and_window() {
        let page = json!({
            "row_offset": 25,
            "rows": [{"row_name": "cell_35", "cells": ["S35"]}],
            "column_offset": 1,
            "columns": [{"index": 1, "name": "reads", "label": "reads"}],
            "query": "S",
            "sort_column": 1,
            "sort_direction": "desc"
        });

        let metadata = data_view_artifact_metadata(&page, "qc", "table", "table", "csv");

        assert_eq!(metadata["object_name"], "qc");
        assert_eq!(metadata["row_offset"], 25);
        assert_eq!(metadata["row_count"], 1);
        assert_eq!(metadata["column_offset"], 1);
        assert_eq!(metadata["column_count"], 1);
        assert_eq!(metadata["query"], "S");
        assert_eq!(metadata["sort_column"], 1);
        assert_eq!(metadata["sort_direction"], "desc");
        assert_eq!(metadata["format"], "csv");
    }

    #[test]
    fn validates_png_signature() {
        assert!(has_png_signature(&[137, 80, 78, 71, 13, 10, 26, 10, 0, 1]));
        assert!(!has_png_signature(b"not-a-png"));
    }

    #[test]
    fn decodes_padded_and_unpadded_plot_png_payloads() {
        assert_eq!(
            decode_plot_png_base64("iVBORw0KGgo=").unwrap(),
            b"\x89PNG\r\n\x1a\n"
        );
        assert_eq!(
            decode_plot_png_base64("iVBORw0KGgo").unwrap(),
            b"\x89PNG\r\n\x1a\n"
        );
        assert!(decode_plot_png_base64("A").is_err());
        assert!(decode_plot_png_base64("not=base64").is_err());
    }

    fn render_job_fixture(job_id: &str, project_root: &str, status: &str) -> RenderJobState {
        RenderJobState {
            job_id: job_id.to_string(),
            project_root: project_root.to_string(),
            path: "report.Rmd".to_string(),
            document_version: Some(3),
            status: status.to_string(),
            artifact_id: None,
            output_path: None,
            tool: None,
            media_type: None,
            provenance_complete: None,
            message: None,
            terminal_reason: None,
            submitted_at: "2026-08-03T00:00:00Z".to_string(),
            completed_at: None,
        }
    }

    #[test]
    fn render_job_terminal_transitions_are_monotonic() {
        let mut job = render_job_fixture("render_1", "D:/project", "running");
        finish_render_job(&mut job, "completed", None, Some("completed"));
        assert!(render_job_is_terminal(&job.status));
        finish_render_job(
            &mut job,
            "interrupted",
            Some("late cancellation".to_string()),
            Some("user_interrupt"),
        );
        assert_eq!(job.status, "completed");
        assert_eq!(job.terminal_reason.as_deref(), Some("completed"));
        assert!(job.message.is_none());
    }

    #[test]
    fn render_job_restart_reconciliation_distinguishes_run_truth() {
        let mut before_start = render_job_fixture("render_1", "D:/project", "cancel_requested");
        reconcile_render_job(&mut before_start, None, None, None);
        assert_eq!(before_start.status, "interrupted");
        assert_eq!(
            before_start.terminal_reason.as_deref(),
            Some("workspace_restart_before_start")
        );

        let mut completed = render_job_fixture("render_2", "D:/project", "cancel_requested");
        reconcile_render_job(&mut completed, Some("completed"), None, Some("completed"));
        assert_eq!(completed.status, "completed");

        let mut failed = render_job_fixture("render_3", "D:/project", "cancel_requested");
        reconcile_render_job(
            &mut failed,
            Some("failed"),
            Some("render error".to_string()),
            Some("r_error"),
        );
        assert_eq!(failed.status, "failed");
        assert_eq!(failed.message.as_deref(), Some("render error"));

        let mut interrupted = render_job_fixture("render_4", "D:/project", "cancel_requested");
        reconcile_render_job(
            &mut interrupted,
            Some("interrupted"),
            None,
            Some("cancelled_during_restart"),
        );
        assert_eq!(interrupted.status, "interrupted");
        assert_eq!(
            interrupted.terminal_reason.as_deref(),
            Some("cancelled_during_restart")
        );
    }

    #[test]
    fn render_job_serialization_keeps_project_and_document_identity() {
        let job = render_job_fixture("render_1", "D:/project-a", "submitted");
        let value = serde_json::to_value(job).unwrap();
        assert_eq!(value["job_id"], "render_1");
        assert_eq!(value["project_root"], "D:/project-a");
        assert_eq!(value["path"], "report.Rmd");
        assert_eq!(value["document_version"], 3);
        assert_eq!(value["status"], "submitted");
        assert!(value["artifact_id"].is_null());
    }

    #[test]
    fn render_job_attaches_only_the_exact_artifact_projection() {
        let mut job = render_job_fixture("render_1", "D:/project-a", "running");
        let artifact = ArtifactRecordSummary {
            artifact_id: "artifact_render_1_render".to_string(),
            artifact_kind: "render_output".to_string(),
            run_id: Some("render_1".to_string()),
            project_root: "D:/project-a".to_string(),
            output_path: "report.html".to_string(),
            source_path: Some("report.Rmd".to_string()),
            execution_mode: Some("render".to_string()),
            document_version: Some(3),
            workspace_id: Some("ws-1".to_string()),
            state_revision: Some(2),
            project_revision: Some(4),
            media_type: "text/html".to_string(),
            metadata_json: "{}".to_string(),
            provenance_complete: true,
            incomplete_reason: None,
            created_at: "2026-08-03T00:00:00Z".to_string(),
        };

        attach_render_artifact(&mut job, &artifact);

        assert_eq!(job.artifact_id.as_deref(), Some("artifact_render_1_render"));
        assert_eq!(job.output_path.as_deref(), Some("report.html"));
        assert_eq!(job.media_type.as_deref(), Some("text/html"));
        assert_eq!(job.provenance_complete, Some(true));
    }

    #[test]
    #[ignore = "writes the requested generated TypeScript contract"]
    fn project_typescript_export() {
        let output_path = std::env::var_os("RHO_PROJECT_BINDINGS_PATH")
            .expect("RHO_PROJECT_BINDINGS_PATH must name the generated file");
        tauri_specta::Builder::<tauri::Wry>::new()
            .commands(tauri_specta::collect_commands![
                crate::commands::project_session::project_open,
                crate::commands::project_session::project_pick_directory,
                crate::commands::project_session::project_restore_session,
            ])
            .error_handling(tauri_specta::ErrorHandlingMode::Throw)
            .export(specta_typescript::Typescript::default(), output_path)
            .expect("Project TypeScript export must succeed");
    }

    #[test]
    #[ignore = "writes the requested generated TypeScript contract"]
    fn startup_typescript_export() {
        let output_path = std::env::var_os("RHO_STARTUP_BINDINGS_PATH")
            .expect("RHO_STARTUP_BINDINGS_PATH must name the generated file");
        tauri_specta::Builder::<tauri::Wry>::new()
            .commands(tauri_specta::collect_commands![
                crate::commands::startup::startup_bootstrap,
                crate::commands::startup::startup_choose_rscript,
                crate::commands::startup::workspace_start,
                crate::commands::startup::startup_diagnostics,
            ])
            .error_handling(tauri_specta::ErrorHandlingMode::Throw)
            .export(specta_typescript::Typescript::default(), output_path)
            .expect("Startup TypeScript export must succeed");
    }

    #[test]
    #[ignore = "writes the requested generated TypeScript contract"]
    fn history_typescript_export() {
        let output_path = std::env::var_os("RHO_HISTORY_BINDINGS_PATH")
            .expect("RHO_HISTORY_BINDINGS_PATH must name the generated file");
        tauri_specta::Builder::<tauri::Wry>::new()
            .commands(tauri_specta::collect_commands![
                crate::commands::runs::list_runs,
                crate::commands::artifacts::list_artifact_records,
                crate::commands::runs::list_problems,
                crate::commands::artifacts::list_plot_artifacts,
                crate::commands::artifacts::read_plot_artifact,
                crate::commands::runs::retry_run,
            ])
            .error_handling(tauri_specta::ErrorHandlingMode::Throw)
            .export(specta_typescript::Typescript::default(), output_path)
            .expect("History TypeScript export must succeed");
    }

    #[test]
    #[ignore = "writes the requested generated TypeScript contract"]
    fn environment_typescript_export() {
        let output_path = std::env::var_os("RHO_ENVIRONMENT_BINDINGS_PATH")
            .expect("RHO_ENVIRONMENT_BINDINGS_PATH must name the generated file");
        tauri_specta::Builder::<tauri::Wry>::new()
            .commands(tauri_specta::collect_commands![
                crate::commands::environment::list_installed_packages,
                crate::commands::environment::list_environment_operation_requests,
            ])
            .error_handling(tauri_specta::ErrorHandlingMode::Throw)
            .export(specta_typescript::Typescript::default(), output_path)
            .expect("Environment TypeScript export must succeed");
    }

    #[test]
    #[ignore = "writes the requested generated TypeScript contract"]
    fn evidence_typescript_export() {
        let output_path = std::env::var_os("RHO_EVIDENCE_BINDINGS_PATH")
            .expect("RHO_EVIDENCE_BINDINGS_PATH must name the generated file");
        tauri_specta::Builder::<tauri::Wry>::new()
            .commands(tauri_specta::collect_commands![
                crate::commands::evidence::list_evidence_claims,
            ])
            .error_handling(tauri_specta::ErrorHandlingMode::Throw)
            .export(specta_typescript::Typescript::default(), output_path)
            .expect("Evidence TypeScript export must succeed");
    }

    #[test]
    #[ignore = "writes the requested generated TypeScript contract"]
    fn git_typescript_export() {
        let output_path = std::env::var_os("RHO_GIT_BINDINGS_PATH")
            .expect("RHO_GIT_BINDINGS_PATH must name the generated file");
        tauri_specta::Builder::<tauri::Wry>::new()
            .commands(tauri_specta::collect_commands![
                crate::git_commands::git_status,
                crate::git_commands::git_log,
            ])
            .error_handling(tauri_specta::ErrorHandlingMode::Throw)
            .export(specta_typescript::Typescript::default(), output_path)
            .expect("Git TypeScript export must succeed");
    }

    #[test]
    fn startup_log_tail_is_unicode_safe_and_exactly_bounded() {
        let content = format!("discarded{}kept", "界".repeat(65_536));
        let tail = crate::commands::startup::startup_log_tail(&content);
        assert_eq!(tail.chars().count(), 65_536);
        assert!(tail.ends_with("kept"));
        assert!(!tail.contains("discarded"));
    }
}

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
