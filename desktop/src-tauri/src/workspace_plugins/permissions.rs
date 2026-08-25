use super::*;

impl PendingPluginPermissionRegistry {
    pub(crate) fn respond(
        &self,
        context: &PluginRuntimeContext,
        input: PluginPermissionDecisionInput,
        store: &mut Store<impl StoreConnection>,
    ) -> Result<PluginPermissionDecisionResult> {
        ensure!(
            input.expected_project_revision == context.project_revision,
            "plugin permission response is stale for the current project revision"
        );
        let request = PluginPermissionQueryService::new(store)
            .get_request(&context.project_root, &input.request_id)?
            .context("plugin permission request was not found in the current project")?;
        ensure!(
            request.expected_project_revision == context.project_revision,
            "plugin permission request belongs to a stale project revision"
        );
        let decision = match input.decision.as_str() {
            "deny" => PluginPermissionDecision::Deny,
            "allow_once" => PluginPermissionDecision::AllowOnce,
            "allow_project" => PluginPermissionDecision::AllowProject,
            _ => bail!("unsupported plugin permission decision"),
        };
        let (grant_id, policy_revision, expires_at) = match decision {
            PluginPermissionDecision::Deny => (None, None, None),
            PluginPermissionDecision::AllowOnce => (
                Some(format!("grant.{}", uuid::Uuid::new_v4().simple())),
                Some(POLICY_REVISION),
                Some((Utc::now() + ChronoDuration::minutes(5)).to_rfc3339()),
            ),
            PluginPermissionDecision::AllowProject => (
                Some(format!("grant.{}", uuid::Uuid::new_v4().simple())),
                Some(POLICY_REVISION),
                Some((Utc::now() + ChronoDuration::days(30)).to_rfc3339()),
            ),
        };
        let outcome = PluginPermissionMutationService::new(store).resolve_request(
            &context.project_root,
            &PluginPermissionDecisionDraft {
                request_id: input.request_id.clone(),
                project_root: context.project_root.clone(),
                expected_project_revision: input.expected_project_revision,
                decision,
                reason_code: (decision == PluginPermissionDecision::Deny)
                    .then(|| "user_denied".to_string()),
                grant_id,
                policy_revision,
                expires_at,
            },
        )?;
        ensure!(
            matches!(
                outcome,
                PluginPermissionMutationOutcome::Applied
                    | PluginPermissionMutationOutcome::Unchanged
            ),
            "plugin permission response was rejected as stale"
        );
        let resolved = PluginPermissionQueryService::new(store)
            .get_request(&context.project_root, &input.request_id)?
            .context("resolved plugin permission request disappeared")?;

        let mut state = self
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let (plugin_status, active_grant_count, message) = match try_activate_pending(
            &mut state,
            context,
            &request.plugin_id,
            store,
        ) {
            Ok((status, count)) => (status, count, None),
            Err(error) => {
                let changed = error
                    .to_string()
                    .contains("package changed while permission review was open");
                state
                    .pending
                    .remove(&registry_key(&context.project_root, &request.plugin_id));
                (
                        if changed {
                            "stale_digest"
                        } else {
                            "host_unavailable"
                        }
                        .to_string(),
                        0,
                        Some(
                            if changed {
                                "The package changed after review. The recorded decision cannot authorize the new package; enable it again to review the new digest."
                            } else {
                                "The decision was saved, but the isolated plugin host did not start. No live handle is available."
                            }
                            .to_string(),
                        ),
                    )
            }
        };
        Ok(PluginPermissionDecisionResult {
            outcome,
            request: resolved,
            plugin_status,
            active_grant_count,
            message,
        })
    }

    pub(crate) fn list_grants(
        &self,
        context: &PluginRuntimeContext,
        store: &Store<impl StoreConnection>,
    ) -> Result<PluginGrantList> {
        let grants = PluginPermissionQueryService::new(store).list_grants(
            &context.project_root,
            Some(100),
            None,
        )?;
        let state = self
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        Ok(PluginGrantList {
            project_root: context.project_root.clone(),
            grants: grants
                .into_iter()
                .map(|grant| grant_view(grant, &state.grants))
                .collect::<Result<Vec<_>>>()?,
        })
    }

    pub(crate) fn revoke(
        &self,
        context: &PluginRuntimeContext,
        grant_id: &str,
        store: &mut Store<impl StoreConnection>,
    ) -> Result<PluginGrantRevokeResult> {
        let outcome = PluginPermissionMutationService::new(store).revoke_grant(
            &context.project_root,
            grant_id,
            "user_revoked",
        )?;
        ensure!(
            outcome != PluginPermissionMutationOutcome::Stale,
            "plugin grant revoke was rejected as stale"
        );
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let live_handle_revoked = state.grants.revoke_durable_grant(grant_id);
        for active in state.active.values_mut() {
            active.handles.remove(grant_id);
        }
        Ok(PluginGrantRevokeResult {
            outcome,
            grant_id: grant_id.to_string(),
            live_handle_revoked,
        })
    }
}
