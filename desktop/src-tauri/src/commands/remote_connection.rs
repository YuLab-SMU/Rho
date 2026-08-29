use std::collections::BTreeMap;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use anyhow::{Context, Result, bail, ensure};
use rho_toolchain::{
    ComputeHost, ComputeIsolation, ComputeTarget, LOCAL_TARGET_ID, load_target_registry,
    load_toolchain_config, validate_compute_target, validate_target_id,
};
use serde::{Deserialize, Serialize};
use tauri::State;
use tempfile::NamedTempFile;
use toml_edit::{Array, DocumentMut, Item, Value, value};
use zeroize::Zeroizing;

use crate::AppState;

const MAX_SSH_OUTPUT_BYTES: usize = 1024 * 1024;

#[derive(Deserialize, specta::Type)]
pub(crate) struct SshConnectionProbeRequest {
    host: String,
    port: u16,
    username: String,
    password: Option<String>,
    identity_file: Option<String>,
    confirmed_fingerprint: Option<String>,
}

#[derive(Debug, Clone, Serialize, specta::Type)]
pub(crate) struct SshHostFingerprintView {
    algorithm: String,
    sha256: String,
}

#[derive(Debug, Clone, Serialize, specta::Type)]
pub(crate) struct SlurmPartitionView {
    partition: String,
    available: String,
    nodes: String,
    gres: String,
    cpus: String,
}

#[derive(Debug, Clone, Serialize, specta::Type)]
pub(crate) struct SshConnectionProbeView {
    status: String,
    fingerprints: Vec<SshHostFingerprintView>,
    authenticated: bool,
    host_name: Option<String>,
    slurm_version: Option<String>,
    partitions: Vec<SlurmPartitionView>,
    helper_available: bool,
    message: String,
}

#[derive(Deserialize, specta::Type)]
pub(crate) struct ConfigureSshTargetRequest {
    target_id: String,
    host: String,
    port: u16,
    username: String,
    password: Option<String>,
    confirmed_fingerprint: String,
    remote_root: String,
    capabilities: Vec<String>,
    install_managed_key: bool,
    identity_file: Option<String>,
    select_for_project: bool,
}

#[derive(Debug, Clone, Serialize, specta::Type)]
pub(crate) struct ComputeTargetView {
    target_id: String,
    selected: bool,
    host_kind: String,
    host: Option<String>,
    port: Option<u16>,
    username: Option<String>,
    remote_root: Option<String>,
    isolation_kind: String,
    capabilities: Vec<String>,
    identity_file: Option<String>,
    identity_available: bool,
}

#[derive(Debug, Clone, Serialize, specta::Type)]
pub(crate) struct ComputeTargetListView {
    selected_target_id: String,
    targets_yaml: String,
    targets: Vec<ComputeTargetView>,
}

#[derive(Debug, Clone, Serialize, specta::Type)]
pub(crate) struct ConfigureSshTargetView {
    target: ComputeTargetView,
    probe: SshConnectionProbeView,
    project_selected: bool,
}

#[derive(Serialize)]
struct TargetRegistryWrite {
    schema: u16,
    targets: BTreeMap<String, ComputeTarget>,
}

struct ScannedHost {
    known_hosts: Vec<u8>,
    fingerprints: Vec<SshHostFingerprintView>,
}

fn bounded_token(label: &str, value: &str, maximum: usize) -> Result<String> {
    let value = value.trim();
    ensure!(
        !value.is_empty() && value.len() <= maximum && !value.chars().any(char::is_control),
        "{label} is invalid"
    );
    Ok(value.to_string())
}

fn scan_host(host: &str, port: u16) -> Result<ScannedHost> {
    let host = bounded_token("SSH host", host, 255)?;
    ensure!(port > 0, "SSH port must be positive");
    let scan = Command::new("ssh-keyscan")
        .args(["-T", "5", "-p", &port.to_string(), "--", &host])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .output()
        .context("starting ssh-keyscan")?;
    ensure!(
        scan.status.success()
            && !scan.stdout.is_empty()
            && scan.stdout.len() <= MAX_SSH_OUTPUT_BYTES,
        "The SSH host did not return a bounded host key"
    );
    let mut child = Command::new("ssh-keygen")
        .args(["-lf", "-", "-E", "sha256"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .context("starting ssh-keygen")?;
    child
        .stdin
        .as_mut()
        .context("opening ssh-keygen input")?
        .write_all(&scan.stdout)?;
    let output = child.wait_with_output()?;
    ensure!(
        output.status.success(),
        "Could not fingerprint the SSH host key"
    );
    let fingerprints = String::from_utf8_lossy(&output.stdout)
        .lines()
        .filter_map(|line| {
            let fields = line.split_whitespace().collect::<Vec<_>>();
            let sha256 = fields.get(1)?.strip_prefix("SHA256:")?;
            let algorithm = fields
                .last()
                .map(|value| value.trim_matches(['(', ')']).to_string())
                .unwrap_or_else(|| "unknown".to_string());
            Some(SshHostFingerprintView {
                algorithm,
                sha256: format!("SHA256:{sha256}"),
            })
        })
        .collect::<Vec<_>>();
    ensure!(
        !fingerprints.is_empty(),
        "SSH host fingerprints were unavailable"
    );
    Ok(ScannedHost {
        known_hosts: scan.stdout,
        fingerprints,
    })
}

fn askpass_script(password: &Zeroizing<String>) -> Result<NamedTempFile> {
    ensure!(!password.is_empty(), "SSH password is empty");
    let mut script = tempfile::Builder::new()
        .prefix("rho-ssh-askpass-")
        .suffix(if cfg!(windows) { ".cmd" } else { ".sh" })
        .tempfile()
        .context("creating the temporary SSH password bridge")?;
    if cfg!(windows) {
        script.write_all(b"@echo off\r\necho %RHO_SSH_PASSWORD%\r\n")?;
    } else {
        script.write_all(b"#!/bin/sh\nprintf '%s\\n' \"$RHO_SSH_PASSWORD\"\n")?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(script.path(), fs::Permissions::from_mode(0o700))?;
        }
    }
    script.flush()?;
    Ok(script)
}

fn shell_single_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

fn run_ssh(
    request: &SshConnectionProbeRequest,
    scan: &ScannedHost,
    remote_command: &str,
) -> Result<Vec<u8>> {
    let username = bounded_token("SSH username", &request.username, 128)?;
    let host = bounded_token("SSH host", &request.host, 255)?;
    let destination = format!("{username}@{host}");
    let mut known_hosts = NamedTempFile::new().context("creating known-host state")?;
    known_hosts.write_all(&scan.known_hosts)?;
    known_hosts.flush()?;

    let password = request
        .password
        .as_ref()
        .filter(|value| !value.is_empty())
        .map(|value| Zeroizing::new(value.clone()));
    let askpass = password.as_ref().map(askpass_script).transpose()?;
    let mut command = Command::new("ssh");
    command.args([
        "-T",
        "-o",
        "StrictHostKeyChecking=yes",
        "-o",
        &format!("UserKnownHostsFile={}", known_hosts.path().display()),
        "-o",
        "ConnectTimeout=10",
        "-o",
        "ServerAliveInterval=5",
        "-o",
        "ServerAliveCountMax=1",
    ]);
    if let Some(identity_file) = request
        .identity_file
        .as_deref()
        .filter(|value| !value.trim().is_empty())
    {
        command.arg("-i").arg(identity_file);
    }
    if let (Some(password), Some(askpass)) = (password.as_ref(), askpass.as_ref()) {
        command
            .args(["-o", "BatchMode=no", "-o", "NumberOfPasswordPrompts=1"])
            .env("SSH_ASKPASS", askpass.path())
            .env("SSH_ASKPASS_REQUIRE", "force")
            .env("DISPLAY", "rho-ssh-askpass:0")
            .env("RHO_SSH_PASSWORD", password.as_str());
    } else {
        command.args(["-o", "BatchMode=yes"]);
    }
    let output = command
        .arg("-p")
        .arg(request.port.to_string())
        .arg("--")
        .arg(destination)
        .arg(remote_command)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .context("starting SSH connection")?;
    ensure!(
        output.stdout.len() <= MAX_SSH_OUTPUT_BYTES && output.stderr.len() <= MAX_SSH_OUTPUT_BYTES,
        "SSH output exceeded its safety bound"
    );
    if !output.status.success() {
        bail!("SSH authentication or remote inspection failed");
    }
    Ok(output.stdout)
}

fn static_probe_command() -> &'static str {
    "printf 'RHO_HOST\\t%s\\n' \"$(hostname)\"; if command -v sinfo >/dev/null 2>&1; then printf 'RHO_SLURM\\t%s\\n' \"$(sinfo --version | head -1)\"; sinfo -h -o 'RHO_PARTITION|%P|%a|%D|%G|%C' | head -32; fi; if command -v rho-toolchain-helper >/dev/null 2>&1; then printf 'RHO_HELPER\\tready\\n'; else printf 'RHO_HELPER\\tmissing\\n'; fi"
}

fn parse_probe(scan: &ScannedHost, output: &[u8]) -> SshConnectionProbeView {
    let mut host_name = None;
    let mut slurm_version = None;
    let mut helper_available = false;
    let mut partitions = Vec::new();
    for line in String::from_utf8_lossy(output).lines() {
        let fields = if line.starts_with("RHO_PARTITION|") {
            line.split('|').collect::<Vec<_>>()
        } else {
            line.split('\t').collect::<Vec<_>>()
        };
        match fields.as_slice() {
            ["RHO_HOST", value] => host_name = Some((*value).to_string()),
            ["RHO_SLURM", value] => slurm_version = Some((*value).to_string()),
            ["RHO_HELPER", "ready"] => helper_available = true,
            ["RHO_PARTITION", partition, available, nodes, gres, cpus] => {
                partitions.push(SlurmPartitionView {
                    partition: partition.trim_end_matches('*').to_string(),
                    available: (*available).to_string(),
                    nodes: (*nodes).to_string(),
                    gres: (*gres).to_string(),
                    cpus: (*cpus).to_string(),
                });
            }
            _ => {}
        }
    }
    SshConnectionProbeView {
        status: "ready".to_string(),
        fingerprints: scan.fingerprints.clone(),
        authenticated: true,
        host_name,
        slurm_version,
        partitions,
        helper_available,
        message: if helper_available {
            "SSH and the Rho remote Helper are ready.".to_string()
        } else {
            "SSH is ready. Install the Rho remote Helper before remote execution.".to_string()
        },
    }
}

fn probe_connection(request: &SshConnectionProbeRequest) -> Result<SshConnectionProbeView> {
    let scan = scan_host(&request.host, request.port)?;
    let Some(confirmed) = request
        .confirmed_fingerprint
        .as_deref()
        .filter(|value| !value.trim().is_empty())
    else {
        return Ok(SshConnectionProbeView {
            status: "host_key_confirmation_required".to_string(),
            fingerprints: scan.fingerprints,
            authenticated: false,
            host_name: None,
            slurm_version: None,
            partitions: Vec::new(),
            helper_available: false,
            message: "Confirm one discovered host fingerprint before authentication.".to_string(),
        });
    };
    ensure!(
        scan.fingerprints
            .iter()
            .any(|value| value.sha256 == confirmed),
        "Confirmed SSH fingerprint is not currently offered by this host"
    );
    let output = run_ssh(request, &scan, static_probe_command())?;
    Ok(parse_probe(&scan, &output))
}

fn managed_key_path(rho_home: &Path, target_id: &str) -> PathBuf {
    rho_home.join("ssh").join(target_id).join("id_ed25519")
}

fn ensure_managed_key(rho_home: &Path, target_id: &str) -> Result<PathBuf> {
    validate_target_id(target_id)?;
    let identity = managed_key_path(rho_home, target_id);
    if identity.is_file() && identity.with_extension("pub").is_file() {
        return Ok(identity);
    }
    let directory = identity
        .parent()
        .context("managed SSH key directory is unavailable")?;
    fs::create_dir_all(directory)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(directory, fs::Permissions::from_mode(0o700))?;
    }
    let output = Command::new("ssh-keygen")
        .args([
            "-q",
            "-t",
            "ed25519",
            "-N",
            "",
            "-C",
            &format!("rho:{target_id}"),
            "-f",
        ])
        .arg(&identity)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .output()
        .context("generating a managed SSH key")?;
    ensure!(
        output.status.success(),
        "Could not generate the managed SSH key"
    );
    Ok(identity)
}

fn install_public_key(
    request: &SshConnectionProbeRequest,
    scan: &ScannedHost,
    identity_file: &Path,
) -> Result<()> {
    ensure!(
        request
            .password
            .as_deref()
            .is_some_and(|value| !value.is_empty()),
        "A one-time password is required to install the managed key"
    );
    let public_key = fs::read_to_string(identity_file.with_extension("pub"))?;
    let public_key = public_key.trim();
    ensure!(
        public_key.len() <= 16 * 1024
            && public_key.starts_with("ssh-ed25519 ")
            && !public_key.chars().any(|value| matches!(value, '\r' | '\n')),
        "Managed public key is invalid"
    );
    let remote_command = format!(
        "umask 077; mkdir -p \"$HOME/.ssh\"; touch \"$HOME/.ssh/authorized_keys\"; chmod 700 \"$HOME/.ssh\"; chmod 600 \"$HOME/.ssh/authorized_keys\"; grep -qxF {key} \"$HOME/.ssh/authorized_keys\" || printf '%s\\n' {key} >> \"$HOME/.ssh/authorized_keys\"",
        key = shell_single_quote(public_key),
    );
    run_ssh(request, scan, &remote_command)?;
    Ok(())
}

fn write_target_registry(
    rho_home: &Path,
    target_id: &str,
    target: ComputeTarget,
) -> Result<ComputeTarget> {
    validate_compute_target(target_id, &target)?;
    let current = load_target_registry(rho_home)?;
    let mut targets = current.registry.targets;
    targets.remove(LOCAL_TARGET_ID);
    targets.insert(target_id.to_string(), target.clone());
    let source = serde_norway::to_string(&TargetRegistryWrite { schema: 1, targets })?;
    fs::create_dir_all(rho_home)?;
    let path = rho_home.join("targets.yaml");
    if path.exists() && fs::symlink_metadata(&path)?.file_type().is_symlink() {
        bail!("targets.yaml must not be a symbolic link");
    }
    crate::project::atomic_write(&path, source.as_bytes())?;
    load_target_registry(rho_home)?;
    Ok(target)
}

fn select_project_target(
    project_root: &Path,
    target_id: &str,
    capabilities: &[String],
) -> Result<()> {
    let config = load_toolchain_config(project_root)?;
    let source = fs::read_to_string(&config.path)?;
    let mut document = source
        .parse::<DocumentMut>()
        .context("parsing rho.toml for target selection")?;
    document["schema"] = value(2);
    document["compute"]["default_target"] = value(target_id);
    let mut required = Array::new();
    for capability in capabilities {
        required.push(capability.as_str());
    }
    document["compute"]["required_capabilities"] = Item::Value(Value::Array(required));
    crate::project::atomic_write(&config.path, document.to_string().as_bytes())?;
    load_toolchain_config(project_root)?;
    Ok(())
}

fn target_view(
    target_id: &str,
    target: &ComputeTarget,
    selected_target_id: &str,
) -> ComputeTargetView {
    match &target.host {
        ComputeHost::Local => ComputeTargetView {
            target_id: target_id.to_string(),
            selected: target_id == selected_target_id,
            host_kind: "local".to_string(),
            host: None,
            port: None,
            username: None,
            remote_root: None,
            isolation_kind: target.isolation_kind().to_string(),
            capabilities: target.capabilities.clone(),
            identity_file: None,
            identity_available: true,
        },
        ComputeHost::Ssh {
            host,
            username,
            port,
            remote_root,
            identity_file,
            ..
        } => ComputeTargetView {
            target_id: target_id.to_string(),
            selected: target_id == selected_target_id,
            host_kind: "ssh".to_string(),
            host: Some(host.clone()),
            port: Some(*port),
            username: username.clone(),
            remote_root: Some(remote_root.clone()),
            isolation_kind: target.isolation_kind().to_string(),
            capabilities: target.capabilities.clone(),
            identity_file: identity_file.clone(),
            identity_available: identity_file
                .as_ref()
                .is_some_and(|value| Path::new(value).is_file()),
        },
    }
}

#[cfg_attr(test, specta::specta)]
#[tauri::command]
pub(crate) async fn compute_target_list(
    state: State<'_, AppState>,
) -> Result<ComputeTargetListView, String> {
    let project_root = state.project_root.read().await.clone();
    let rho_home = crate::agent_llm::agent_config::rho_home().map_err(crate::display_error)?;
    tauri::async_runtime::spawn_blocking(move || {
        let targets = load_target_registry(&rho_home)?;
        let selected_target_id = load_toolchain_config(&project_root)
            .map(|config| config.config.compute.default_target)
            .unwrap_or_else(|_| LOCAL_TARGET_ID.to_string());
        Ok::<_, anyhow::Error>(ComputeTargetListView {
            selected_target_id: selected_target_id.clone(),
            targets_yaml: targets.path.to_string_lossy().into_owned(),
            targets: targets
                .registry
                .targets
                .iter()
                .map(|(target_id, target)| target_view(target_id, target, &selected_target_id))
                .collect(),
        })
    })
    .await
    .map_err(|error| format!("Compute target list task failed: {error}"))?
    .map_err(crate::display_error)
}

#[cfg_attr(test, specta::specta)]
#[tauri::command]
pub(crate) async fn remote_connection_probe(
    request: SshConnectionProbeRequest,
) -> Result<SshConnectionProbeView, String> {
    tauri::async_runtime::spawn_blocking(move || probe_connection(&request))
        .await
        .map_err(|error| format!("SSH probe task failed: {error}"))?
        .map_err(crate::display_error)
}

#[cfg_attr(test, specta::specta)]
#[tauri::command]
pub(crate) async fn configure_ssh_target(
    request: ConfigureSshTargetRequest,
    state: State<'_, AppState>,
) -> Result<ConfigureSshTargetView, String> {
    let project_root = state.project_root.read().await.clone();
    let rho_home = crate::agent_llm::agent_config::rho_home().map_err(crate::display_error)?;
    tauri::async_runtime::spawn_blocking(move || {
        let target_id = bounded_token("Target ID", &request.target_id, 128)?;
        validate_target_id(&target_id)?;
        let host = bounded_token("SSH host", &request.host, 255)?;
        let username = bounded_token("SSH username", &request.username, 128)?;
        let remote_root = bounded_token("Remote project root", &request.remote_root, 1024)?;
        ensure!(
            remote_root.starts_with('/'),
            "Remote project root must be absolute"
        );
        let scan = scan_host(&host, request.port)?;
        ensure!(
            scan.fingerprints
                .iter()
                .any(|value| value.sha256 == request.confirmed_fingerprint),
            "Confirmed SSH fingerprint is no longer offered by the host"
        );
        let identity_file = if request.install_managed_key {
            let identity = ensure_managed_key(&rho_home, &target_id)?;
            let bootstrap = SshConnectionProbeRequest {
                host: host.clone(),
                port: request.port,
                username: username.clone(),
                password: request.password,
                identity_file: None,
                confirmed_fingerprint: Some(request.confirmed_fingerprint.clone()),
            };
            install_public_key(&bootstrap, &scan, &identity)?;
            Some(identity.to_string_lossy().into_owned())
        } else {
            request
                .identity_file
                .filter(|value| !value.trim().is_empty())
        };
        let probe_request = SshConnectionProbeRequest {
            host: host.clone(),
            port: request.port,
            username: username.clone(),
            password: None,
            identity_file: identity_file.clone(),
            confirmed_fingerprint: Some(request.confirmed_fingerprint.clone()),
        };
        let probe = probe_connection(&probe_request)?;
        ensure!(
            probe.authenticated,
            "Managed-key SSH authentication did not become ready"
        );
        let target = write_target_registry(
            &rho_home,
            &target_id,
            ComputeTarget {
                host: ComputeHost::Ssh {
                    host,
                    username: Some(username),
                    port: request.port,
                    host_fingerprint: request.confirmed_fingerprint,
                    remote_root,
                    identity_file,
                },
                isolation: ComputeIsolation::Native,
                capabilities: request.capabilities.clone(),
            },
        )?;
        let project_selected = request.select_for_project && probe.helper_available;
        if project_selected {
            select_project_target(&project_root, &target_id, &request.capabilities)?;
        }
        Ok::<_, anyhow::Error>(ConfigureSshTargetView {
            target: target_view(
                &target_id,
                &target,
                if project_selected {
                    &target_id
                } else {
                    LOCAL_TARGET_ID
                },
            ),
            probe,
            project_selected,
        })
    })
    .await
    .map_err(|error| format!("SSH target configuration task failed: {error}"))?
    .map_err(crate::display_error)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_bounded_slurm_probe_without_exposing_credentials() {
        let scan = ScannedHost {
            known_hosts: Vec::new(),
            fingerprints: vec![SshHostFingerprintView {
                algorithm: "ED25519".to_string(),
                sha256: "SHA256:test".to_string(),
            }],
        };
        let view = parse_probe(
            &scan,
            b"RHO_HOST\tmaster\nRHO_SLURM\tslurm 19.05.2\nRHO_PARTITION|gpu_batch*|up|1|gpu:3|2/46/0/48\nRHO_HELPER\tmissing\n",
        );
        assert!(view.authenticated);
        assert_eq!(view.host_name.as_deref(), Some("master"));
        assert_eq!(view.partitions[0].partition, "gpu_batch");
        assert!(!view.helper_available);
    }

    #[test]
    fn gui_target_save_and_project_selection_preserve_runtime_configuration() {
        let rho_home = tempfile::tempdir().unwrap();
        let project = tempfile::tempdir().unwrap();
        fs::write(
            project.path().join("rho.toml"),
            "# retained comment\nschema = 1\n[runtime.python]\nversion = \"3.12\"\nmanager = \"uv\"\nproject = \"pyproject.toml\"\nlockfile = \"uv.lock\"\n",
        )
        .unwrap();
        let identity = rho_home.path().join("id_ed25519");
        fs::write(&identity, "private").unwrap();
        let target = ComputeTarget {
            host: ComputeHost::Ssh {
                host: "hpc.example.edu".to_string(),
                username: Some("scientist".to_string()),
                port: 2329,
                host_fingerprint: "SHA256:abcdefghijklmnopqrstuvwxyz0123456789ABCDE".to_string(),
                remote_root: "/data/project".to_string(),
                identity_file: Some(identity.to_string_lossy().into_owned()),
            },
            isolation: ComputeIsolation::Native,
            capabilities: vec!["cpu".to_string()],
        };
        write_target_registry(rho_home.path(), "hpc", target).unwrap();
        select_project_target(project.path(), "hpc", &["cpu".to_string()]).unwrap();

        let registry = load_target_registry(rho_home.path()).unwrap();
        assert!(registry.registry.resolve("hpc").is_ok());
        let config = load_toolchain_config(project.path()).unwrap();
        assert_eq!(config.config.schema, 2);
        assert_eq!(config.config.compute.default_target, "hpc");
        assert!(
            fs::read_to_string(project.path().join("rho.toml"))
                .unwrap()
                .contains("# retained comment")
        );
    }

    #[test]
    #[ignore = "requires an explicitly supplied live SSH account"]
    fn live_ssh_slurm_probe() {
        let host = std::env::var("RHO_TEST_SSH_HOST").unwrap();
        let username = std::env::var("RHO_TEST_SSH_USERNAME").unwrap();
        let password = std::env::var("RHO_TEST_SSH_PASSWORD").unwrap();
        let fingerprint = std::env::var("RHO_TEST_SSH_FINGERPRINT").unwrap();
        let port = std::env::var("RHO_TEST_SSH_PORT").unwrap().parse().unwrap();
        let view = probe_connection(&SshConnectionProbeRequest {
            host,
            port,
            username,
            password: Some(password),
            identity_file: None,
            confirmed_fingerprint: Some(fingerprint),
        })
        .unwrap();
        assert!(view.authenticated);
        assert!(view.host_name.is_some());
        assert!(view.slurm_version.is_some());
        assert!(!view.partitions.is_empty());
    }

    #[test]
    fn shell_quote_keeps_public_key_as_one_literal() {
        assert_eq!(
            shell_single_quote("ssh-ed25519 abc rho:test"),
            "'ssh-ed25519 abc rho:test'"
        );
        assert_eq!(shell_single_quote("a'b"), "'a'\\''b'");
    }
}
