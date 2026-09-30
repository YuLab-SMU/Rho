//! File references retain native identity and digest; preview never substitutes current bytes.
use super::*;
use serde::Serialize;
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Cursor {
    owner: InstanceRef,
    principal: PrincipalId,
    window: WindowId,
    text: String,
    after: SearchFilesCursor,
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
            let _lane = self.lane.try_lock().map_err(|_| {
                Failure::unavailable("Files is busy applying a patch; try again after it settles")
            })?;
            let runtime = self.runtime()?;
            let discovered = rho_files_owner::list_matching_files(
                runtime,
                &SearchFilesArguments {
                    text: request.text.clone(),
                    show_hidden: false,
                    continuation: cursor.map(|c| c.after),
                },
                usize::from(request.limit),
            )
            .await
            .map_err(Failure::input)?;
            let mut items = vec![];
            let mut notices = discovered
                .notices
                .into_iter()
                .take(5)
                .map(|n| n.chars().take(900).collect::<String>())
                .collect::<Vec<_>>();
            let mut skipped_files = 0;
            let mut identity_budget = 8 * 1024 * 1024_u64;
            for entry in discovered.entries {
                if entry.kind != "regular" {
                    continue;
                }
                if entry.byte_size > identity_budget {
                    skipped_files += 1;
                    continue;
                }
                identity_budget -= entry.byte_size;
                let page = runtime
                    .read_text(&ReadTextArguments {
                        path: entry.path.clone(),
                        expected_sha256: None,
                        start_line: 1,
                        limit_lines: 1,
                        continuation: None,
                    })
                    .await
                    .map_err(Failure::text)?;
                if let Some(file) = page.file.filter(|_| page.skipped.is_none()) {
                    items.push(item(&call.binding.provider, &request.window, &file)?);
                } else {
                    skipped_files += 1;
                }
            }
            let next = discovered.continuation.map(|after| {
                json!(Cursor {
                    owner: call.binding.provider.clone(),
                    principal: call.principal.clone(),
                    window: request.window,
                    text: request.text,
                    after,
                })
            });
            if skipped_files > 0 {
                notices.push(format!("{skipped_files} file(s) omitted because they are binary, unsupported, outside the page byte budget or unavailable."));
            }
            notices.push("Current project text files. Hidden files are excluded; unsupported files are reported. Preview rechecks the captured digest and native identity.".into());
            let page = ContextPage {
                items,
                next,
                notices,
            };
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
