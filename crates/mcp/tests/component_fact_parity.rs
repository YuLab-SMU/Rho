//! A03: actual R facts read through the component port, Host and MCP wire.
use axum::{Json, Router, routing::post};
use rho_contract::*;
use rho_host::{ApplicationStore, ArkConfig, ComponentAgentService, NextHost};
use rho_mcp::McpEdge;
use rmcp::{ServiceExt, model::CallToolRequestParams};
use serde_json::{Value, json};
use std::{path::PathBuf, sync::Arc, time::Duration};

fn chunk(delta: Value, finish: Value) -> String {
    format!(
        "data: {}\n\n",
        json!({"id":"parity","object":"chat.completion.chunk","created":1,
        "model":"fixture","choices":[{"index":0,"delta":delta,"finish_reason":finish}]})
    )
}

async fn completion(Json(body): Json<Value>) -> ([(&'static str, &'static str); 1], String) {
    let results = body["messages"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|message| message["role"] == "tool")
        .collect::<Vec<_>>();
    let mut text = chunk(json!({"role":"assistant"}), Value::Null);
    if results.len() < 2 {
        let (name, arguments) = if results.is_empty() {
            (
                "workspace_run_r",
                json!({"code":"edge_counter <- edge_counter + 1L; edge_counter"}),
            )
        } else {
            let native: Value =
                serde_json::from_str(results[0]["content"].as_str().unwrap()).unwrap();
            (
                "operation_get",
                json!({"operation_id":native["operation"]["operation_id"].as_str().unwrap()}),
            )
        };
        text.push_str(&chunk(
            json!({"tool_calls":[{"index":0,"id":format!("call-{}",results.len()),
            "type":"function","function":{"name":name,"arguments":arguments.to_string()}}]}),
            Value::Null,
        ));
        text.push_str(&chunk(json!({}), json!("tool_calls")));
    } else {
        assert_eq!(results.len(), 2);
        text.push_str(&chunk(
            json!({"content":"The original operation was verified."}),
            Value::Null,
        ));
        text.push_str(&chunk(json!({}), json!("stop")));
    }
    text.push_str("data: [DONE]\n\n");
    ([("content-type", "text/event-stream")], text)
}

fn without_observation_time(mut value: Value) -> Value {
    // Read observations occur at different times. No other field is discarded.
    assert!(
        value
            .as_object_mut()
            .unwrap()
            .remove("observed_at_ms")
            .is_some()
    );
    value
}

#[tokio::test]
#[ignore = "requires real Ark/R; isolated project, no model service"]
async fn component_host_and_mcp_preserve_the_same_native_operation_and_observation() {
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path().canonicalize().unwrap();
    let project = root.to_string_lossy().into_owned();
    let host = Arc::new(
        NextHost::open_ark(
            &root.join("journal.sqlite"),
            ArkConfig {
                executable: PathBuf::from(std::env::var_os("RHO_ARK").expect("RHO_ARK")),
                r_home: PathBuf::from(std::env::var_os("RHO_R_HOME").expect("RHO_R_HOME")),
                project_root: root.clone(),
                data_root: root.join("runtime"),
                execution_timeout: Duration::from_secs(30),
                library_path: None,
                checkpoint_helper_path: None,
            },
        )
        .await
        .unwrap(),
    );
    let mut context = NextHost::local_context();
    context.connection_id = "studio:fact-parity".into();
    let setup = host.invoke(&context, Invocation {
        client_request_id: "initialize-counter".into(),
        capability: CapabilityRef::new("workspace.run_r", 1).unwrap(),
        arguments: json!({"workspace_instance_id":"main","code":"edge_counter <- 0L; invisible(NULL)"}),
        preconditions: vec![],
    }).await.unwrap();
    assert_eq!(setup.status, OperationStatus::Succeeded);
    let session_id = setup.output.unwrap()["session_id"]
        .as_str()
        .unwrap()
        .to_owned();
    let initial = host
        .query_snapshot(
            &context,
            QueryRequest {
                capability: CapabilityRef::new("operation.list_recent", 1).unwrap(),
                arguments: json!({"limit":32}),
            },
        )
        .await
        .unwrap()
        .data
        .unwrap();
    let registered = host
        .dispatch(
            &context,
            HostRequest::ApplicationBridge(ApplicationBridgeRequest::Register {
                window_id: "parity-window".into(),
                incarnation: "parity-incarnation".into(),
                label: "Fact parity test".into(),
                previous_session: None,
            }),
        )
        .await
        .unwrap();
    let ApplicationBridgeReply::Registered(registration) =
        serde_json::from_value(registered).unwrap()
    else {
        panic!("Window registration missing")
    };
    let window = registration.session.window.clone();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base_url = format!("http://{}/v1", listener.local_addr().unwrap());
    let provider = tokio::spawn(async move {
        axum::serve(
            listener,
            Router::new().route("/v1/chat/completions", post(completion)),
        )
        .await
        .unwrap();
    });
    let service = ComponentAgentService::new(Arc::new(
        ApplicationStore::open(&root.join("components.sqlite")).unwrap(),
    ));
    let credential = service
        .put_session_key(&host, &context, &project, &window, "fixture-only".into())
        .unwrap();
    service
        .configure(
            &host,
            &context,
            &project,
            &window,
            &ComponentModelSettings {
                version: 0,
                enabled: true,
                connection: Some(ComponentModelConnection {
                    protocol: ComponentModelProtocol::OpenaiCompletions,
                    base_url,
                    model: "fixture".into(),
                    credential,
                }),
            },
        )
        .await
        .unwrap();
    let conversation = service
        .create(
            &host,
            &context,
            &project,
            &window,
            "parity",
            ComponentAgentProfile::Workspace,
        )
        .unwrap();
    let run = service
        .start(
            host.clone(),
            context.clone(),
            &project,
            ComponentAgentStart {
                continuation: None,
                request_id: "execute-once".into(),
                conversation_id: conversation.conversation_id,
                conversation_version: conversation.version,
                window,
                model_settings_version: 1,
                text: "Increment the fixture counter once and read the original operation.".into(),
                grant: ComponentAgentGrant {
                    mode: ComponentAgentMode::Run,
                    session: Some(ComponentAgentSession {
                        workspace_instance_id: "main".into(),
                        session_id,
                    }),
                    documents: vec![],
                    files: vec![],
                },
                sources: vec![],
            },
        )
        .await
        .unwrap();
    let terminal = tokio::time::timeout(Duration::from_secs(30), async {
        loop {
            host.dispatch(
                &context,
                HostRequest::ApplicationBridge(ApplicationBridgeRequest::Renew {
                    session: registration.session.clone(),
                }),
            )
            .await
            .unwrap();
            let observed = service.run(&host, &context, &project, &run.run_id).unwrap();
            if observed.state.is_terminal() {
                break observed;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    })
    .await
    .unwrap();
    assert_eq!(
        terminal.state,
        ComponentAgentRunState::Completed,
        "{:?}",
        terminal.reason
    );
    let receipts = service
        .tools(&host, &context, &project, &run.run_id)
        .unwrap();
    assert_eq!(receipts.len(), 2);
    let write = receipts.iter().find(|tool| tool.mutation).unwrap();
    let read = receipts.iter().find(|tool| !tool.mutation).unwrap();
    let id = write.operation_id.as_ref().unwrap();
    let direct = host.get_operation(&context, id).await.unwrap().unwrap();
    assert_eq!(direct.status, OperationStatus::Succeeded);
    assert_eq!(direct.output.as_ref().unwrap()["value"], 1);
    assert_eq!(
        write.result.as_ref().unwrap(),
        &serde_json::to_value(&direct).unwrap()
    );
    let query = host
        .query_snapshot(
            &context,
            QueryRequest {
                capability: CapabilityRef::new("operation.get", 1).unwrap(),
                arguments: json!({"operation_id":id}),
            },
        )
        .await
        .unwrap();
    let component_observation = without_observation_time(read.result.clone().unwrap());
    assert_eq!(
        component_observation,
        without_observation_time(serde_json::to_value(query).unwrap())
    );

    assert_eq!(terminal.model_calls, 3);
    assert_eq!(terminal.tool_calls, 2);
    let recent = host
        .query_snapshot(
            &context,
            QueryRequest {
                capability: CapabilityRef::new("operation.list_recent", 1).unwrap(),
                arguments: json!({"limit":32}),
            },
        )
        .await
        .unwrap();
    let recent = recent.data.unwrap();
    let initial_ids = initial["operations"]
        .as_array()
        .unwrap()
        .iter()
        .map(|operation| operation["operation_id"].clone())
        .collect::<Vec<_>>();
    let recent_ids = recent["operations"]
        .as_array()
        .unwrap()
        .iter()
        .map(|operation| operation["operation_id"].clone())
        .collect::<Vec<_>>();
    assert!(initial_ids.iter().all(|id| recent_ids.contains(id)));
    assert_eq!(recent_ids.len(), initial_ids.len() + 1);
    assert_eq!(
        recent_ids
            .iter()
            .filter(|id| !initial_ids.contains(id))
            .cloned()
            .collect::<Vec<_>>(),
        vec![serde_json::to_value(id).unwrap()]
    );
    let before = host.outbox(&context, 0, 100).await.unwrap();
    let edge = McpEdge::new(host.clone(), context.clone()).unwrap();
    let (server_io, client_io) = tokio::io::duplex(64 * 1024);
    let server = tokio::spawn(async move { edge.serve(server_io).await.unwrap().waiting().await });
    let client = ().serve(client_io).await.unwrap();
    for name in ["rho.operation.get", "rho.operation.get.v1"] {
        let response = client
            .call_tool(
                CallToolRequestParams::new(name)
                    .with_arguments(json!({"operation_id":id}).as_object().unwrap().clone()),
            )
            .await
            .unwrap();
        assert_ne!(response.is_error, Some(true));
        let value = response.structured_content.unwrap()["result"].clone();
        if name == "rho.operation.get" {
            assert_eq!(value, serde_json::to_value(&direct).unwrap());
        } else {
            assert_eq!(without_observation_time(value), component_observation);
        }
    }
    assert_eq!(
        host.outbox(&context, 0, 100).await.unwrap(),
        before,
        "Reading through either edge must not append scientific events"
    );
    assert_eq!(
        host.get_operation(&context, id).await.unwrap().unwrap(),
        direct
    );
    client.cancel().await.unwrap();
    server.await.unwrap().unwrap();
    service.close().await;
    provider.abort();
}
