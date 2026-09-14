//! Human handoff coordination; draft writes stay under their original owner lock.
use crate::{AgentTaskService, ApplicationStore, ComponentAgentService, NextHost};
use rho_application::{AgentHandoffOwner, ApplicationError, ComponentActor};
use rho_contract::*;
use serde_json::json;
use std::sync::Arc;

pub struct AgentHandoffService {
    owner: AgentHandoffOwner,
}

impl AgentHandoffService {
    pub fn new(store: Arc<ApplicationStore>) -> Self {
        Self { owner: AgentHandoffOwner::new(store) }
    }

    fn actor(host: &NextHost, context: &CallContext, project: &str, window: &ApplicationWindowRef)
        -> Result<ComponentActor, ApplicationError> {
        crate::application::studio(context).map_err(|error| Self::native_error(host, context, error))?;
        if !host.runtime._project_lease.as_ref().is_some_and(|lease|lease.root().to_str()==Some(project)) {
            return Err(ApplicationError::Diagnostic(Box::new(Diagnostic {
                code: DiagnosticCode::Unavailable, continuation: DiagnosticContinuation::ReadAgain,
                message: "The handoff belongs to a different project".into(), next_reads: vec![],
            })));
        }
        host.application_owner().map_err(|error| Self::native_error(host, context, error))?
            .component_actor(context, window, Self::now())
    }

    fn now() -> u64 {
        std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_millis() as u64
    }

    fn native_error(host: &NextHost, context: &CallContext, error: rho_operation::OperationError) -> ApplicationError {
        ApplicationError::Diagnostic(Box::new(host.runtime.gateway.diagnostic(context, &error)))
    }

    async fn scientific_context(tasks: &AgentTaskService, host: &NextHost, context: &CallContext,
        project: &str, source: &ProjectAgentTaskRef) -> Result<Vec<AgentContextSelection>, ApplicationError> {
        let ProjectAgentTaskRef::Native { task_id } = source else { return Ok(vec![]); };
        let observed = tasks.query(host, context, AgentTasksQuery {
            project_root: project.into(), query: AgentTaskQuery::ScientificWork { task_id: task_id.clone(), limit: 17 },
        }).await?;
        let AgentTaskQueryResult::ScientificWork { work } = observed else { return Err(ApplicationError::NotFound); };
        // The caller-scoped journal supplies these IDs. No task ID or operation
        // claimed in a model answer can contribute to the handoff references.
        Ok(work.operations.into_iter().map(|operation| AgentContextSelection {
            source: "operations".into(), label: format!("Run {}", operation.operation_id.as_str()),
            reference: json!({"operation_id":operation.operation_id}), inclusion: "summary".into(),
        }).collect())
    }

    pub async fn query(&self, tasks: &AgentTaskService, host: &NextHost, context: &CallContext,
        request: AgentHandoffsQuery) -> Result<AgentHandoffQueryResult, ApplicationError> {
        let actor = Self::actor(host, context, &request.project_root, &request.window)?;
        Ok(match request.query {
            AgentHandoffQuery::Source { source } => {
                let extra = Self::scientific_context(tasks, host, context, &request.project_root, &source).await?;
                AgentHandoffQueryResult::Source { source: self.owner.source(actor.scope(), &source, &extra)? }
            }
            AgentHandoffQuery::Target { target } => AgentHandoffQueryResult::Target {
                target: self.owner.target(actor.scope(), &target, &request.window)?,
            },
            AgentHandoffQuery::Receipt { request_id } => AgentHandoffQueryResult::Receipt {
                receipt: self.owner.receipt(actor.scope(), &request_id)?,
            },
        })
    }

    pub async fn transfer(&self, tasks: &AgentTaskService, rho: &ComponentAgentService,
        host: &NextHost, context: &CallContext, request: &AgentHandoffCommand)
        -> Result<AgentHandoffReceipt, ApplicationError> {
        let actor = Self::actor(host, context, &request.project_root, &request.window)?;
        let repeated = self.owner.receipt(actor.scope(), &request.request_id)?.is_some();
        let extra = if repeated {
            vec![] // Exact replay is resolved before re-reading changing source material.
        } else {
            Self::scientific_context(tasks, host, context, &request.project_root, &request.source).await?
        };
        if !repeated {
            let material = self.owner.source(actor.scope(), &request.source, &extra)?;
            if material.revision != request.source_revision { return Err(rho_application::handoff_source_expired()); }
            let allowed = material.context.iter().map(rho_application::handoff_context_key)
                .collect::<Result<std::collections::BTreeSet<_>, _>>()?;
            for selection in &request.context {
                if !allowed.contains(&rho_application::handoff_context_key(selection)?) {
                    return Err(ApplicationError::InvalidInput("This reference does not belong to the source task".into()));
                }
                let observed = tasks.query(host, context, AgentTasksQuery {
                    project_root: request.project_root.clone(), query: AgentTaskQuery::ContextPreview {
                        window: request.window.clone(), selection: selection.clone(),
                    },
                }).await?;
                if let AgentTaskQueryResult::ContextPreview { preview } = observed
                    && preview.selection.reference != selection.reference {
                    return Err(ApplicationError::InvalidInput("Preview and save the current reference in the source task before handing it off".into()));
                }
                if let ProjectAgentTaskRef::Rho { conversation_id } = &request.target {
                    let target = rho.conversation(host, context, &request.project_root, conversation_id)?;
                    let preview = rho.preview_source(host, context, ComponentSourcePreviewRequest {
                        project_root: request.project_root.clone(), window: request.window.clone(),
                        session: target.draft_grant.and_then(|grant| grant.session), selection: selection.clone(),
                    }).await?;
                    if let Some(message) = preview.error {
                        return Err(ApplicationError::InvalidInput(format!("This source is unavailable to the target task: {message}")));
                    }
                }
            }
        }
        let commit = || self.owner.transfer(&actor, request, &extra, Self::now());
        match request.target {
            ProjectAgentTaskRef::Native { .. } => tasks.with_handoff_write(commit),
            ProjectAgentTaskRef::Rho { .. } => rho.with_handoff_write(commit),
        }
    }
}
