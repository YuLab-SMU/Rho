//! Version-bound Agent task evidence from the existing handoff read projection.
use crate::{
    manifest,
    metadata::{Failure, Metadata, decode, encoded},
};
use rho_agent_api::{ProjectAgentTaskPage, ProjectAgentTaskRef};
use rho_plugin_sdk::protocol::*;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Selector {
    task: ProjectAgentTaskRef,
    revision: String,
}
fn item(
    metadata: &Metadata,
    window: WindowId,
    source: &rho_agent_api::handoff::AgentHandoffSourceSnapshot,
) -> ContextItem {
    ContextItem {
        reference: ContextReference {
            provider: metadata.instance.identity.clone(),
            contribution: ContributionId::new("agent").unwrap(),
            window,
            selector: json!(Selector {
                task: source.source.clone(),
                revision: source.revision.clone()
            }),
        },
        title: source.title.chars().take(160).collect(),
        description:
            "Retained Agent task text at an exact revision; model text is not scientific truth."
                .into(),
        kind: "text".into(),
    }
}
pub(crate) fn query(metadata: &Metadata, call: &PluginCall) -> Result<Value, Failure> {
    if call.binding.capability.id.as_str() == "agent.context.search" {
        let request: ContextSearch = decode(&call.arguments)?;
        request
            .validate()
            .map_err(|error| Failure::invalid(&error.to_string()))?;
        let mut read = call.clone();
        read.binding.capability = manifest::key("agent.tasks");
        read.arguments =
            json!({"archived":false,"before":request.after,"limit":request.limit.min(20)});
        let page: ProjectAgentTaskPage = decode(&metadata.read(&read)?)?;
        let mut items = vec![];
        for task in page.tasks {
            if !task
                .title
                .to_lowercase()
                .contains(&request.text.to_lowercase())
            {
                continue;
            }
            let source = metadata
                .handoffs
                .source(&metadata.scope, &task.reference, &[])?;
            items.push(item(metadata, request.window.clone(), &source));
        }
        return encoded(ContextPage {
            items,
            next: page.next.map(Value::String),
            notices: vec!["Task text only; no model call or native history reconnection.".into()],
        });
    }
    let request: PreviewContext = decode(&call.arguments)?;
    request
        .validate()
        .map_err(|error| Failure::invalid(&error.to_string()))?;
    if request.reference.provider != metadata.instance.identity
        || request.reference.contribution.as_str() != "agent"
        || request.inclusion != json!({"kind":"task"})
    {
        return Err(Failure::invalid(
            "Agent source differs from its exact task contribution",
        ));
    }
    let selection: Selector = decode(&request.reference.selector)?;
    let source = metadata
        .handoffs
        .source(&metadata.scope, &selection.task, &[])?;
    if source.revision != selection.revision {
        return Err(Failure::invalid(
            "The Agent task revision changed; retain the original note and prepare the current task",
        ));
    }
    let task_id = match &selection.task {
        ProjectAgentTaskRef::Native { task_id } => task_id,
        ProjectAgentTaskRef::Rho { conversation_id } => conversation_id,
    };
    let mut text = source.body.clone();
    let truncated = source.truncated || text.len() > request.max_bytes as usize;
    let mut end = text.len().min(request.max_bytes as usize);
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    text.truncate(end);
    encoded(ContextPreview {
        item: item(metadata, request.reference.window, &source),
        text,
        truncated,
        data: json!({"annotation_source":{"source_id":format!("task:{}",serde_json::to_string(&selection.task).map_err(|error| Failure::invalid(&error.to_string()))?),"source_version":source.revision},
            "annotation_anchors":[{"kind":"structured","path":[task_id],"row":null,"column":null,"topic":null}],"notices":source.notices,"scientific_truth":false}),
        resources: vec![],
    })
}
