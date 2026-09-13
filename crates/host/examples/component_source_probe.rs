//! Explicit P2 real model + R source acceptance, always in a disposable project.
use rho_contract::*;
use rho_host::{ApplicationStore, ArkConfig, ComponentAgentService, NextHost};
use serde_json::json;
use std::{
    path::PathBuf,
    sync::Arc,
    time::{Duration, Instant},
};

#[tokio::main(flavor = "current_thread")]
async fn main() {
    if let Err(error) = probe().await {
        eprintln!(
            "{}",
            json!({"phase":"component-source-probe","passed":false,"error":error})
        );
        std::process::exit(1);
    }
}
async fn probe() -> Result<(), String> {
    let selected =
        std::env::args().find_map(|arg| arg.strip_prefix("--profile=").map(str::to_owned));
    if selected.as_deref().is_some_and(|name| {
        !["objects", "packages", "plots", "environment", "workspace"].contains(&name)
    }) {
        return Err("Unsupported profile for this probe".into());
    }
    let temp = tempfile::tempdir().map_err(|_| "Cannot create temporary project")?;
    let root = temp
        .path()
        .canonicalize()
        .map_err(|_| "Cannot resolve project")?;
    let project = root.to_string_lossy().into_owned();
    let database = root.join("journal.sqlite");
    let host = Arc::new(
        NextHost::open_ark(
            &database,
            ArkConfig {
                executable: PathBuf::from(std::env::var_os("RHO_ARK").ok_or("Missing RHO_ARK")?),
                r_home: PathBuf::from(std::env::var_os("RHO_R_HOME").ok_or("Missing RHO_R_HOME")?),
                project_root: root.clone(),
                data_root: root.join("runtime"),
                execution_timeout: Duration::from_secs(30),
                library_path: None,
                checkpoint_helper_path: None,
            },
        )
        .await
        .map_err(|_| "Cannot open R Host")?,
    );
    let service = ComponentAgentService::new(Arc::new(ApplicationStore::open(
        &root.join("components.sqlite"),
    )?));
    let result=async {
        let mut context=NextHost::local_context();context.connection_id="studio:source-probe".into();
        let marker=format!("source-{}",uuid::Uuid::new_v4());
        let color=["red","green","blue"][(uuid::Uuid::new_v4().as_bytes()[0]%3) as usize];
        let code=format!("source_data <- data.frame(marker = '{marker}', value = 29L); par(mar=c(0,0,0,0)); plot.new(); rect(-1,-1,2,2,col='{color}',border=NA); invisible(NULL)");
        let setup=host.invoke(&context,Invocation{client_request_id:"fixture-setup".into(),capability:CapabilityRef::new("workspace.run_r",1).unwrap(),arguments:json!({"workspace_instance_id":"main","code":code}),preconditions:vec![]}).await.map_err(|_|"Fixture execution failed")?;
        if setup.status!=OperationStatus::Succeeded{return Err("Fixture did not succeed".into());}
        let output:RunROutput=serde_json::from_value(setup.output.ok_or("Missing fixture output")?).map_err(|_|"Invalid fixture output")?;
        let media=output.output_references.into_iter().rev().find(|r|r.mime_type.starts_with("image/")).ok_or("Missing native plot")?;
        let session=ComponentAgentSession{workspace_instance_id:"main".into(),session_id:output.session_id};
        let ApplicationBridgeReply::Registered(registration)=serde_json::from_value(host.dispatch(&context,HostRequest::ApplicationBridge(ApplicationBridgeRequest::Register{window_id:"probe".into(),incarnation:uuid::Uuid::new_v4().to_string(),label:"Source acceptance".into(),previous_session:None})).await.map_err(|_|"Window registration failed")?).map_err(|_|"Invalid registration")? else{return Err("Unexpected registration".into());};
        let window=registration.session.window.clone();
        let protocol=match std::env::var("RHO_COMPONENT_MODEL_PROTOCOL").as_deref(){Ok("anthropic")=>ComponentModelProtocol::Anthropic,_=>ComponentModelProtocol::OpenaiCompletions};
        service.configure(&host,&context,&project,&window,&ComponentModelSettings{version:0,enabled:true,connection:Some(ComponentModelConnection{protocol,base_url:std::env::var("RHO_COMPONENT_MODEL_BASE_URL").map_err(|_|"Missing model URL")?,model:std::env::var("RHO_COMPONENT_MODEL_ID").map_err(|_|"Missing model ID")?,credential:ComponentCredentialRef::Environment{name:std::env::var("RHO_COMPONENT_MODEL_KEY_ENV").map_err(|_|"Missing credential reference")?}})}).await.map_err(|_|"Model configuration failed")?;
        for (id,kind) in [("test-connection",ComponentModelTestKind::Connection),("test-images",ComponentModelTestKind::Images)] {
            if selected.is_some() && !(selected.as_deref()==Some("plots") && kind==ComponentModelTestKind::Images) {continue;}

            service.test_model(host.clone(),context.clone(),ComponentModelTestRequest{project_root:project.clone(),window:window.clone(),request_id:id.into(),model_settings_version:1,kind}).await.map_err(|e|e.to_string())?;
            let test=tokio::time::timeout(Duration::from_secs(125),async{let mut heartbeat=Instant::now();loop{if heartbeat.elapsed()>=Duration::from_secs(3){host.dispatch(&context,HostRequest::ApplicationBridge(ApplicationBridgeRequest::Renew{session:registration.session.clone()})).await.map_err(|e|e.to_string())?;heartbeat=Instant::now();}let test=service.diagnostic(&host,&context,&project,id).map_err(|e|e.to_string())?.ok_or("Missing diagnostic")?;if !matches!(test.state,ComponentModelTestState::Queued|ComponentModelTestState::Running){return Ok::<_,String>(test);}tokio::time::sleep(Duration::from_millis(25)).await;}}).await.map_err(|_|"Diagnostic timeout")??;
            if test.state!=ComponentModelTestState::Passed{return Err(format!("Diagnostic {id} failed: {:?}",test.detail));}
            println!("{}",json!({"phase":"component-model-diagnostic","kind":kind,"passed":true}));
        }
        let packages=host.dispatch(&context,HostRequest::QuerySnapshot(QueryRequest{capability:CapabilityRef::new("workspace.packages",1).unwrap(),arguments:json!({"workspace_instance_id":"main","expected_session":session.session_id,"package_name":"stats","mode":"installed"})})).await.map_err(|_|"Package observation failed")?;
        let copy=&packages["data"]["packages"][0];let version=copy["version"].as_str().ok_or("Missing package version")?.to_string();
        let cases=vec![
            ("environment",ComponentAgentProfile::Environment,AgentContextSelection{source:"environment".into(),label:"Main session".into(),reference:json!({"workspace_instance_id":"main"}),inclusion:"summary".into()},"Read the selected R-session metadata. Reply only with its exact native_session_id, without quotes or formatting. Do not use tools.".to_string(),session.session_id.clone()),

            ("objects",ComponentAgentProfile::Objects,AgentContextSelection{source:"objects".into(),label:"source_data".into(),reference:json!({"workspace_instance_id":"main","expected_session":session.session_id,"name":"source_data"}),inclusion:"selection".into()},"Read the selected source_data context. Reply with only the exact string in the marker column, without quotes or formatting. Do not use tools.".to_string(),marker),
            ("packages",ComponentAgentProfile::Packages,AgentContextSelection{source:"packages".into(),label:"stats".into(),reference:json!({"workspace_instance_id":"main","expected_session":session.session_id,"observation_id":packages["data"]["observation_id"],"package":"stats","library_path":copy["library_path"]}),inclusion:"summary".into()},"Read the selected installed-copy metadata. Reply with only its exact version number. Do not use tools.".to_string(),version),
            ("plots",ComponentAgentProfile::Plots,AgentContextSelection{source:"plots".into(),label:"Native color plot".into(),reference:serde_json::to_value(&media).unwrap(),inclusion:"image".into()},"Inspect the actual attached image. Reply with only its dominant fill color as one lowercase English word. Do not use tools.".to_string(),color.to_string()),
        ];
        let connection=rusqlite::Connection::open(&database).map_err(|_|"Cannot inspect journal")?;
        let count=||connection.query_row("SELECT COUNT(*) FROM operations",[],|r|r.get::<_,u64>(0)).unwrap();let before=count();
        for (name,profile,selection,text,expected) in cases {
            if selected.as_ref().is_some_and(|choice|choice!=name) {continue;}

            host.dispatch(&context,HostRequest::ApplicationBridge(ApplicationBridgeRequest::Renew{session:registration.session.clone()})).await.map_err(|_|"Window heartbeat failed")?;
            let preview=service.preview_source(&host,&context,ComponentSourcePreviewRequest{project_root:project.clone(),window:window.clone(),session:Some(session.clone()),selection}).await.map_err(|e|e.to_string())?;
            if let Some(error)=preview.error{return Err(error);}
            let conversation=service.create(&host,&context,&project,&window,name,profile).map_err(|e|e.to_string())?;
            let started=Instant::now();
            let run=service.start(host.clone(),context.clone(),&project,ComponentAgentStart{ continuation: None,request_id:format!("{name}-request"),conversation_id:conversation.conversation_id,conversation_version:conversation.version,window:window.clone(),model_settings_version:1,text,grant:ComponentAgentGrant{mode:ComponentAgentMode::Explain,session:Some(session.clone()),documents:vec![],files:vec![]},sources:vec![preview.snapshot.ok_or("Source is unavailable")?.selection]}).await.map_err(|e|e.to_string())?;
            let terminal=tokio::time::timeout(Duration::from_secs(125),async{let mut heartbeat=Instant::now();loop{if heartbeat.elapsed()>=Duration::from_secs(3){host.dispatch(&context,HostRequest::ApplicationBridge(ApplicationBridgeRequest::Renew{session:registration.session.clone()})).await.map_err(|e|e.to_string())?;heartbeat=Instant::now();}let observed=service.run(&host,&context,&project,&run.run_id).map_err(|e|e.to_string())?;if observed.state.is_terminal(){return Ok::<_,String>(observed);}tokio::time::sleep(Duration::from_millis(25)).await;}}).await.map_err(|_|"Model deadline exceeded")??;
            if terminal.state!=ComponentAgentRunState::Completed{return Err(format!("{name} failed: {:?}",terminal.reason));}
            let page=service.events(&host,&context,&project,&run.run_id,0,128).map_err(|e|e.to_string())?;
            let answer=page.events.into_iter().filter_map(|e|match e.content{ComponentAgentEventContent::Text{text}=>Some(text),_=>None}).collect::<String>();
            let correct=if name=="plots" {image_color(&answer)==Some(expected.as_str())} else {answer.trim()==expected};
            let after=count();
            println!("{}",json!({"phase":"component-source-evidence","profile":name,"expected":expected,"answer":answer,"correct":correct,"scientific_operations_before":before,"scientific_operations_after":after,"model_calls":terminal.model_calls,"tool_calls":terminal.tool_calls}));
            if !correct || after!=before{return Err(format!("{name} source answer or scientific operation count did not match"));}
            println!("{}",json!({"phase":"component-source-probe","profile":name,"passed":true,"model_calls":terminal.model_calls,"tool_calls":terminal.tool_calls,"additional_scientific_operations":0,"elapsed_ms":started.elapsed().as_millis()}));
        }
        if std::env::args().any(|arg|arg=="--with-run") || selected.as_deref()==Some("workspace") {
            host.dispatch(&context,HostRequest::ApplicationBridge(ApplicationBridgeRequest::Renew{session:registration.session.clone()})).await.map_err(|_|"Window heartbeat failed")?;
            let conversation=service.create(&host,&context,&project,&window,"authorized-run",ComponentAgentProfile::Workspace).map_err(|e|e.to_string())?;
            let expected=format!("run-{}",uuid::Uuid::new_v4());
            let code=format!("component_answer <- '{expected}'; component_answer");
            let text=format!("In the authorized Main session, call workspace_run_r exactly once with this exact code:\n```r\n{code}\n```\nOmit output_mode so the native structured value is returned. Then reply with only that returned string, without quotes or formatting.");
            let started=Instant::now();
            let run=service.start(host.clone(),context.clone(),&project,ComponentAgentStart{ continuation: None,request_id:"authorized-run".into(),conversation_id:conversation.conversation_id,conversation_version:conversation.version,window:window.clone(),model_settings_version:1,text,grant:ComponentAgentGrant{mode:ComponentAgentMode::Run,session:Some(session.clone()),documents:vec![],files:vec![]},sources:vec![]}).await.map_err(|e|e.to_string())?;
            let terminal=tokio::time::timeout(Duration::from_secs(125),async{let mut heartbeat=Instant::now();loop{if heartbeat.elapsed()>=Duration::from_secs(3){host.dispatch(&context,HostRequest::ApplicationBridge(ApplicationBridgeRequest::Renew{session:registration.session.clone()})).await.map_err(|e|e.to_string())?;heartbeat=Instant::now();}let run=service.run(&host,&context,&project,&run.run_id).map_err(|e|e.to_string())?;if run.state.is_terminal(){return Ok::<_,String>(run);}tokio::time::sleep(Duration::from_millis(25)).await;}}).await.map_err(|_|"Run model deadline exceeded")??;
            if terminal.state!=ComponentAgentRunState::Completed{return Err(format!("Authorized run failed: {:?}",terminal.reason));}
            let tools=service.tools(&host,&context,&project,&run.run_id).map_err(|e|e.to_string())?;
            let writes=tools.iter().filter(|tool|tool.mutation).collect::<Vec<_>>();
            println!("{}",json!({"phase":"component-run-evidence","model_calls":terminal.model_calls,"tool_calls":terminal.tool_calls,"scientific_operations":count()-before,"tools":tools}));
            if writes.len()!=1 || count()!=before+1{return Err("Unexpected scientific dispatch count".into());}
            let record=host.get_operation(&context,writes[0].operation_id.as_ref().ok_or("Missing native operation identity")?).await.map_err(|e|e.to_string())?.ok_or("Missing native record")?;
            if record.status!=OperationStatus::Succeeded || record.operation.normalized_arguments["code"].as_str()!=Some(&code){return Err("Native operation did not match authorized code".into());}
            if record.output.as_ref().and_then(|output|output["value"].as_str())!=Some(expected.as_str()){return Err("Native R value did not match the requested result".into());}
            let events=service.events(&host,&context,&project,&run.run_id,0,128).map_err(|e|e.to_string())?;
            let answer=final_answer(events.events);
            println!("{}",json!({"phase":"component-run-answer","expected":expected,"answer":answer}));
            if answer.trim()!=expected{return Err("Model did not return the native R result".into());}
            println!("{}",json!({"phase":"component-authorized-run","passed":true,"model_calls":terminal.model_calls,"tool_calls":terminal.tool_calls,"scientific_operations":1,"elapsed_ms":started.elapsed().as_millis()}));
        }
        Ok(())
    }.await;
    service.close().await;
    if result.is_err() {
        eprintln!("{}", json!({"phase":"retained-source-fixture","path":temp.keep()}));
    }
    result
}

fn image_color(raw: &str) -> Option<&'static str> {
    let mut text = raw.trim();
    for marker in ["**", "__", "`", "\"", "'"] {
        if let Some(inner) = text
            .strip_prefix(marker)
            .and_then(|s| s.strip_suffix(marker))
        {
            text = inner.trim();
            break;
        }
    }
    match text.to_ascii_lowercase().as_str() {
        "red" => Some("red"),
        "green" => Some("green"),
        "blue" => Some("blue"),
        _ => None,
    }
}

// Progress narration before tools is not the final model answer after their results.
fn final_answer(events: Vec<ComponentAgentEvent>) -> String {
    let mut answer = String::new();
    for event in events {
        match event.content {
            ComponentAgentEventContent::Text { text } => answer.push_str(&text),
            ComponentAgentEventContent::Tool { .. } => answer.clear(),
            _ => {}
        }
    }
    answer
}

#[test]
fn final_answer_excludes_progress_before_tool_completion() {
    let events = vec![
        ComponentAgentEventContent::Text { text: "I will run this now.".into() },
        ComponentAgentEventContent::Tool { receipt_id: "tool".into(), phase: ComponentToolPhase::Resolved },
        ComponentAgentEventContent::Text { text: "native-".into() },
        ComponentAgentEventContent::Text { text: "result".into() },
        ComponentAgentEventContent::State { state: ComponentAgentRunState::Completed, reason: None },
    ].into_iter().enumerate().map(|(index, content)| ComponentAgentEvent {
        run_id: "run".into(), sequence: index as u64 + 1, created_at_ms: 1, content,
    }).collect();
    assert_eq!(final_answer(events), "native-result");
}
