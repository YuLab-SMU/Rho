#![cfg(unix)]

use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use rho_toolchain::{
    CommandSpec, EffectStatus, OperationJournal, OperationStatus, RemoteEffectPayload,
    RemoteHelperOperation, RemoteHelperRequest, RemoteHelperResponse, RemoteInspectPayload,
    load_toolchain_config,
};

fn command(project_root: &Path, script: String) -> CommandSpec {
    CommandSpec {
        program: PathBuf::from("/bin/sh"),
        args: vec!["-c".to_string(), script],
        cwd: project_root.to_path_buf(),
        env: Default::default(),
    }
}

fn invoke(request: &RemoteHelperRequest) -> RemoteHelperResponse {
    let mut child = Command::new(env!("CARGO_BIN_EXE_rho-toolchain-helper"))
        .arg("--stdio")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    child
        .stdin
        .as_mut()
        .unwrap()
        .write_all(&serde_json::to_vec(request).unwrap())
        .unwrap();
    let output = child.wait_with_output().unwrap();
    assert!(
        output.status.success(),
        "helper failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    serde_json::from_slice(&output.stdout).unwrap()
}

fn request(
    config: &rho_toolchain::ToolchainConfigDocument,
    request_id: &str,
    operation: RemoteHelperOperation,
    payload: serde_json::Value,
) -> RemoteHelperRequest {
    RemoteHelperRequest {
        protocol: 1,
        request_id: request_id.to_string(),
        target_id: "lab".to_string(),
        project_root: config.project_root.to_string_lossy().into_owned(),
        rho_toml_sha256: config.sha256.clone(),
        target_registry_sha256: "b".repeat(64),
        operation,
        payload,
    }
}

#[test]
fn remote_sync_and_lock_coordinate_all_effects_under_one_journal() {
    let root = tempfile::tempdir().unwrap();
    std::fs::write(
        root.path().join("rho.toml"),
        "schema = 2\n[runtime.python]\nversion = \"3.12\"\nmanager = \"uv\"\nproject = \"pyproject.toml\"\nlockfile = \"uv.lock\"\n[compute]\ndefault_target = \"lab\"\n",
    )
    .unwrap();
    let config = load_toolchain_config(root.path()).unwrap();

    let sync_id = "sync-multi-effect";
    let sync = RemoteEffectPayload {
        operation_id: sync_id.to_string(),
        confirmed: true,
        commands: vec![
            command(
                &config.project_root,
                format!(
                    "printf first > '{}'",
                    config.project_root.join("sync-first").display()
                ),
            ),
            command(
                &config.project_root,
                format!(
                    "printf second > '{}'; exit 7",
                    config.project_root.join("sync-second").display()
                ),
            ),
            command(
                &config.project_root,
                format!(
                    "printf forbidden > '{}'",
                    config.project_root.join("sync-third").display()
                ),
            ),
        ],
        environment: None,
    };
    let response = invoke(&request(
        &config,
        "request-sync-multi",
        RemoteHelperOperation::Sync,
        serde_json::to_value(sync).unwrap(),
    ));
    assert!(!response.ok);
    assert_eq!(response.status, "failed");
    assert!(response.partial_effects_possible);
    let journal: OperationJournal = serde_json::from_value(response.payload).unwrap();
    assert_eq!(journal.status, OperationStatus::Failed);
    assert_eq!(journal.effects.len(), 2);
    assert_eq!(journal.effects[0].status, EffectStatus::Succeeded);
    assert_eq!(journal.effects[1].status, EffectStatus::Failed);
    assert!(config.project_root.join("sync-first").is_file());
    assert!(config.project_root.join("sync-second").is_file());
    assert!(!config.project_root.join("sync-third").exists());

    let inspected = invoke(&request(
        &config,
        "inspect-sync-multi",
        RemoteHelperOperation::InspectOperation,
        serde_json::to_value(RemoteInspectPayload {
            operation_id: sync_id.to_string(),
        })
        .unwrap(),
    ));
    assert!(inspected.ok);
    assert_eq!(inspected.status, "failed");
    assert_eq!(
        serde_json::from_value::<OperationJournal>(inspected.payload).unwrap(),
        journal
    );

    let lock_id = "lock-multi-effect";
    let lock = RemoteEffectPayload {
        operation_id: lock_id.to_string(),
        confirmed: true,
        commands: vec![
            command(
                &config.project_root,
                format!(
                    "printf one > '{}'",
                    config.project_root.join("lock-first").display()
                ),
            ),
            command(
                &config.project_root,
                format!(
                    "printf two > '{}'",
                    config.project_root.join("lock-second").display()
                ),
            ),
        ],
        environment: None,
    };
    let response = invoke(&request(
        &config,
        "request-lock-multi",
        RemoteHelperOperation::Lock,
        serde_json::to_value(lock).unwrap(),
    ));
    assert!(response.ok);
    assert_eq!(response.status, "succeeded");
    assert!(!response.partial_effects_possible);
    let journal: OperationJournal = serde_json::from_value(response.payload).unwrap();
    assert_eq!(journal.status, OperationStatus::Succeeded);
    assert_eq!(journal.effects.len(), 2);
    assert!(
        journal
            .effects
            .iter()
            .all(|effect| effect.status == EffectStatus::Succeeded)
    );
}
