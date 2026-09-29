use crate::{arguments::*, manifest};
use rho_annotation_api::*;
use rho_annotation_owner::*;
use rho_annotation_store::AnnotationStore;
use rho_plugin_sdk::{HostCallClient, protocol::*};
use serde::{Serialize, de::DeserializeOwned};
use serde_json::{Value, json};
use std::{path::Path, sync::Arc};

#[derive(Debug)]
pub struct Failure {
    pub code: &'static str,
    pub message: String,
}
impl Failure {
    pub fn invalid(message: impl ToString) -> Self {
        Self {
            code: "invalid_input",
            message: message.to_string(),
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
impl From<AnnotationError> for Failure {
    fn from(error: AnnotationError) -> Self {
        let code = match error {
            AnnotationError::NotFound => "not_found",
            AnnotationError::Conflict => "conflict",
            AnnotationError::RequestConflict => "request_conflict",
            AnnotationError::Budget(_) => "budget_exceeded",
            AnnotationError::Storage(_) => "annotation_storage_unavailable",
            _ => "invalid_input",
        };
        let message = if code == "annotation_storage_unavailable" {
            "Annotation storage is unavailable; inspect the original request before retrying".into()
        } else {
            error.to_string()
        };
        Self { code, message }
    }
}
pub fn decode<T: DeserializeOwned>(value: &Value) -> Result<T, Failure> {
    serde_json::from_value(value.clone()).map_err(Failure::invalid)
}
pub fn encoded(value: impl Serialize) -> Result<Value, Failure> {
    serde_json::to_value(value).map_err(Failure::invalid)
}
pub fn now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}
pub struct Metadata {
    pub(crate) instance: PluginInstance,
    pub(crate) scope: AnnotationScope,
    pub(crate) grants: Vec<CapabilityRequirement>,
    pub(crate) owner: AnnotationOwner,
}
impl Metadata {
    pub fn new(
        instance: PluginInstance,
        environment: BackendEnvironment,
        grants: Vec<CapabilityRequirement>,
    ) -> Result<Self, String> {
        decode::<Empty>(&instance.configuration).map_err(|e| e.message)?;
        for directory in [&environment.project_root, &environment.data_root] {
            let path = Path::new(directory);
            if !path.is_absolute()
                || !path.is_dir()
                || path.canonicalize().map_err(|e| e.to_string())? != path
            {
                return Err(
                    "Annotations require existing canonical Host-issued directories".into(),
                );
            }
        }
        let path = Path::new(&environment.data_root).join("annotations-v1.sqlite");
        if let Ok(meta) = std::fs::symlink_metadata(&path) {
            if !meta.is_file() || meta.file_type().is_symlink() {
                return Err("Annotation storage is not a private regular file".into());
            }
        }
        let owner = AnnotationOwner::new(Arc::new(AnnotationStore::open(&path)?));
        Ok(Self {
            scope: AnnotationScope {
                project: environment.project_root,
                principal: instance.principal.to_string(),
            },
            instance,
            grants,
            owner,
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
            || manifest::is_operation(call.binding.capability.id.as_str()) != Some(operation)
        {
            return Err(Failure::invalid(
                "Annotation call differs from its admitted identity, contract or native preconditions",
            ));
        }
        if !call.scopes.contains(if operation {
            "application.control"
        } else {
            "application.read"
        }) || !call.scopes.contains("plugins.read")
        {
            return Err(Failure {
                code: "access_denied",
                message: "Original annotation call lacks its declared scopes".into(),
            });
        }
        Ok(())
    }
    pub(crate) fn actor(&self, caller: &PluginViewCaller) -> AnnotationActor {
        let window = match &caller.view {
            Some(origin) => AnnotationWindowRef {
                window_id: origin.window.to_string(),
                incarnation: format!("view:{}", origin.view),
            },
            None => AnnotationWindowRef {
                window_id: format!("annotations:{}", self.instance.identity.instance),
                incarnation: format!("instance:{}", self.instance.identity.instance),
            },
        };
        AnnotationActor::admitted(self.scope.clone(), window)
    }
    pub async fn execute(
        &self,
        call: &PluginCall,
        host: &HostCallClient,
    ) -> Result<Value, Failure> {
        let caller = crate::sources::caller(self, call, host).await?;
        match call.binding.capability.id.as_str() {
            "annotations.capture.import" => {
                return crate::captures::import(self, call, host, &caller).await;
            }
            "annotations.capture.read" => {
                return crate::captures::read(self, decode(&call.arguments)?);
            }
            _ => (),
        }
        if call.binding.capability.id.as_str() != "annotations.write" {
            return match call.binding.capability.id.as_str() {
                "annotations.read" => self.read(decode(&call.arguments)?),
                "annotations.context.search" => {
                    crate::contexts::search(self, decode(&call.arguments)?, &caller)
                }
                "annotations.context.preview" => {
                    crate::contexts::preview(self, decode(&call.arguments)?, &caller)
                }
                _ => Err(Failure::invalid("Unknown annotation query")),
            };
        }
        let arguments: WriteRequest = decode(&call.arguments)?;
        let actor = self.actor(&caller);
        let command = match arguments.command {
            WriteCommand::Freeze {
                reference,
                inclusion,
                anchor,
            } => {
                reference.validate().map_err(Failure::invalid)?;
                crate::sources::window(&caller, &reference.window)?;
                AnnotationCommand::Freeze {
                    selection: AnnotationSelection {
                        source: "plugin".into(),
                        label: "Selected contribution".into(),
                        reference: encoded(reference)?,
                        inclusion: serde_json::to_string(&crate::sources::canonical(inclusion))
                            .map_err(Failure::invalid)?,
                    },
                    session: None,
                    anchor: anchor.into(),
                }
            }
            WriteCommand::Create {
                evidence_id,
                note,
                labels,
                marks,
                continued_from,
            } => AnnotationCommand::Create {
                evidence_id,
                note,
                labels,
                marks,
                continued_from,
            },
            WriteCommand::Update {
                expected,
                note,
                labels,
                marks,
            } => AnnotationCommand::Update {
                expected,
                note,
                labels,
                marks,
            },
            WriteCommand::Delete { expected } => AnnotationCommand::Delete { expected },
        };
        let request = AnnotationsCommand {
            project_root: self.scope.project.clone(),
            window: actor.window().clone(),
            request_id: arguments.request_id,
            command,
        };
        // Never observe a source again on an exact replay, even if its current version is gone.
        if let Some(saved) = self.owner.receipt(&self.scope, &request.request_id)? {
            if !self.owner.replay_matches(&request, &saved)? {
                return Err(AnnotationError::RequestConflict.into());
            }
            return encoded(saved.receipt);
        }
        if let AnnotationCommand::Freeze {
            selection, anchor, ..
        } = &request.command
        {
            validate_anchor(anchor)?;
            let frozen = crate::sources::freeze(self, call, host, selection, anchor).await?;
            if crate::sources::caller(self, call, host).await? != caller {
                return Err(Failure::invalid(
                    "The original caller changed before annotation admission",
                ));
            }
            return encoded(self.owner.freeze(&actor, &request, frozen, now())?);
        }
        // The framed principal is Host-authenticated. Do not invent a human/Agent author kind.
        let author = AnnotationAuthor {
            kind: AnnotationAuthorKind::Principal,
            id: call.principal.to_string(),
        };
        encoded(self.owner.write(&actor, &author, &request, now())?)
    }
    fn read(&self, request: ReadRequest) -> Result<Value, Failure> {
        match request {
            ReadRequest::List {
                source_id,
                after,
                limit,
                include_deleted,
            } => {
                let (items, next_after) = self.owner.list(
                    &self.scope,
                    source_id.as_deref(),
                    after.as_deref(),
                    limit,
                    include_deleted,
                )?;
                encoded(AnnotationQueryResult::List { items, next_after })
            }
            ReadRequest::Read { annotation } => {
                let (revision, evidence) = self.owner.read(&self.scope, &annotation)?;
                encoded(AnnotationQueryResult::Read { revision, evidence })
            }
            ReadRequest::Evidence { evidence_id } => encoded(AnnotationQueryResult::Evidence {
                evidence: self.owner.evidence(&self.scope, &evidence_id)?,
            }),
            ReadRequest::Receipt { request_id } => encoded(AnnotationQueryResult::CommandStatus {
                receipt: self
                    .owner
                    .receipt(&self.scope, &request_id)?
                    .map(|r| r.receipt),
            }),
        }
    }
}
