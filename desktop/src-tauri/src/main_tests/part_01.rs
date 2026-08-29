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
            stderr: if success {
                String::new()
            } else {
                "probe failed without package output".to_string()
            },
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
            target_admission: RwLock::new(None),
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
            workbench_projection:
                crate::workbench_projection::WorkbenchProjectionState::default(),
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
    async fn workbench_projection_capture_keeps_rapid_project_switches_coherent() {
        let tempdir = tempfile::tempdir().unwrap();
        let project_a = tempdir.path().join("project-a");
        let project_b = tempdir.path().join("project-b");
        std::fs::create_dir_all(&project_a).unwrap();
        std::fs::create_dir_all(&project_b).unwrap();
        let store_path = tempdir.path().join("rho.sqlite");
        let extension_host = test_candidate_extension_host_with_application_plugins().await;
        let state = test_app_state_with_extension_host(
            tempdir.path(),
            &project_a,
            &store_path,
            extension_host,
        );
        let lane = Arc::new(WorkspaceBrokerLane::new(
            BrokerState::new("workspace.projection"),
            StoreExecutor::open(&store_path).await.unwrap(),
        ));
        {
            let mut workspace = lane.lock().await;
            workspace.broker.project_changed();
        }
        *state.context.lock().await = Some(Arc::clone(&lane));

        let first = {
            let _transition = state.project_transition_gate.lock().await;
            crate::workbench_projection::capture_for_state(&state)
                .await
                .unwrap()
        };
        assert_eq!(first.projection_generation, 1);
        assert_eq!(first.revisions.project_revision, 1);

        {
            let _transition = state.project_transition_gate.lock().await;
            *state.project_root.write().await = project_b;
            let mut workspace = lane.lock().await;
            workspace.broker.project_changed();
        }
        let second = {
            let _transition = state.project_transition_gate.lock().await;
            crate::workbench_projection::capture_for_state(&state)
                .await
                .unwrap()
        };
        assert_ne!(first.project_id, second.project_id);
        assert_eq!(second.projection_generation, 2);
        assert_eq!(second.revisions.project_revision, 2);
        assert_eq!(second.project_id, second.kernel.project.project_id);
        assert_eq!(second.project_id, second.surfaces.project_id);
        assert_eq!(second.project_id, second.studio.project_id);
        assert_eq!(second.project_id, second.runtimes.project_id);
        assert_eq!(second.project_id, second.resources.project_id);
        assert_eq!(second.project_id, second.profile.profile.project_id);
    }
