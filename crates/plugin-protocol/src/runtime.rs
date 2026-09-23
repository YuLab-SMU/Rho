use crate::*;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeSet;
use ts_rs::TS;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct InstanceRef {
    pub instance: PluginInstanceId,
    pub plugin: PluginId,
    pub revision: RevisionId,
    pub artifact: ArtifactId,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "snake_case")]
pub enum InstanceState {
    Preparing,
    Active,
    Draining,
    Released,
    Failed,
    CleanupFailed,
    Disconnected,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct PluginInstance {
    pub identity: InstanceRef,
    pub project: ProjectId,
    pub principal: PrincipalId,
    pub alias: InstanceAlias,
    pub configuration: Value,
    pub state: InstanceState,
    pub diagnostic: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct ProviderBinding {
    pub capability: CapabilityKey,
    pub provider: InstanceRef,
    pub project: ProjectId,
    /// Owner-defined native identity, fixed at admission. Not interpreted by core.
    pub target: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct ResourceReference {
    pub owner: InstanceRef,
    pub resource: ResourceId,
    pub digest: ContentDigest,
    pub media_type: String,
    pub bytes: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct PluginCall {
    pub request: RequestId,
    pub binding: ProviderBinding,
    pub principal: PrincipalId,
    pub scopes: BTreeSet<String>,
    pub arguments: Value,
    pub preconditions: Value,
    pub operation_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct PluginCommitPlan {
    pub outcome: PluginOutcome,
    pub output: Option<Value>,
    pub error: Option<String>,
    pub recovery: Option<Value>,
    pub facts: Vec<ProposedFact>,
    pub evidence: Vec<ResourceReference>,
    /// True only after the owner has confirmed execution stopped.
    pub cancellation_confirmed: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "snake_case")]
pub enum PluginOutcome {
    Succeeded,
    Failed,
    Uncertain,
    Cancelled,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct ProposedFact {
    pub schema: String,
    pub key: String,
    pub value: Value,
}

/// Each direction has its own strictly increasing sequence starting at one.
/// Connection identity is host-issued and rotated for every transport incarnation.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct RpcFrame {
    pub protocol_version: u32,
    pub connection: ConnectionId,
    pub instance: PluginInstanceId,
    pub sequence: u32,
    pub request: RequestId,
    pub body: RpcBody,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(
    tag = "type",
    content = "data",
    rename_all = "snake_case",
    deny_unknown_fields
)]
pub enum RpcBody {
    Initialize {
        instance: PluginInstance,
        grants: Vec<CapabilityRequirement>,
    },
    Ready {
        revision: RevisionId,
        artifact: ArtifactId,
    },
    Query(PluginCall),
    Invoke(PluginCall),
    QueryResult {
        data: Value,
        completeness: ObservationCompleteness,
        source: Option<ResourceReference>,
    },
    CommitPlan(PluginCommitPlan),
    /// Reverse calls use a delegated, instance-bound grant, never a Host credential.
    HostCall {
        capability: CapabilityKey,
        arguments: Value,
    },
    HostResult {
        result: Value,
    },
    Cancel {
        operation_id: String,
    },
    CancelAcknowledged {
        operation_id: String,
        confirmed: bool,
    },
    Release,
    Released,
    Error {
        code: String,
        message: String,
        recovery: Option<Value>,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "snake_case")]
pub enum ObservationCompleteness {
    Complete,
    Partial,
    Cached,
    Unavailable,
}

impl RpcFrame {
    pub fn decode(bytes: &[u8]) -> Result<Self, ProtocolError> {
        require(
            bytes.len() <= MAX_CONTROL_BYTES,
            "RPC control frame exceeds byte limit",
        )?;
        let frame: Self =
            serde_json::from_slice(bytes).map_err(|e| ProtocolError(e.to_string()))?;
        require(
            frame.protocol_version == PLUGIN_PROTOCOL_VERSION && frame.sequence > 0,
            "unsupported protocol or sequence",
        )?;
        Ok(frame)
    }
    pub fn encode(&self) -> Result<Vec<u8>, ProtocolError> {
        let bytes = serde_json::to_vec(self).map_err(|e| ProtocolError(e.to_string()))?;
        Self::decode(&bytes)?;
        Ok(bytes)
    }
}

/// This guard is constructed from the Host's transport registry, not incoming data.
pub struct RpcSessionGuard {
    instance: PluginInstanceId,
    connection: ConnectionId,
    next_sequence: u32,
    revoked: bool,
}
impl RpcSessionGuard {
    pub fn new(instance: PluginInstanceId, connection: ConnectionId) -> Self {
        Self {
            instance,
            connection,
            next_sequence: 1,
            revoked: false,
        }
    }
    pub fn revoke(&mut self) {
        self.revoked = true;
    }
    pub fn accept(&mut self, bytes: &[u8]) -> Result<RpcFrame, ProtocolError> {
        require(!self.revoked, "instance channel has been revoked")?;
        let frame = RpcFrame::decode(bytes)?;
        require(
            frame.instance == self.instance && frame.connection == self.connection,
            "message belongs to a different instance or connection",
        )?;
        require(
            frame.sequence == self.next_sequence,
            "stale or out-of-order message",
        )?;
        self.next_sequence = self
            .next_sequence
            .checked_add(1)
            .ok_or_else(|| ProtocolError("sequence exhausted; reconnect explicitly".into()))?;
        Ok(frame)
    }
}
