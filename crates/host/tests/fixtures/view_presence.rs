use super::*;

#[tokio::test]
async fn view_presence_distinguishes_native_attachment_closure_and_unknown_identity() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("project");
    fs::create_dir(&root).unwrap();
    let db = temp.path().join("state.sqlite");
    let archive = package(&temp.path().join("package"));
    PluginRepository::open(&repository_path(&db))
        .unwrap()
        .import(&archive)
        .unwrap();
    let host = NextHost::open_plugin_workspace(&db, &root).await.unwrap();
    let context = NextHost::local_context();
    let instance=invoke(&host,&context,"activate-presence","plugins.activate",json!({"revision":archive.revision.id,"artifact":archive.artifacts[0].id,"target":backend_target(),"alias":"presence","configuration":{}})).await["instance"]["identity"].clone();
    let mut channels = vec![];
    for name in ["one", "two"] {
        let view=invoke(&host,&context,&format!("open-{name}"),"views.open",json!({"instance":instance,"contribution":"view","window":format!("window-{name}"),"configuration":{},"state":{"private_draft":"Do not expose content"}})).await;
        let connection = serde_json::from_value(
            query(
                &host,
                &context,
                "views.connection",
                json!({"view":view["view"]}),
            )
            .await,
        )
        .unwrap();
        channels.push(Channel {
            connection,
            sequence: 0,
        });
    }
    let mut second = channels.pop().unwrap();
    let mut first = channels.pop().unwrap();
    let view = first.connection.view.view.clone();
    let args = json!({"view":view});
    let attached =
        json!({"view":view,"window":"window-one","instance":instance,"state":"attached"});
    // No close handler is registered yet. Its absence says nothing about whether
    // the existing native connection can issue calls.
    assert_eq!(
        query(&host, &context, "views.presence", args.clone()).await,
        attached
    );
    let observed = second
        .call(&host, &context, "query", "views.presence", args.clone())
        .await
        .unwrap();
    assert_eq!(observed["data"], attached);
    for forbidden in [
        &first.connection.call_token,
        &first.connection.asset_token,
        "Do not expose content",
    ] {
        assert!(!observed.to_string().contains(forbidden));
    }
    let binding = query(
        &host,
        &context,
        "plugins.resolve",
        json!({"instance":instance,"capability":{"id":"fixture.origin","version":1}}),
    )
    .await;
    let delegated=second.call(&host,&context,"query","fixture.origin",json!({"binding":binding,"arguments":{"capability":{"id":"views.presence","version":1},"host_arguments":args}})).await.unwrap();
    assert_eq!(
        delegated["data"]["delegated"]["data"]["result"]["data"],
        attached
    );
    for args in [
        json!({"view":"absent"}),
        json!({"view":view,"principal":"forged"}),
        json!({"view":view,"window":"forged"}),
    ] {
        assert!(
            host.query_snapshot(
                &context,
                QueryRequest {
                    capability: CapabilityRef::new("views.presence", 1).unwrap(),
                    arguments: args
                }
            )
            .await
            .is_err()
        );
    }
    let mut weak = context.clone();
    weak.scopes.remove("plugins.read");
    assert!(
        second
            .call(&host, &weak, "query", "views.presence", args.clone())
            .await
            .is_err()
    );
    let mut foreign = context.clone();
    foreign.caller.id = "foreign-principal".into();
    assert!(
        host.query_snapshot(
            &foreign,
            QueryRequest {
                capability: CapabilityRef::new("views.presence", 1).unwrap(),
                arguments: args.clone()
            }
        )
        .await
        .is_err()
    );
    first
        .send(
            &host,
            &context,
            json!({"type":"register_close_handler","renderer":"first-document"}),
        )
        .await
        .unwrap();
    let accepted = host
        .dispatch(
            &context,
            HostRequest::Invoke(InvokeRequest {
                invocation: invocation("closing-presence", "views.close", args.clone()),
                return_after_acceptance: Some(true),
            }),
        )
        .await
        .unwrap();
    let operation = tokio::time::timeout(std::time::Duration::from_secs(5), async {
        loop {
            let status = first
                .send(
                    &host,
                    &context,
                    json!({"type":"observe_lifecycle","renderer":"first-document"}),
                )
                .await
                .unwrap();
            if status["close"]["phase"] == "requested" {
                break status["close"]["operation"].clone();
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    assert_eq!(
        query(&host, &context, "views.presence", args.clone()).await["state"],
        "closing"
    );
    first.send(&host,&context,json!({"type":"refuse_close","renderer":"first-document","operation":operation,"reason":"Keep the draft"})).await.unwrap();
    assert_eq!(
        settled(&host, &context, accepted).await.status,
        OperationStatus::Failed
    );
    assert_eq!(
        query(&host, &context, "views.presence", args.clone()).await["state"],
        "attached"
    );
    invoke(
        &host,
        &context,
        "close-presence",
        "views.close",
        json!({"view":view,"mode":{"kind":"retain_acknowledged","expected_version":0}}),
    )
    .await;
    assert_eq!(
        query(&host, &context, "views.presence", args.clone()).await["state"],
        "closed"
    );
    // A crashed backend revokes its native view authority without rewriting the
    // retained view into a successfully closed document.
    assert!(
        host.query_snapshot(
            &context,
            QueryRequest {
                capability: CapabilityRef::new("fixture.origin", 1).unwrap(),
                arguments: json!({"binding":binding,"arguments":{"action":"crash"}})
            }
        )
        .await
        .is_err()
    );
    let second_args = json!({"view":second.connection.view.view});
    tokio::time::timeout(std::time::Duration::from_secs(5), async {
        loop {
            if query(&host, &context, "views.presence", second_args.clone()).await["state"]
                == "detached"
            {
                break;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    assert_eq!(
        query(&host, &context, "views.inspect", second_args).await["closed"],
        false
    );
    host.drain().await;
}
