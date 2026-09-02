#![cfg(unix)]

use std::{collections::BTreeMap, fs, os::unix::fs::PermissionsExt};

use rho_acp_client::{AcpProcessSpec, VerifiedAcpSandbox, run_external_acp_turn};

#[tokio::test]
async fn external_acp_process_owns_the_agent_loop_while_rho_projects_events() {
    let directory = tempfile::tempdir().unwrap();
    let workspace = directory.path().join("workspace");
    fs::create_dir(&workspace).unwrap();
    let agent = directory.path().join("fake-acp-agent");
    fs::write(
        &agent,
        r#"#!/bin/sh
read init
id=$(printf '%s' "$init" | sed -E 's/.*"id":([^,}]+).*/\1/')
printf '{"jsonrpc":"2.0","id":%s,"result":{"protocolVersion":1,"agentCapabilities":{},"agentInfo":{"name":"fake-acp","version":"1"}}}\n' "$id"
read session
id=$(printf '%s' "$session" | sed -E 's/.*"id":([^,}]+).*/\1/')
printf '{"jsonrpc":"2.0","id":%s,"result":{"sessionId":"session-test"}}\n' "$id"
read prompt
id=$(printf '%s' "$prompt" | sed -E 's/.*"id":([^,}]+).*/\1/')
printf '{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"session-test","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"external ok"}}}}\n'
printf '{"jsonrpc":"2.0","id":%s,"result":{"stopReason":"end_turn"}}\n' "$id"
sleep 1
"#,
    )
    .unwrap();
    let mut permissions = fs::metadata(&agent).unwrap().permissions();
    permissions.set_mode(0o700);
    fs::set_permissions(&agent, permissions).unwrap();

    let result = run_external_acp_turn(
        AcpProcessSpec {
            executable: agent,
            arguments: Vec::new(),
            environment: BTreeMap::from([
                ("PATH".to_string(), "/usr/bin:/bin".to_string()),
                (
                    "HOME".to_string(),
                    directory.path().to_string_lossy().into_owned(),
                ),
                (
                    "TMPDIR".to_string(),
                    directory.path().to_string_lossy().into_owned(),
                ),
            ]),
            sandbox: VerifiedAcpSandbox {
                working_directory: workspace,
                authoritative_project_mounted: false,
                workspace_socket_mounted: false,
                store_mounted: false,
                secret_store_mounted: false,
                network_denied: true,
            },
        },
        "respond".to_string(),
    )
    .await
    .unwrap();

    assert_eq!(result.session_id, "session-test");
    assert_eq!(result.final_text, "external ok");
    assert_eq!(result.permission_requests_denied, 0);
    assert_eq!(result.events.len(), 1);
}
