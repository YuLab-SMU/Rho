fn smoke_wasm_plugin_host(store_path: &Path, project_root: &Path) -> Result<Value> {
    use rho_extension_runtime::{
        ActivationGeneration, BrokerCallIdSource, CapabilityId, ContributionCallOutcome,
        ContributionCallRequest, ContributionCallSession, ContributionClock, ContributionError,
        ContributionInstanceIdentity, ContributionInvocationOrigin, ContributionStore,
        GrantRequest, GrantSource, GrantStore, GuestStep, HostFrame, HostInstanceId,
        HostInstanceState, HostMessage, HostProtocolErrorCode, HostRequestId, HostResponse,
        P2_1_SMOKE_WASM, P2_1_WASI_IMPORT_SMOKE_WASM, P2_2_SMOKE_WASM, PackageDigest,
        PermissionConstraints, PermissionKind, PluginId, PluginVersion, RuntimeKind, ScopeId,
        ViewerDocumentV1, WasmHostIdentity, WasmPluginHost, WorkspacePluginManifest,
    };
    use rho_store::{
        PluginLifecycleMutationService, PluginLifecycleQueryService, PluginPermissionDecision,
        PluginPermissionDecisionDraft, PluginPermissionMutationOutcome,
        PluginPermissionMutationService, PluginPermissionQueryService,
        PluginPermissionRequestDraft,
    };

    #[derive(Debug)]
    struct SmokeCallId;
    impl BrokerCallIdSource for SmokeCallId {
        fn next_call_id(&self) -> u64 {
            42
        }
    }

    #[derive(Debug)]
    struct SmokeClock;
    impl ContributionClock for SmokeClock {
        fn now_millis(&self) -> u64 {
            100
        }
    }

    let identity = WasmHostIdentity::new(
        ScopeId::new("project.installed-smoke")?,
        PluginId::new("org.yulab.rho.phase2-smoke")?,
        PackageDigest::from_inventory(&[(b"dist/plugin.wasm", P2_1_SMOKE_WASM)]),
        ActivationGeneration::new(1)?,
        HostInstanceId::generate(),
    );
    let mut host = WasmPluginHost::from_bytes(identity, P2_1_SMOKE_WASM)
        .map_err(|error| anyhow!("creating installed P2-1 Wasm host: {error:?}"))?;
    let make_frame = |host: &WasmPluginHost, message| HostFrame {
        instance_id: host.identity().host_instance_id().clone(),
        message,
    };
    ensure!(
        host.handle_frame(make_frame(
            &host,
            HostMessage::Hello {
                api_version: rho_extension_runtime::HOST_PROTOCOL_VERSION,
            },
        ))
        .map_err(|error| anyhow!("negotiating installed P2-1 Wasm host: {error:?}"))?
            == Some(HostResponse::Ready {
                api_version: rho_extension_runtime::HOST_PROTOCOL_VERSION,
            }),
        "installed P2-1 Wasm host did not negotiate V1"
    );
    ensure!(
        host.handle_frame(make_frame(&host, HostMessage::Activate))
            .map_err(|error| anyhow!("activating installed P2-1 Wasm host: {error:?}"))?
            == Some(HostResponse::Activated),
        "installed P2-1 Wasm host did not activate"
    );
    let request_id = HostRequestId::new("request.installed-smoke")?;
    ensure!(
        host.handle_frame(make_frame(
            &host,
            HostMessage::Echo {
                request_id: request_id.clone(),
                payload: "Rho P2 Wasm".to_string(),
            },
        ))
        .map_err(|error| anyhow!("calling installed P2-1 Wasm host: {error:?}"))?
            == Some(HostResponse::EchoResult {
                request_id,
                payload: "Rho P2 Wasm".to_string(),
            }),
        "installed P2-1 Wasm host echo diverged"
    );
    ensure!(
        host.handle_frame(make_frame(&host, HostMessage::Heartbeat))
            .map_err(|error| anyhow!("heartbeating installed P2-1 Wasm host: {error:?}"))?
            == Some(HostResponse::HeartbeatAck),
        "installed P2-1 Wasm host heartbeat failed"
    );
    ensure!(
        host.handle_frame(make_frame(&host, HostMessage::Quiesce))
            .map_err(|error| anyhow!("quiescing installed P2-1 Wasm host: {error:?}"))?
            == Some(HostResponse::Quiesced),
        "installed P2-1 Wasm host did not quiesce"
    );
    ensure!(
        host.handle_frame(make_frame(&host, HostMessage::Dispose))
            .map_err(|error| anyhow!("disposing installed P2-1 Wasm host: {error:?}"))?
            == Some(HostResponse::Disposed)
            && host.state() == HostInstanceState::Disposed,
        "installed P2-1 Wasm host did not dispose"
    );

    let forbidden_identity = WasmHostIdentity::new(
        ScopeId::new("project.installed-smoke")?,
        PluginId::new("org.yulab.rho.phase2-wasi-probe")?,
        PackageDigest::from_inventory(&[(b"dist/plugin.wasm", P2_1_WASI_IMPORT_SMOKE_WASM)]),
        ActivationGeneration::new(1)?,
        HostInstanceId::generate(),
    );
    let wasi_error = WasmPluginHost::from_bytes(forbidden_identity, P2_1_WASI_IMPORT_SMOKE_WASM)
        .expect_err("installed P2-1 Wasm host accepted a WASI import");
    ensure!(
        wasi_error.code == HostProtocolErrorCode::ForbiddenImport,
        "installed P2-1 Wasm host rejected WASI with the wrong error"
    );

    let v2_host_instance = HostInstanceId::generate();
    let v2_identity = WasmHostIdentity::new(
        ScopeId::new("project.installed-smoke")?,
        PluginId::new("org.yulab.rho.phase2-v2-smoke")?,
        PackageDigest::from_inventory(&[(b"dist/plugin.wasm", P2_2_SMOKE_WASM)]),
        ActivationGeneration::new(2)?,
        v2_host_instance.clone(),
    );
    let mut v2_host = WasmPluginHost::from_bytes_with_call_id_source(
        v2_identity,
        P2_2_SMOKE_WASM,
        Arc::new(SmokeCallId),
    )
    .map_err(|error| anyhow!("creating installed P2-2 Wasm host: {error:?}"))?;
    ensure!(
        v2_host.guest_abi_version() == 2,
        "installed P2-2 ABI is not V2"
    );
    ensure!(
        v2_host
            .handle_frame(HostFrame {
                instance_id: v2_host_instance.clone(),
                message: HostMessage::Hello {
                    api_version: rho_extension_runtime::HOST_PROTOCOL_VERSION,
                },
            })
            .map_err(|error| anyhow!("negotiating installed P2-2 Wasm host: {error:?}"))?
            == Some(HostResponse::Ready {
                api_version: rho_extension_runtime::HOST_PROTOCOL_VERSION,
            }),
        "installed P2-2 Wasm host negotiation failed"
    );
    ensure!(
        v2_host
            .handle_frame(HostFrame {
                instance_id: v2_host_instance.clone(),
                message: HostMessage::Activate,
            })
            .map_err(|error| anyhow!("activating installed P2-2 Wasm host: {error:?}"))?
            == Some(HostResponse::Activated),
        "installed P2-2 Wasm host activation failed"
    );
    let v2_request = HostRequestId::new("request.installed-v2-smoke")?;
    let yielded = v2_host
        .begin_broker_call(v2_request.clone(), json!({"smoke": true}))
        .map_err(|error| anyhow!("yielding installed P2-2 broker call: {error:?}"))?;
    ensure!(
        matches!(yielded, GuestStep::BrokerRequest { .. })
            && !format!("{yielded:?}").contains("handle."),
        "installed P2-2 broker yield was not typed and redacted"
    );
    ensure!(
        matches!(
            v2_host
                .resume_broker_call(&v2_request, &json!({"ok": false}), 0)
                .map_err(|error| anyhow!("resuming installed P2-2 broker call: {error:?}"))?,
            GuestStep::Complete { .. }
        ),
        "installed P2-2 broker resume did not complete"
    );

    let now_millis = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0);
    let constraints = PermissionConstraints {
        paths: vec!["data/**/*.csv".to_string()],
        max_bytes: Some(1024),
        ..Default::default()
    };
    let mut grants = GrantStore::new();
    let handle = grants.grant(GrantRequest {
        durable_grant_id: "grant.installed-smoke".to_string(),
        normalized_project_root: "/tmp/rho-installed-smoke".to_string(),
        plugin_id: PluginId::new("org.yulab.rho.phase2-v2-smoke")?,
        plugin_version: PluginVersion::parse("1.0.0")?,
        runtime_kind: RuntimeKind::Wasm,
        host_instance_id: v2_host_instance,
        package_digest: PackageDigest::from_inventory(&[(b"dist/plugin.wasm", P2_2_SMOKE_WASM)]),
        project_id: ScopeId::new("project.installed-smoke")?,
        scope_id: ScopeId::new("project.installed-smoke")?,
        activation_generation: ActivationGeneration::new(2)?,
        permission: PermissionKind::ProjectFsRead,
        constraints_digest: constraints.digest()?,
        constraints,
        grant_source: GrantSource::Project,
        policy_revision: 1,
        workspace: None,
        expires_at_millis: now_millis + 60_000,
    })?;
    ensure!(
        handle.id.len() == "handle.".len() + 64 && !format!("{handle:?}").contains(&handle.id),
        "installed P2-2 handle is not 256-bit and redacted"
    );
    ensure!(
        grants.revoke_durable_grant("grant.installed-smoke")
            && !grants.has_live_durable_grant("grant.installed-smoke"),
        "installed P2-2 revoke did not remove live authority"
    );

    let normalized_project_root = normalize_project_root(project_root.to_string_lossy().as_ref());
    let package_digest = PackageDigest::from_inventory(&[(b"dist/plugin.wasm", P2_2_SMOKE_WASM)]);
    let persisted_constraints = PermissionConstraints {
        paths: vec!["data/**/*.csv".to_string()],
        max_bytes: Some(1024),
        ..Default::default()
    };
    let constraints_json = persisted_constraints.canonical_json()?;
    let constraints_digest = persisted_constraints.digest()?;
    let mut persisted = Store::open(store_path)?;
    PluginPermissionMutationService::new(&mut persisted).create_request(
        &normalized_project_root,
        &PluginPermissionRequestDraft {
            request_id: "request.installed-smoke".to_string(),
            project_root: normalized_project_root.clone(),
            plugin_id: "org.yulab.rho.phase2-v2-smoke".to_string(),
            plugin_version: "1.0.0".to_string(),
            package_digest: package_digest.to_string(),
            runtime_kind: "wasm".to_string(),
            permission: "project.fs.read".to_string(),
            constraints_json,
            constraints_digest,
            purpose_text: Some("Installed P2-2 smoke".to_string()),
            expected_project_revision: 1,
        },
    )?;
    let durable_grant_id = "grant.persisted-installed-smoke";
    let decision = PluginPermissionMutationService::new(&mut persisted).resolve_request(
        &normalized_project_root,
        &PluginPermissionDecisionDraft {
            request_id: "request.installed-smoke".to_string(),
            project_root: normalized_project_root.clone(),
            expected_project_revision: 1,
            decision: PluginPermissionDecision::AllowOnce,
            reason_code: None,
            grant_id: Some(durable_grant_id.to_string()),
            policy_revision: Some(1),
            expires_at: Some((chrono::Utc::now() + chrono::Duration::minutes(4)).to_rfc3339()),
        },
    )?;
    ensure!(
        decision == PluginPermissionMutationOutcome::Applied,
        "installed P2-2 durable grant decision was not applied"
    );
    ensure!(
        PluginPermissionMutationService::new(&mut persisted).revoke_grant(
            &normalized_project_root,
            durable_grant_id,
            "installed_smoke_revoke",
        )? == PluginPermissionMutationOutcome::Applied,
        "installed P2-2 durable revoke was not applied"
    );
    let persisted_events = PluginPermissionQueryService::new(&persisted)
        .list_events(&normalized_project_root, Some(20))?;
    ensure!(
        persisted_events
            .iter()
            .any(|event| event.event_type == "request_granted")
            && persisted_events
                .iter()
                .any(|event| event.event_type == "grant_revoked"),
        "installed P2-2 durable audit events are incomplete"
    );
    ensure!(
        !serde_json::to_string(&persisted_events)?.contains("handle."),
        "installed P2-2 durable audit exposed a raw handle"
    );

    let empty_schema = json!({"type": "object", "properties": {}});
    let manifest = WorkspacePluginManifest::parse(&serde_json::to_vec(&json!({
        "schemaVersion": 2,
        "id": "org.yulab.rho.phase2-contribution-smoke",
        "name": "Installed contribution smoke",
        "version": "1.0.0",
        "apiVersion": "^1.0",
        "runtime": {"kind": "wasm", "entry": "dist/plugin.wasm", "scope": "project"},
        "provides": [
            {"capability": "tool.installed.smoke", "contract_major": 1},
            {"capability": "ui.panel.installed_smoke", "contract_major": 1}
        ],
        "contributions": [
            {
                "id": "tool.installed.smoke", "kind": "tool", "contractMajor": 1,
                "label": "Installed smoke", "purpose": "Exercise the packaged contribution proxy",
                "inputSchema": empty_schema,
                "outputSchema": {
                    "type": "object",
                    "properties": {"smoke": {"type": "boolean"}},
                    "required": ["smoke"]
                }
            },
            {
                "id": "ui.panel.installed_smoke", "kind": "panel", "contractMajor": 1,
                "label": "Installed details", "purpose": "Exercise the named project Panel",
                "inputSchema": empty_schema, "outputSchema": empty_schema,
                "panelSlot": "plugin_details"
            }
        ]
    }))?)?;
    let p23_project = ScopeId::new("project.installed-contribution-smoke")?;
    let p23_plugin = manifest.id.clone();
    let p23_digest = PackageDigest::from_inventory(&[(b"dist/plugin.wasm", P2_2_SMOKE_WASM)]);
    let p23_host_id = HostInstanceId::new("instance.installed-contribution-smoke")?;
    let p23_generation = ActivationGeneration::new(3)?;
    let p23_identity = ContributionInstanceIdentity::new(
        p23_project.clone(),
        p23_plugin.clone(),
        p23_digest.clone(),
        p23_generation,
        p23_host_id.clone(),
    );
    let candidate = ContributionStore::stage(p23_identity.clone(), manifest.contributions.clone())
        .map_err(|error| anyhow!("staging installed P2-3 contributions: {error:?}"))?;
    let mut contribution_store = ContributionStore::new();
    contribution_store
        .publish(candidate, None)
        .map_err(|error| anyhow!("publishing installed P2-3 contributions: {error:?}"))?;
    ensure!(
        contribution_store.list(&p23_project).len() == 2,
        "installed P2-3 contribution publication is incomplete"
    );
    let stale_candidate = ContributionStore::stage(
        ContributionInstanceIdentity::new(
            p23_project.clone(),
            p23_plugin.clone(),
            p23_digest.clone(),
            ActivationGeneration::new(4)?,
            HostInstanceId::new("instance.installed-stale-candidate")?,
        ),
        manifest.contributions.clone(),
    )
    .map_err(|error| anyhow!("staging installed stale P2-3 candidate: {error:?}"))?;
    ensure!(
        contribution_store.publish(stale_candidate, None)
            == Err(ContributionError::ExpectedOldMismatch),
        "installed P2-3 expected-old CAS accepted a stale candidate"
    );
    let mut p23_host = WasmPluginHost::from_bytes_with_call_id_source(
        WasmHostIdentity::new(
            p23_project.clone(),
            p23_plugin,
            p23_digest,
            p23_generation,
            p23_host_id.clone(),
        ),
        P2_2_SMOKE_WASM,
        Arc::new(SmokeCallId),
    )
    .map_err(|error| anyhow!("creating installed P2-3 Wasm host: {error:?}"))?;
    ensure!(
        matches!(
            p23_host.handle_frame(HostFrame {
                instance_id: p23_host_id.clone(),
                message: HostMessage::Hello {
                    api_version: rho_extension_runtime::HOST_PROTOCOL_VERSION
                }
            }),
            Ok(Some(HostResponse::Ready { .. }))
        ) && matches!(
            p23_host.handle_frame(HostFrame {
                instance_id: p23_host_id,
                message: HostMessage::Activate
            }),
            Ok(Some(HostResponse::Activated))
        ),
        "installed P2-3 contribution host did not activate"
    );
    let (mut p23_call, p23_first) = ContributionCallSession::begin(
        &contribution_store,
        ContributionCallRequest {
            project_id: p23_project.clone(),
            contribution_id: CapabilityId::new("tool.installed.smoke")?,
            origin: ContributionInvocationOrigin::AgentTool,
            input: json!({}),
            supplied_handles: BTreeMap::from([(
                "project.fs.read".to_string(),
                format!("handle.{}", "a".repeat(64)),
            )]),
        },
        &SmokeClock,
        &mut p23_host,
    )
    .map_err(|error| anyhow!("beginning installed P2-3 contribution call: {error:?}"))?;
    ensure!(
        matches!(p23_first, GuestStep::BrokerRequest { .. }),
        "installed P2-3 contribution did not yield to the broker"
    );
    let p23_terminal = p23_call
        .resume(
            &contribution_store,
            &json!({"ok": true}),
            2,
            &SmokeClock,
            &mut p23_host,
        )
        .map_err(|error| anyhow!("resuming installed P2-3 contribution call: {error:?}"))?;
    let p23_outcome = p23_call
        .finish(
            &contribution_store,
            &p23_terminal,
            &SmokeClock,
            &mut p23_host,
        )
        .map_err(|error| anyhow!("finishing installed P2-3 contribution call: {error:?}"))?;
    ensure!(
        matches!(
            p23_outcome,
            ContributionCallOutcome::Completed { ref result, .. }
                if result == &json!({"smoke": true})
        ),
        "installed P2-3 contribution result failed schema validation"
    );
    let viewer_document = ViewerDocumentV1::parse(json!({
        "contract": rho_extension_runtime::PLUGIN_VIEWER_DOCUMENT_CONTRACT,
        "title": "Installed plugin details",
        "blocks": [{
            "kind": "text",
            "text": "<script>packaged text only</script>"
        }]
    }))?;
    ensure!(
        viewer_document.blocks.len() == 1,
        "installed P2-3 ViewerDocument did not validate"
    );
    contribution_store
        .unpublish(&p23_identity)
        .map_err(|error| anyhow!("tearing down installed P2-3 contributions: {error:?}"))?;
    ensure!(
        contribution_store.list(&p23_project).is_empty(),
        "installed P2-3 contribution teardown left a live route"
    );

    let p24_root = tempfile::tempdir()?;
    let p24_project = p24_root.path().join("project");
    let p24_data = p24_root.path().join("data");
    let p24_plugin = p24_project.join(".rho/plugins/installed-smoke");
    std::fs::create_dir_all(p24_plugin.join("dist"))?;
    std::fs::create_dir_all(&p24_data)?;
    std::fs::write(p24_plugin.join("dist/plugin.wasm"), P2_1_SMOKE_WASM)?;
    std::fs::write(
        p24_plugin.join("rho-plugin.json"),
        serde_json::to_vec(&json!({
            "schemaVersion": 1,
            "id": "org.yulab.rho.phase2-durable-enable-smoke",
            "name": "Durable enable smoke",
            "version": "1.0.0",
            "apiVersion": "^1.0",
            "runtime": {"kind": "wasm", "entry": "dist/plugin.wasm", "scope": "project"}
        }))?,
    )?;
    let p24_project_root =
        normalize_project_root(p24_project.canonicalize()?.to_string_lossy().as_ref());
    let p24_context = crate::workspace_plugins::PluginRuntimeContext {
        app_data_dir: p24_data.clone(),
        project_root: p24_project_root.clone(),
        project_revision: 1,
        project_scope_id: ScopeId::new("project.installed-durable-enable-smoke")?,
        workspace: None,
    };
    let mut p24_store = Store::open(p24_root.path().join("rho.sqlite"))?;
    let p24_registry = crate::workspace_plugins::PendingPluginPermissionRegistry::default();
    let p24_enabled = p24_registry.request_enable(
        &p24_context,
        "org.yulab.rho.phase2-durable-enable-smoke",
        &mut p24_store,
    )?;
    ensure!(
        p24_enabled.status == "enabled" && p24_enabled.transition_id.is_some(),
        "installed P2-4 durable first enable did not complete"
    );
    let p24_state = PluginLifecycleQueryService::new(&p24_store)
        .get_state(
            &p24_project_root,
            "org.yulab.rho.phase2-durable-enable-smoke",
        )?
        .context("installed P2-4 lifecycle state is missing")?;
    ensure!(
        p24_state.desired_state == "enabled"
            && p24_state.observed_state == "active"
            && p24_state.accepted_digest.is_some()
            && p24_state.pending_digest.is_none()
            && p24_state.last_activation_generation == 1,
        "installed P2-4 durable lifecycle truth is incomplete"
    );
    let p24_transition = PluginLifecycleQueryService::new(&p24_store)
        .get_transition(
            &p24_project_root,
            p24_enabled.transition_id.as_deref().unwrap_or_default(),
        )?
        .context("installed P2-4 lifecycle transition is missing")?;
    ensure!(
        p24_transition.phase == "completed" && p24_transition.status == "completed",
        "installed P2-4 transition did not reach durable completion"
    );
    let p24_cached = rho_server::plugin_package_cache::PluginPackageCache::new(&p24_data)
        .load_exact(
            &p24_project_root,
            "org.yulab.rho.phase2-durable-enable-smoke",
            p24_state.accepted_digest.as_deref().unwrap_or_default(),
        )?;
    ensure!(
        p24_cached.file_bytes("dist/plugin.wasm") == Some(P2_1_SMOKE_WASM),
        "installed P2-4 immutable cache read-back diverged"
    );
    drop(p24_registry);
    let p24_restarted = crate::workspace_plugins::PendingPluginPermissionRegistry::default();
    let p24_restart_report = p24_restarted.reconcile_project(&p24_context, &mut p24_store);
    ensure!(
        p24_restart_report.reactivated == 1,
        "installed P2-4 restart did not reconstruct the exact enabled package"
    );
    let p24_restarted_state = PluginLifecycleQueryService::new(&p24_store)
        .get_state(
            &p24_project_root,
            "org.yulab.rho.phase2-durable-enable-smoke",
        )?
        .context("installed P2-4 restarted lifecycle state is missing")?;
    ensure!(
        p24_restarted_state.observed_state == "active"
            && p24_restarted_state.last_activation_generation == 2,
        "installed P2-4 restart reused or lost activation generation"
    );
    let p24_disabled = p24_restarted.disable(
        &p24_context,
        "org.yulab.rho.phase2-durable-enable-smoke",
        &mut p24_store,
    )?;
    ensure!(
        p24_disabled.status == "disabled"
            && p24_disabled.route_closed
            && p24_disabled.host_disposed
            && p24_disabled.errors.is_empty(),
        "installed P2-4 explicit Disable did not complete exact teardown"
    );
    let p24_disabled_state = PluginLifecycleQueryService::new(&p24_store)
        .get_state(
            &p24_project_root,
            "org.yulab.rho.phase2-durable-enable-smoke",
        )?
        .context("installed P2-4 disabled lifecycle state is missing")?;
    ensure!(
        p24_disabled_state.desired_state == "disabled"
            && p24_disabled_state.observed_state == "disabled",
        "installed P2-4 explicit Disable did not persist terminal truth"
    );
    let p24_reenabled = p24_restarted.request_enable(
        &p24_context,
        "org.yulab.rho.phase2-durable-enable-smoke",
        &mut p24_store,
    )?;
    ensure!(
        p24_reenabled.status == "enabled",
        "installed P2-4 exact package could not re-enable after Disable"
    );
    let p24_boundary = p24_restarted.teardown_project(&p24_context, "shutdown", &mut p24_store);
    ensure!(
        p24_boundary.attempted == 1 && p24_boundary.completed == 1 && p24_boundary.forced == 0,
        "installed P2-4 shutdown boundary did not reuse exact teardown"
    );
    let p24_stopped_state = PluginLifecycleQueryService::new(&p24_store)
        .get_state(
            &p24_project_root,
            "org.yulab.rho.phase2-durable-enable-smoke",
        )?
        .context("installed P2-4 stopped lifecycle state is missing")?;
    ensure!(
        p24_stopped_state.desired_state == "enabled"
            && p24_stopped_state.observed_state == "stopped",
        "installed P2-4 boundary teardown lost enabled intent or stopped truth"
    );
    let p24_boundary_reactivation = p24_restarted.reconcile_project(&p24_context, &mut p24_store);
    ensure!(
        p24_boundary_reactivation.reactivated == 1,
        "installed P2-4 stopped boundary did not reconstruct exactly"
    );
    for expected_crash_count in 1..=3 {
        let crash = p24_restarted.quarantine_timed_out_plugin(
            &p24_context,
            "org.yulab.rho.phase2-durable-enable-smoke",
            &mut p24_store,
        )?;
        ensure!(
            crash.crash_count == expected_crash_count
                && crash.blocked == (expected_crash_count == 3),
            "installed P2-4 crash loop count/block state diverged"
        );
        if expected_crash_count < 3 {
            ensure!(
                p24_restarted
                    .retry(
                        &p24_context,
                        "org.yulab.rho.phase2-durable-enable-smoke",
                        &mut p24_store,
                    )?
                    .status
                    == "enabled",
                "installed P2-4 Retry did not create fresh authority"
            );
        }
    }
    ensure!(
        p24_restarted
            .retry(
                &p24_context,
                "org.yulab.rho.phase2-durable-enable-smoke",
                &mut p24_store,
            )
            .is_err(),
        "installed P2-4 blocked crash loop accepted Retry"
    );
    ensure!(
        p24_restarted
            .disable(
                &p24_context,
                "org.yulab.rho.phase2-durable-enable-smoke",
                &mut p24_store,
            )?
            .status
            == "disabled",
        "installed P2-4 blocked plugin could not be explicitly disabled"
    );
    ensure!(
        p24_restarted
            .request_enable(
                &p24_context,
                "org.yulab.rho.phase2-durable-enable-smoke",
                &mut p24_store,
            )?
            .status
            == "enabled",
        "installed P2-4 reviewed crash loop could not re-enable exactly"
    );
    let p24_uninstall_state = PluginLifecycleQueryService::new(&p24_store)
        .get_state(
            &p24_project_root,
            "org.yulab.rho.phase2-durable-enable-smoke",
        )?
        .context("installed P2-4 Uninstall state is missing")?;
    let p24_uninstalled = p24_restarted.uninstall(
        &p24_context,
        &crate::workspace_plugins::WorkspacePluginUninstallInput {
            plugin_id: "org.yulab.rho.phase2-durable-enable-smoke".to_string(),
            directory_name: "installed-smoke".to_string(),
            package_digest: p24_uninstall_state
                .accepted_digest
                .clone()
                .context("installed P2-4 Uninstall accepted digest is missing")?,
            expected_project_revision: p24_context.project_revision,
            confirmed: true,
        },
        &mut p24_store,
    )?;
    let p24_uninstalled_state = PluginLifecycleQueryService::new(&p24_store)
        .get_state(
            &p24_project_root,
            "org.yulab.rho.phase2-durable-enable-smoke",
        )?
        .context("installed P2-4 durable Uninstalled state is missing")?;
    let p24_tombstone = PluginLifecycleQueryService::new(&p24_store)
        .get_tombstone(&p24_project_root, &p24_uninstalled.tombstone_id)?
        .context("installed P2-4 recoverable tombstone is missing")?;
    ensure!(
        p24_uninstalled.status == "uninstalled"
            && p24_uninstalled.route_closed
            && p24_uninstalled_state.desired_state == "uninstalled"
            && p24_uninstalled_state.observed_state == "uninstalled"
            && !p24_plugin.exists()
            && p24_tombstone.restored_at.is_none(),
        "installed P2-4 recoverable Uninstall truth diverged"
    );
    let p24_restored = p24_restarted.restore(
        &p24_context,
        &crate::workspace_plugins::WorkspacePluginRestoreInput {
            tombstone_id: p24_uninstalled.tombstone_id.clone(),
            expected_project_revision: p24_context.project_revision,
        },
        &mut p24_store,
    )?;
    let p24_restored_state = PluginLifecycleQueryService::new(&p24_store)
        .get_state(
            &p24_project_root,
            "org.yulab.rho.phase2-durable-enable-smoke",
        )?
        .context("installed P2-4 restored lifecycle state is missing")?;
    ensure!(
        p24_restored.status == "disabled"
            && p24_plugin.is_dir()
            && p24_restored_state.desired_state == "disabled"
            && p24_restored_state.observed_state == "disabled"
            && p24_restored_state.last_host_session_id.is_none()
            && PluginPermissionQueryService::new(&p24_store)
                .list_grants(&p24_project_root, Some(100), Some("active"))?
                .is_empty(),
        "installed P2-4 Restore created authority or non-disabled truth"
    );
    ensure!(
        p24_restarted
            .request_enable(
                &p24_context,
                "org.yulab.rho.phase2-durable-enable-smoke",
                &mut p24_store,
            )?
            .status
            == "enabled",
        "installed P2-4 restored package could not be explicitly re-enabled"
    );
    p24_restarted.invalidate_project(&p24_project_root);
    let p24_manifest_path = p24_plugin.join("rho-plugin.json");
    let p24_original_manifest = std::fs::read(&p24_manifest_path)?;
    let mut p24_changed_manifest: Value = serde_json::from_slice(&p24_original_manifest)?;
    p24_changed_manifest["version"] = json!("2.0.0");
    std::fs::write(
        &p24_manifest_path,
        serde_json::to_vec(&p24_changed_manifest)?,
    )?;
    let p24_changed_report = p24_restarted.reconcile_project(&p24_context, &mut p24_store);
    ensure!(
        p24_changed_report.update_pending == 1,
        "installed P2-4 changed package did not remain update-pending"
    );
    let p24_changed_list = p24_restarted.list(&p24_context, &mut p24_store)?;
    ensure!(
        p24_changed_list
            .plugins
            .iter()
            .any(|plugin| plugin.status == "update_pending"),
        "installed P2-4 trusted projection hid update-pending state"
    );
    let p24_update_project = p24_root.path().join("update-project");
    let p24_update_plugin = p24_update_project.join(".rho/plugins/update-smoke");
    std::fs::create_dir_all(p24_update_plugin.join("dist"))?;
    std::fs::write(p24_update_plugin.join("dist/plugin.wasm"), P2_1_SMOKE_WASM)?;
    let p24_update_manifest = p24_update_plugin.join("rho-plugin.json");
    std::fs::write(
        &p24_update_manifest,
        serde_json::to_vec(&json!({
            "schemaVersion": 1,
            "id": "org.yulab.rho.phase2-update-smoke",
            "name": "Update smoke",
            "version": "1.0.0",
            "apiVersion": "^1.0",
            "runtime": {"kind": "wasm", "entry": "dist/plugin.wasm", "scope": "project"}
        }))?,
    )?;
    let p24_update_root = normalize_project_root(
        p24_update_project
            .canonicalize()?
            .to_string_lossy()
            .as_ref(),
    );
    let p24_update_context = crate::workspace_plugins::PluginRuntimeContext {
        app_data_dir: p24_data.clone(),
        project_root: p24_update_root.clone(),
        project_revision: 1,
        project_scope_id: ScopeId::new("project.installed-update-smoke")?,
        workspace: None,
    };
    let p24_update_registry = crate::workspace_plugins::PendingPluginPermissionRegistry::default();
    ensure!(
        p24_update_registry
            .request_enable(
                &p24_update_context,
                "org.yulab.rho.phase2-update-smoke",
                &mut p24_store,
            )?
            .status
            == "enabled",
        "installed P2-4 Update fixture did not enable"
    );
    let p24_update_old = PluginLifecycleQueryService::new(&p24_store)
        .get_state(&p24_update_root, "org.yulab.rho.phase2-update-smoke")?
        .context("installed P2-4 Update old state is missing")?;
    let p24_update_old_digest = p24_update_old
        .accepted_digest
        .clone()
        .context("installed P2-4 Update old digest is missing")?;
    let mut p24_update_changed: Value =
        serde_json::from_slice(&std::fs::read(&p24_update_manifest)?)?;
    p24_update_changed["version"] = json!("2.0.0");
    std::fs::write(
        &p24_update_manifest,
        serde_json::to_vec(&p24_update_changed)?,
    )?;
    let p24_update_candidate =
        rho_extension_runtime::discover_workspace_plugins(&p24_update_project)?
            .context("installed P2-4 Update candidate discovery is missing")?
            .plugins
            .into_iter()
            .find(|plugin| plugin.manifest.id.as_str() == "org.yulab.rho.phase2-update-smoke")
            .context("installed P2-4 Update candidate is missing")?;
    let p24_updated = p24_update_registry.request_update(
        &p24_update_context,
        &crate::workspace_plugins::WorkspacePluginUpdateInput {
            plugin_id: "org.yulab.rho.phase2-update-smoke".to_string(),
            expected_old_digest: p24_update_old_digest.clone(),
            candidate_digest: p24_update_candidate.digest.to_string(),
            expected_project_revision: p24_update_context.project_revision,
        },
        &mut p24_store,
    )?;
    let p24_updated_state = PluginLifecycleQueryService::new(&p24_store)
        .get_state(&p24_update_root, "org.yulab.rho.phase2-update-smoke")?
        .context("installed P2-4 Update terminal state is missing")?;
    ensure!(
        p24_updated.status == "enabled"
            && p24_updated_state.accepted_digest.as_deref()
                == Some(p24_update_candidate.digest.as_str())
            && p24_updated_state.rollback_digest.as_deref() == Some(p24_update_old_digest.as_str())
            && p24_updated_state.pending_digest.is_none()
            && p24_updated_state.last_activation_generation
                > p24_update_old.last_activation_generation
            && p24_updated_state.last_host_session_id != p24_update_old.last_host_session_id,
        "installed P2-4 exact Update did not commit fresh pointer/runtime truth"
    );
    let p24_rolled_back = p24_update_registry.request_rollback(
        &p24_update_context,
        &crate::workspace_plugins::WorkspacePluginRollbackInput {
            plugin_id: "org.yulab.rho.phase2-update-smoke".to_string(),
            expected_current_digest: p24_update_candidate.digest.to_string(),
            rollback_digest: p24_update_old_digest.clone(),
            expected_project_revision: p24_update_context.project_revision,
        },
        &mut p24_store,
    )?;
    let p24_rollback_state = PluginLifecycleQueryService::new(&p24_store)
        .get_state(&p24_update_root, "org.yulab.rho.phase2-update-smoke")?
        .context("installed P2-4 Rollback terminal state is missing")?;
    ensure!(
        p24_rolled_back.status == "enabled"
            && p24_rollback_state.accepted_digest.as_deref()
                == Some(p24_update_old_digest.as_str())
            && p24_rollback_state.rollback_digest.as_deref()
                == Some(p24_update_candidate.digest.as_str())
            && p24_rollback_state.last_activation_generation
                > p24_updated_state.last_activation_generation
            && p24_rollback_state.last_host_session_id != p24_updated_state.last_host_session_id
            && rho_extension_runtime::discover_workspace_plugins(&p24_update_project)?
                .context("installed Rollback source discovery disappeared")?
                .plugins
                .iter()
                .any(|plugin| plugin.digest == p24_update_candidate.digest),
        "installed P2-4 exact Rollback did not preserve source or fresh pointer truth"
    );
    p24_update_registry.invalidate_project(&p24_update_root);
    let p24_rollback_restart = crate::workspace_plugins::PendingPluginPermissionRegistry::default();
    let p24_rollback_restart_report =
        p24_rollback_restart.reconcile_project(&p24_update_context, &mut p24_store);
    ensure!(
        p24_rollback_restart_report.reactivated == 1,
        "installed P2-4 Rollback restart did not reconstruct accepted cache"
    );
    let p24_rollback_restart_state = PluginLifecycleQueryService::new(&p24_store)
        .get_state(&p24_update_root, "org.yulab.rho.phase2-update-smoke")?
        .context("installed P2-4 Rollback restart state is missing")?;
    ensure!(
        p24_rollback_restart_state.accepted_digest.as_deref()
            == Some(p24_update_old_digest.as_str())
            && p24_rollback_restart_state.rollback_digest.as_deref()
                == Some(p24_update_candidate.digest.as_str())
            && p24_rollback_restart_state.last_activation_generation
                > p24_rollback_state.last_activation_generation
            && p24_rollback_restart
                .list(&p24_update_context, &mut p24_store)?
                .plugins
                .iter()
                .any(|plugin| plugin.status == "update_pending"),
        "installed P2-4 Rollback restart lost accepted cache or Update-pending source truth"
    );
    let p24_recovery_project = p24_root.path().join("recovery-project");
    let p24_recovery_plugin = p24_recovery_project.join(".rho/plugins/recovery-smoke");
    std::fs::create_dir_all(p24_recovery_plugin.join("dist"))?;
    std::fs::write(
        p24_recovery_plugin.join("dist/plugin.wasm"),
        P2_1_SMOKE_WASM,
    )?;
    std::fs::write(
        p24_recovery_plugin.join("rho-plugin.json"),
        serde_json::to_vec(&json!({
            "schemaVersion": 1,
            "id": "org.yulab.rho.phase2-recovery-smoke",
            "name": "Recovery smoke",
            "version": "1.0.0",
            "apiVersion": "^1.0",
            "runtime": {"kind": "wasm", "entry": "dist/plugin.wasm", "scope": "project"}
        }))?,
    )?;
    let p24_recovery_root = normalize_project_root(
        p24_recovery_project
            .canonicalize()?
            .to_string_lossy()
            .as_ref(),
    );
    let p24_recovery_context = crate::workspace_plugins::PluginRuntimeContext {
        app_data_dir: p24_data.clone(),
        project_root: p24_recovery_root.clone(),
        project_revision: 0,
        project_scope_id: ScopeId::new("project.installed-recovery-smoke")?,
        workspace: None,
    };
    let p24_recovery_registry =
        crate::workspace_plugins::PendingPluginPermissionRegistry::default();
    p24_recovery_registry.request_enable(
        &p24_recovery_context,
        "org.yulab.rho.phase2-recovery-smoke",
        &mut p24_store,
    )?;
    p24_recovery_registry.disable(
        &p24_recovery_context,
        "org.yulab.rho.phase2-recovery-smoke",
        &mut p24_store,
    )?;
    let p24_recovery_state = PluginLifecycleQueryService::new(&p24_store)
        .get_state(&p24_recovery_root, "org.yulab.rho.phase2-recovery-smoke")?
        .context("installed P2-4 recovery state is missing")?;
    PluginLifecycleMutationService::new(&mut p24_store).request_transition(
        &p24_recovery_root,
        &rho_store::WorkspacePluginTransitionDraft {
            transition_id: "transition.uninstall.installed-recovery".to_string(),
            project_root: p24_recovery_root.clone(),
            plugin_id: "org.yulab.rho.phase2-recovery-smoke".to_string(),
            kind: "uninstall".to_string(),
            request_event_type: "user_requested".to_string(),
            desired_state: "uninstalled".to_string(),
            expected_old_digest: p24_recovery_state.accepted_digest,
            candidate_digest: None,
            rollback_digest: None,
            backup_path_key: Some("trash.installed-recovery".to_string()),
        },
    )?;
    let first_recovery =
        p24_recovery_registry.reconcile_project(&p24_recovery_context, &mut p24_store);
    let mut recovery_revision = BrokerState::new("plugin_recovery_smoke");
    if first_recovery.project_files_changed {
        recovery_revision.project_changed();
    }
    let second_recovery =
        p24_recovery_registry.reconcile_project(&p24_recovery_context, &mut p24_store);
    if second_recovery.project_files_changed {
        recovery_revision.project_changed();
    }
    ensure!(
        first_recovery.recovered_uninstalls == 1
            && first_recovery.project_files_changed
            && second_recovery.recovered_uninstalls == 0
            && !second_recovery.project_files_changed
            && recovery_revision.identity().project_revision == 1
            && !p24_recovery_plugin.exists(),
        "installed P2-4 Uninstall recovery or once-only revision diverged"
    );
    let p24_retention_project = p24_root.path().join("retention-project");
    let p24_retention_plugin = p24_retention_project.join(".rho/plugins/retention-smoke");
    std::fs::create_dir_all(p24_retention_plugin.join("dist"))?;
    std::fs::write(
        p24_retention_plugin.join("dist/plugin.wasm"),
        P2_1_SMOKE_WASM,
    )?;
    std::fs::write(
        p24_retention_plugin.join("rho-plugin.json"),
        serde_json::to_vec(&json!({
            "schemaVersion": 1,
            "id": "org.yulab.rho.phase2-retention-smoke",
            "name": "Retention smoke",
            "version": "1.0.0",
            "apiVersion": "^1.0",
            "runtime": {"kind": "wasm", "entry": "dist/plugin.wasm", "scope": "project"}
        }))?,
    )?;
    let p24_retention_root = normalize_project_root(
        p24_retention_project
            .canonicalize()?
            .to_string_lossy()
            .as_ref(),
    );
    let p24_retention_context = crate::workspace_plugins::PluginRuntimeContext {
        app_data_dir: p24_data.clone(),
        project_root: p24_retention_root.clone(),
        project_revision: 1,
        project_scope_id: ScopeId::new("project.installed-retention-smoke")?,
        workspace: None,
    };
    let p24_retention_registry =
        crate::workspace_plugins::PendingPluginPermissionRegistry::default();
    ensure!(
        p24_retention_registry
            .request_enable(
                &p24_retention_context,
                "org.yulab.rho.phase2-retention-smoke",
                &mut p24_store,
            )?
            .status
            == "enabled",
        "installed P2-4 retention fixture did not enable"
    );
    let p24_retention_state = PluginLifecycleQueryService::new(&p24_store)
        .get_state(&p24_retention_root, "org.yulab.rho.phase2-retention-smoke")?
        .context("installed P2-4 retention lifecycle state is missing")?;
    let p24_retention_uninstall = p24_retention_registry.uninstall(
        &p24_retention_context,
        &crate::workspace_plugins::WorkspacePluginUninstallInput {
            plugin_id: "org.yulab.rho.phase2-retention-smoke".to_string(),
            directory_name: "retention-smoke".to_string(),
            package_digest: p24_retention_state
                .accepted_digest
                .clone()
                .context("installed P2-4 retention accepted digest is missing")?,
            expected_project_revision: p24_retention_context.project_revision,
            confirmed: true,
        },
        &mut p24_store,
    )?;
    let p24_retention_tombstone = PluginLifecycleQueryService::new(&p24_store)
        .get_tombstone(&p24_retention_root, &p24_retention_uninstall.tombstone_id)?
        .context("installed P2-4 retention tombstone is missing")?;
    let p24_sibling = p24_root.path().join("sibling-project/.rho/plugins/keep");
    std::fs::create_dir_all(&p24_sibling)?;
    std::fs::write(p24_sibling.join("sentinel.txt"), b"keep")?;
    let retention_service = rho_server::plugin_retention::PluginTrashRetentionService::new();
    let expired = retention_service.expire(
        &mut p24_store,
        &p24_retention_root,
        &p24_retention_tombstone.moved_at,
        1,
    )?;
    ensure!(
        expired.expired.len() == 1 && expired.expired[0].retention_class == "expired",
        "installed P2-4 retention expiry did not select the exact tombstone"
    );
    let p24_purge_draft = rho_store::WorkspacePluginPurgeDraft {
        project_root: p24_retention_root.clone(),
        tombstone_id: p24_retention_tombstone.tombstone_id.clone(),
        plugin_id: p24_retention_tombstone.plugin_id.clone(),
        package_digest: p24_retention_tombstone.package_digest.clone(),
        backup_path_key: p24_retention_tombstone.backup_path_key.clone(),
        original_directory_name: p24_retention_tombstone.original_directory_name.clone(),
    };
    ensure!(
        PluginLifecycleMutationService::new(&mut p24_store)
            .request_purge(&p24_retention_root, &p24_purge_draft)?
            .tombstone
            .retention_class
            == "purge_pending",
        "installed P2-4 purge-pending truth was not durable before deletion"
    );
    let p24_purge_recovery =
        p24_retention_registry.reconcile_project(&p24_retention_context, &mut p24_store);
    let p24_purged = PluginLifecycleQueryService::new(&p24_store)
        .get_tombstone(&p24_retention_root, &p24_retention_tombstone.tombstone_id)?
        .context("installed P2-4 recovered purge tombstone is missing")?;
    ensure!(
        p24_purge_recovery.recovered_purges == 1
            && p24_purge_recovery.project_files_changed
            && p24_purged.deleted_at.is_some()
            && p24_purged.retention_class == "expired"
            && !p24_retention_plugin.exists()
            && p24_sibling.join("sentinel.txt").is_file(),
        "installed P2-4 exact purge damaged sibling truth or missed terminal tombstone"
    );
    let p24_purge_replay = retention_service.purge_exact_tombstone(
        &mut p24_store,
        &p24_retention_root,
        &p24_retention_tombstone.tombstone_id,
    )?;
    ensure!(
        p24_purge_replay.file_outcome
            == rho_server::plugin_package_trash::PluginPackageOwnershipOutcome::AlreadyPurged,
        "installed P2-4 exact purge replay was not idempotent"
    );

    let mut report = json!({
        "runtime": "wasmtime-38.0.4",
        "guest_abi": 1,
        "guest_echo": true,
        "heartbeat": true,
        "disposed": true,
        "wasi_rejected": true,
        "imports_exposed": 0,
        "guest_abi_v2": 2,
        "broker_yield_resume": true,
        "grant_handle_bits": 256,
        "raw_handle_redacted": true,
        "revoke_enforced": true,
        "durable_permission_lane": true,
        "durable_raw_handle_absent": true,
        "manifest_v2": 2,
        "contribution_publish_cas": true,
        "contribution_call_proxy": true,
        "viewer_document_v1": true,
        "panel_slot": "plugin_details",
        "contribution_teardown": true,
        "schema_v14_lifecycle": true,
        "exact_package_cache": true,
        "durable_first_enable": true,
        "durable_activation_generation": 1,
        "durable_completion_after_routing": true,
        "restart_reactivated": true,
        "restart_generation": 2,
        "restart_authority_fresh": true,
        "changed_package_update_pending": true,
        "explicit_disable": true,
        "disable_route_closed": true,
        "disable_host_disposed": true,
        "disable_terminal_durable": true,
        "boundary_teardown_reused": true,
        "boundary_enabled_intent_preserved": true,
        "boundary_reactivated": true,
        "crash_state_durable": true,
        "heartbeat_timeout_classified": true,
        "retry_fresh_authority": true,
        "third_crash_blocked": true,
    });
    report["recoverable_uninstall"] = json!(true);
    report["uninstall_tombstone_atomic"] = json!(true);
    report["uninstall_package_in_trash"] = json!(true);
    report["restore_disabled_no_authority"] = json!(true);
    report["retention_expired"] = json!(true);
    report["purge_pending_durable"] = json!(true);
    report["exact_trash_purged"] = json!(true);
    report["purge_tombstone_terminal"] = json!(true);
    report["purge_sibling_project_preserved"] = json!(true);
    report["purge_replay_idempotent"] = json!(true);
    report["update_local_candidate_only"] = json!(true);
    report["update_expected_old_cas"] = json!(true);
    report["update_pointer_durable"] = json!(true);
    report["update_generation_fresh"] = json!(true);
    report["rollback_exact_cache_only"] = json!(true);
    report["rollback_fresh_authority"] = json!(true);
    report["rollback_pointer_reversed"] = json!(true);
    report["rollback_source_unchanged"] = json!(true);
    report["rollback_restart_cached"] = json!(true);
    report["recovery_purge_pending"] = json!(true);
    report["recovery_incomplete_uninstall"] = json!(true);
    report["recovery_project_revision_once"] = json!(true);
    Ok(report)
}
