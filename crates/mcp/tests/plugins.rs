#[path = "../../host/tests/fixtures/plugins.rs"]
mod fixture;
use rho_contract::{CapabilityRef, Invocation};
use rho_host::NextHost;
use rho_mcp::McpEdge;
use rho_plugins::{PluginRepository, backend_target, repository_path};
use rmcp::{
    ClientHandler, RoleClient, ServiceExt,
    model::{CallToolRequestParams, PaginatedRequestParams},
    service::NotificationContext,
};
use serde_json::{Value, json};
use std::{fs, sync::Arc, time::Duration};
use tokio::sync::Notify;
struct Client(Arc<Notify>);
impl ClientHandler for Client {
    async fn on_tool_list_changed(&self, _: NotificationContext<RoleClient>) {
        self.0.notify_one();
    }
}
#[tokio::test]
async fn existing_mcp_connection_tracks_plugin_publications_and_invalidates_old_page_cursors() {
    let temp = tempfile::tempdir().unwrap();
    let project = temp.path().join("project");
    fs::create_dir(&project).unwrap();
    let db = temp.path().join("state.sqlite");
    let archive = fixture::package(&temp.path().join("outside-checkout"), "1", false);
    let mut repo = PluginRepository::open(&repository_path(&db)).unwrap();
    repo.import(&archive).unwrap();
    let host = Arc::new(NextHost::open_project(&db, &project).await.unwrap());
    let edge = McpEdge::local(host.clone()).unwrap();
    let (server_io, client_io) = tokio::io::duplex(128 * 1024);
    let server = tokio::spawn(async move { edge.serve(server_io).await.unwrap().waiting().await });
    let changed = Arc::new(Notify::new());
    let client = Client(changed.clone()).serve(client_io).await.unwrap();
    let page = client.list_tools(None).await.unwrap();
    assert!(
        !client
            .list_all_tools()
            .await
            .unwrap()
            .iter()
            .any(|t| t.name == "rho.fixture.read.v1")
    );
    let reply=client.call_tool(CallToolRequestParams::new("rho.plugins.activate.v1").with_arguments(json!({
        "client_request_id":"mcp-activate","arguments":{"revision":archive.revision.id,"artifact":archive.artifacts[0].id,
            "target":backend_target(),"alias":"mcp","configuration":{}}
    }).as_object().unwrap().clone())).await.unwrap();
    assert_ne!(reply.is_error, Some(true), "{reply:?}");
    let record = &reply.structured_content.unwrap()["result"];
    assert_eq!(record["status"], "succeeded", "{record}");
    let identity = record["output"]["instance"]["identity"].clone();
    tokio::time::timeout(Duration::from_secs(10), changed.notified())
        .await
        .unwrap();
    let tools = client.list_all_tools().await.unwrap();
    assert!(tools.iter().any(|t| t.name == "rho.fixture.read.v1"));
    if let Some(cursor) = page.next_cursor {
        assert!(
            client
                .list_tools(Some(
                    PaginatedRequestParams::default().with_cursor(Some(cursor))
                ))
                .await
                .is_err()
        );
    }
    let result = client
        .call_tool(
            CallToolRequestParams::new("rho.plugins.resolve.v1").with_arguments(
                json!({"capability":{"id":"fixture.read","version":1},"instance":identity})
                    .as_object()
                    .unwrap()
                    .clone(),
            ),
        )
        .await
        .unwrap();
    let binding = result.structured_content.unwrap()["result"]["data"].clone();
    let result = client
        .call_tool(
            CallToolRequestParams::new("rho.fixture.read.v1").with_arguments(
                json!({"binding":binding,"arguments":{"message":"public MCP"},"preconditions":{}})
                    .as_object()
                    .unwrap()
                    .clone(),
            ),
        )
        .await
        .unwrap();
    assert_eq!(
        result.structured_content.unwrap()["result"]["data"]["arguments"]["message"],
        "public MCP"
    );
    // The MCP connection sees publication changes made through another official
    // edge as well; it cannot keep a private, stale second capability registry.
    let result = host
        .invoke(
            &NextHost::local_context(),
            Invocation {
                client_request_id: "host-release".into(),
                capability: CapabilityRef::new("plugins.release", 1).unwrap(),
                arguments: json!({"instance":identity}),
                preconditions: vec![],
            },
        )
        .await
        .unwrap();
    assert_eq!(
        serde_json::to_value(result.status).unwrap(),
        Value::String("succeeded".into())
    );
    tokio::time::timeout(Duration::from_secs(10), changed.notified())
        .await
        .unwrap();
    assert!(
        !client
            .list_all_tools()
            .await
            .unwrap()
            .iter()
            .any(|t| t.name == "rho.fixture.read.v1")
    );
    let restarted=host.invoke(&NextHost::local_context(),Invocation {client_request_id:"restart-for-fault-test".into(),capability:CapabilityRef::new("plugins.activate",1).unwrap(),arguments:json!({"revision":archive.revision.id,"artifact":archive.artifacts[0].id,"target":backend_target(),"alias":"fault","configuration":{}}),preconditions:vec![]}).await.unwrap();
    assert_eq!(restarted.status, rho_contract::OperationStatus::Succeeded);
    tokio::time::timeout(Duration::from_secs(10), changed.notified())
        .await
        .unwrap();
    let instance = &restarted.output.as_ref().unwrap()["instance"]["identity"];
    let binding=host.query_snapshot(&NextHost::local_context(),rho_contract::QueryRequest {capability:CapabilityRef::new("plugins.resolve",1).unwrap(),arguments:json!({"capability":{"id":"fixture.run","version":1},"instance":instance})}).await.unwrap().data.unwrap();
    let crashed=host.invoke(&NextHost::local_context(),Invocation {client_request_id:"native-fault".into(),capability:CapabilityRef::new("fixture.run",1).unwrap(),arguments:json!({"binding":binding,"arguments":{"action":"crash","marker":temp.path().join("native-effects")},"preconditions":{}}),preconditions:vec![]}).await.unwrap();
    assert_eq!(crashed.status, rho_contract::OperationStatus::Uncertain);
    // No catalog read triggers withdrawal: the process owner's lifecycle event
    // itself publishes the change and wakes the already-connected MCP client.
    tokio::time::timeout(Duration::from_secs(10), changed.notified())
        .await
        .unwrap();
    assert!(
        !client
            .list_all_tools()
            .await
            .unwrap()
            .iter()
            .any(|t| t.name == "rho.fixture.run.v1")
    );
    assert_eq!(
        fs::read_to_string(temp.path().join("native-effects")).unwrap(),
        "executed\n"
    );
    client.cancel().await.unwrap();
    server.await.unwrap().unwrap();
    host.drain().await;
}
