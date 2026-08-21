//! Local-only authoring tools for project-scoped Rho plugins.
//!
//! This crate deliberately reuses the accepted runtime parser, package digest,
//! snapshot, Wasm host, schema, and trusted command-result contracts. It owns
//! no product runtime, permission, persistence, desktop, install, or release
//! authority.

use std::fmt;
use std::fs::{self, File};
use std::io::Read;
use std::path::{Component, Path, PathBuf};

use rho_extension_runtime::{
    ActivationGeneration, ContributionKind, GuestStep, HOST_PROTOCOL_VERSION, HostFrame,
    HostInstanceId, HostMessage, HostRequestId, HostResponse, MANIFEST_NAME, MAX_MANIFEST_BYTES,
    MAX_PACKAGE_FILE_BYTES, PLUGINS_DIR, PluginCommandResultV1, RuntimeKind, ScopeId,
    WasmHostIdentity, WasmPluginHost, WorkspacePluginManifest, discover_workspace_plugins,
    snapshot_workspace_plugin_package,
};
use serde::Serialize;
use serde_json::json;

const WAT_SOURCE: &str = "src/plugin.wat";
const MAX_DIAGNOSTIC_BYTES: usize = 1024;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PluginDevError {
    code: &'static str,
    message: String,
}

impl PluginDevError {
    fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: bounded_single_line(message.into()),
        }
    }

    pub fn code(&self) -> &'static str {
        self.code
    }

    pub fn message(&self) -> &str {
        &self.message
    }
}

impl fmt::Display for PluginDevError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "{}: {}", self.code, self.message)
    }
}

impl std::error::Error for PluginDevError {}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct PluginCheckItem {
    pub plugin_id: String,
    pub version: String,
    pub digest: String,
    pub runtime_kind: String,
    pub contribution_count: usize,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ProjectCheckReport {
    pub project_root: String,
    pub plugins: Vec<PluginCheckItem>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct BuildReport {
    pub built_plugins: Vec<String>,
    pub check: ProjectCheckReport,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct CommandSmokeReport {
    pub plugin_id: String,
    pub contribution_id: String,
    pub digest: String,
    pub guest_abi: u64,
    pub result: serde_json::Value,
}

pub fn build_project(project_root: &Path) -> Result<BuildReport, PluginDevError> {
    let project_root = checked_project_root(project_root)?;
    let plugins_root = project_root.join(PLUGINS_DIR);
    ensure_real_directory(&plugins_root, "plugin_root_rejected")?;
    let mut directories = read_directories(&plugins_root)?;
    directories.sort_by_key(|entry| entry.file_name());
    if directories.is_empty() {
        return Err(PluginDevError::new(
            "no_plugins",
            "the project plugin root contains no plugin directories",
        ));
    }

    let mut built_plugins = Vec::new();
    for directory in directories {
        let plugin_root = directory.path();
        ensure_real_directory(&plugin_root, "plugin_directory_rejected")?;
        let manifest_path = plugin_root.join(MANIFEST_NAME);
        let manifest = read_manifest(&manifest_path)?;
        if manifest.runtime.kind != RuntimeKind::Wasm {
            return Err(PluginDevError::new(
                "unsupported_runtime",
                format!("plugin {} does not use the Wasm runtime", manifest.id),
            ));
        }
        let source = plugin_root.join(WAT_SOURCE);
        match fs::symlink_metadata(&source) {
            Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_file() => {
                return Err(PluginDevError::new(
                    "wat_source_rejected",
                    format!("plugin {} WAT source is not a real file", manifest.id),
                ));
            }
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(error) => {
                return Err(PluginDevError::new(
                    "wat_source_rejected",
                    format!("cannot inspect plugin {} WAT source: {error}", manifest.id),
                ));
            }
        }
        let wat = read_bounded(&source, MAX_PACKAGE_FILE_BYTES, "wat_source_rejected")?;
        let wasm = wat::parse_bytes(&wat).map_err(|error| {
            PluginDevError::new(
                "wat_compile_failed",
                format!("plugin {} WAT is invalid: {error}", manifest.id),
            )
        })?;
        let entry = safe_entry_path(&plugin_root, &manifest)?;
        if entry == source {
            return Err(PluginDevError::new(
                "entry_path_rejected",
                "manifest entry must not overwrite the WAT source",
            ));
        }
        write_generated_entry(&plugin_root, &entry, wasm.as_ref())?;
        built_plugins.push(manifest.id.to_string());
    }
    if built_plugins.is_empty() {
        return Err(PluginDevError::new(
            "no_wat_sources",
            format!("no plugin contains {WAT_SOURCE}"),
        ));
    }

    let check = check_project(&project_root)?;
    Ok(BuildReport {
        built_plugins,
        check,
    })
}

pub fn check_project(project_root: &Path) -> Result<ProjectCheckReport, PluginDevError> {
    let project_root = checked_project_root(project_root)?;
    let report = discover_workspace_plugins(&project_root)
        .map_err(|error| PluginDevError::new("discovery_failed", error.to_string()))?
        .ok_or_else(|| {
            PluginDevError::new("plugin_root_missing", format!("{} is missing", PLUGINS_DIR))
        })?;
    if !report.failures.is_empty() {
        let first = &report.failures[0];
        return Err(PluginDevError::new(
            "discovery_rejected",
            format!(
                "{} package failure(s); first at {}: {}",
                report.failures.len(),
                first.path,
                first.reason
            ),
        ));
    }
    if report.plugins.is_empty() {
        return Err(PluginDevError::new(
            "no_plugins",
            "the project plugin root contains no valid plugins",
        ));
    }

    let mut plugins = Vec::with_capacity(report.plugins.len());
    for plugin in report.plugins {
        snapshot_workspace_plugin_package(
            &project_root,
            plugin.manifest.id.as_str(),
            &plugin.digest,
        )
        .map_err(|error| PluginDevError::new("snapshot_rejected", error.to_string()))?;
        plugins.push(PluginCheckItem {
            plugin_id: plugin.manifest.id.to_string(),
            version: plugin.manifest.version.to_string(),
            digest: plugin.digest.to_string(),
            runtime_kind: plugin.manifest.runtime.kind.to_string(),
            contribution_count: plugin.manifest.contributions.len(),
        });
    }
    plugins.sort_by(|left, right| left.plugin_id.cmp(&right.plugin_id));
    Ok(ProjectCheckReport {
        project_root: project_root.to_string_lossy().into_owned(),
        plugins,
    })
}

pub fn smoke_command(
    project_root: &Path,
    plugin_id: &str,
    contribution_id: &str,
) -> Result<CommandSmokeReport, PluginDevError> {
    let project_root = checked_project_root(project_root)?;
    check_project(&project_root)?;
    let report = discover_workspace_plugins(&project_root)
        .map_err(|error| PluginDevError::new("discovery_failed", error.to_string()))?
        .ok_or_else(|| PluginDevError::new("plugin_root_missing", PLUGINS_DIR))?;
    if !report.failures.is_empty() {
        let first = &report.failures[0];
        return Err(PluginDevError::new(
            "discovery_rejected",
            format!("{}: {}", first.path, first.reason),
        ));
    }
    let plugin = report
        .plugins
        .into_iter()
        .find(|plugin| plugin.manifest.id.as_str() == plugin_id)
        .ok_or_else(|| {
            PluginDevError::new("plugin_not_found", format!("unknown plugin {plugin_id}"))
        })?;
    if !plugin.manifest.permissions.is_empty() {
        return Err(PluginDevError::new(
            "permissions_not_supported",
            "local F1 smoke accepts only zero-permission packages",
        ));
    }
    let contribution = plugin
        .manifest
        .contributions
        .iter()
        .find(|contribution| contribution.id.as_str() == contribution_id)
        .ok_or_else(|| {
            PluginDevError::new(
                "contribution_not_found",
                format!("unknown contribution {contribution_id}"),
            )
        })?;
    if contribution.kind != ContributionKind::Command {
        return Err(PluginDevError::new(
            "contribution_not_command",
            format!("{contribution_id} is not a Command contribution"),
        ));
    }
    let input = json!({});
    contribution
        .input_schema
        .as_ref()
        .ok_or_else(|| PluginDevError::new("input_schema_missing", contribution_id))?
        .validate_instance(&input)
        .map_err(|error| PluginDevError::new("empty_input_rejected", error.to_string()))?;
    let output_schema = contribution
        .output_schema
        .as_ref()
        .ok_or_else(|| PluginDevError::new("output_schema_missing", contribution_id))?;
    let snapshot = snapshot_workspace_plugin_package(
        &project_root,
        plugin.manifest.id.as_str(),
        &plugin.digest,
    )
    .map_err(|error| PluginDevError::new("snapshot_rejected", error.to_string()))?;
    let module = snapshot
        .file_bytes(&plugin.manifest.runtime.entry)
        .ok_or_else(|| PluginDevError::new("entry_missing", &plugin.manifest.runtime.entry))?;
    let identity = WasmHostIdentity::new(
        ScopeId::new("plugin-dev.local")
            .map_err(|error| PluginDevError::new("identity_failed", error.to_string()))?,
        plugin.manifest.id.clone(),
        plugin.digest.clone(),
        ActivationGeneration::new(1)
            .map_err(|error| PluginDevError::new("identity_failed", error.to_string()))?,
        HostInstanceId::generate(),
    );
    let mut host = WasmPluginHost::from_bytes(identity, module)
        .map_err(|error| host_error("wasm_rejected", error))?;
    let ready = host
        .handle_frame(frame(
            &host,
            HostMessage::Hello {
                api_version: HOST_PROTOCOL_VERSION,
            },
        ))
        .map_err(|error| host_error("hello_rejected", error))?;
    if ready
        != Some(HostResponse::Ready {
            api_version: HOST_PROTOCOL_VERSION,
        })
    {
        return Err(PluginDevError::new(
            "hello_rejected",
            "guest did not acknowledge the current host protocol",
        ));
    }
    let activated = host
        .handle_frame(frame(&host, HostMessage::Activate))
        .map_err(|error| host_error("activation_rejected", error))?;
    if activated != Some(HostResponse::Activated) || host.guest_abi_version() != 2 {
        return Err(PluginDevError::new(
            "activation_rejected",
            "guest did not activate as Guest ABI V2",
        ));
    }
    let request_id = HostRequestId::generate();
    let call_result = (|| {
        let step = host
            .begin_contribution_call(
                request_id,
                json!({
                    "contribution": {
                        "id": contribution.id,
                        "contract_major": contribution.contract_major,
                    },
                    "project_id": "plugin-dev.local",
                    "plugin_id": plugin.manifest.id,
                    "package_digest": plugin.digest,
                    "activation_generation": 1,
                    "host_instance_id": host.identity().host_instance_id(),
                    "origin": "user_command",
                    "input": input,
                    "capability_handles": [],
                    "deadline_millis": 30000,
                }),
            )
            .map_err(|error| host_error("command_rejected", error))?;
        let result = match step {
            GuestStep::Complete { result, .. } => result,
            GuestStep::BrokerRequest { .. } => {
                return Err(PluginDevError::new(
                    "unexpected_broker_request",
                    "zero-permission Command requested a broker operation",
                ));
            }
            GuestStep::Error { code, .. } => {
                return Err(PluginDevError::new(
                    "guest_error",
                    format!("guest returned error code {code}"),
                ));
            }
        };
        output_schema
            .validate_instance(&result)
            .map_err(|error| PluginDevError::new("output_schema_rejected", error.to_string()))?;
        PluginCommandResultV1::parse(result.clone())
            .map_err(|error| PluginDevError::new("command_result_rejected", error.to_string()))?;
        Ok(result)
    })();
    let dispose_result = dispose_host(&mut host);
    let result = call_result?;
    dispose_result?;

    Ok(CommandSmokeReport {
        plugin_id: plugin_id.to_string(),
        contribution_id: contribution_id.to_string(),
        digest: snapshot.digest.to_string(),
        guest_abi: host.guest_abi_version(),
        result,
    })
}

fn checked_project_root(project_root: &Path) -> Result<PathBuf, PluginDevError> {
    let metadata = fs::symlink_metadata(project_root).map_err(|error| {
        PluginDevError::new(
            "project_root_missing",
            format!("cannot inspect project root: {error}"),
        )
    })?;
    if !metadata.is_dir() {
        return Err(PluginDevError::new(
            "project_root_rejected",
            "project root must be a directory",
        ));
    }
    fs::canonicalize(project_root).map_err(|error| {
        PluginDevError::new(
            "project_root_rejected",
            format!("cannot canonicalize project root: {error}"),
        )
    })
}

fn ensure_real_directory(path: &Path, code: &'static str) -> Result<(), PluginDevError> {
    let metadata = fs::symlink_metadata(path)
        .map_err(|error| PluginDevError::new(code, format!("cannot inspect directory: {error}")))?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(PluginDevError::new(code, "expected a real directory"));
    }
    Ok(())
}

fn ensure_real_file(path: &Path, code: &'static str) -> Result<(), PluginDevError> {
    let metadata = fs::symlink_metadata(path)
        .map_err(|error| PluginDevError::new(code, format!("cannot inspect file: {error}")))?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err(PluginDevError::new(code, "expected a real file"));
    }
    Ok(())
}

fn read_directories(path: &Path) -> Result<Vec<fs::DirEntry>, PluginDevError> {
    fs::read_dir(path)
        .map_err(|error| {
            PluginDevError::new(
                "plugin_root_rejected",
                format!("cannot read plugin root: {error}"),
            )
        })?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| {
            PluginDevError::new(
                "plugin_root_rejected",
                format!("cannot enumerate plugin root: {error}"),
            )
        })
}

fn read_manifest(path: &Path) -> Result<WorkspacePluginManifest, PluginDevError> {
    ensure_real_file(path, "manifest_rejected")?;
    let bytes = read_bounded(path, MAX_MANIFEST_BYTES, "manifest_rejected")?;
    WorkspacePluginManifest::parse(&bytes)
        .map_err(|error| PluginDevError::new("manifest_rejected", error.to_string()))
}

fn read_bounded(
    path: &Path,
    maximum: usize,
    code: &'static str,
) -> Result<Vec<u8>, PluginDevError> {
    let file = File::open(path)
        .map_err(|error| PluginDevError::new(code, format!("cannot open file: {error}")))?;
    let mut bytes = Vec::new();
    file.take((maximum + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(|error| PluginDevError::new(code, format!("cannot read file: {error}")))?;
    if bytes.len() > maximum {
        return Err(PluginDevError::new(
            code,
            format!("file exceeds {maximum} bytes"),
        ));
    }
    Ok(bytes)
}

fn safe_entry_path(
    plugin_root: &Path,
    manifest: &WorkspacePluginManifest,
) -> Result<PathBuf, PluginDevError> {
    let relative = Path::new(&manifest.runtime.entry);
    if relative.is_absolute()
        || relative
            .components()
            .any(|component| !matches!(component, Component::Normal(_)))
    {
        return Err(PluginDevError::new(
            "entry_path_rejected",
            "manifest entry is not a normalized relative path",
        ));
    }
    Ok(plugin_root.join(relative))
}

fn write_generated_entry(
    plugin_root: &Path,
    entry: &Path,
    bytes: &[u8],
) -> Result<(), PluginDevError> {
    let parent = entry.parent().ok_or_else(|| {
        PluginDevError::new("entry_path_rejected", "manifest entry has no parent")
    })?;
    let relative_parent = parent.strip_prefix(plugin_root).map_err(|_| {
        PluginDevError::new("entry_path_rejected", "entry parent escaped the plugin")
    })?;
    let mut current = plugin_root.to_path_buf();
    for component in relative_parent.components() {
        let Component::Normal(component) = component else {
            return Err(PluginDevError::new(
                "entry_path_rejected",
                "entry parent is not normalized",
            ));
        };
        current.push(component);
        match fs::symlink_metadata(&current) {
            Ok(metadata) => {
                if metadata.file_type().is_symlink() || !metadata.is_dir() {
                    return Err(PluginDevError::new(
                        "entry_path_rejected",
                        "entry parent contains a symlink or non-directory",
                    ));
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                fs::create_dir(&current).map_err(|error| {
                    PluginDevError::new(
                        "entry_write_failed",
                        format!("cannot create entry directory: {error}"),
                    )
                })?;
            }
            Err(error) => {
                return Err(PluginDevError::new(
                    "entry_path_rejected",
                    format!("cannot inspect entry directory: {error}"),
                ));
            }
        }
    }
    match fs::symlink_metadata(entry) {
        Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_file() => {
            return Err(PluginDevError::new(
                "entry_path_rejected",
                "existing entry is a symlink or non-file",
            ));
        }
        Ok(_) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => {
            return Err(PluginDevError::new(
                "entry_path_rejected",
                format!("cannot inspect existing entry: {error}"),
            ));
        }
    }
    let file_name = entry
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| {
            PluginDevError::new("entry_path_rejected", "entry filename is not valid UTF-8")
        })?;
    let temporary = parent.join(format!(".{file_name}.rho-plugin-dev.partial"));
    match fs::symlink_metadata(&temporary) {
        Ok(_) => {
            return Err(PluginDevError::new(
                "entry_write_failed",
                "a previous partial build remains; remove it after inspection",
            ));
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => {
            return Err(PluginDevError::new(
                "entry_write_failed",
                format!("cannot inspect temporary entry: {error}"),
            ));
        }
    }
    fs::write(&temporary, bytes).map_err(|error| {
        PluginDevError::new(
            "entry_write_failed",
            format!("cannot write temporary Wasm entry: {error}"),
        )
    })?;
    if let Err(error) = fs::rename(&temporary, entry) {
        let _ = fs::remove_file(&temporary);
        return Err(PluginDevError::new(
            "entry_write_failed",
            format!("cannot publish generated Wasm entry: {error}"),
        ));
    }
    Ok(())
}

fn frame(host: &WasmPluginHost, message: HostMessage) -> HostFrame {
    HostFrame {
        instance_id: host.identity().host_instance_id().clone(),
        message,
    }
}

fn host_error(
    code: &'static str,
    error: rho_extension_runtime::HostProtocolError,
) -> PluginDevError {
    PluginDevError::new(code, error.to_string())
}

fn dispose_host(host: &mut WasmPluginHost) -> Result<(), PluginDevError> {
    use rho_extension_runtime::HostInstanceState;

    if host.state() == HostInstanceState::Active {
        host.handle_frame(frame(host, HostMessage::Quiesce))
            .map_err(|error| host_error("quiesce_rejected", error))?;
    }
    if matches!(
        host.state(),
        HostInstanceState::Ready | HostInstanceState::Quiescing
    ) {
        host.handle_frame(frame(host, HostMessage::Dispose))
            .map_err(|error| host_error("dispose_rejected", error))?;
    }
    Ok(())
}

fn bounded_single_line(message: String) -> String {
    let mut bounded = String::with_capacity(message.len().min(MAX_DIAGNOSTIC_BYTES));
    let mut previous_space = false;
    for character in message.chars() {
        let character = if character.is_control() {
            ' '
        } else {
            character
        };
        if character == ' ' && previous_space {
            continue;
        }
        if bounded.len() + character.len_utf8() > MAX_DIAGNOSTIC_BYTES {
            break;
        }
        bounded.push(character);
        previous_space = character == ' ';
    }
    bounded.trim().to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn diagnostics_are_single_line_and_byte_bounded() {
        let error = PluginDevError::new(
            "fixture",
            format!("first\nsecond\t{}", "界".repeat(MAX_DIAGNOSTIC_BYTES)),
        );
        assert!(!error.message().contains(['\n', '\r', '\t']));
        assert!(error.message().len() <= MAX_DIAGNOSTIC_BYTES);
        assert!(error.message().starts_with("first second"));
    }
}
