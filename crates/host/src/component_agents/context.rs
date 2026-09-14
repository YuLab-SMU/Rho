//! Validated source expansion, reusing native composer readers and their real owners.
use super::*;
use base64::{Engine, engine::general_purpose::STANDARD};
use sha2::{Digest, Sha256};
use std::sync::Mutex as StdMutex;

pub(super) struct PreparedContext {
    pub context: ComponentAgentContext,
    pub images: Vec<ComponentImageInput>,
}

pub(crate) async fn search(
    host: &NextHost,
    context: &CallContext,
    request: &ComponentSourceSearch,
) -> Result<ComponentSourceSearchResult, ApplicationError> {
    let _actor =
        ComponentAgentService::actor(host, context, &request.project_root, &request.window)?;
    if request.text.len() > 256 || !(1..=50).contains(&request.limit) {
        return Err(error("Source search exceeds its budget"));
    }
    let reader = crate::AgentContextReader::new(&request.project_root, host, context);
    if matches!(request.source.as_str(), "files" | "editor" | "plots" | "operations") {
        let (items, notices) = crate::agent_context::search(
            &reader,
            &request.window,
            Some(&request.source),
            &request.text,
            request.limit,
            &[],
        )
        .await
        .map_err(error)?;
        return Ok(ComponentSourceSearchResult { items, notices });
    }
    let item =
        |label: String, description: String, reference: Value, inclusion: &str| AgentContextItem {
            title: label.clone(),
            description,
            kind: request.source.clone(),
            selection: AgentContextSelection {
                source: request.source.clone(),
                label,
                reference,
                inclusion: inclusion.into(),
            },
        };
    let result=async {
        match request.source.as_str(){
            "objects"|"tables"|"packages"|"workspace"=>{
                let session=request.session.as_ref().ok_or("Choose an R session")?;
                let _hold=host.hold_runtime_instance(&session.workspace_instance_id,&session.session_id,"component-source-search","Source search").map_err(|e|e.to_string())?;
                if request.source=="workspace" {return Ok(vec![item("Console / Workspace".into(),session.workspace_instance_id.clone(),json!({"workspace_instance_id":session.workspace_instance_id,"expected_session":session.session_id}),"summary")]);}
                if request.source=="packages" {
                    let data=reader.query("workspace.packages",json!({"workspace_instance_id":session.workspace_instance_id,"expected_session":session.session_id,"mode":"installed","filter":request.text,"grouped":false,"limit":request.limit})).await?;
                    return Ok(data["packages"].as_array().into_iter().flatten().filter_map(|package|{
                        let name=package["name"].as_str()?;Some(item(name.into(),format!("{} · {}",package["version"].as_str().unwrap_or("unknown"),package["library_path"].as_str().unwrap_or_default()),json!({"workspace_instance_id":session.workspace_instance_id,"expected_session":session.session_id,"package":name,"library_path":package["library_path"],"observation_id":data["observation_id"]}),"summary"))
                    }).take(request.limit as usize).collect());
                }
                let data=reader.query("workspace.snapshot",json!({"workspace_instance_id":session.workspace_instance_id,"expected_session":session.session_id,"limit":200})).await?;
                Ok(data["objects"].as_array().into_iter().flatten().filter_map(|object|{
                    let name=object["name"].as_str()?;if !name.to_lowercase().contains(&request.text.to_lowercase()){return None;}
                    if request.source=="tables" && object["dimensions"].as_array().is_none_or(|d|d.len()!=2){return None;}
                    Some(item(name.into(),object["object_type"].as_str().unwrap_or("R object").into(),json!({"workspace_instance_id":session.workspace_instance_id,"expected_session":session.session_id,"name":name}),if request.source=="tables"{"selection"}else{"summary"}))
                }).take(request.limit as usize).collect())
            },
            "environment"=>{
                let data=reader.query("runtime.instances",json!({"limit":request.limit})).await?;
                Ok(data["instances"].as_array().into_iter().flatten().filter_map(|instance|{
                    let id=instance["workspace_instance_id"].as_str()?;let name=instance["name"].as_str().unwrap_or(id);
                    if !name.to_lowercase().contains(&request.text.to_lowercase()){return None;}
                    Some(item(name.into(),"R session metadata".into(),json!({"workspace_instance_id":id}),"summary"))
                }).collect())
            },
            _=>Err("Unknown component source".into()),
        }
    }.await;
    match result {
        Ok(items) => Ok(ComponentSourceSearchResult {
            items,
            notices: if matches!(request.source.as_str(), "objects" | "tables") {
                vec!["Suggestions cover at most the first 200 bindings".into()]
            } else {
                vec![]
            },
        }),
        Err(message) => Ok(ComponentSourceSearchResult {
            items: vec![],
            notices: vec![message],
        }),
    }
}

fn source_session(
    selection: &AgentContextSelection,
    session: Option<&ComponentAgentSession>,
) -> Result<(), ApplicationError> {
    if matches!(
        selection.source.as_str(),
        "objects" | "tables" | "packages" | "workspace"
    ) {
        let session = session.ok_or_else(|| error("This source requires an explicit R session"))?;
        if selection.reference["workspace_instance_id"].as_str()
            != Some(&session.workspace_instance_id)
            || selection.reference["expected_session"].as_str() != Some(&session.session_id)
        {
            return Err(error("Context source belongs to a different R session"));
        }
    }
    Ok(())
}

pub(crate) async fn preview(
    host: &NextHost,
    context: &CallContext,
    request: &ComponentSourcePreviewRequest,
    sending: bool,
) -> Result<ComponentSourcePreview, ApplicationError> {
    let _actor =
        ComponentAgentService::actor(host, context, &request.project_root, &request.window)?;
    let selection = &request.selection;
    if serde_json::to_vec(selection).map_err(error)?.len() > 64 * 1024 {
        return Err(error("Context reference exceeds 64 KiB"));
    }
    source_session(selection, request.session.as_ref())?;
    if selection.source == "editor"
        && selection
            .reference
            .get("window")
            .is_some_and(|w| w != &json!(request.window))
    {
        return Err(error("Document source belongs to another window"));
    }
    let observations = StdMutex::new(Vec::new());
    let reader = crate::AgentContextReader::new(&request.project_root, host, context)
        .recording(&observations);
    let result=async {
        let _hold=if matches!(selection.source.as_str(),"objects"|"tables"|"packages"|"workspace") {
            let session=request.session.as_ref().unwrap();
            Some(host.hold_runtime_instance(&session.workspace_instance_id,&session.session_id,"component-context","Component source preview").map_err(|e|e.to_string())?)
        } else {None};
        match selection.source.as_str() {
            "files"|"editor"|"objects"|"tables"|"plots"|"operations"=>crate::agent_context::preview(&reader,&request.window,selection,&[],sending).await,
            "packages"=>{
                if sending && selection.reference["index_ref"].as_str().is_none() {return Err("Preview this package copy before including it".into());}
                if !matches!(selection.inclusion.as_str(),"summary"|"selection") {return Err("Unsupported package inclusion".into());}
                let session=request.session.as_ref().unwrap();
                let mut args=selection.reference.clone();
                let obj=args.as_object_mut().ok_or("Package source must be an object")?;
                obj.remove("workspace_instance_id");obj.remove("expected_session");
                obj.insert("expected_session".into(),json!(session.session_id));
                obj.insert("workspace_instance_id".into(),json!(session.workspace_instance_id));
                obj.insert("limit".into(),json!(20));
                let data=reader.query("workspace.package_index",args).await?;
                let page:PackageIndexPage=serde_json::from_value(data.clone()).map_err(|e|e.to_string())?;
                let mut selected=selection.clone();selected.label=page.package.clone();
                selected.reference["index_ref"]=json!(page.index_ref);
                Ok(AgentContextPreview{selection:selected,title:page.package.clone(),description:format!("Package · {} · {}",page.package,page.version),text:"Static installed-copy metadata; loadability and installation history were not inferred.".into(),native_data:data,columns:vec![],rows:vec![],image_base64:None,image_mime_type:None,inclusions:vec!["summary".into(),"selection".into()],truncated:!page.complete})
            },
            "workspace"=>{
                if selection.inclusion!="summary" {return Err("Workspace sources include only bounded state".into());}
                let session=request.session.as_ref().unwrap();
                let data=reader.query("workspace.console_state",json!({"workspace_instance_id":session.workspace_instance_id})).await?;
                // Native stdin prompts may contain secrets; they are never model context.
                let mut data=data;
                if let Some(object)=data.as_object_mut(){object.remove("input_request");object.remove("input");}
                Ok(simple_preview(selection,"Console / Workspace",data))
            },
            "environment"=>{
                if selection.inclusion!="summary" {return Err("Environment sources include only bounded metadata".into());}
                let id=selection.reference["workspace_instance_id"].as_str().ok_or("Select an R session")?;
                let data=reader.query("runtime.instance",json!({"workspace_instance_id":id})).await?;
                Ok(simple_preview(selection,"R session",data))
            },
            _=>Err("This component context source is unavailable".into()),
        }
    }.await;
    let observed = observations
        .into_inner()
        .map_err(|_| error("Context observations unavailable"))?;
    let preview = match result {
        Ok(preview) => preview,
        Err(message) => {
            return Ok(ComponentSourcePreview {
                snapshot: None,
                image_base64: None,
                image_mime_type: None,
                observations: observed,
                error: Some(message),
            });
        }
    };
    if serde_json::to_vec(&preview.native_data)
        .map_err(error)?
        .len()
        > 64 * 1024
        || preview.text.len() > 64 * 1024
    {
        return Err(ApplicationError::Budget(
            "Select a smaller context excerpt".into(),
        ));
    }
    let evidence = match preview.selection.source.as_str() {
        "operations" => vec![ComponentAgentEvidence::Operation {
            operation_id: serde_json::from_value(preview.selection.reference["operation_id"].clone()).map_err(error)?,
        }],
        "files" => vec![ComponentAgentEvidence::File {
            path: preview.selection.reference["path"]
                .as_str()
                .unwrap_or_default()
                .into(),
            sha256: preview.selection.reference["expected_sha256"]
                .as_str()
                .unwrap_or_default()
                .into(),
        }],
        "plots" => vec![ComponentAgentEvidence::Media {
            reference: serde_json::from_value(preview.selection.reference.clone())
                .map_err(error)?,
        }],
        "editor" => vec![ComponentAgentEvidence::Document {
            document: serde_json::from_value(preview.selection.reference["document"].clone())
                .map_err(error)?,
        }],
        _ => vec![ComponentAgentEvidence::Observation {
            capability: observed
                .last()
                .map(|o| o.capability.clone())
                .unwrap_or_default(),
            reference: preview.selection.reference.clone(),
        }],
    };
    let snapshot = ComponentSourceSnapshot {
        selection: preview.selection,
        title: preview.title,
        description: preview.description,
        text: preview.text,
        native_data: preview.native_data,
        truncated: preview.truncated,
        observations: observed.clone(),
        evidence,
    };
    let output = ComponentSourcePreview {
        snapshot: Some(snapshot),
        image_base64: preview.image_base64,
        image_mime_type: preview.image_mime_type,
        observations: observed,
        error: None,
    };
    if output.image_base64.is_some() {
        image_input(&output)?;
    }
    Ok(output)
}
fn simple_preview(
    selection: &AgentContextSelection,
    title: &str,
    data: Value,
) -> AgentContextPreview {
    AgentContextPreview {
        selection: selection.clone(),
        title: title.into(),
        description: title.into(),
        text: String::new(),
        native_data: data,
        columns: vec![],
        rows: vec![],
        image_base64: None,
        image_mime_type: None,
        inclusions: vec!["summary".into()],
        truncated: false,
    }
}
fn image_input(preview: &ComponentSourcePreview) -> Result<ComponentImageInput, ApplicationError> {
    let snapshot = preview
        .snapshot
        .as_ref()
        .ok_or_else(|| error("Image source is unavailable"))?;
    let base64 = preview
        .image_base64
        .as_ref()
        .ok_or_else(|| error("Image bytes are unavailable"))?;
    let mime = preview
        .image_mime_type
        .as_deref()
        .ok_or_else(|| error("Image media type is unavailable"))?;
    if base64.len() > 2 * 1024 * 1024 * 4 / 3 + 4 || !matches!(mime, "image/png" | "image/jpeg") {
        return Err(error("Unsupported or oversized source image"));
    }
    let bytes = STANDARD
        .decode(base64)
        .map_err(|_| error("Invalid verified image encoding"))?;
    if bytes.len() > 2 * 1024 * 1024 {
        return Err(error("Source image exceeds 2 MiB"));
    }
    let sha256 = format!("sha256:{:x}", Sha256::digest(&bytes));
    if snapshot.native_data["preview_sha256"].as_str() != Some(&sha256) {
        return Err(error("Image bytes do not match their owner identity"));
    }
    Ok(ComponentImageInput {
        reference: ComponentImageSource::Scientific(serde_json::from_value(snapshot.selection.reference.clone()).map_err(error)?),
        mime_type: mime.into(),
        base64: base64.clone(),
        sha256,
    })
}
pub(super) async fn prepare(
    host: &NextHost,
    context: &CallContext,
    project: &str,
    request: &ComponentAgentStart,
) -> Result<PreparedContext, ApplicationError> {
    if request.sources.len() > 16 {
        return Err(error("Too many context sources"));
    }
    let mut sources = Vec::new();
    let mut images = Vec::new();
    for selection in &request.sources {
        let result = preview(
            host,
            context,
            &ComponentSourcePreviewRequest {
                project_root: project.into(),
                window: request.window.clone(),
                session: request.grant.session.clone(),
                selection: selection.clone(),
            },
            true,
        )
        .await?;
        if let Some(message) = result.error {
            return Err(error(message));
        }
        if result.image_base64.is_some() {
            images.push(image_input(&result)?);
        }
        sources.push(
            result
                .snapshot
                .ok_or_else(|| error("Context source is unavailable"))?,
        );
    }
    let context = ComponentAgentContext { sources, history: None };
    if images.len() > 2 || serde_json::to_vec(&context).map_err(error)?.len() > 64 * 1024 {
        return Err(ApplicationError::Budget(
            "Selected context exceeds the text/image budget".into(),
        ));
    }
    Ok(PreparedContext { context, images })
}
