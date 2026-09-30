use base64::{Engine, engine::general_purpose::STANDARD};
use rho_plugin_sdk::protocol::*;
use serde::Deserialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

const ENCODING: &str = "org.rho.editor.document.v1";
const MAX_EDITOR_BYTES: usize = 512 * 1024;
const CONTEXT: &str = "documents";
#[derive(Debug)]
pub struct Failure {
    pub code: &'static str,
    pub message: String,
}
fn fault(code: &'static str, message: impl ToString) -> Failure {
    Failure {
        code,
        message: message.to_string(),
    }
}
fn invalid(message: impl ToString) -> Failure {
    fault("invalid_context", message)
}
fn changed() -> Failure {
    fault(
        "context_changed",
        "The synchronized Editor capture changed. Search again before including it.",
    )
}
fn check(condition: bool, message: &str) -> Result<(), Failure> {
    if condition {
        Ok(())
    } else {
        Err(invalid(message))
    }
}
fn decode<T: for<'de> Deserialize<'de>>(value: Value) -> Result<T, Failure> {
    serde_json::from_value(value).map_err(invalid)
}
fn source(instance: &PluginInstance) -> DraftSource {
    DraftSource {
        revision: instance.identity.revision.clone(),
        contribution: ContributionId::new("editor").unwrap(),
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
struct Selector {
    draft: DraftId,
    version: u32,
    digest: ContentDigest,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Cursor {
    after: DraftId,
    text: String,
    window: WindowId,
    revision: RevisionId,
}
#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
enum Inclusion {
    Document,
    Selection,
}
#[derive(Deserialize)]
struct Payload {
    schema: u32,
    document: Document,
}
#[derive(Deserialize)]
struct Document {
    path: Option<String>,
    raw: String,
    version: String,
    anchor: u32,
    head: u32,
    readonly: Option<String>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Metadata {
    encoding: String,
    path: Option<String>,
    name: String,
    document_version: String,
    selection: Selection,
    read_only: bool,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Selection {
    anchor: u32,
    head: u32,
}

pub enum Step {
    Read {
        capability: &'static str,
        arguments: Value,
    },
    Complete {
        data: Value,
        completeness: ObservationCompleteness,
    },
}
enum Phase {
    Search(ContextSearch),
    Inspect {
        request: PreviewContext,
        selector: Selector,
        inclusion: Inclusion,
    },
    Read {
        request: Box<PreviewContext>,
        inclusion: Inclusion,
        draft: DocumentDraft,
        bytes: Vec<u8>,
    },
    Done,
}
pub struct Job {
    instance: PluginInstance,
    phase: Phase,
}
impl Job {
    pub fn start(instance: &PluginInstance, call: &PluginCall) -> Result<(Self, Step), Failure> {
        check(
            call.binding.provider == instance.identity
                && call.binding.project == instance.project
                && call.principal == instance.principal
                && call.operation_id.is_none(),
            "Context call differs from the initialized owner",
        )?;
        check(
            call.binding.target.is_none() && call.preconditions.is_null(),
            "Context queries do not accept a runtime target or mutation preconditions",
        )?;
        check(
            call.binding.capability.version == 1 && call.scopes.contains("documents.read"),
            "Context query requires documents.read",
        )?;
        let (phase, step) = match call.binding.capability.id.as_str() {
            "editor.context.search" => {
                let request: ContextSearch = decode(call.arguments.clone())?;
                request.validate().map_err(invalid)?;
                let after = if let Some(cursor) = &request.after {
                    let cursor: Cursor = decode(cursor.clone())?;
                    check(
                        cursor.text == request.text
                            && cursor.window == request.window
                            && cursor.revision == instance.identity.revision,
                        "Context cursor belongs to another search",
                    )?;
                    Some(cursor.after)
                } else {
                    None
                };
                let args = json!({"window":request.window,"source":source(instance),"after":after,"limit":request.limit});
                (
                    Phase::Search(request),
                    Step::Read {
                        capability: "documents.list",
                        arguments: args,
                    },
                )
            }
            "editor.context.preview" => {
                let request: PreviewContext = decode(call.arguments.clone())?;
                request.validate().map_err(invalid)?;
                check(
                    request.reference.provider == instance.identity
                        && request.reference.contribution.as_str() == CONTEXT,
                    "Context reference belongs to another provider or contribution",
                )?;
                let selector: Selector = decode(request.reference.selector.clone())?;
                check(
                    selector.version > 0,
                    "Context draft version must be positive",
                )?;
                let inclusion: Inclusion = decode(request.inclusion.clone())?;
                let args = json!({"window":request.reference.window,"draft":selector.draft});
                (
                    Phase::Inspect {
                        request,
                        selector,
                        inclusion,
                    },
                    Step::Read {
                        capability: "documents.inspect",
                        arguments: args,
                    },
                )
            }
            _ => return Err(invalid("Unknown Editor context capability")),
        };
        Ok((
            Self {
                instance: instance.clone(),
                phase,
            },
            step,
        ))
    }
    pub fn resume(&mut self, result: Value) -> Result<Step, Failure> {
        // HostResult contains a normal public QuerySnapshot. Never reinterpret
        // unavailable, cached or partial data as an authoritative draft capture.
        check(
            result["status"] == "ready" && result["completeness"] == "complete",
            "Draft observation is incomplete or unavailable",
        )?;
        let value = result
            .get("data")
            .ok_or_else(|| invalid("Missing draft observation"))?
            .clone();
        match std::mem::replace(&mut self.phase, Phase::Done) {
            Phase::Search(request) => {
                let page: DocumentDraftPage = decode(value)?;
                check(
                    page.drafts.len() <= usize::from(request.limit),
                    "Draft page exceeds the requested bound",
                )?;
                let mut items = vec![];
                let mut invalid_count = 0usize;
                let mut previous = None;
                for draft in &page.drafts {
                    check(
                        draft.source == source(&self.instance)
                            && draft.version > 0
                            && draft.bytes <= MAX_DRAFT_BYTES,
                        "Draft summary differs from the selected source",
                    )?;
                    check(
                        previous.is_none_or(|previous| &draft.draft > previous),
                        "Draft page identities are not ordered",
                    )?;
                    previous = Some(&draft.draft);
                    match item(
                        &self.instance,
                        &request.window,
                        &draft.draft,
                        draft.version,
                        &draft.digest,
                        &draft.metadata,
                    ) {
                        Ok(item) => {
                            let text = request.text.to_lowercase();
                            if item.title.to_lowercase().contains(&text)
                                || draft.metadata["path"]
                                    .as_str()
                                    .unwrap_or_default()
                                    .to_lowercase()
                                    .contains(&text)
                            {
                                items.push(item);
                            }
                        }
                        Err(_) => invalid_count += 1,
                    }
                }
                if let Some(next) = &page.next {
                    check(
                        previous == Some(next),
                        "Draft continuation does not match the page",
                    )?;
                }
                let notices = if invalid_count > 0 {
                    vec![format!(
                        "Could not list {invalid_count} Editor document{}.",
                        if invalid_count == 1 { "" } else { "s" }
                    )]
                } else {
                    vec![]
                };
                let next=page.next.map(|after|json!({"after":after,"text":request.text,"window":request.window,"revision":self.instance.identity.revision}));
                let page = ContextPage {
                    items,
                    next,
                    notices,
                };
                page.validate().map_err(invalid)?;
                Ok(Step::Complete {
                    data: json!(page),
                    completeness: if invalid_count > 0 {
                        ObservationCompleteness::Partial
                    } else {
                        ObservationCompleteness::Complete
                    },
                })
            }
            Phase::Inspect {
                request,
                selector,
                inclusion,
            } => {
                let draft: Option<DocumentDraft> = decode(value)?;
                let draft = draft.ok_or_else(changed)?;
                if draft.discarded
                    || draft.version != selector.version
                    || draft.content.digest != selector.digest
                {
                    return Err(changed());
                }
                check(
                    draft.draft == selector.draft
                        && draft.project == self.instance.project
                        && draft.principal == self.instance.principal
                        && draft.window == request.reference.window
                        && draft.source == source(&self.instance),
                    "Draft capture differs from its original source",
                )?;
                draft.content.validate().map_err(invalid)?;
                item(
                    &self.instance,
                    &draft.window,
                    &draft.draft,
                    draft.version,
                    &draft.content.digest,
                    &draft.metadata,
                )?;
                let step = read_step(&draft, 0);
                self.phase = Phase::Read {
                    request: Box::new(request),
                    inclusion,
                    draft,
                    bytes: vec![],
                };
                Ok(step)
            }
            Phase::Read {
                request,
                inclusion,
                draft,
                mut bytes,
            } => {
                let chunk: DocumentDraftChunk = decode(value)?;
                if chunk.version != draft.version || chunk.digest != draft.content.digest {
                    return Err(changed());
                }
                check(
                    chunk.draft == draft.draft && chunk.offset as usize == bytes.len(),
                    "Draft content page differs from the original capture",
                )?;
                let page = STANDARD.decode(chunk.base64).map_err(invalid)?;
                let end = bytes.len() + page.len();
                check(
                    page.len() <= MAX_DRAFT_CHUNK_BYTES as usize
                        && end <= draft.content.bytes as usize,
                    "Draft page exceeds its capture",
                )?;
                check(
                    chunk.next
                        == if end < draft.content.bytes as usize {
                            Some(end as u32)
                        } else {
                            None
                        }
                        && (end == draft.content.bytes as usize || !page.is_empty()),
                    "Draft content continuation is inconsistent",
                )?;
                bytes.extend(page);
                if chunk.next.is_some() {
                    let step = read_step(&draft, end as u32);
                    self.phase = Phase::Read {
                        request,
                        inclusion,
                        draft,
                        bytes,
                    };
                    Ok(step)
                } else {
                    check(
                        format!("sha256:{:x}", Sha256::digest(&bytes))
                            == draft.content.digest.as_str(),
                        "Draft content digest does not match its capture",
                    )?;
                    let preview = preview(&self.instance, *request, inclusion, draft, &bytes)?;
                    Ok(Step::Complete {
                        data: json!(preview),
                        completeness: ObservationCompleteness::Complete,
                    })
                }
            }
            Phase::Done => Err(invalid("Context read already completed")),
        }
    }
}
fn read_step(draft: &DocumentDraft, offset: u32) -> Step {
    Step::Read {
        capability: "documents.read",
        arguments: json!({"window":draft.window,"draft":draft.draft,"expected_version":draft.version,"offset":offset,"limit":MAX_DRAFT_CHUNK_BYTES}),
    }
}
fn metadata(value: &Value) -> Result<Metadata, Failure> {
    let meta: Metadata = decode(value.clone())?;
    check(
        meta.encoding == ENCODING
            && !meta.document_version.is_empty()
            && meta.document_version.len() <= 128,
        "Draft metadata is not an Editor encoding",
    )?;
    if let Some(path) = &meta.path {
        check(
            !path.is_empty()
                && path.len() <= 1024
                && !path.starts_with('/')
                && !path
                    .bytes()
                    .any(|byte| byte < 32 || byte == 127 || byte == b':' || byte == b'\\')
                && path.split('/').all(|part| {
                    !part.is_empty()
                        && part != "."
                        && part != ".."
                        && !part.eq_ignore_ascii_case(".git")
                }),
            "Invalid Editor path metadata",
        )?;
    }
    check(
        meta.name
            == meta
                .path
                .as_deref()
                .and_then(|path| path.rsplit('/').next())
                .unwrap_or("Untitled.R"),
        "Editor document name differs from its captured path",
    )?;
    Ok(meta)
}
fn item(
    instance: &PluginInstance,
    window: &WindowId,
    draft: &DraftId,
    version: u32,
    digest: &ContentDigest,
    value: &Value,
) -> Result<ContextItem, Failure> {
    let meta = metadata(value)?;
    let item = ContextItem {
        reference: ContextReference {
            provider: instance.identity.clone(),
            contribution: ContributionId::new(CONTEXT).unwrap(),
            window: window.clone(),
            selector: json!({"draft":draft,"version":version,"digest":digest}),
        },
        title: meta.name,
        description: meta.path.unwrap_or_else(|| "Unsaved document".into()),
        kind: "text".into(),
    };
    item.validate().map_err(invalid)?;
    Ok(item)
}
fn utf16_byte(text: &str, offset: u32) -> Result<usize, Failure> {
    let mut position = 0u32;
    for (byte, ch) in text.char_indices() {
        if position == offset {
            return Ok(byte);
        }
        position += ch.len_utf16() as u32;
    }
    if position == offset {
        Ok(text.len())
    } else {
        Err(invalid("Captured selection is outside a Unicode boundary"))
    }
}
fn preview(
    instance: &PluginInstance,
    request: PreviewContext,
    inclusion: Inclusion,
    draft: DocumentDraft,
    bytes: &[u8],
) -> Result<ContextPreview, Failure> {
    let payload: Payload = serde_json::from_slice(bytes).map_err(invalid)?;
    check(
        payload.schema == 1,
        "Draft has another Editor payload schema",
    )?;
    let document = payload.document;
    let meta = metadata(&draft.metadata)?;
    check(
        document.raw.len() <= MAX_EDITOR_BYTES
            && document.path == meta.path
            && document.version == meta.document_version
            && document.anchor == meta.selection.anchor
            && document.head == meta.selection.head
            && document.readonly.is_some() == meta.read_only,
        "Editor metadata differs from the captured document",
    )?;
    let text = document.raw.replace("\r\n", "\n").replace('\r', "\n");
    let (text, inclusion_name) = match inclusion {
        Inclusion::Document => (text.as_str(), "document"),
        Inclusion::Selection => {
            let start = utf16_byte(&text, document.anchor.min(document.head))?;
            let end = utf16_byte(&text, document.anchor.max(document.head))?;
            (&text[start..end], "selection")
        }
    };
    let mut end = text.len().min(request.max_bytes as usize);
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    let result = ContextPreview {
        item: item(
            instance,
            &draft.window,
            &draft.draft,
            draft.version,
            &draft.content.digest,
            &draft.metadata,
        )?,
        text: text[..end].into(),
        truncated: end < text.len() || document.readonly.is_some(),
        data: json!({"encoding":ENCODING,"path":document.path,"document_version":document.version,"draft_version":draft.version,"inclusion":inclusion_name,
            "selection":{"anchor":document.anchor,"head":document.head},"read_only":document.readonly,"synchronized":true,"annotation_source":{"source_id":format!("draft:{}",draft.draft),"source_version":format!("sha256:{:x}",Sha256::digest(document.raw.as_bytes()))}}),
        resources: vec![],
    };
    result.validate().map_err(invalid)?;
    Ok(result)
}
