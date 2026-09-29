//! File references retain native identity and digest; preview never substitutes current bytes.
use super::*;
use serde::Serialize;
#[derive(Default)]
pub(super) struct Catalog {
    entries: BTreeMap<(String, String), TextIdentity>,
    order: std::collections::VecDeque<(String, String)>,
}
impl Catalog {
    pub(super) fn observe(&mut self, principal: &str, page: &TextPage) {
        let Some(file) = &page.file else { return };
        let key = (principal.into(), file.path.clone());
        self.order.retain(|old| old != &key);
        self.order.push_back(key.clone());
        self.entries.insert(key, file.clone());
        while self.entries.len() > 100 {
            self.entries.remove(&self.order.pop_front().unwrap());
        }
    }
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Cursor {
    owner: InstanceRef,
    principal: PrincipalId,
    window: WindowId,
    text: String,
    after: String,
}
#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
enum Inclusion {
    Metadata,
    Text,
}
fn item(
    owner: &InstanceRef,
    window: &WindowId,
    file: &TextIdentity,
) -> Result<ContextItem, Failure> {
    let item = ContextItem {
        reference: ContextReference {
            provider: owner.clone(),
            window: window.clone(),
            contribution: ContributionId::new("files").unwrap(),
            selector: json!(file),
        },
        title: file.path.chars().take(200).collect(),
        description: format!(
            "{} bytes · {} · original file identity",
            file.byte_size, file.encoding
        ),
        kind: "text".into(),
    };
    item.validate().map_err(Failure::input)?;
    Ok(item)
}
impl Owner {
    pub(super) async fn context(&self, call: &PluginCall) -> Result<Value, Failure> {
        if call.binding.capability.id.as_str() == "files.context.search" {
            let request: ContextSearch = decode(&call.arguments)?;
            request.validate().map_err(Failure::input)?;
            let cursor: Option<Cursor> = request.after.as_ref().map(decode).transpose()?;
            if cursor.as_ref().is_some_and(|c| {
                c.owner != call.binding.provider
                    || c.principal != call.principal
                    || c.window != request.window
                    || c.text != request.text
            }) {
                return Err(Failure::input(
                    "File context cursor belongs to another owner, caller or search",
                ));
            }
            let catalog = self.context_catalog.lock().unwrap();
            let rows = catalog
                .entries
                .iter()
                .filter(|((principal, path), _)| {
                    principal == call.principal.as_str()
                        && cursor.as_ref().is_none_or(|c| path > &c.after)
                        && path.to_lowercase().contains(&request.text.to_lowercase())
                })
                .take(usize::from(request.limit) + 1)
                .collect::<Vec<_>>();
            let items = rows
                .iter()
                .take(usize::from(request.limit))
                .map(|(_, file)| item(&call.binding.provider, &request.window, file))
                .collect::<Result<Vec<_>, _>>()?;
            let next = (rows.len() > usize::from(request.limit)).then(|| {
                json!(Cursor {
                    owner: call.binding.provider.clone(),
                    principal: call.principal.clone(),
                    window: request.window.clone(),
                    text: request.text.clone(),
                    after: rows[usize::from(request.limit) - 1].1.path.clone()
                })
            });
            let page = ContextPage{items,next,notices:vec!["Up to 100 previously read text files. Preview rechecks the original digest and native identity; unavailable files are never silently refreshed.".into()]};
            page.validate().map_err(Failure::input)?;
            return encode(page);
        }
        let request: PreviewContext = decode(&call.arguments)?;
        request.validate().map_err(Failure::input)?;
        if request.reference.provider != call.binding.provider
            || request.reference.contribution.as_str() != "files"
        {
            return Err(Failure::input(
                "File context belongs to another provider or contribution",
            ));
        }
        let file: TextIdentity = decode(&request.reference.selector)?;
        let inclusion: Inclusion = decode(&request.inclusion)?;
        let mut args = ReadTextArguments {
            path: file.path.clone(),
            expected_sha256: Some(file.sha256.clone()),
            start_line: 1,
            limit_lines: 200,
            continuation: None,
        };
        validate_read(&args).map_err(Failure::text)?;
        let limit = request.max_bytes.min(16384) as usize;
        let mut text = format!(
            "Project file: {}\nSHA-256: {}\nBytes: {}\nEncoding: {}\n",
            file.path, file.sha256, file.byte_size, file.encoding
        );
        let mut truncated = false;
        let runtime = self.runtime()?;
        loop {
            let page = runtime.read_text(&args).await.map_err(Failure::text)?;
            if page.file.as_ref() != Some(&file) || page.skipped.is_some() {
                return Err(Failure {code:"content_changed",message:"The original file is changed or unavailable. Prepare the selected file again.".into()});
            }
            if matches!(inclusion, Inclusion::Metadata) {
                break;
            }
            for fragment in page.fragments {
                text.push_str(&fragment.text);
            }
            if text.len() > limit {
                truncated = true;
                break;
            }
            match page.continuation {
                None if page.complete => break,
                Some(next)
                    if args
                        .continuation
                        .as_ref()
                        .is_none_or(|old| next.byte_offset > old.byte_offset) =>
                {
                    args.continuation = Some(next)
                }
                _ => {
                    return Err(Failure::unavailable(
                        "Original file text pagination did not complete",
                    ));
                }
            }
        }
        if text.len() > limit {
            truncated = true;
            let mut end = limit;
            while !text.is_char_boundary(end) {
                end -= 1;
            }
            text.truncate(end);
        }
        let preview = ContextPreview {
            item: item(&call.binding.provider, &request.reference.window, &file)?,
            text,
            truncated,
            // The contained project path is the lineage, not the transient native
            // observation. Exact native identity is still checked above; identical
            // bytes saved again remain the same annotation content version.
            data: json!({"file":file,"inclusion":request.inclusion,
                "annotation_source":{"source_id":format!("file:{}",file.path),
                    "source_version":file.sha256}}),
            resources: vec![],
        };
        preview.validate().map_err(Failure::input)?;
        encode(preview)
    }
}
