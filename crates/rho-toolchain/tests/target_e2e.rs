use std::ffi::OsString;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

use rho_toolchain::{
    CommandSpec, EnvironmentReceipt, EnvironmentReceiptMode, OperationKind, OperationStatus,
    PythonEnvironmentReceipt, RemoteEffectPayload, RemoteHelperOperation, RemoteHelperRequest,
    RemoteOperationMirrorStatus, TargetAdmissionMode, adapt_plan_for_target, admit_target,
    execute_journaled_operation, invoke_remote_effect, load_target_registry, load_toolchain_config,
    monitor_project_resources, python_run_plan, read_remote_operation_mirror,
    reconcile_remote_operation,
};
use sha2::{Digest, Sha256};

const FINGERPRINT: &str = "SHA256:abcdefghijklmnopqrstuvwxyz0123456789ABCDE";
const IMAGE_DIGEST: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const CONDA_SPEC: &[u8] = b"@EXPLICIT\nhttps://example.invalid/python-3.12-0.tar.bz2\n";

struct EnvironmentGuard {
    path: Option<OsString>,
    helper: Option<OsString>,
}

impl Drop for EnvironmentGuard {
    fn drop(&mut self) {
        unsafe {
            match self.path.take() {
                Some(value) => std::env::set_var("PATH", value),
                None => std::env::remove_var("PATH"),
            }
            match self.helper.take() {
                Some(value) => std::env::set_var("RHO_FAKE_HELPER", value),
                None => std::env::remove_var("RHO_FAKE_HELPER"),
            }
        }
    }
}

fn install_fake_tools(directory: &Path) -> EnvironmentGuard {
    fs::create_dir_all(directory).unwrap();
    let source = directory.join("fake-tool.rs");
    fs::write(&source, FAKE_TOOL_SOURCE).unwrap();
    let executable = directory.join(format!("fake-tool{}", std::env::consts::EXE_SUFFIX));
    let rustc = std::env::var_os("RUSTC").unwrap_or_else(|| OsString::from("rustc"));
    let output = Command::new(rustc)
        .args(["--edition=2024", "-O"])
        .arg(&source)
        .arg("-o")
        .arg(&executable)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "fake tool compilation failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    for name in [
        "docker",
        "conda",
        "uv",
        "ssh",
        "ssh-keyscan",
        "ssh-keygen",
        "rho-e2e-effect",
    ] {
        fs::copy(
            &executable,
            directory.join(format!("{name}{}", std::env::consts::EXE_SUFFIX)),
        )
        .unwrap();
    }
    let old_path = std::env::var_os("PATH");
    let mut paths = vec![directory.to_path_buf()];
    if let Some(path) = old_path.as_ref() {
        paths.extend(std::env::split_paths(path));
    }
    let joined = std::env::join_paths(paths).unwrap();
    let old_helper = std::env::var_os("RHO_FAKE_HELPER");
    unsafe {
        std::env::set_var("PATH", joined);
        std::env::set_var(
            "RHO_FAKE_HELPER",
            env!("CARGO_BIN_EXE_rho-toolchain-helper"),
        );
    }
    EnvironmentGuard {
        path: old_path,
        helper: old_helper,
    }
}

fn python_config(target_id: &str) -> String {
    format!(
        "schema = 2\n[runtime.python]\nversion = \"3.12\"\nmanager = \"uv\"\nproject = \"pyproject.toml\"\nlockfile = \"uv.lock\"\n[compute]\ndefault_target = \"{target_id}\"\nrequired_capabilities = [\"cpu\"]\n"
    )
}

fn write_python_project(root: &Path, target_id: &str, fake_tools: &Path) {
    fs::create_dir_all(root).unwrap();
    fs::write(root.join("rho.toml"), python_config(target_id)).unwrap();
    fs::write(
        root.join("pyproject.toml"),
        "[project]\nname = \"rho-e2e\"\nversion = \"0.1.0\"\n",
    )
    .unwrap();
    fs::write(root.join("uv.lock"), "version = 1\n").unwrap();
    let python = if cfg!(windows) {
        root.join(".venv/Scripts/python.exe")
    } else {
        root.join(".venv/bin/python")
    };
    fs::create_dir_all(python.parent().unwrap()).unwrap();
    fs::copy(
        fake_tools.join(format!("fake-tool{}", std::env::consts::EXE_SUFFIX)),
        python,
    )
    .unwrap();
}

fn write_registry(root: &Path, target_yaml: &str) {
    fs::write(
        root.join("targets.yaml"),
        format!("schema: 1\ntargets:\n{target_yaml}"),
    )
    .unwrap();
}

fn docker_e2e(root: &Path, fake_tools: &Path) {
    write_python_project(root, "docker-e2e", fake_tools);
    write_registry(
        root,
        &format!(
            "  docker-e2e:\n    host:\n      kind: local\n    isolation:\n      kind: docker\n      engine: docker\n      image: registry.example/rho@sha256:{IMAGE_DIGEST}\n    capabilities: [cpu]\n"
        ),
    );
    let config = load_toolchain_config(root).unwrap();
    let targets = load_target_registry(root).unwrap();
    let admission = admit_target(root, &targets, TargetAdmissionMode::Run).unwrap();
    assert_eq!(admission.host_kind(), "local");
    assert_eq!(admission.isolation_kind(), "docker");
    let logical = python_run_plan(
        &config,
        &targets,
        &admission,
        Path::new("uv"),
        &["python".to_string(), "analysis.py".to_string()],
        false,
    )
    .unwrap();
    let adapted = adapt_plan_for_target(&config, &targets, &admission, &logical).unwrap();
    let journal = execute_journaled_operation(
        &config,
        "docker-e2e-run",
        OperationKind::Run,
        &adapted.commands,
        &targets,
        true,
    )
    .unwrap();
    assert_eq!(journal.status, OperationStatus::Succeeded);
    assert!(root.join("docker-executed").is_file());
    assert!(
        adapted.commands[0]
            .args
            .contains(&"--network=none".to_string())
    );
    assert!(
        adapted.commands[0]
            .args
            .contains(&"--read-only".to_string())
    );
}

fn conda_e2e(root: &Path, fake_tools: &Path) {
    write_python_project(root, "conda-e2e", fake_tools);
    let explicit_sha256 = format!("{:x}", Sha256::digest(CONDA_SPEC));
    write_registry(
        root,
        &format!(
            "  conda-e2e:\n    host:\n      kind: local\n    isolation:\n      kind: conda\n      environment: rho-e2e\n      explicit_spec_sha256: {explicit_sha256}\n    capabilities: [cpu]\n"
        ),
    );
    let config = load_toolchain_config(root).unwrap();
    let targets = load_target_registry(root).unwrap();
    let admission = admit_target(root, &targets, TargetAdmissionMode::Run).unwrap();
    assert_eq!(admission.isolation_kind(), "conda");
    let logical = python_run_plan(
        &config,
        &targets,
        &admission,
        Path::new("uv"),
        &["python".to_string(), "analysis.py".to_string()],
        false,
    )
    .unwrap();
    let adapted = adapt_plan_for_target(&config, &targets, &admission, &logical).unwrap();
    let journal = execute_journaled_operation(
        &config,
        "conda-e2e-run",
        OperationKind::Run,
        &adapted.commands,
        &targets,
        true,
    )
    .unwrap();
    assert_eq!(journal.status, OperationStatus::Succeeded);
    assert!(root.join("conda-executed").is_file());
    assert_eq!(
        &adapted.commands[0].args[..4],
        ["run", "--no-capture-output", "--name", "rho-e2e"]
    );
}

fn remote_receipt(
    remote_config: &rho_toolchain::ToolchainConfigDocument,
    registry_sha256: &str,
    operation_id: &str,
) -> EnvironmentReceipt {
    EnvironmentReceipt {
        schema_version: 1,
        execution_id: operation_id.to_string(),
        mode: EnvironmentReceiptMode::Run,
        project_root: remote_config.project_root.clone(),
        rho_toml_sha256: remote_config.sha256.clone(),
        target_id: "ssh-e2e".to_string(),
        target_registry_sha256: Some(registry_sha256.to_string()),
        host_kind: "ssh".to_string(),
        isolation_kind: "native".to_string(),
        isolation_identity: None,
        created_at: "2026-09-01T00:00:00Z".to_string(),
        operating_system: std::env::consts::OS.to_string(),
        architecture: std::env::consts::ARCH.to_string(),
        system_requirements: Vec::new(),
        r: None,
        python: Some(PythonEnvironmentReceipt {
            requested_version: "3.12".to_string(),
            resolved_version: "3.12.12".to_string(),
            executable: if cfg!(windows) {
                remote_config.project_root.join(".venv/Scripts/python.exe")
            } else {
                remote_config.project_root.join(".venv/bin/python")
            },
            venv: remote_config.project_root.join(".venv"),
            site_packages: vec![remote_config.project_root.join(".venv/site-packages")],
            pyproject_sha256: "c".repeat(64),
            uv_lock_sha256: "d".repeat(64),
        }),
    }
}

fn ssh_request(
    local_config: &rho_toolchain::ToolchainConfigDocument,
    remote_config: &rho_toolchain::ToolchainConfigDocument,
    registry_sha256: &str,
    request_id: &str,
    operation_id: &str,
    effect_program: &Path,
    marker: &Path,
) -> RemoteHelperRequest {
    RemoteHelperRequest {
        protocol: 1,
        request_id: request_id.to_string(),
        target_id: "ssh-e2e".to_string(),
        project_root: remote_config.project_root.to_string_lossy().into_owned(),
        rho_toml_sha256: local_config.sha256.clone(),
        target_registry_sha256: registry_sha256.to_string(),
        operation: RemoteHelperOperation::Run,
        payload: serde_json::to_value(RemoteEffectPayload {
            operation_id: operation_id.to_string(),
            confirmed: true,
            commands: vec![CommandSpec {
                program: effect_program.to_path_buf(),
                args: vec![marker.to_string_lossy().into_owned()],
                cwd: remote_config.project_root.clone(),
                env: Default::default(),
            }],
            environment: Some(remote_receipt(remote_config, registry_sha256, operation_id)),
        })
        .unwrap(),
    }
}

fn ssh_multi_effect_request(
    local_config: &rho_toolchain::ToolchainConfigDocument,
    remote_config: &rho_toolchain::ToolchainConfigDocument,
    registry_sha256: &str,
    operation: RemoteHelperOperation,
    operation_id: &str,
    effect_program: &Path,
    markers: &[PathBuf],
) -> RemoteHelperRequest {
    RemoteHelperRequest {
        protocol: 1,
        request_id: format!("request-{operation_id}"),
        target_id: "ssh-e2e".to_string(),
        project_root: remote_config.project_root.to_string_lossy().into_owned(),
        rho_toml_sha256: local_config.sha256.clone(),
        target_registry_sha256: registry_sha256.to_string(),
        operation,
        payload: serde_json::to_value(RemoteEffectPayload {
            operation_id: operation_id.to_string(),
            confirmed: true,
            commands: markers
                .iter()
                .map(|marker| CommandSpec {
                    program: effect_program.to_path_buf(),
                    args: vec![marker.to_string_lossy().into_owned()],
                    cwd: remote_config.project_root.clone(),
                    env: Default::default(),
                })
                .collect(),
            environment: None,
        })
        .unwrap(),
    }
}

fn ssh_e2e(local_root: &Path, remote_root: &Path, fake_tools: &Path) {
    write_python_project(local_root, "ssh-e2e", fake_tools);
    write_python_project(remote_root, "ssh-e2e", fake_tools);
    write_registry(
        local_root,
        &format!(
            "  ssh-e2e:\n    host:\n      kind: ssh\n      host: fake.example\n      username: scientist\n      port: 2222\n      host_fingerprint: {FINGERPRINT}\n      remote_root: {}\n    isolation:\n      kind: native\n    capabilities: [cpu]\n",
            remote_root.canonicalize().unwrap().to_string_lossy()
        ),
    );
    let local_config = load_toolchain_config(local_root).unwrap();
    let remote_config = load_toolchain_config(remote_root).unwrap();
    assert_eq!(local_config.sha256, remote_config.sha256);
    let targets = load_target_registry(local_root).unwrap();
    let target = targets.registry.resolve("ssh-e2e").unwrap();
    let admission = admit_target(local_root, &targets, TargetAdmissionMode::Run).unwrap();
    assert_eq!(admission.host_kind(), "ssh");
    assert_eq!(admission.isolation_kind(), "native");
    let monitored = monitor_project_resources(local_root, &targets).unwrap();
    let remote_monitor = monitored
        .targets
        .iter()
        .find(|target| target.target_id == "ssh-e2e")
        .unwrap();
    assert!(remote_monitor.device.is_some());
    assert!(
        remote_monitor
            .device
            .as_ref()
            .unwrap()
            .metrics
            .iter()
            .any(|metric| metric.kind == "memory")
    );
    let registry_sha256 = targets.sha256.as_deref().unwrap();
    let effect_program = fake_tools.join(format!("rho-e2e-effect{}", std::env::consts::EXE_SUFFIX));

    let marker = remote_config.project_root.join("ssh-executed");
    let response = invoke_remote_effect(
        &local_config.project_root,
        "ssh-e2e",
        target,
        &ssh_request(
            &local_config,
            &remote_config,
            registry_sha256,
            "request-ssh-success",
            "ssh-e2e-run",
            &effect_program,
            &marker,
        ),
    )
    .unwrap();
    assert!(response.ok);
    assert_eq!(response.status, "succeeded");
    assert!(marker.is_file());
    assert_eq!(
        read_remote_operation_mirror(&local_config.project_root, "ssh-e2e-run")
            .unwrap()
            .status,
        RemoteOperationMirrorStatus::Succeeded
    );

    for (operation, mode, operation_id) in [
        (
            RemoteHelperOperation::Sync,
            TargetAdmissionMode::Sync,
            "ssh-e2e-sync",
        ),
        (
            RemoteHelperOperation::Lock,
            TargetAdmissionMode::Lock,
            "ssh-e2e-lock",
        ),
    ] {
        admission.for_mode(&local_config, &targets, mode).unwrap();
        let markers = [
            remote_config
                .project_root
                .join(format!("{operation_id}-first")),
            remote_config
                .project_root
                .join(format!("{operation_id}-second")),
        ];
        let response = invoke_remote_effect(
            &local_config.project_root,
            "ssh-e2e",
            target,
            &ssh_multi_effect_request(
                &local_config,
                &remote_config,
                registry_sha256,
                operation,
                operation_id,
                &effect_program,
                &markers,
            ),
        )
        .unwrap();
        assert!(response.ok);
        let journal: rho_toolchain::OperationJournal =
            serde_json::from_value(response.payload).unwrap();
        assert_eq!(journal.effects.len(), 2);
        assert!(markers.iter().all(|marker| marker.is_file()));
    }

    let uncertain_marker = remote_config.project_root.join("ssh-disconnected-executed");
    let error = invoke_remote_effect(
        &local_config.project_root,
        "ssh-e2e",
        target,
        &ssh_request(
            &local_config,
            &remote_config,
            registry_sha256,
            "request-ssh-disconnect",
            "ssh-e2e-disconnect",
            &effect_program,
            &uncertain_marker,
        ),
    )
    .unwrap_err();
    assert!(error.completion_uncertain());
    assert!(uncertain_marker.is_file());
    assert_eq!(
        read_remote_operation_mirror(&local_config.project_root, "ssh-e2e-disconnect")
            .unwrap()
            .status,
        RemoteOperationMirrorStatus::Uncertain
    );
    let reconciled = reconcile_remote_operation(
        &local_config.project_root,
        "ssh-e2e",
        target,
        "ssh-e2e-disconnect",
    )
    .unwrap();
    assert_eq!(reconciled.status, RemoteOperationMirrorStatus::Succeeded);
    assert_eq!(
        reconciled.remote_journal.unwrap().status,
        OperationStatus::Succeeded
    );
}

#[test]
fn docker_conda_and_ssh_complete_target_acceptance() {
    let root = tempfile::tempdir().unwrap();
    let fake_tools = root.path().join("fake-tools");
    let _environment = install_fake_tools(&fake_tools);
    docker_e2e(&root.path().join("docker-project"), &fake_tools);
    conda_e2e(&root.path().join("conda-project"), &fake_tools);
    ssh_e2e(
        &root.path().join("ssh-local-project"),
        &root.path().join("ssh-remote-project"),
        &fake_tools,
    );
}

const FAKE_TOOL_SOURCE: &str = r#"
use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

const FINGERPRINT: &str = "SHA256:abcdefghijklmnopqrstuvwxyz0123456789ABCDE";
const CONDA_SPEC: &str = "@EXPLICIT\nhttps://example.invalid/python-3.12-0.tar.bz2\n";

fn tool_name() -> String {
    let name = std::env::args_os().next().unwrap_or_default();
    Path::new(&name)
        .file_stem()
        .unwrap_or_default()
        .to_string_lossy()
        .to_string()
}

fn write_marker(name: &str) {
    fs::write(std::env::current_dir().unwrap().join(name), b"executed").unwrap();
}

fn docker(args: &[String]) {
    if args.first().is_some_and(|value| value == "image") {
        assert_eq!(args.get(1).map(String::as_str), Some("inspect"));
        assert!(args.get(2).is_some_and(|value| value.contains("@sha256:")));
        print!("[]");
        return;
    }
    let source = args
        .windows(2)
        .find(|values| values[0] == "--mount")
        .and_then(|values| values[1].split("source=").nth(1))
        .and_then(|value| value.split(",target=").next())
        .map(PathBuf::from)
        .unwrap_or_else(|| std::env::current_dir().unwrap());
    let image = args
        .iter()
        .position(|value| value.contains("@sha256:"))
        .expect("fake Docker image argument");
    let program = args.get(image + 1).expect("fake Docker program");
    if Path::new(program).file_name().is_some_and(|name| name == "python" || name == "python.exe") {
        println!("Python 3.12.12");
    } else if program == "uv" && args.get(image + 2).is_some_and(|value| value == "run") {
        fs::write(source.join("docker-executed"), b"executed").unwrap();
    }
}

fn conda(args: &[String]) {
    if args.first().is_some_and(|value| value == "list") {
        print!("{CONDA_SPEC}");
        return;
    }
    let program = args.get(4).map(String::as_str).unwrap_or_default();
    if Path::new(program).file_name().is_some_and(|name| name == "python" || name == "python.exe") {
        println!("Python 3.12.12");
    } else if program == "uv" && args.get(5).is_some_and(|value| value == "run") {
        write_marker("conda-executed");
    }
}

fn ssh(request: &[u8]) -> i32 {
    let mut child = Command::new(std::env::var_os("RHO_FAKE_HELPER").unwrap())
        .arg("--stdio")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    child.stdin.as_mut().unwrap().write_all(request).unwrap();
    let output = child.wait_with_output().unwrap();
    if !output.status.success() {
        std::io::stderr().write_all(&output.stderr).unwrap();
        return output.status.code().unwrap_or(1);
    }
    let disconnect = String::from_utf8_lossy(request)
        .contains("\"request_id\":\"request-ssh-disconnect\"");
    if disconnect {
        eprintln!("injected SSH disconnect after remote completion");
        255
    } else {
        std::io::stdout().write_all(&output.stdout).unwrap();
        0
    }
}

fn main() {
    let tool = tool_name();
    let args = std::env::args().skip(1).collect::<Vec<_>>();
    let code = match tool.as_str() {
        "ssh-keyscan" => {
            println!("fake.example ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFake");
            0
        }
        "ssh-keygen" => {
            let mut ignored = Vec::new();
            std::io::stdin().read_to_end(&mut ignored).unwrap();
            println!("256 {FINGERPRINT} fake.example (ED25519)");
            0
        }
        "ssh" => {
            assert!(args.iter().any(|value| value == "BatchMode=yes"));
            assert!(args.iter().any(|value| value == "StrictHostKeyChecking=yes"));
            assert!(args.iter().any(|value| value == "rho-toolchain-helper"));
            assert!(args.iter().any(|value| value == "--stdio"));
            let mut request = Vec::new();
            std::io::stdin().read_to_end(&mut request).unwrap();
            ssh(&request)
        }
        "docker" => {
            docker(&args);
            0
        }
        "conda" => {
            conda(&args);
            0
        }
        "uv" => {
            if args.first().is_some_and(|value| value == "--version") {
                println!("uv 0.8.0");
            }
            0
        }
        "python" => {
            println!("Python 3.12.12");
            0
        }
        "rho-e2e-effect" => {
            fs::write(args.first().expect("effect marker path"), b"applied").unwrap();
            0
        }
        other => {
            eprintln!("unsupported fake tool {other}");
            2
        }
    };
    std::process::exit(code);
}
"#;
