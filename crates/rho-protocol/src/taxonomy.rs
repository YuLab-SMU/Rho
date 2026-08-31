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

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "snake_case")]
pub enum PermissionPosture {
    AskBeforeChanges,
    AutoWithinPolicy,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "snake_case")]
pub enum DataEgressPosture {
    Deny,
    ConfiguredProviderOnly,
    AllowlistedDestinations,
    AskForUnrestrictedDestination,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "snake_case")]
pub enum BrokerDecisionKind {
    Allow,
    Ask,
    Deny,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "snake_case")]
pub enum NetworkPolicy {
    Deny,
    ProviderOnly,
    AllowlistedDomains,
    UnrestrictedWithApproval,
}
