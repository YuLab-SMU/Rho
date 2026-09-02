pub(crate) async fn smoke_test(include_agent: bool) -> Result<Value> {
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
        let discovered = rho_acp_client::discover_external_acp_agent(&config.process_path)
            .context("desktop smoke requested an external ACP Agent, but none was installed")?;
        Some(json!({
            "ready": true,
            "provider": discovered.display_name,
            "protocol": discovered.protocol,
            "executable": discovered.executable,
        }))
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
