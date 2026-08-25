use super::*;

impl PendingPluginPermissionRegistry {
    #[allow(dead_code)]
    pub(crate) fn issue_workspace_object_references(
        &self,
        context: &PluginRuntimeContext,
        snapshot_response: &serde_json::Value,
    ) -> Result<Vec<WorkspaceObjectReferenceView>> {
        let workspace_context = workspace_inspection_context(context)?;
        self.state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .workspace_objects
            .issue_from_snapshot(&workspace_context, snapshot_response)
            .map_err(Into::into)
    }

    #[allow(dead_code)]
    pub(crate) async fn invoke_network_plugin(
        &self,
        context: &PluginRuntimeContext,
        plugin_id: &str,
        request: serde_json::Value,
        store_path: &Path,
    ) -> Result<WorkspacePluginCallResult> {
        let key = registry_key(&context.project_root, plugin_id);
        let request_id = HostRequestId::generate();
        let mut step = {
            let mut state = self
                .state
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            let active = state
                .active
                .get_mut(&key)
                .context("workspace plugin is not enabled for this project")?;
            ensure!(
                !active.host.broker_call_active(),
                "workspace plugin already has an active broker call"
            );
            let handles = active
                .handles
                .values()
                .map(|handle| (handle.permission.as_static_str(), handle.id.clone()))
                .collect::<BTreeMap<_, _>>();
            active
                .host
                .begin_broker_call(
                    request_id.clone(),
                    serde_json::json!({
                        "request": request,
                        "capability_handles": handles,
                    }),
                )
                .map_err(|error| anyhow!("workspace plugin broker begin failed: {error:?}"))?
        };
        let mut broker_steps = 0;
        loop {
            match step {
                GuestStep::Complete { result, .. } => {
                    return Ok(WorkspacePluginCallResult {
                        plugin_id: plugin_id.to_string(),
                        status: "completed".to_string(),
                        result: Some(result),
                        error_code: None,
                        broker_steps,
                    });
                }
                GuestStep::Error { code, .. } => {
                    return Ok(WorkspacePluginCallResult {
                        plugin_id: plugin_id.to_string(),
                        status: "failed".to_string(),
                        result: None,
                        error_code: Some(code),
                        broker_steps,
                    });
                }
                GuestStep::BrokerRequest {
                    handle_id,
                    permission,
                    operation,
                    args,
                    ..
                } => {
                    broker_steps += 1;
                    if permission != "network.fetch" || operation != "network.fetch" {
                        step =
                            self.resume_plugin_error(&key, &request_id, "operation_not_available")?;
                        continue;
                    }
                    let fetch_request: NetworkFetchRequest = match serde_json::from_value(args) {
                        Ok(request) => request,
                        Err(_) => {
                            step =
                                self.resume_plugin_error(&key, &request_id, "invalid_arguments")?;
                            continue;
                        }
                    };
                    let (
                        revalidation,
                        grant_id,
                        plugin_identity_id,
                        package_digest,
                        policy,
                        network_engine,
                    ) = {
                        let mut state = self
                            .state
                            .lock()
                            .unwrap_or_else(std::sync::PoisonError::into_inner);
                        let active = state
                            .active
                            .get(&key)
                            .context("workspace plugin was disabled before call admission")?;
                        let identity = active.host.identity().clone();
                        let setup = (|| {
                            let constraints = state
                                .grants
                                .permission_constraints_for_handle(&handle_id)
                                .ok_or("unknown_handle")?;
                            let policy = NetworkFetchPolicy {
                                allowed_hosts: constraints.hosts,
                                allowed_methods: constraints.methods,
                                max_response_bytes: constraints
                                    .max_response_bytes
                                    .ok_or("invalid_grant")?,
                                current_project_revision: u64::try_from(context.project_revision)
                                    .map_err(|_| "stale_project")?,
                            };
                            let initial = network_request_authorization(&fetch_request, &policy)
                                .map_err(|error| network_error_code(error.code))?;
                            Ok::<_, &'static str>((policy, initial))
                        })();
                        let (policy, initial) = match setup {
                            Ok(setup) => setup,
                            Err(code) => {
                                drop(state);
                                let mut store = Store::open(store_path)?;
                                if let Err(persistence_error) = record_call_event(
                                    &mut store,
                                    context,
                                    identity.plugin_id().as_str(),
                                    identity.package_digest().as_str(),
                                    None,
                                    "call_denied",
                                    "failed",
                                    Some(code),
                                    serde_json::json!({"operation": "network.fetch"}),
                                    false,
                                ) {
                                    self.cancel_plugin_call(&key, &request_id);
                                    return Err(persistence_error);
                                }
                                step = self.resume_plugin_error(&key, &request_id, code)?;
                                continue;
                            }
                        };
                        let revalidation = RevalidationRequest {
                            handle_id: handle_id.clone(),
                            plugin_id: identity.plugin_id().clone(),
                            host_instance_id: identity.host_instance_id().clone(),
                            package_digest: identity.package_digest().clone(),
                            project_id: identity.project_id().clone(),
                            scope_id: identity.project_id().clone(),
                            generation: identity.activation_generation(),
                            permission: PermissionKind::NetworkFetch,
                            permission_use: PermissionUse::NetworkFetch {
                                scheme: initial.scheme,
                                host: initial.host,
                                method: initial.method,
                                requested_response_bytes: initial.requested_response_bytes,
                            },
                            workspace: None,
                        };
                        let admitted = state.grants.revalidate(revalidation.clone());
                        if let Revalidation::Denied(error) = admitted {
                            drop(state);
                            let mut store = Store::open(store_path)?;
                            if let Err(persistence_error) = record_call_event(
                                &mut store,
                                context,
                                identity.plugin_id().as_str(),
                                identity.package_digest().as_str(),
                                None,
                                "call_denied",
                                "failed",
                                Some(grant_error_code(error)),
                                serde_json::json!({"operation": "network.fetch"}),
                                false,
                            ) {
                                self.cancel_plugin_call(&key, &request_id);
                                return Err(persistence_error);
                            }
                            step = self.resume_plugin_error(
                                &key,
                                &request_id,
                                grant_error_code(error),
                            )?;
                            continue;
                        }
                        let grant_id = state
                            .grants
                            .durable_grant_id_for_handle(&handle_id)
                            .context("admitted network handle has no durable grant identity")?
                            .to_string();
                        (
                            revalidation,
                            grant_id,
                            identity.plugin_id().to_string(),
                            identity.package_digest().to_string(),
                            policy,
                            Arc::clone(&state.network_engine),
                        )
                    };
                    {
                        let mut store = Store::open(store_path)?;
                        if let Err(error) = record_call_event(
                            &mut store,
                            context,
                            &plugin_identity_id,
                            &package_digest,
                            Some(&grant_id),
                            "call_admitted",
                            "completed",
                            None,
                            serde_json::json!({"operation": "network.fetch"}),
                            false,
                        ) {
                            self.release_plugin_admission(&handle_id);
                            self.cancel_plugin_call(&key, &request_id);
                            return Err(error);
                        }
                    }
                    let authorizer = LiveNetworkAuthorizer {
                        registry: self,
                        key: &key,
                        template: revalidation.clone(),
                    };
                    let started = Instant::now();
                    let fetched = network_engine
                        .fetch(&fetch_request, &policy, &authorizer)
                        .await;
                    let fetched = match fetched {
                        Ok(result) => result,
                        Err(error) => {
                            let code = network_error_code(error.code);
                            let authorization_stale =
                                error.code == NetworkFetchErrorCode::AuthorizationDenied;
                            let mut store = Store::open(store_path)?;
                            let persisted = if authorization_stale {
                                record_call_event(
                                    &mut store,
                                    context,
                                    &plugin_identity_id,
                                    &package_digest,
                                    None,
                                    "call_denied",
                                    "stale",
                                    Some(code),
                                    serde_json::json!({"operation": "network.fetch"}),
                                    false,
                                )
                            } else if error.completion_uncertain {
                                record_call_event(
                                    &mut store,
                                    context,
                                    &plugin_identity_id,
                                    &package_digest,
                                    Some(&grant_id),
                                    "completion_uncertain",
                                    "failed",
                                    Some(code),
                                    serde_json::json!({"operation": "network.fetch"}),
                                    true,
                                )
                            } else {
                                record_call_event(
                                    &mut store,
                                    context,
                                    &plugin_identity_id,
                                    &package_digest,
                                    Some(&grant_id),
                                    "call_failed",
                                    "failed",
                                    Some(code),
                                    serde_json::json!({"operation": "network.fetch"}),
                                    false,
                                )
                            };
                            if authorization_stale {
                                self.release_plugin_admission(&handle_id);
                            } else if error.completion_uncertain {
                                self.complete_plugin_uncertain(&handle_id);
                            } else {
                                self.release_plugin_admission(&handle_id);
                            }
                            if let Err(persistence_error) = persisted {
                                self.cancel_plugin_call(&key, &request_id);
                                return Err(persistence_error);
                            }
                            step = self.resume_plugin_error(&key, &request_id, code)?;
                            continue;
                        }
                    };
                    let final_admitted = {
                        let state = self
                            .state
                            .lock()
                            .unwrap_or_else(std::sync::PoisonError::into_inner);
                        state.grants.revalidate_admitted(&revalidation) == Revalidation::Allowed
                    };
                    if !final_admitted {
                        let mut store = Store::open(store_path)?;
                        if let Err(persistence_error) = record_call_event(
                            &mut store,
                            context,
                            &plugin_identity_id,
                            &package_digest,
                            None,
                            "call_denied",
                            "stale",
                            Some("stale_after_dispatch"),
                            serde_json::json!({"operation": "network.fetch"}),
                            false,
                        ) {
                            self.release_plugin_admission(&handle_id);
                            self.cancel_plugin_call(&key, &request_id);
                            return Err(persistence_error);
                        }
                        self.release_plugin_admission(&handle_id);
                        step =
                            self.resume_plugin_error(&key, &request_id, "stale_after_dispatch")?;
                        continue;
                    }
                    {
                        let mut store = Store::open(store_path)?;
                        if let Err(error) = record_call_event(
                            &mut store,
                            context,
                            &plugin_identity_id,
                            &package_digest,
                            Some(&grant_id),
                            "call_completed",
                            "completed",
                            None,
                            serde_json::json!({
                                "durationMs": started.elapsed().as_millis().min(u64::MAX as u128) as u64,
                                "operation": "network.fetch",
                                "redirectCount": fetched.redirect_count,
                                "sizeBytes": fetched.size_bytes,
                                "statusCode": fetched.status
                            }),
                            true,
                        ) {
                            self.complete_plugin_uncertain(&handle_id);
                            self.cancel_plugin_call(&key, &request_id);
                            return Err(error);
                        }
                    }
                    let fetched_bytes = fetched.size_bytes as usize;
                    let fetched = serde_json::to_value(fetched)?;
                    let resume_result = (|| -> Result<GuestStep> {
                        let mut state = self
                            .state
                            .lock()
                            .unwrap_or_else(std::sync::PoisonError::into_inner);
                        ensure!(
                            state.grants.revalidate_admitted(&revalidation)
                                == Revalidation::Allowed,
                            "network grant became stale after durable completion"
                        );
                        state.grants.complete_success(&handle_id);
                        state
                            .active
                            .get_mut(&key)
                            .context(
                                "workspace plugin was disabled before network result delivery",
                            )?
                            .host
                            .resume_broker_call(
                                &request_id,
                                &serde_json::json!({"ok": true, "value": fetched}),
                                fetched_bytes,
                            )
                            .map_err(|error| anyhow!("network plugin resume failed: {error:?}"))
                    })();
                    step = match resume_result {
                        Ok(step) => step,
                        Err(error) => {
                            let mut state = self
                                .state
                                .lock()
                                .unwrap_or_else(std::sync::PoisonError::into_inner);
                            remove_active_plugin(&mut state, &key);
                            drop(state);
                            let mut store = Store::open(store_path)?;
                            record_call_event(
                                &mut store,
                                context,
                                &plugin_identity_id,
                                &package_digest,
                                None,
                                "call_failed",
                                "failed",
                                Some("completion_delivery_failed"),
                                serde_json::json!({"operation": "network.fetch"}),
                                false,
                            )?;
                            return Err(error);
                        }
                    };
                }
            }
        }
    }

    #[allow(dead_code)]
    pub(crate) async fn invoke_workspace_plugin(
        &self,
        context: &PluginRuntimeContext,
        plugin_id: &str,
        request: serde_json::Value,
        store_path: &Path,
        dispatcher: &dyn WorkspacePluginDispatcher,
    ) -> Result<WorkspacePluginCallResult> {
        let key = registry_key(&context.project_root, plugin_id);
        let request_id = HostRequestId::generate();
        let workspace_context = workspace_inspection_context(context)?;
        let mut step = {
            let mut state = self
                .state
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            let references = state.workspace_objects.list_for_context(&workspace_context);
            let active = state
                .active
                .get_mut(&key)
                .context("workspace plugin is not enabled for this project")?;
            ensure!(
                !active.host.broker_call_active(),
                "workspace plugin already has an active broker call"
            );
            let handles = active
                .handles
                .values()
                .map(|handle| (handle.permission.as_static_str(), handle.id.clone()))
                .collect::<BTreeMap<_, _>>();
            active
                .host
                .begin_broker_call(
                    request_id.clone(),
                    serde_json::json!({
                        "request": request,
                        "capability_handles": handles,
                        "workspace_object_references": references,
                    }),
                )
                .map_err(|error| anyhow!("workspace plugin broker begin failed: {error:?}"))?
        };
        let mut broker_steps = 0;
        loop {
            match step {
                GuestStep::Complete { result, .. } => {
                    return Ok(WorkspacePluginCallResult {
                        plugin_id: plugin_id.to_string(),
                        status: "completed".to_string(),
                        result: Some(result),
                        error_code: None,
                        broker_steps,
                    });
                }
                GuestStep::Error { code, .. } => {
                    return Ok(WorkspacePluginCallResult {
                        plugin_id: plugin_id.to_string(),
                        status: "failed".to_string(),
                        result: None,
                        error_code: Some(code),
                        broker_steps,
                    });
                }
                GuestStep::BrokerRequest {
                    handle_id,
                    permission,
                    operation,
                    args,
                    ..
                } => {
                    broker_steps += 1;
                    if permission != "workspace.r.inspect" || operation != "workspace.r.inspect" {
                        step =
                            self.resume_plugin_error(&key, &request_id, "operation_not_available")?;
                        continue;
                    }
                    let inspect_request: WorkspaceInspectRequest =
                        match serde_json::from_value(args) {
                            Ok(request) => request,
                            Err(_) => {
                                step = self.resume_plugin_error(
                                    &key,
                                    &request_id,
                                    "invalid_arguments",
                                )?;
                                continue;
                            }
                        };
                    let requested_bytes = match inspect_request.operation {
                        WorkspaceInspectOperation::Metadata => 64 * 1024,
                        WorkspaceInspectOperation::Preview => 256 * 1024,
                    };
                    let (prepared, revalidation, grant_id, plugin_identity_id, package_digest) = {
                        let mut state = self
                            .state
                            .lock()
                            .unwrap_or_else(std::sync::PoisonError::into_inner);
                        let prepared = state
                            .workspace_objects
                            .prepare(&workspace_context, &inspect_request)?;
                        let active = state
                            .active
                            .get(&key)
                            .context("workspace plugin was disabled before call admission")?;
                        let identity = active.host.identity().clone();
                        let revalidation = RevalidationRequest {
                            handle_id: handle_id.clone(),
                            plugin_id: identity.plugin_id().clone(),
                            host_instance_id: identity.host_instance_id().clone(),
                            package_digest: identity.package_digest().clone(),
                            project_id: identity.project_id().clone(),
                            scope_id: identity.project_id().clone(),
                            generation: identity.activation_generation(),
                            permission: PermissionKind::WorkspaceRInspect,
                            permission_use: PermissionUse::WorkspaceRInspect {
                                operation: match inspect_request.operation {
                                    WorkspaceInspectOperation::Metadata => "metadata",
                                    WorkspaceInspectOperation::Preview => "preview",
                                }
                                .to_string(),
                                requested_bytes,
                            },
                            workspace: context.workspace.clone(),
                        };
                        let admitted = state.grants.revalidate(revalidation.clone());
                        if let Revalidation::Denied(error) = admitted {
                            drop(state);
                            let mut store = Store::open(store_path)?;
                            if let Err(persistence_error) = record_call_event(
                                &mut store,
                                context,
                                identity.plugin_id().as_str(),
                                identity.package_digest().as_str(),
                                None,
                                "call_denied",
                                "failed",
                                Some(grant_error_code(error)),
                                serde_json::json!({"operation": "workspace.r.inspect"}),
                                false,
                            ) {
                                self.cancel_plugin_call(&key, &request_id);
                                return Err(persistence_error);
                            }
                            step = self.resume_plugin_error(
                                &key,
                                &request_id,
                                grant_error_code(error),
                            )?;
                            continue;
                        }
                        let grant_id = state
                            .grants
                            .durable_grant_id_for_handle(&handle_id)
                            .context("admitted Workspace handle has no durable grant identity")?
                            .to_string();
                        (
                            prepared,
                            revalidation,
                            grant_id,
                            identity.plugin_id().to_string(),
                            identity.package_digest().to_string(),
                        )
                    };
                    {
                        let mut store = Store::open(store_path)?;
                        if let Err(error) = record_call_event(
                            &mut store,
                            context,
                            &plugin_identity_id,
                            &package_digest,
                            Some(&grant_id),
                            "call_admitted",
                            "completed",
                            None,
                            serde_json::json!({"operation": "workspace.r.inspect"}),
                            false,
                        ) {
                            self.release_plugin_admission(&handle_id);
                            self.cancel_plugin_call(&key, &request_id);
                            return Err(error);
                        }
                    }
                    let started = Instant::now();
                    let dispatched = match dispatcher.dispatch(prepared.clone()).await {
                        Ok(result) => result,
                        Err(_) => {
                            let mut store = Store::open(store_path)?;
                            if let Err(persistence_error) = record_call_event(
                                &mut store,
                                context,
                                &plugin_identity_id,
                                &package_digest,
                                Some(&grant_id),
                                "call_failed",
                                "failed",
                                Some("workspace_dispatch_failed"),
                                serde_json::json!({"operation": "workspace.r.inspect"}),
                                false,
                            ) {
                                self.release_plugin_admission(&handle_id);
                                self.cancel_plugin_call(&key, &request_id);
                                return Err(persistence_error);
                            }
                            self.release_plugin_admission(&handle_id);
                            step = self.resume_plugin_error(
                                &key,
                                &request_id,
                                "workspace_dispatch_failed",
                            )?;
                            continue;
                        }
                    };
                    let completed_context = WorkspaceInspectionContext {
                        project_root: context.project_root.clone(),
                        workspace: dispatched.current_workspace.clone(),
                    };
                    let projected = {
                        let state = self
                            .state
                            .lock()
                            .unwrap_or_else(std::sync::PoisonError::into_inner);
                        state.workspace_objects.finish(
                            &completed_context,
                            &prepared,
                            &dispatched.response,
                        )
                    };
                    let projected = match projected {
                        Ok(projected) => projected,
                        Err(error) => {
                            let code = workspace_error_code(error.code);
                            let mut store = Store::open(store_path)?;
                            if let Err(persistence_error) = record_call_event(
                                &mut store,
                                context,
                                &plugin_identity_id,
                                &package_digest,
                                None,
                                "call_denied",
                                "stale",
                                Some(code),
                                serde_json::json!({"operation": "workspace.r.inspect"}),
                                false,
                            ) {
                                self.release_plugin_admission(&handle_id);
                                self.cancel_plugin_call(&key, &request_id);
                                return Err(persistence_error);
                            }
                            self.release_plugin_admission(&handle_id);
                            step = self.resume_plugin_error(&key, &request_id, code)?;
                            continue;
                        }
                    };
                    let still_admitted = {
                        let state = self
                            .state
                            .lock()
                            .unwrap_or_else(std::sync::PoisonError::into_inner);
                        same_workspace_grant_identity(
                            context.workspace.as_ref(),
                            &dispatched.current_workspace,
                        ) && state.grants.revalidate_admitted(&revalidation)
                            == Revalidation::Allowed
                    };
                    if !still_admitted {
                        let mut store = Store::open(store_path)?;
                        if let Err(persistence_error) = record_call_event(
                            &mut store,
                            context,
                            &plugin_identity_id,
                            &package_digest,
                            None,
                            "call_denied",
                            "stale",
                            Some("stale_after_dispatch"),
                            serde_json::json!({"operation": "workspace.r.inspect"}),
                            false,
                        ) {
                            self.release_plugin_admission(&handle_id);
                            self.cancel_plugin_call(&key, &request_id);
                            return Err(persistence_error);
                        }
                        self.release_plugin_admission(&handle_id);
                        step =
                            self.resume_plugin_error(&key, &request_id, "stale_after_dispatch")?;
                        continue;
                    }
                    let projected_bytes = serde_json::to_vec(&projected)?.len();
                    {
                        let mut store = Store::open(store_path)?;
                        if let Err(error) = record_call_event(
                            &mut store,
                            context,
                            &plugin_identity_id,
                            &package_digest,
                            Some(&grant_id),
                            "call_completed",
                            "completed",
                            None,
                            serde_json::json!({
                                "durationMs": started.elapsed().as_millis().min(u64::MAX as u128) as u64,
                                "operation": "workspace.r.inspect",
                                "sizeBytes": projected_bytes
                            }),
                            true,
                        ) {
                            self.release_plugin_admission(&handle_id);
                            self.cancel_plugin_call(&key, &request_id);
                            return Err(error);
                        }
                    }
                    let resume_result = (|| -> Result<GuestStep> {
                        let mut state = self
                            .state
                            .lock()
                            .unwrap_or_else(std::sync::PoisonError::into_inner);
                        ensure!(
                            state.grants.revalidate_admitted(&revalidation)
                                == Revalidation::Allowed,
                            "Workspace grant became stale after durable completion"
                        );
                        state.grants.complete_success(&handle_id);
                        state
                            .active
                            .get_mut(&key)
                            .context("workspace plugin was disabled before result delivery")?
                            .host
                            .resume_broker_call(
                                &request_id,
                                &serde_json::json!({"ok": true, "value": projected}),
                                projected_bytes,
                            )
                            .map_err(|error| anyhow!("Workspace plugin resume failed: {error:?}"))
                    })();
                    step = match resume_result {
                        Ok(step) => step,
                        Err(error) => {
                            let mut state = self
                                .state
                                .lock()
                                .unwrap_or_else(std::sync::PoisonError::into_inner);
                            remove_active_plugin(&mut state, &key);
                            drop(state);
                            let mut store = Store::open(store_path)?;
                            record_call_event(
                                &mut store,
                                context,
                                &plugin_identity_id,
                                &package_digest,
                                None,
                                "call_failed",
                                "failed",
                                Some("completion_delivery_failed"),
                                serde_json::json!({"operation": "workspace.r.inspect"}),
                                false,
                            )?;
                            return Err(error);
                        }
                    };
                }
            }
        }
    }
}
