pub async fn bootstrap_bridge(
    session: &ArkSession,
    broker: &mut BrokerState,
    executor: &StoreExecutor,
    bridge_package: &Path,
) -> Result<()> {
    let bridge_path = r_string(&normalized_path(bridge_package))?;
    let code = format!(
        r#"local({{
  bridge_env <- new.env(parent = asNamespace("utils"))
  for (name in c("state.R", "execute.R", "workspace.R", "completion.R", "lintr.R", "targets.R", "formatting.R")) {{
    sys.source(file.path({bridge_path}, "R", name), envir = bridge_env)
  }}
  options(rho.bridge.env = bridge_env)
  invisible(TRUE)
}})"#
    );
    let request = ExecutionRequest::new(
        ExecutionOrigin::System,
        OperationClass::StateCapable,
        ExpectedWorkspace::default(),
        code.clone(),
    );
    let before = broker.identity().clone();
    let project_root = run_workspace_store_service(executor, |store| {
        store
            .active_project_root()?
            .context("Cannot persist bootstrap run without an active project identity")
    })
    .await?;
    let run_draft = RunDraft {
        run_id: request.execution_id.clone(),
        parent_run_id: None,
        project_root: project_root.clone(),
        origin: execution_origin_name(request.origin).to_string(),
        request_type: "workspace.bootstrap".to_string(),
        operation_class: operation_class_name(request.operation_class).to_string(),
        code: code.clone(),
        arguments_json: "{}".to_string(),
        source_path: None,
        execution_mode: Some("bootstrap".to_string()),
        document_version: None,
        workspace_id: before.workspace_id.clone(),
        state_revision_before: before.state_revision as i64,
        project_revision_before: before.project_revision as i64,
        environment_snapshot_id: None,
    };
    let run_id = request.execution_id.clone();
    run_workspace_store_service(executor, move |store| {
        store.create_run(&run_draft)?;
        store.update_run_status(&run_id, "running", None)?;
        Ok(())
    })
    .await?;
    let event_executor = executor.clone();
    let event_execution_id = request.execution_id.clone();
    let result = session
        .execute_async(code, move |event| {
            let executor = event_executor.clone();
            let execution_id = event_execution_id.clone();
            async move {
                run_workspace_store_service(&executor, move |store| {
                    append_event(
                        store,
                        MessageKind::Event,
                        json!({
                            "type": "kernel.event",
                            "execution_id": execution_id,
                            "event": event
                        }),
                    )?;
                    Ok(())
                })
                .await
            }
        })
        .await;
    match result {
        Ok(()) => {
            broker.complete(&request);
            let after = broker.identity().clone();
            let identity = broker.identity().clone();
            let finish = RunFinish {
                run_id: request.execution_id,
                status: "completed".to_string(),
                terminal_reason: None,
                workspace_id: Some(after.workspace_id),
                state_revision_after: Some(after.state_revision as i64),
                project_revision_after: Some(after.project_revision as i64),
                stdout: None,
                value_text: None,
                messages: Vec::new(),
                warnings: Vec::new(),
                error_message: None,
                error_call: None,
                traceback: Vec::new(),
                environment_snapshot_id_after: None,
            };
            run_workspace_store_service(executor, move |store| {
                store.save_identity(&identity)?;
                store.finish_run(&finish)?;
                Ok(())
            })
            .await?;
            Ok(())
        }
        Err(error) => {
            let finish = RunFinish {
                run_id: request.execution_id,
                status: "failed".to_string(),
                terminal_reason: Some("bootstrap_error".to_string()),
                workspace_id: None,
                state_revision_after: None,
                project_revision_after: None,
                stdout: None,
                value_text: None,
                messages: Vec::new(),
                warnings: Vec::new(),
                error_message: Some(redact_sensitive_text(&error.to_string())),
                error_call: None,
                traceback: Vec::new(),
                environment_snapshot_id_after: None,
            };
            run_workspace_store_service(executor, move |store| {
                store.finish_run(&finish)?;
                Ok(())
            })
            .await?;
            Err(error).context("bootstrapping rho.bridge in Ark")
        }
    }
}
