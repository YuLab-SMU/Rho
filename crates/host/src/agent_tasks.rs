//! Transitional Host scope, context and native MCP adapter. The Agent package
//! owns task admission, durable observations and native connection scheduling.
use crate::{ApplicationStore, NextHost};
use base64::{Engine, engine::general_purpose::STANDARD};
use rho_agent_client::*;
use rho_agent_native::{NativeTaskEndpoint, NativeTaskFailure, NativeTaskPort, NativeTaskRuntime};
use rho_application::*;
use rho_contract::*;
use serde_json::json;
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    sync::Arc,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tokio::sync::{Mutex, OwnedSemaphorePermit};

fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}
fn err(error: impl ToString) -> ApplicationError {
    ApplicationError::InvalidInput(error.to_string())
}
fn scope(project: &str, context: &CallContext) -> Result<AgentTaskScope, ApplicationError> {
    context.validate().map_err(err)?;
    Ok(AgentTaskScope {
        project: project.into(),
        principal: serde_json::to_string(context.principal()).map_err(err)?,
    })
}
type DiagnosticEntries = HashMap<String, (String, Arc<std::sync::Mutex<AgentDiagnostic>>)>;
pub struct AgentTaskService {
    owner: Arc<AgentTaskOwner>,
    factory: Arc<dyn NativeAgentFactory>,
    native: Arc<NativeTaskRuntime>,
    pub mcp_connections: Arc<crate::AgentMcpConnections>,
    diagnostics: Mutex<DiagnosticEntries>,
    catalogs: std::sync::Mutex<HashMap<(String, AgentProvider), LocalAgent>>,
    context_providers: std::sync::RwLock<Vec<Arc<dyn crate::AgentContextProvider>>>,
}
impl AgentTaskService {
    pub(crate) fn with_handoff_write<T>(
        &self,
        write: impl FnOnce() -> Result<T, ApplicationError>,
    ) -> Result<T, ApplicationError> {
        self.owner.with_handoff_write(write)
    }
    pub async fn project_task_page(
        &self,
        host: &NextHost,
        context: &CallContext,
        project: &str,
        archived: Option<bool>,
        before: Option<&str>,
        limit: u32,
        rho: &crate::ComponentAgentService,
    ) -> Result<ProjectAgentTaskPage, ApplicationError> {
        Self::validate_project(host, project)?;
        let scope = scope(project, context)?;
        rho.with_live_run_ids(|live| {
            self.owner.store.project_agent_tasks(
                &scope,
                archived,
                before,
                limit as usize,
                &self.owner.host_incarnation,
                rho.host_incarnation(),
                live,
            )
        })
        .await
        .map_err(Into::into)
    }
    fn validate_project(host: &NextHost, project: &str) -> Result<(), ApplicationError> {
        if !host
            .runtime
            ._project_lease
            .as_ref()
            .is_some_and(|lease| lease.root().to_str() == Some(project))
        {
            return Err(err("Agent task belongs to a different project"));
        }
        Ok(())
    }
    pub fn new(store: Arc<ApplicationStore>) -> Arc<Self> {
        Self::with_factory(store, Arc::new(LocalNativeAgents))
    }
    pub fn with_factory(
        store: Arc<dyn AgentTaskRepository>,
        factory: Arc<dyn NativeAgentFactory>,
    ) -> Arc<Self> {
        let owner = Arc::new(AgentTaskOwner::new(store));
        let native = NativeTaskRuntime::new(owner.clone(), factory.clone());
        Arc::new(Self {
            owner,
            factory,
            native,
            mcp_connections: Arc::default(),
            diagnostics: Mutex::new(HashMap::new()),
            catalogs: std::sync::Mutex::new(HashMap::new()),
            context_providers: std::sync::RwLock::new(Vec::new()),
        })
    }
    pub fn remember_catalog(&self, project: String, catalog: LocalAgent) {
        self.catalogs
            .lock()
            .unwrap()
            .insert((project, catalog.provider), catalog);
    }
    pub fn register_context_provider(
        &self,
        provider: Arc<dyn crate::AgentContextProvider>,
    ) -> Result<(), String> {
        let source = provider.source();
        if !source.plugin
            || !source.id.starts_with("plugin.")
            || source.id.len() > 80
            || !source
                .id
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_'))
            || source.name.is_empty()
            || source.name.len() > 128
        {
            return Err("Invalid plugin context-source identity".into());
        }
        let mut providers = self
            .context_providers
            .write()
            .map_err(|_| "Context registry unavailable")?;
        if providers.iter().any(|p| p.source().id == source.id) {
            return Err("Context source is already registered".into());
        }
        if providers.len() >= 32 {
            return Err("Context source budget reached".into());
        }
        providers.push(provider);
        Ok(())
    }
    pub async fn has_live(&self) -> bool {
        self.native.has_live().await
    }
    pub fn reserve_connection(&self) -> Result<OwnedSemaphorePermit, ApplicationError> {
        self.native.reserve_connection().map_err(Into::into)
    }
    pub async fn test(
        self: &Arc<Self>,
        host: &NextHost,
        mut request: TestAgent,
        endpoint: String,
        _token: String,
    ) -> Result<AgentDiagnostic, ApplicationError> {
        Self::validate_project(host, &request.project_root)?;
        uuid::Uuid::parse_str(&request.request_id)
            .map_err(|_| err("Invalid diagnostic request ID"))?;
        let observe = request.observe_only;
        request.observe_only = false;
        let signature = format!(
            "{:x}",
            Sha256::digest(serde_json::to_vec(&request).map_err(err)?)
        );
        let mut entries = self.diagnostics.lock().await;
        if let Some((old, state)) = entries.get(&request.request_id) {
            if *old != signature {
                return Err(ApplicationError::RequestConflict);
            }
            return Ok(state.lock().map_err(err)?.clone());
        }
        let initial = AgentDiagnostic {
            request_id: request.request_id.clone(),
            provider: request.provider,
            model: request.model.clone(),
            state: if observe { "unknown" } else { "running" }.into(),
            elapsed_ms: None,
            response: None,
            error: observe.then(|| {
                "The previous diagnostic is unavailable. Run Test explicitly to start another."
                    .into()
            }),
        };
        if observe {
            return Ok(initial);
        }
        Self::validate_window(host, &request.window, &NextHost::local_context()).await?;
        if entries.len() >= 128 {
            return Err(ApplicationError::Budget(
                "Diagnostic request budget reached for this Host".into(),
            ));
        }
        let permit = self.reserve_connection()?;
        let status = Arc::new(std::sync::Mutex::new(initial.clone()));
        entries.insert(request.request_id.clone(), (signature, status.clone()));
        drop(entries);
        let service = self.clone();
        let mcp = self.mcp_connections.issue(
            &request.project_root,
            &NextHost::local_context(),
            "diagnostic",
            &request.request_id,
            1,
            false,
        );
        tokio::spawn(async move {
            let _permit = permit;
            let _mcp = mcp;
            let started = now();
            let opened = service
                .factory
                .open(NativeOpenRequest {
                    provider: request.provider,
                    root: request.project_root.into(),
                    window: request.window.clone().into(),
                    native_session_id: None,
                    endpoint,
                    token: _mcp.token.clone(),
                    interrupted: false,
                })
                .await;
            let result = match opened {
                Err(e) => Err(e.error),
                Ok(session) => {
                    let result=async {
                        if service.native.is_stopped() { return Err("Host closed before the diagnostic started".into()); }
                        session.configure(&request.model,request.effort.as_deref(),None).await?;
                        session.send(NativePrompt{request_id:request.request_id,display_text:"Connection test".into(),parts:vec![NativeInput::Text("Reply with exactly ok. Do not call tools or read files.".into())],window:request.window.into()}).await?;
                        tokio::time::timeout(Duration::from_secs(90),async {
                            let mut tick=tokio::time::interval(Duration::from_millis(100));
                            loop {
                                if service.native.is_stopped() { return Err("Host closed during the diagnostic".into()); }
                                let s=session.snapshot();
                                match s.state.as_str(){
                                    "ready"=>return Ok(session.events(0).events.into_iter().filter(|e|e.role.as_deref()==Some("assistant")).map(|e|e.text).collect::<Vec<_>>().join("\n")),
                                    "running"=>{},
                                    "waiting_for_permission"=>return Err("Test requested a tool permission; diagnostics do not run tools".into()),
                                    _=>return Err(s.error.unwrap_or_else(||format!("Diagnostic ended: {}",s.state))),
                                }
                                tick.tick().await;
                            }
                        }).await.map_err(|_|"Diagnostic timed out; the request was not replayed".to_owned())?
                    }.await;
                    session.close().await;
                    result
                }
            };
            let mut state = status.lock().unwrap();
            state.elapsed_ms = Some(now().saturating_sub(started));
            match result {
                Ok(text) => {
                    state.response = Some(text);
                    state.state = "succeeded".into();
                }
                Err(e) => {
                    state.state = "failed".into();
                    state.error = Some(e);
                }
            }
        });
        Ok(initial)
    }
    pub async fn close(&self) {
        self.mcp_connections.revoke_all();
        self.native.close().await;
    }
    pub async fn validate_window(
        host: &NextHost,
        window: &ApplicationWindowRef,
        context: &CallContext,
    ) -> Result<(), ApplicationError> {
        let result = host
            .dispatch(
                context,
                HostRequest::QuerySnapshot(QueryRequest {
                    capability: CapabilityRef {
                        id: "application.context".into(),
                        version: 1,
                    },
                    arguments: json!({"window":window,"limit":1}),
                }),
            )
            .await
            .map_err(err)?;
        if result["status"] != "ready" || result["data"]["source"] != "live_bridge" {
            return Err(ApplicationError::Offline);
        }
        Ok(())
    }
    pub async fn query(
        &self,
        host: &NextHost,
        context: &CallContext,
        request: AgentTasksQuery,
    ) -> Result<AgentTaskQueryResult, ApplicationError> {
        Self::validate_project(host, &request.project_root)?;
        let scope = scope(&request.project_root, context)?;
        match request.query {
            AgentTaskQuery::ScientificWork { task_id, limit } => {
                if !(1..=20).contains(&limit) {
                    return Err(err("Task operation limit must be 1–20"));
                }
                let task = self.owner.get(&scope, &task_id)?;
                if !task.task_mcp_identity {
                    return Ok(AgentTaskQueryResult::ScientificWork {
                        work: AgentScientificWork {
                            task_id,
                            attributable: false,
                            operations: vec![],
                            has_more: false,
                        },
                    });
                }
                let caller = CallerIdentity {
                    kind: CallerKind::Agent,
                    id: format!("task:{task_id}"),
                };
                let page = host
                    .runtime
                    .gateway
                    .recent_for_caller(
                        context,
                        &caller,
                        &RecentOperationsArguments {
                            before_cursor: None,
                            client_request_id: None,
                            operation_id: None,
                            limit,
                        },
                    )
                    .await
                    .map_err(|failure| {
                        ApplicationError::Diagnostic(Box::new(
                            host.runtime.gateway.diagnostic(context, &failure),
                        ))
                    })?;
                Ok(AgentTaskQueryResult::ScientificWork {
                    work: AgentScientificWork {
                        task_id,
                        attributable: true,
                        operations: page.operations,
                        has_more: page.next_cursor.is_some(),
                    },
                })
            }
            AgentTaskQuery::ProjectList { .. } => Err(err("Use the Host project task projection")),
            AgentTaskQuery::ContextSources => Ok(AgentTaskQueryResult::ContextSources {
                sources: crate::agent_context::sources(&self.context_providers.read().unwrap()),
            }),
            AgentTaskQuery::ContextSearch {
                window,
                source,
                text,
                limit,
            } => {
                let providers = self.context_providers.read().unwrap().clone();
                let reader = crate::AgentContextReader::new(&scope.project, host, context);
                let (items, notices) = crate::agent_context::search(
                    &reader,
                    &window,
                    source.as_deref(),
                    &text,
                    limit,
                    &providers,
                )
                .await
                .map_err(err)?;
                Ok(AgentTaskQueryResult::ContextItems { items, notices })
            }
            AgentTaskQuery::ContextPreview { window, selection } => {
                let providers = self.context_providers.read().unwrap().clone();
                let reader = crate::AgentContextReader::new(&scope.project, host, context);
                Ok(AgentTaskQueryResult::ContextPreview {
                    preview: crate::agent_context::preview(
                        &reader, &window, &selection, &providers, false,
                    )
                    .await
                    .map_err(err)?,
                })
            }
            AgentTaskQuery::List {
                archived,
                before,
                limit,
            } => {
                if !(1..=100).contains(&limit) {
                    return Err(err("Task page limit must be 1–100"));
                }
                let mut records = self.owner.store.agent_tasks(
                    &scope,
                    archived,
                    before.as_deref(),
                    limit as usize + 1,
                )?;
                let more = records.len() > limit as usize;
                records.truncate(limit as usize);
                let next = if more {
                    records
                        .last()
                        .map(|r| format!("{}:{}", r.task.created_at_ms, r.task.task_id))
                } else {
                    None
                };
                let tasks = records
                    .iter()
                    .map(|r| {
                        self.owner.detail(&scope, &r.task.task_id).map(|mut d| {
                            d.summary.attachment.capabilities.models.clear();
                            d.summary
                        })
                    })
                    .collect::<Result<Vec<_>, _>>()?;
                let (running, permissions) = self
                    .owner
                    .store
                    .agent_task_counts(&scope, &self.owner.host_incarnation)?;
                let active_ids = self.native.active_ids(&scope).await;
                let mut attention = Vec::new();
                for id in active_ids {
                    let mut summary = self.owner.detail(&scope, &id)?.summary;
                    if !summary.attachment.decisions.is_empty() {
                        summary.attachment.capabilities.models.clear();
                        attention.push(summary);
                    }
                }
                Ok(AgentTaskQueryResult::List {
                    tasks,
                    attention,
                    next,
                    running,
                    permissions,
                })
            }
            AgentTaskQuery::Get { task_id } => Ok(AgentTaskQueryResult::Detail {
                detail: Box::new(self.owner.detail(&scope, &task_id)?),
            }),
            AgentTaskQuery::Receipt { request_id } => {
                let mut receipt = self.owner.store.agent_receipt(&scope, &request_id)?;
                if let Some(r) = &mut receipt {
                    let task = self.owner.get(&scope, &r.task_id)?;
                    if task.host_incarnation != self.owner.host_incarnation
                        && matches!(r.status.as_str(), "prepared" | "submitted")
                    {
                        r.status = "uncertain".into();
                        r.error =
                            Some("Host restarted before the original result was confirmed".into());
                    }
                }
                Ok(AgentTaskQueryResult::Receipt { receipt })
            }
            AgentTaskQuery::Events {
                task_id,
                after,
                before,
                limit,
            } => Ok(AgentTaskQueryResult::Events {
                page: self.owner.store.agent_events(
                    &scope,
                    &task_id,
                    after,
                    before,
                    limit as usize,
                )?,
            }),
            AgentTaskQuery::NativeHistory {
                task_id,
                cursor,
                limit,
            } => Ok(AgentTaskQueryResult::NativeHistory {
                page: self.native.history(&scope, &task_id, cursor, limit).await?,
            }),
        }
    }
    pub async fn command(
        self: &Arc<Self>,
        host: Arc<NextHost>,
        context: CallContext,
        request: AgentTasksCommand,
        endpoint: String,
        _token: String,
    ) -> Result<AgentTaskCommandResult, ApplicationError> {
        Self::validate_project(&host, &request.project_root)?;
        if self.native.is_stopped() {
            return Err(err("This Host is closing"));
        }
        Self::validate_window(&host, &request.window, &context).await?;
        let request = AgentTaskRequest::from(request);
        let scope = scope(&request.project_root, &context)?;
        if let AgentTaskCommand::TakeOver {
            control,
            stop: true,
        } = &request.command
        {
            let record = self.owner.get(&scope, &control.task_id)?;
            if record.attachment.controller.window_id != request.window.window_id
                && Self::validate_window(
                    &host,
                    &record.attachment.controller.clone().into(),
                    &context,
                )
                .await
                .is_ok()
            {
                return Err(err(
                    "The operating window is still online; stop the Agent there before taking over",
                ));
            }
        }
        // No await between durable admission and spawning the owned native action.
        let admission = self.owner.admit(&scope, &request, now())?;
        let id = admission.task.task.task_id.clone();
        let receipt = admission.receipt.clone();
        if !admission.repeated
            && matches!(request.command, AgentTaskCommand::Create { .. })
            && let Some(catalog) = self
                .catalogs
                .lock()
                .unwrap()
                .get(&(scope.project.clone(), admission.task.task.provider))
                .cloned()
        {
            self.owner.update(
                &scope,
                &id,
                admission.task.attachment.generation,
                |t, _, _, _| {
                    t.attachment.capabilities = catalog.capabilities;
                    Ok(())
                },
            )?;
        }
        if admission.native && !admission.repeated {
            let port = Arc::new(NativeCommandPort {
                service: self.clone(),
                host,
                context,
                endpoint,
            });
            let _ = self.native.launch(scope.clone(), request, admission, port);
        } else if !admission.repeated
            && matches!(
                request.command,
                AgentTaskCommand::TakeOver { stop: false, .. }
            )
        {
            self.native
                .rebind(
                    &id,
                    request.window.clone(),
                    admission.task.attachment.generation,
                )
                .await;
        }
        let detail = self.owner.detail(&scope, &receipt.task_id)?;
        Ok(AgentTaskCommandResult { receipt, detail })
    }
    async fn input(
        &self,
        host: &NextHost,
        context: &CallContext,
        scope: &AgentTaskScope,
        task: &StoredAgentTask,
        draft: &AgentTaskDraft,
    ) -> Result<Vec<NativeInput>, NativeTaskFailure> {
        let mut parts = vec![NativeInput::Text(draft.content.text.clone())];
        let overview = host
            .dispatch(
                context,
                HostRequest::QuerySnapshot(QueryRequest {
                    capability: CapabilityRef {
                        id: "host.overview".into(),
                        version: 1,
                    },
                    arguments: json!({}),
                }),
            )
            .await
            .map_err(|e| NativeTaskFailure::before(e.to_string()))?;
        let studio = match host
            .dispatch(
                context,
                HostRequest::QuerySnapshot(QueryRequest {
                    capability: CapabilityRef {
                        id: "application.context".into(),
                        version: 1,
                    },
                    arguments: json!({"window":task.attachment.controller,"limit":16}),
                }),
            )
            .await
        {
            Ok(snapshot) => snapshot,
            Err(error) => json!({"status":"unavailable","reason":error.to_string()}),
        };
        let unconfirmed = self
            .owner
            .store
            .agent_receipts(scope, &task.task.task_id)?
            .into_iter()
            .filter(unconfirmed_receipt)
            .map(|r| json!({"request_id":r.request_id,"status":r.status}))
            .take(32)
            .collect::<Vec<_>>();
        parts.push(NativeInput::Resource{uri:"rho://connection-context".into(),mime_type:"application/json".into(),text:json!({
            "project":scope.project,"window":task.attachment.controller,"workspace":overview["data"],"studio":studio,
            "working_in_rho":"You are working with the user in a live scientific workspace. Pass structured Rho identities (window, document, reference, selection) and application actions as JSON objects, never JSON-encoded strings. Editor, Console, Objects and Plots are shared working surfaces available through Rho's application and scientific tools. For an analysis script, create or edit a document in the supplied Studio window and run its captured version with application.control so the user can see and keep the code. Read application.context for current versions; check application.command_status for the original action's save/run receipts. Use the live R Workspace for R execution. Display a plot with print(p) on Rho's R device; ggsave alone writes a file and does not populate Plots. Verify workspace.list_outputs/output.view, then application.control select_plot with the actual operation/sequence to show a retained figure. Do not claim a component contains a result without owner evidence. If Studio is unavailable, retain code in the project and describe that limitation. Accepted R work may be queued or paused: inspect workspace.console_state instead of sleeping or resubmitting. An R error can pause the queue; inspect the failed run, then explicitly resume the observed pause when continuing intended work is appropriate. You own the analysis and tool choices; Rho supplies execution and presentation capabilities.",
            "previous_unconfirmed_requests":unconfirmed
        }).to_string()});
        for id in &draft.content.assets {
            let (asset, bytes) = self
                .owner
                .store
                .agent_asset(scope, &task.task.task_id, id)?;
            if asset.mime_type.starts_with("image/") {
                parts.push(NativeInput::Image {
                    mime_type: asset.mime_type,
                    data: bytes,
                });
            } else {
                let text = String::from_utf8(bytes).map_err(|_| {
                    NativeTaskFailure::before(format!(
                        "{} is not a supported text/image input for this Agent",
                        asset.name
                    ))
                })?;
                parts.push(NativeInput::Resource {
                    uri: format!("rho://attachments/{}/{}", task.task.task_id, asset.asset_id),
                    text,
                    mime_type: asset.mime_type,
                });
            }
        }
        let providers = self.context_providers.read().unwrap().clone();
        let reader = crate::AgentContextReader::new(&scope.project, host, context);
        for selection in &draft.content.context {
            let captured = crate::agent_context::preview(
                &reader,
                &task.attachment.controller.clone().into(),
                selection,
                &providers,
                true,
            )
            .await
            .map_err(NativeTaskFailure::before)?;
            parts.extend(crate::agent_context::input(captured).map_err(NativeTaskFailure::before)?);
        }
        Ok(parts)
    }
    pub fn asset(
        &self,
        context: &CallContext,
        project: &str,
        task: &str,
        asset: &str,
    ) -> Result<(AgentAsset, Vec<u8>), ApplicationError> {
        self.owner
            .store
            .agent_asset(&scope(project, context)?, task, asset)
            .map_err(Into::into)
    }
}
struct NativeCommandPort {
    service: Arc<AgentTaskService>,
    host: Arc<NextHost>,
    context: CallContext,
    endpoint: String,
}
#[async_trait::async_trait]
impl NativeTaskPort for NativeCommandPort {
    async fn input(
        &self,
        scope: &AgentTaskScope,
        task: &StoredAgentTask,
        draft: &AgentTaskDraft,
    ) -> Result<Vec<NativeInput>, NativeTaskFailure> {
        self.service
            .input(&self.host, &self.context, scope, task, draft)
            .await
    }
    async fn endpoint(
        &self,
        scope: &AgentTaskScope,
        task: &StoredAgentTask,
    ) -> Result<NativeTaskEndpoint, NativeTaskFailure> {
        let lease = Arc::new(self.service.mcp_connections.issue(
            &scope.project,
            &self.context,
            "task",
            &task.task.task_id,
            task.attachment.generation,
            !task.task_mcp_identity,
        ));
        Ok(NativeTaskEndpoint {
            url: self.endpoint.clone(),
            token: lease.token.clone(),
            lease,
        })
    }
}

#[cfg(test)]
mod tests;
