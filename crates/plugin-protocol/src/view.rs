//! Isolated view lifecycle and the public browser channel. State belongs to one
//! exact source revision; closing a view never requests backend cancellation.
use crate::*;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use ts_rs::TS;

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct OpenPluginView {
    pub instance: InstanceRef,
    pub contribution: ContributionId,
    pub window: WindowId,
    pub configuration: Value,
    pub state: Value,
    /// Immutable resource context; it confers no resource-read authority.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub resource: Option<ResourceReference>,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct PluginViewArguments {
    pub view: ViewInstanceId,
}
#[derive(Debug, Default, Clone, Serialize, Deserialize, JsonSchema, TS)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum PluginViewCloseMode {
    /// Ask the connected view to flush its draft before native closure.
    #[default]
    Flush,
    /// Explicit recovery when cooperation is unavailable. Keeps exactly this
    /// acknowledged version; does not claim that local edits have been saved.
    RetainAcknowledged { expected_version: u32 },
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct ClosePluginView {
    pub view: ViewInstanceId,
    #[serde(default)]
    pub mode: PluginViewCloseMode,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS)]
#[serde(tag = "phase", rename_all = "snake_case", deny_unknown_fields)]
pub enum PluginViewCloseState {
    Open,
    Requested { operation: OperationId },
    Prepared { operation: OperationId, state_version: u32 },
    Refused { operation: OperationId, reason: String },
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct PluginViewLifecycle {
    pub view: ViewInstanceId,
    pub state_version: u32,
    pub close: PluginViewCloseState,
}
/// Sent by the containing shell after this exact document is destroyed. The
/// private credential must never enter a plugin frame or an Operation journal.
#[derive(Clone, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct ReleasePluginViewRenderer {
    pub view: ViewInstanceId,
    pub connection: ConnectionId,
    pub window: WindowId,
    pub renderer: RequestId,
    pub call_token: String,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct PluginViewRendererRelease {
    pub view: ViewInstanceId,
    pub renderer: RequestId,
    /// False on an identical repeat. This acknowledges only deregistration,
    /// never saved content, view closure or backend release.
    pub released: bool,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct UpdatePluginView {
    pub view: ViewInstanceId,
    /// An owner-specific state version, never a global scientific revision.
    pub expected_version: u32,
    pub state: Value,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct PluginViewRecord {
    pub view: ViewInstanceId,
    /// Omitted for normal runtime views. Fixture mode never grants native calls.
    #[serde(default, skip_serializing_if = "PluginInstancePurpose::is_runtime")]
    #[ts(as = "Option<_>", optional)]
    pub purpose: PluginInstancePurpose,
    pub instance: InstanceRef,
    pub project: ProjectId,
    pub principal: PrincipalId,
    pub contribution: ContributionId,
    pub window: WindowId,
    pub configuration: Value,
    pub state: Value,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub resource: Option<ResourceReference>,
    pub state_version: u32,
    pub closed: bool,
}
/// Host-observed calling view identity. This contains no bridge or asset token
/// and cannot be presented as a credential for another call.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct PluginViewOrigin {
    pub view: ViewInstanceId,
    pub window: WindowId,
    pub connection: ConnectionId,
}
/// `None` means the admitted caller was not a view. A captured view that is no
/// longer present fails the observation rather than becoming a non-view caller.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct PluginViewCaller {
    pub view: Option<PluginViewOrigin>,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct PluginViewConnection {
    pub view: PluginViewRecord,
    pub connection: ConnectionId,
    pub next_sequence: u32,
    /// Short-lived asset authority for this view's exact immutable artifact only.
    pub asset_token: String,
    /// Retained by the containing shell. Never sent to the iframe or stored in
    /// Operation records, scenarios, view state or source packages.
    pub call_token: String,
    pub entrypoint: PackagePath,
    pub grants: Vec<CapabilityRequirement>,
}

/// Every request crosses the containing shell's scoped Host port. No browser
/// credential, project root or user identity is accepted from the iframe.
#[derive(Clone, Serialize, Deserialize, JsonSchema, TS)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
pub enum PluginViewRequest {
    /// Register only after installing the local close-time flush handler.
    RegisterCloseHandler { renderer: RequestId },
    ObserveLifecycle { renderer: RequestId },
    PrepareClose {
        renderer: RequestId,
        operation: OperationId,
        state_version: u32,
    },
    RefuseClose {
        renderer: RequestId,
        operation: OperationId,
        reason: String,
    },
    /// Reserve a browser text-copy action while the user gesture is current.
    /// Host validation is not confirmation that the clipboard was written.
    BeginTextCopy,
    FinishTextCopy {
        copy_id: RequestId,
        text: String,
    },
    CancelTextCopy {
        copy_id: RequestId,
    },
    /// Request a new browser tab after an explicit gesture. The Host verifies
    /// view authority; only the container can acknowledge native navigation.
    OpenExternalUrl { url: String },
    /// Open this containing window's counterpart in an explicitly selected
    /// disposable project. The shell alone constructs its private launch URL.
    OpenTestWorkspace { test_project: TestProjectId },
    /// Admit an explicit original-resource download. This is not evidence that
    /// the containing browser requested or completed a file download.
    DownloadResource { reference: ResourceReference, filename: String },
    /// Download exact package bytes through the declared archive-read port.
    /// Presentation acknowledgement alone does not prove that a file was saved.
    DownloadArchive { reference: PluginArchiveReference, filename: String },
    Control {
        capability: CapabilityKey,
        arguments: Value,
    },
    Query {
        capability: CapabilityKey,
        arguments: Value,
    },
    Invoke {
        request_id: RequestId,
        capability: CapabilityKey,
        arguments: Value,
        preconditions: Vec<Value>,
    },
    GetOperation {
        operation_id: String,
    },
    Cancel {
        operation_id: String,
    },
    SetState {
        expected_version: u32,
        state: Value,
    },
}
impl std::fmt::Debug for PluginViewRequest {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let kind = match self {
            Self::RegisterCloseHandler { .. } => "RegisterCloseHandler",
            Self::ObserveLifecycle { .. } => "ObserveLifecycle",
            Self::PrepareClose { .. } => "PrepareClose",
            Self::RefuseClose { .. } => "RefuseClose",
            Self::BeginTextCopy => "BeginTextCopy",
            Self::FinishTextCopy { .. } => "FinishTextCopy",
            Self::CancelTextCopy { .. } => "CancelTextCopy",
            Self::OpenExternalUrl { .. } => "OpenExternalUrl",
            Self::OpenTestWorkspace { .. } => "OpenTestWorkspace",
            Self::DownloadResource { .. } => "DownloadResource",
            Self::DownloadArchive { .. } => "DownloadArchive",
            Self::Control { .. } => "Control",
            Self::Query { .. } => "Query",
            Self::Invoke { .. } => "Invoke",
            Self::GetOperation { .. } => "GetOperation",
            Self::Cancel { .. } => "Cancel",
            Self::SetState { .. } => "SetState",
        };
        f.write_str(kind)?;
        f.write_str(" ([payload redacted])")
    }
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct PluginViewMessage {
    pub protocol_version: u32,
    pub connection: ConnectionId,
    pub view: ViewInstanceId,
    pub sequence: u32,
    pub request: RequestId,
    /// Select only an already live child for ordinary port calls. Intrinsic
    /// view state, close cooperation and presentation stay with this view.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub test_project: Option<TestProjectId>,
    pub body: PluginViewRequest,
}
