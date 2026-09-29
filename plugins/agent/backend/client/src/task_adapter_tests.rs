//! Protocol recovery fixtures represent documented native edge behavior. They
//! never call a provider, read another user's sessions, or start an R runtime.
use super::*;
use std::{fs, os::unix::fs::PermissionsExt};

#[test]
fn configured_kimi_home_checks_only_the_exact_native_session_and_project() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("project");
    fs::create_dir(&root).unwrap();
    let home = dir.path().join("native-home");
    let session = home.join("sessions/fixture/session-one");
    fs::create_dir_all(&session).unwrap();
    fs::write(
        home.join("workspaces.json"),
        json!({"version":1,"workspaces":{"fixture":{"root":root}}}).to_string(),
    )
    .unwrap();
    fs::write(
        session.join("state.json"),
        json!({"version":2,"id":"session-one","cwd":root}).to_string(),
    )
    .unwrap();
    let options = NativeAgentOptions {
        kimi_home: Some(home),
    };
    verify_kimi_project(&root, "session-one", &options).unwrap();
    assert!(verify_kimi_project(&root, "missing-session", &options).is_err());
    fs::write(
        session.join("state.json"),
        json!({"version":2,"id":"session-one","cwd":"another-project"}).to_string(),
    )
    .unwrap();
    assert!(
        verify_kimi_project(&root, "session-one", &options)
            .unwrap_err()
            .contains("different project")
    );
    fs::remove_file(session.join("state.json")).unwrap();
    let outside = dir.path().join("outside.json");
    fs::write(
        &outside,
        json!({"version":2,"id":"session-one","cwd":root}).to_string(),
    )
    .unwrap();
    std::os::unix::fs::symlink(outside, session.join("state.json")).unwrap();
    assert!(
        verify_kimi_project(&root, "session-one", &options)
            .unwrap_err()
            .contains("escaped")
    );
}

#[tokio::test]
async fn configured_kimi_home_is_local_to_each_native_child() {
    let dir = tempfile::tempdir().unwrap();
    let program = dir.path().join("fixture");
    fs::write(&program, r#"#!/usr/bin/env node
require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
const m=JSON.parse(line);process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result:{home:process.env.KIMI_CODE_HOME}})+'\n');
});
"#).unwrap();
    fs::set_permissions(&program, fs::Permissions::from_mode(0o700)).unwrap();
    let original = std::env::var_os("KIMI_CODE_HOME");
    for name in ["first-native-home", "second-native-home"] {
        let home = dir.path().join(name);
        fs::create_dir(&home).unwrap();
        let options = NativeAgentOptions {
            kimi_home: Some(home.clone()),
        };
        let rpc = Rpc::spawn_with_options(&program, AgentProvider::Kimi, dir.path(), "", &options)
            .await
            .unwrap();
        assert_eq!(
            rpc.call("fixture/home", json!({}), 2).await.unwrap()["home"],
            home.to_string_lossy().as_ref()
        );
        rpc.close().await;
    }
    assert_eq!(std::env::var_os("KIMI_CODE_HOME"), original);
}
async fn fixture() -> (tempfile::TempDir, Arc<Rpc>) {
    let dir = tempfile::tempdir().unwrap();
    let program = dir.path().join("fixture");
    fs::write(&program,r#"#!/usr/bin/env node
const readline=require('node:readline');let calls=[],inbox=['old queued input'],stopped=false,refuse=false,held=null,hold=false;
const send=(m,result)=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result})+'\n');
readline.createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line),p=m.params||{};calls.push({method:m.method,params:p});
if(m.method==='session/close'){if(refuse){process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,error:{code:-32000,message:'close unconfirmed'}})+'\n');return;}inbox=[];send(m,{});}
else if(m.method==='session/resume'||m.method==='session/load')send(m,{sessionId:p.sessionId});
else if(m.method==='session/prompt'){if(hold)held=m;else send(m,{executed:[...inbox,p.prompt],stopReason:'end_turn'});}
else if(m.method==='fixture/hold'){hold=true;send(m,{});}
else if(m.method==='fixture/release'){send(held,{stopReason:'end_turn'});send(m,{});held=null;}
else if(m.method==='turn/interrupt'){stopped=true;send(m,{});}
else if(m.method==='thread/read')send(m,{thread:{id:p.threadId,status:{type:stopped?'idle':'active'}}});
else if(m.method==='thread/turns/list')send(m,{data:[{id:'turn-1',startedAt:10,status:'completed',items:[{id:'item-1',type:'agentMessage',text:'restored answer'}]}],nextCursor:p.cursor==='loop'?'loop':p.cursor?null:'older'});
else if(m.method==='fixture/refuse'){refuse=true;send(m,{});}
else if(m.method==='fixture/calls')send(m,{calls});
else send(m,{});
});
"#).unwrap();
    fs::set_permissions(&program, fs::Permissions::from_mode(0o700)).unwrap();
    let rpc = Rpc::spawn(&program, AgentProvider::Kimi, dir.path(), "fixture-token")
        .await
        .unwrap();
    (dir, rpc)
}
#[tokio::test]
async fn acp_prompt_keeps_its_reply_past_ten_minutes_and_closure_releases_waiter() {
    let (_dir, rpc) = fixture().await;
    rpc.call("fixture/hold", json!({}), 2).await.unwrap();
    let ticket = rpc
        .begin_call("session/prompt", json!({"sessionId":"s","prompt":[]}))
        .await
        .unwrap();
    rpc.call("fixture/calls", json!({}), 2).await.unwrap();
    let waiting_rpc = rpc.clone();
    let waiting = tokio::spawn(async move { waiting_rpc.finish_prompt(ticket).await });
    tokio::time::pause();
    tokio::time::advance(std::time::Duration::from_secs(601)).await;
    assert!(
        !waiting.is_finished(),
        "a tool/permission wait must not detach the native turn"
    );
    tokio::time::resume();
    rpc.call("fixture/release", json!({}), 2).await.unwrap();
    assert_eq!(waiting.await.unwrap().unwrap()["stopReason"], "end_turn");
    let ticket = rpc
        .begin_call("session/prompt", json!({"sessionId":"s","prompt":[]}))
        .await
        .unwrap();
    rpc.close().await;
    assert!(
        tokio::time::timeout(std::time::Duration::from_secs(2), rpc.finish_prompt(ticket))
            .await
            .unwrap()
            .is_err()
    );
}
#[tokio::test]
async fn deepseek_crash_inbox_is_cleared_before_new_input_and_keeps_exact_identity() {
    let (dir, rpc) = fixture().await;
    let mcp = json!([{"name":"rho","url":"http://new-host/mcp","headers":[{"name":"Authorization","value":"Bearer new-fixture"}]}]);
    let result = open_acp_session(
        &rpc,
        AgentProvider::Deepseek,
        Some("saved-identity"),
        dir.path(),
        &mcp,
        true,
    )
    .await
    .unwrap();
    assert_eq!(result["sessionId"], "saved-identity");
    let calls = rpc.call("fixture/calls", json!({}), 2).await.unwrap();
    let sequence = calls["calls"].as_array().unwrap();
    assert_eq!(
        sequence
            .iter()
            .take(3)
            .map(|c| c["method"].as_str().unwrap())
            .collect::<Vec<_>>(),
        vec!["session/resume", "session/close", "session/resume"]
    );
    assert!(!sequence.iter().any(|c| c["method"] == "session/prompt"));
    for c in [&sequence[0], &sequence[2]] {
        assert_eq!(c["params"]["sessionId"], "saved-identity");
        assert_eq!(c["params"]["mcpServers"], mcp);
    }
    let sent = rpc
        .call(
            "session/prompt",
            json!({"sessionId":"saved-identity","prompt":"new input"}),
            2,
        )
        .await
        .unwrap();
    assert_eq!(sent["executed"], json!(["new input"]));
    rpc.close().await;
}
#[tokio::test]
async fn deepseek_unconfirmed_close_never_opens_the_second_resume() {
    let (dir, rpc) = fixture().await;
    rpc.call("fixture/refuse", json!({}), 2).await.unwrap();
    assert!(
        open_acp_session(
            &rpc,
            AgentProvider::Deepseek,
            Some("saved"),
            dir.path(),
            &json!([]),
            true
        )
        .await
        .is_err()
    );
    let calls = rpc.call("fixture/calls", json!({}), 2).await.unwrap();
    assert_eq!(
        calls["calls"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|c| c["method"] == "session/resume")
            .count(),
        1
    );
    rpc.close().await;
}
#[tokio::test]
async fn codex_resumed_active_turn_is_stopped_and_idle_is_confirmed_without_prompting() {
    let (_dir, rpc) = fixture().await;
    ensure_codex_quiet(
        &rpc,
        "thread-1",
        &json!({"status":{"type":"active"},"turns":[{"id":"old-turn","status":"inProgress"}]}),
    )
    .await
    .unwrap();
    let calls = rpc.call("fixture/calls", json!({}), 2).await.unwrap();
    let calls = calls["calls"].as_array().unwrap();
    assert_eq!(
        calls[0]["params"],
        json!({"threadId":"thread-1","turnId":"old-turn"})
    );
    assert_eq!(calls[1]["method"], "thread/read");
    assert!(!calls.iter().any(|c| c["method"] == "turn/start"));
    assert!(
        ensure_codex_quiet(&rpc, "thread-1", &json!({}))
            .await
            .is_err()
    );
    rpc.close().await;
}
#[tokio::test]
async fn codex_native_history_uses_full_turn_pages_and_rejects_nonadvancing_cursor() {
    let (dir, rpc) = fixture().await;
    rpc.buffer.lock().unwrap().session = Some(AgentClientSession {
        id: "connection".into(),
        provider: AgentProvider::Codex,
        native_session_id: "thread-1".into(),
        project_root: dir.path().to_string_lossy().into_owned(),
        window: AgentControllerRef {
            window_id: "w".into(),
            incarnation: "i".into(),
        },
        model: "m".into(),
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
    let connection = Connection {
        client: Arc::new(ExternalAgentClient {
            rpc: rpc.clone(),
            provider: AgentProvider::Codex,
        }),
        proof: None,
    };
    let (events, next) = connection.history(None, 20).await.unwrap();
    assert_eq!(events[0].text, "restored answer");
    assert!(events[0].historical);
    assert_eq!(events[0].at_ms, 10_000);
    assert_eq!(next.as_deref(), Some("older"));
    assert_eq!(connection.history(next, 20).await.unwrap().1, None);
    assert!(connection.history(Some("loop".into()), 20).await.is_err());
    let calls = rpc.call("fixture/calls", json!({}), 2).await.unwrap();
    assert_eq!(calls["calls"][0]["params"]["itemsView"], "full");
    assert_eq!(calls["calls"][0]["params"]["threadId"], "thread-1");
    rpc.close().await;
}

#[test]
fn kimi_workspace_aliases_only_resolve_the_recorded_id_in_the_same_project() {
    let dir = tempfile::tempdir().unwrap();
    let home = dir.path();
    let p = home.join("sessions/alias/saved/state.json");
    fs::create_dir_all(p.parent().unwrap()).unwrap();
    fs::write(&p, "{}").unwrap();
    fs::write(
        home.join("workspaces.json"),
        json!({"version":1,"workspaces":{"alias":{"root":"/study"},"foreign":{"root":"/other"}}})
            .to_string(),
    )
    .unwrap();
    assert_eq!(
        kimi_state_path(home, Path::new("/study"), "derived", "saved").unwrap(),
        p
    );
    assert!(kimi_state_path(home, Path::new("/other"), "derived", "saved").is_err());
    assert!(kimi_state_path(home, Path::new("/study"), "derived", "missing").is_err());
}
