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
            assert_eq!(surfaces.factories().len(), 23);
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
                    "rho.settings",
                    "rho.environment",
                    "rho.navigator",
                    "rho.claims",
                    "rho.evidence-graph",
                    "rho.evidence-gaps",
                    "rho.claim-trace",
                    "rho.git",
                    "rho.runs",
                    "rho.jobs",
                    "rho.artifacts",
                    "rho.approvals",
                    "rho.revisions",
                    "rho.problems",
                    "rho.plots",
                    "rho.logs",
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
            let settings = surfaces
                .factories()
                .iter()
                .find(|factory| factory.definition.surface_id.as_str() == "rho.settings")
                .unwrap();
            assert_eq!(
                settings.definition.scope,
                rho_ui_contract::SurfaceScopeV1::Application
            );
            assert_eq!(
                settings.definition.instance_policy,
                rho_ui_contract::SurfaceInstancePolicyV1::Singleton
            );
            assert_eq!(
                settings.definition.origin,
                rho_ui_contract::SurfaceOriginV1::Application {
                    component_id: rho_ui_contract::ApplicationComponentId::new("rho.settings")
                        .unwrap(),
                }
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
            let graph_project_a = crate::evidence_graph_runtime::project_id_for_root(&project_a)
                .unwrap();
            assert!(
                candidate
                    .evidence_graph
                    .health(&project_a, &graph_project_a)
                    .unwrap()
                    .available
            );
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
            assert!(matches!(
                candidate.evidence_graph.health(&project_a, &graph_project_a),
                Err(rho_evidence_graph::GraphError::ProjectMismatch)
            ));
            let graph_project_b = crate::evidence_graph_runtime::project_id_for_root(&project_b)
                .unwrap();
            assert!(
                candidate
                    .evidence_graph
                    .health(&project_b, &graph_project_b)
                    .unwrap()
                    .available
            );
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
    fn corrupt_evidence_sidecar_does_not_downgrade_a_committed_project_switch() {
        let runtime = tokio::runtime::Runtime::new().unwrap();
        runtime.block_on(async {
            let tempdir = TempDir::new().unwrap();
            let previous = tempdir.path().join("previous-project");
            let target = tempdir.path().join("target-project");
            std::fs::create_dir_all(&previous).unwrap();
            std::fs::create_dir_all(target.join(".rho")).unwrap();
            std::fs::write(target.join(".rho/evidence.lbdb"), b"corrupt sidecar").unwrap();
            let store_path = tempdir.path().join("rho.sqlite");
            Store::open(&store_path).unwrap();
            let state = test_app_state(tempdir.path(), &previous, &store_path);
            state
                .switch_test_control
                .succeed_without_running(SwitchTestStep::SyncWorkspace);

            let response = switch_project_with_watcher_factory(
                target.clone(),
                None,
                &state,
                |_| Ok(ProjectWatcherControl::noop()),
            )
            .await
            .unwrap();

            assert_eq!(response.status, "ready");
            assert_eq!(*state.project_root.read().await, target);
            let project_id = crate::evidence_graph_runtime::project_id_for_root(&target).unwrap();
            let health = state.evidence_graph.health(&target, &project_id).unwrap();
            assert!(!health.available);
            assert_eq!(
                health.error_code.as_deref(),
                Some("GRAPH_ENGINE_UNAVAILABLE")
            );
        });
    }

    #[test]
    fn committed_store_receipts_reconcile_into_the_exact_project_graph() {
        let runtime = tokio::runtime::Runtime::new().unwrap();
        runtime.block_on(async {
            let tempdir = TempDir::new().unwrap();
            let project = tempdir.path().join("receipt-project");
            std::fs::create_dir_all(&project).unwrap();
            let normalized = normalize_project_root(project.to_string_lossy().as_ref());
            let store_path = tempdir.path().join("rho.sqlite");
            let mut store = Store::open(&store_path).unwrap();
            create_run_fixture(&mut store, &normalized, "run:receipt", "x <- 1");
            drop(store);
            let state = test_app_state(tempdir.path(), &project, &store_path);
            state
                .switch_test_control
                .succeed_without_running(SwitchTestStep::SyncWorkspace);

            let response = switch_project_with_watcher_factory(
                project.clone(),
                None,
                &state,
                |_| Ok(ProjectWatcherControl::noop()),
            )
            .await
            .unwrap();
            assert_eq!(response.status, "ready");

            let project_id = crate::evidence_graph_runtime::project_id_for_root(&project).unwrap();
            let reference = rho_protocol::AuthorityRefV1::new(
                project_id.clone(),
                rho_protocol::AuthorityKindV1::Run,
                "run:receipt",
            )
            .unwrap();
            let node = state
                .evidence_graph
                .with_graph(&project, &project_id, |graph| {
                    graph.get_authority_node(&reference)
                })
                .unwrap();
            assert_eq!(node.kind, rho_evidence_graph::NodeKind::Run);
            assert_eq!(
                node.payload["cached_observation"]["status"],
                "succeeded"
            );
            let view = state
                .evidence_graph
                .with_graph(&project, &project_id, |graph| {
                    let node = graph.get_authority_node(&reference)?;
                    Ok(crate::evidence_graph_runtime::project_node(graph, node)
                        .expect("graph node must project"))
                })
                .unwrap();
            assert_eq!(
                view.authority_ref.as_ref().map(|value| value.authority_id.as_str()),
                Some("run:receipt")
            );
            let encoded = serde_json::to_value(&view).unwrap();
            assert!(encoded.get("authority_status").is_none());
            assert!(encoded.get("authority_observed_at").is_none());

            let context = crate::evidence_graph_runtime::active_graph_context(&state)
                .await
                .unwrap();
            let observations = crate::evidence_graph_runtime::resolve_authority_observations(
                &state,
                &context,
                &[reference],
            )
            .await
            .unwrap();
            assert_eq!(observations.len(), 1);
            assert_eq!(
                observations[0].status,
                rho_protocol::AuthorityStatusV1::Succeeded
            );
            assert!(
                state
                    .evidence_graph
                    .health(&project, &project_id)
                    .unwrap()
                    .graph
                    .unwrap()
                    .authority_cursor
                    > 0
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
