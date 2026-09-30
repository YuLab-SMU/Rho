//! The source of a fresh document note must be one of this original Send's
//! explicit read tools. Shared by Native and Rho model admission.
use rho_agent_api::{AgentNativeToolSelection, AgentNativeToolTarget};
use rho_plugin_sdk::protocol::{ContextReference, ProjectId};
use serde_json::Value;
pub(crate) fn document_source<'a>(
    reference: &Value,
    tools: impl IntoIterator<Item = &'a AgentNativeToolSelection>,
    project: &ProjectId,
    window: &str,
) -> Result<(), String> {
    let reference: ContextReference = serde_json::from_value(reference.clone())
        .map_err(|_| "A new research note requires an exact selected Editor reference")?;
    let selected = tools.into_iter().any(|tool| matches!(&tool.target,
        AgentNativeToolTarget::Provider { binding } if binding.capability.id.as_str()=="editor.context.preview"
            && binding.capability.version==1 && binding.provider==reference.provider && &binding.project==project));
    if !selected
        || reference.contribution.as_str() != "documents"
        || reference.window.as_str() != window
    {
        return Err("Research-note capture requires the original window and an Editor preview tool selected for this Send".into());
    }
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn only_original_selected_document_provider_window_and_project_can_be_frozen() {
        let provider = json!({"plugin":"org.rho.editor","instance":"editor-one","revision":format!("sha256:{}","a".repeat(64)),"artifact":format!("sha256:{}","b".repeat(64))});
        let tool: AgentNativeToolSelection=serde_json::from_value(json!({"name":"editor_context_preview","target":{"type":"provider","binding":{"provider":provider,"project":"project","capability":{"id":"editor.context.preview","version":1},"target":null}}})).unwrap();
        let reference = json!({"provider":provider,"window":"window","contribution":"documents","selector":{"draft":"draft-one","version":1,"digest":format!("sha256:{}","c".repeat(64))}});
        let project = ProjectId::new("project").unwrap();
        assert!(document_source(&reference, [&tool], &project, "window").is_ok());
        assert!(document_source(&reference, [], &project, "window").is_err());
        assert!(document_source(&reference, [&tool], &project, "another-window").is_err());
        assert!(
            document_source(
                &reference,
                [&tool],
                &ProjectId::new("another-project").unwrap(),
                "window"
            )
            .is_err()
        );
        for (field, value) in [
            ("instance", json!("other-editor")),
            ("artifact", json!(format!("sha256:{}", "d".repeat(64)))),
        ] {
            let mut changed = reference.clone();
            changed["provider"][field] = value;
            assert!(document_source(&changed, [&tool], &project, "window").is_err());
        }
        let mut changed = reference;
        changed["contribution"] = json!("files");
        assert!(document_source(&changed, [&tool], &project, "window").is_err());
    }
}
