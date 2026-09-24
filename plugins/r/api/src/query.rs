use crate::*;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
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
    pub fn unbound(arguments: T) -> Self {
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
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, ts_rs::TS)]
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
    ReadHelp(ScopedWorkspaceArguments<crate::ReadPackageHelpArguments>),
}
impl WorkspaceQuery {
    pub fn bind_scope(&mut self, scope: WorkspaceQueryScope) {
        match self {
            Self::ListObjects(arguments) => arguments.scope = scope,
            Self::ObserveObject(arguments) => arguments.scope = scope,
            Self::ReadObject(arguments) => arguments.scope = scope,
            Self::PackageIndex(arguments) => arguments.scope = scope,
            Self::ReadHelp(arguments) => arguments.scope = scope,
            _ => {}
        }
    }

    pub fn expected_session(&self) -> Option<&str> {
        match self {
            Self::Snapshot(arguments) => arguments.expected_session.as_deref(),
            Self::InspectObject(arguments) => arguments.expected_session.as_deref(),
            Self::Packages(arguments) => arguments.expected_session.as_deref(),
            Self::ListObjects(a) => Some(&a.arguments.expected_session),
            Self::ObserveObject(a) => Some(&a.arguments.expected_session),
            Self::ReadObject(a) => Some(&a.arguments.expected_session),
            Self::PackageIndex(a) => Some(&a.arguments.expected_session),
            Self::ReadHelp(a) => Some(&a.arguments.expected_session),
        }
    }
}
