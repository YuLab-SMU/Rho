use super::WorkspaceRunHandler;
use async_trait::async_trait;
pub use rho_contract::{BindingSummary, WorkspaceSnapshotData};
use rho_contract::{
    CancellationClass, CapabilityDescriptor, CapabilityKind, CapabilityRef, IdempotencyClass,
    ObservationCompleteness, QuerySnapshot, QueryStatus, RetryClass, TargetRef,
};
use rho_operation::{Clock, OperationError, QueryHandler, SystemClock};
use schemars::{JsonSchema, schema_for};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{collections::BTreeSet, sync::Arc};

pub const WORKSPACE_READ_SCOPE: &str = "workspace.read";
pub const SNAPSHOT_QUERY_ID: &str = "workspace.snapshot";
pub const INSPECT_QUERY_ID: &str = "workspace.inspect_object";
pub const MAX_SNAPSHOT_ITEMS: u32 = 200;
pub const MAX_PREVIEW_ITEMS: u32 = 100;

fn default_limit() -> u32 {
    MAX_SNAPSHOT_ITEMS
}
fn default_preview_items() -> u32 {
    20
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct SnapshotArguments {
    #[serde(default = "default_limit")]
    #[schemars(range(min = 1, max = 200))]
    pub limit: u32,
    #[serde(default)]
    pub expected_session: Option<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct InspectArguments {
    #[schemars(length(min = 1, max = 1024))]
    pub name: String,
    #[serde(default = "default_preview_items")]
    #[schemars(range(min = 1, max = 100))]
    pub max_items: u32,
    #[serde(default)]
    pub expected_session: Option<String>,
}

#[derive(Debug, Clone)]
pub enum WorkspaceQuery {
    Snapshot(SnapshotArguments),
    InspectObject(InspectArguments),
}
impl WorkspaceQuery {
    fn expected_session(&self) -> Option<&str> {
        match self {
            Self::Snapshot(arguments) => arguments.expected_session.as_deref(),
            Self::InspectObject(arguments) => arguments.expected_session.as_deref(),
        }
    }
}

pub struct WorkspaceObservation {
    pub session_id: String,
    pub source: String,
    pub observed_at_ms: i64,
    pub data: Value,
    pub completeness: ObservationCompleteness,
    pub notices: Vec<String>,
}

#[derive(Clone, Copy)]
pub enum WorkspaceQueryKind {
    Snapshot,
    InspectObject,
}

pub struct WorkspaceQueryHandler {
    descriptor: CapabilityDescriptor,
    kind: WorkspaceQueryKind,
    owner: Arc<WorkspaceRunHandler>,
}
impl WorkspaceQueryHandler {
    pub fn new(owner: Arc<WorkspaceRunHandler>, kind: WorkspaceQueryKind) -> Self {
        let (id, input_schema) = match kind {
            WorkspaceQueryKind::Snapshot => {
                (SNAPSHOT_QUERY_ID, schema_for!(SnapshotArguments).to_value())
            }
            WorkspaceQueryKind::InspectObject => {
                (INSPECT_QUERY_ID, schema_for!(InspectArguments).to_value())
            }
        };
        Self {
            descriptor: CapabilityDescriptor {
                kind: CapabilityKind::Query,
                capability: CapabilityRef::new(id, 1).unwrap(),
                domain: "workspace".into(),
                input_schema,
                output_schema: schema_for!(QuerySnapshot).to_value(),
                required_scopes: BTreeSet::from([WORKSPACE_READ_SCOPE.into()]),
                potential_effects: BTreeSet::new(),
                idempotency: IdempotencyClass::Pure,
                retry: RetryClass::Safe,
                cancellation: CancellationClass::Unsupported,
            },
            kind,
            owner,
        }
    }

    fn parse(&self, arguments: &Value) -> Result<WorkspaceQuery, OperationError> {
        let invalid = |e: serde_json::Error| OperationError::InvalidInput(e.to_string());
        match self.kind {
            WorkspaceQueryKind::Snapshot => {
                let args: SnapshotArguments =
                    serde_json::from_value(arguments.clone()).map_err(invalid)?;
                if args.limit == 0 || args.limit > MAX_SNAPSHOT_ITEMS {
                    return Err(OperationError::InvalidInput(
                        "snapshot limit must be 1..=200".into(),
                    ));
                }
                Ok(WorkspaceQuery::Snapshot(args))
            }
            WorkspaceQueryKind::InspectObject => {
                let args: InspectArguments =
                    serde_json::from_value(arguments.clone()).map_err(invalid)?;
                if args.name.is_empty()
                    || args.name.len() > 4096
                    || args.name.chars().count() > 1024
                    || args.name.contains('\0')
                    || args.max_items == 0
                    || args.max_items > MAX_PREVIEW_ITEMS
                {
                    return Err(OperationError::InvalidInput(
                        "inspect requires a bounded name and max_items in 1..=100".into(),
                    ));
                }
                Ok(WorkspaceQuery::InspectObject(args))
            }
        }
    }
}

#[async_trait]
impl QueryHandler for WorkspaceQueryHandler {
    fn descriptor(&self) -> &CapabilityDescriptor {
        &self.descriptor
    }
    fn normalize_arguments(&self, arguments: &Value) -> Result<Value, OperationError> {
        let query = self.parse(arguments)?;
        match query {
            WorkspaceQuery::Snapshot(args) => serde_json::to_value(args),
            WorkspaceQuery::InspectObject(args) => serde_json::to_value(args),
        }
        .map_err(|e| OperationError::InvalidInput(e.to_string()))
    }

    async fn query(&self, arguments: &Value) -> Result<QuerySnapshot, OperationError> {
        let query = self.parse(arguments)?;
        let target = TargetRef {
            kind: "workspace".into(),
            identity: self.owner.runtime.session_id().into(),
        };
        if query
            .expected_session()
            .is_some_and(|session| session != target.identity)
        {
            return Err(OperationError::InvalidInput(
                "query names a stale Workspace session".into(),
            ));
        }
        let mut snapshot = QuerySnapshot {
            target,
            source: "workspace".into(),
            observed_at_ms: SystemClock.now_ms()?,
            status: QueryStatus::Busy,
            completeness: ObservationCompleteness::Unknown,
            data: None,
            notices: Vec::new(),
        };
        let Ok(_lane) = self.owner.lane.try_lock() else {
            snapshot
                .notices
                .push("Workspace is busy; no R query was submitted.".into());
            return Ok(snapshot);
        };
        match self.owner.runtime.query(&query).await {
            Ok(observation) if observation.session_id == snapshot.target.identity => {
                snapshot.source = observation.source;
                snapshot.observed_at_ms = observation.observed_at_ms;
                snapshot.status = QueryStatus::Ready;
                snapshot.completeness = observation.completeness;
                snapshot.data = Some(observation.data);
                snapshot.notices = observation.notices;
            }
            result => {
                snapshot.status = QueryStatus::Unavailable;
                snapshot.notices.push(match result {
                    Err(error) => error.message,
                    Ok(_) => "query response belongs to a different R session".into(),
                });
            }
        }
        Ok(snapshot)
    }
}
