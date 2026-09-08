#![forbid(unsafe_code)]
mod resources;
use rho_operation::OperationError;

use futures::StreamExt;
use rho_contract::{
    CallContext, CallerIdentity, CallerKind, CapabilityKind, CapabilityRef, HostRequest,
    Invocation, OperationId, OperationRecord, OutboxRecord, Precondition, QueryRequest,
    QuerySnapshot,
};
use rho_host::NextHost;
use rmcp::{
    ErrorData, RoleServer, ServerHandler, ServiceExt,
    model::{
        CallToolRequestParams, CallToolResult, ClientJsonRpcMessage, Implementation,
        ListToolsResult, PaginatedRequestParams, ServerCapabilities, ServerInfo,
        ServerJsonRpcMessage, Tool, ToolAnnotations,
    },
    service::RequestContext,
    transport::async_rw::JsonRpcMessageCodec,
};
use schemars::{JsonSchema, schema_for};
use serde::Deserialize;
use serde_json::{Map, Value, json};
use std::{collections::BTreeMap, sync::Arc};
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
#[derive(Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
struct OperationArguments {
    operation_id: OperationId,
}
#[derive(Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
struct EventArguments {
    #[serde(default)]
    after_sequence: u64,
    #[serde(default = "event_limit")]
    #[schemars(range(min = 1, max = 1000))]
    limit: usize,
}
fn event_limit() -> usize {
    100
}

enum Route {
    Capability(CapabilityRef, CapabilityKind),
    Get,
    Cancel,
    Input,
    Events,
    View,
}
struct Entry {
    tool: Tool,
    route: Route,
}
pub struct McpEdge {
    host: Arc<NextHost>,
    context: CallContext,
    entries: BTreeMap<String, Entry>,
    in_flight: Semaphore,
    observations: Semaphore,
}
impl McpEdge {
    pub fn new(host: Arc<NextHost>, context: CallContext) -> Result<Self, String> {
        context.validate().map_err(|error| error.to_string())?;
        let mut entries = BTreeMap::new();
        for capability in host.capabilities() {
            if !capability.required_scopes.is_subset(&context.scopes) {
                continue;
            }
            let name = format!(
                "rho.{}.v{}",
                capability.capability.id, capability.capability.version
            );
            if name.len() > 128
                || !name
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | '.'))
            {
                return Err(format!(
                    "capability cannot be represented as an MCP tool: {}",
                    capability.capability.display_key()
                ));
            }
            let query = capability.kind == CapabilityKind::Query;
            let control = capability.kind == CapabilityKind::Control;
            let input = if query || control {
                capability.input_schema
            } else {
                command_schema(capability.input_schema)?
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
            let description = format!(
                "{}\nPurpose: {}\nOwner: {}\nEffects: {}\nRetry: {}\nCancellation: {}\nLimitations: {}\nDetails and validated examples: rho.host.describe.v1 ({})",
                capability.documentation.summary,
                capability.documentation.purpose,
                capability.documentation.owner,
                capability.documentation.effects,
                capability.documentation.retry_rule,
                capability.documentation.cancellation_rule,
                capability.documentation.limitations.join(" "),
                capability.capability.display_key()
            );
            let tool = Tool::new(name.clone(), description, object(input)?)
                .with_raw_output_schema(Arc::new(object(result_schema(output))?))
                .with_annotations(ToolAnnotations::new().read_only(query));
            if entries
                .insert(
                    name,
                    Entry {
                        tool,
                        route: Route::Capability(capability.capability, capability.kind),
                    },
                )
                .is_some()
            {
                return Err("MCP tool name collision".into());
            }
        }
        for (name, description, input, output, route, read_only) in [
            (
                "rho.operation.get",
                "Read a visible Operation without executing or recovering it.",
                schema_for!(OperationArguments).to_value(),
                schema_for!(Option<OperationRecord>).to_value(),
                Route::Get,
                true,
            ),
            (
                "rho.operation.request_cancellation",
                "Request cancellation by OperationId. Acceptance is not confirmation of a stopped runtime.",
                schema_for!(rho_contract::CancelOperation).to_value(),
                json!({"type":"object"}),
                Route::Cancel,
                false,
            ),
            (
                "rho.workspace.respond_input",
                "Reply once to the identified R stdin request. This does not submit code or start R. Password answers are transient and are not journaled.",
                schema_for!(rho_contract::RespondInput).to_value(),
                json!({"type":"object","properties":{"submitted":{"type":"boolean"}},"required":["submitted"]}),
                Route::Input,
                false,
            ),
            (
                "rho.events.poll",
                "Read a bounded durable event cursor page. This does not start an Operation; it is not live push.",
                schema_for!(EventArguments).to_value(),
                schema_for!(Vec<OutboxRecord>).to_value(),
                Route::Events,
                true,
            ),
        ] {
            let tool = Tool::new(name, description, object(input)?)
                .with_raw_output_schema(Arc::new(object(result_schema(output))?))
                .with_annotations(ToolAnnotations::new().read_only(read_only));
            if entries.insert(name.into(), Entry { tool, route }).is_some() {
                return Err("MCP control tool name collision".into());
            }
        }
        if context.scopes.contains("workspace.read")
            && host
                .capabilities()
                .iter()
                .any(|capability| capability.capability.id == "output.view")
        {
            let mut payload = schema_for!(rho_contract::OutputView).to_value();
            if let Some(properties) = payload.get_mut("properties").and_then(Value::as_object_mut) {
                properties.remove("preview_base64");
            }
            if let Some(required) = payload.get_mut("required").and_then(Value::as_array_mut) {
                required.retain(|field| field != "preview_base64");
            }
            let output = rho_contract::query_result_schema(payload);
            let tool = Tool::new("rho.output.view","View a verified original PNG/JPEG/static SVG with native image content, optional original-coordinate crop, and original resource link. Preview is not a new scientific result.",object(schema_for!(rho_contract::ViewOutputArguments).to_value())?)
                .with_raw_output_schema(Arc::new(object(result_schema(output))?))
                .with_annotations(ToolAnnotations::new().read_only(true));
            entries.insert(
                "rho.output.view".into(),
                Entry {
                    tool,
                    route: Route::View,
                },
            );
        }
        Ok(Self {
            host,
            context,
            entries,
            in_flight: Semaphore::new(32),
            observations: Semaphore::new(16),
        })
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
    async fn route(&self, route: &Route, args: Value) -> Result<Value, OperationError> {
        let request = match route {
            Route::Capability(capability, CapabilityKind::Operation) => {
                let input: CommandArguments =
                    serde_json::from_value(args).map_err(invalid_operation)?;
                HostRequest::Invoke(rho_contract::InvokeRequest {
                    return_after_acceptance: input.return_after_acceptance,
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
            Route::View => {
                return Err(invalid_operation("native view uses the presentation route"));
            }
            Route::Capability(_, CapabilityKind::Control) => HostRequest::ApplicationControl(
                serde_json::from_value(args).map_err(invalid_operation)?,
            ),
            Route::Get => {
                let input: OperationArguments =
                    serde_json::from_value(args).map_err(invalid_operation)?;
                HostRequest::GetOperation {
                    operation_id: input.operation_id,
                }
            }
            Route::Cancel => {
                let input: rho_contract::CancelOperation =
                    serde_json::from_value(args).map_err(invalid_operation)?;
                HostRequest::RequestCancellation {
                    operation_id: input.operation_id,
                    only_if_pending: input.only_if_pending,
                }
            }
            Route::Input => {
                HostRequest::RespondInput(serde_json::from_value(args).map_err(invalid_operation)?)
            }
            Route::Events => {
                let input: EventArguments =
                    serde_json::from_value(args).map_err(invalid_operation)?;
                HostRequest::Subscribe {
                    after_sequence: input.after_sequence,
                    limit: input.limit,
                }
            }
        };
        self.host.dispatch(&self.context, request).await
    }
}
impl ServerHandler for McpEdge {
    fn get_info(&self) -> ServerInfo {
        ServerInfo::new(ServerCapabilities::builder().enable_tools().enable_resources().build())
            .with_server_info(Implementation::new("rho", env!("CARGO_PKG_VERSION")))
            .with_instructions("Rho exposes a scientific space, not an Agent loop. Commands require caller-generated stable client_request_id values; query tools do not create Operations. Use rho.events.poll to discover accepted OperationIds and rho.operation.request_cancellation to request a real cancellation. RPC cancellation or disconnect only stops waiting; accepted Host work is drained. No second user approval is created by Rho.")
    }
    fn get_tool(&self, name: &str) -> Option<Tool> {
        self.entries.get(name).map(|entry| entry.tool.clone())
    }
    async fn list_tools(
        &self,
        request: Option<PaginatedRequestParams>,
        _: RequestContext<RoleServer>,
    ) -> Result<ListToolsResult, ErrorData> {
        let offset = request
            .and_then(|request| request.cursor)
            .map(|cursor| cursor.parse::<usize>())
            .transpose()
            .map_err(|_| ErrorData::invalid_params("invalid tools cursor", None))?
            .unwrap_or(0);
        if offset > self.entries.len() {
            return Err(ErrorData::invalid_params(
                "tools cursor is out of range",
                None,
            ));
        }
        let mut result = ListToolsResult::default();
        result.tools = self
            .entries
            .values()
            .skip(offset)
            .take(PAGE_SIZE)
            .map(|entry| entry.tool.clone())
            .collect();
        result.next_cursor = (offset + result.tools.len() < self.entries.len())
            .then(|| (offset + result.tools.len()).to_string());
        Ok(result)
    }
    async fn list_resource_templates(
        &self,
        _: Option<PaginatedRequestParams>,
        _: RequestContext<RoleServer>,
    ) -> Result<rmcp::model::ListResourceTemplatesResult, ErrorData> {
        if !self.context.scopes.contains("workspace.read") {
            return Ok(rmcp::model::ListResourceTemplatesResult::default());
        }
        Ok(resources::templates())
    }
    async fn read_resource(
        &self,
        request: rmcp::model::ReadResourceRequestParams,
        _: RequestContext<RoleServer>,
    ) -> Result<rmcp::model::ReadResourceResult, ErrorData> {
        let _permit = self
            .observations
            .try_acquire()
            .map_err(|_| ErrorData::internal_error("Resource read quota reached", None))?;
        self.read_output_resource(&request.uri)
            .await
            .map_err(|error| {
                ErrorData::invalid_params(
                    error.to_string(),
                    Some(json!({"diagnostic":error.diagnostic()})),
                )
            })
    }
    async fn call_tool(
        &self,
        request: CallToolRequestParams,
        _: RequestContext<RoleServer>,
    ) -> Result<CallToolResult, ErrorData> {
        let Some(entry) = self.entries.get(request.name.as_ref()) else {
            return Err(ErrorData::invalid_params("unknown Rho tool", None));
        };
        let quota = match entry.route {
            Route::Capability(_, CapabilityKind::Operation) => Some(&self.in_flight),
            Route::Capability(_, CapabilityKind::Query) | Route::View => Some(&self.observations),
            _ => None,
        };
        let _permit = if let Some(quota) = quota {
            match quota.try_acquire() {
                Ok(permit) => Some(permit),
                Err(_) => {
                    return Ok(CallToolResult::structured_error(
                        json!({"error":"MCP in-flight limit reached; request not accepted","diagnostic":OperationError::HostBusy.diagnostic()}),
                    ));
                }
            }
        } else {
            None
        };
        let args = Value::Object(request.arguments.unwrap_or_default());
        if matches!(entry.route, Route::View) {
            return Ok(match self.native_view(args).await {
                Ok(result) => result,
                Err(error) => CallToolResult::structured_error(
                    json!({"error":error.to_string(),"diagnostic":error.diagnostic()}),
                ),
            });
        }
        let result = match self.route(&entry.route, args).await {
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
            Err(error) => CallToolResult::structured_error(
                json!({"error":error.to_string(),"diagnostic":error.diagnostic()}),
            ),
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
fn object(value: Value) -> Result<Map<String, Value>, String> {
    value
        .as_object()
        .cloned()
        .ok_or_else(|| "tool schema is not an object".into())
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
fn command_schema(mut arguments: Value) -> Result<Value, String> {
    let definitions = arguments
        .as_object_mut()
        .ok_or("capability argument schema is not an object")?
        .remove("$defs");
    let mut schema = json!({"type":"object", "properties":{
        "client_request_id":{"type":"string","minLength":1,"maxLength":160},
        "arguments":arguments,
        "return_after_acceptance":{"type":"boolean","default":false},
        "preconditions":{"type":"array","maxItems":32,"items":schema_for!(Precondition).to_value(),"default":[]}
    }, "required":["client_request_id","arguments"], "additionalProperties":false});
    if let Some(definitions) = definitions {
        schema["$defs"] = definitions;
    }
    Ok(schema)
}

fn invalid_operation(error: impl std::fmt::Display) -> OperationError {
    OperationError::InvalidInput(error.to_string())
}
