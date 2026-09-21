//! Composer information channels use existing scientific/application query owners.
//! A provider receives a read-only port, never a second execution/approval loop.
use crate::NextHost;
use async_trait::async_trait;
use base64::{Engine, engine::general_purpose::STANDARD};
use rho_agent_client::NativeInput;
use rho_contract::*;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::sync::{Arc, Mutex};

pub struct AgentContextReader<'a> {
    pub project: &'a str,
    host: &'a NextHost,
    context: &'a CallContext,
    observations: Option<&'a Mutex<Vec<ComponentSourceObservation>>>,
}
impl<'a> AgentContextReader<'a> {
    pub(crate) fn new(project: &'a str, host: &'a NextHost, context: &'a CallContext) -> Self {
        Self {
            project,
            host,
            context,
            observations: None,
        }
    }
    pub(crate) fn recording(
        mut self,
        observations: &'a Mutex<Vec<ComponentSourceObservation>>,
    ) -> Self {
        self.observations = Some(observations);
        self
    }
    pub async fn query(&self, id: &str, args: Value) -> Result<Value, String> {
        let value = self
            .host
            .dispatch(
                self.context,
                HostRequest::QuerySnapshot(QueryRequest {
                    capability: CapabilityRef {
                        id: id.into(),
                        version: 1,
                    },
                    arguments: args,
                }),
            )
            .await
            .map_err(|e| e.to_string())?;
        let snapshot: QuerySnapshot = serde_json::from_value(value).map_err(|e| e.to_string())?;
        if let Some(observations) = self.observations {
            let mut observations = observations
                .lock()
                .map_err(|_| "Context observation storage unavailable")?;
            if observations.len() >= 32 {
                return Err("Too many source observations".into());
            }
            observations.push(ComponentSourceObservation {
                capability: id.into(),
                target: snapshot.target.clone(),
                source: snapshot.source.clone(),
                observed_at_ms: snapshot.observed_at_ms,
                status: snapshot.status,
                completeness: snapshot.completeness,
                notices: snapshot.notices.clone(),
            });
        }
        if snapshot.status != QueryStatus::Ready {
            let message = snapshot.notices.join("\n");
            return Err(if message.is_empty() {
                format!("{id} is not ready")
            } else {
                message
            });
        }
        Ok(snapshot.data.unwrap_or(Value::Null))
    }
}
#[async_trait]
pub trait AgentContextProvider: Send + Sync {
    fn source(&self) -> AgentContextSource;
    async fn search(
        &self,
        reader: &AgentContextReader<'_>,
        window: &ApplicationWindowRef,
        text: &str,
        limit: u32,
    ) -> Result<Vec<AgentContextItem>, String>;
    async fn preview(
        &self,
        reader: &AgentContextReader<'_>,
        window: &ApplicationWindowRef,
        selection: &AgentContextSelection,
    ) -> Result<AgentContextPreview, String>;
}
pub(crate) fn sources(plugins: &[Arc<dyn AgentContextProvider>]) -> Vec<AgentContextSource> {
    let mut list = [
        ("files", "Files"),
        ("editor", "Editor"),
        ("objects", "Objects"),
        ("plots", "Plots"),
        ("operations", "Runs"),
        ("tables", "Tables"),
        ("packages", "Packages"),
        ("help", "Help"),
        ("viewer", "Viewer"),
        ("annotations", "Annotations"),
        ("workspace", "Console / Workspace"),
        ("environment", "R Sessions"),
    ]
    .into_iter()
    .map(|(id, name)| AgentContextSource {
        id: id.into(),
        name: name.into(),
        plugin: false,
    })
    .collect::<Vec<_>>();
    list.extend(plugins.iter().map(|p| p.source()));
    list
}
fn item(
    source: &str,
    title: String,
    description: String,
    kind: &str,
    reference: Value,
    inclusion: &str,
) -> AgentContextItem {
    AgentContextItem {
        selection: AgentContextSelection {
            source: source.into(),
            label: title.clone(),
            reference,
            inclusion: inclusion.into(),
        },
        title,
        description,
        kind: kind.into(),
    }
}
pub(crate) async fn search(
    reader: &AgentContextReader<'_>,
    window: &ApplicationWindowRef,
    source: Option<&str>,
    text: &str,
    limit: u32,
    plugins: &[Arc<dyn AgentContextProvider>],
) -> Result<(Vec<AgentContextItem>, Vec<String>), String> {
    if text.len() > 256 || !(1..=50).contains(&limit) {
        return Err("Context search exceeds its budget".into());
    }
    let mut result = Vec::new();
    let mut notices = Vec::new();
    let requested = sources(plugins).into_iter().filter(|s| {
        source.is_none() || source == Some(s.id.as_str()) || source == Some("plugins") && s.plugin
    });
    let context = reader
        .query("application.context", json!({"window":window,"limit":32}))
        .await?;
    let mut object_snapshot: Option<Value> = None;
    for source in requested {
        let remaining = limit.saturating_sub(result.len() as u32);
        if remaining == 0 {
            break;
        }
        let found=async {Ok::<Vec<AgentContextItem>,String>(match source.id.as_str(){
            "packages"|"workspace"|"environment"=>{
                let session = context["context"]["workspace_instance_id"].as_str().zip(context["context"]["native_session_id"].as_str()).map(|(id,native)|ComponentAgentSession{workspace_instance_id:id.into(),session_id:native.into()});
                let page=Box::pin(crate::component_agents::context::search(reader.host,reader.context,&ComponentSourceSearch{project_root:reader.project.into(),window:window.clone(),session,source:source.id.clone(),text:text.into(),limit:remaining})).await.map_err(|e|e.to_string())?;
                notices.extend(page.notices);page.items
            },
            "files"=>{
                let page=if text.trim().is_empty(){reader.query("project.list_directory",json!({"path":"","limit":remaining})).await?}else{reader.query("project.search_files",json!({"text":text,"show_hidden":false})).await?};
                page["entries"].as_array().into_iter().flatten().filter(|e|e["kind"]=="regular").take(remaining as usize).filter_map(|e|{let path=e["path"].as_str()?;Some(item("files",path.into(),"Project file".into(),"file",json!({"path":path}),"text"))}).collect()
            },
            "editor"=>context["documents"].as_array().into_iter().flatten().filter_map(|d|{
                let name=d["path"].as_str().or_else(||d["document"]["document_id"].as_str())?;
                if !name.to_lowercase().contains(&text.to_lowercase()){return None;}
                let selected=d["selection"]["anchor"]!=d["selection"]["head"];
                Some(item("editor",name.into(),if selected{"Selected code"}else{"Open document"}.into(),"code",json!({"window":window,"document":d["document"],"expected_sha256":d["sha256"],"selection":d["selection"]}),if selected{"selection"}else{"text"}))
            }).take(remaining as usize).collect(),
            "objects"|"tables"=>{
                let session=context["context"]["native_session_id"].as_str().ok_or("R is not connected")?;
                let instance=context["context"]["workspace_instance_id"].as_str();
                // Suggestions do not allocate directory observations for every
                // keystroke. Resolve an exact native object only on preview.
                if object_snapshot.is_none() {
                    let mut arguments=json!({"expected_session":session,"limit":200});
                    if let Some(instance)=instance { arguments["workspace_instance_id"]=json!(instance); }
                    let page=reader.query("workspace.snapshot",arguments).await?;
                    if page["truncated"]==true { notices.push("Objects: suggestions cover the first 200 bindings".into()); }
                    object_snapshot=Some(page);
                }
                let page=object_snapshot.as_ref().unwrap();
                page["objects"].as_array().into_iter().flatten()
                    .filter(|e|e["name"].as_str().is_some_and(|n|n.to_lowercase().contains(&text.to_lowercase())))
                    .filter(|e|source.id!="tables" || e["dimensions"].as_array().is_some_and(|d|d.len()==2))
                    .take(remaining as usize).filter_map(|e|{
                        let name=e["name"].as_str()?;let dims=e["dimensions"].as_array().map(|a|a.iter().map(Value::to_string).collect::<Vec<_>>().join(" × ")).unwrap_or_default();
                        let mut reference=json!({"name":name,"expected_session":session});
                        if let Some(instance)=instance { reference["workspace_instance_id"]=json!(instance); }
                        Some(item(&source.id,name.into(),if dims.is_empty(){e["object_type"].as_str().unwrap_or("R object").into()}else{dims},if source.id=="tables"{"table"}else{"object"},reference,if source.id=="tables"{"selection"}else{"summary"}))
                    }).collect()

            },
            "operations"=>{
                let page=reader.query("operation.list_recent",json!({"limit":remaining.min(20)})).await?;
                let page:RecentOperations=serde_json::from_value(page).map_err(|e|e.to_string())?;
                page.operations.into_iter().filter(|op| text.is_empty() || format!("{} {}",op.operation_id.as_str(),op.capability.id).to_lowercase().contains(&text.to_lowercase())).map(|op|item("operations",format!("Run {}",op.operation_id.as_str()),op.capability.id.clone(),"run",json!({"operation_id":op.operation_id}),"summary")).collect()
            },
            "plots"=>{
                let recent=reader.query("operation.list_recent",json!({"limit":10})).await?;let mut found=Vec::new();
                for operation in recent["operations"].as_array().into_iter().flatten(){
                    let Some(id)=operation["operation_id"].as_str() else{continue;};
                    let page=reader.query("workspace.list_outputs",json!({"operation_id":id,"after_sequence":0,"limit":remaining.min(10)})).await;
                    if let Ok(page)=page {for media in page["media"].as_array().into_iter().flatten(){let r=&media["reference"];let name=format!("Plot {}",r["sequence"]);if r["mime_type"].as_str().is_some_and(|m|m.starts_with("image/"))&&name.to_lowercase().contains(&text.to_lowercase()){found.push(item("plots",name,format!("Output · {}",r["mime_type"].as_str().unwrap_or("image")),"figure",r.clone(),"image"));}
                    if found.len()>=remaining as usize{break;}}}
                    if found.len()>=remaining as usize{break;}
                }found
            },
            _=>{
                let provider=plugins.iter().find(|p|p.source().id==source.id).ok_or("Context source is unavailable")?;
                provider.search(reader,window,text,remaining).await?
            }
        })}.await;
        match found {
            Ok(mut found) => {
                found.truncate(remaining as usize);
                result.extend(found);
            }
            Err(e) => notices.push(format!("{}: {e}", source.name)),
        }
    }
    Ok((result, notices))
}
fn preview_base(selection: &AgentContextSelection, inclusions: &[&str]) -> AgentContextPreview {
    AgentContextPreview {
        selection: selection.clone(),
        title: selection.label.clone(),
        description: String::new(),
        text: String::new(),
        native_data: Value::Null,
        columns: vec![],
        rows: vec![],
        image_base64: None,
        image_mime_type: None,
        inclusions: inclusions.iter().map(|s| s.to_string()).collect(),
        truncated: false,
    }
}
fn field<'a>(v: &'a Value, key: &str) -> Result<&'a str, String> {
    v[key]
        .as_str()
        .ok_or_else(|| format!("Context reference is missing {key}"))
}
pub(crate) async fn preview(
    reader: &AgentContextReader<'_>,
    window: &ApplicationWindowRef,
    s: &AgentContextSelection,
    plugins: &[Arc<dyn AgentContextProvider>],
    sending: bool,
) -> Result<AgentContextPreview, String> {
    if serde_json::to_vec(&s.reference)
        .map_err(|e| e.to_string())?
        .len()
        > 64 * 1024
    {
        return Err("Context reference exceeds its budget".into());
    }
    let mut p = match s.source.as_str() {
        "operations" => {
            if s.inclusion != "summary" { return Err("Run sources include only their bounded owner summary".into()); }
            let id = field(&s.reference, "operation_id")?;
            let page = reader.query("operation.list_recent", json!({"operation_id":id,"limit":1})).await?;
            let page: RecentOperations = serde_json::from_value(page).map_err(|e|e.to_string())?;
            let operation = page.operations.into_iter().find(|op|op.operation_id.as_str()==id)
                .ok_or("The original run is unavailable to this task")?;
            let mut p = preview_base(s, &["summary"]);
            p.title = format!("Run {}", operation.operation_id.as_str());
            p.description = format!("Original operation · {}",operation.capability.id);
            p.selection.label = p.title.clone();
            p.text = format!("Original operation {}: {}. This is an owner observation, not a new execution.",operation.operation_id.as_str(),serde_json::to_value(operation.status).map_err(|e|e.to_string())?.as_str().unwrap_or("unknown"));
            p.native_data = serde_json::to_value(operation).map_err(|e|e.to_string())?;
            p
        }
        "packages" | "workspace" | "environment" => {
            let session = s.reference["workspace_instance_id"].as_str().zip(s.reference["expected_session"].as_str()).map(|(id,native)|ComponentAgentSession{workspace_instance_id:id.into(),session_id:native.into()});
            let result = Box::pin(crate::component_agents::context::preview(reader.host,reader.context,&ComponentSourcePreviewRequest{project_root:reader.project.into(),window:window.clone(),session,selection:s.clone()},sending)).await.map_err(|e|e.to_string())?;
            let snapshot=result.snapshot.ok_or_else(||result.error.unwrap_or_else(||"Source unavailable".into()))?;
            AgentContextPreview{selection:snapshot.selection,title:snapshot.title,description:snapshot.description,text:snapshot.text,native_data:snapshot.native_data,columns:vec![],rows:vec![],image_base64:result.image_base64,image_mime_type:result.image_mime_type,inclusions:if s.source=="packages" {vec!["summary".into(),"selection".into()]} else {vec!["summary".into()]},truncated:snapshot.truncated}
        }
        "files" => {
            let path = field(&s.reference, "path")?;
            let hash = s.reference["expected_sha256"].as_str();
            if sending && hash.is_none() {
                return Err("Preview this file before including it".into());
            }
            let data = reader
                .query(
                    "project.read_file",
                    json!({"path":path,"offset":0,"limit_bytes":16384,"expected_sha256":hash}),
                )
                .await?;
            let file: FilePage = serde_json::from_value(data).map_err(|e| e.to_string())?;
            let mut p = preview_base(s, &["text", "summary"]);
            p.title = file.file.path.clone();
            p.selection.label = p.title.clone();
            p.selection.reference =
                json!({"path":file.file.path,"expected_sha256":file.file.sha256});
            p.description = format!("Files · {} bytes", file.file.byte_size);
            p.truncated = file.has_more;
            p.native_data = serde_json::to_value(&file.file).map_err(|e| e.to_string())?;
            p.text = if s.inclusion == "summary" {
                format!("{} · {} bytes", file.file.path, file.file.byte_size)
            } else {
                String::from_utf8(file.bytes).map_err(|_|"This file is not text; use an image/file attachment supported by the Agent")?
            };
            p
        }
        "editor" => {
            let reference = &s.reference;
            let source_window = reference
                .get("window")
                .cloned()
                .unwrap_or_else(|| json!(window));
            let doc = reference
                .get("document")
                .ok_or("Document reference is missing")?;
            let hash = field(reference, "expected_sha256")?;
            let mut full = String::new();
            let mut offset = 0;
            let mut summary = None;
            for _ in 0..8 {
                let data=reader.query("application.read_document",json!({"window":source_window,"document":doc,"expected_sha256":hash,"offset_utf8":offset,"limit_bytes":65536,"allow_offline":true})).await?;
                let page: ApplicationDocumentPage =
                    serde_json::from_value(data).map_err(|e| e.to_string())?;
                summary = Some(page.document);
                full.push_str(&page.text);
                if let Some(next) = page.next_offset_utf8 {
                    if next <= offset {
                        return Err("Document page did not advance".into());
                    }
                    offset = next;
                } else {
                    break;
                }
            }
            let doc = summary.ok_or("Document is unavailable")?;
            let mut p = preview_base(s, &["selection", "text", "summary"]);
            p.title = doc
                .path
                .clone()
                .unwrap_or_else(|| doc.document.document_id.clone());
            p.description = if doc.dirty {
                "Editor · Unsaved draft"
            } else {
                "Editor"
            }
            .into();
            if s.inclusion == "selection" {
                let normalized = full
                    .strip_prefix('\u{feff}')
                    .unwrap_or(&full)
                    .replace("\r\n", "\n")
                    .replace('\r', "\n");
                let units: Vec<u16> = normalized.encode_utf16().collect();
                let from = doc.selection.anchor.min(doc.selection.head) as usize;
                let to = doc.selection.anchor.max(doc.selection.head) as usize;
                if from == to || to > units.len() {
                    return Err("The selected code is no longer available".into());
                }
                p.text = String::from_utf16(&units[from..to])
                    .map_err(|_| "Selection splits a Unicode character")?;
            } else if s.inclusion == "summary" {
                p.text = format!(
                    "{} bytes · {}",
                    doc.utf8_bytes,
                    if doc.dirty {
                        "Unsaved draft"
                    } else {
                        "Saved document"
                    }
                );
            } else {
                p.text = full;
            }
            p.native_data = serde_json::to_value(&doc).map_err(|e| e.to_string())?;
            p
        }
        "objects" | "tables" => {
            let session = field(&s.reference, "expected_session")?;
            let mut reference = s.reference.clone();
            if reference["object_ref"].as_str().is_none() {
                if sending {
                    return Err("Preview this object before including it".into());
                }
                let mut arguments =
                    json!({"expected_session":session,"name":field(&reference,"name")?,"path":[]});
                if let Some(instance) = reference["workspace_instance_id"].as_str() {
                    arguments["workspace_instance_id"] = json!(instance);
                }
                let observation = reader.query("workspace.observe_object", arguments).await?;
                reference["object_ref"] = observation["object_ref"].clone();
            }
            let table = s.inclusion == "selection";
            let mut arguments = json!({"expected_session":session,"object_ref":field(&reference,"object_ref")?,"kind":if table{"table"}else{"structure"},"start":reference["start"].as_u64().unwrap_or(1),"limit":reference["limit"].as_u64().unwrap_or(20).min(20),"column_start":reference["column_start"].as_u64().unwrap_or(1),"column_limit":reference["column_limit"].as_u64().unwrap_or(6).min(10)});
            if let Some(instance) = reference["workspace_instance_id"].as_str() {
                arguments["workspace_instance_id"] = json!(instance);
            }
            let data = reader.query("workspace.read_object", arguments).await?;
            let page: ObjectReadPage =
                serde_json::from_value(data.clone()).map_err(|e| e.to_string())?;
            let mut p = preview_base(s, &["summary", "selection"]);
            p.selection.reference = reference;
            p.title = page.root_name;
            p.selection.label = p.title.clone();
            p.description = format!(
                "{} · {}",
                if table { "Table" } else { "Objects" },
                page.metadata
                    .dimensions
                    .iter()
                    .map(u64::to_string)
                    .collect::<Vec<_>>()
                    .join(" × ")
            );
            p.truncated = !page.complete;
            p.text = format!(
                "{}\n{}",
                page.metadata.classes.join(", "),
                page.metadata.notice.clone().unwrap_or_default()
            );
            p.native_data = data;
            p.columns = page
                .columns
                .iter()
                .enumerate()
                .map(|(i, c)| {
                    c.name
                        .clone()
                        .unwrap_or_else(|| format!("Column {}", page.column_start as usize + i))
                })
                .collect();
            for i in 0..page
                .columns
                .iter()
                .map(|c| c.values.len())
                .max()
                .unwrap_or(0)
                .min(20)
            {
                p.rows.push(
                    page.columns
                        .iter()
                        .map(|c| c.values.get(i).map(scalar).unwrap_or_default())
                        .collect(),
                );
            }
            p
        }
        "help" => {
            // The same exact-copy reader people use; nothing is loaded or executed.
            if !matches!(s.inclusion.as_str(), "text" | "summary") {
                return Err("Help sources include topic text or a summary".into());
            }
            let mut args = s.reference.clone();
            let object = args.as_object_mut().ok_or("Help reference must be an object")?;
            object.remove("index_ref");
            object.insert("limit_bytes".into(), json!(32768));
            object.insert("offset_utf8".into(), json!(0));
            object.remove("expected_help_files");
            object.insert("format".into(), json!("text"));
            let data = reader.query("workspace.read_help", args).await?;
            let page: PackageHelpPage = serde_json::from_value(data.clone()).map_err(|e| e.to_string())?;
            if !page.found {
                return Err(format!("Help topic {} is not documented in this installed copy", page.topic));
            }
            let mut p = preview_base(s, &["text", "summary"]);
            p.title = format!("{}::{}", page.package, page.topic);
            p.selection.label = p.title.clone();
            p.description = format!(
                "Help · {} {} · {}",
                page.package,
                page.version.clone().unwrap_or_default(),
                page.library_path
            );
            p.truncated = !page.complete;
            p.text = if s.inclusion == "summary" {
                page.text.lines().take(12).collect::<Vec<_>>().join("\n")
            } else {
                page.text.clone()
            };
            p.native_data = json!({
                "package": page.package, "topic": page.topic, "library_path": page.library_path,
                "version": page.version, "help_files": page.help_files, "observation_id": page.observation_id,
                "complete": page.complete, "total_bytes": page.total_bytes,
            });
            p
        }
        "viewer" => {
            if !matches!(s.inclusion.as_str(), "summary" | "text") {
                return Err("Viewer sources include a summary or the retained HTML text".into());
            }
            let r: MediaReference = serde_json::from_value(
                s.reference.get("reference").cloned().unwrap_or_else(|| s.reference.clone()),
            )
            .map_err(|_| "Invalid viewer artifact reference")?;
            if r.mime_type != "text/html" {
                return Err("Viewer sources are retained text/html outputs".into());
            }
            let mut p = preview_base(s, &["summary", "text"]);
            p.title = format!("HTML output {}", r.sequence);
            p.description = format!("Viewer · Run {} · Output {} · saved artifact", r.operation_id.as_str(), r.sequence);
            p.selection.reference = json!({"reference": r});
            let data = reader
                .query("output.read_text", json!({"reference": r, "offset": 0, "limit_bytes": 65536}))
                .await?;
            let page: OutputTextPage = serde_json::from_value(data).map_err(|e| e.to_string())?;
            p.truncated = !page.complete;
            p.text = if s.inclusion == "summary" {
                format!("Retained HTML document · {} bytes. Browser selection, zoom or filter state is not exposed.", r.byte_size)
            } else {
                page.text
            };
            p.native_data = json!({"reference": r, "state": "saved", "complete": page.complete});
            p
        }
        "annotations" => {
            let annotation: AnnotationRevisionRef = serde_json::from_value(
                s.reference.get("annotation").cloned().unwrap_or(Value::Null),
            )
            .map_err(|_| "Annotation reference needs an annotation_id and revision")?;
            if !matches!(s.inclusion.as_str(), "summary" | "text" | "image") {
                return Err("Annotation sources include their note, evidence and optional capture".into());
            }
            let owner = reader.host.annotations().ok_or("Annotations are unavailable in this Host")?;
            let scope = reader.host.application_owner().map_err(|e| e.to_string())?.scope(reader.context).map_err(|e| e.to_string())?;
            let (revision, evidence) = owner.read(&scope, &annotation).map_err(|e| e.to_string())?;
            if revision.deleted {
                return Err("This annotation was deleted".into());
            }
            let mut p = preview_base(s, &["summary", "text", "image"]);
            p.title = if revision.note.trim().is_empty() {
                format!("Marks on {}", evidence.source.title)
            } else {
                revision.note.lines().next().unwrap_or_default().chars().take(80).collect()
            };
            p.selection.label = p.title.clone();
            p.selection.reference = json!({"annotation": revision.annotation, "source_id": evidence.source.source_id, "source_version": evidence.source.source_version});
            p.description = format!(
                "Annotation · {} · version {} · by {}",
                evidence.source.title,
                evidence.source.source_version.chars().take(24).collect::<String>(),
                revision.author.id
            );
            let anchor = serde_json::to_value(&evidence.anchor).map_err(|e| e.to_string())?;
            p.text = format!(
                "Note: {}\nLabels: {}\nSource: {} ({:?}) version {}\nAnchor: {}\nEvidence: {}\nThis note is bound to the source version above; it is not a comment on any later version.",
                revision.note,
                revision.labels.join(", "),
                evidence.source.title,
                evidence.source.owner,
                evidence.source.source_version,
                anchor,
                evidence.fragment
            );
            p.native_data = json!({
                "revision": revision, "source": evidence.source, "anchor": evidence.anchor,
                "fragment": evidence.fragment, "selection": evidence.selection,
            });
            if let AnnotationAnchor::CapturedView { capture } = &evidence.anchor
                && s.inclusion == "image"
            {
                let (stored, bytes) = owner.capture(&scope, &capture.capture_id).map_err(|e| e.to_string())?;
                if bytes.len() > 2 * 1024 * 1024 {
                    return Err("The captured view exceeds the 2 MiB image budget; include the note text instead".into());
                }
                p.image_base64 = Some(STANDARD.encode(&bytes));
                p.image_mime_type = Some(stored.mime_type.clone());
                p.native_data["preview_sha256"] = json!(stored.sha256);
                p.native_data["capture"] = json!(stored);
                p.native_data["marks"] = json!(revision.marks);
            }
            p
        }
        "plots" => {
            let r: MediaReference = serde_json::from_value(s.reference.clone())
                .map_err(|_| "Invalid output reference")?;
            let mut p = preview_base(s, &["image", "summary"]);
            p.title = format!("Plot {}", r.sequence);
            p.description = format!("Plots · Output {}", r.sequence);
            p.text = format!("{} · {} bytes", r.mime_type, r.byte_size);
            p.native_data = serde_json::to_value(&r).map_err(|e| e.to_string())?;
            if s.inclusion == "image" {
                let data = reader
                    .query("output.view", json!({"reference":r,"max_edge":640}))
                    .await?;
                let view: OutputView = serde_json::from_value(data).map_err(|e| e.to_string())?;
                p.native_data = json!({"reference":view.reference,"preview_width":view.preview_width,"preview_height":view.preview_height,"preview_sha256":view.preview_sha256,"transformations":view.transformations});
                p.image_base64 = Some(view.preview_base64);
                p.image_mime_type = Some(view.preview_mime_type);
            } else {
                reader
                    .query(
                        "workspace.read_output",
                        json!({"reference":r,"offset":0,"limit_bytes":1}),
                    )
                    .await?;
            }
            p
        }
        _ => {
            plugins
                .iter()
                .find(|p| p.source().id == s.source)
                .ok_or("This plugin information source is unavailable")?
                .preview(reader, window, s)
                .await?
        }
    };
    if p.selection.source != s.source || !p.inclusions.contains(&s.inclusion) {
        return Err("The information source does not support this inclusion scope".into());
    }
    if p.text.len() > 65536 {
        let mut end = 65536;
        while !p.text.is_char_boundary(end) {
            end -= 1;
        }
        p.text.truncate(end);
        p.truncated = true;
    }
    if p.image_base64
        .as_ref()
        .is_some_and(|v| v.len() > 2 * 1024 * 1024)
    {
        return Err("Context image preview exceeds its budget".into());
    }
    if serde_json::to_vec(&p.native_data)
        .map_err(|e| e.to_string())?
        .len()
        > 65536
    {
        return Err("Select a smaller context excerpt".into());
    }
    p.columns.truncate(10);
    p.rows.truncate(20);
    Ok(p)
}
fn scalar(s: &ObjectScalar) -> String {
    s.label
        .clone()
        .or_else(|| s.text.clone())
        .or_else(|| s.number.map(|n| n.to_string()))
        .or_else(|| s.logical.map(|v| if v { "TRUE" } else { "FALSE" }.into()))
        .unwrap_or_else(|| s.kind.clone())
}
pub(crate) fn input(preview: AgentContextPreview) -> Result<Vec<NativeInput>, String> {
    let identity = format!(
        "{:x}",
        Sha256::digest(serde_json::to_vec(&preview.selection).map_err(|e| e.to_string())?)
    );
    let mut parts = vec![NativeInput::Resource {
        uri: format!(
            "rho://context/{}/{}",
            preview.selection.source,
            &identity[..16]
        ),
        mime_type: "text/plain".into(),
        text: format!(
            "{}\n{}\nScope: {}{}\nReference: {}\n{}\nStructured data: {}",
            preview.title,
            preview.description,
            preview.selection.inclusion,
            if preview.truncated {
                " (bounded excerpt)"
            } else {
                ""
            },
            preview.selection.reference,
            preview.text,
            preview.native_data
        ),
    }];
    if let Some(image) = preview.image_base64 {
        parts.push(NativeInput::Image {
            mime_type: preview
                .image_mime_type
                .ok_or("Missing context image type")?,
            data: STANDARD
                .decode(image)
                .map_err(|_| "Invalid context image")?,
        });
    }
    Ok(parts)
}
