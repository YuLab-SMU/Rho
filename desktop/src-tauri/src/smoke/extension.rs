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
