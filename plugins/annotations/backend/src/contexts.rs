use crate::{
    metadata::{Failure, Metadata, decode, encoded},
    sources,
};
use rho_annotation_api::*;
use rho_plugin_sdk::protocol::*;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Cursor {
    window: WindowId,
    text: String,
    after: String,
}
fn item(
    metadata: &Metadata,
    window: &WindowId,
    revision: &AnnotationRevision,
    source: &AnnotationSourceRef,
) -> ContextItem {
    ContextItem {
        reference: ContextReference {
            provider: metadata.instance.identity.clone(),
            contribution: ContributionId::new("annotations").unwrap(),
            window: window.clone(),
            selector: json!(revision.annotation),
        },
        title: source.title.chars().take(200).collect(),
        description: format!(
            "Annotation revision {} · Frozen source {} · current source status unknown",
            revision.annotation.revision,
            source.source_version.chars().take(120).collect::<String>()
        ),
        kind: "annotation".into(),
    }
}
pub fn search(
    metadata: &Metadata,
    request: ContextSearch,
    caller: &PluginViewCaller,
) -> Result<Value, Failure> {
    request.validate().map_err(Failure::invalid)?;
    sources::window(caller, &request.window)?;
    let cursor = request.after.as_ref().map(decode::<Cursor>).transpose()?;
    if cursor
        .as_ref()
        .is_some_and(|c| c.window != request.window || c.text != request.text)
    {
        return Err(Failure::invalid(
            "Annotation search cursor belongs to another search",
        ));
    }
    // Scan one bounded metadata page only. An empty matching page may have a continuation.
    let (rows, next) = metadata.owner.list(
        &metadata.scope,
        None,
        cursor.as_ref().map(|c| c.after.as_str()),
        request.limit as u32,
        false,
    )?;
    let needle = request.text.to_lowercase();
    let items = rows
        .into_iter()
        .filter(|row| {
            row.revision.note.to_lowercase().contains(&needle)
                || row.source.title.to_lowercase().contains(&needle)
        })
        .map(|row| item(metadata, &request.window, &row.revision, &row.source))
        .collect();
    let next = next.map(|after| {
        json!(Cursor {
            window: request.window,
            text: request.text,
            after
        })
    });
    let page = ContextPage { items, next, notices: vec!["Notes retain their original source evidence. Search does not observe current source availability or start a runtime.".into()] };
    page.validate().map_err(Failure::invalid)?;
    encoded(page)
}
pub fn preview(
    metadata: &Metadata,
    request: PreviewContext,
    caller: &PluginViewCaller,
) -> Result<Value, Failure> {
    request.validate().map_err(Failure::invalid)?;
    sources::window(caller, &request.reference.window)?;
    if request.reference.provider != metadata.instance.identity
        || request.reference.contribution.as_str() != "annotations"
        || request.inclusion != json!({"kind":"note_and_evidence"})
    {
        return Err(Failure::invalid(
            "Annotation preview differs from its exact source or inclusion",
        ));
    }
    let reference: AnnotationRevisionRef = decode(&request.reference.selector)?;
    let (revision, evidence) = metadata.owner.read(&metadata.scope, &reference)?;
    let mut text = format!(
        "Annotation: {}\nRevision: {}{}\n\n{}\n\nFrozen source version: {}\nCurrent source status: unknown (not re-observed).\n\n{}",
        evidence.source.title,
        reference.revision,
        if revision.deleted { " (deleted)" } else { "" },
        revision.note,
        evidence.source.source_version,
        evidence.fragment["text"]
            .as_str()
            .unwrap_or("No text excerpt was captured.")
    );
    let truncated = text.len() > request.max_bytes as usize;
    let mut end = text.len().min(request.max_bytes as usize);
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    text.truncate(end);
    let preview = ContextPreview {
        item: item(
            metadata,
            &request.reference.window,
            &revision,
            &evidence.source,
        ),
        text,
        truncated,
        data: json!({"annotation":reference,"author":revision.author,"source":evidence.source,"anchor":evidence.anchor,"marks":revision.marks,"deleted":revision.deleted,"source_status":"unknown","source_availability":"unknown","frozen_evidence":true,"annotation_source":{"source_id":reference.annotation_id,"source_version":reference.revision.to_string()}}),
        resources: vec![],
    };
    preview.validate().map_err(Failure::invalid)?;
    encoded(preview)
}
