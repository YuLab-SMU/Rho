use super::*;

impl PendingPluginPermissionRegistry {
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
        store: &mut Store<impl StoreConnection>,
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
        store: &mut Store<impl StoreConnection>,
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
}
