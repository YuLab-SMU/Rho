fn environment_operation_is_package(operation: &str) -> bool {
    matches!(
        operation,
        "install_package" | "update_package" | "remove_package"
    )
}

fn validate_environment_package_name(package: &str) -> Result<()> {
    let bytes = package.as_bytes();
    ensure!(
        !bytes.is_empty() && bytes.len() <= 128,
        "Package must contain 1 to 128 ASCII characters"
    );
    ensure!(
        bytes[0].is_ascii_alphabetic()
            && bytes[1..]
                .iter()
                .all(|value| value.is_ascii_alphanumeric() || *value == b'.'),
        "Package must be one valid R package name"
    );
    Ok(())
}

fn validate_local_help_lookup(name: &str, package: Option<&str>) -> Result<()> {
    ensure!(
        !name.is_empty() && name.len() <= 128 && !name.chars().any(char::is_control),
        "Help name must contain 1 to 128 UTF-8 bytes without control characters"
    );
    if let Some(package) = package {
        validate_environment_package_name(package).context("invalid Help package")?;
    }
    Ok(())
}

fn validate_project_relative_r_path(path: &str) -> Result<()> {
    validate_project_relative_r_source_path(path, "Lint")
}

fn validate_project_relative_r_source_path(path: &str, label: &str) -> Result<()> {
    ensure!(
        !path.is_empty() && path.len() <= 1000 && !path.chars().any(char::is_control),
        "{label} path must contain 1 to 1000 UTF-8 bytes without control characters"
    );
    ensure!(
        !path.starts_with('/')
            && !path.starts_with('\\')
            && !path.contains(':')
            && path
                .split(['/', '\\'])
                .all(|segment| !segment.is_empty() && segment != "." && segment != ".."),
        "{label} path must be project-relative"
    );
    ensure!(
        path.to_ascii_lowercase().ends_with(".r"),
        "{label} path must identify one R file"
    );
    Ok(())
}

fn environment_repositories_expression(
    repositories: &Option<HashMap<String, String>>,
) -> Result<String> {
    match repositories {
        Some(values) if !values.is_empty() => {
            let mut entries = values.iter().collect::<Vec<_>>();
            entries.sort_by(|left, right| left.0.cmp(right.0));
            let names = entries
                .iter()
                .map(|(name, _)| r_string(name))
                .collect::<Result<Vec<_>>>()?
                .join(", ");
            let repo_values = entries
                .iter()
                .map(|(_, value)| r_string(value))
                .collect::<Result<Vec<_>>>()?
                .join(", ");
            Ok(format!("stats::setNames(c({repo_values}), c({names}))"))
        }
        _ => Ok("NULL".to_string()),
    }
}

fn environment_operation_bridge_expression(
    arguments: &EnvironmentOperationArguments,
) -> Result<String> {
    let repositories = environment_repositories_expression(&arguments.repositories)?;
    let bioconductor = arguments
        .bioconductor
        .as_deref()
        .map(r_string)
        .transpose()?
        .unwrap_or_else(|| "NULL".to_string());
    let package = arguments
        .package
        .as_deref()
        .map(r_string)
        .transpose()?
        .unwrap_or_else(|| "NULL".to_string());
    let project_library = arguments
        .project_library
        .as_deref()
        .map(r_string)
        .transpose()?
        .unwrap_or_else(|| "NULL".to_string());
    Ok(format!(
        r#"getOption("rho.bridge.env")$rho_environment_operation(
  operation = {operation},
  project_dir = {project_dir},
  repositories = {repositories},
  bioconductor = {bioconductor},
  package = {package},
  project_library = {project_library}
)"#,
        operation = r_string(&arguments.operation)?,
        project_dir = r_string(arguments.project_root.as_deref().unwrap_or_default())?,
    ))
}

fn environment_operation_requires_after_snapshot(request_type: &str) -> bool {
    matches!(
        request_type,
        "environment.initialize"
            | "environment.restore"
            | "environment.snapshot"
            | "environment.package_install"
            | "environment.package_update"
            | "environment.package_remove"
    )
}

fn scientific_run_requires_environment_snapshot(request_type: &str) -> bool {
    matches!(
        request_type,
        "workspace.execute"
            | "workspace.render_document"
            | "environment.initialize"
            | "environment.restore"
            | "environment.snapshot"
            | "environment.package_install"
            | "environment.package_update"
            | "environment.package_remove"
    )
}

fn canonical_environment_operation_arguments(
    project_root: &str,
    arguments: &EnvironmentOperationArguments,
) -> Value {
    let mut repositories = arguments
        .repositories
        .clone()
        .unwrap_or_default()
        .into_iter()
        .collect::<Vec<_>>();
    repositories.sort_by(|left, right| left.0.cmp(&right.0));
    json!({
        "operation": arguments.operation,
        "project_root": project_root,
        "repositories": repositories.into_iter().map(|(name, value)| json!({"name": name, "value": value})).collect::<Vec<_>>(),
        "bioconductor": arguments.bioconductor,
        "package": arguments.package,
        "project_library": arguments.project_library
    })
}

async fn preview_environment_operation(
    arguments: &EnvironmentOperationArguments,
    turn_id: Option<&str>,
    source: &str,
    session: &ArkSession,
    broker: &BrokerState,
    executor: &StoreExecutor,
) -> Result<EnvironmentOperationRequestSummary> {
    let request_name = environment_operation_request_name(&arguments.operation)?;
    let project_root = executor
        .project_transition_repository()
        .active_project_root()
        .await?
        .context("No active project root is configured")?
        .replace('\\', "/");
    let project_argument = r_string(&project_root)?;
    let package_operation = environment_operation_is_package(&arguments.operation);
    let preview_value = if package_operation {
        let package = arguments
            .package
            .as_deref()
            .context("Package operation requires `package`")?;
        validate_environment_package_name(package)?;
        let repositories = environment_repositories_expression(&arguments.repositories)?;
        let value = execute_bridge_result_expression(
            session,
            &format!(
                r#"getOption("rho.bridge.env")$rho_environment_package_preview(
  operation = {operation},
  package = {package},
  project_dir = {project_argument},
  repositories = {repositories}
)"#,
                operation = r_string(&arguments.operation)?,
                package = r_string(package)?,
            ),
        )
        .await
        .context("previewing package environment operation")?;
        ensure!(
            value.get("ok").and_then(Value::as_bool) == Some(true),
            "Package operation preview did not return an accepted result"
        );
        value
    } else {
        execute_bridge_result_expression(
            session,
            &format!(
                r#"getOption("rho.bridge.env")$rho_environment_status_preview(
  project_dir = {project_argument},
  diff_limit = {MAX_ENVIRONMENT_DIFF_ENTRIES}
)"#
            ),
        )
        .await
        .unwrap_or_else(|error| {
            json!({
                "project_dir": project_root,
                "renv": {"status": "degraded", "synchronization": "incomplete"},
                "renv_status": {
                    "ok": false,
                    "messages": [],
                    "warnings": [],
                    "error": {"message": error.to_string(), "call": null}
                },
                "bioconductor": {"status": "unknown", "version": null, "package_available": false},
                "diff": {"values": [], "truncated": false}
            })
        })
    };
    let before_snapshot_id = capture_environment_snapshot_id(session, &project_root, executor)
        .await
        .ok();
    let preview_repositories = if package_operation && arguments.operation != "remove_package" {
        Some(
            serde_json::from_value(
                preview_value
                    .get("repositories")
                    .cloned()
                    .context("Package preview omitted repositories")?,
            )
            .context("decoding package preview repositories")?,
        )
    } else if package_operation {
        Some(HashMap::new())
    } else {
        arguments.repositories.clone()
    };
    let preview_project_library = if package_operation {
        Some(
            preview_value
                .get("project_library")
                .and_then(Value::as_str)
                .context("Package preview omitted project library")?
                .to_string(),
        )
    } else {
        arguments.project_library.clone()
    };
    let stored_arguments = EnvironmentOperationArguments {
        operation: arguments.operation.clone(),
        project_root: Some(project_root.clone()),
        repositories: preview_repositories,
        bioconductor: arguments.bioconductor.clone(),
        package: arguments.package.clone(),
        project_library: preview_project_library,
    };
    let canonical_arguments =
        canonical_environment_operation_arguments(&project_root, &stored_arguments);
    let preview_json = serde_json::to_string(&json!({
        "request_name": request_name,
        "arguments": canonical_arguments,
        "workspace": broker.identity(),
        "before_snapshot_id": before_snapshot_id,
        "preview": preview_value
    }))?;
    let preview_sha256 = sha256_hex(preview_json.as_bytes());
    let request_id = format!("envreq_{}", Uuid::new_v4());
    let identity = broker.identity().clone();
    let draft = EnvironmentOperationRequestDraft {
        request_id: request_id.clone(),
        turn_id: turn_id.map(str::to_string),
        source: source.to_string(),
        request_name: request_name.to_string(),
        project_root: project_root.clone(),
        arguments_json: serde_json::to_string(&stored_arguments)?,
        preview_json,
        preview_sha256,
        workspace_id: identity.workspace_id.clone(),
        state_revision: identity.state_revision as i64,
        project_revision: identity.project_revision as i64,
        before_snapshot_id,
    };
    run_workspace_store_service(executor, move |store| {
        store.create_environment_operation_request(&draft)?;
        store
            .get_environment_operation_request(&project_root, &request_id)?
            .context("Environment operation request was not persisted")
    })
    .await
}

async fn execute_confirmed_environment_operation(
    request: &EnvironmentOperationRequestSummary,
    origin: ExecutionOrigin,
    session: &ArkSession,
    broker: &mut BrokerState,
    executor: &StoreExecutor,
) -> Result<Value> {
    let stored_arguments: EnvironmentOperationArguments =
        serde_json::from_str(&request.arguments_json)
            .context("decoding stored environment operation arguments")?;
    let payload = json!({
        "arguments": {
            "operation": stored_arguments.operation,
            "repositories": stored_arguments.repositories,
            "bioconductor": stored_arguments.bioconductor,
            "package": stored_arguments.package,
            "project_library": stored_arguments.project_library,
            "project_root": request.project_root
        },
        "expected_workspace": broker.identity(),
        "approval_request_id": request.request_id
    });
    dispatch_workspace_request(
        &request.request_name,
        &payload,
        origin,
        session,
        broker,
        executor,
    )
    .await
}

fn environment_operation_stale_reason(
    request: &EnvironmentOperationRequestSummary,
    broker: &BrokerState,
    current_project_root: &str,
    current_snapshot_id: Option<&str>,
) -> Option<String> {
    let identity = broker.identity();
    if request.workspace_id.as_deref() != Some(identity.workspace_id.as_str()) {
        return Some("Workspace identity changed before confirmation.".to_string());
    }
    if request.state_revision != Some(identity.state_revision as i64)
        || request.project_revision != Some(identity.project_revision as i64)
    {
        return Some("Workspace or project revision changed before confirmation.".to_string());
    }
    if !request
        .project_root
        .eq_ignore_ascii_case(current_project_root)
    {
        return Some("Project root changed before confirmation.".to_string());
    }
    if request.before_snapshot_id.as_deref() != current_snapshot_id {
        return Some("Environment evidence changed before confirmation.".to_string());
    }
    None
}

pub async fn request_environment_operation(
    arguments: EnvironmentOperationArguments,
    turn_id: Option<&str>,
    source: &str,
    session: &ArkSession,
    broker: &BrokerState,
    executor: &StoreExecutor,
) -> Result<EnvironmentOperationRequestSummary> {
    preview_environment_operation(&arguments, turn_id, source, session, broker, executor).await
}

pub async fn decide_environment_operation(
    request_id: &str,
    decision: &str,
    reason: Option<String>,
    origin: ExecutionOrigin,
    session: &ArkSession,
    broker: &mut BrokerState,
    executor: &StoreExecutor,
) -> Result<Value> {
    let requested_id = request_id.to_string();
    let request = run_workspace_store_service(executor, move |store| {
        let project_root = store
            .active_project_root()?
            .context("Cannot decide environment operation without an active project identity")?;
        store
            .get_environment_operation_request(&project_root, &requested_id)?
            .context(format!(
                "Environment operation request not found: {requested_id}"
            ))
    })
    .await?;
    ensure!(
        request.status == "requested",
        "Environment operation request is no longer pending: {}",
        request.status
    );
    if decision != "approve" {
        let status = if decision == "cancel" {
            "cancelled"
        } else {
            "rejected"
        };
        let request_id = request_id.to_string();
        let persisted_request_id = request_id.clone();
        let decision_value = decision.to_string();
        let decision_record = EnvironmentOperationDecisionRecord {
            decision: decision_value.clone(),
            status: status.to_string(),
            reason: reason.clone(),
        };
        run_workspace_store_service(executor, move |store| {
            store.decide_environment_operation_request(&persisted_request_id, &decision_record)?;
            Ok(())
        })
        .await?;
        return Ok(json!({
            "request_id": request_id,
            "status": status,
            "decision": decision_value
        }));
    }

    let current_project_root = executor
        .project_transition_repository()
        .active_project_root()
        .await?
        .unwrap_or_default()
        .replace('\\', "/");
    let current_snapshot_id =
        capture_environment_snapshot_id(session, &current_project_root, executor)
            .await
            .ok();
    if let Some(stale_reason) = environment_operation_stale_reason(
        &request,
        broker,
        &current_project_root,
        current_snapshot_id.as_deref(),
    ) {
        let request_id = request_id.to_string();
        let persisted_request_id = request_id.clone();
        let decision = EnvironmentOperationDecisionRecord {
            decision: "approve".to_string(),
            status: "stale".to_string(),
            reason: Some(stale_reason.clone()),
        };
        run_workspace_store_service(executor, move |store| {
            store.decide_environment_operation_request(&persisted_request_id, &decision)?;
            Ok(())
        })
        .await?;
        return Ok(json!({
            "request_id": request_id,
            "status": "stale",
            "reason": stale_reason
        }));
    }

    let approved_request_id = request_id.to_string();
    let approved_decision = EnvironmentOperationDecisionRecord {
        decision: "approve".to_string(),
        status: "approved".to_string(),
        reason,
    };
    run_workspace_store_service(executor, move |store| {
        store.decide_environment_operation_request(&approved_request_id, &approved_decision)?;
        Ok(())
    })
    .await?;
    let result =
        execute_confirmed_environment_operation(&request, origin, session, broker, executor).await;
    if let Err(error) = &result {
        // Dispatch can fail before the execution envelope claims the request
        // as running. Do not leave a user-visible approval without a truthful
        // terminal outcome.
        let finish = EnvironmentOperationFinish {
            request_id: request_id.to_string(),
            status: "failed".to_string(),
            run_id: None,
            terminal_outcome: Some("dispatch_error".to_string()),
            reason: Some(redact_sensitive_text(&error.to_string())),
        };
        let _ = run_workspace_store_service(executor, move |store| {
            store.finish_environment_operation_request(&finish)?;
            Ok(())
        })
        .await;
    }
    result
}

async fn capture_environment_snapshot_id(
    session: &ArkSession,
    project_root: &str,
    executor: &StoreExecutor,
) -> Result<String> {
    let project_root = project_root.replace('\\', "/");
    let project_argument = if project_root.is_empty() {
        "getwd()".to_string()
    } else {
        r_string(&project_root)?
    };
    let raw = match execute_bridge_result_expression(
        session,
        &format!(
            r#"getOption("rho.bridge.env")$rho_environment_evidence(project_dir = {project_argument})"#
        ),
    )
    .await
    {
        Ok(value) => serde_json::from_value::<RawEnvironmentEvidence>(value).unwrap_or_default(),
        Err(_) => RawEnvironmentEvidence {
            project_dir: project_root.clone(),
            ..RawEnvironmentEvidence::default()
        },
    };
    let mut snapshot = canonicalize_environment_snapshot(project_root, raw);
    let canonical_json = finalize_environment_snapshot_json(&mut snapshot).unwrap_or_else(|error| {
        serde_json::to_string(&degraded_environment_snapshot(
            snapshot.project_root.clone(),
            format!("snapshot_budget_error: {error}"),
        ))
        .unwrap_or_else(|_| {
            "{\"project_root\":\"\",\"renv\":{\"status\":\"degraded\"},\"incomplete_reason\":\"snapshot_serialization_failed\"}".to_string()
        })
    });
    let snapshot_id = sha256_hex(canonical_json.as_bytes());
    let draft = EnvironmentSnapshotDraft {
        snapshot_id: snapshot_id.clone(),
        project_root: snapshot.project_root.clone(),
        canonical_json,
    };
    run_workspace_store_service(executor, move |store| {
        store.record_environment_snapshot(&draft)?;
        Ok(())
    })
    .await?;
    Ok(snapshot_id)
}

fn degraded_environment_snapshot(
    project_root: String,
    reason: String,
) -> CanonicalEnvironmentSnapshot {
    CanonicalEnvironmentSnapshot {
        project_root,
        runtime: CanonicalRuntimeState {
            version: None,
            platform: None,
        },
        bioconductor: CanonicalBioconductorState {
            status: "unknown".to_string(),
            version: None,
            package_available: false,
        },
        library_paths: Vec::new(),
        installed_packages: Vec::new(),
        renv: CanonicalRenvState {
            status: "degraded".to_string(),
            has_lockfile: false,
            package_available: false,
            project_library: None,
            active: false,
            lockfile: CanonicalLockfileState {
                exists: false,
                sha256: None,
                valid: false,
                packages: Vec::new(),
            },
            synchronization: "incomplete".to_string(),
        },
        incomplete_reason: Some(reason),
    }
}

fn canonicalize_environment_snapshot(
    project_root: String,
    raw: RawEnvironmentEvidence,
) -> CanonicalEnvironmentSnapshot {
    let resolved_project_root = if project_root.is_empty() {
        raw.project_dir.replace('\\', "/")
    } else {
        project_root
    };
    if raw.runtime.version.is_none()
        && raw.runtime.platform.is_none()
        && raw.installed_packages.values.is_empty()
        && raw.library_paths.is_empty()
    {
        return degraded_environment_snapshot(
            resolved_project_root,
            "capture_failed: environment evidence was unavailable".to_string(),
        );
    }

    let mut incomplete_reasons = Vec::new();
    if raw.installed_packages.truncated {
        incomplete_reasons.push("installed_packages_truncated_at_source".to_string());
    }
    if let Some(reason) = raw.installed_packages.incomplete_reason.clone() {
        incomplete_reasons.push(format!("installed_packages_incomplete: {reason}"));
    }

    let mut installed_packages = raw
        .installed_packages
        .values
        .into_iter()
        .map(|item| CanonicalInstalledPackage {
            name: item.name,
            version: item.version,
            library: item.library.map(|value| value.replace('\\', "/")),
        })
        .collect::<Vec<_>>();
    installed_packages.sort_by(|left, right| {
        left.name
            .cmp(&right.name)
            .then(left.version.cmp(&right.version))
            .then(left.library.cmp(&right.library))
    });

    let lockfile = canonicalize_lockfile(
        raw.renv.has_lockfile.unwrap_or(false),
        raw.renv.lockfile_path.as_deref(),
        &mut incomplete_reasons,
    );
    let synchronization = compute_lockfile_sync_state(
        &installed_packages,
        raw.renv.package_available.unwrap_or(false),
        &lockfile,
    );

    CanonicalEnvironmentSnapshot {
        project_root: resolved_project_root,
        runtime: CanonicalRuntimeState {
            version: raw.runtime.version,
            platform: raw.runtime.platform,
        },
        bioconductor: CanonicalBioconductorState {
            status: raw
                .bioconductor
                .status
                .unwrap_or_else(|| "unknown".to_string()),
            version: raw.bioconductor.version,
            package_available: raw.bioconductor.package_available.unwrap_or(false),
        },
        library_paths: raw
            .library_paths
            .into_iter()
            .map(|value| value.replace('\\', "/"))
            .collect(),
        installed_packages,
        renv: CanonicalRenvState {
            status: raw.renv.status.unwrap_or_else(|| "unknown".to_string()),
            has_lockfile: raw.renv.has_lockfile.unwrap_or(false),
            package_available: raw.renv.package_available.unwrap_or(false),
            project_library: raw
                .renv
                .project_library
                .map(|value| value.replace('\\', "/")),
            active: raw.renv.active.unwrap_or(false),
            lockfile,
            synchronization,
        },
        incomplete_reason: (!incomplete_reasons.is_empty()).then(|| incomplete_reasons.join(" | ")),
    }
}

fn canonicalize_lockfile(
    has_lockfile: bool,
    lockfile_path: Option<&str>,
    incomplete_reasons: &mut Vec<String>,
) -> CanonicalLockfileState {
    if !has_lockfile {
        return CanonicalLockfileState {
            exists: false,
            sha256: None,
            valid: false,
            packages: Vec::new(),
        };
    }
    let Some(lockfile_path) = lockfile_path.filter(|value| !value.trim().is_empty()) else {
        incomplete_reasons.push("lockfile_path_missing".to_string());
        return CanonicalLockfileState {
            exists: true,
            sha256: None,
            valid: false,
            packages: Vec::new(),
        };
    };
    let bytes = match std::fs::read(lockfile_path) {
        Ok(bytes) => bytes,
        Err(error) => {
            incomplete_reasons.push(format!("lockfile_read_failed: {error}"));
            return CanonicalLockfileState {
                exists: false,
                sha256: None,
                valid: false,
                packages: Vec::new(),
            };
        }
    };
    let parsed: Value = match serde_json::from_slice(&bytes) {
        Ok(value) => value,
        Err(error) => {
            incomplete_reasons.push(format!("lockfile_parse_failed: {error}"));
            return CanonicalLockfileState {
                exists: true,
                sha256: Some(sha256_hex(&bytes)),
                valid: false,
                packages: Vec::new(),
            };
        }
    };
    let mut packages = parsed
        .get("Packages")
        .and_then(Value::as_object)
        .map(|entries| {
            entries
                .iter()
                .map(|(name, value)| CanonicalLockfilePackage {
                    name: name.clone(),
                    version: value
                        .get("Version")
                        .and_then(Value::as_str)
                        .map(str::to_string),
                    source: value
                        .get("Source")
                        .and_then(Value::as_str)
                        .map(str::to_string),
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    packages.sort_by(|left, right| left.name.cmp(&right.name));
    CanonicalLockfileState {
        exists: true,
        sha256: Some(sha256_hex(&bytes)),
        valid: parsed.get("Packages").and_then(Value::as_object).is_some(),
        packages,
    }
}

fn compute_lockfile_sync_state(
    installed_packages: &[CanonicalInstalledPackage],
    renv_available: bool,
    lockfile: &CanonicalLockfileState,
) -> String {
    if !lockfile.exists {
        return "no_lockfile".to_string();
    }
    if !renv_available {
        return "renv_unavailable".to_string();
    }
    if !lockfile.valid {
        return "invalid_lockfile".to_string();
    }
    let mut installed_versions = HashMap::new();
    for package in installed_packages {
        installed_versions
            .entry(package.name.clone())
            .or_insert_with(|| package.version.clone());
    }
    let drifted = lockfile.packages.iter().any(|package| {
        installed_versions
            .get(&package.name)
            .and_then(|value| value.as_deref())
            != package.version.as_deref()
    });
    if drifted {
        "drifted".to_string()
    } else {
        "synchronized".to_string()
    }
}

fn finalize_environment_snapshot_json(
    snapshot: &mut CanonicalEnvironmentSnapshot,
) -> Result<String> {
    let mut budget_trimmed = false;
    loop {
        let encoded = serde_json::to_string(snapshot)?;
        if encoded.len() <= MAX_CANONICAL_SNAPSHOT_BYTES {
            if budget_trimmed {
                append_incomplete_reason(
                    &mut snapshot.incomplete_reason,
                    "canonical_snapshot_trimmed_to_budget",
                );
                return Ok(serde_json::to_string(snapshot)?);
            }
            return Ok(encoded);
        }
        if !snapshot.installed_packages.is_empty() {
            snapshot.installed_packages.pop();
            budget_trimmed = true;
            continue;
        }
        if !snapshot.renv.lockfile.packages.is_empty() {
            snapshot.renv.lockfile.packages.pop();
            budget_trimmed = true;
            continue;
        }
        if !snapshot.library_paths.is_empty() {
            snapshot.library_paths.pop();
            budget_trimmed = true;
            continue;
        }
        bail!("environment snapshot exceeds byte budget even after trimming");
    }
}

fn append_incomplete_reason(target: &mut Option<String>, reason: &str) {
    match target {
        Some(existing) => {
            if !existing.split(" | ").any(|item| item == reason) {
                existing.push_str(" | ");
                existing.push_str(reason);
            }
        }
        None => *target = Some(reason.to_string()),
    }
}

fn sha256_hex(bytes: &[u8]) -> String {
    let mut digest = Sha256::new();
    digest.update(bytes);
    format!("{:x}", digest.finalize())
}
