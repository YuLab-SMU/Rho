use rho_plugin_sdk::protocol::*;
use serde_json::{Value, json};
fn main() -> Result<(), Box<dyn std::error::Error>> {
    let destination = std::env::args_os()
        .nth(1)
        .ok_or("Expected manifest destination")?;
    let mut manifest: Value = serde_json::from_slice(&std::fs::read(&destination)?)?;
    let example = json!({"provider":{"plugin":"org.rho.editor","instance":"editor-example","revision":format!("sha256:{}","a".repeat(64)),"artifact":format!("sha256:{}","b".repeat(64))},
        "contribution":"documents","window":"window-example","selector":{"draft":"draft-example","version":1,"digest":format!("sha256:{}","c".repeat(64))}});
    let capability = |id, input: Value, output: Value, example: Value| {
        json!({"capability":{"id":id,"version":1},"kind":"query","title":id,
        "description":"Observe synchronized Editor context at its original source version. Does not read native files, start R, execute code, or recover work.",
        "input_schema":input,"examples":[example],"output_schema":output,"recovery_schema":true,"required_scopes":["documents.read"],"effects":[],"cancellation":"unsupported"})
    };
    let mut preview_input = schemars::schema_for!(PreviewContext).to_value();
    // Inclusion choices are declared data for generic consumers, never a core
    // branch that recognizes the Editor's plugin id or a fixed panel enum.
    preview_input["properties"]["inclusion"] = json!({"oneOf":[
        {"title":"Synchronized document","type":"object","additionalProperties":false,"required":["kind"],"properties":{"kind":{"const":"document"}}},
        {"title":"Captured selection","type":"object","additionalProperties":false,"required":["kind"],"properties":{"kind":{"const":"selection"}}}
    ]});
    manifest["capabilities"] = json!([
        capability(
            "editor.context.search",
            schemars::schema_for!(ContextSearch).to_value(),
            schemars::schema_for!(ContextPage).to_value(),
            json!({"window":"window-example","text":"","after":null,"limit":20})
        ),
        capability(
            "editor.context.preview",
            preview_input,
            schemars::schema_for!(ContextPreview).to_value(),
            json!({"reference":example,"inclusion":{"kind":"document"},"max_bytes":16384})
        )
    ]);
    manifest["capabilities"].as_array_mut().unwrap().push(json!({
        "capability":{"id":"editor.run.inspect","version":1},"kind":"query","title":"Inspect original Editor run",
        "description":"Read the original Editor run and its native execution, including lost child acknowledgements. Does not execute, retry, start R or promote uncertain work to success.",
        "input_schema":schemars::schema_for!(rho_editor_backend::actions::InspectRun).to_value(),"output_schema":true,"recovery_schema":true,
        "examples":[{"operation":"operation-example","window":"window-example"}],"required_scopes":["documents.read","operation.read"],"effects":[],"cancellation":"unsupported"
    }));
    let required = manifest["requires"].as_array_mut().unwrap();
    if !required
        .iter()
        .any(|r| r["capability"]["id"] == "plugins.delegated_operation")
    {
        required.push(json!({"capability":{"id":"plugins.delegated_operation","version":1},"scopes":["operation.read"]}));
    }
    for requirement in &mut *required {
        if requirement["capability"]["id"] == "plugins.delegated_operation" {
            requirement["scopes"] = json!(["operation.read"]);
        }
    }
    for (id, description, scopes) in [
        (
            "editor.edit",
            "Replace the exact synchronized Editor draft with complete text (32 KiB maximum), preserving its file base and line endings. CAS rejects concurrent edits. Does not save the file or run code.",
            vec!["documents.read", "documents.write", "operation.read"],
        ),
        (
            "editor.save",
            "Save an exact synchronized Editor document through its captured Files provider and file digest. An optional new path must be absent. Returns the updated reference and original child operations; a draft conflict after a file save is partial work, not rollback.",
            vec![
                "documents.read",
                "documents.write",
                "operation.read",
                "project.read",
                "project.write",
            ],
        ),
        (
            "editor.run",
            "Run the exact synchronized document through its captured R provider/session. Never accepts replacement code or starts R. Returns the original code digest, document reference and native execution result.",
            vec![
                "documents.read",
                "documents.write",
                "operation.read",
                "workspace.run_r",
            ],
        ),
    ] {
        manifest["capabilities"].as_array_mut().unwrap().push(json!({"capability":{"id":id,"version":1},"kind":"operation","title":id,"description":description,
            "input_schema":schemars::schema_for!(rho_editor_backend::actions::Input).to_value(),"output_schema":true,"recovery_schema":true,
            "examples":[{"reference":example}],"required_scopes":scopes,"effects":[],"cancellation":"unsupported"}));
    }
    let required = manifest["requires"].as_array_mut().unwrap();
    if !required
        .iter()
        .any(|r| r["capability"]["id"] == "editor.run.inspect")
    {
        required.push(json!({"capability":{"id":"editor.run.inspect","version":1},"scopes":["documents.read","operation.read"]}));
    }
    manifest["contexts"] = json!([{"id":"documents","title":"Editor documents","search":{"id":"editor.context.search","version":1},"preview":{"id":"editor.context.preview","version":1}}]);
    manifest["backend"] = json!({"executable":"dist/rho-editor-backend","arguments":[]});
    let manifest: PluginManifest = serde_json::from_value(manifest)?;
    manifest.validate()?;
    std::fs::write(destination, serde_json::to_string_pretty(&manifest)? + "\n")?;
    Ok(())
}
