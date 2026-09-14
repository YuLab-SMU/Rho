//! Rho-owned HTTP/draft/reader verification; no native Agent or model is started.
use super::*;
use axum::body::{Body,to_bytes};
use rho_contract::*;
use serde_json::{Value,json};
use tower::ServiceExt;

async fn post(app:&Router,path:&str,body:Value,token:&str,window:Option<&str>)->(StatusCode,Value){
    let mut builder=Request::builder().method("POST").uri(path).header(header::HOST,"127.0.0.1:10001")
        .header(header::AUTHORIZATION,token).header(header::CONTENT_TYPE,"application/json");
    if let Some(window)=window{builder=builder.header("x-rho-studio-window",window);}
    let response=app.clone().oneshot(builder.body(Body::from(body.to_string())).unwrap()).await.unwrap();
    let status=response.status();let bytes=to_bytes(response.into_body(),MAX_REPLY).await.unwrap();
    (status,serde_json::from_slice(&bytes).unwrap_or_else(|_|json!({"text":String::from_utf8_lossy(&bytes)})))
}
async fn registered(state:&AppState)->(Arc<NextHost>,String,CallContext,ApplicationWindowRef){
    let host=state.hosting.read().await.selected.as_ref().unwrap().host.clone();
    let project=state.hosting.read().await.info().project_root.unwrap();
    let mut context=NextHost::local_context();context.connection_id="studio:handoff-window".into();
    let result=host.dispatch(&context,HostRequest::ApplicationBridge(ApplicationBridgeRequest::Register{
        window_id:"handoff-window".into(),incarnation:"handoff-life".into(),label:"Handoff fixture".into(),previous_session:None,
    })).await.unwrap();
    let ApplicationBridgeReply::Registered(registration)=serde_json::from_value(result).unwrap() else{panic!()};
    (host,project,context,registration.session.window)
}
async fn call(app:&Router,path:&str,body:Value)->Value{
    let (status,value)=post(app,path,body,"Bearer fixture-only",Some("handoff-window")).await;
    assert!(status.is_success(),"{status}: {value}");value
}
async fn native(app:&Router,project:&str,window:&ApplicationWindowRef)->Value{
    call(app,"/api/agents/tasks/command",json!({"project_root":project,"window":window,"request_id":uuid::Uuid::new_v4().to_string(),
        "command":{"kind":"create","provider":"kimi","model":"fixture","effort":null}})).await["detail"].clone()
}
async fn rho(app:&Router,project:&str,window:&ApplicationWindowRef,id:&str){
    call(app,"/api/agents/components/command",json!({"project_root":project,"window":window,
        "command":{"kind":"create","conversation_id":id,"profile":"project"}})).await;
}

#[tokio::test]
async fn handoff_http_preserves_drafts_receipts_and_private_window_boundary(){
    let (_directory,state,app)=tests::fixture().await;
    let (host,project,context,window)=registered(&state).await;
    rho(&app,&project,&window,"source").await;
    let target=native(&app,&project,&window).await;
    let target_ref=json!({"kind":"native","task_id":target["summary"]["task"]["task_id"]});
    let source_ref=json!({"kind":"rho","conversation_id":"source"});
    let query=|query|json!({"project_root":project,"window":window,"query":query});
    let (status,_)=post(&app,"/api/agents/handoff/query",query(json!({"kind":"source","source":source_ref})),"Bearer native-fixture-only",Some("handoff-window")).await;
    assert_eq!(status,StatusCode::UNAUTHORIZED);
    let (status,error)=post(&app,"/api/agents/handoff/query",query(json!({"kind":"source","source":source_ref})),"Bearer fixture-only",None).await;
    assert_eq!(status,StatusCode::FORBIDDEN);assert_eq!(error["diagnostic"]["code"],"access_denied");
    let before=host.outbox(&context,0,100).await.unwrap();
    let source=call(&app,"/api/agents/handoff/query",query(json!({"kind":"source","source":source_ref}))).await["source"].clone();
    let observed=call(&app,"/api/agents/handoff/query",query(json!({"kind":"target","target":target_ref}))).await["target"].clone();
    let request=json!({"project_root":project,"window":window,"request_id":"handoff-once","source":source_ref,"source_revision":source["revision"],
        "target":target_ref,"target_draft_version":observed["draft_version"],"target_control_generation":observed["control_generation"],
        "body":"Goal: Continue the analysis\nConfirmed: User reviewed the source\nNext: Compare groups","context":[]});
    let receipt=call(&app,"/api/agents/handoff/command",request.clone()).await;
    let repeated=call(&app,"/api/agents/handoff/command",request.clone()).await;
    assert_eq!(receipt,repeated);
    assert_eq!(call(&app,"/api/agents/handoff/query",query(json!({"kind":"receipt","request_id":"handoff-once"}))).await["receipt"],receipt);
    let after=call(&app,"/api/agents/handoff/query",query(json!({"kind":"target","target":target_ref}))).await["target"].clone();
    assert_eq!(after["draft"]["text"],request["body"]);
    let mut stale=request;stale["request_id"]=json!("stale");
    let (status,error)=post(&app,"/api/agents/handoff/command",stale,"Bearer fixture-only",Some("handoff-window")).await;
    assert_eq!(status,StatusCode::CONFLICT);assert_eq!(error["submission"],"rejected");assert_eq!(error["diagnostic"]["code"],"content_changed");
    assert_eq!(before,host.outbox(&context,0,100).await.unwrap());
    assert!(!state.task_agents.has_live().await);assert!(!state.component_agents.has_live().await);
}

#[tokio::test]
async fn handoff_run_reference_uses_the_original_scientific_owner_without_new_execution(){
    let (_directory,state,app)=tests::fixture().await;
    let (host,project,mut context,window)=registered(&state).await;
    let source_task=native(&app,&project,&window).await;
    let id=source_task["summary"]["task"]["task_id"].as_str().unwrap();
    context.principal=Some(context.caller.clone());
    context.caller=CallerIdentity{kind:CallerKind::Agent,id:format!("task:{id}")};
    let operation=host.invoke(&context,Invocation{client_request_id:"source-file".into(),capability:CapabilityRef::new("project.apply_patch",1).unwrap(),
        arguments:json!({"patch":"--- /dev/null\n+++ b/result.txt\n@@ -0,0 +1 @@\n+original-result\n"}),preconditions:vec![]}).await.unwrap();
    assert_eq!(operation.status,OperationStatus::Succeeded);
    context.caller=NextHost::local_context().caller;
    rho(&app,&project,&window,"target").await;
    let source_ref=json!({"kind":"native","task_id":id});let target_ref=json!({"kind":"rho","conversation_id":"target"});
    let query=|query|json!({"project_root":project,"window":window,"query":query});
    let source=call(&app,"/api/agents/handoff/query",query(json!({"kind":"source","source":source_ref}))).await["source"].clone();
    let selection=source["context"].as_array().unwrap().iter().find(|item|item["source"]=="operations").unwrap().clone();
    assert_eq!(selection["reference"]["operation_id"],json!(operation.operation.operation_id));
    let before=host.outbox(&context,0,100).await.unwrap();
    let native=call(&app,"/api/agents/tasks/query",json!({"project_root":project,"query":{"kind":"context_preview","window":window,"selection":selection}})).await;
    let rho=call(&app,"/api/agents/components/context",json!({"project_root":project,"window":window,"session":null,"selection":selection})).await;
    assert_eq!(native["preview"]["native_data"],rho["snapshot"]["native_data"]);
    let target=call(&app,"/api/agents/handoff/query",query(json!({"kind":"target","target":target_ref}))).await["target"].clone();
    call(&app,"/api/agents/handoff/command",json!({"project_root":project,"window":window,"request_id":"run-handoff",
        "source":source_ref,"source_revision":source["revision"],"target":target_ref,"target_draft_version":target["draft_version"],"target_control_generation":null,
        "body":"Review the original operation result.","context":[selection]})).await;
    assert_eq!(before,host.outbox(&context,0,100).await.unwrap());
    assert_eq!(std::fs::read_to_string(std::path::Path::new(&project).join("result.txt")).unwrap(),"original-result\n");
    // A reference stored in a legitimate source draft is still checked against
    // its real reader; handing it off cannot launder a stale file observation.
    let file=call(&app,"/api/agents/tasks/query",json!({"project_root":project,"query":{"kind":"context_preview","window":window,
        "selection":{"source":"files","label":"result.txt","reference":{"path":"result.txt"},"inclusion":"text"}}})).await["preview"]["selection"].clone();
    call(&app,"/api/agents/tasks/command",json!({"project_root":project,"window":window,"request_id":uuid::Uuid::new_v4().to_string(),
        "command":{"kind":"save_draft","control":{"task_id":id,"generation":source_task["summary"]["attachment"]["generation"]},
        "version":source_task["draft"]["version"],"content":{"text":"Source goal","assets":[],"context":[file]}}})).await;
    let source=call(&app,"/api/agents/handoff/query",query(json!({"kind":"source","source":source_ref}))).await["source"].clone();
    let target=call(&app,"/api/agents/handoff/query",query(json!({"kind":"target","target":target_ref}))).await["target"].clone();
    std::fs::write(std::path::Path::new(&project).join("result.txt"),"later user edit\n").unwrap();
    let (status,error)=post(&app,"/api/agents/handoff/command",json!({"project_root":project,"window":window,"request_id":"stale-file",
        "source":source_ref,"source_revision":source["revision"],"target":target_ref,"target_draft_version":target["draft_version"],"target_control_generation":null,
        "body":"This must not be appended.","context":[file]}),"Bearer fixture-only",Some("handoff-window")).await;
    assert_eq!(status,StatusCode::UNPROCESSABLE_ENTITY);assert_eq!(error["submission"],"rejected");
    assert_eq!(call(&app,"/api/agents/handoff/query",query(json!({"kind":"target","target":target_ref}))).await["target"],target);
    assert!(!state.task_agents.has_live().await);assert!(!state.component_agents.has_live().await);
}
