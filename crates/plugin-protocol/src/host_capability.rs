//! Read-only contracts for native Host ports. These are metadata, not grants or
//! provider bindings. Ordinary plugin capabilities retain their exact instance
//! and immutable-manifest inspection path.
use crate::{CapabilityKey, CapabilityKind, ProjectId};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeSet;
use ts_rs::TS;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct HostCapabilityArguments {
    pub capability: CapabilityKey,
}

/// The exact current startup contract in this project. Dynamic contributions
/// cannot acquire a Host identity by using this query. Reading a write contract
/// does not grant its scopes or invoke it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct HostCapabilityContract {
    pub project: ProjectId,
    pub capability: CapabilityKey,
    pub kind: CapabilityKind,
    pub description: String,
    pub input_schema: Value,
    pub required_scopes: BTreeSet<String>,
}
