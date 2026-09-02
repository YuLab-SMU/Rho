    use super::{
        AgentTaskEntry, AppState, ExecuteRequest,
        ExecuteSourceRange,
        RUNTIME_CACHE_VERSION, RUserStartupFiles,
        RenderJobState, RuntimeCacheFile, RuntimeConfig, StartupView, SwitchTestControl,
        SwitchTestStep, active_context, agent_retry_source,
        agent_turn_admission_error,
        ark_candidate_paths,
        attach_render_artifact, bounded_diagnostic, cancel_agent_turn_state,
        classify_startup_error, configure_user_startup, deferred_agent_runtime_status,
        display_error_chain, durable_project_root,
        ensure_supported_r_architecture, ensure_supported_r_version, existing_startup_file,
        find_executable_on_path, finish_render_job, interrupt_all_agent_tasks, load_runtime_cache,
        locate_ark_from_candidates, locate_rscript, parse_r_runtime_probe,
        persist_workspace_identity,
        environment_operation_switch_blocker, project_switch_blocker, r_architecture_supported, reconcile_render_job,
        render_job_is_terminal,
        runtime_file_signature, save_runtime_cache, shutdown_application, store_executor,
        switch_project_with_watcher_factory, text_sha256,
        validate_execute_source_range_shape,
        workspace_project_root_code, write_r_probe_script,
    };
    use crate::commands::agent_conversation::delete_agent_conversation_state;
    use crate::commands::artifacts::{
        data_view_artifact_metadata, data_view_delimited_text, decode_plot_png_base64,
        ensure_artifact_export_target, has_png_signature,
    };
    use crate::commands::editor::editor_format_result;
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
        ApprovalRequestDraft, ArtifactRecordSummary,
        PlotArtifactDraft, RunDraft, RunFinish, Store, StoreExecutor,
        normalize_project_root,
    };
    use serde_json::json;
    use sha2::Digest as _;
    use std::collections::HashMap;
    use std::future::Future;
    use std::path::{Path, PathBuf};
    use std::pin::Pin;
    use std::process::Command;
    use std::sync::atomic::AtomicBool;
    use std::sync::{Arc, Mutex as StdMutex};
    use std::time::Duration;
    use tempfile::TempDir;
    use tokio::sync::{Mutex, RwLock, Semaphore};

    fn desktop_environment_plan_fixture(
        project_root: &str,
        target_library: &str,
        project_revision: u64,
    ) -> rho_protocol::MaterializedPackagePlanV1 {
        use rho_protocol::*;

        let digest = |value: char| {
            AuthorityDigest::new(format!("sha256:{}", value.to_string().repeat(64))).unwrap()
        };
        let environment_id = EnvironmentId::new("environment_test_local").unwrap();
        MaterializedPackagePlanV1::new(MaterializedPackagePlanBodyV1 {
            contract_version: ENVIRONMENT_CONTRACT_VERSION,
            environment: EnvironmentIdentityV1 {
                environment_id: environment_id.clone(),
                role: EnvironmentRoleV1::NativeUser,
                project_id: Some(ProjectId::new("project_test_local").unwrap()),
                target_id: "local".to_string(),
                execution_profile_id: ExecutionProfileId::new("execution_profile_test_local")
                    .unwrap(),
            },
            expected_before: ExpectedEnvironmentStateV1 {
                environment_id,
                desired_revision: EnvironmentDesiredRevisionId::new("env_desired_test_before")
                    .unwrap(),
                realization_revision: EnvironmentRealizationRevisionId::new(
                    "env_realized_test_before",
                )
                .unwrap(),
                project_revision: Some(project_revision),
                repository_profile_digest: digest('a'),
            },
            intent: PackageIntentV1::InstallUserPackage,
            runtime: RuntimeRealizationV1 {
                runtime_id: RuntimeRealizationId::new("runtime_realization_test_local").unwrap(),
                requirement: RuntimeRequirementV1 {
                    distribution: RuntimeDistributionV1::R,
                    exact_version: "4.5.2".to_string(),
                    platform: std::env::consts::OS.to_string(),
                    architecture: std::env::consts::ARCH.to_string(),
                },
                ownership: RuntimeOwnershipV1::System,
                support_tier: RuntimeSupportTierV1::Verified,
                executable: "/usr/local/bin/Rscript".to_string(),
                runtime_home: "/usr/local/lib/R".to_string(),
                executable_digest: digest('b'),
                build_fingerprint: digest('c'),
                compiler_fingerprint: None,
            },
            library_stack: LibraryStackV1::new(vec![LibraryLayerV1 {
                layer_id: LibraryLayerId::new("library_user_test_local").unwrap(),
                kind: LibraryLayerKindV1::User,
                owner: LibraryOwnerV1::User,
                mutability: LibraryMutabilityV1::UserWritable,
                canonical_path: target_library.to_string(),
                priority: 1,
                filesystem_identity: format!("test:{project_root}:user-library"),
            }])
            .unwrap(),
            repository_profile: RepositoryProfileV1 {
                profile_id: RepositoryProfileId::new("repository_profile_test_local").unwrap(),
                repositories: vec![RepositoryEndpointV1 {
                    name: "fixture".to_string(),
                    url: "file:///fixtures/mini-cran".to_string(),
                    priority: 1,
                }],
                bioconductor_version: None,
                snapshot: None,
                binary_preference: "source".to_string(),
                source_fallback_policy: "deny".to_string(),
                offline_policy: "offline".to_string(),
                proxy_profile_ref: None,
                trust_bundle_ref: None,
                credential_refs: Vec::new(),
                allowed_origins: vec!["file://".to_string()],
            },
            package_actions: vec![PackageActionV1 {
                package: "rhofixture".to_string(),
                kind: PackageActionKindV1::Install,
                from_version: None,
                to_version: Some("1.0.0".to_string()),
                source: "file:///fixtures/mini-cran/rhofixture_1.0.0.tar.gz".to_string(),
                repository: Some("fixture".to_string()),
                form: PackageFormV1::Source,
                artifact_digest: digest('e'),
                artifact_byte_size: 42,
            }],
            native_requirement_actions: Vec::new(),
            toolchain_actions: Vec::new(),
            lockfile_action: None,
            artifact_digests: vec![digest('e')],
            network_intents: Vec::new(),
            secret_requirements: Vec::new(),
            verification_probes: vec![EnvironmentVerificationProbeV1 {
                probe_id: "probe_namespace_rhofixture".to_string(),
                kind: "namespace_load".to_string(),
                expected: "rhofixture@1.0.0".to_string(),
            }],
            restart_required: true,
            expires_at: "2099-01-01T00:00:00Z".to_string(),
        })
        .unwrap()
    }

    struct DesktopEnvironmentExecutionFixture;

    impl rho_control_plane::EnvironmentExecutionPort for DesktopEnvironmentExecutionFixture {
        fn execute<C: rho_store::StoreConnection>(
            &mut self,
            _plan: &rho_protocol::MaterializedPackagePlanV1,
            _store: &mut rho_store::Store<C>,
            _project_root: &str,
            _operation_id: &str,
        ) -> Result<rho_control_plane::EnvironmentExecutionOutcome, String> {
            Ok(rho_control_plane::EnvironmentExecutionOutcome::Succeeded {
                execution_id: rho_protocol::ExecutionId::new(
                    "execution_desktop_environment_fixture",
                )
                .unwrap(),
            })
        }

        fn reconcile<C: rho_store::StoreConnection>(
            &mut self,
            _plan: &rho_protocol::MaterializedPackagePlanV1,
            _store: &mut rho_store::Store<C>,
            _project_root: &str,
            _operation_id: &str,
        ) -> Result<Option<rho_control_plane::EnvironmentExecutionOutcome>, String> {
            Ok(None)
        }
    }

    struct DesktopEnvironmentVerifierFixture {
        project_root: String,
        operation_id: rho_protocol::OperationId,
    }

    impl rho_control_plane::EnvironmentCommitVerifier for DesktopEnvironmentVerifierFixture {
        fn verify(
            &mut self,
            plan: &rho_protocol::MaterializedPackagePlanV1,
            execution_id: &rho_protocol::ExecutionId,
        ) -> Result<rho_store::EnvironmentStateCommit, String> {
            let digest = |value: char| {
                rho_protocol::AuthorityDigest::new(format!(
                    "sha256:{}",
                    value.to_string().repeat(64)
                ))
                .unwrap()
            };
            let desired = rho_protocol::EnvironmentDesiredRevisionV1 {
                revision_id: rho_protocol::EnvironmentDesiredRevisionId::new(
                    "env_desired_desktop_after",
                )
                .unwrap(),
                core_manifest_digest: None,
                renv_lock_digest: None,
                repository_profile_digest: plan
                    .body
                    .expected_before
                    .repository_profile_digest
                    .clone(),
                execution_profile_digest: digest('6'),
                ownership_policy_digest: digest('7'),
            };
            let realization = rho_protocol::EnvironmentRealizationRevisionV1 {
                revision_id: rho_protocol::EnvironmentRealizationRevisionId::new(
                    "env_realized_desktop_after",
                )
                .unwrap(),
                runtime_id: plan.body.runtime.runtime_id.clone(),
                library_stack_digest: plan.body.library_stack.effective_digest.clone(),
                package_inventory_digest: digest('8'),
                native_fingerprint: digest('9'),
                target_realization_digest: digest('0'),
            };
            let receipt = rho_protocol::EnvironmentOperationReceiptV1 {
                receipt_id: rho_protocol::EnvironmentReceiptId::new(
                    "environment_receipt_desktop",
                )
                .unwrap(),
                operation_id: self.operation_id.clone(),
                plan_id: plan.plan_id.clone(),
                actor_id: "desktop_user".to_string(),
                approval_effect_digest: digest('1'),
                desired_before: plan.body.expected_before.desired_revision.clone(),
                desired_after: Some(desired.revision_id.clone()),
                realization_before: plan.body.expected_before.realization_revision.clone(),
                realization_after: Some(realization.revision_id.clone()),
                checkpoints: vec![rho_protocol::EnvironmentCheckpointV1 {
                    name: "namespace_verified".to_string(),
                    reached_at: "2026-09-01T12:00:00Z".to_string(),
                    digest: Some(digest('2')),
                }],
                execution_refs: vec![execution_id.clone()],
                verification_refs: vec!["namespace:rhofixture@1.0.0".to_string()],
                outcome: rho_protocol::EnvironmentOperationOutcomeV1::Succeeded,
                partial_effects_possible: false,
                restart_required: true,
                recorded_at: "2026-09-01T12:00:01Z".to_string(),
            };
            let receipt_digest = rho_protocol::AuthorityDigest::new(format!(
                "sha256:{:x}",
                sha2::Sha256::digest(serde_json::to_vec(&receipt).unwrap())
            ))
            .unwrap();
            Ok(rho_store::EnvironmentStateCommit {
                project_root: self.project_root.clone(),
                environment: plan.body.environment.clone(),
                desired: desired.clone(),
                realization: realization.clone(),
                receipt,
                binding: rho_protocol::WorkspaceEnvironmentBindingV1 {
                    environment_id: plan.body.environment.environment_id.clone(),
                    desired_revision: desired.revision_id,
                    realization_revision: realization.revision_id,
                    receipt_digest,
                },
            })
        }
    }

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
        assert!(!run_is_retryable(
            "environment.request_apply_plan",
            "user"
        ));
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
            r_libs: "C:/Users/test/R/library;C:/R/library".to_string(),
            path_sep: ";".to_string(),
            process_path: std::env::var_os("PATH").unwrap_or_default(),
            r_profile_user: None,
            r_environ_user: None,
            bridge_package: data_dir.join("rho.bridge"),
            agent_runtime: deferred_agent_runtime_status(),
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
            evidence_graph: rho_evidence_graph::ProjectGraphManager::default(),
            approvals: Arc::new(PendingApprovalRegistry::default()),
            workspace_environment: Mutex::new(
                crate::application_state::WorkspaceEnvironmentRuntime::default(),
            ),
            project_transition_gate: Arc::new(Mutex::new(())),
            extension_host,
            plugin_permissions: crate::workspace_plugins::PendingPluginPermissionRegistry::new(),
            agent_tasks: Arc::new(Mutex::new(HashMap::new())),
            agent_workspace_lane: Arc::new(AgentWorkspaceLane::default()),
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
