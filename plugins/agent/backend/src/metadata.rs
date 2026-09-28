use crate::arguments::*;
use rho_agent_api::{AgentControllerRef, ComponentAgentConversation};
use rho_agent_owner::component::{
    ComponentActor, ComponentActorValidator, ComponentAgentOwner, ComponentTaskError,
};
use rho_agent_owner::{AgentTaskRepository, AgentTaskScope};
use rho_agent_store::AgentStore;
use rho_plugin_sdk::protocol::*;
use serde::de::DeserializeOwned;
use serde_json::{Value, json};
use std::{
    path::Path,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
};

pub struct Metadata {
    pub owner: ComponentAgentOwner,
    store: Arc<AgentStore>,
    instance: PluginInstance,
    scope: AgentTaskScope,
}

pub fn now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

pub struct Failure {
    pub code: &'static str,
    pub message: String,
}
impl Failure {
    pub fn invalid(message: &str) -> Self {
        Self {
            code: "invalid_input",
            message: message.into(),
        }
    }
    pub fn body(self) -> RpcBody {
        RpcBody::Error {
            code: self.code.into(),
            message: self.message,
            recovery: None,
        }
    }
}
impl From<ComponentTaskError> for Failure {
    fn from(error: ComponentTaskError) -> Self {
        let code = match &error {
            ComponentTaskError::Storage(_) => "agent_storage_unavailable",
            ComponentTaskError::NotFound => "not_found",
            ComponentTaskError::Conflict | ComponentTaskError::IncarnationChanged => "conflict",
            ComponentTaskError::RequestConflict => "request_conflict",
            ComponentTaskError::Offline => "unavailable",
            ComponentTaskError::Budget(_) => "budget_exceeded",
            ComponentTaskError::AccessDenied { .. } | ComponentTaskError::InvalidBridge => {
                "access_denied"
            }
            _ => "invalid_input",
        };
        let message = if matches!(error, ComponentTaskError::Storage(_)) {
            "Agent metadata storage is unavailable; retain the original request".into()
        } else {
            error.to_string()
        };
        Self { code, message }
    }
}
pub fn decode<T: DeserializeOwned>(value: &Value) -> Result<T, Failure> {
    serde_json::from_value(value.clone())
        .map_err(|_| Failure::invalid("Arguments do not match the declared Agent contract"))
}
fn encoded(value: impl serde::Serialize) -> Result<Value, Failure> {
    serde_json::to_value(value).map_err(|_| Failure::invalid("Agent metadata could not be encoded"))
}

// The native query was made for this active, already-admitted parent. This actor
// is constructed and consumed synchronously, with no intervening await or reuse.
// It does not retain the observation as authority for later calls/model actions.
struct CurrentAdmission {
    observed_at: u64,
    unused: AtomicBool,
}
impl ComponentActorValidator for CurrentAdmission {
    fn validate(&self, now: u64) -> Result<(), ComponentTaskError> {
        if now != self.observed_at || !self.unused.swap(false, Ordering::SeqCst) {
            return Err(ComponentTaskError::Offline);
        }
        Ok(())
    }
}

impl Metadata {
    pub fn new(instance: PluginInstance, environment: BackendEnvironment) -> Result<Self, String> {
        decode::<Empty>(&instance.configuration).map_err(|e| e.message)?;
        for directory in [&environment.project_root, &environment.data_root] {
            let path = Path::new(directory);
            if !path.is_absolute()
                || !path.is_dir()
                || path
                    .canonicalize()
                    .map_err(|_| "Agent directories are unavailable")?
                    != path
            {
                return Err("Agent requires the existing normalized native project and instance directories".into());
            }
        }
        let store = Arc::new(
            AgentStore::open(&Path::new(&environment.data_root).join("agent-v1.sqlite"))
                .map_err(|_| "Agent instance storage is unavailable")?,
        );
        let scope = AgentTaskScope {
            project: environment.project_root,
            principal: instance.principal.to_string(),
        };
        let owner = ComponentAgentOwner::new(store.clone(), uuid::Uuid::new_v4().to_string());
        Ok(Self {
            owner,
            store,
            instance,
            scope,
        })
    }
    pub fn validate(
        &self,
        request: &RequestId,
        call: &PluginCall,
        operation: bool,
    ) -> Result<(), Failure> {
        if &call.request != request
            || call.binding.provider != self.instance.identity
            || call.binding.project != self.instance.project
            || call.principal != self.instance.principal
            || operation != call.operation_id.is_some()
            || call.binding.capability.version != 1
            || call.binding.target.is_some()
            || !(call.preconditions.is_null() || call.preconditions == json!([]))
            || !call.owner_context.is_null()
        {
            return Err(Failure::invalid(
                "Agent call differs from its admitted identity or native preconditions",
            ));
        }
        let scope = if operation {
            "application.control"
        } else {
            "application.read"
        };
        if !call.scopes.contains(scope) || (operation && !call.scopes.contains("plugins.read")) {
            return Err(Failure {
                code: "access_denied",
                message: "Original Agent call lacks its declared scope".into(),
            });
        }
        if operation != crate::manifest::is_mutation(call.binding.capability.id.as_str()) {
            return Err(Failure::invalid(
                "Agent capability does not match the requested call kind",
            ));
        }
        Ok(())
    }
    pub fn read(&self, call: &PluginCall) -> Result<Value, Failure> {
        match call.binding.capability.id.as_str() {
            "agent.tasks" => {
                let args: TaskList = decode(&call.arguments)?;
                if !(1..=20).contains(&args.limit)
                    || args.before.as_ref().is_some_and(|v| v.len() > 512)
                {
                    return Err(Failure::invalid("Agent task page bounds are invalid"));
                }
                // This metadata composition has no running native or model loops.
                // Retained active records remain interrupted observations, never restarted.
                encoded(
                    self.store
                        .project_agent_tasks(
                            &self.scope,
                            args.archived,
                            args.before.as_deref(),
                            args.limit as usize,
                            &self.owner.host_incarnation,
                            &self.owner.host_incarnation,
                            &[],
                        )
                        .map_err(ComponentTaskError::from)?,
                )
            }
            "agent.model.conversation" => {
                let args: Conversation = decode(&call.arguments)?;
                encoded(self.conversation(&args.conversation_id)?)
            }
            "agent.model.settings" => {
                let _: Empty = decode(&call.arguments)?;
                encoded(self.owner.store.component_settings(&self.scope)?)
            }
            _ => Err(Failure::invalid("Agent query is not implemented")),
        }
    }
    fn conversation(&self, id: &str) -> Result<ComponentAgentConversation, Failure> {
        if id.is_empty() || id.len() > 160 {
            return Err(Failure::invalid("Invalid conversation identity"));
        }
        Ok(self
            .owner
            .store
            .component_conversation(&self.scope, id)?
            .ok_or(ComponentTaskError::NotFound)?)
    }
    pub fn mutate(&self, call: &PluginCall, caller: PluginViewCaller) -> Result<Value, Failure> {
        let controller = match caller.view {
            Some(origin) => AgentControllerRef {
                window_id: origin.window.to_string(),
                incarnation: format!("{}:{}", origin.view, origin.connection),
            },
            // A direct native caller has its own controller namespace. It cannot
            // masquerade as a view or implicitly take over another controller.
            None => AgentControllerRef {
                window_id: format!("agent:{}", self.instance.identity.instance),
                incarnation: self.owner.host_incarnation.clone(),
            },
        };
        let now = now();
        let actor = ComponentActor::new(
            self.scope.clone(),
            controller,
            Arc::new(CurrentAdmission {
                observed_at: now,
                unused: AtomicBool::new(true),
            }),
        );
        match call.binding.capability.id.as_str() {
            "agent.model.create" => {
                let args: CreateConversation = decode(&call.arguments)?;
                encoded(
                    self.owner
                        .create(&actor, &args.conversation_id, args.profile, now)?,
                )
            }
            "agent.model.draft" => {
                let args: SaveDraft = decode(&call.arguments)?;
                self.owner.save_draft_content(
                    &actor,
                    &args.conversation_id,
                    args.draft_version,
                    args.content,
                    args.grant,
                    now,
                )?;
                encoded(self.conversation(&args.conversation_id)?)
            }
            "agent.model.update" => {
                let args: UpdateConversation = decode(&call.arguments)?;
                if args.title.is_none() && args.archived.is_none() {
                    return Err(Failure::invalid("Select a task metadata change"));
                }
                self.owner.update_task_metadata(
                    &actor,
                    &args.conversation_id,
                    args.expected_version,
                    args.title,
                    args.archived,
                    now,
                )?;
                encoded(self.conversation(&args.conversation_id)?)
            }
            "agent.model.take_control" => {
                let args: TakeControl = decode(&call.arguments)?;
                encoded(self.owner.take_control(
                    &actor,
                    &args.conversation_id,
                    args.expected_version,
                    now,
                )?)
            }
            _ => Err(Failure::invalid("Agent mutation is not implemented")),
        }
    }
}
