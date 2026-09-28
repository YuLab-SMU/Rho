//! Explicit targets distinguish native Host ports from ordinary plugin bindings.
//! A recorded target describes original scope; it is never a dispatch credential.
use rho_plugin_protocol::{CapabilityKey, PluginRequest, ProjectId, ProviderBinding};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;
use ts_rs::TS;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
pub enum AgentNativeToolTarget {
    Provider {
        binding: ProviderBinding,
    },
    Host {
        project: ProjectId,
        capability: CapabilityKey,
        /// Captured by the caller before Send, for example its selected branch.
        /// Model arguments cannot include or replace these top-level fields.
        fixed_arguments: BTreeMap<String, Value>,
    },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
pub enum AgentNativeToolRequest {
    Provider {
        request: PluginRequest,
    },
    Host {
        project: ProjectId,
        capability: CapabilityKey,
        /// Complete native input, including the caller's captured fields.
        arguments: Value,
    },
}

impl AgentNativeToolRequest {
    pub fn capability(&self) -> &CapabilityKey {
        match self {
            Self::Provider { request } => &request.binding.capability,
            Self::Host { capability, .. } => capability,
        }
    }

    /// Native Host ports consume their own argument contract; ordinary providers
    /// retain the public PluginRequest envelope and exact provider identity.
    pub fn host_arguments(&self) -> Value {
        match self {
            Self::Provider { request } => serde_json::to_value(request).unwrap(),
            Self::Host { arguments, .. } => arguments.clone(),
        }
    }
}
