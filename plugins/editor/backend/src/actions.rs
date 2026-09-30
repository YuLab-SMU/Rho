//! Editor document actions over the public draft, Files and R owners. The exact
//! synchronized capture is read before every action; CAS never overwrites typing.
use base64::{Engine, engine::general_purpose::STANDARD};
use rho_plugin_sdk::{HostCallClient, protocol::*};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::sync::atomic::{AtomicU64, Ordering};

#[derive(Clone, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct Input {
    pub reference: ContextReference,
    /// New complete text for edit; omitted for save/run.
    #[serde(default)]
    #[schemars(length(max = 32768))]
    pub code: Option<String>,
    /// Optional project-relative destination for an untitled document or Save As.
    #[serde(default)]
    pub path: Option<String>,
    /// Exact R provider/session captured by the Agent adapter, never discovered here.
    #[serde(default)]
    pub runtime: Option<InstanceRef>,
    #[serde(default)]
    pub expected_session: Option<String>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Selector {
    draft: DraftId,
    version: u32,
    digest: ContentDigest,
}
static NEXT: AtomicU64 = AtomicU64::new(1);
fn key(id: &str, version: u32) -> CapabilityKey {
    CapabilityKey {
        id: ContributionId::new(id).unwrap(),
        version,
    }
}
fn hash(bytes: &[u8]) -> String {
    format!("sha256:{:x}", Sha256::digest(bytes))
}
fn require(ok: bool, reason: &str) -> Result<(), String> {
    if ok { Ok(()) } else { Err(reason.into()) }
}
struct Calls<'a> {
    host: &'a HostCallClient,
    call: &'a PluginCall,
    effects: Vec<Value>,
    uncertain: bool,
}
impl Calls<'_> {
    async fn call(&self, id: &str, version: u32, args: Value) -> Result<Value, String> {
        let request = RequestId::new(format!(
            "editor-action-{}",
            NEXT.fetch_add(1, Ordering::Relaxed)
        ))
        .unwrap();
        self.host
            .begin(request, self.call.request.clone(), key(id, version), args)
            .map_err(|e| e.to_string())?
            .receive()
            .await
            .map_err(|e| e.to_string())
    }
    async fn read(&self, id: &str, args: Value) -> Result<Value, String> {
        let result = self.call(id, 1, args).await?;
        require(
            result["status"] == "ready" && result["completeness"] == "complete",
            "The original observation is incomplete",
        )?;
        result
            .get("data")
            .cloned()
            .ok_or("Missing observation data".into())
    }
    async fn operation(&mut self, id: &str, version: u32, args: Value) -> Result<Value, String> {
        // If transport ends after dispatch, retain uncertainty; never resend.
        self.uncertain = true;
        let mut record = self.call(id, version, args).await?;
        let operation = record["operation"]["operation_id"]
            .as_str()
            .ok_or("Missing original child operation")?
            .to_string();
        require(
            record["operation"]["causation_id"]
                == self.call.operation_id.as_deref().unwrap_or_default()
                && record["operation"]["caller"]["id"]
                    == self.call.binding.provider.instance.as_str()
                && record["operation"]["capability"] == json!(key(id, version)),
            "Child operation differs from the Editor request",
        )?;
        self.effects
            .push(json!({"operation":operation,"capability":key(id,version)}));
        for _ in 0..2400 {
            match record["status"].as_str() {
                Some("succeeded") => {
                    self.uncertain = false;
                    return Ok(record["output"].clone());
                }
                Some("failed" | "cancelled") => {
                    self.uncertain = false;
                    return Err(format!(
                        "Original {id} operation {}: {}",
                        record["status"], record["error"]
                    ));
                }
                Some("uncertain") => {
                    return Err(
                        "Original child operation is uncertain; inspect the retained operation"
                            .into(),
                    );
                }
                Some("accepted" | "running" | "reconciling") => {}
                _ => return Err("Invalid child operation outcome".into()),
            }
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
            let next = self
                .read("operation.get", json!({"operation_id":operation}))
                .await?;
            record = next["record"].clone();
            require(
                record["operation"]["operation_id"] == operation,
                "Original child operation changed identity",
            )?;
        }
        Err("Original child operation is still pending; inspect it without replay".into())
    }
}
async fn capture(
    calls: &Calls<'_>,
    instance: &PluginInstance,
    input: &Input,
) -> Result<(DocumentDraft, Value), String> {
    let reference = &input.reference;
    require(
        reference.provider == instance.identity && reference.contribution.as_str() == "documents",
        "Editor reference belongs to another provider",
    )?;
    let selector: Selector =
        serde_json::from_value(reference.selector.clone()).map_err(|e| e.to_string())?;
    let draft: DocumentDraft = serde_json::from_value(
        calls
            .read(
                "documents.inspect",
                json!({"window":reference.window,"draft":selector.draft}),
            )
            .await?,
    )
    .map_err(|e| e.to_string())?;
    require(
        !draft.discarded
            && draft.draft == selector.draft
            && draft.version == selector.version
            && draft.content.digest == selector.digest
            && draft.project == instance.project
            && draft.principal == instance.principal
            && draft.window == reference.window
            && draft.source.revision == instance.identity.revision
            && draft.source.contribution.as_str() == "editor"
            && draft.metadata["encoding"] == "org.rho.editor.document.v1",
        "The synchronized document changed; read it again before editing",
    )?;
    draft.content.validate().map_err(|e| e.to_string())?;
    let mut bytes = vec![];
    loop {
        let page: DocumentDraftChunk = serde_json::from_value(calls.read("documents.read",json!({"window":draft.window,"draft":draft.draft,"expected_version":draft.version,"offset":bytes.len(),"limit":MAX_DRAFT_CHUNK_BYTES})).await?).map_err(|e|e.to_string())?;
        require(
            page.draft == draft.draft
                && page.version == draft.version
                && page.digest == draft.content.digest
                && page.offset as usize == bytes.len(),
            "Document page changed",
        )?;
        let part = STANDARD.decode(page.base64).map_err(|e| e.to_string())?;
        require(
            part.len() <= MAX_DRAFT_CHUNK_BYTES as usize
                && bytes.len() + part.len() <= draft.content.bytes as usize
                && (!part.is_empty() || draft.content.bytes == 0),
            "Invalid document page size",
        )?;
        bytes.extend(part);
        let next = (bytes.len() < draft.content.bytes as usize).then_some(bytes.len() as u32);
        require(page.next == next, "Invalid document continuation")?;
        if next.is_none() {
            break;
        }
    }
    require(
        hash(&bytes) == draft.content.digest.as_str(),
        "Document digest changed",
    )?;
    let payload: Value = serde_json::from_slice(&bytes).map_err(|e| e.to_string())?;
    let doc = &payload["document"];
    require(
        payload["schema"] == 1
            && doc["readonly"].is_null()
            && doc["version"] == draft.metadata["document_version"]
            && doc["path"] == draft.metadata["path"]
            && doc["raw"]
                .as_str()
                .is_some_and(|s| s.len() <= 512 * 1024 && !s.contains('\0')),
        "Document is not an editable synchronized Editor capture",
    )?;
    require(
        payload["save"].is_null()
            && (payload["fileRun"].is_null() || payload["fileRun"]["phase"] == "submitting")
            && (payload["code"].is_null()
                || matches!(
                    payload["code"]["status"].as_str(),
                    Some("succeeded" | "failed" | "cancelled")
                )),
        "The Editor retains an unfinished save or execution; inspect it before another action",
    )?;
    Ok((draft, payload))
}
fn path_valid(path: &str) -> bool {
    !path.is_empty()
        && path.len() <= 1024
        && !path.starts_with('/')
        && !path
            .chars()
            .any(|c| c.is_control() || c == ':' || c == '\\')
        && path
            .split('/')
            .all(|p| !p.is_empty() && p != "." && p != ".." && !p.eq_ignore_ascii_case(".git"))
}
fn patch(path: &str, before: Option<&str>, after: &str) -> String {
    let quote = |p: &str| serde_json::to_string(p).unwrap();
    let a = quote(&format!("a/{path}"));
    let b = quote(&format!("b/{path}"));
    let lines = |s: &str| {
        if s.is_empty() {
            0
        } else {
            s.split_inclusive('\n').count()
        }
    };
    let old = before.unwrap_or("");
    let mut out = format!(
        "diff --git {a} {b}\n{}--- {}\n+++ {b}\n@@ -{},{} +{},{} @@\n",
        if before.is_none() {
            "new file mode 100644\n"
        } else {
            ""
        },
        if before.is_none() { "/dev/null" } else { &a },
        if old.is_empty() { 0 } else { 1 },
        lines(old),
        if after.is_empty() { 0 } else { 1 },
        lines(after)
    );
    for (prefix, text) in [('-', old), ('+', after)] {
        for line in text.split_inclusive('\n') {
            out.push(prefix);
            out.push_str(line);
            if !line.ends_with('\n') {
                out.push_str("\n\\ No newline at end of file\n");
            }
        }
    }
    out
}
async fn publish(
    calls: &mut Calls<'_>,
    mut draft: DocumentDraft,
    payload: Value,
) -> Result<Value, String> {
    let bytes = serde_json::to_vec(&payload).map_err(|e| e.to_string())?;
    require(
        bytes.len() <= MAX_DRAFT_BYTES as usize,
        "Updated document exceeds its size limit",
    )?;
    let upload = RequestId::new(format!(
        "editor-save-{}",
        calls.call.operation_id.as_deref().unwrap()
    ))
    .map_err(|e| e.to_string())?;
    let mut chunks = vec![];
    for part in bytes.chunks(MAX_DRAFT_CHUNK_BYTES as usize) {
        let digest = ContentDigest::new(hash(part)).map_err(|e| e.to_string())?;
        let staged = calls.call("documents.stage",1,json!({"window":draft.window,"draft":draft.draft,"upload":upload,"digest":digest,"base64":STANDARD.encode(part)})).await?;
        let staged: DraftChunkReference = serde_json::from_value(staged).map_err(|e| e.to_string())?;
        require(staged.digest == digest && staged.bytes as usize == part.len(), "Staged document bytes were not confirmed")?;
        chunks.push(staged);
    }
    let doc = &payload["document"];
    let metadata = json!({"encoding":"org.rho.editor.document.v1","path":doc["path"],"name":doc["path"].as_str().and_then(|p|p.rsplit('/').next()).unwrap_or("Untitled.R"),"document_version":doc["version"],"selection":{"anchor":doc["anchor"],"head":doc["head"]},"read_only":false});
    let output=calls.operation("documents.save",1,json!({"window":draft.window,"draft":draft.draft,"upload":upload,"source":draft.source,"expected_version":draft.version,
        "content":{"digest":hash(&bytes),"bytes":bytes.len(),"chunks":chunks},"metadata":metadata})).await?;
    let saved: DocumentDraft = serde_json::from_value(output).map_err(|e| e.to_string())?;
    require(
        saved.draft == draft.draft
            && saved.window == draft.window
            && saved.source == draft.source
            && saved.version == draft.version + 1
            && saved.content.digest.as_str() == hash(&bytes),
        "Saved document differs from the original edit",
    )?;
    draft = saved;
    Ok(
        json!({"reference":{"provider":calls.call.binding.provider,"contribution":"documents","window":draft.window,"selector":{"draft":draft.draft,"version":draft.version,"digest":draft.content.digest}},"path":doc["path"],"document_version":doc["version"],"draft":draft}),
    )
}
async fn execute(calls: &mut Calls<'_>, instance: &PluginInstance) -> Result<Value, String> {
    let input: Input =
        serde_json::from_value(calls.call.arguments.clone()).map_err(|e| e.to_string())?;
    let (draft, mut payload) = capture(calls, instance, &input).await?;
    let action = calls.call.binding.capability.id.as_str().to_owned();
    match action.as_str() {
        "editor.edit" => {
            require(
                input.path.is_none() && input.runtime.is_none() && input.expected_session.is_none(),
                "Edit accepts text and its original reference only",
            )?;
            let code = input
                .code
                .as_deref()
                .ok_or("Edit needs complete replacement text")?;
            require(
                code.len() <= 32768 && !code.contains('\0'),
                "Edit text exceeds 32 KiB or contains NUL",
            )?;
            let eol = payload["document"]["eol"]
                .as_str()
                .ok_or("Missing line-ending policy")?;
            require(
                matches!(eol, "\n" | "\r\n" | "\r"),
                "Invalid document line endings",
            )?;
            let normalized = code.replace("\r\n", "\n").replace('\r', "\n");
            let raw = normalized.replace('\n', eol);
            let doc = &mut payload["document"];
            doc["raw"] = json!(raw);
            doc["byteSize"] = json!(raw.len() + if doc["bom"] == true { 3 } else { 0 });
            doc["version"] = json!(format!(
                "edit-{}",
                calls.call.operation_id.as_deref().unwrap()
            ));
            let length = normalized.encode_utf16().count() as u64;
            for field in ["anchor", "head"] {
                doc[field] = json!(doc[field].as_u64().unwrap_or(0).min(length));
            }
            payload["disk"] = Value::Null;
            publish(calls, draft, payload).await
        }
        "editor.save" => {
            require(
                input.code.is_none() && input.runtime.is_none() && input.expected_session.is_none(),
                "Save accepts a reference and optional destination only",
            )?;
            let doc = &payload["document"];
            let path = input
                .path
                .as_deref()
                .or(doc["path"].as_str())
                .ok_or("Choose a destination for the untitled document")?
                .to_owned();
            require(
                path_valid(&path),
                "Save requires a contained project-relative path",
            )?;
            let raw = format!(
                "{}{}",
                if doc["bom"] == true { "\u{feff}" } else { "" },
                doc["raw"].as_str().unwrap()
            );
            let same = doc["path"].as_str() == Some(&path);
            let before = if same { doc["baseRaw"].as_str() } else { None };
            let expected = if same {
                doc["baseHash"].clone()
            } else {
                Value::Null
            };
            let files: InstanceRef =
                serde_json::from_value(payload["files"].clone()).map_err(|e| e.to_string())?;
            let paths = calls.read("workspace.paths", json!({})).await?;
            let root = paths["project_root"]
                .as_str()
                .ok_or("Project root is unavailable")?;
            let patch = patch(&path, before, &raw);
            require(patch.len() <= 200 * 1024, "Save patch exceeds 200 KiB")?;
            let binding = ProviderBinding {
                provider: files,
                project: instance.project.clone(),
                capability: key("files.apply_patch", 1),
                target: Some(root.into()),
            };
            if before != Some(raw.as_str()) {
                calls.operation("files.apply_patch",1,json!({"binding":binding,"arguments":{"patch":patch},"preconditions":[{"kind":"file.sha256","subject":path,"expected":expected}]})).await?;
            } else {
                // Even an unchanged draft cannot claim a save if its captured
                // file was changed on disk by another writer.
                let mut observed_binding = binding;
                observed_binding.capability = key("files.snapshot", 1);
                let observed = calls.call("files.snapshot", 1, json!({"binding":observed_binding,"arguments":{"paths":[path],"limit":1},"preconditions":null})).await?;
                require(observed["status"] == "ready" && observed["data"]["files"][0]["path"] == path
                    && observed["data"]["files"][0]["kind"] == "regular"
                    && observed["data"]["files"][0]["sha256"] == expected,
                    "The original file changed on disk; compare it before saving")?;
            }
            payload["document"]["path"] = json!(path);
            payload["document"]["baseRaw"] = json!(raw);
            payload["document"]["baseHash"] = json!(hash(raw.as_bytes()));
            payload["disk"] = Value::Null;
            publish(calls, draft, payload).await
        }
        "editor.run" => {
            require(
                input.code.is_none() && input.path.is_none(),
                "Run uses the captured document text, never model-supplied replacement code",
            )?;
            let runtime = input
                .runtime
                .ok_or("Run needs the originally selected R provider")?;
            require(
                json!(runtime) == payload["runtime"],
                "Document runtime differs from the selected workspace",
            )?;
            let session = input
                .expected_session
                .ok_or("Run needs the originally selected R session")?;
            require(!session.is_empty(), "Missing selected R session")?;
            let raw = payload["document"]["raw"].as_str().unwrap();
            let code = raw.replace("\r\n", "\n").replace('\r', "\n");
            require(
                !code.trim().is_empty() && code.len() <= 262144,
                "Captured run requires 1–256 KiB of code",
            )?;
            let binding = ProviderBinding {
                provider: runtime,
                project: instance.project.clone(),
                capability: key("r.execute", 2),
                target: Some(session.clone()),
            };
            let result=calls.operation("r.execute",2,json!({"binding":binding,"arguments":{"expected_session":session,"run":{"code":code,"output_mode":"console"}},"preconditions":null})).await?;
            Ok(
                json!({"reference":input.reference,"document_version":payload["document"]["version"],"code_digest":hash(code.as_bytes()),"result":result}),
            )
        }
        _ => Err("Unknown Editor action".into()),
    }
}
pub async fn invoke(
    host: HostCallClient,
    instance: PluginInstance,
    call: PluginCall,
) -> PluginCommitPlan {
    let mut calls = Calls {
        host: &host,
        call: &call,
        effects: vec![],
        uncertain: false,
    };
    let result = execute(&mut calls, &instance).await;
    let (outcome, output, error) = match result {
        Ok(mut output) => {
            output["operations"] = json!(calls.effects);
            (PluginOutcome::Succeeded, Some(output), None)
        }
        Err(error) => (
            if calls.uncertain || !calls.effects.is_empty() {
                PluginOutcome::Uncertain
            } else {
                PluginOutcome::Failed
            },
            None,
            Some(error),
        ),
    };
    PluginCommitPlan {
        outcome,
        output,
        error,
        recovery: Some(json!({"operations":calls.effects,"original_request":call.request})),
        facts: vec![],
        evidence: vec![],
        cancellation_confirmed: false,
    }
}
