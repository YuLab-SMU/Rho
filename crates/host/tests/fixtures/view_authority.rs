use super::*;

#[tokio::test]
async fn own_backend_retains_selected_authority_without_lending_it_to_foreign_providers() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("project");
    fs::create_dir(&root).unwrap();
    let db = temp.path().join("state.sqlite");
    let source = temp.path().join("package");
    package(&source);
    let manifest_path = source.join("plugin.json");
    let mut manifest: Value = serde_json::from_slice(&fs::read(&manifest_path).unwrap()).unwrap();
    // Only the selected optional grant supplies documents.read to this view.
    manifest["requires"] = json!([
        {"capability":{"id":"fixture.origin","version":1},"scopes":["plugins.read"]}
    ]);
    manifest["optional_requires"] = json!([
        {"capability":{"id":"documents.list","version":1},"scopes":["documents.read"]},
        {"capability":{"id":"fixture.run","version":1},"scopes":["documents.read"]}
    ]);
    fs::write(&manifest_path, serde_json::to_vec(&manifest).unwrap()).unwrap();
    let archive = snapshot_directory(&source, None, &backend_target()).unwrap();
    PluginRepository::open(&repository_path(&db))
        .unwrap()
        .import(&archive)
        .unwrap();
    let host = NextHost::open_plugin_workspace(&db, &root).await.unwrap();
    let context = NextHost::local_context();
    let mut identities = Vec::new();
    for (alias, selected) in [("selected", true), ("unselected", false)] {
        let optional = if selected {
            json!([{"id":"documents.list","version":1},{"id":"fixture.run","version":1}])
        } else {
            json!([])
        };
        let instance = invoke(&host, &context, alias, "plugins.activate", json!({
            "revision":archive.revision.id,"artifact":archive.artifacts[0].id,"target":backend_target(),
            "alias":alias,"configuration":{},"optional_capabilities":optional
        })).await["instance"]["identity"].clone();
        identities.push(instance);
    }
    for (index, instance) in identities.iter().enumerate() {
        let view = invoke(&host, &context, &format!("open-{index}"), "views.open", json!({
            "instance":instance,"contribution":"view","window":"window-a","configuration":{},"state":{}
        })).await;
        let mut channel = Channel {
            connection: serde_json::from_value(
                query(
                    &host,
                    &context,
                    "views.connection",
                    json!({"view":view["view"]}),
                )
                .await,
            )
            .unwrap(),
            sequence: 0,
        };
        let binding = query(
            &host,
            &context,
            "plugins.resolve",
            json!({
                "instance":instance,"capability":{"id":"fixture.origin","version":1}
            }),
        )
        .await;
        let scopes = channel
            .call(
                &host,
                &context,
                "query",
                "fixture.origin",
                json!({
                    "binding":binding,"arguments":{"action":"scope_snapshot"}
                }),
            )
            .await
            .unwrap()["data"]["scopes"]
            .clone();
        assert_eq!(
            scopes,
            if index == 0 {
                json!(["documents.read", "plugins.read"])
            } else {
                json!(["plugins.read"])
            }
        );
        let delegated = channel
            .call(
                &host,
                &context,
                "query",
                "fixture.origin",
                json!({
                    "binding":binding,"arguments":{"host_arguments":listing("window-a")}
                }),
            )
            .await
            .unwrap();
        if index == 0 {
            allowed(&delegated["data"], 0);
            let mutation_binding = query(
                &host,
                &context,
                "plugins.resolve",
                json!({
                    "instance":instance,"capability":{"id":"fixture.run","version":1}
                }),
            )
            .await;
            let mutation = channel.call(&host, &context, "query", "fixture.origin", json!({
                "binding":binding,"arguments":{"capability":{"id":"fixture.run","version":1},
                    "host_arguments":{"binding":mutation_binding,"arguments":{}}}
            })).await.unwrap();
            assert_eq!(
                mutation["data"]["delegated"]["type"], "error",
                "an own-backend Query cannot borrow an Operation grant to mutate"
            );
        } else {
            assert_eq!(delegated["data"]["delegated"]["type"], "error");
        }
        let mut narrowed = context.clone();
        narrowed.scopes.remove("documents.read");
        let narrowed_result = channel
            .call(
                &host,
                &narrowed,
                "query",
                "fixture.origin",
                json!({
                    "binding":binding,"arguments":{"action":"scope_snapshot"}
                }),
            )
            .await
            .unwrap();
        assert_eq!(narrowed_result["data"]["scopes"], json!(["plugins.read"]));
        let foreign = query(
            &host,
            &context,
            "plugins.resolve",
            json!({
                "instance":identities[1-index],"capability":{"id":"fixture.origin","version":1}
            }),
        )
        .await;
        let foreign_result = channel
            .call(
                &host,
                &context,
                "query",
                "fixture.origin",
                json!({
                    "binding":foreign,"arguments":{"action":"scope_snapshot"}
                }),
            )
            .await
            .unwrap();
        assert_eq!(foreign_result["data"]["scopes"], json!(["plugins.read"]));
        invoke(
            &host,
            &context,
            &format!("close-{index}"),
            "views.close",
            json!({
                "view":view["view"],"mode":{"kind":"retain_acknowledged","expected_version":0}
            }),
        )
        .await;
    }
    host.drain().await;
}
