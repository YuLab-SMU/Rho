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
    manifest["contexts"] = json!([{"id":"documents","title":"Editor documents","search":{"id":"editor.context.search","version":1},"preview":{"id":"editor.context.preview","version":1}}]);
    manifest["backend"] = json!({"executable":"dist/rho-editor-backend","arguments":[]});
    let manifest: PluginManifest = serde_json::from_value(manifest)?;
    manifest.validate()?;
    std::fs::write(destination, serde_json::to_string_pretty(&manifest)? + "\n")?;
    Ok(())
}
