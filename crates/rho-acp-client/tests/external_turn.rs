#![cfg(unix)]

use std::{collections::BTreeMap, fs, os::unix::fs::PermissionsExt};

use agent_client_protocol::schema::{McpServer, McpServerStdio};
use rho_acp_client::{
    AcpClientExposure, AcpProcessSpec, VerifiedAcpSandbox, run_external_acp_turn,
    run_external_acp_turn_with_exposure,
};

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
    assert_eq!(result.permission_requests_selected, 0);
    assert_eq!(result.workspace_file_reads, 0);
    assert_eq!(result.workspace_file_writes, 0);
    assert_eq!(result.terminal_commands_created, 0);
    assert_eq!(result.events.len(), 1);
}

#[tokio::test]
async fn external_acp_agent_receives_workspace_terminal_mcp_and_permission_capabilities() {
    let directory = tempfile::tempdir().unwrap();
    let workspace = directory.path().join("workspace");
    fs::create_dir(&workspace).unwrap();
    let source = workspace.join("source.txt");
    let written = workspace.join("nested/result.txt");
    fs::write(&source, "alpha\nbeta\ngamma\n").unwrap();

    let source_json = serde_json::to_string(source.to_str().unwrap()).unwrap();
    let written_json = serde_json::to_string(written.to_str().unwrap()).unwrap();
    let workspace_json = serde_json::to_string(workspace.to_str().unwrap()).unwrap();
    let script = r#"#!/bin/sh
set -eu
read init
printf '%s\n' "$init" > "$HOME/init.json"
id=$(printf '%s' "$init" | sed -E 's/.*"id":([^,}]+).*/\1/')
printf '{"jsonrpc":"2.0","id":%s,"result":{"protocolVersion":1,"agentCapabilities":{},"agentInfo":{"name":"fake-acp","version":"1"}}}\n' "$id"
read session
printf '%s\n' "$session" > "$HOME/session.json"
id=$(printf '%s' "$session" | sed -E 's/.*"id":([^,}]+).*/\1/')
printf '{"jsonrpc":"2.0","id":%s,"result":{"sessionId":"session-test"}}\n' "$id"
read prompt
id=$(printf '%s' "$prompt" | sed -E 's/.*"id":([^,}]+).*/\1/')
printf '{"jsonrpc":"2.0","id":101,"method":"fs/read_text_file","params":{"sessionId":"session-test","path":__SOURCE__,"line":2,"limit":1}}\n'
read read_response
printf '%s\n' "$read_response" > "$HOME/read-response.json"
printf '%s' "$read_response" | grep -q 'beta'
printf '{"jsonrpc":"2.0","id":102,"method":"fs/write_text_file","params":{"sessionId":"session-test","path":__WRITTEN__,"content":"written by external agent"}}\n'
read write_response
printf '%s\n' "$write_response" > "$HOME/write-response.json"
printf '%s' "$write_response" | grep -q '"id":102'
printf '{"jsonrpc":"2.0","id":103,"method":"session/request_permission","params":{"sessionId":"session-test","toolCall":{"toolCallId":"call-1","title":"Write file"},"options":[{"optionId":"reject","name":"Reject","kind":"reject_once"},{"optionId":"allow","name":"Allow once","kind":"allow_once"}]}}\n'
read permission_response
printf '%s\n' "$permission_response" > "$HOME/permission-response.json"
printf '%s' "$permission_response" | grep -q '"optionId":"allow"'
printf '{"jsonrpc":"2.0","id":104,"method":"terminal/create","params":{"sessionId":"session-test","command":"/bin/sh","args":["-c","printf terminal-ok"],"cwd":__WORKSPACE__,"outputByteLimit":1024}}\n'
read terminal_response
printf '%s\n' "$terminal_response" > "$HOME/terminal-response.json"
terminal_id=$(printf '%s' "$terminal_response" | sed -E 's/.*"terminalId":"([^"]+)".*/\1/')
printf '{"jsonrpc":"2.0","id":105,"method":"terminal/wait_for_exit","params":{"sessionId":"session-test","terminalId":"%s"}}\n' "$terminal_id"
read wait_response
printf '%s' "$wait_response" | grep -q '"exitCode":0'
printf '{"jsonrpc":"2.0","id":106,"method":"terminal/output","params":{"sessionId":"session-test","terminalId":"%s"}}\n' "$terminal_id"
read output_response
printf '%s\n' "$output_response" > "$HOME/output-response.json"
printf '%s' "$output_response" | grep -q 'terminal-ok'
printf '{"jsonrpc":"2.0","id":107,"method":"terminal/release","params":{"sessionId":"session-test","terminalId":"%s"}}\n' "$terminal_id"
read release_response
printf '%s' "$release_response" | grep -q '"id":107'
printf '{"jsonrpc":"2.0","id":%s,"result":{"stopReason":"end_turn"}}\n' "$id"
"#
    .replace("__SOURCE__", &source_json)
    .replace("__WRITTEN__", &written_json)
    .replace("__WORKSPACE__", &workspace_json);
    let agent = directory.path().join("fake-acp-agent-with-client-requests");
    fs::write(&agent, script).unwrap();
    let mut permissions = fs::metadata(&agent).unwrap().permissions();
    permissions.set_mode(0o700);
    fs::set_permissions(&agent, permissions).unwrap();

    let result = run_external_acp_turn_with_exposure(
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
        "inspect and edit the workspace".to_string(),
        None,
        AcpClientExposure::workspace_snapshot().with_mcp_servers(vec![McpServer::Stdio(
            McpServerStdio::new("rho", "/opt/rho/bin/rho-mcp"),
        )]),
    )
    .await
    .unwrap();

    let initialize: serde_json::Value =
        serde_json::from_slice(&fs::read(directory.path().join("init.json")).unwrap()).unwrap();
    assert_eq!(
        initialize["params"]["clientCapabilities"]["fs"]["readTextFile"],
        true
    );
    assert_eq!(
        initialize["params"]["clientCapabilities"]["fs"]["writeTextFile"],
        true
    );
    assert_eq!(initialize["params"]["clientCapabilities"]["terminal"], true);
    let session: serde_json::Value =
        serde_json::from_slice(&fs::read(directory.path().join("session.json")).unwrap()).unwrap();
    assert_eq!(session["params"]["mcpServers"][0]["name"], "rho");
    assert_eq!(
        session["params"]["mcpServers"][0]["command"],
        "/opt/rho/bin/rho-mcp"
    );
    assert_eq!(
        fs::read_to_string(written).unwrap(),
        "written by external agent"
    );
    assert_eq!(result.permission_requests_denied, 0);
    assert_eq!(result.permission_requests_selected, 1);
    assert_eq!(result.workspace_file_reads, 1);
    assert_eq!(result.workspace_file_writes, 1);
    assert_eq!(result.terminal_commands_created, 1);
}
