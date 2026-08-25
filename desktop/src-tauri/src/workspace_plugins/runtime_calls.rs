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

    /// Execute a future contribution call through the no-import Guest ABI V2
    /// loop. P2-2C admits only `project.fs.read`; P2-3 will supply the first
    /// product contribution router that calls this method.
    #[allow(dead_code)]
    pub(crate) fn invoke_plugin(
        &self,
        context: &PluginRuntimeContext,
        plugin_id: &str,
        request: serde_json::Value,
        store: &mut Store,
    ) -> Result<WorkspacePluginCallResult> {
        self.invoke_plugin_with_hook(
            context,
            plugin_id,
            request,
            store,
            &mut |_registry, _store, _grant_id| Ok(()),
        )
    }

    pub(super) fn invoke_plugin_with_hook(
        &self,
        context: &PluginRuntimeContext,
        plugin_id: &str,
        request: serde_json::Value,
        store: &mut Store,
        after_read: &mut impl FnMut(&Self, &mut Store, &str) -> Result<()>,
    ) -> Result<WorkspacePluginCallResult> {
        let key = registry_key(&context.project_root, plugin_id);
        let crash_identity = self.crash_identity(&key);
        let result =
            self.invoke_plugin_with_hook_inner(context, plugin_id, request, store, after_read);
        if result.is_err()
            && let Some(identity) = crash_identity.as_ref()
        {
            let _ =
                self.persist_crash_if_needed(context, &key, identity, "guest_call_failed", store);
        }
        result
    }

    fn invoke_plugin_with_hook_inner(
        &self,
        context: &PluginRuntimeContext,
        plugin_id: &str,
        request: serde_json::Value,
        store: &mut Store,
        after_read: &mut impl FnMut(&Self, &mut Store, &str) -> Result<()>,
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
            ensure!(
                active.package_digest == active.host.identity().package_digest().as_str(),
                "workspace plugin host package identity is stale"
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
                    if permission != "project.fs.read" || operation != "project.fs.read" {
                        step =
                            self.resume_plugin_error(&key, &request_id, "operation_not_available")?;
                        continue;
                    }
                    let file_request: ProjectFsReadRequest = match serde_json::from_value(args) {
                        Ok(request) => request,
                        Err(_) => {
                            step =
                                self.resume_plugin_error(&key, &request_id, "invalid_arguments")?;
                            continue;
                        }
                    };
                    let (revalidation, grant_id, plugin_identity) = {
                        let mut state = self
                            .state
                            .lock()
                            .unwrap_or_else(std::sync::PoisonError::into_inner);
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
                            permission: PermissionKind::ProjectFsRead,
                            permission_use: PermissionUse::ProjectFsRead {
                                relative_path: file_request.project_relative_path.clone(),
                                requested_bytes: file_request.max_bytes,
                            },
                            workspace: None,
                        };
                        let outcome = state.grants.revalidate(revalidation.clone());
                        let grant_id = state
                            .grants
                            .durable_grant_id_for_handle(&handle_id)
                            .map(str::to_string);
                        (
                            revalidation,
                            grant_id,
                            (
                                identity.plugin_id().to_string(),
                                identity.package_digest().to_string(),
                                outcome,
                            ),
                        )
                    };
                    let (plugin_identity_id, package_digest, admitted) = plugin_identity;
                    if let Revalidation::Denied(error) = admitted {
                        if let Err(persistence_error) = record_call_event(
                            store,
                            context,
                            &plugin_identity_id,
                            &package_digest,
                            None,
                            "call_denied",
                            "failed",
                            Some(grant_error_code(error)),
                            serde_json::json!({"operation": "project.fs.read"}),
                            false,
                        ) {
                            self.cancel_plugin_call(&key, &request_id);
                            return Err(persistence_error);
                        }
                        step =
                            self.resume_plugin_error(&key, &request_id, grant_error_code(error))?;
                        continue;
                    }
                    let Some(grant_id) = grant_id else {
                        self.cancel_plugin_call(&key, &request_id);
                        bail!("admitted plugin handle has no durable grant identity");
                    };
                    if let Err(error) = record_call_event(
                        store,
                        context,
                        &plugin_identity_id,
                        &package_digest,
                        Some(&grant_id),
                        "call_admitted",
                        "completed",
                        None,
                        serde_json::json!({"operation": "project.fs.read"}),
                        false,
                    ) {
                        self.release_plugin_admission(&handle_id);
                        self.cancel_plugin_call(&key, &request_id);
                        return Err(error);
                    }
                    let started = Instant::now();
                    let operation = read_project_file(
                        Path::new(&context.project_root),
                        u64::try_from(context.project_revision)
                            .context("current project revision is negative")?,
                        &file_request,
                    );
                    let file_result = match operation {
                        Ok(result) => result,
                        Err(error) => {
                            let code = project_file_error_code(error.code);
                            if let Err(persistence_error) = record_call_event(
                                store,
                                context,
                                &plugin_identity_id,
                                &package_digest,
                                Some(&grant_id),
                                "call_failed",
                                "failed",
                                Some(code),
                                serde_json::json!({
                                    "durationMs": started.elapsed().as_millis().min(u64::MAX as u128) as u64,
                                    "operation": "project.fs.read"
                                }),
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
                    after_read(self, store, &grant_id)?;
                    let still_admitted = {
                        let state = self
                            .state
                            .lock()
                            .unwrap_or_else(std::sync::PoisonError::into_inner);
                        let session_current = state.active.get(&key).is_some_and(|active| {
                            active.host.identity().host_instance_id()
                                == &revalidation.host_instance_id
                        });
                        session_current
                            && state.grants.revalidate_admitted(&revalidation)
                                == Revalidation::Allowed
                    };
                    if !still_admitted {
                        if let Err(persistence_error) = record_call_event(
                            store,
                            context,
                            &plugin_identity_id,
                            &package_digest,
                            None,
                            "call_denied",
                            "stale",
                            Some("stale_after_dispatch"),
                            serde_json::json!({"operation": "project.fs.read"}),
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
                    if let Err(persistence_error) = record_call_event(
                        store,
                        context,
                        &plugin_identity_id,
                        &package_digest,
                        Some(&grant_id),
                        "call_completed",
                        "completed",
                        None,
                        serde_json::json!({
                            "durationMs": started.elapsed().as_millis().min(u64::MAX as u128) as u64,
                            "operation": "project.fs.read",
                            "sizeBytes": file_result.size_bytes
                        }),
                        true,
                    ) {
                        self.release_plugin_admission(&handle_id);
                        self.cancel_plugin_call(&key, &request_id);
                        return Err(persistence_error);
                    }
                    let result_value = serde_json::to_value(&file_result)?;
                    let resume_result = (|| -> Result<GuestStep> {
                        let mut state = self
                            .state
                            .lock()
                            .unwrap_or_else(std::sync::PoisonError::into_inner);
                        let final_admission = state.grants.revalidate_admitted(&revalidation);
                        if final_admission != Revalidation::Allowed {
                            state.grants.complete_uncertain(&handle_id);
                            if let Some(active) = state.active.get_mut(&key) {
                                let _ = active.host.cancel_broker_call(&request_id);
                            }
                            bail!("plugin grant became stale after durable completion");
                        }
                        state.grants.complete_success(&handle_id);
                        let active = state
                            .active
                            .get_mut(&key)
                            .context("workspace plugin was disabled before result delivery")?;
                        active
                            .host
                            .resume_broker_call(
                                &request_id,
                                &serde_json::json!({"ok": true, "value": result_value}),
                                file_result.size_bytes as usize,
                            )
                            .map_err(|error| {
                                anyhow!("workspace plugin broker resume failed: {error:?}")
                            })
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
                            record_call_event(
                                store,
                                context,
                                &plugin_identity_id,
                                &package_digest,
                                None,
                                "call_failed",
                                "failed",
                                Some("guest_resume_failed"),
                                serde_json::json!({"operation": "project.fs.read"}),
                                false,
                            )?;
                            return Err(error);
                        }
                    };
                }
            }
        }
    }

    fn resume_plugin_error(
        &self,
        key: &str,
        request_id: &HostRequestId,
        code: &str,
    ) -> Result<GuestStep> {
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let (result, failed_host) = {
            let active = state
                .active
                .get_mut(key)
                .context("workspace plugin was disabled before error delivery")?;
            let host_id = active.host_instance_id.clone();
            let result = active.host.resume_broker_call(
                request_id,
                &serde_json::json!({"ok": false, "error": {"code": code}}),
                0,
            );
            (result, host_id)
        };
        match result {
            Ok(step) => Ok(step),
            Err(error) => {
                remove_active_plugin(&mut state, key);
                state.grants.invalidate_host(&failed_host);
                Err(anyhow!("workspace plugin error resume failed: {error:?}"))
            }
        }
    }

    fn release_plugin_admission(&self, handle_id: &str) {
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        state.grants.complete_failure_before_dispatch(handle_id);
    }

    fn complete_plugin_uncertain(&self, handle_id: &str) {
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        state.grants.complete_uncertain(handle_id);
    }

    fn cancel_plugin_call(&self, key: &str, request_id: &HostRequestId) {
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if let Some(active) = state.active.get_mut(key) {
            let _ = active.host.cancel_broker_call(request_id);
        }
    }

    #[allow(dead_code)]
    pub(crate) fn begin_contribution_call(
        &self,
        context: &PluginRuntimeContext,
        contribution_id: &str,
        origin: ContributionInvocationOrigin,
        input: serde_json::Value,
    ) -> Result<(ContributionCallSession, GuestStep)> {
        let contribution_id = rho_extension_runtime::CapabilityId::new(contribution_id.to_string())
            .context("validating contribution id")?;
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let plugin_id = state
            .contributions
            .get(&context.project_scope_id, &contribution_id)
            .context("contribution is not published for the current project")?
            .plugin_id
            .to_string();
        let key = registry_key(&context.project_root, &plugin_id);
        let RegistryState {
            active,
            contributions,
            ..
        } = &mut *state;
        let active = active
            .get_mut(&key)
            .context("contribution host is not active for the current project")?;
        let handles = if origin == ContributionInvocationOrigin::TrustedCheckRule {
            BTreeMap::new()
        } else {
            active
                .handles
                .values()
                .map(|handle| {
                    (
                        handle.permission.as_static_str().to_string(),
                        handle.id.clone(),
                    )
                })
                .collect()
        };
        ContributionCallSession::begin(
            contributions,
            ContributionCallRequest {
                project_id: context.project_scope_id.clone(),
                contribution_id,
                origin,
                input,
                supplied_handles: handles,
            },
            &SystemContributionClock,
            &mut active.host,
        )
        .map_err(Into::into)
    }

    #[allow(dead_code)]
    pub(crate) fn resume_contribution_call(
        &self,
        context: &PluginRuntimeContext,
        session: &mut ContributionCallSession,
        broker_result: &serde_json::Value,
        raw_result_bytes: usize,
    ) -> Result<GuestStep> {
        ensure!(
            session.identity().project_id == context.project_scope_id,
            "contribution call belongs to another project"
        );
        let key = registry_key(&context.project_root, session.identity().plugin_id.as_str());
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let result = {
            let RegistryState {
                active,
                contributions,
                ..
            } = &mut *state;
            let active = active
                .get_mut(&key)
                .context("contribution host became inactive before resume")?;
            session.resume(
                contributions,
                broker_result,
                raw_result_bytes,
                &SystemContributionClock,
                &mut active.host,
            )
        };
        if result.is_err()
            && state.active.get(&key).is_some_and(|active| {
                active.host.identity().project_id() == &session.identity().project_id
                    && active.host.identity().plugin_id() == &session.identity().plugin_id
                    && active.host.identity().package_digest() == &session.identity().package_digest
                    && active.host.identity().activation_generation()
                        == session.identity().activation_generation
                    && active.host.identity().host_instance_id()
                        == &session.identity().host_instance_id
            })
        {
            remove_active_plugin(&mut state, &key);
        }
        result.map_err(Into::into)
    }

    #[allow(dead_code)]
    pub(crate) fn finish_contribution_call(
        &self,
        context: &PluginRuntimeContext,
        session: &mut ContributionCallSession,
        step: &GuestStep,
    ) -> Result<ContributionCallOutcome> {
        ensure!(
            session.identity().project_id == context.project_scope_id,
            "contribution call belongs to another project"
        );
        let key = registry_key(&context.project_root, session.identity().plugin_id.as_str());
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let RegistryState {
            active,
            contributions,
            grants,
            ..
        } = &mut *state;
        let active = active
            .get_mut(&key)
            .context("contribution host became inactive before completion")?;
        if !session.supplied_handles_are_live(|handle_id| {
            grants.handle_allows_admitted_completion(handle_id)
        }) {
            session.invalidate_before_publish();
            bail!("contribution handle was revoked or expired before completion");
        }
        session
            .finish(
                contributions,
                step,
                &SystemContributionClock,
                &mut active.host,
            )
            .map_err(Into::into)
    }

    pub(crate) fn invoke_file_contribution(
        &self,
        context: &PluginRuntimeContext,
        contribution_id: &str,
        origin: ContributionInvocationOrigin,
        input: serde_json::Value,
        store: &mut Store,
    ) -> Result<serde_json::Value> {
        let crash_context = {
            let state = self
                .state
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            rho_extension_runtime::CapabilityId::new(contribution_id.to_string())
                .ok()
                .and_then(|capability| {
                    state
                        .contributions
                        .get(&context.project_scope_id, &capability)
                })
                .and_then(|record| {
                    let key = registry_key(&context.project_root, record.plugin_id.as_str());
                    state.active.get(&key).map(|active| {
                        (
                            key,
                            ActiveCrashIdentity {
                                plugin_id: record.plugin_id.to_string(),
                                package_digest: record.package_digest.to_string(),
                                host_instance_id: active.host_instance_id.clone(),
                            },
                        )
                    })
                })
        };
        let result =
            self.invoke_file_contribution_inner(context, contribution_id, origin, input, store);
        if result.is_err()
            && let Some((key, identity)) = crash_context.as_ref()
        {
            let _ = self.persist_crash_if_needed(
                context,
                key,
                identity,
                "contribution_host_failed",
                store,
            );
        }
        result
    }

    fn invoke_file_contribution_inner(
        &self,
        context: &PluginRuntimeContext,
        contribution_id: &str,
        origin: ContributionInvocationOrigin,
        input: serde_json::Value,
        store: &mut Store,
    ) -> Result<serde_json::Value> {
        {
            let state = self
                .state
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            let capability = rho_extension_runtime::CapabilityId::new(contribution_id.to_string())?;
            let kind = state
                .contributions
                .get(&context.project_scope_id, &capability)
                .context("Agent contribution is not published for this project")?
                .contribution
                .kind;
            ensure!(
                matches!(
                    (origin, kind),
                    (
                        ContributionInvocationOrigin::AgentTool,
                        ContributionKind::Tool
                    ) | (
                        ContributionInvocationOrigin::TrustedSource,
                        ContributionKind::Source
                    ) | (
                        ContributionInvocationOrigin::UserCommand,
                        ContributionKind::Command
                    ) | (
                        ContributionInvocationOrigin::TrustedViewer,
                        ContributionKind::Viewer
                    ) | (
                        ContributionInvocationOrigin::TrustedPanel,
                        ContributionKind::Panel
                    ) | (
                        ContributionInvocationOrigin::TrustedSurface,
                        ContributionKind::Surface
                    ) | (
                        ContributionInvocationOrigin::TrustedCheckRule,
                        ContributionKind::CheckRule
                    )
                ),
                "contribution kind does not match its trusted invocation origin"
            );
        }
        let (mut call, mut step) =
            self.begin_contribution_call(context, contribution_id, origin, input)?;
        let mut permission_event_ids = Vec::new();
        loop {
            match step {
                GuestStep::Complete { .. } | GuestStep::Error { .. } => {
                    let outcome = self.finish_contribution_call(context, &mut call, &step)?;
                    let mut value = serde_json::to_value(outcome)?;
                    value["provenance"]["permission_event_ids"] =
                        serde_json::to_value(permission_event_ids)?;
                    return Ok(value);
                }
                GuestStep::BrokerRequest {
                    handle_id,
                    permission,
                    operation,
                    args,
                    ..
                } => {
                    if permission != "project.fs.read" || operation != "project.fs.read" {
                        step = self.resume_contribution_call(
                            context,
                            &mut call,
                            &serde_json::json!({
                                "ok": false,
                                "error": {"code": "operation_not_available"}
                            }),
                            0,
                        )?;
                        continue;
                    }
                    let file_request: ProjectFsReadRequest = match serde_json::from_value(args) {
                        Ok(request) => request,
                        Err(_) => {
                            step = self.resume_contribution_call(
                                context,
                                &mut call,
                                &serde_json::json!({
                                    "ok": false,
                                    "error": {"code": "invalid_arguments"}
                                }),
                                0,
                            )?;
                            continue;
                        }
                    };
                    let key =
                        registry_key(&context.project_root, call.identity().plugin_id.as_str());
                    let (revalidation, grant_id, plugin_id, package_digest, admitted) = {
                        let mut state = self
                            .state
                            .lock()
                            .unwrap_or_else(std::sync::PoisonError::into_inner);
                        let active = state
                            .active
                            .get(&key)
                            .context("contribution host disappeared before file admission")?;
                        let identity = active.host.identity().clone();
                        let revalidation = RevalidationRequest {
                            handle_id: handle_id.clone(),
                            plugin_id: identity.plugin_id().clone(),
                            host_instance_id: identity.host_instance_id().clone(),
                            package_digest: identity.package_digest().clone(),
                            project_id: identity.project_id().clone(),
                            scope_id: identity.project_id().clone(),
                            generation: identity.activation_generation(),
                            permission: PermissionKind::ProjectFsRead,
                            permission_use: PermissionUse::ProjectFsRead {
                                relative_path: file_request.project_relative_path.clone(),
                                requested_bytes: file_request.max_bytes,
                            },
                            workspace: None,
                        };
                        let admitted = state.grants.revalidate(revalidation.clone());
                        let grant_id = state
                            .grants
                            .durable_grant_id_for_handle(&handle_id)
                            .map(str::to_string);
                        (
                            revalidation,
                            grant_id,
                            identity.plugin_id().to_string(),
                            identity.package_digest().to_string(),
                            admitted,
                        )
                    };
                    if let Revalidation::Denied(error) = admitted {
                        permission_event_ids.push(record_call_event(
                            store,
                            context,
                            &plugin_id,
                            &package_digest,
                            None,
                            "call_denied",
                            "failed",
                            Some(grant_error_code(error)),
                            serde_json::json!({
                                "operation": "project.fs.read",
                                "contribution": contribution_id
                            }),
                            false,
                        )?);
                        self.cancel_contribution_call(context, &mut call);
                        bail!(
                            "plugin contribution permission was denied: {}",
                            grant_error_code(error)
                        );
                    }
                    let grant_id = grant_id
                        .context("admitted contribution handle has no durable grant identity")?;
                    match record_call_event(
                        store,
                        context,
                        &plugin_id,
                        &package_digest,
                        Some(&grant_id),
                        "call_admitted",
                        "completed",
                        None,
                        serde_json::json!({
                            "operation": "project.fs.read",
                            "contribution": contribution_id
                        }),
                        false,
                    ) {
                        Ok(event_id) => permission_event_ids.push(event_id),
                        Err(error) => {
                            self.release_plugin_admission(&handle_id);
                            self.cancel_contribution_call(context, &mut call);
                            return Err(error);
                        }
                    }
                    let started = Instant::now();
                    let file_result = match read_project_file(
                        Path::new(&context.project_root),
                        u64::try_from(context.project_revision)
                            .context("current project revision is negative")?,
                        &file_request,
                    ) {
                        Ok(result) => result,
                        Err(error) => {
                            let code = project_file_error_code(error.code);
                            let event = record_call_event(
                                store,
                                context,
                                &plugin_id,
                                &package_digest,
                                Some(&grant_id),
                                "call_failed",
                                "failed",
                                Some(code),
                                serde_json::json!({
                                    "durationMs": started.elapsed().as_millis().min(u64::MAX as u128) as u64,
                                    "operation": "project.fs.read",
                                    "contribution": contribution_id
                                }),
                                false,
                            );
                            self.release_plugin_admission(&handle_id);
                            permission_event_ids.push(event?);
                            step = self.resume_contribution_call(
                                context,
                                &mut call,
                                &serde_json::json!({"ok": false, "error": {"code": code}}),
                                0,
                            )?;
                            continue;
                        }
                    };
                    let still_admitted = {
                        let state = self
                            .state
                            .lock()
                            .unwrap_or_else(std::sync::PoisonError::into_inner);
                        state.active.get(&key).is_some_and(|active| {
                            active.host.identity().host_instance_id()
                                == &revalidation.host_instance_id
                        }) && state.grants.revalidate_admitted(&revalidation)
                            == Revalidation::Allowed
                    };
                    if !still_admitted {
                        permission_event_ids.push(record_call_event(
                            store,
                            context,
                            &plugin_id,
                            &package_digest,
                            None,
                            "call_denied",
                            "stale",
                            Some("stale_after_dispatch"),
                            serde_json::json!({
                                "operation": "project.fs.read",
                                "contribution": contribution_id
                            }),
                            false,
                        )?);
                        self.release_plugin_admission(&handle_id);
                        self.cancel_contribution_call(context, &mut call);
                        bail!("plugin contribution became stale after file dispatch");
                    }
                    let completion_event = record_call_event(
                        store,
                        context,
                        &plugin_id,
                        &package_digest,
                        Some(&grant_id),
                        "call_completed",
                        "completed",
                        None,
                        serde_json::json!({
                            "durationMs": started.elapsed().as_millis().min(u64::MAX as u128) as u64,
                            "operation": "project.fs.read",
                            "sizeBytes": file_result.size_bytes,
                            "contribution": contribution_id
                        }),
                        true,
                    );
                    let completion_event = match completion_event {
                        Ok(event_id) => event_id,
                        Err(error) => {
                            self.release_plugin_admission(&handle_id);
                            self.cancel_contribution_call(context, &mut call);
                            return Err(error);
                        }
                    };
                    permission_event_ids.push(completion_event);
                    {
                        let mut state = self
                            .state
                            .lock()
                            .unwrap_or_else(std::sync::PoisonError::into_inner);
                        if state.grants.revalidate_admitted(&revalidation) != Revalidation::Allowed
                        {
                            state.grants.complete_uncertain(&handle_id);
                            drop(state);
                            self.cancel_contribution_call(context, &mut call);
                            bail!(
                                "plugin contribution grant became stale after durable completion"
                            );
                        }
                        state.grants.complete_success(&handle_id);
                    }
                    let result_value = serde_json::to_value(&file_result)?;
                    let resumed = self.resume_contribution_call(
                        context,
                        &mut call,
                        &serde_json::json!({"ok": true, "value": result_value}),
                        file_result.size_bytes as usize,
                    );
                    step = match resumed {
                        Ok(step) => step,
                        Err(error) => {
                            record_call_event(
                                store,
                                context,
                                &plugin_id,
                                &package_digest,
                                None,
                                "call_failed",
                                "failed",
                                Some("guest_resume_failed"),
                                serde_json::json!({
                                    "operation": "project.fs.read",
                                    "contribution": contribution_id
                                }),
                                false,
                            )?;
                            return Err(error);
                        }
                    };
                }
            }
        }
    }

    fn cancel_contribution_call(
        &self,
        context: &PluginRuntimeContext,
        session: &mut ContributionCallSession,
    ) {
        let key = registry_key(&context.project_root, session.identity().plugin_id.as_str());
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if let Some(active) = state.active.get_mut(&key) {
            let _ = session.cancel(&mut active.host);
        }
    }

    pub(crate) fn invalidate_project(&self, project_root: &str) -> usize {
        let project_root = normalize_project_root(project_root);
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let invalidated = state.grants.invalidate_project(&project_root);
        let prefix = format!("{project_root}\0");
        let active_keys = state
            .active
            .keys()
            .filter(|key| key.starts_with(&prefix))
            .cloned()
            .collect::<Vec<_>>();
        for key in active_keys {
            remove_active_plugin(&mut state, &key);
        }
        state.pending.retain(|key, _| !key.starts_with(&prefix));
        state.workspace_objects.invalidate_project(&project_root);
        invalidated
    }

    pub(crate) fn quarantine_timed_out_plugin(
        &self,
        context: &PluginRuntimeContext,
        plugin_id: &str,
        store: &mut Store,
    ) -> Result<WorkspacePluginCrashOutcome> {
        let key = registry_key(&context.project_root, plugin_id);
        let identity = self
            .crash_identity(&key)
            .context("timed-out plugin has no active host")?;
        {
            let mut state = self
                .state
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            if let Some(active) = state.active.get_mut(&key) {
                active.host.quarantine_for_timeout();
            }
            remove_active_plugin(&mut state, &key);
        }
        PluginLifecycleMutationService::new(store)
            .record_crash(
                &context.project_root,
                &identity.plugin_id,
                &identity.package_digest,
                identity.host_instance_id.as_str(),
                "heartbeat_timeout",
            )
            .map_err(Into::into)
    }

    pub(crate) fn sweep_project_heartbeats(
        &self,
        context: &PluginRuntimeContext,
        store: &mut Store,
    ) -> WorkspacePluginHeartbeatReport {
        let prefix = format!("{}\0", normalize_project_root(&context.project_root));
        let mut failed = Vec::new();
        let checked = {
            let mut state = self
                .state
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            let keys = state
                .active
                .keys()
                .filter(|key| key.starts_with(&prefix))
                .cloned()
                .collect::<Vec<_>>();
            for key in &keys {
                let unhealthy = if let Some(active) = state.active.get_mut(key) {
                    let identity = active.host.identity().clone();
                    !matches!(
                        active.host.handle_frame(HostFrame {
                            instance_id: identity.host_instance_id().clone(),
                            message: HostMessage::Heartbeat,
                        }),
                        Ok(Some(HostResponse::HeartbeatAck))
                    )
                } else {
                    false
                };
                if unhealthy && let Some(active) = state.active.get(key) {
                    failed.push((
                        key.clone(),
                        ActiveCrashIdentity {
                            plugin_id: active.host.identity().plugin_id().to_string(),
                            package_digest: active.package_digest.clone(),
                            host_instance_id: active.host_instance_id.clone(),
                        },
                    ));
                }
            }
            for (key, _) in &failed {
                remove_active_plugin(&mut state, key);
            }
            keys.len()
        };
        let mut report = WorkspacePluginHeartbeatReport {
            project_root: context.project_root.clone(),
            checked,
            crashed: 0,
            blocked: 0,
            failures: 0,
        };
        for (_, identity) in failed {
            match PluginLifecycleMutationService::new(store).record_crash(
                &context.project_root,
                &identity.plugin_id,
                &identity.package_digest,
                identity.host_instance_id.as_str(),
                "heartbeat_failed",
            ) {
                Ok(crash) if crash.outcome == PluginLifecycleMutationOutcome::Applied => {
                    if crash.blocked {
                        report.blocked += 1;
                    } else {
                        report.crashed += 1;
                    }
                }
                Ok(_) => report.failures += 1,
                Err(_) => {
                    report.failures += 1;
                    if let Ok(Some(lifecycle)) = PluginLifecycleQueryService::new(store)
                        .get_state(&context.project_root, &identity.plugin_id)
                    {
                        let _ = persist_recovery_block(
                            store,
                            context,
                            &lifecycle,
                            "heartbeat_persistence_failed",
                        );
                    }
                }
            }
        }
        report
    }

    fn crash_identity(&self, key: &str) -> Option<ActiveCrashIdentity> {
        let state = self
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        state.active.get(key).map(|active| ActiveCrashIdentity {
            plugin_id: active.host.identity().plugin_id().to_string(),
            package_digest: active.package_digest.clone(),
            host_instance_id: active.host_instance_id.clone(),
        })
    }

    fn persist_crash_if_needed(
        &self,
        context: &PluginRuntimeContext,
        key: &str,
        identity: &ActiveCrashIdentity,
        reason_code: &str,
        store: &mut Store,
    ) -> Result<bool> {
        {
            let mut state = self
                .state
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            let exact = state.active.get(key).is_some_and(|active| {
                active.host_instance_id == identity.host_instance_id
                    && active.package_digest == identity.package_digest
            });
            if exact {
                let quarantined = state
                    .active
                    .get(key)
                    .is_some_and(|active| active.host.state() == HostInstanceState::Quarantined);
                if !quarantined {
                    return Ok(false);
                }
                remove_active_plugin(&mut state, key);
            }
        }
        let crash = PluginLifecycleMutationService::new(store).record_crash(
            &context.project_root,
            &identity.plugin_id,
            &identity.package_digest,
            identity.host_instance_id.as_str(),
            reason_code,
        );
        match crash {
            Ok(crash) => Ok(crash.outcome == PluginLifecycleMutationOutcome::Applied),
            Err(error) => {
                if let Ok(Some(lifecycle)) = PluginLifecycleQueryService::new(store)
                    .get_state(&context.project_root, &identity.plugin_id)
                {
                    let _ = persist_recovery_block(
                        store,
                        context,
                        &lifecycle,
                        "crash_persistence_failed",
                    );
                }
                Err(error.into())
            }
        }
    }
}
