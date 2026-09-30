#![forbid(unsafe_code)]
mod connections;
pub use connections::McpConnections;
mod schema;
use rho_host::OperationError;
use schema::object;

use futures::StreamExt;
use rho_contract::{
    CallContext, CallerIdentity, CallerKind, CapabilityKind, CapabilityRef, HostRequest,
    Invocation, OperationGetArguments, PollOperationEventsArguments, Precondition, QueryRequest,
};
use rho_host::NextHost;
use rmcp::{
    ErrorData, RoleServer, ServerHandler, ServiceExt,
    model::{
        CallToolRequestParams, CallToolResult, ClientJsonRpcMessage, Content, Implementation,
        ListToolsResult, PaginatedRequestParams, ServerCapabilities, ServerInfo,
        ServerJsonRpcMessage, Tool, ToolAnnotations,
    },
    service::{NotificationContext, RequestContext},
    transport::async_rw::JsonRpcMessageCodec,
};
use schemars::schema_for;
use serde::Deserialize;
use serde_json::{Value, json};
use std::{collections::BTreeMap, sync::{Arc, OnceLock, Mutex}};
use tokio::{
    io::{AsyncRead, AsyncWrite},
    sync::Semaphore,
};
use tokio_util::codec::{FramedRead, FramedWrite};

const MAX_FRAME: usize = rho_contract::MAX_ARGUMENT_BYTES + 16 * 1024;
const MAX_REPLY: usize = 8 * 1024 * 1024;
const PAGE_SIZE: usize = 64;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct CommandArguments {
    client_request_id: String,
    arguments: Value,
    #[serde(default)]
    preconditions: Vec<Precondition>,
    #[serde(default)]
    return_after_acceptance: Option<bool>,
}

#[derive(Clone)]
enum Route {
    Capability(CapabilityRef, CapabilityKind),
    Get,
    Cancel,
    Events,
}
#[derive(Clone)]
struct Entry {
    tool: Tool,
    route: Route,
}
/// Injected by the authenticated HTTP edge, not deserialized from MCP arguments.
#[derive(Clone)]
pub struct McpRequestIdentity {
    pub project: String,
    pub identity: String,
    pub test_project: Option<rho_contract::TestProjectId>,
}
struct HttpBinding {
    identity: String,
    test_project: Option<rho_contract::TestProjectId>,
    host: Arc<NextHost>,
}
pub struct McpEdge {
    host: Arc<NextHost>,
    context: CallContext,
    connection: Option<connections::ConnectionObservation>,
    catalog: Mutex<CatalogCache>,
    notifications: tokio_util::sync::CancellationToken,
    notifications_started: OnceLock<()>,
    in_flight: Semaphore,
    observations: Semaphore,
    http_project: Option<String>,
    http_binding: OnceLock<HttpBinding>,
}
struct ToolCatalog { identity: String, entries: BTreeMap<String, Entry> }
struct CatalogCache {
    descriptors: Vec<rho_contract::CapabilityDescriptor>,
    catalog: Arc<ToolCatalog>,
}
impl CatalogCache {
    fn new(descriptors: Vec<rho_contract::CapabilityDescriptor>) -> Result<Self,String> {
        use sha2::{Digest,Sha256};
        let identity=format!("{:x}",Sha256::digest(serde_json::to_vec(&descriptors).map_err(|e|e.to_string())?));
        let entries=build_entries(&descriptors)?;
        Ok(Self {descriptors,catalog:Arc::new(ToolCatalog{identity,entries})})
    }
}
impl Drop for McpEdge {
    fn drop(&mut self) { self.notifications.cancel(); }
}
fn tool_name(capability: &CapabilityRef) -> String {
    let readable=format!("rho.{}.v{}",capability.id,capability.version);
    if readable.len()<=128 && readable.bytes().all(|c| c.is_ascii_alphanumeric() || b"_-.".contains(&c)) { return readable; }
    // Keep every valid Host identity representable without allowing one package
    // to make the whole MCP catalog unavailable. Separate prefix prevents a
    // collision with the readable namespace; version participates in the hash.
    use sha2::{Digest,Sha256};
    format!("rho_h_{:x}",Sha256::digest(capability.display_key().as_bytes()))
}
fn build_entries(capabilities: &[rho_contract::CapabilityDescriptor]) -> Result<BTreeMap<String,Entry>,String> {
        let mut entries = BTreeMap::new();
        for capability in capabilities {
            let name = tool_name(&capability.capability);
            let (tool, route) = {
                let query = capability.kind == CapabilityKind::Query;
                let control = capability.kind == CapabilityKind::Control;
                let input = if query || control {
                    capability.input_schema.clone()
                } else {
                    command_schema(capability.input_schema.clone())?
                };
                let output = if query {
                    rho_contract::query_result_schema(capability.output_schema.clone())
                } else if control {
                    capability.output_schema.clone()
                } else {
                    rho_contract::operation_result_schema(
                        capability.output_schema.clone(),
                        capability.recovery_schema.clone(),
                    )
                };
                let tool = Tool::new(
                    name.clone(),
                    capability_description(capability),
                    object(input)?,
                )
                .with_raw_output_schema(Arc::new(object(result_schema(output))?))
                .with_annotations(ToolAnnotations::new().read_only(query)
                    .idempotent(capability.idempotency == rho_contract::IdempotencyClass::Pure));
                (
                    tool,
                    Route::Capability(capability.capability.clone(), capability.kind),
                )
            };
            if entries.insert(name, Entry { tool, route }).is_some() {
                return Err("MCP tool name collision".into());
            }
        }
        for (name, capability_id, route, projection) in [
            (
                "rho.operation.get",
                "operation.get",
                Route::Get,
                Some("record"),
            ),
            (
                "rho.operation.request_cancellation",
                "operation.request_cancellation",
                Route::Cancel,
                None,
            ),
            (
                "rho.events.poll",
                "operation.events",
                Route::Events,
                Some("events"),
            ),
        ] {
            let Some(capability) = capabilities
                .iter()
                .find(|descriptor| descriptor.capability.id == capability_id)
            else {
                continue;
            };
            let output = if let Some(field) = projection {
                rho_contract::project_payload_schema(&capability.output_schema, field)?
            } else {
                capability.output_schema.clone()
            };
            let mut description = capability_description(capability);
            if let Some(field) = projection {
                description.push_str(&format!("\nCompatibility projection: returns only {field} from the same Host-validated {} query. Use rho.{}.v{} for observation metadata and continuation.", capability_id, capability_id, capability.capability.version));
                if field == "events" {
                    description.push_str(" This array never asserts journal completeness; resume with the last returned sequence, including when fewer items than the requested limit are returned.");
                }
            }
            let tool = Tool::new(name, description, object(capability.input_schema.clone())?)
                .with_raw_output_schema(Arc::new(object(result_schema(output))?))
                .with_annotations(
                    ToolAnnotations::new().read_only(capability.kind == CapabilityKind::Query)
                        .idempotent(capability.idempotency == rho_contract::IdempotencyClass::Pure),
                );
            if entries.insert(name.into(), Entry { tool, route }).is_some() {
                return Err("MCP control tool name collision".into());
            }
        }
    Ok(entries)
}
impl McpEdge {
    pub fn new(host: Arc<NextHost>, context: CallContext) -> Result<Self, String> {
        context.validate().map_err(|error| error.to_string())?;
        let descriptors = host.capabilities_for(&context);
        let catalog = CatalogCache::new(descriptors)?;
        Ok(Self {
            host,
            context,
            connection: None,
            catalog: Mutex::new(catalog),
            notifications: tokio_util::sync::CancellationToken::new(),
            notifications_started: OnceLock::new(),
            in_flight: Semaphore::new(32),
            observations: Semaphore::new(16),
            http_project: None,
            http_binding: OnceLock::new(),
        })
    }
    fn catalog_for(&self, context: &CallContext) -> Result<Arc<ToolCatalog>, String> {
        let descriptors=self.active_host().capabilities_for(context);
        let mut cache=self.catalog.lock().unwrap();
        if cache.descriptors != descriptors { *cache=CatalogCache::new(descriptors)?; }
        Ok(cache.catalog.clone())
    }
    #[cfg(test)]
    fn entries(&self) -> Arc<ToolCatalog> {
        self.catalog_for(&self.context).expect("validated Host tool contracts")
    }
    pub fn local(host: Arc<NextHost>) -> Result<Self, String> {
        let mut context = NextHost::local_context();
        context.principal = Some(context.caller.clone());
        context.caller = CallerIdentity {
            kind: CallerKind::Agent,
            id: "local-mcp".into(),
        };
        context.connection_id = format!("mcp:{}", std::process::id());
        Self::new(host, context)
    }
    /// Observes transport activity without changing the caller or Host path.
    pub fn observe_connections(mut self, connections: &Arc<McpConnections>) -> Self {
        self.connection = Some(connections.observe());
        self
    }

    pub fn http_project(mut self, project: String) -> Self {
        self.http_project = Some(project);
        self
    }
    fn active_host(&self) -> &Arc<NextHost> {
        self.http_binding.get().map(|binding| &binding.host).unwrap_or(&self.host)
    }
    fn request_context(&self, request: &RequestContext<RoleServer>) -> Result<CallContext, ErrorData> {
        let Some(project) = &self.http_project else { return Ok(self.context.clone()); };
        let identity = request.extensions.get::<http::request::Parts>()
            .and_then(|parts| parts.extensions.get::<McpRequestIdentity>())
            .ok_or_else(|| ErrorData::invalid_request("MCP request has no trusted connection identity", None))?;
        if &identity.project != project {
            return Err(ErrorData::invalid_request("MCP connection identity changed", None));
        }
        let context = self.context.clone();
        // Selection is fixed by authenticated transport metadata, never by tool
        // arguments. Keep the child leased until this MCP connection ends.
        let selected = match &identity.test_project {
            Some(id) => self.host.plugin_test_host(&context, id)
                .map_err(|error|ErrorData::invalid_request(error.to_string(),None))?,
            None => self.host.clone(),
        };
        let binding = self.http_binding.get_or_init(||HttpBinding {
            identity:identity.identity.clone(),test_project:identity.test_project.clone(),host:selected,
        });
        if binding.identity != identity.identity || binding.test_project != identity.test_project {
            return Err(ErrorData::invalid_request("MCP connection project selection changed",None));
        }
        Ok(context)
    }

    fn observe_request(&self) {
        if let Some(connection) = &self.connection {
            connection.request();
        }
    }
    async fn route_with_context(&self, context: &CallContext, route: &Route, args: Value) -> Result<Value, OperationError> {
        let request = match route {
            Route::Capability(capability, CapabilityKind::Operation) => {
                let input: CommandArguments =
                    serde_json::from_value(args).map_err(invalid_operation)?;
                HostRequest::Invoke(rho_contract::InvokeRequest {
                    return_after_acceptance: Some(
                        input
                            .return_after_acceptance
                            .unwrap_or(false),
                    ),
                    invocation: Invocation {
                        client_request_id: input.client_request_id,
                        capability: capability.clone(),
                        arguments: input.arguments,
                        preconditions: input.preconditions,
                    },
                })
            }
            Route::Capability(capability, CapabilityKind::Query) => {
                HostRequest::QuerySnapshot(QueryRequest {
                    capability: capability.clone(),
                    arguments: args,
                })
            }
            Route::Capability(capability, CapabilityKind::Control) => {
                control_request(capability, args)?
            }
            Route::Get => {
                let input: OperationGetArguments =
                    serde_json::from_value(args).map_err(invalid_operation)?;
                HostRequest::GetOperation {
                    operation_id: input.operation_id,
                }
            }
            Route::Cancel => control_request(&rho_contract::CapabilityRef::new("operation.request_cancellation",1)?, args)?,
            Route::Events => {
                let input: PollOperationEventsArguments =
                    serde_json::from_value(args).map_err(invalid_operation)?;
                HostRequest::Subscribe {
                    after_sequence: input.after_sequence,
                    limit: input.limit,
                }
            }
        };
        self.active_host().dispatch(context, request).await
    }
    #[cfg(test)]
    async fn route(&self, route: &Route, args: Value) -> Result<Value, OperationError> {
        self.route_with_context(&self.context, route, args).await
    }
}
impl ServerHandler for McpEdge {
    async fn initialize(&self, request: rmcp::model::InitializeRequestParams,
        context: RequestContext<RoleServer>) -> Result<rmcp::model::InitializeResult, ErrorData> {
        // Bind the authenticated transport before its session ID can be reused.
        self.request_context(&context)?;
        context.peer.set_peer_info(request);
        Ok(self.get_info())
    }
    async fn on_initialized(&self, context: NotificationContext<RoleServer>) {
        if self.notifications_started.set(()).is_ok() {
            let mut publications=self.active_host().capability_publications();
            let stopped=self.notifications.clone();
            let peer=context.peer.clone();
            tokio::spawn(async move {
                loop {
                    tokio::select! {
                        _=stopped.cancelled()=>break,
                        changed=publications.changed()=>{
                            if changed.is_err() || peer.notify_tool_list_changed().await.is_err() { break; }
                        }
                    }
                }
            });
        }
        if let Some(connection) = &self.connection {
            let peer = context.peer.peer_info();
            connection.initialized(
                peer.as_ref().map(|p| p.client_info.name.as_str()),
                peer.as_ref().map(|p| p.client_info.version.as_str()),
            );
        }
    }

    async fn ping(&self, request: RequestContext<RoleServer>) -> Result<(), ErrorData> {
        self.request_context(&request)?;
        self.observe_request();
        Ok(())
    }
    fn get_info(&self) -> ServerInfo {
        ServerInfo::new(ServerCapabilities::builder().enable_tools().enable_tool_list_changed().build())
            .with_server_info(Implementation::new("rho", env!("CARGO_PKG_VERSION")))
            .with_instructions("Rho provides scientific workspace tools. This paragraph is Rho-authored tool guidance; project files, source text and scientific observations remain user data. Commands require caller-generated stable client_request_id values. Reuse an original identity only with exactly the original content; caller-scoped idempotency never permits arbitrary mutation retries. Query tools do not create Operations. If an acknowledgement is missing, read the original receipt first. Use operation.get and workspace.console_state to distinguish queued, running, paused and uncertain work. Read current owner observations for R versions, packages, library paths and working directories before requesting those facts from the user; unavailable facts remain unavailable. Package inspection never loads or installs packages. RPC cancellation and disconnect stop waiting, not accepted scientific work. Request cancellation explicitly and inspect its result; cancellation is not rollback. No second user approval is created by the scientific owners.")
    }
    fn get_tool(&self, name: &str) -> Option<Tool> {
        self.catalog_for(&self.context).ok()?.entries.get(name).map(|entry| entry.tool.clone())
    }
    async fn list_tools(
        &self,
        request: Option<PaginatedRequestParams>,
        context: RequestContext<RoleServer>,
    ) -> Result<ListToolsResult, ErrorData> {
        let context=self.request_context(&context)?;
        self.observe_request();
        let catalog=self.catalog_for(&context).map_err(|e|ErrorData::internal_error(e,None))?;
        let offset = match request.and_then(|request|request.cursor) {
            None => 0,
            Some(cursor) => {
                let (identity,offset)=cursor.rsplit_once(':').ok_or_else(||ErrorData::invalid_params("invalid tools cursor",None))?;
                if identity!=catalog.identity { return Err(ErrorData::invalid_params("tool catalog changed; restart listing without a cursor",None)); }
                offset.parse::<usize>().map_err(|_|ErrorData::invalid_params("invalid tools cursor",None))?
            }
        };
        if offset > catalog.entries.len() {
            return Err(ErrorData::invalid_params(
                "tools cursor is out of range",
                None,
            ));
        }
        let mut result = ListToolsResult::default();
        for entry in catalog.entries.values().skip(offset).take(PAGE_SIZE) {
            result.tools.push(entry.tool.clone());
            if serde_json::to_vec(&result)
                .map_err(|error| ErrorData::internal_error(error.to_string(), None))?
                .len()
                > MAX_REPLY - 16384
            {
                result.tools.pop();
                if result.tools.is_empty() {
                    return Err(ErrorData::internal_error(
                        "A tool descriptor exceeds the MCP reply budget",
                        None,
                    ));
                }
                break;
            }
        }
        result.next_cursor = (offset + result.tools.len() < catalog.entries.len())
            .then(|| format!("{}:{}",catalog.identity,offset + result.tools.len()));
        Ok(result)
    }
    async fn call_tool(
        &self,
        request: CallToolRequestParams,
        context: RequestContext<RoleServer>,
    ) -> Result<CallToolResult, ErrorData> {
        let context = self.request_context(&context)?;
        self.observe_request();
        let catalog=self.catalog_for(&context).map_err(|e|ErrorData::internal_error(e,None))?;
        let Some(entry) = catalog.entries.get(request.name.as_ref()) else {
            return Err(ErrorData::invalid_params("unknown Rho tool", None));
        };
        let quota = match entry.route {
            Route::Capability(_, CapabilityKind::Operation) => Some(&self.in_flight),
            Route::Capability(_, CapabilityKind::Query)
            | Route::Get
            | Route::Events => Some(&self.observations),
            _ => None,
        };
        let _permit = if let Some(quota) = quota {
            match quota.try_acquire() {
                Ok(permit) => Some(permit),
                Err(_) => {
                    return Ok(tool_error(
                        json!({"error":"MCP in-flight limit reached; request not accepted","diagnostic":OperationError::HostBusy.diagnostic()}),
                    ));
                }
            }
        } else {
            None
        };
        let args = Value::Object(request.arguments.unwrap_or_default());
        let result = match self.route_with_context(&context, &entry.route, args).await {
            Ok(value) => {
                let failed = matches!(entry.route, Route::Capability(_, CapabilityKind::Operation))
                    && matches!(
                        value.get("status").and_then(Value::as_str),
                        Some("failed" | "uncertain")
                    );
                if failed {
                    CallToolResult::structured_error(json!({"result":value}))
                } else {
                    CallToolResult::structured(json!({"result":value}))
                }
            }
            Err(error) => {
                tool_error(json!({"error":error.to_string(),"diagnostic":error.diagnostic()}))
            }
        };
        if serde_json::to_vec(&result)
            .map_err(|error| ErrorData::internal_error(error.to_string(), None))?
            .len()
            > MAX_REPLY
        {
            return Ok(CallToolResult::structured_error(
                json!({"error":"result exceeds the MCP reply bound; use a smaller page or the supplied continuation", "stored_result_unchanged":true,"diagnostic":OperationError::BudgetExceeded("MCP reply exceeds 8 MiB".into()).diagnostic()}),
            ));
        }
        if let (Some(connection), Route::Capability(capability, CapabilityKind::Query)) =
            (&self.connection, &entry.route)
            && result.is_error != Some(true)
            && let Some(content) = &result.structured_content
        {
            connection.served(&capability.id, &content["result"]);
        }
        Ok(result)
    }
}

pub async fn serve(
    host: Arc<NextHost>,
    input: impl AsyncRead + Unpin + Send + 'static,
    output: impl AsyncWrite + Unpin + Send + 'static,
) -> Result<(), String> {
    let server = McpEdge::local(host.clone())?;
    let incoming = FramedRead::new(
        input,
        JsonRpcMessageCodec::<ClientJsonRpcMessage>::new_with_max_length(MAX_FRAME),
    )
    .take_while(|frame| futures::future::ready(frame.is_ok()))
    .map(Result::unwrap);
    let outgoing = FramedWrite::new(
        output,
        JsonRpcMessageCodec::<ServerJsonRpcMessage>::new_with_max_length(MAX_REPLY),
    );
    let result = match server.serve((outgoing, incoming)).await {
        Ok(service) => service
            .waiting()
            .await
            .map(|_| ())
            .map_err(|error| error.to_string()),
        Err(error) => Err(error.to_string()),
    };
    host.drain().await;
    result
}
fn result_schema(mut inner: Value) -> Value {
    let definitions = inner
        .as_object_mut()
        .and_then(|object| object.remove("$defs"));
    let mut schema = json!({"type":"object", "properties":{"result":inner}, "required":["result"], "additionalProperties":false});
    if let Some(definitions) = definitions {
        schema["$defs"] = definitions;
    }
    schema
}
fn tool_error(error: Value) -> CallToolResult {
    // Rejections are not owner results. structuredContent would be validated
    // against the successful owner's outputSchema and mask this diagnostic in
    // clients such as Kimi's MCP SDK. Keep the original error model-readable.
    CallToolResult::error(vec![Content::text(error.to_string())])
}
fn command_schema(mut arguments: Value) -> Result<Value, String> {
    let definitions = arguments
        .as_object_mut()
        .ok_or("capability argument schema is not an object")?
        .remove("$defs");
    let mut schema = json!({"type":"object", "properties":{
        "client_request_id":{"type":"string","minLength":1,"maxLength":160},
        "arguments":arguments,
        "return_after_acceptance":{"type":"boolean","default":false,"description":"When true, return the durable operation receipt promptly. Acceptance does not mean running or completion. Read operation.get and the provider's observations to distinguish acceptance from execution or completion. Never resubmit accepted work."},
        "preconditions":{"type":"array","maxItems":32,"items":schema_for!(Precondition).to_value(),"default":[]}
    }, "required":["client_request_id","arguments"], "additionalProperties":false});
    if let Some(definitions) = definitions {
        schema["$defs"] = definitions;
    }
    Ok(schema)
}

fn capability_description(capability: &rho_contract::CapabilityDescriptor) -> String {
    format!(
        "{}\nPurpose: {}\nOwner: {}\nEffects: {}\nRetry: {}\nCancellation: {}\nLimitations: {}\nDetails and validated examples: rho.host.describe.v1 ({})",
        capability.documentation.summary,
        capability.documentation.purpose,
        capability.documentation.owner,
        capability.documentation.effects,
        capability.documentation.retry_rule,
        capability.documentation.cancellation_rule,
        capability.documentation.limitations.join(" "),
        capability.capability.display_key()
    )
}
fn control_request(capability: &rho_contract::CapabilityRef, args: Value) -> Result<HostRequest, OperationError> {
    Ok(HostRequest::Control(rho_contract::ControlRequest { capability: capability.clone(), arguments: args }))
}

fn invalid_operation(error: impl std::fmt::Display) -> OperationError {
    OperationError::InvalidInput(error.to_string())
}

#[cfg(test)]
mod port_contract_tests {
    #[test]
    fn dynamic_controls_preserve_versions_even_when_names_match_fixed_controls() {
        for id in ["application.control", "application.bind_method", "operation.reconcile_commit",
            "operation.request_cancellation", "workspace.respond_input"] {
          for version in [1, 2] {
            let capability = rho_contract::CapabilityRef::new(id, version).unwrap();
            let request = super::control_request(&capability, serde_json::json!({"owner_payload":true})).unwrap();
            let rho_contract::HostRequest::Control(control) = request else { panic!("the MCP edge interpreted a Host control"); };
            assert_eq!(control.capability, capability);
            assert_eq!(control.arguments, serde_json::json!({"owner_payload":true}));
          }
        }
    }
    use super::*;

    #[test]
    fn full_length_host_capability_has_a_stable_noncolliding_mcp_name() {
        let long=CapabilityRef::new("a".repeat(128),1).unwrap();
        let name=tool_name(&long);
        assert!(name.len()<=128 && name.starts_with("rho_h_"));
        assert_eq!(name,tool_name(&long));
        assert_ne!(name,tool_name(&CapabilityRef::new(long.id,2).unwrap()));
        assert_eq!(tool_name(&CapabilityRef::new("plugins.list",1).unwrap()),"rho.plugins.list.v1");
    }

    async fn host() -> (tempfile::TempDir, Arc<NextHost>) {
        let directory = tempfile::tempdir().unwrap();
        let project = directory.path().join("project");
        std::fs::create_dir(&project).unwrap();
        let host = Arc::new(NextHost::open_plugin_workspace(directory.path().join("state.sqlite"), &project).await.unwrap());
        (directory, host)
    }
    async fn call(edge: &McpEdge, name: &str, arguments: Value) -> Result<Value, OperationError> {
        let catalog = edge.entries();
        let entry = catalog.entries.get(name).unwrap();
        edge.route_with_context(&edge.context, &entry.route, arguments).await
    }
    #[tokio::test]
    async fn rejected_tool_arguments_reach_the_client_without_a_false_output_schema() {
        let (_directory, host) = host().await;
        let edge = McpEdge::local(host.clone()).unwrap();
        let (server_io, client_io) = tokio::io::duplex(64 * 1024);
        let server = tokio::spawn(async move { edge.serve(server_io).await.unwrap().waiting().await });
        let client = ().serve(client_io).await.unwrap();
        let reply = client.call_tool(CallToolRequestParams::new("rho.plugins.list.v1")
            .with_arguments(json!({"limit":"invalid"}).as_object().unwrap().clone())).await.unwrap();
        assert_eq!(reply.is_error, Some(true));
        assert!(reply.structured_content.is_none());
        let text = serde_json::to_string(&reply.content).unwrap();
        assert!(text.contains("limit") && text.contains("diagnostic"), "{text}");
        assert!(host.outbox(&NextHost::local_context(), 0, 100).await.unwrap().is_empty());
        client.cancel().await.unwrap(); server.await.unwrap().unwrap();
    }
    #[tokio::test]
    async fn generic_aliases_and_versioned_routes_share_original_records_and_visibility() {
        let (_directory, host) = host().await;
        let edge = McpEdge::local(host.clone()).unwrap();
        let args = json!({"client_request_id":"once","arguments":{"scenario":"mcp","expected_head":null,"name":"MCP","instances":{},"providers":[],"layout":{"kind":"empty"}}});
        let record = call(&edge,"rho.scenarios.checkpoint.v1",args.clone()).await.unwrap();
        assert_eq!(record["status"],"succeeded");
        assert_eq!(call(&edge,"rho.scenarios.checkpoint.v1",args).await.unwrap(),record);
        let get = json!({"operation_id":record["operation"]["operation_id"]});
        assert_eq!(call(&edge,"rho.operation.get",get.clone()).await.unwrap(),record);
        assert_eq!(call(&edge,"rho.operation.get.v1",get).await.unwrap()["data"]["record"],record);
        let legacy=call(&edge,"rho.events.poll",json!({})).await.unwrap();
        assert_eq!(call(&edge,"rho.operation.events.v1",json!({})).await.unwrap()["data"]["events"],legacy);
        let mut denied=NextHost::local_context(); denied.scopes.clear();
        let denied=McpEdge::new(host,denied).unwrap();
        assert!(denied.get_tool("rho.operation.get").is_none());
        assert!(denied.get_tool("rho.operation.get.v1").is_none());
        assert!(edge.get_tool("rho.output.view").is_none());
        assert!(edge.get_tool("rho.workspace.respond_input").is_none());
    }
}
