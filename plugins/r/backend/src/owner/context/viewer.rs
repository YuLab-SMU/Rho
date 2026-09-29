use super::*;

const SEARCH: &str = "r.context.viewer.search";
const PREVIEW: &str = "r.context.viewer.preview";
const CONTRIBUTION: &str = "viewer";
const PLOT_SEARCH: &str = "r.context.plots.search";
const PLOT_PREVIEW: &str = "r.context.plots.preview";
mod plots;
mod console;
pub(super) fn is_query(id: &str) -> bool {
    matches!(id, SEARCH | PREVIEW | PLOT_SEARCH | PLOT_PREVIEW) || console::is_query(id)
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Source {
    pub(super) operation: OperationId,
    pub(super) sequence: u64,
    pub(super) session: String,
    pub(super) reference: ResourceReference,
}
impl Source {
    fn item(
        &self,
        owner: &InstanceRef,
        window: &WindowId,
        status: &str,
    ) -> Result<ContextItem, String> {
        let item = ContextItem {
            reference: ContextReference {
                provider: owner.clone(),
                contribution: ContributionId::new(CONTRIBUTION).unwrap(),
                window: window.clone(),
                selector: json!(self),
            },
            title: format!("HTML output {}", self.sequence),
            description: format!(
                "Run {} · {status} · {} bytes · saved artifact",
                self.operation.as_str(),
                self.reference.bytes
            ),
            kind: "text".into(),
        };
        item.validate().map_err(|e| e.to_string())?;
        Ok(item)
    }
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Cursor {
    owner: InstanceRef,
    window: WindowId,
    text: String,
    before: Option<u64>,
    within: Option<(OperationId, u64)>,
    #[serde(default = "viewer_contribution")]
    contribution: String,
}
fn viewer_contribution() -> String {
    "viewer".into()
}
#[derive(Deserialize)]
struct JournalPage {
    operations: Vec<JournalItem>,
    next_cursor: Option<u64>,
}
#[derive(Deserialize)]
struct JournalItem {
    cursor: u64,
    operation_id: OperationId,
    capability: CapabilityKey,
    status: String,
}

fn terminal(status: &str) -> bool {
    matches!(status, "succeeded" | "failed" | "cancelled" | "uncertain")
}
fn execution(capability: &CapabilityKey) -> bool {
    capability.id.as_str() == "r.execute" && matches!(capability.version, 1 | 2)
}
fn outputs(
    owner: &InstanceRef,
    operation: &OperationId,
    record: &Value,
) -> Result<(Vec<Source>, String), String> {
    outputs_for(owner, operation, record, &["text/html"])
}
fn outputs_for(
    owner: &InstanceRef,
    operation: &OperationId,
    record: &Value,
    media_types: &[&str],
) -> Result<(Vec<Source>, String), String> {
    let original = &record["operation"];
    let capability: CapabilityKey = decode(original["capability"].clone())?;
    let status = record["status"]
        .as_str()
        .ok_or("Missing original operation status")?;
    check(
        original["operation_id"] == operation.as_str(),
        "Viewer context returned another original operation",
    )?;
    if !terminal(status) || !execution(&capability) {
        return Ok((vec![], status.into()));
    }
    let provider: InstanceRef =
        decode(original["normalized_arguments"]["binding"]["provider"].clone())?;
    if &provider != owner {
        return Ok((vec![], status.into()));
    }
    let output = &record["output"];
    if output.is_null() {
        return Ok((vec![], status.into()));
    }
    check(
        output["operation_id"] == operation.as_str(),
        "Viewer output differs from its original operation",
    )?;
    if status == "cancelled" && output == &json!({"operation_id":operation,"started":false}) {
        return Ok((vec![], status.into()));
    }
    let session = output["session_id"]
        .as_str()
        .filter(|s| !s.is_empty() && s.len() <= 160)
        .ok_or("Missing original native session")?;
    let media: Vec<RetainedROutput> = decode(output["outputs"].clone())?;
    let mut result = vec![];
    let mut previous = None;
    for item in media {
        if !media_types.contains(&item.reference.media_type.as_str()) {
            continue;
        }
        check(
            item.reference.owner == *owner
                && item.native.operation_id == *operation
                && item.native.mime_type == item.reference.media_type
                && item.native.byte_size == item.reference.bytes
                && item.native.sha256 == item.reference.digest.as_str()
                && previous.is_none_or(|seq| seq < item.native.sequence),
            "Saved output identity or sequence differs from its original R result",
        )?;
        ResourceRead {
            reference: item.reference.clone(),
            offset: 0,
            limit: 1,
        }
        .validate()
        .map_err(|e| e.to_string())?;
        previous = Some(item.native.sequence);
        result.push(Source {
            operation: operation.clone(),
            sequence: item.native.sequence,
            session: session.into(),
            reference: item.reference,
        });
    }
    Ok((result, status.into()))
}
impl Owner {
    async fn context_read(
        &self,
        call: &PluginCall,
        id: &str,
        arguments: Value,
    ) -> Result<Value, String> {
        let observation = self
            .host
            .call(
                call.request.clone(),
                None,
                environment_binding::key(id, 1),
                arguments,
                Duration::from_secs(30),
            )
            .await?;
        check(
            observation["status"] == "ready"
                && (observation["completeness"] == "complete"
                    || id == "operation.list_recent" && observation["completeness"] == "partial"),
            "Original Viewer record is incomplete or unavailable",
        )?;
        observation
            .get("data")
            .cloned()
            .ok_or("Missing original Viewer observation".into())
    }
    pub(super) async fn query_viewer_context(&self, call: &PluginCall) -> Result<Value, String> {
        if console::is_query(call.binding.capability.id.as_str()) { return self.query_console_context(call).await; }
        let plot = matches!(
            call.binding.capability.id.as_str(),
            PLOT_SEARCH | PLOT_PREVIEW
        );
        let contribution = if plot { "plots" } else { "viewer" };
        check(
            self.context_grants.get && call.scopes.contains("operation.read"),
            "Viewer context requires the selected original-operation read grant",
        )?;
        match call.binding.capability.id.as_str() {
            PLOT_PREVIEW => self.query_plot_context(call).await,
            SEARCH | PLOT_SEARCH => {
                check(
                    self.context_grants.list,
                    "Viewer search requires the selected operation listing grant",
                )?;
                let request: ContextSearch = decode(call.arguments.clone())?;
                request.validate().map_err(|e| e.to_string())?;
                let cursor = request
                    .after
                    .as_ref()
                    .map(|value| decode::<Cursor>(value.clone()))
                    .transpose()?;
                if let Some(cursor) = &cursor {
                    check(
                        cursor.owner == self.instance
                            && cursor.window == request.window
                            && cursor.text == request.text
                            && cursor.contribution == contribution,
                        "Viewer continuation belongs to another provider, window or search",
                    )?;
                }
                let before = cursor.as_ref().and_then(|c| c.before);
                let mut within = cursor.and_then(|c| c.within);
                let page: JournalPage = decode(
                    self.context_read(
                        call,
                        "operation.list_recent",
                        json!({"limit":5,"before_cursor":before}),
                    )
                    .await?,
                )?;
                check(
                    page.operations.len() <= 5
                        && page
                            .operations
                            .windows(2)
                            .all(|rows| rows[0].cursor > rows[1].cursor)
                        && page
                            .operations
                            .iter()
                            .all(|row| before.is_none_or(|before| row.cursor < before))
                        && page.next_cursor.is_none_or(|next| {
                            page.operations.last().is_some_and(|row| row.cursor == next)
                        }),
                    "Invalid Viewer journal continuation",
                )?;
                if let Some((operation, _)) = &within {
                    check(
                        page.operations
                            .first()
                            .is_some_and(|row| &row.operation_id == operation),
                        "Original Viewer continuation is unavailable",
                    )?;
                }
                let text = request.text.to_lowercase();
                let mut items = vec![];
                let mut next = page.next_cursor.map(|before| {
                    json!(Cursor {
                        owner: self.instance.clone(),
                        window: request.window.clone(),
                        text: request.text.clone(),
                        before: Some(before),
                        within: None,
                        contribution: contribution.into()
                    })
                });
                'records: for row in page.operations {
                    let after_sequence = within.take().map(|(_, sequence)| sequence);
                    if !execution(&row.capability) || !terminal(&row.status) {
                        continue;
                    }
                    let observed = self
                        .context_read(
                            call,
                            "operation.get",
                            json!({"operation_id":row.operation_id}),
                        )
                        .await?;
                    let (sources, status) = outputs_for(
                        &self.instance,
                        &row.operation_id,
                        &observed["record"],
                        if plot { plots::TYPES } else { &["text/html"] },
                    )?;
                    check(
                        status == row.status,
                        "Original Viewer operation status changed",
                    )?;
                    let mut last = after_sequence;
                    for source in sources {
                        if after_sequence.is_some_and(|sequence| source.sequence <= sequence) {
                            continue;
                        }
                        let item = if plot {
                            plots::item(
                                &self.instance,
                                &request.window,
                                std::slice::from_ref(&source),
                            )?
                        } else {
                            source.item(&self.instance, &request.window, &status)?
                        };
                        if !format!("{} {}", item.title, item.description)
                            .to_lowercase()
                            .contains(&text)
                        {
                            continue;
                        }
                        if items.len() == usize::from(request.limit) {
                            next = Some(json!(Cursor {
                                owner: self.instance.clone(),
                                window: request.window.clone(),
                                text: request.text.clone(),
                                before: Some(
                                    row.cursor
                                        .checked_add(1)
                                        .filter(|v| *v <= i64::MAX as u64)
                                        .ok_or("Viewer cursor exceeds the journal bound")?
                                ),
                                within: last.map(|sequence| (row.operation_id, sequence)),
                                contribution: contribution.into()
                            }));
                            break 'records;
                        }
                        last = Some(source.sequence);
                        items.push(item);
                    }
                }
                let page = ContextPage {
                    items,
                    next,
                    notices: vec![if plot {
                        "Saved original plots only; PNG/JPEG image inclusion is explicit. A journal page can be empty and still have more results.".into()
                    } else {
                        "Saved HTML from terminal R operations only. Interactive browser state is not captured. A journal page can have no matches and still have more results.".into()
                    }],
                };
                page.validate().map_err(|e| e.to_string())?;
                Ok(json!(page))
            }
            PREVIEW => {
                let request: PreviewContext = decode(call.arguments.clone())?;
                request.validate().map_err(|e| e.to_string())?;
                check(
                    request.reference.provider == self.instance
                        && request.reference.contribution.as_str() == CONTRIBUTION,
                    "Viewer reference belongs to another provider or contribution",
                )?;
                let source: Source = decode(request.reference.selector.clone())?;
                let inclusion: Inclusion = decode(request.inclusion.clone())?;
                let observed = self
                    .context_read(
                        call,
                        "operation.get",
                        json!({"operation_id":source.operation}),
                    )
                    .await?;
                let (sources, status) =
                    outputs(&self.instance, &source.operation, &observed["record"])?;
                check(
                    sources.iter().any(|s| json!(s) == json!(source)),
                    "Viewer selection differs from its original committed output",
                )?;
                let (text, truncated, inclusion) = match inclusion {
                    Inclusion::Metadata {} => (
                        format!(
                            "Saved HTML artifact record · {} bytes · R session {} · run {} · output {} · {status}. Content availability and interactive selection, zoom or filter state are not included.",
                            source.reference.bytes,
                            source.session,
                            source.operation.as_str(),
                            source.sequence
                        ),
                        false,
                        "metadata",
                    ),
                    Inclusion::Text {} => {
                        check(
                            self.context_grants.resources && call.scopes.contains("resources.read"),
                            "Viewer text requires the selected resource read grant",
                        )?;
                        let bytes = self
                            .resources
                            .read(
                                call.request.clone(),
                                ResourceRead {
                                    reference: source.reference.clone(),
                                    offset: 0,
                                    limit: request.max_bytes,
                                },
                            )
                            .await
                            .map_err(|e| e.to_string())?;
                        let complete = bytes.len() as u64 == source.reference.bytes;
                        if complete {
                            check(
                                format!("sha256:{:x}", Sha256::digest(&bytes))
                                    == source.reference.digest.as_str(),
                                "Saved HTML digest changed",
                            )?;
                        }
                        let text = utf8_prefix(&bytes, complete)?;
                        (text, !complete, "text")
                    }
                };
                let (text, clipped) = bounded_text(&text, request.max_bytes as usize);
                let preview = ContextPreview {
                    item: source.item(&self.instance, &request.reference.window, &status)?,
                    text,
                    truncated: truncated || clipped,
                    data: json!({"inclusion":inclusion,"format":"html_source","operation_status":status,"interactive_state":false,
                        "annotation_source":{"source_id":format!("output:{}:{}",source.operation,source.sequence),"source_version":source.reference.digest}}),
                    resources: vec![],
                };
                check(
                    preview.item.reference == request.reference,
                    "Viewer preview changed its original reference",
                )?;
                preview.validate().map_err(|e| e.to_string())?;
                Ok(json!(preview))
            }
            _ => Err("Unknown Viewer context capability".into()),
        }
    }
}
#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
enum Inclusion {
    Text {},
    Metadata {},
}
fn bounded_text(text: &str, limit: usize) -> (String, bool) {
    let mut end = limit.min(text.len());
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    (text[..end].into(), end < text.len())
}
fn utf8_prefix(bytes: &[u8], complete: bool) -> Result<String, String> {
    match std::str::from_utf8(bytes) {
        Ok(text) => Ok(text.into()),
        Err(error) if !complete && error.error_len().is_none() => {
            Ok(std::str::from_utf8(&bytes[..error.valid_up_to()])
                .unwrap()
                .into())
        }
        Err(_) => Err("The saved HTML is not UTF-8 text".into()),
    }
}

#[cfg(test)]
mod tests;
