pub async fn dispatch_workspace_request(
    request_type: &str,
    payload: &Value,
    origin: ExecutionOrigin,
    session: &ArkSession,
    broker: &mut BrokerState,
    executor: &StoreExecutor,
) -> Result<Value> {
    dispatch_workspace_request_with_execution_id(
        request_type,
        payload,
        origin,
        session,
        broker,
        executor,
        None,
    )
    .await
}

pub async fn dispatch_workspace_request_with_execution_id(
    request_type: &str,
    payload: &Value,
    origin: ExecutionOrigin,
    session: &ArkSession,
    broker: &mut BrokerState,
    executor: &StoreExecutor,
    execution_id: Option<&str>,
) -> Result<Value> {
    let expected: ExpectedWorkspace = serde_json::from_value(
        payload
            .get("expected_workspace")
            .cloned()
            .context("Agent request omitted expected_workspace")?,
    )
    .context("decoding expected_workspace")?;
    let arguments = payload
        .get("arguments")
        .cloned()
        .unwrap_or_else(|| json!({}));
    let (operation_class, bridge_expression) = bridge_expression(request_type, &arguments)?;
    let mut request =
        ExecutionRequest::new(origin, operation_class, expected, bridge_expression.clone());
    if let Some(execution_id) = execution_id {
        ensure!(
            valid_caller_execution_id(execution_id),
            "invalid caller-provided execution id"
        );
        request.execution_id = execution_id.to_string();
    }
    broker.authorize(&request)?;
    let before = broker.identity().clone();
    let project_root = run_workspace_store_service(executor, |store| {
        store
            .active_project_root()?
            .context("Cannot persist run without an active project identity")
    })
    .await?;
    let environment_snapshot_id = if scientific_run_requires_environment_snapshot(request_type) {
        Some(capture_environment_snapshot_id(session, &project_root, executor).await?)
    } else {
        None
    };
    let generated_output_before = (request_type == "workspace.execute")
        .then(|| capture_generated_output_snapshot(Path::new(&project_root)));
    let run_draft = RunDraft {
        run_id: request.execution_id.clone(),
        parent_run_id: arguments
            .get("parent_run_id")
            .and_then(Value::as_str)
            .map(str::to_string),
        project_root: project_root.clone(),
        origin: execution_origin_name(origin).to_string(),
        request_type: request_type.to_string(),
        operation_class: operation_class_name(operation_class).to_string(),
        code: requested_code(request_type, &arguments, &bridge_expression),
        arguments_json: serde_json::to_string(&arguments)?,
        source_path: arguments
            .get("source_path")
            .and_then(Value::as_str)
            .map(str::to_string),
        execution_mode: arguments
            .get("execution_mode")
            .and_then(Value::as_str)
            .map(str::to_string),
        document_version: arguments.get("document_version").and_then(Value::as_i64),
        workspace_id: before.workspace_id.clone(),
        state_revision_before: before.state_revision as i64,
        project_revision_before: before.project_revision as i64,
        environment_snapshot_id,
    };
    let run_id = request.execution_id.clone();
    run_workspace_store_service(executor, move |store| {
        store.create_run(&run_draft)?;
        store.update_run_status(&run_id, "running", None)?;
        Ok(())
    })
    .await?;
    let result_file = ResultFile::new(&request.execution_id)?;
    let bridge_call = bridge_result_publisher(&bridge_expression, &result_file)?;
    request.code = bridge_call.clone();
    let kernel_events = Arc::new(StdMutex::new(Vec::new()));
    let event_kernel_events = Arc::clone(&kernel_events);
    let event_executor = executor.clone();
    let event_execution_id = request.execution_id.clone();
    let execution = session
        .execute_async(bridge_call, move |event| {
            event_kernel_events
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .push(event.clone());
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
        .await
        .and_then(|_| {
            let events = kernel_events
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            ensure_no_kernel_errors(&events)
        });
    match execution {
        Ok(()) => {}
        Err(error) => {
            let cancel_execution_id = request.execution_id.clone();
            let cancelled = run_workspace_store_service(executor, move |store| {
                Ok(store
                    .cancel_requested(&cancel_execution_id)
                    .unwrap_or(false))
            })
            .await?;
            let environment_snapshot_id_after =
                if scientific_run_requires_environment_snapshot(request_type) {
                    capture_environment_snapshot_id(session, &project_root, executor)
                        .await
                        .ok()
                } else {
                    None
                };
            let error_message = redact_sensitive_text(&error.to_string());
            let finish = RunFinish {
                run_id: request.execution_id.clone(),
                status: if cancelled { "interrupted" } else { "failed" }.to_string(),
                terminal_reason: Some(
                    if cancelled {
                        "user_interrupt"
                    } else {
                        "execution_error"
                    }
                    .to_string(),
                ),
                workspace_id: None,
                state_revision_after: None,
                project_revision_after: None,
                stdout: None,
                value_text: None,
                messages: Vec::new(),
                warnings: Vec::new(),
                error_message: Some(error_message.clone()),
                error_call: None,
                traceback: Vec::new(),
                environment_snapshot_id_after,
            };
            run_workspace_store_service(executor, move |store| {
                store.finish_run(&finish)?;
                Ok(())
            })
            .await?;
            return Err(error).context("executing Workspace R request");
        }
    }
    let result = match result_file.read_json() {
        Ok(value) => value,
        Err(error) => {
            let cancel_execution_id = request.execution_id.clone();
            let cancelled = run_workspace_store_service(executor, move |store| {
                Ok(store
                    .cancel_requested(&cancel_execution_id)
                    .unwrap_or(false))
            })
            .await?;
            let environment_snapshot_id_after =
                if scientific_run_requires_environment_snapshot(request_type) {
                    capture_environment_snapshot_id(session, &project_root, executor)
                        .await
                        .ok()
                } else {
                    None
                };
            let error_message = redact_sensitive_text(&error.to_string());
            let finish = RunFinish {
                run_id: request.execution_id.clone(),
                status: if cancelled { "interrupted" } else { "failed" }.to_string(),
                terminal_reason: Some(
                    if cancelled {
                        "user_interrupt"
                    } else {
                        "result_unavailable"
                    }
                    .to_string(),
                ),
                workspace_id: None,
                state_revision_after: None,
                project_revision_after: None,
                stdout: None,
                value_text: None,
                messages: Vec::new(),
                warnings: Vec::new(),
                error_message: Some(error_message.clone()),
                error_call: None,
                traceback: Vec::new(),
                environment_snapshot_id_after,
            };
            run_workspace_store_service(executor, move |store| {
                store.finish_run(&finish)?;
                Ok(())
            })
            .await?;
            return Err(error);
        }
    };
    broker.complete(&request);
    let after = broker.identity().clone();
    let durable_identity = after.clone();
    run_workspace_store_service(executor, move |store| {
        store.save_identity(&durable_identity)?;
        Ok(())
    })
    .await?;
    let failed = workspace_result_failed(&result);
    let generated_output_after = (!failed && request_type == "workspace.execute")
        .then(|| capture_generated_output_snapshot(Path::new(&project_root)));
    let generated_output_deltas = generated_output_before
        .as_ref()
        .zip(generated_output_after.as_ref())
        .map(|(before, after)| generated_output_deltas(before, after))
        .unwrap_or_default();
    let environment_snapshot_id_after =
        if scientific_run_requires_environment_snapshot(request_type) {
            capture_environment_snapshot_id(session, &project_root, executor)
                .await
                .ok()
        } else {
            None
        };
    let error_range = translated_run_error_range(&arguments, &result);
    let finish = RunFinish {
        run_id: request.execution_id.clone(),
        status: if failed { "failed" } else { "completed" }.to_string(),
        terminal_reason: failed.then_some("r_error".to_string()),
        workspace_id: Some(after.workspace_id.clone()),
        state_revision_after: Some(after.state_revision as i64),
        project_revision_after: Some(after.project_revision as i64),
        stdout: json_string(&result, "stdout"),
        value_text: json_string(&result, "value"),
        messages: json_string_list(&result, "messages"),
        warnings: json_string_list(&result, "warnings"),
        error_message: result
            .get("error")
            .and_then(|value| value.get("message"))
            .and_then(Value::as_str)
            .map(redact_sensitive_text),
        error_call: result
            .get("error")
            .and_then(|value| value.get("call"))
            .and_then(Value::as_str)
            .map(str::to_string),
        traceback: json_string_list(&result, "traceback")
            .into_iter()
            .chain(json_string_list(&result, "calls"))
            .collect(),
        environment_snapshot_id_after,
    };
    run_workspace_store_service(executor, move |store| {
        store.finish_run_with_error_range(&finish, error_range.as_ref())?;
        Ok(())
    })
    .await?;
    let kernel_events = kernel_events
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .clone();
    let plot_payloads = extract_plot_payloads(&kernel_events);
    let mut plot_references = Vec::new();
    let mut plot_drafts = Vec::new();
    for (index, (media_type, payload_json)) in plot_payloads.into_iter().enumerate() {
        let plot_id = format!("plot_{}_{}", request.execution_id, index + 1);
        let payload_bytes = payload_json.len();
        let payload_sha256 = sha256_hex(payload_json.as_bytes());
        plot_drafts.push(PlotArtifactDraft {
            plot_id: plot_id.clone(),
            run_id: request.execution_id.clone(),
            project_root: Some(project_root.clone()),
            source_path: arguments
                .get("source_path")
                .and_then(Value::as_str)
                .map(str::to_string),
            execution_mode: arguments
                .get("execution_mode")
                .and_then(Value::as_str)
                .map(str::to_string),
            document_version: arguments.get("document_version").and_then(Value::as_i64),
            workspace_id: Some(after.workspace_id.clone()),
            state_revision: Some(after.state_revision as i64),
            project_revision: Some(after.project_revision as i64),
            media_type: media_type.clone(),
            payload_json,
            provenance_complete: arguments
                .get("source_path")
                .and_then(Value::as_str)
                .is_some_and(|path| !path.starts_with('<'))
                && arguments
                    .get("document_version")
                    .and_then(Value::as_i64)
                    .is_some(),
        });
        plot_references.push(json!({
            "plot_id": plot_id,
            "media_type": media_type,
            "payload_bytes": payload_bytes,
            "payload_sha256": payload_sha256,
        }));
    }
    if !plot_drafts.is_empty() {
        run_workspace_store_service(executor, move |store| {
            for draft in &plot_drafts {
                store.create_plot_artifact(draft)?;
            }
            Ok(())
        })
        .await?;
    }
    let mut artifact_references = Vec::new();
    let mut artifact_drafts = Vec::new();
    if !generated_output_deltas.is_empty() {
        let source_path = arguments
            .get("source_path")
            .and_then(Value::as_str)
            .map(str::to_string);
        let document_version = arguments.get("document_version").and_then(Value::as_i64);
        let (provenance_complete, incomplete_reason) = artifact_provenance_status(
            Some(&request.execution_id),
            source_path.as_deref(),
            document_version,
        );
        for delta in generated_output_deltas {
            let path_hash = sha256_hex(delta.path.as_bytes());
            let artifact_id = format!(
                "artifact_{}_file_{}",
                request.execution_id,
                &path_hash[..16]
            );
            let media_type = infer_output_media_type(&delta.path);
            let output_signature = hash_project_output(Path::new(&project_root), &delta.path).ok();
            artifact_drafts.push(ArtifactRecordDraft {
                artifact_id: artifact_id.clone(),
                artifact_kind: "generated_file".to_string(),
                run_id: Some(request.execution_id.clone()),
                project_root: project_root.clone(),
                output_path: delta.path.clone(),
                source_path: source_path.clone(),
                execution_mode: arguments
                    .get("execution_mode")
                    .and_then(Value::as_str)
                    .map(str::to_string),
                document_version,
                workspace_id: Some(after.workspace_id.clone()),
                state_revision: Some(after.state_revision as i64),
                project_revision: Some(after.project_revision as i64),
                media_type: media_type.clone(),
                metadata_json: serde_json::to_string(&json!({
                    "discovery": "project_file_delta",
                    "change_kind": delta.change_kind,
                    "size_bytes": delta.signature.size_bytes,
                    "scan_truncated": generated_output_before.as_ref().is_some_and(|value| value.truncated)
                        || generated_output_after.as_ref().is_some_and(|value| value.truncated),
                }))?,
                provenance_complete,
                incomplete_reason: incomplete_reason.clone(),
            });
            artifact_references.push(json!({
                "artifact_id": artifact_id,
                "media_type": media_type,
                "output_path": delta.path,
                "payload_bytes": output_signature.as_ref().map(|value| value.0),
                "payload_sha256": output_signature.as_ref().map(|value| value.1.clone()),
            }));
        }
    }
    let mut artifact_id = None;
    let mut artifact_media_type = None;
    if !failed
        && request_type == "workspace.render_document"
        && let Some(output_path) = result.get("output_path").and_then(Value::as_str)
    {
            let source_path = arguments
                .get("source_path")
                .and_then(Value::as_str)
                .map(str::to_string);
            let document_version = arguments.get("document_version").and_then(Value::as_i64);
            let (provenance_complete, incomplete_reason) = artifact_provenance_status(
                Some(&request.execution_id),
                source_path.as_deref(),
                document_version,
            );
            let created_artifact_id = render_artifact_id(&request.execution_id);
            let created_media_type = infer_output_media_type(output_path);
            let relative_output = artifact_output_path(Some(&project_root), output_path);
            let output_materialized =
                materialized_project_output(Path::new(&project_root), &relative_output);
            if output_materialized {
                artifact_drafts.push(ArtifactRecordDraft {
                    artifact_id: created_artifact_id.clone(),
                    artifact_kind: "render_output".to_string(),
                    run_id: Some(request.execution_id.clone()),
                    project_root: project_root.clone(),
                    output_path: relative_output,
                    source_path,
                    execution_mode: arguments
                        .get("execution_mode")
                        .and_then(Value::as_str)
                        .map(str::to_string),
                    document_version,
                    workspace_id: Some(after.workspace_id.clone()),
                    state_revision: Some(after.state_revision as i64),
                    project_revision: Some(after.project_revision as i64),
                    media_type: created_media_type.clone(),
                    metadata_json: serde_json::to_string(&json!({
                        "tool": result.get("tool").and_then(Value::as_str),
                        "source_path": arguments.get("source_path").and_then(Value::as_str),
                    }))?,
                    provenance_complete,
                    incomplete_reason,
                });
                artifact_id = Some(created_artifact_id);
                artifact_media_type = Some(created_media_type);
            }
    }
    if !artifact_drafts.is_empty() {
        run_workspace_store_service(executor, move |store| {
            for draft in &artifact_drafts {
                store.create_artifact_record(draft)?;
            }
            Ok(())
        })
        .await?;
    }
    Ok(json!({
        "execution_id": request.execution_id,
        "artifact_id": artifact_id,
        "artifact_media_type": artifact_media_type,
        "plot_references": plot_references,
        "artifact_references": artifact_references,
        "execution": result,
        "events": kernel_events,
        "workspace": broker.identity()
    }))
}
