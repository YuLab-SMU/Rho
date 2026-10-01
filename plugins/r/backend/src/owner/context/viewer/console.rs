//! Original terminal executions, never the current console buffer or a new run.
use super::*;
const SEARCH: &str = "r.context.console.search";
const PREVIEW: &str = "r.context.console.preview";
const MAX_EVENTS_BYTES: u64 = 2 * 1024 * 1024;
pub(super) fn is_query(id: &str) -> bool {
    matches!(id, SEARCH | PREVIEW)
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct ConsoleSource {
    operation: OperationId,
    session: String,
    events: ResourceReference,
}
#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
enum Inclusion {
    Code {},
    Transcript {},
}
fn original(
    owner: &InstanceRef,
    id: &OperationId,
    record: &Value,
) -> Result<Option<(ConsoleSource, String, String)>, String> {
    let op = &record["operation"];
    check(
        op["operation_id"] == id.as_str(),
        "Console returned another original operation",
    )?;
    let capability: CapabilityKey = decode(op["capability"].clone())?;
    let status = record["status"]
        .as_str()
        .ok_or("Missing Console operation status")?;
    if !terminal(status) || !execution(&capability) {
        return Ok(None);
    }
    let args = &op["normalized_arguments"];
    let provider: InstanceRef = decode(args["binding"]["provider"].clone())?;
    if &provider != owner {
        return Ok(None);
    }
    let output = &record["output"];
    if output.is_null()
        || status == "cancelled" && output == &json!({"operation_id":id,"started":false})
    {
        return Ok(None);
    }
    let session = args["arguments"]["expected_session"]
        .as_str()
        .filter(|s| !s.is_empty() && s.len() <= 160)
        .ok_or("Missing original Console session")?;
    check(
        output["operation_id"] == id.as_str() && output["session_id"] == session,
        "Console output differs from its original execution",
    )?;
    let run = if capability.version == 2 {
        &args["arguments"]["run"]
    } else {
        &args["arguments"]
    };
    let code = run["code"]
        .as_str()
        .ok_or("Missing original Console code")?;
    let events: ResourceReference = decode(output["events"].clone())?;
    ResourceRead {
        reference: events.clone(),
        offset: 0,
        limit: 1,
    }
    .validate()
    .map_err(|e| e.to_string())?;
    check(
        events.owner == *owner && events.media_type == "application/json",
        "Console events belong to another owner or format",
    )?;
    Ok(Some((
        ConsoleSource {
            operation: id.clone(),
            session: session.into(),
            events,
        },
        code.into(),
        status.into(),
    )))
}
impl ConsoleSource {
    fn item(
        &self,
        owner: &InstanceRef,
        window: &WindowId,
        code: &str,
        status: &str,
    ) -> Result<ContextItem, String> {
        let item = ContextItem {
            reference: ContextReference {
                provider: owner.clone(),
                window: window.clone(),
                contribution: ContributionId::new("console").unwrap(),
                selector: json!(self),
            },
            title: format!(
                "R run · {}",
                code.lines()
                    .next()
                    .unwrap_or("")
                    .chars()
                    .take(80)
                    .collect::<String>()
            ),
            description: format!(
                "{} · run {} · native session {}",
                status,
                self.operation.as_str(),
                self.session
            ),
            kind: "text".into(),
        };
        item.validate().map_err(|e| e.to_string())?;
        Ok(item)
    }
}
fn transcript(source: &ConsoleSource, bytes: &[u8]) -> Result<String, String> {
    check(
        bytes.len() as u64 == source.events.bytes
            && format!("sha256:{:x}", Sha256::digest(bytes)) == source.events.digest.as_str(),
        "Original Console events failed integrity verification",
    )?;
    let page: OutputEvents = serde_json::from_slice(bytes).map_err(|e| e.to_string())?;
    check(
        page.operation_id == source.operation
            && !page.has_more
            && !page.truncated
            && !page.gap
            && page.notices.is_empty(),
        "Original Console transcript is partial; choose original code only",
    )?;
    let mut prior = 0;
    let mut text = String::new();
    for event in page.events {
        check(
            event.operation_id == source.operation
                && event.sequence > prior
                && event.sequence <= page.next_sequence,
            "Console event identity or order changed",
        )?;
        prior = event.sequence;
        if let Some(value) = event.text {
            text.push_str(&format!(
                "[{} · {}]\n{}\n",
                event.sequence, event.kind, value
            ));
        }
        if event.media.is_some() {
            text.push_str(&format!(
                "[{} · media output omitted; inspect its original artifact]\n",
                event.sequence
            ));
        }
    }
    Ok(text)
}
impl Owner {
    pub(super) async fn query_console_context(&self, call: &PluginCall) -> Result<Value, String> {
        check(
            self.context_grants.get && call.scopes.contains("operation.read"),
            "Console context requires original-operation read access",
        )?;
        if call.binding.capability.id.as_str() == SEARCH {
            check(
                self.context_grants.list,
                "Console search requires operation listing access",
            )?;
            let request: ContextSearch = decode(call.arguments.clone())?;
            request.validate().map_err(|e| e.to_string())?;
            let cursor = request
                .after
                .as_ref()
                .map(|v| decode::<Cursor>(v.clone()))
                .transpose()?;
            if let Some(c) = &cursor {
                check(
                    c.owner == self.instance
                        && c.window == request.window
                        && c.text == request.text
                        && c.contribution == "console"
                        && c.within.is_none(),
                    "Console continuation belongs to another search",
                )?;
            }
            let before = cursor.and_then(|c| c.before);
            let page: JournalPage = decode(
                self.context_read(
                    call,
                    "operation.list_recent",
                    json!({"limit":request.limit.min(5),"before_cursor":before}),
                )
                .await?,
            )?;
            check(
                page.operations.len() <= usize::from(request.limit.min(5))
                    && page
                        .operations
                        .windows(2)
                        .all(|r| r[0].cursor > r[1].cursor)
                    && page
                        .operations
                        .iter()
                        .all(|r| before.is_none_or(|b| r.cursor < b))
                    && page.next_cursor.is_none_or(|next| {
                        page.operations.last().is_some_and(|r| r.cursor == next)
                    }),
                "Invalid Console journal continuation",
            )?;
            let mut items = vec![];
            for row in page.operations {
                if !execution(&row.capability) || !terminal(&row.status) {
                    continue;
                }
                let data = self
                    .context_read(
                        call,
                        "operation.get",
                        json!({"operation_id":row.operation_id}),
                    )
                    .await?;
                if let Some((source, code, status)) =
                    original(&self.instance, &row.operation_id, &data["record"])?
                {
                    check(
                        status == row.status,
                        "Original Console operation status changed",
                    )?;
                    if format!("{code} {status} {}", source.operation.as_str())
                        .to_lowercase()
                        .contains(&request.text.to_lowercase())
                    {
                        items.push(source.item(&self.instance, &request.window, &code, &status)?);
                    }
                }
            }
            let next = page.next_cursor.map(|before| {
                json!(Cursor {
                    owner: self.instance.clone(),
                    window: request.window,
                    text: request.text,
                    before: Some(before),
                    within: None,
                    contribution: "console".into()
                })
            });
            let page = ContextPage {items,next,notices:vec!["Original terminal R runs only. Empty pages may have more results; preview never starts R.".into()]};
            page.validate().map_err(|e| e.to_string())?;
            return Ok(json!(page));
        }
        let request: PreviewContext = decode(call.arguments.clone())?;
        request.validate().map_err(|e| e.to_string())?;
        check(
            request.reference.provider == self.instance
                && request.reference.contribution.as_str() == "console",
            "Console reference belongs to another provider or contribution",
        )?;
        let source: ConsoleSource = decode(request.reference.selector.clone())?;
        let inclusion: Inclusion = decode(request.inclusion.clone())?;
        let record = self
            .context_read(
                call,
                "operation.get",
                json!({"operation_id":source.operation}),
            )
            .await?;
        let (actual, code, status) =
            original(&self.instance, &source.operation, &record["record"])?
                .ok_or("Original terminal Console result is unavailable")?;
        check(
            json!(actual) == json!(source),
            "Console selection differs from its original execution",
        )?;
        let mut text = format!(
            "Original R run {} · {status}\nNative session: {}\nCode:\n{code}\n",
            source.operation.as_str(),
            source.session
        );
        let kind = match inclusion {
            Inclusion::Code {} => "code",
            Inclusion::Transcript {} => {
                check(
                    self.context_grants.resources && call.scopes.contains("resources.read"),
                    "Console transcript requires resource read access",
                )?;
                check(
                    source.events.bytes <= MAX_EVENTS_BYTES,
                    "Console event resource exceeds 2 MiB; choose original code only",
                )?;
                let mut bytes = Vec::new();
                while (bytes.len() as u64) < source.events.bytes {
                    bytes.extend(
                        self.resources
                            .read(
                                call.request.clone(),
                                ResourceRead {
                                    reference: source.events.clone(),
                                    offset: bytes.len() as u64,
                                    limit: MAX_RESOURCE_READ_BYTES,
                                },
                            )
                            .await
                            .map_err(|e| e.to_string())?,
                    );
                }
                text.push_str("Recorded output (event text, not a terminal screenshot):\n");
                text.push_str(&transcript(&source, &bytes)?);
                "transcript"
            }
        };
        if !record["record"]["error"].is_null() {
            text.push_str(&format!("Recorded error: {}\n", record["record"]["error"]));
        }
        // Both inclusions refer to the same immutable run. Include code and
        // terminal outcome as well as the retained transcript's digest.
        let source_version = format!(
            "sha256:{:x}",
            Sha256::digest(
                serde_json::to_vec(&json!([
                    code,
                    status,
                    record["record"]["error"],
                    source.events.digest
                ]))
                .map_err(|e| e.to_string())?
            )
        );
        let (text, truncated) = bounded_text(&text, request.max_bytes as usize);
        let preview = ContextPreview {
            item: source.item(&self.instance, &request.reference.window, &code, &status)?,
            text,
            truncated,
            data: json!({"operation":source.operation,"session":source.session,"events":source.events,"status":status,"inclusion":kind,
                "annotation_anchors":[{"kind":"structured","path":[source.operation],"row":null,"column":null,"topic":null}],
                "annotation_source":{"source_id":format!("run:{}",source.operation),"source_version":source_version}}),
            resources: vec![],
        };
        preview.validate().map_err(|e| e.to_string())?;
        Ok(json!(preview))
    }
}
#[cfg(test)]
mod tests;
