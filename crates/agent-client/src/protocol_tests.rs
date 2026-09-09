//! Local JSON-RPC fixtures. These tests never start a real Agent or use a model.
use super::*;
use std::{fs, os::unix::fs::PermissionsExt, time::Duration};

async fn fixture() -> (tempfile::TempDir, Arc<ExternalAgentClient>) {
    let dir = tempfile::tempdir().unwrap();
    let program = dir.path().join("fake-agent");
    fs::write(&program,r##"#!/usr/bin/env node
const readline=require('node:readline');let pending=null,count=0;
const send=x=>process.stdout.write(JSON.stringify(x)+'\n');
readline.createInterface({input:process.stdin}).on('line',line=>{
 const m=JSON.parse(line);
 if(m.method==='session/prompt'){
  count++;pending=m.id;
  send({jsonrpc:'2.0',id:'permission-1',method:'session/request_permission',params:{toolCall:{title:'Read the fixture'},options:[{optionId:'yes',name:'Allow once',kind:'allow_once'},{optionId:'no',name:'Decline',kind:'reject_once'}]}});
 }else if(m.id==='permission-1'&&m.result){
  send({jsonrpc:'2.0',method:'session/update',params:{sessionId:'native-1',update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'ok fixture-private-token '+ '界'.repeat(100000)}}}});
  send({jsonrpc:'2.0',id:pending,result:{stopReason:'end_turn'}});
 }else if(m.method==='fixture/count')send({jsonrpc:'2.0',id:m.id,result:{count}});
 else if(m.method==='fixture/large')send({jsonrpc:'2.0',id:m.id,result:{text:'x'.repeat(8*1024*1024)}});
 else if(m.method==='fixture/exit')process.exit(0);
 else if(m.method==='model/list')send({jsonrpc:'2.0',id:m.id,result:{data:[],nextCursor:'repeated'}});
 else if(m.method==='session/close')send({jsonrpc:'2.0',id:m.id,result:{}});
});
"##).unwrap();
    fs::set_permissions(&program, fs::Permissions::from_mode(0o700)).unwrap();
    let rpc = Rpc::spawn(
        &program,
        AgentProvider::Kimi,
        dir.path(),
        "fixture-private-token",
    )
    .await
    .unwrap();
    rpc.buffer.lock().unwrap().session = Some(AgentClientSession {
        id: "client-1".into(),
        provider: AgentProvider::Kimi,
        native_session_id: "native-1".into(),
        project_root: dir.path().to_string_lossy().into_owned(),
        window: window(),
        model: "fixture".into(),
        effort: None,
        state: "ready".into(),
        messages: vec![],
        activity: vec![],
        decisions: vec![],
        error: None,
        truncated: false,
        elapsed_ms: None,
        last_request_id: None,
    });
    (
        dir,
        Arc::new(ExternalAgentClient {
            rpc,
            provider: AgentProvider::Kimi,
        }),
    )
}
fn window() -> ApplicationWindowRef {
    ApplicationWindowRef {
        window_id: "window-1".into(),
        incarnation: "incarnation-1".into(),
    }
}
async fn state(client: &ExternalAgentClient, wanted: &str) {
    tokio::time::timeout(Duration::from_secs(3), async {
        while client.snapshot().state != wanted {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .unwrap();
}
#[tokio::test]
async fn native_permission_streaming_redaction_and_lost_ack_retries_preserve_one_prompt() {
    let (_dir, client) = fixture().await;
    let id = uuid::Uuid::new_v4().to_string();
    client
        .prompt("Read this fixture", false, &id, window())
        .await
        .unwrap();
    state(&client, "waiting_for_permission").await;
    assert_eq!(
        client.snapshot().decisions[0]
            .options
            .iter()
            .map(|o| o.id.as_str())
            .collect::<Vec<_>>(),
        vec!["yes", "no"]
    );
    let decision = client.snapshot().decisions[0].id;
    assert!(client.decide(decision, "not-advertised").await.is_err());
    assert_eq!(client.snapshot().state, "waiting_for_permission");
    client.decide(decision, "yes").await.unwrap();
    state(&client, "ready").await;
    let snapshot = client.snapshot();
    assert!(snapshot.decisions.is_empty());
    assert!(snapshot.truncated);
    assert!(
        snapshot
            .messages
            .last()
            .unwrap()
            .text
            .contains("<private-token>")
    );
    assert!(
        !serde_json::to_string(&snapshot)
            .unwrap()
            .contains("fixture-private-token")
    );
    assert!(
        snapshot
            .messages
            .iter()
            .map(|m| m.text.len())
            .sum::<usize>()
            <= 256 * 1024
    );
    assert_eq!(snapshot.last_request_id.as_deref(), Some(id.as_str()));
    client
        .prompt("Read this fixture", false, &id, window())
        .await
        .unwrap();
    assert!(
        client
            .prompt("Different input", false, &id, window())
            .await
            .is_err()
    );
    assert_eq!(
        client
            .rpc
            .call("fixture/count", json!({}), 1)
            .await
            .unwrap()["count"],
        1
    );
    client.close().await;
    assert_eq!(client.snapshot().state, "disconnected");
}
#[tokio::test]
async fn timeout_remains_uncertain_and_foreign_windows_cannot_submit() {
    let (_dir, client) = fixture().await;
    let other = ApplicationWindowRef {
        window_id: "other".into(),
        ..window()
    };
    assert!(
        client
            .prompt("test", false, &uuid::Uuid::new_v4().to_string(), other)
            .await
            .is_err()
    );
    assert_eq!(
        client
            .rpc
            .call("fixture/count", json!({}), 1)
            .await
            .unwrap()["count"],
        0
    );
    client.rpc.complete(
        Some("Agent session/prompt timed out; native outcome pending".into()),
        false,
    );
    assert_eq!(client.snapshot().state, "uncertain");
    assert!(
        client
            .prompt(
                "do not replay",
                false,
                &uuid::Uuid::new_v4().to_string(),
                window()
            )
            .await
            .is_err()
    );
    client.close().await;
}

#[tokio::test]
async fn native_envelope_accepts_a_full_mcp_reply_without_expanding_the_ui_snapshot() {
    let (_dir, client) = fixture().await;
    let value = client
        .rpc
        .call("fixture/large", json!({}), 3)
        .await
        .unwrap();
    assert_eq!(value["text"].as_str().unwrap().len(), 8 * 1024 * 1024);
    assert!(client.snapshot().messages.is_empty());
    client.close().await;
}

#[tokio::test]
async fn closed_transport_cannot_be_reused_or_revived_by_a_late_turn_result() {
    let (_dir, client) = fixture().await;
    assert!(client.rpc.call("fixture/exit", json!({}), 3).await.is_err());
    state(&client, "disconnected").await;
    client.rpc.complete(None, false);
    assert_eq!(client.snapshot().state, "disconnected");
    assert!(
        client
            .prompt(
                "do not send",
                false,
                &uuid::Uuid::new_v4().to_string(),
                window()
            )
            .await
            .is_err()
    );
    client.close().await;
}

#[tokio::test]
async fn repeated_empty_model_pages_fail_without_retrying_forever() {
    let (_dir, client) = fixture().await;
    let result = tokio::time::timeout(Duration::from_secs(1), codex_models(&client.rpc))
        .await
        .unwrap();
    assert!(result.unwrap_err().contains("model-list cursor"));
    client.close().await;
}
