use super::WorkspaceRunHandler;
use async_trait::async_trait;
pub use rho_contract::{
    BindingSummary, PackageQueryArguments, PackageSnapshotData, WorkspaceSnapshotData,
};
use rho_contract::{
    CancellationClass, CapabilityDescriptor, CapabilityKind, CapabilityRef, IdempotencyClass,
    ObservationCompleteness, QuerySnapshot, QueryStatus, RetryClass, TargetRef,
};
use rho_contract::{
    ListObjectsArguments, ObjectDirectoryPage, ObjectObservation, ObjectReadPage,
    ObserveObjectArguments, PackageIndexArguments, PackageIndexPage, ReadObjectArguments,
};
use rho_operation::{Clock, OperationError, QueryHandler, SystemClock};
use schemars::schema_for;

use serde_json::Value;

pub use rho_r_api::{WorkspaceQueryScope, ScopedWorkspaceArguments, SnapshotArguments, InspectArguments, WorkspaceQuery, WORKSPACE_READ_SCOPE, SNAPSHOT_QUERY_ID, INSPECT_QUERY_ID, MAX_SNAPSHOT_ITEMS, MAX_PREVIEW_ITEMS};
use std::{collections::BTreeSet, sync::Arc};

pub struct WorkspaceObservation {
    pub session_id: String,
    pub source: String,
    pub observed_at_ms: i64,
    pub data: Value,
    pub completeness: ObservationCompleteness,
    pub notices: Vec<String>,
}

pub use rho_r_api::WorkspaceQueryKind;

pub struct WorkspaceQueryHandler {
    descriptor: CapabilityDescriptor,
    kind: WorkspaceQueryKind,
    owner: Arc<WorkspaceRunHandler>,
}
impl WorkspaceQueryHandler {
    pub fn new(owner: Arc<WorkspaceRunHandler>, kind: WorkspaceQueryKind) -> Self {
        let (id, input_schema) = match kind {
            WorkspaceQueryKind::ReadHelp => (
                "workspace.read_help",
                schema_for!(rho_contract::ReadPackageHelpArguments).to_value(),
            ),
            WorkspaceQueryKind::ListObjects => (
                "workspace.list_objects",
                schema_for!(ListObjectsArguments).to_value(),
            ),
            WorkspaceQueryKind::ObserveObject => (
                "workspace.observe_object",
                schema_for!(ObserveObjectArguments).to_value(),
            ),
            WorkspaceQueryKind::ReadObject => (
                "workspace.read_object",
                schema_for!(ReadObjectArguments).to_value(),
            ),
            WorkspaceQueryKind::PackageIndex => (
                "workspace.package_index",
                schema_for!(PackageIndexArguments).to_value(),
            ),
            WorkspaceQueryKind::Packages => (
                "workspace.packages",
                schema_for!(PackageQueryArguments).to_value(),
            ),
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
                documentation: rho_contract::builtin_documentation(id),
                recovery_schema: serde_json::json!({"type":"null"}),
                domain: "workspace".into(),
                input_schema,
                output_schema: match kind {
                    WorkspaceQueryKind::ReadHelp => {
                        schema_for!(rho_contract::PackageHelpPage).to_value()
                    }
                    WorkspaceQueryKind::ListObjects => schema_for!(ObjectDirectoryPage).to_value(),
                    WorkspaceQueryKind::ObserveObject => schema_for!(ObjectObservation).to_value(),
                    WorkspaceQueryKind::ReadObject => schema_for!(ObjectReadPage).to_value(),
                    WorkspaceQueryKind::PackageIndex => schema_for!(PackageIndexPage).to_value(),
                    WorkspaceQueryKind::Packages => schema_for!(PackageSnapshotData).to_value(),
                    WorkspaceQueryKind::Snapshot => schema_for!(WorkspaceSnapshotData).to_value(),
                    WorkspaceQueryKind::InspectObject => schema_for!(BindingSummary).to_value(),
                },
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
        self.kind.parse(arguments).map_err(|error| OperationError::InvalidInput(error.to_string()))
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
            WorkspaceQuery::Packages(args) => serde_json::to_value(args),
            WorkspaceQuery::InspectObject(args) => serde_json::to_value(args),
            WorkspaceQuery::ListObjects(a) => serde_json::to_value(a.arguments),
            WorkspaceQuery::ObserveObject(a) => serde_json::to_value(a.arguments),
            WorkspaceQuery::ReadObject(a) => serde_json::to_value(a.arguments),
            WorkspaceQuery::PackageIndex(a) => serde_json::to_value(a.arguments),
            WorkspaceQuery::ReadHelp(a) => serde_json::to_value(a.arguments),
        }
        .map_err(|e| OperationError::InvalidInput(e.to_string()))
    }

    async fn query(&self, arguments: &Value) -> Result<QuerySnapshot, OperationError> {
        if matches!(
            self.kind,
            WorkspaceQueryKind::ListObjects
                | WorkspaceQueryKind::ObserveObject
                | WorkspaceQueryKind::ReadObject
                | WorkspaceQueryKind::PackageIndex
                | WorkspaceQueryKind::ReadHelp
        ) {
            return Err(OperationError::InvalidInput(
                "Reference-bearing Workspace queries require trusted CallContext".into(),
            ));
        }
        self.query_bound(None, arguments).await
    }
    async fn query_for(
        &self,
        context: &rho_contract::CallContext,
        arguments: &Value,
    ) -> Result<QuerySnapshot, OperationError> {
        self.query_bound(Some(context), arguments).await
    }
}
impl WorkspaceQueryHandler {
    async fn query_bound(
        &self,
        context: Option<&rho_contract::CallContext>,
        arguments: &Value,
    ) -> Result<QuerySnapshot, OperationError> {
        let mut query = self.parse(arguments)?;
        if let Some(context) = context {
            let scope = WorkspaceQueryScope {
                project: self.owner.runtime.project_root().unwrap_or_default().into(),
                principal: serde_json::to_string(context.principal())
                    .map_err(|e| OperationError::InvalidInput(e.to_string()))?,
                session: self.owner.runtime.session_id().into(),
            };
            query.bind_scope(scope);
        }
        let target = TargetRef {
            kind: "workspace".into(),
            identity: self.owner.runtime.session_id().into(),
        };
        if query
            .expected_session()
            .is_some_and(|session| session != target.identity)
        {
            return Err(OperationError::StaleSession(
                "query names a stale Workspace session".into(),
            ));
        }
        let mut snapshot = QuerySnapshot {
            next_reads: Vec::new(),
            diagnostics: Vec::new(),
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
                if let Err(error) = &result
                    && let Some(code) = error.query_code.as_deref()
                {
                    return Err(match code {
                        "observation_expired" | "observation_invalid" => {
                            OperationError::ObservationExpired(error.message.clone())
                        }
                        "content_changed" => OperationError::ContentChanged(error.message.clone()),
                        "not_found" => OperationError::NotFound(error.message.clone()),
                        "budget_exhausted" => OperationError::BudgetExceeded(error.message.clone()),
                        "unavailable" | "unsupported" => {
                            OperationError::Unavailable(error.message.clone())
                        }
                        _ => OperationError::InvalidInput(error.message.clone()),
                    });
                }
                snapshot.status = QueryStatus::Unavailable;
                snapshot.notices.push(match result {
                    Err(error) => error.message,
                    Ok(_) => "query response belongs to a different R session".into(),
                });
            }
        }
        if snapshot.status == QueryStatus::Ready {
            let id = self.descriptor.capability.id.as_str();
            let mut bound = arguments.clone();
            bound["expected_session"] = serde_json::json!(snapshot.target.identity);
            if let Some(data) = &snapshot.data {
                match self.kind {
                    WorkspaceQueryKind::ReadHelp=>{
                        if let Some(offset)=data.get("next_offset_utf8").filter(|value|!value.is_null()) {
                            bound["offset_utf8"]=offset.clone();bound["expected_help_files"]=data["help_files"].clone();
                            snapshot.next_reads.push(rho_contract::NextRead::query(id,"Continue the same help file identities",bound));
                        }
                    },
                    WorkspaceQueryKind::Snapshot=>snapshot.next_reads.push(rho_contract::NextRead::query("workspace.list_objects","Browse a stable complete binding directory",serde_json::json!({"expected_session":snapshot.target.identity,"limit":100}))),
                    WorkspaceQueryKind::InspectObject=>snapshot.next_reads.push(rho_contract::NextRead::query("workspace.observe_object","Open an observation that supports continued investigation",serde_json::json!({"expected_session":snapshot.target.identity,"name":arguments["name"]}))),
                    WorkspaceQueryKind::ObserveObject=>snapshot.next_reads.push(rho_contract::NextRead::query("workspace.read_object","Read metadata and supported structure from this exact observation",serde_json::json!({"expected_session":snapshot.target.identity,"object_ref":data["object_ref"],"kind":"structure"}))),
                    WorkspaceQueryKind::ListObjects|WorkspaceQueryKind::Packages|WorkspaceQueryKind::PackageIndex=>{
                        if let Some(offset)=data.get("next_offset").filter(|value|!value.is_null()) {
                            bound["offset"]=offset.clone();
                            for reference in ["directory_ref","observation_id","index_ref"] {if let Some(value)=data.get(reference).filter(|value|!value.is_null()){bound[reference]=value.clone();}}
                            snapshot.next_reads.push(rho_contract::NextRead::query(id,"Continue the same native observation and filters",bound));
                        }
                    },
                    WorkspaceQueryKind::ReadObject=>{
                        for (source,destination,purpose) in [("next_start","start","Read the next values, children or row slice"),("next_column_start","column_start","Read the next column slice at the same starting row"),("next_text_start","text_start","Continue the same long text value")] {
                            if let Some(value)=data.get(source).filter(|value|!value.is_null()){let mut next=bound.clone();next[destination]=value.clone();snapshot.next_reads.push(rho_contract::NextRead::query(id,purpose,next));}
                        }
                    },
                }
            }
        }
        if matches!(
            self.kind,
            WorkspaceQueryKind::ListObjects
                | WorkspaceQueryKind::ObserveObject
                | WorkspaceQueryKind::ReadObject
        ) {
            let bytes = |snapshot: &QuerySnapshot| {
                serde_json::to_vec(snapshot)
                    .map(|bytes| bytes.len())
                    .map_err(|error| OperationError::Contract(error.to_string()))
            };
            if bytes(&snapshot)? > 256 * 1024 && !snapshot.next_reads.is_empty() {
                snapshot.notices.push("Bound next-read arguments exceed this page's byte budget. Use the exact reference, path and continuation fields returned in data; no object content was omitted by this navigation limit.".into());
                while bytes(&snapshot)? > 256 * 1024 && !snapshot.next_reads.is_empty() {
                    snapshot.next_reads.pop();
                }
            }
            if bytes(&snapshot)? > 256 * 1024 {
                return Err(OperationError::BudgetExceeded("Object observation exceeds 256 KiB including its envelope; narrow the filter, path or page size".into()));
            }
        }
        Ok(snapshot)
    }
}
