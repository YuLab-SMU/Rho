use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "snake_case")]
pub enum EffectClass {
    Read,
    WorkspaceMutation,
    ProjectMutation,
    ExternalEffect,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "snake_case")]
pub enum RetryClass {
    PureRead,
    IdempotentWrite,
    ConditionallyIdempotent,
    NonIdempotent,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, PartialOrd, Ord, Hash)]
#[serde(rename_all = "snake_case")]
pub enum DataClass {
    Public,
    ProjectInternal,
    ProjectConfidential,
    RestrictedSecret,
}

impl DataClass {
    pub fn join(self, other: Self) -> Self {
        self.max(other)
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, PartialOrd, Ord, Hash)]
#[serde(rename_all = "snake_case")]
pub enum TargetClass {
    Workspace,
    ProjectFiles,
    LocalProcess,
    Container,
    RemoteRunner,
    ExternalService,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, PartialOrd, Ord, Hash)]
#[serde(rename_all = "snake_case")]
pub enum DestinationClass {
    LocalWorkspace,
    LocalSandbox,
    ConfiguredProvider,
    AllowlistedDomain,
    UnrestrictedNetwork,
    RemoteExecutor,
}

// PermissionPosture removed: Agent (external ACP) handles all permission logic.
// Rho's job is to expose state and execute requests, not to gate Agent decisions.

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "snake_case")]
pub enum NetworkPolicy {
    Deny,
    ProviderOnly,
    AllowlistedDomains,
    Unrestricted,
}
