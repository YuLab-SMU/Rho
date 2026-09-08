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
use schemars::{JsonSchema, schema_for};
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Serialize)]
pub struct WorkspaceQueryScope {
    pub project: String,
    pub principal: String,
    pub session: String,
}
#[derive(Debug, Clone, Serialize)]
pub struct ScopedWorkspaceArguments<T> {
    #[serde(flatten)]
    pub arguments: T,
    pub scope: WorkspaceQueryScope,
}
impl<T> ScopedWorkspaceArguments<T> {
    fn unbound(arguments: T) -> Self {
        Self {
            arguments,
            scope: WorkspaceQueryScope {
                project: String::new(),
                principal: String::new(),
                session: String::new(),
            },
        }
    }
}

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
    Packages(PackageQueryArguments),
    ListObjects(ScopedWorkspaceArguments<ListObjectsArguments>),
    ObserveObject(ScopedWorkspaceArguments<ObserveObjectArguments>),
    ReadObject(ScopedWorkspaceArguments<ReadObjectArguments>),
    PackageIndex(ScopedWorkspaceArguments<PackageIndexArguments>),
}
impl WorkspaceQuery {
    fn expected_session(&self) -> Option<&str> {
        match self {
            Self::Snapshot(arguments) => arguments.expected_session.as_deref(),
            Self::InspectObject(arguments) => arguments.expected_session.as_deref(),
            Self::Packages(arguments) => arguments.expected_session.as_deref(),
            Self::ListObjects(a) => Some(&a.arguments.expected_session),
            Self::ObserveObject(a) => Some(&a.arguments.expected_session),
            Self::ReadObject(a) => Some(&a.arguments.expected_session),
            Self::PackageIndex(a) => Some(&a.arguments.expected_session),
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
    Packages,
    Snapshot,
    InspectObject,
    ListObjects,
    ObserveObject,
    ReadObject,
    PackageIndex,
}

pub struct WorkspaceQueryHandler {
    descriptor: CapabilityDescriptor,
    kind: WorkspaceQueryKind,
    owner: Arc<WorkspaceRunHandler>,
}
impl WorkspaceQueryHandler {
    pub fn new(owner: Arc<WorkspaceRunHandler>, kind: WorkspaceQueryKind) -> Self {
        let (id, input_schema) = match kind {
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
        let invalid = |e: serde_json::Error| OperationError::InvalidInput(e.to_string());
        match self.kind {
            WorkspaceQueryKind::ListObjects => {
                let a: ListObjectsArguments =
                    serde_json::from_value(arguments.clone()).map_err(invalid)?;
                if a.limit == 0
                    || a.limit > 200
                    || a.name_contains.len() > 4096
                    || a.name_contains.contains('\0')
                    || a.object_type.as_ref().is_some_and(|v| v.len() > 64)
                    || (a.directory_ref.is_none() && a.offset != 0)
                {
                    return Err(OperationError::InvalidInput("Object listing requires limit 1..=200, bounded filters, and a directory reference for continuation".into()));
                }
                validate_reference(a.directory_ref.as_deref())?;
                Ok(WorkspaceQuery::ListObjects(
                    ScopedWorkspaceArguments::unbound(a),
                ))
            }
            WorkspaceQueryKind::ObserveObject => {
                let a: ObserveObjectArguments =
                    serde_json::from_value(arguments.clone()).map_err(invalid)?;
                if a.name.is_empty() || a.name.len() > 4096 || a.name.contains('\0') {
                    return Err(OperationError::InvalidInput(
                        "Object name must contain 1..=4096 UTF-8 bytes without NUL".into(),
                    ));
                }
                validate_path(&a.path)?;
                Ok(WorkspaceQuery::ObserveObject(
                    ScopedWorkspaceArguments::unbound(a),
                ))
            }
            WorkspaceQueryKind::ReadObject => {
                let a: ReadObjectArguments =
                    serde_json::from_value(arguments.clone()).map_err(invalid)?;
                validate_reference(Some(&a.object_ref))?;
                validate_path(&a.path)?;
                if a.start == 0
                    || a.start > 9007199254740991
                    || a.limit == 0
                    || a.limit > 200
                    || a.column_start == 0
                    || a.column_limit == 0
                    || a.column_limit > 50
                    || a.text_attribute
                        .as_deref()
                        .is_some_and(|v| !["names", "levels"].contains(&v))
                    || a.text_start == 0
                    || a.text_start > 9007199254740991
                    || a.text_limit_bytes == 0
                    || a.text_limit_bytes > 65536
                {
                    return Err(OperationError::InvalidInput("Object reads require one-based indices, limit 1..=200, column_limit 1..=50, and text_limit_bytes 1..=65536".into()));
                }
                Ok(WorkspaceQuery::ReadObject(
                    ScopedWorkspaceArguments::unbound(a),
                ))
            }
            WorkspaceQueryKind::PackageIndex => {
                let a: PackageIndexArguments =
                    serde_json::from_value(arguments.clone()).map_err(invalid)?;
                validate_reference(a.index_ref.as_deref())?;
                validate_reference(Some(&a.observation_id))?;
                if a.limit == 0
                    || a.limit > 200
                    || a.filter.len() > 512
                    || a.package.is_empty()
                    || a.package.len() > 128
                    || !a
                        .package
                        .bytes()
                        .all(|c| c.is_ascii_alphanumeric() || c == b'.')
                    || a.library_path.len() > 16384
                    || a.library_path.contains('\0')
                    || a.kind.as_deref().is_some_and(|v| {
                        !["export", "alias", "topic", "declaration", "unresolved"].contains(&v)
                    })
                    || (a.index_ref.is_none() && a.offset != 0)
                {
                    return Err(OperationError::InvalidInput("Package index requires an exact observed package copy, limit 1..=200, bounded filter, and index reference for continuation".into()));
                }
                Ok(WorkspaceQuery::PackageIndex(
                    ScopedWorkspaceArguments::unbound(a),
                ))
            }
            WorkspaceQueryKind::Packages => {
                let args: PackageQueryArguments =
                    serde_json::from_value(arguments.clone()).map_err(invalid)?;
                if args.limit == 0
                    || args.limit > 200
                    || args.offset > 10000
                    || args.filter.chars().count() > 128
                    || args.filter.contains('\0')
                    || args.observation_id.as_ref().is_some_and(|id| {
                        id.len() > 64
                            || id.is_empty()
                            || !id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_')
                    })
                    || args.package_name.as_ref().is_some_and(|name| {
                        name.is_empty()
                            || name.len() > 128
                            || !name.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'.')
                    })
                {
                    return Err(OperationError::InvalidInput("Packages requires limit 1..=200, offset <= 10000 and a filter of at most 128 characters".into()));
                }
                if args.observation_id.is_some() && args.expected_session.is_none() {
                    return Err(OperationError::InvalidInput(
                        "Cached package reads require expected_session".into(),
                    ));
                }
                Ok(WorkspaceQuery::Packages(args))
            }

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
            WorkspaceQuery::Packages(args) => serde_json::to_value(args),
            WorkspaceQuery::InspectObject(args) => serde_json::to_value(args),
            WorkspaceQuery::ListObjects(a) => serde_json::to_value(a.arguments),
            WorkspaceQuery::ObserveObject(a) => serde_json::to_value(a.arguments),
            WorkspaceQuery::ReadObject(a) => serde_json::to_value(a.arguments),
            WorkspaceQuery::PackageIndex(a) => serde_json::to_value(a.arguments),
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
            match &mut query {
                WorkspaceQuery::ListObjects(a) => a.scope = scope,
                WorkspaceQuery::ObserveObject(a) => a.scope = scope,
                WorkspaceQuery::ReadObject(a) => a.scope = scope,
                WorkspaceQuery::PackageIndex(a) => a.scope = scope,
                _ => {}
            }
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

fn validate_reference(reference: Option<&str>) -> Result<(), OperationError> {
    if reference.is_some_and(|v| {
        v.is_empty() || v.len() > 128 || !v.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_')
    }) {
        return Err(OperationError::InvalidInput(
            "Invalid Workspace observation reference".into(),
        ));
    }
    Ok(())
}
fn validate_path(path: &[rho_contract::ObjectPathElement]) -> Result<(), OperationError> {
    if path.len() > 32
        || path.iter().any(|step| match step {
            rho_contract::ObjectPathElement::Index { index } => {
                *index == 0 || *index > 9007199254740991
            }
            rho_contract::ObjectPathElement::Name { name } => {
                name.len() > 4096 || name.contains('\0')
            }
        })
    {
        return Err(OperationError::InvalidInput(
            "Object paths allow at most 32 exact names or positive R indices".into(),
        ));
    }
    Ok(())
}
