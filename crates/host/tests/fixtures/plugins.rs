use rho_plugin_protocol::PluginArchive;
use rho_plugins::{backend_target, snapshot_directory};
use serde_json::json;
use std::{fs, path::Path};

/// This is built outside the checkout. Its executable imports no Rho code and
/// knows only the public framed protocol and the manifest's declared Host ports.
pub fn package(path: &Path, version: &str, collision: bool) -> PluginArchive {
    fs::create_dir_all(path.join("dist")).unwrap();
    let code = include_str!("../../../plugins/tests/fixtures/backend.py")
        .replace("\"host.echo\"", "\"plugins.list\"")
        .replace(
            "else \"plugins.list\"",
            "else \"plugins.branch\" if action == \"delegate_branch\" else \"plugins.list\"",
        )
        .replace(
            "\"arguments\": args})",
            "\"arguments\": args.get(\"host_arguments\", {})})",
        )
        .replace(
            "elif action in (\"commit\", \"badfact\", \"evidence\"):",
            r#"elif action == "delegate_operation":
            host_request = "backend-" + request
            reverse[host_request] = (request, data)
            send(host_request, "host_call", {"parent_request":request,
                "capability":{"id":"plugins.branch","version":1},
                "arguments":data["arguments"]["host_arguments"]})
        elif action in ("commit", "badfact", "evidence"):"#,
        )
        .replace(
            "query_result(original, {\"delegated\": data})",
            r#"if isinstance(original, tuple):
            original_request, original_call = original
            original_call["arguments"]["delegated"] = data
            commit(original_request, call=original_call)
        else:
            query_result(original, {"delegated": data})"#,
        );
    fs::write(path.join("backend.py"), &code).unwrap();
    fs::write(path.join("dist/backend"), code).unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path.join("dist/backend"), fs::Permissions::from_mode(0o755)).unwrap();
    }
    fs::write(
        path.join("BUILD.md"),
        "Copy backend.py to dist/backend and set executable permission.",
    )
    .unwrap();
    fs::write(path.join("deps.lock"), "Python 3 standard library.").unwrap();
    let capability = |id, kind, scope, effects, cancellation| {
        json!({
            "capability":{"id":id,"version":1},"kind":kind,"title":id,"description":"External Host fixture",
            "input_schema":{"type":"object"},"examples":[{}],"output_schema":{"type":"object"},"recovery_schema":true,
            "required_scopes":[scope],"effects":effects,"cancellation":cancellation
        })
    };
    let mut control = capability("fixture.answer", "control", "plugins.run", json!(["fixture.input"]), "unsupported");
    control["capability"]["version"] = json!(2);
    control["input_schema"] = json!({"type":"object","properties":{"value":{"type":"string","maxLength":65536},"action":{"type":"string"}},"required":["value"],"additionalProperties":false});
    control["examples"] = json!([{"value":"example"}]);
    control["output_schema"] = json!({"type":"object","properties":{"submitted":{"type":"boolean"}},"required":["submitted"],"additionalProperties":false});
    fs::write(path.join("plugin.json"), serde_json::to_vec(&json!({
        "protocol_version":1,"id":"example.host","name":"External Host fixture","version":version,
        "description":"Public plugin protocol fixture","license":"MIT",
        "source":{"files":["backend.py"],"lockfiles":["deps.lock"],"build_instructions":"BUILD.md","build":null},
        "dependencies":{},"requires":[
            {"capability":{"id":"plugins.list","version":1},"scopes":["plugins.read"]},
            {"capability":{"id":"plugins.branch","version":1},"scopes":["plugins.write"]}],
        "views":[],"contexts":[],"backend":{"executable":"dist/backend","arguments":[]},
        "capabilities":[capability(if collision {"plugins.list"}else{"fixture.read"},"query","plugins.read",json!([]),"unsupported"),
            capability("fixture.run","operation","plugins.run",json!(["fixture.write"]),"request"), control],
        "configuration_schema":{"type":"object"},"default_configuration":{}
    })).unwrap()).unwrap();
    snapshot_directory(path, None, &backend_target()).unwrap()
}
