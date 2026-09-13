//! Explicit real-model acceptance of the built-in Host query path on a disposable project.
use rho_contract::*;
use rho_host::{ApplicationStore, ComponentAgentService, NextHost};
use serde_json::json;
use std::{
    sync::Arc,
    time::{Duration, Instant},
};

#[tokio::main(flavor = "current_thread")]
async fn main() {
    if let Err(error) = probe().await {
        eprintln!(
            "{}",
            json!({"phase":"component-host-probe","passed":false,"error":error})
        );
        std::process::exit(1);
    }
}
async fn probe() -> Result<(), String> {
    let directory = tempfile::tempdir().map_err(|_| "Cannot create temporary project")?;
    let root = directory.path().join("study");
    std::fs::create_dir(&root).map_err(|_| "Cannot create project")?;
    let marker = format!("rho-marker-{}", uuid::Uuid::new_v4());
    std::fs::write(root.join("analysis.R"), format!("marker <- '{marker}'\n"))
        .map_err(|_| "Cannot write fixture")?;
    let project = root
        .canonicalize()
        .map_err(|_| "Cannot resolve project")?
        .to_string_lossy()
        .into_owned();
    let host = Arc::new(
        NextHost::open_project(directory.path().join("journal.sqlite"), &project)
            .await
            .map_err(|_| "Cannot open Host")?,
    );
    let service = ComponentAgentService::new(Arc::new(ApplicationStore::open(
        &directory.path().join("components.sqlite"),
    )?));
    let result=async {
        let mut context=NextHost::local_context();context.connection_id="studio:component-probe".into();
        let registration=host.dispatch(&context,HostRequest::ApplicationBridge(ApplicationBridgeRequest::Register{window_id:"probe-window".into(),incarnation:uuid::Uuid::new_v4().to_string(),label:"Synthetic component acceptance".into(),previous_session:None})).await.map_err(|_|"Cannot register test window")?;
        let ApplicationBridgeReply::Registered(registration)=serde_json::from_value(registration).map_err(|_|"Invalid window registration")? else {return Err("Unexpected registration response".into());};
        let window=registration.session.window;
        let protocol=match std::env::var("RHO_COMPONENT_MODEL_PROTOCOL").as_deref() {Ok("anthropic")=>ComponentModelProtocol::Anthropic,Ok("openai_completions")|Err(_)=>ComponentModelProtocol::OpenaiCompletions,_=>return Err("Unsupported model protocol".into())};
        let model=ComponentModelConnection{protocol,base_url:std::env::var("RHO_COMPONENT_MODEL_BASE_URL").map_err(|_|"Missing model endpoint")?,model:std::env::var("RHO_COMPONENT_MODEL_ID").map_err(|_|"Missing model ID")?,credential:ComponentCredentialRef::Environment{name:std::env::var("RHO_COMPONENT_MODEL_KEY_ENV").map_err(|_|"Missing credential reference")?}};
        service.configure(&host,&context,&project,&window,&ComponentModelSettings{version:0,enabled:true,connection:Some(model)}).await.map_err(|_|"Model configuration rejected")?;
        let conversation=service.create(&host,&context,&project,&window,"probe",ComponentAgentProfile::Project).map_err(|_|"Conversation creation failed")?;
        let request=ComponentAgentStart{ continuation: None,request_id:"probe-request".into(),conversation_id:conversation.conversation_id,conversation_version:conversation.version,window:window.clone(),model_settings_version:1,
            text:"Use project_read_text to read analysis.R. Reply with only the exact marker string assigned there, without quotes or formatting. Do not run or edit anything.".into(),grant:ComponentAgentGrant{mode:ComponentAgentMode::Explain,session:None,documents:vec![],files:vec![]},sources:vec![]};
        let started=Instant::now();let run=service.start(host.clone(),context.clone(),&project,request.clone()).await.map_err(|_|"Run admission failed")?;
        let repeated=service.start(host.clone(),context.clone(),&project,request).await.map_err(|_|"Repeated request failed")?;
        if run.run_id!=repeated.run_id{return Err("Request identity changed".into());}
        let terminal=tokio::time::timeout(Duration::from_secs(125),async {
            loop {
                let observed=service.run(&host,&context,&project,&run.run_id).map_err(|_|"Run observation failed")?;
                if observed.state.is_terminal(){return Ok::<_,String>(observed);}
                tokio::time::sleep(Duration::from_millis(25)).await;
            }
        }).await.map_err(|_|"Real model deadline exceeded")??;
        if terminal.state!=ComponentAgentRunState::Completed {return Err(format!("Assistant ended in {:?}: {}",terminal.state,terminal.reason.unwrap_or_default()));}
        let tools=service.tools(&host,&context,&project,&run.run_id).map_err(|_|"Tool receipt read failed")?;
        if tools.is_empty() || tools.iter().any(|tool|tool.mutation) || !tools.iter().any(|tool|tool.capability=="project.read_text" && tool.result.as_ref().is_some_and(|result|result.to_string().contains(&marker))) {return Err("Authoritative read-only tool evidence did not match".into());}
        let page=service.events(&host,&context,&project,&run.run_id,0,128).map_err(|_|"Event read failed")?;
        let answer=page.events.iter().filter_map(|event|match &event.content {ComponentAgentEventContent::Text{text}=>Some(text.as_str()),_=>None}).collect::<String>();
        if answer.trim()!=marker {return Err("Model answer did not match the unseen file marker".into());}
        println!("{}",json!({"phase":"component-host-probe","passed":true,"protocol":protocol,"request_deduplicated":true,"native_file_verified":true,"model_calls":terminal.model_calls,"tool_calls":terminal.tool_calls,"input_tokens":terminal.input_tokens,"output_tokens":terminal.output_tokens,"elapsed_ms":started.elapsed().as_millis()}));
        Ok(())
    }.await;
    service.close().await;
    result
}
