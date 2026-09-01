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

fn scientific_run_requires_environment_snapshot(request_type: &str) -> bool {
    matches!(
        request_type,
        "workspace.execute" | "workspace.render_document"
    )
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
        Ok(value) => serde_json::from_value::<RawEnvironmentReceipt>(value).unwrap_or_default(),
        Err(_) => RawEnvironmentReceipt {
            project_dir: project_root.clone(),
            ..RawEnvironmentReceipt::default()
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
    raw: RawEnvironmentReceipt,
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
            "capture_failed: environment receipt was unavailable".to_string(),
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
