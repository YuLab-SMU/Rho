use super::*;
use rho_plugin_protocol::{PluginViewConnection, PluginViewMessage};

struct Channel {
    connection: PluginViewConnection,
    sequence: u32,
}
impl Channel {
    async fn send(
        &mut self,
        host: &NextHost,
        context: &CallContext,
        body: Value,
    ) -> Result<Value, OperationError> {
        self.sequence += 1;
        let message: PluginViewMessage = serde_json::from_value(json!({"protocol_version":1,
            "connection":self.connection.connection,"view":self.connection.view.view,
            "sequence":self.sequence,"request":format!("download-{}",self.sequence),"body":body}))
        .unwrap();
        host.dispatch_plugin_view(
            context,
            self.connection.view.window.as_str(),
            &self.connection.call_token,
            message,
        )
        .await
    }
}

#[tokio::test]
async fn original_download_requires_declared_read_scope_exact_resource_and_live_view_without_claiming_a_file()
 {
    let temp = tempfile::tempdir().unwrap();
    let project = temp.path().join("project");
    fs::create_dir(&project).unwrap();
    let db = temp.path().join("state.sqlite");
    let native = fixture::package(&temp.path().join("native"), "1", false);
    let denied = ui_package(&temp.path().join("denied"));
    let path = temp.path().join("allowed");
    ui_package(&path);
    let mut manifest: Value =
        serde_json::from_slice(&fs::read(path.join("plugin.json")).unwrap()).unwrap();
    manifest["requires"] =
        json!([{"capability":{"id":"resources.read","version":1},"scopes":["resources.read"]}]);
    fs::write(
        path.join("plugin.json"),
        serde_json::to_vec(&manifest).unwrap(),
    )
    .unwrap();
    let allowed = rho_plugins::snapshot_directory(&path, None, "ui-web").unwrap();
    let mut repository = PluginRepository::open(&repository_path(&db)).unwrap();
    for archive in [&native, &denied, &allowed] {
        repository.import(archive).unwrap();
    }
    let host = NextHost::open_plugin_workspace(&db, &project)
        .await
        .unwrap();
    let context = NextHost::local_context();
    let owner = observation(
        &run(
            &host,
            &context,
            "native",
            "plugins.activate",
            activation(&native, "native"),
        )
        .await,
    );
    let binding = query(
        &host,
        &context,
        "plugins.resolve",
        json!({"instance":owner.instance.identity,"capability":{"id":"fixture.read","version":1}}),
    )
    .await;
    let reference = query(
        &host,
        &context,
        "fixture.read",
        json!({"binding":binding,"arguments":{"action":"resource_put"}}),
    )
    .await["reference"]
        .clone();
    let body =
        json!({"type":"download_resource","reference":reference,"filename":"Original 中文.png"});
    let mut channels = Vec::new();
    for (name, archive) in [("denied", &denied), ("allowed", &allowed)] {
        let instance = observation(&run(&host, &context, name, "plugins.activate", json!({"revision":archive.revision.id,"artifact":archive.artifacts[0].id,"target":"ui-web","alias":name,"configuration":{}})).await);
        let opened = run(&host, &context, &format!("open-{name}"), "views.open", json!({"instance":instance.instance.identity,"contribution":"view","window":"download-window","configuration":{},"state":{"text":""}})).await.output.unwrap();
        let connection = serde_json::from_value(
            query(
                &host,
                &context,
                "views.connection",
                json!({"view":opened["view"]}),
            )
            .await,
        )
        .unwrap();
        channels.push(Channel {
            connection,
            sequence: 0,
        });
    }
    let mut allowed = channels.pop().unwrap();
    let mut denied = channels.pop().unwrap();
    let before = query(
        &host,
        &context,
        "operation.list_recent",
        json!({"limit":100}),
    )
    .await;
    assert!(
        denied.send(&host, &context, body.clone()).await.is_err(),
        "parent authority cannot grant an undeclared resource read"
    );
    for scope in ["resources.read", "plugins.run"] {
        let mut revoked = context.clone();
        revoked.scopes.remove(scope);
        assert!(
            allowed.send(&host, &revoked, body.clone()).await.is_err(),
            "revoked {scope}"
        );
    }
    for filename in [
        "",
        "../plot.png",
        "a\\b.png",
        "a:b",
        "bad\nname",
        " leading.png",
        ".",
        "..",
    ] {
        let mut bad = body.clone();
        bad["filename"] = json!(filename);
        assert!(
            allowed.send(&host, &context, bad).await.is_err(),
            "bad filename {filename:?}"
        );
    }
    for (field, value) in [
        ("bytes", json!(16 * 1024 * 1024 + 1)),
        ("resource", json!("foreign")),
        ("digest", json!(format!("sha256:{}", "0".repeat(64)))),
    ] {
        let mut bad = body.clone();
        bad["reference"][field] = value;
        assert!(
            allowed.send(&host, &context, bad).await.is_err(),
            "changed {field}"
        );
    }
    assert_eq!(
        allowed.send(&host, &context, body.clone()).await.unwrap(),
        json!({"authorized_view":allowed.connection.view.view}),
        "admission is not a native file or download confirmation"
    );
    assert_eq!(
        query(
            &host,
            &context,
            "operation.list_recent",
            json!({"limit":100})
        )
        .await,
        before
    );
    let debug: rho_plugin_protocol::PluginViewRequest =
        serde_json::from_value(body.clone()).unwrap();
    assert!(!format!("{debug:?}").contains("Original"));
    assert!(!format!("{debug:?}").contains(reference["digest"].as_str().unwrap()));
    assert_eq!(
        run(
            &host,
            &context,
            "release-native",
            "plugins.release",
            json!({"instance":owner.instance.identity})
        )
        .await
        .status,
        OperationStatus::Succeeded
    );
    assert!(
        allowed.send(&host, &context, body.clone()).await.is_ok(),
        "retained originals do not restart their provider"
    );

    allowed
        .send(
            &host,
            &context,
            json!({"type":"register_close_handler","renderer":"document"}),
        )
        .await
        .unwrap();
    let close: OperationRecord = serde_json::from_value(
        host.dispatch(
            &context,
            HostRequest::Invoke(InvokeRequest {
                invocation: invocation(
                    "close",
                    "views.close",
                    json!({"view":allowed.connection.view.view}),
                ),
                return_after_acceptance: Some(true),
            }),
        )
        .await
        .unwrap(),
    )
    .unwrap();
    let operation = tokio::time::timeout(std::time::Duration::from_secs(5), async {
        loop {
            let observed = allowed
                .send(
                    &host,
                    &context,
                    json!({"type":"observe_lifecycle","renderer":"document"}),
                )
                .await
                .unwrap();
            if observed["close"]["phase"] == "requested" {
                break observed["close"]["operation"].clone();
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    let fenced = allowed
        .send(&host, &context, body.clone())
        .await
        .unwrap_err();
    assert!(fenced.to_string().contains("fenced"));
    allowed.send(&host, &context, json!({"type":"prepare_close","renderer":"document","operation":operation,"state_version":0})).await.unwrap();
    tokio::time::timeout(std::time::Duration::from_secs(5), async {
        loop {
            let state = host
                .get_operation(&context, &close.operation.operation_id)
                .await
                .unwrap()
                .unwrap();
            if state.status.is_terminal() {
                assert_eq!(state.status, OperationStatus::Succeeded);
                break;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    assert!(allowed.send(&host, &context, body).await.is_err());
    host.drain().await;
}
