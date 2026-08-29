fn bridge_expression(request_type: &str, arguments: &Value) -> Result<(OperationClass, String)> {
    let bridge = r#"getOption("rho.bridge.env")"#;
    match request_type {
        "workspace.execute" => {
            let code = arguments["code"]
                .as_str()
                .context("workspace.execute requires string argument `code`")?;
            Ok((
                OperationClass::StateCapable,
                format!(
                    "{bridge}$rho_execute({}, envir = .GlobalEnv)",
                    r_string(code)?
                ),
            ))
        }
        "workspace.snapshot" => Ok((
            OperationClass::Probe,
            format!("{bridge}$rho_workspace_snapshot(envir = .GlobalEnv)"),
        )),
        "workspace.inspect_object" => {
            let name = arguments["name"]
                .as_str()
                .context("workspace.inspect_object requires string argument `name`")?;
            Ok((
                OperationClass::Probe,
                format!(
                    "{bridge}$rho_inspect_object({}, envir = .GlobalEnv)",
                    r_string(name)?
                ),
            ))
        }
        "workspace.inspect_data_object" => {
            let object_name = arguments["object_name"]
                .as_str()
                .context("workspace.inspect_data_object requires string argument `object_name`")?;
            Ok((
                OperationClass::Probe,
                format!(
                    "{bridge}$rho_inspect_data_object({}, envir = .GlobalEnv)",
                    r_string(object_name)?
                ),
            ))
        }
        "workspace.list_package_functions" => {
            let packages_arg = arguments
                .get("packages")
                .and_then(|v| v.as_array())
                .map(|arr| {
                    arr.iter()
                        .filter_map(|v| v.as_str())
                        .collect::<Vec<_>>()
                        .join("\", \"")
                })
                .unwrap_or_default();
            let limit = arguments
                .get("limit")
                .and_then(|v| v.as_u64())
                .unwrap_or(500);
            Ok((
                OperationClass::Probe,
                format!(
                    "{bridge}$rho_list_package_functions(packages = c(\"{packages_arg}\"), limit = {limit})",
                ),
            ))
        }
        "workspace.function_help" => {
            let name = arguments["name"]
                .as_str()
                .context("workspace.function_help requires string argument `name`")?;
            let package = arguments
                .get("package")
                .and_then(|v| v.as_str())
                .filter(|s| !s.is_empty());
            validate_local_help_lookup(name, package)?;
            let pkg_arg = match package {
                Some(p) => r_string(p)?,
                None => "NULL".to_string(),
            };
            Ok((
                OperationClass::Probe,
                format!(
                    "{bridge}$rho_function_help({}, package = {pkg_arg})",
                    r_string(name)?,
                ),
            ))
        }
        "workspace.function_documentation" => {
            let name = arguments["name"]
                .as_str()
                .context("workspace.function_documentation requires string argument `name`")?;
            let package = arguments["package"]
                .as_str()
                .context("workspace.function_documentation requires string argument `package`")?;
            validate_local_help_lookup(name, Some(package))?;
            Ok((
                OperationClass::Probe,
                format!(
                    "{bridge}$rho_function_documentation({}, package = {})",
                    r_string(name)?,
                    r_string(package)?
                ),
            ))
        }
        "workspace.lint_file" => {
            let path = arguments["path"]
                .as_str()
                .context("workspace.lint_file requires string argument `path`")?;
            let document_version = arguments["document_version"]
                .as_i64()
                .context("workspace.lint_file requires integer argument `document_version`")?;
            validate_project_relative_r_path(path)?;
            ensure!(
                (0..=i32::MAX as i64).contains(&document_version),
                "workspace.lint_file requires a non-negative document version"
            );
            Ok((
                OperationClass::Probe,
                format!(
                    "{bridge}$rho_lint_file({}, document_version = {})",
                    r_string(path)?,
                    document_version
                ),
            ))
        }
        "workspace.format_r_source" => {
            let source = arguments["source"]
                .as_str()
                .context("workspace.format_r_source requires string argument `source`")?;
            let path = arguments["path"]
                .as_str()
                .context("workspace.format_r_source requires string argument `path`")?;
            let document_version = arguments["document_version"].as_i64().context(
                "workspace.format_r_source requires integer argument `document_version`",
            )?;
            validate_project_relative_r_source_path(path, "Formatting")?;
            ensure!(
                source.len() <= 1024 * 1024,
                "Formatting source must be at most 1 MiB"
            );
            ensure!(
                !source.chars().any(|character| character == '\0'),
                "Formatting source must not contain NUL bytes"
            );
            ensure!(
                (0..=i32::MAX as i64).contains(&document_version),
                "workspace.format_r_source requires a non-negative document version"
            );
            Ok((
                OperationClass::Probe,
                format!(
                    "{bridge}$rho_format_r_source(source = {}, path = {}, document_version = {})",
                    r_string(source)?,
                    r_string(path)?,
                    document_version
                ),
            ))
        }
        "workspace.inspect_targets" => {
            let root = arguments["project_root"]
                .as_str()
                .context("workspace.inspect_targets requires string argument `project_root`")?;
            Ok((
                OperationClass::Probe,
                format!("{bridge}$rho_inspect_targets({})", r_string(root)?),
            ))
        }
        "workspace.list_installed_packages" => {
            let limit = arguments
                .get("limit")
                .and_then(|v| v.as_u64())
                .unwrap_or(500);
            Ok((
                OperationClass::Probe,
                format!("{bridge}$rho_list_installed_packages(limit = {limit}L)",),
            ))
        }
        "workspace.list_lockfile_packages" => {
            let root = arguments["project_root"].as_str().context(
                "workspace.list_lockfile_packages requires string argument `project_root`",
            )?;
            let limit = arguments
                .get("limit")
                .and_then(|v| v.as_u64())
                .unwrap_or(500)
                .clamp(1, 500);
            Ok((
                OperationClass::Probe,
                format!(
                    "{bridge}$rho_list_lockfile_packages({}, limit = {limit}L)",
                    r_string(root)?,
                ),
            ))
        }
        "workspace.find_function_definition" => {
            let name = arguments["name"]
                .as_str()
                .context("workspace.find_function_definition requires string argument `name`")?;
            let root = arguments["project_root"].as_str().context(
                "workspace.find_function_definition requires string argument `project_root`",
            )?;
            Ok((
                OperationClass::Probe,
                format!(
                    "{bridge}$rho_find_function_definition({}, {})",
                    r_string(name)?,
                    r_string(root)?
                ),
            ))
        }
        "workspace.find_project_references" => {
            let name = arguments["name"]
                .as_str()
                .context("workspace.find_project_references requires string argument `name`")?;
            let root = arguments["project_root"].as_str().context(
                "workspace.find_project_references requires string argument `project_root`",
            )?;
            let limit = arguments
                .get("limit")
                .and_then(|value| value.as_u64())
                .unwrap_or(100)
                .clamp(1, 200);
            validate_local_help_lookup(name, None)?;
            ensure!(
                !root.is_empty() && root.len() <= 1000 && !root.chars().any(char::is_control),
                "reference project root must contain 1 to 1000 UTF-8 bytes without control characters"
            );
            Ok((
                OperationClass::Probe,
                format!(
                    "{bridge}$rho_find_project_references({}, {}, limit = {limit}L)",
                    r_string(name)?,
                    r_string(root)?
                ),
            ))
        }
        "workspace.discover_chunks" => {
            let path = arguments["path"]
                .as_str()
                .context("workspace.discover_chunks requires string argument `path`")?;
            let limit = arguments
                .get("limit")
                .and_then(|v| v.as_u64())
                .unwrap_or(200);
            Ok((
                OperationClass::Probe,
                format!(
                    "{bridge}$rho_discover_chunks({}, limit = {})",
                    r_string(path)?,
                    limit,
                ),
            ))
        }
        "workspace.read_data_view" => {
            let object_name = arguments["object_name"]
                .as_str()
                .context("workspace.read_data_view requires string argument `object_name`")?;
            let view_token = arguments["view_token"]
                .as_str()
                .context("workspace.read_data_view requires string argument `view_token`")?;
            let view_kind = arguments["view_kind"]
                .as_str()
                .context("workspace.read_data_view requires string argument `view_kind`")?;
            let view_key = arguments["view_key"]
                .as_str()
                .context("workspace.read_data_view requires string argument `view_key`")?;
            let row_offset = arguments
                .get("row_offset")
                .and_then(Value::as_u64)
                .unwrap_or(0);
            let row_limit = arguments
                .get("row_limit")
                .and_then(Value::as_u64)
                .unwrap_or(50);
            let column_offset = arguments
                .get("column_offset")
                .and_then(Value::as_u64)
                .unwrap_or(0);
            let column_limit = arguments
                .get("column_limit")
                .and_then(Value::as_u64)
                .unwrap_or(20);
            let query = match arguments.get("query") {
                None | Some(Value::Null) => None,
                Some(Value::String(value)) => {
                    let value = value.trim();
                    if value.len() > 256
                        || value
                            .chars()
                            .any(|character| matches!(character, '\0' | '\r' | '\n'))
                    {
                        anyhow::bail!(
                            "workspace.read_data_view query must be at most 256 UTF-8 bytes without NUL or newline controls"
                        );
                    }
                    (!value.is_empty()).then_some(value)
                }
                Some(_) => anyhow::bail!(
                    "workspace.read_data_view optional argument `query` must be a string or null"
                ),
            };
            let sort_column = match arguments.get("sort_column") {
                None | Some(Value::Null) => None,
                Some(value) => Some(value.as_u64().context(
                    "workspace.read_data_view optional argument `sort_column` must be a non-negative integer or null",
                )?),
            };
            let sort_direction = match arguments.get("sort_direction") {
                None | Some(Value::Null) => None,
                Some(Value::String(value)) if matches!(value.as_str(), "asc" | "desc") => {
                    Some(value.as_str())
                }
                Some(_) => anyhow::bail!(
                    "workspace.read_data_view optional argument `sort_direction` must be `asc`, `desc`, or null"
                ),
            };
            if sort_column.is_some() != sort_direction.is_some() {
                anyhow::bail!(
                    "workspace.read_data_view sort_column and sort_direction must be provided together"
                );
            }
            let query = query
                .map(r_string)
                .transpose()?
                .unwrap_or_else(|| "NULL".to_string());
            let sort_column = sort_column
                .map(|value| format!("{value}L"))
                .unwrap_or_else(|| "NULL".to_string());
            let sort_direction = sort_direction
                .map(r_string)
                .transpose()?
                .unwrap_or_else(|| "NULL".to_string());
            Ok((
                OperationClass::Probe,
                format!(
                    "{bridge}$rho_read_data_view(object_name = {}, view_token = {}, view_kind = {}, view_key = {}, row_offset = {}, row_limit = {}, column_offset = {}, column_limit = {}, query = {}, sort_column = {}, sort_direction = {}, envir = .GlobalEnv)",
                    r_string(object_name)?,
                    r_string(view_token)?,
                    r_string(view_kind)?,
                    r_string(view_key)?,
                    row_offset,
                    row_limit,
                    column_offset,
                    column_limit,
                    query,
                    sort_column,
                    sort_direction
                ),
            ))
        }
        "workspace.render_document" => {
            let path = arguments["path"]
                .as_str()
                .context("workspace.render_document requires string argument `path`")?;
            let format_argument = arguments
                .get("format")
                .and_then(Value::as_str)
                .map(r_string)
                .transpose()?
                .unwrap_or_else(|| "NULL".to_string());
            Ok((
                OperationClass::ProjectMutation,
                format!(
                    "{bridge}$rho_render_document({}, format = {}, envir = .GlobalEnv)",
                    r_string(path)?,
                    format_argument
                ),
            ))
        }
        "environment.initialize"
        | "environment.restore"
        | "environment.snapshot"
        | "environment.package_install"
        | "environment.package_update"
        | "environment.package_remove" => {
            let operation = match request_type {
                "environment.initialize" => "initialize",
                "environment.restore" => "restore",
                "environment.snapshot" => "snapshot",
                "environment.package_install" => "install_package",
                "environment.package_update" => "update_package",
                "environment.package_remove" => "remove_package",
                _ => unreachable!(),
            };
            let repositories = arguments
                .get("repositories")
                .filter(|value| !value.is_null())
                .cloned()
                .map(serde_json::from_value)
                .transpose()
                .context("decoding environment operation repositories")?;
            let operation_arguments = EnvironmentOperationArguments {
                operation: operation.to_string(),
                project_root: arguments
                    .get("project_root")
                    .and_then(Value::as_str)
                    .map(str::to_string),
                repositories,
                bioconductor: arguments
                    .get("bioconductor")
                    .and_then(Value::as_str)
                    .map(str::to_string),
                package: arguments
                    .get("package")
                    .and_then(Value::as_str)
                    .map(str::to_string),
                project_library: arguments
                    .get("project_library")
                    .and_then(Value::as_str)
                    .map(str::to_string),
            };
            let class = if environment_operation_is_package(operation) {
                OperationClass::StateCapable
            } else {
                OperationClass::ProjectMutation
            };
            Ok((
                class,
                environment_operation_bridge_expression(&operation_arguments)?,
            ))
        }
        "workspace.set_project_root" => {
            let code = arguments["code"]
                .as_str()
                .context("workspace.set_project_root requires string argument `code`")?;
            Ok((
                OperationClass::StateAndProjectMutation,
                format!(
                    "{bridge}$rho_execute({}, envir = .GlobalEnv)",
                    r_string(code)?
                ),
            ))
        }
        _ => bail!("unsupported Agent R request type: {request_type}"),
    }
}

fn append_event(
    store: &mut Store<impl StoreConnection>,
    kind: MessageKind,
    payload: Value,
) -> Result<i64> {
    Ok(store.append_event(&Envelope::new(kind, payload))?)
}

fn execution_origin_name(origin: ExecutionOrigin) -> &'static str {
    match origin {
        ExecutionOrigin::User => "user",
        ExecutionOrigin::Agent => "agent",
        ExecutionOrigin::System => "system",
    }
}

fn operation_class_name(class: OperationClass) -> &'static str {
    match class {
        OperationClass::Probe => "probe",
        OperationClass::StateCapable => "state_capable",
        OperationClass::ProjectMutation => "project_mutation",
        OperationClass::StateAndProjectMutation => "state_and_project_mutation",
    }
}

fn requested_code(request_type: &str, arguments: &Value, bridge_expression: &str) -> String {
    match request_type {
        "workspace.execute" | "workspace.set_project_root" => arguments
            .get("code")
            .and_then(Value::as_str)
            .unwrap_or(bridge_expression)
            .to_string(),
        "workspace.inspect_object" => arguments
            .get("name")
            .and_then(Value::as_str)
            .map(|name| format!("inspect {name}"))
            .unwrap_or_else(|| bridge_expression.to_string()),
        "workspace.inspect_data_object" => arguments
            .get("object_name")
            .and_then(Value::as_str)
            .map(|name| format!("inspect data {name}"))
            .unwrap_or_else(|| bridge_expression.to_string()),
        "workspace.format_r_source" => arguments
            .get("path")
            .and_then(Value::as_str)
            .map(|path| format!("format {path}"))
            .unwrap_or_else(|| bridge_expression.to_string()),
        "workspace.read_data_view" => arguments
            .get("object_name")
            .and_then(Value::as_str)
            .map(|name| {
                format!(
                    "read data view {} {}",
                    name,
                    arguments
                        .get("view_kind")
                        .and_then(Value::as_str)
                        .unwrap_or("view")
                )
            })
            .unwrap_or_else(|| bridge_expression.to_string()),
        "environment.initialize"
        | "environment.restore"
        | "environment.snapshot"
        | "environment.package_install"
        | "environment.package_update"
        | "environment.package_remove" => {
            let project_root = arguments
                .get("project_root")
                .and_then(Value::as_str)
                .unwrap_or("unknown project");
            let package = arguments
                .get("package")
                .and_then(Value::as_str)
                .map(|value| format!(" {value}"))
                .unwrap_or_default();
            format!("{request_type}{package} {project_root}")
        }
        "workspace.render_document" => arguments
            .get("path")
            .and_then(Value::as_str)
            .map(|path| format!("render {path}"))
            .unwrap_or_else(|| bridge_expression.to_string()),
        _ => bridge_expression.to_string(),
    }
}

fn hash_project_output(project_root: &Path, relative_path: &str) -> Result<(u64, String)> {
    let root = project_root
        .canonicalize()
        .with_context(|| format!("resolving project output root {}", project_root.display()))?;
    let candidate = root.join(relative_path);
    let metadata = fs::symlink_metadata(&candidate)
        .with_context(|| format!("reading generated output metadata {}", candidate.display()))?;
    ensure!(
        metadata.file_type().is_file() && !metadata.file_type().is_symlink(),
        "generated output is not a regular non-symlink file"
    );
    let canonical = candidate
        .canonicalize()
        .with_context(|| format!("resolving generated output {}", candidate.display()))?;
    ensure!(
        canonical.starts_with(&root),
        "generated output resolves outside the active project"
    );
    let mut file = fs::File::open(&canonical)
        .with_context(|| format!("opening generated output {}", canonical.display()))?;
    let mut digest = Sha256::new();
    let mut bytes = 0_u64;
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let read = file.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        bytes = bytes.saturating_add(read as u64);
        digest.update(&buffer[..read]);
    }
    Ok((bytes, format!("{:x}", digest.finalize())))
}

fn generated_output_extension(path: &Path) -> bool {
    matches!(
        path.extension()
            .and_then(|value| value.to_str())
            .unwrap_or_default()
            .to_ascii_lowercase()
            .as_str(),
        "csv"
            | "tsv"
            | "txt"
            | "json"
            | "rds"
            | "rda"
            | "rdata"
            | "html"
            | "htm"
            | "pdf"
            | "png"
            | "jpg"
            | "jpeg"
            | "svg"
            | "xlsx"
            | "xls"
            | "parquet"
            | "feather"
            | "arrow"
            | "docx"
            | "pptx"
            | "zip"
            | "gz"
    )
}

fn ignored_generated_output_directory(name: &str) -> bool {
    matches!(
        name.to_ascii_lowercase().as_str(),
        ".git" | ".rho" | ".rproj.user" | ".worktrees" | "target" | "renv" | "node_modules"
    )
}

fn capture_generated_output_snapshot(root: &Path) -> GeneratedOutputSnapshot {
    let Ok(root) = root.canonicalize() else {
        return GeneratedOutputSnapshot {
            truncated: true,
            ..Default::default()
        };
    };
    let mut snapshot = GeneratedOutputSnapshot::default();
    let mut scanned_entries = 0;
    collect_generated_output_files(&root, &root, 0, &mut scanned_entries, &mut snapshot);
    snapshot
}

fn collect_generated_output_files(
    root: &Path,
    directory: &Path,
    depth: usize,
    scanned_entries: &mut usize,
    snapshot: &mut GeneratedOutputSnapshot,
) {
    if depth > MAX_GENERATED_OUTPUT_DEPTH
        || *scanned_entries >= MAX_GENERATED_OUTPUT_ENTRIES
        || snapshot.files.len() >= MAX_GENERATED_OUTPUT_FILES
    {
        snapshot.truncated = true;
        return;
    }
    let Ok(read_dir) = fs::read_dir(directory) else {
        snapshot.truncated = true;
        return;
    };
    let mut entries = read_dir.filter_map(|entry| entry.ok()).collect::<Vec<_>>();
    entries.sort_by_key(|entry| entry.file_name().to_string_lossy().to_ascii_lowercase());
    for entry in entries {
        if *scanned_entries >= MAX_GENERATED_OUTPUT_ENTRIES
            || snapshot.files.len() >= MAX_GENERATED_OUTPUT_FILES
        {
            snapshot.truncated = true;
            return;
        }
        *scanned_entries += 1;
        let Ok(file_type) = entry.file_type() else {
            snapshot.truncated = true;
            continue;
        };
        if file_type.is_symlink() {
            continue;
        }
        let path = entry.path();
        if file_type.is_dir() {
            if ignored_generated_output_directory(&entry.file_name().to_string_lossy()) {
                continue;
            }
            let Ok(canonical) = path.canonicalize() else {
                snapshot.truncated = true;
                continue;
            };
            if canonical.starts_with(root) {
                collect_generated_output_files(
                    root,
                    &canonical,
                    depth + 1,
                    scanned_entries,
                    snapshot,
                );
            }
            continue;
        }
        if !file_type.is_file() || !generated_output_extension(&path) {
            continue;
        }
        let Ok(metadata) = entry.metadata() else {
            snapshot.truncated = true;
            continue;
        };
        let Ok(relative) = path.strip_prefix(root) else {
            continue;
        };
        let modified_nanos = metadata
            .modified()
            .ok()
            .and_then(|value| value.duration_since(UNIX_EPOCH).ok())
            .map(|value| value.as_nanos())
            .unwrap_or_default();
        snapshot.files.insert(
            relative.to_string_lossy().replace('\\', "/"),
            GeneratedOutputSignature {
                size_bytes: metadata.len(),
                modified_nanos,
            },
        );
    }
}

fn generated_output_deltas(
    before: &GeneratedOutputSnapshot,
    after: &GeneratedOutputSnapshot,
) -> Vec<GeneratedOutputDelta> {
    after
        .files
        .iter()
        .filter_map(|(path, signature)| match before.files.get(path) {
            None => Some(GeneratedOutputDelta {
                path: path.clone(),
                change_kind: "created",
                signature: signature.clone(),
            }),
            Some(previous) if previous != signature => Some(GeneratedOutputDelta {
                path: path.clone(),
                change_kind: "modified",
                signature: signature.clone(),
            }),
            _ => None,
        })
        .take(MAX_GENERATED_OUTPUT_RECORDS)
        .collect()
}

fn artifact_output_path(project_root: Option<&str>, output_path: &str) -> String {
    let normalized_output = output_path.replace('\\', "/");
    let Some(project_root) = project_root else {
        return normalized_output;
    };
    let normalized_root = project_root
        .replace('\\', "/")
        .trim_end_matches('/')
        .to_string();
    if let Some(relative) = normalized_output
        .strip_prefix(&(normalized_root.clone() + "/"))
        .filter(|value| !value.is_empty())
    {
        relative.to_string()
    } else if normalized_output == normalized_root {
        ".".to_string()
    } else {
        normalized_output
    }
}

fn materialized_project_output(project_root: &Path, relative_output: &str) -> bool {
    let Ok(canonical_root) = project_root.canonicalize() else {
        return false;
    };
    let output_file = project_root.join(relative_output);
    output_file.is_file()
        && output_file
            .canonicalize()
            .map(|path| path.starts_with(&canonical_root))
            .unwrap_or(false)
}

fn infer_output_media_type(path: &str) -> String {
    let extension = Path::new(path)
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    match extension.as_str() {
        "html" | "htm" => "text/html",
        "pdf" => "application/pdf",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "svg" => "image/svg+xml",
        "csv" => "text/csv",
        "tsv" => "text/tab-separated-values",
        "txt" => "text/plain",
        "json" => "application/json",
        "rds" | "rda" | "rdata" => "application/x-r-data",
        "xlsx" => "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "xls" => "application/vnd.ms-excel",
        "parquet" => "application/vnd.apache.parquet",
        "feather" | "arrow" => "application/vnd.apache.arrow.file",
        "docx" => "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "pptx" => "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        "zip" => "application/zip",
        "gz" => "application/gzip",
        _ => "application/octet-stream",
    }
    .to_string()
}

fn artifact_provenance_status(
    run_id: Option<&str>,
    source_path: Option<&str>,
    document_version: Option<i64>,
) -> (bool, Option<String>) {
    if run_id.is_none() {
        return (false, Some("run_link_unavailable".to_string()));
    }
    if source_path.is_none() {
        return (false, Some("source_path_unavailable".to_string()));
    }
    if document_version.is_none() {
        return (false, Some("document_version_unavailable".to_string()));
    }
    (true, None)
}

fn extract_plot_payloads(events: &[CorrelatedKernelEvent]) -> Vec<(String, String)> {
    let mut plots = Vec::new();
    let mut seen = HashSet::new();
    for event in events {
        let Ok(value) = serde_json::to_value(event) else {
            continue;
        };
        let Some(data) = value.get("data").and_then(Value::as_object) else {
            continue;
        };
        for media_type in ["image/png", "image/svg+xml", "rho/mock-image"] {
            let Some(payload) = data.get(media_type) else {
                continue;
            };
            let payload = if media_type == "image/png" {
                let Some(encoded) = payload.as_str().and_then(normalize_base64_padding) else {
                    continue;
                };
                Value::String(encoded)
            } else {
                payload.clone()
            };
            let media_type = media_type.to_string();
            let payload_json = serde_json::to_string(&json!({ &media_type: payload }))
                .unwrap_or_else(|_| "{}".to_string());
            if seen.insert((media_type.clone(), payload_json.clone())) {
                plots.push((media_type, payload_json));
            }
            break;
        }
    }
    plots
}

fn normalize_base64_padding(value: &str) -> Option<String> {
    let compact = value
        .chars()
        .filter(|character| !character.is_ascii_whitespace())
        .collect::<String>();
    let core = compact.trim_end_matches('=');
    let padding_length = compact.len() - core.len();
    if core.is_empty()
        || core.contains('=')
        || padding_length > 2
        || (padding_length > 0 && compact.len() % 4 != 0)
        || !core
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'+' || byte == b'/')
        || core.len() % 4 == 1
    {
        return None;
    }
    let mut normalized = core.to_string();
    normalized.extend(std::iter::repeat_n('=', (4 - core.len() % 4) % 4));
    Some(normalized)
}

fn ensure_no_kernel_errors(events: &[CorrelatedKernelEvent]) -> Result<()> {
    if let Some(traceback) = events.iter().find_map(|event| match &event.event {
        KernelEvent::Error { traceback } => Some(traceback),
        _ => None,
    }) {
        bail!("Workspace R execution failed: {traceback}");
    }
    Ok(())
}

fn json_string(value: &Value, key: &str) -> Option<String> {
    value
        .get(key)
        .and_then(Value::as_str)
        .map(redact_sensitive_text)
}

const MAX_DIAGNOSTIC_LINE: u32 = 10_000_000;
const MAX_DIAGNOSTIC_COLUMN: u32 = 1_000_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct DiagnosticPosition {
    line: u32,
    column: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct DiagnosticRangeInput {
    start: DiagnosticPosition,
    end: DiagnosticPosition,
}

fn diagnostic_position_before_or_equal(
    left: DiagnosticPosition,
    right: DiagnosticPosition,
) -> bool {
    left.line < right.line || (left.line == right.line && left.column <= right.column)
}

fn decode_diagnostic_range(value: &Value) -> Option<DiagnosticRangeInput> {
    let integer = |name: &str| {
        value
            .get(name)
            .and_then(Value::as_u64)
            .and_then(|item| u32::try_from(item).ok())
    };
    let range = DiagnosticRangeInput {
        start: DiagnosticPosition {
            line: integer("start_line")?,
            column: integer("start_column")?,
        },
        end: DiagnosticPosition {
            line: integer("end_line")?,
            column: integer("end_column")?,
        },
    };
    let bounded = [range.start, range.end].into_iter().all(|position| {
        position.line > 0
            && position.line <= MAX_DIAGNOSTIC_LINE
            && position.column > 0
            && position.column <= MAX_DIAGNOSTIC_COLUMN
    });
    (bounded
        && diagnostic_position_before_or_equal(range.start, range.end)
        && range.start != range.end)
        .then_some(range)
}

fn project_relative_diagnostic_source(arguments: &Value) -> bool {
    let Some(path) = arguments.get("source_path").and_then(Value::as_str) else {
        return false;
    };
    if path.is_empty()
        || path.starts_with('/')
        || path.starts_with('\\')
        || path.starts_with('<')
        || path.as_bytes().get(1) == Some(&b':')
    {
        return false;
    }
    !path
        .replace('\\', "/")
        .split('/')
        .any(|component| component.is_empty() || matches!(component, "." | ".."))
}

fn utf16_column_at_character_boundary(line: &str, one_based_column: u32) -> Option<u32> {
    let character_offset = usize::try_from(one_based_column.checked_sub(1)?).ok()?;
    if line.chars().count() < character_offset {
        return None;
    }
    let utf16_offset = line
        .chars()
        .take(character_offset)
        .map(char::len_utf16)
        .sum::<usize>();
    u32::try_from(utf16_offset).ok()?.checked_add(1)
}

fn translate_diagnostic_position(
    code_lines: &[&str],
    source_start: DiagnosticPosition,
    relative: DiagnosticPosition,
) -> Option<DiagnosticPosition> {
    let line_index = usize::try_from(relative.line.checked_sub(1)?).ok()?;
    let code_line = *code_lines.get(line_index)?;
    let relative_utf16_column = utf16_column_at_character_boundary(code_line, relative.column)?;
    let line = source_start
        .line
        .checked_add(relative.line.checked_sub(1)?)?;
    let column = if relative.line == 1 {
        source_start
            .column
            .checked_add(relative_utf16_column.checked_sub(1)?)?
    } else {
        relative_utf16_column
    };
    Some(DiagnosticPosition { line, column })
}

fn translated_run_error_range(arguments: &Value, result: &Value) -> Option<RunErrorRange> {
    if !project_relative_diagnostic_source(arguments) {
        return None;
    }
    let source_range = decode_diagnostic_range(arguments.get("source_range")?)?;
    let error = result.get("error")?;
    let range_kind = match (
        error.get("stage").and_then(Value::as_str),
        error.get("range_kind").and_then(Value::as_str),
    ) {
        (Some("evaluation"), Some("r_expression")) => "r_expression",
        (Some("parse"), Some("r_parse_token")) => "r_parse_token",
        _ => return None,
    };
    let relative_range = decode_diagnostic_range(error.get("source_range")?)?;
    let code = arguments.get("code").and_then(Value::as_str)?;
    let code_lines = code.split('\n').collect::<Vec<_>>();
    let start =
        translate_diagnostic_position(&code_lines, source_range.start, relative_range.start)?;
    let end = translate_diagnostic_position(&code_lines, source_range.start, relative_range.end)?;
    if !diagnostic_position_before_or_equal(source_range.start, start)
        || !diagnostic_position_before_or_equal(start, end)
        || start == end
        || !diagnostic_position_before_or_equal(end, source_range.end)
    {
        return None;
    }
    Some(RunErrorRange {
        start_line: start.line,
        start_column: start.column,
        end_line: end.line,
        end_column: end.column,
        range_kind: range_kind.to_string(),
    })
}

// Probe-shaped bridge results do not need an `ok` field. Only an explicit
// `ok: false` represents an R-level failure; missing status is successful.
fn workspace_result_failed(value: &Value) -> bool {
    value
        .get("ok")
        .and_then(Value::as_bool)
        .is_some_and(|ok| !ok)
}

fn json_string_list(value: &Value, key: &str) -> Vec<String> {
    value
        .get(key)
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .map(redact_sensitive_text)
        .collect()
}

fn normalized_path(path: &Path) -> String {
    path.to_string_lossy().replace('\\', "/")
}

fn r_string(value: &str) -> Result<String> {
    serde_json::to_string(value).context("quoting R string")
}

fn redact_sensitive_text(input: &str) -> String {
    let mut output = input.to_string();
    for name in ["key", "api_key", "apikey", "token", "access_token"] {
        for prefix in ["?", "&"] {
            output = redact_after_marker(&output, &format!("{prefix}{name}="), "& \t\r\n\"'");
        }
        for separator in [":\"", ": \""] {
            output = redact_after_marker(&output, &format!("\"{name}\"{separator}"), "\"\r\n");
        }
    }
    redact_after_marker(&output, "Bearer ", " \t\r\n\"'")
}

/// Applies the broker's credential redaction policy before externally sourced
/// project data enters the Agent context planner. The planner deliberately
/// applies the same policy again immediately before prompt assembly.
pub fn redact_agent_context_text(input: &str) -> String {
    redact_sensitive_text(input)
}

fn redact_after_marker(input: &str, marker: &str, terminators: &str) -> String {
    let mut output = String::with_capacity(input.len());
    let lower = input.to_ascii_lowercase();
    let marker_lower = marker.to_ascii_lowercase();
    let mut cursor = 0;
    while let Some(relative) = lower[cursor..].find(&marker_lower) {
        let start = cursor + relative;
        let value_start = start + marker.len();
        output.push_str(&input[cursor..value_start]);
        output.push_str("[REDACTED]");
        let value_end = input[value_start..]
            .find(|character| terminators.contains(character))
            .map_or(input.len(), |relative| value_start + relative);
        cursor = value_end;
    }
    output.push_str(&input[cursor..]);
    output
}

fn bridge_result_publisher(bridge_expression: &str, result_file: &ResultFile) -> Result<String> {
    let result_path = r_string(&normalized_path(&result_file.path))?;
    let temporary_path = r_string(&normalized_path(&result_file.temporary_path))?;
    let result_directory = r_string(&normalized_path(&result_file.directory))?;
    Ok(format!(
        r#"local({{
  result <- {bridge_expression}
  encode_json <- function(value) charToRaw(jsonlite::toJSON(
    value,
    auto_unbox = TRUE,
    null = "null",
    digits = NA
  ))
  publish_raw <- function(payload, temporary, target) {{
    connection <- file(temporary, open = "wb")
    on.exit(close(connection), add = TRUE)
    writeBin(payload, connection)
    close(connection)
    on.exit(NULL)
    published <- isTRUE(file.rename(temporary, target))
    if (!published && file.exists(temporary)) {{
      if (file.exists(target)) unlink(target, force = TRUE)
      published <- isTRUE(file.copy(temporary, target, overwrite = TRUE, copy.mode = FALSE))
      unlink(temporary, force = TRUE)
    }}
    if (!published || !file.exists(target)) {{
      stop(sprintf("Failed to publish the structured rho.bridge result to %s.", target), call. = FALSE)
    }}
    invisible(target)
  }}
  payload <- encode_json(result)
  if (length(payload) > 1048576L) {{
    named_result <- is.list(result) && !is.null(names(result)) &&
      length(names(result)) == length(result) && all(nzchar(names(result)))
    fields <- if (named_result) result else list(.rho.root = result)
    inline <- if (named_result) list() else NULL
    sidecars <- list()
    for (index in seq_along(fields)) {{
      field <- names(fields)[[index]]
      field_payload <- encode_json(fields[[index]])
      if (length(field_payload) <= 65536L && named_result) {{
        inline[[field]] <- fields[[index]]
      }} else {{
        file_name <- sprintf("field-%04d.json", index)
        target <- file.path({result_directory}, file_name)
        publish_raw(field_payload, paste0(target, ".tmp"), target)
        sidecars[[length(sidecars) + 1L]] <- list(
          field = field,
          file = file_name,
          bytes = length(field_payload),
          sha256 = unname(tools::sha256sum(target))
        )
      }}
    }}
    manifest <- list(
      rho_result_manifest_version = 2L,
      inline = inline,
      sidecars = sidecars
    )
    payload <- encode_json(manifest)
    if (length(payload) > 4194304L) {{
      root_name <- "field-root.json"
      root_target <- file.path({result_directory}, root_name)
      root_payload <- encode_json(result)
      publish_raw(root_payload, paste0(root_target, ".tmp"), root_target)
      manifest <- list(
        rho_result_manifest_version = 2L,
        inline = NULL,
        sidecars = list(list(
          field = ".rho.root",
          file = root_name,
          bytes = length(root_payload),
          sha256 = unname(tools::sha256sum(root_target))
        ))
      )
      payload <- encode_json(manifest)
    }}
  }}
  publish_raw(payload, {temporary_path}, {result_path})
  invisible(NULL)
}})"#
    ))
}

async fn execute_bridge_result_expression(
    session: &ArkSession,
    bridge_expression: &str,
) -> Result<Value> {
    let result_file = ResultFile::new(&format!("bridge_probe_{}", Uuid::new_v4()))?;
    let bridge_call = bridge_result_publisher(bridge_expression, &result_file)?;
    let mut kernel_events = Vec::new();
    session
        .execute(bridge_call, |event| {
            kernel_events.push(event.clone());
            Ok(())
        })
        .await
        .and_then(|_| ensure_no_kernel_errors(&kernel_events))?;
    result_file.read_json()
}

#[derive(Debug, serde::Deserialize)]
struct ResultManifestV2 {
    rho_result_manifest_version: u8,
    inline: Value,
    sidecars: Vec<ResultSidecarV2>,
}

#[derive(Debug, serde::Deserialize)]
struct ResultSidecarV2 {
    field: String,
    file: String,
    bytes: u64,
    sha256: String,
}

const MAX_RESULT_SIDECAR_BYTES: u64 = 512 * 1024 * 1024;
const MAX_RESULT_SIDECAR_TOTAL_BYTES: u64 = 1024 * 1024 * 1024;

fn decode_result_manifest_v2(directory: &Path, manifest: Value) -> Result<Value> {
    let manifest: ResultManifestV2 =
        serde_json::from_value(manifest).context("decoding Workspace R result manifest V2")?;
    ensure!(
        manifest.rho_result_manifest_version == 2,
        "unsupported Workspace R result manifest version"
    );
    ensure!(
        !manifest.sidecars.is_empty() && manifest.sidecars.len() <= 256,
        "Workspace R result manifest has an invalid sidecar count"
    );
    let root_sidecar = manifest.sidecars.len() == 1 && manifest.sidecars[0].field == ".rho.root";
    let mut output = if root_sidecar {
        ensure!(
            manifest.inline.is_null(),
            "root sidecar manifest must not include inline fields"
        );
        None
    } else {
        Some(
            manifest
                .inline
                .as_object()
                .cloned()
                .context("Workspace R result manifest inline fields must be an object")?,
        )
    };
    let canonical_directory = directory.canonicalize().with_context(|| {
        format!(
            "resolving Workspace R result directory {}",
            directory.display()
        )
    })?;
    let mut total_bytes = 0_u64;
    let mut fields = HashSet::new();
    for sidecar in manifest.sidecars {
        ensure!(
            !sidecar.field.is_empty()
                && sidecar.field.len() <= 256
                && fields.insert(sidecar.field.clone()),
            "Workspace R result manifest has a duplicate or invalid field"
        );
        ensure!(
            sidecar.file.len() <= 64
                && sidecar.file.starts_with("field-")
                && sidecar.file.ends_with(".json")
                && sidecar
                    .file
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'.')),
            "Workspace R result sidecar name is invalid"
        );
        ensure!(
            sidecar.bytes <= MAX_RESULT_SIDECAR_BYTES,
            "Workspace R result sidecar exceeds the host import budget"
        );
        total_bytes = total_bytes.saturating_add(sidecar.bytes);
        ensure!(
            total_bytes <= MAX_RESULT_SIDECAR_TOTAL_BYTES,
            "Workspace R result sidecars exceed the host import budget"
        );
        ensure!(
            sidecar.sha256.len() == 64
                && sidecar.sha256.bytes().all(|byte| byte.is_ascii_hexdigit()),
            "Workspace R result sidecar digest is invalid"
        );
        let path = directory.join(&sidecar.file);
        let metadata = fs::symlink_metadata(&path)
            .with_context(|| format!("reading Workspace R result sidecar {}", path.display()))?;
        ensure!(
            metadata.file_type().is_file() && !metadata.file_type().is_symlink(),
            "Workspace R result sidecar is not a regular non-symlink file"
        );
        ensure!(
            metadata.len() == sidecar.bytes,
            "Workspace R result sidecar size does not match its manifest"
        );
        let canonical = path
            .canonicalize()
            .with_context(|| format!("resolving Workspace R result sidecar {}", path.display()))?;
        ensure!(
            canonical.parent() == Some(canonical_directory.as_path()),
            "Workspace R result sidecar resolves outside its execution directory"
        );
        let mut file = fs::File::open(&canonical).with_context(|| {
            format!("opening Workspace R result sidecar {}", canonical.display())
        })?;
        let mut bytes = Vec::with_capacity(usize::try_from(sidecar.bytes).unwrap_or(0));
        file.by_ref()
            .take(sidecar.bytes.saturating_add(1))
            .read_to_end(&mut bytes)?;
        ensure!(
            bytes.len() as u64 == sidecar.bytes,
            "Workspace R result sidecar changed during import"
        );
        ensure!(
            sha256_hex(&bytes).eq_ignore_ascii_case(&sidecar.sha256),
            "Workspace R result sidecar digest does not match its manifest"
        );
        let value: Value = serde_json::from_slice(&bytes).with_context(|| {
            format!(
                "decoding Workspace R result sidecar field {}",
                sidecar.field
            )
        })?;
        if root_sidecar {
            return Ok(value);
        }
        let object = output.as_mut().expect("non-root manifest has an object");
        ensure!(
            !object.contains_key(&sidecar.field),
            "Workspace R result field appears in both inline and sidecar data"
        );
        object.insert(sidecar.field, value);
    }
    Ok(Value::Object(output.unwrap_or_default()))
}

struct ResultFile {
    directory: PathBuf,
    path: PathBuf,
    temporary_path: PathBuf,
}

impl ResultFile {
    fn new(execution_id: &str) -> Result<Self> {
        let base = std::env::temp_dir().join("rho").join("bridge-results");
        fs::create_dir_all(&base)
            .with_context(|| format!("creating bridge result directory {}", base.display()))?;
        let identity = sha256_hex(execution_id.as_bytes());
        let directory = base.join(format!("{}-{}", &identity[..12], Uuid::new_v4().simple()));
        fs::create_dir(&directory).with_context(|| {
            format!(
                "creating execution result directory {}",
                directory.display()
            )
        })?;
        Ok(Self {
            path: directory.join("result.json"),
            temporary_path: directory.join("result.json.tmp"),
            directory,
        })
    }

    fn read_json(&self) -> Result<Value> {
        let target = if self.path.is_file() {
            &self.path
        } else if self.temporary_path.is_file() {
            &self.temporary_path
        } else {
            bail!(
                "Workspace R did not publish structured result {} or fallback {}",
                self.path.display(),
                self.temporary_path.display()
            );
        };
        let metadata = fs::symlink_metadata(target)
            .with_context(|| format!("reading Workspace R result metadata {}", target.display()))?;
        ensure!(
            metadata.file_type().is_file() && !metadata.file_type().is_symlink(),
            "Workspace R result is not a regular non-symlink file"
        );
        let mut file = fs::File::open(target)
            .with_context(|| format!("opening Workspace R result {}", target.display()))?;
        let value = read_bounded_json(&mut file)
            .with_context(|| format!("reading Workspace R result {}", target.display()))?;
        if value
            .get("rho_result_manifest_version")
            .and_then(Value::as_u64)
            == Some(2)
            && value.get("sidecars").is_some()
        {
            decode_result_manifest_v2(&self.directory, value)
        } else {
            Ok(value)
        }
    }
}

fn read_bounded_json(mut reader: impl Read) -> Result<Value> {
    let mut bytes = Vec::new();
    reader
        .by_ref()
        .take((MAX_FRAME_BYTES + 1) as u64)
        .read_to_end(&mut bytes)?;
    ensure!(
        bytes.len() <= MAX_FRAME_BYTES,
        "Workspace R result exceeds {} bytes",
        MAX_FRAME_BYTES
    );
    serde_json::from_slice(&bytes).context("decoding structured Workspace R result")
}

impl Drop for ResultFile {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.directory);
    }
}
