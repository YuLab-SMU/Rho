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
            "sequence":self.sequence,"request":format!("message-{}",self.sequence),"body":body}))
        .unwrap();
        host.dispatch_plugin_view(
            context,
            self.connection.view.window.as_str(),
            &self.connection.call_token,
            message,
        )
        .await
    }
    async fn requested(
        &mut self,
        host: &NextHost,
        context: &CallContext,
        renderer: &str,
    ) -> String {
        tokio::time::timeout(std::time::Duration::from_secs(5), async {
            loop {
                let state = self
                    .send(
                        host,
                        context,
                        json!({"type":"observe_lifecycle","renderer":renderer}),
                    )
                    .await
                    .unwrap();
                if state["close"]["phase"] == "requested" {
                    break state["close"]["operation"].as_str().unwrap().to_owned();
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap()
    }
}
async fn accepted(
    host: &NextHost,
    context: &CallContext,
    id: &str,
    view: &Value,
) -> OperationRecord {
    serde_json::from_value(
        host.dispatch(
            context,
            HostRequest::Invoke(InvokeRequest {
                invocation: invocation(id, "views.close", json!({"view":view})),
                return_after_acceptance: Some(true),
            }),
        )
        .await
        .unwrap(),
    )
    .unwrap()
}
async fn settled(
    host: &NextHost,
    context: &CallContext,
    record: &OperationRecord,
) -> OperationRecord {
    tokio::time::timeout(std::time::Duration::from_secs(20), async {
        loop {
            let current = host
                .get_operation(context, &record.operation.operation_id)
                .await
                .unwrap()
                .unwrap();
            if current.status.is_terminal() {
                break current;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap()
}

#[tokio::test]
async fn flush_close_preserves_drafts_requires_each_document_and_commits_layout_atomically() {
    let temp = tempfile::tempdir().unwrap();
    let project = temp.path().join("project");
    fs::create_dir(&project).unwrap();
    let db = temp.path().join("state.sqlite");
    let archive = ui_package(&temp.path().join("ui"));
    let mut repository = PluginRepository::open(&repository_path(&db)).unwrap();
    repository.import(&archive).unwrap();
    let host = NextHost::open_plugin_workspace(&db, &project).await.unwrap();
    let context = NextHost::local_context();
    let instance = observation(
        &run(
            &host,
            &context,
            "activate",
            "plugins.activate",
            json!({"revision":archive.revision.id,
        "artifact":archive.artifacts[0].id,"target":"ui-web","alias":"flush","configuration":{}}),
        )
        .await,
    );
    let opened = run(&host, &context, "open", "windows.open_view", json!({"view":{"instance":instance.instance.identity,
        "contribution":"view","window":"flush-window","configuration":{},"state":{"text":"acknowledged"}},
        "expected_layout_version":0,"group":null})).await.output.unwrap();
    let view = opened["view"]["view"].clone();
    let connection = serde_json::from_value(
        query(&host, &context, "views.connection", json!({"view":view})).await,
    )
    .unwrap();
    let mut channel = Channel {
        connection,
        sequence: 0,
    };
    // A missing document cannot be treated as proof that its draft was saved.
    assert!(
        host.invoke(
            &context,
            invocation("missing-handler", "views.close", json!({"view":view}))
        )
        .await
        .is_err()
    );
    assert!(
        host.invoke(
            &context,
            invocation(
                "wrong-recovery-version",
                "views.close",
                json!({"view":view,
        "mode":{"kind":"retain_acknowledged","expected_version":8}})
            )
        )
        .await
        .is_err()
    );
    for renderer in ["first-document", "second-document"] {
        channel
            .send(
                &host,
                &context,
                json!({"type":"register_close_handler","renderer":renderer}),
            )
            .await
            .unwrap();
    }
    let mut revoked = context.clone();
    revoked.scopes.remove("plugins.run");
    assert!(
        channel
            .send(
                &host,
                &revoked,
                json!({"type":"observe_lifecycle","renderer":"first-document"})
            )
            .await
            .is_err()
    );
    let before = query(
        &host,
        &context,
        "windows.layout",
        json!({"window":"flush-window"}),
    )
    .await;
    let first = accepted(&host, &context, "flush-refused", &view).await;
    let operation = channel.requested(&host, &context, "first-document").await;
    assert_eq!(operation, first.operation.operation_id.as_str());
    // The original operation is returned on retry; no second handshake.
    assert_eq!(
        accepted(&host, &context, "flush-refused", &view)
            .await
            .operation
            .operation_id,
        first.operation.operation_id
    );
    for bad in [
        json!({"type":"register_close_handler","renderer":"late"}),
        json!({"type":"prepare_close","renderer":"unknown","operation":operation,"state_version":0}),
        json!({"type":"prepare_close","renderer":"first-document","operation":"another-operation","state_version":0}),
        json!({"type":"prepare_close","renderer":"first-document","operation":operation,"state_version":99}),
        json!({"type":"begin_text_copy"}),
        json!({"type":"cancel","operation_id":"accepted-science"}),
    ] {
        assert!(channel.send(&host, &context, bad).await.is_err());
    }
    let saved = channel
        .send(
            &host,
            &context,
            json!({"type":"set_state","expected_version":0,"state":{"text":"last 中文 draft"}}),
        )
        .await
        .unwrap();
    assert_eq!(saved["status"], "succeeded");
    channel.send(&host, &context, json!({"type":"prepare_close","renderer":"first-document","operation":operation,"state_version":1})).await.unwrap();
    assert!(
        !host
            .get_operation(&context, &first.operation.operation_id)
            .await
            .unwrap()
            .unwrap()
            .status
            .is_terminal()
    );
    channel.send(&host, &context, json!({"type":"refuse_close","renderer":"second-document","operation":operation,"reason":"draft save failed"})).await.unwrap();
    let failed = settled(&host, &context, &first).await;
    assert_eq!(failed.status, OperationStatus::Failed);
    assert!(failed.error.unwrap().contains("draft save failed"));
    assert_eq!(
        query(
            &host,
            &context,
            "windows.layout",
            json!({"window":"flush-window"})
        )
        .await,
        before
    );
    assert_eq!(
        channel
            .send(
                &host,
                &context,
                json!({"type":"observe_lifecycle","renderer":"first-document"})
            )
            .await
            .unwrap()["close"]["phase"],
        "open"
    );
    assert!(
        !query(&host, &context, "views.inspect", json!({"view":view})).await["closed"]
            .as_bool()
            .unwrap()
    );
    let timed = host
        .invoke(
            &context,
            invocation("unanswered-document", "views.close", json!({"view":view})),
        )
        .await
        .unwrap();
    assert_eq!(timed.status, OperationStatus::Failed);
    assert!(timed.error.unwrap().contains("deadline"));
    assert_eq!(
        channel
            .send(
                &host,
                &context,
                json!({"type":"observe_lifecycle","renderer":"first-document"})
            )
            .await
            .unwrap()["close"]["phase"],
        "open"
    );
    // Each document must acknowledge the same final state. A later save cannot
    // silently supersede another document's already acknowledged version.
    let racing = accepted(&host, &context, "flush-state-race", &view).await;
    let operation = channel.requested(&host, &context, "first-document").await;
    channel.send(&host, &context, json!({"type":"prepare_close","renderer":"first-document","operation":operation,"state_version":1})).await.unwrap();
    let saved = channel
        .send(
            &host,
            &context,
            json!({"type":"set_state","expected_version":1,"state":{"text":"last 中文 draft"}}),
        )
        .await
        .unwrap();
    assert_eq!(saved["status"], "succeeded");
    channel.send(&host, &context, json!({"type":"prepare_close","renderer":"second-document","operation":operation,"state_version":2})).await.unwrap();
    assert_eq!(
        settled(&host, &context, &racing).await.status,
        OperationStatus::Failed
    );
    // Force failure after marking the view closed. The one native transaction
    // must roll back closure, revision release and window removal together.
    let catalog =
        rusqlite::Connection::open(repository_path(&db).join("catalog-v1.sqlite3")).unwrap();
    catalog.execute_batch("CREATE TRIGGER reject_close_layout BEFORE INSERT ON plugin_window_layouts BEGIN SELECT RAISE(ABORT, 'close write failure'); END;").unwrap();
    for (request, succeeds) in [("flush-write-fails", false), ("flush-succeeds", true)] {
        let close = accepted(&host, &context, request, &view).await;
        let operation = channel.requested(&host, &context, "first-document").await;
        for renderer in ["first-document", "second-document"] {
            channel.send(&host, &context, json!({"type":"prepare_close","renderer":renderer,"operation":operation,"state_version":2})).await.unwrap();
        }
        let result = settled(&host, &context, &close).await;
        assert_eq!(
            result.status == OperationStatus::Succeeded,
            succeeds,
            "{:?}",
            result.error
        );
        let record = query(&host, &context, "views.inspect", json!({"view":view})).await;
        assert_eq!(record["closed"], succeeds);
        assert_eq!(record["state"]["text"], "last 中文 draft");
        assert_eq!(record["state_version"], 2);
        if !succeeds {
            assert_eq!(
                query(
                    &host,
                    &context,
                    "windows.layout",
                    json!({"window":"flush-window"})
                )
                .await,
                before
            );
            assert!(
                repository
                    .references(&archive.revision.id)
                    .unwrap()
                    .iter()
                    .any(|reference| reference.contains(view.as_str().unwrap()))
            );
            catalog
                .execute_batch("DROP TRIGGER reject_close_layout;")
                .unwrap();
        }
    }
    let layout = query(
        &host,
        &context,
        "windows.layout",
        json!({"window":"flush-window"}),
    )
    .await;
    assert_eq!(layout["version"], 2);
    assert_eq!(layout["layout"]["views"], json!([]));
    assert_eq!(layout["layout"]["selected"], Value::Null);
    assert!(
        channel
            .send(
                &host,
                &context,
                json!({"type":"observe_lifecycle","renderer":"first-document"})
            )
            .await
            .is_err()
    );
    assert!(
        !repository
            .references(&archive.revision.id)
            .unwrap()
            .iter()
            .any(|reference| reference.starts_with("view:")
                && reference.contains(view.as_str().unwrap()))
    );
    host.drain().await;
}
