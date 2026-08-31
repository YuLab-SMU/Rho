use std::collections::BTreeSet;

use rho_protocol::{ArtifactDigest, ExecutionSpec, ExecutionSpecError, ExecutorKind};
use serde::{Deserialize, Serialize};
use thiserror::Error;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ExecutionAdapterRoute {
    Workspace,
    Local,
    Oci,
    SshRunner,
    Slurm,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct PreparedAdapterInput {
    pub spec: ExecutionSpec,
    pub canonical_digest: ArtifactDigest,
    pub route: ExecutionAdapterRoute,
}

#[derive(Debug, Error)]
pub enum AdapterSpecError {
    #[error("ExecutionSpec validation failed: {0}")]
    Validation(#[from] ExecutionSpecError),
}

pub fn prepare_adapter_input(
    spec: ExecutionSpec,
    negotiated_extensions: &BTreeSet<String>,
) -> Result<PreparedAdapterInput, AdapterSpecError> {
    let canonical_digest = spec.digest(negotiated_extensions)?;
    let route = match spec.executor {
        ExecutorKind::Workspace => ExecutionAdapterRoute::Workspace,
        ExecutorKind::LocalProcess => ExecutionAdapterRoute::Local,
        ExecutorKind::Oci => ExecutionAdapterRoute::Oci,
        ExecutorKind::SshRunner => ExecutionAdapterRoute::SshRunner,
        ExecutorKind::Slurm => ExecutionAdapterRoute::Slurm,
    };
    Ok(PreparedAdapterInput {
        spec,
        canonical_digest,
        route,
    })
}

pub fn spec_boundary() -> (&'static [&'static str], &'static [&'static str]) {
    (
        &["canonical_digest", "adapter_route", "negotiated_extensions"],
        &[
            "agent_provider_branch",
            "ui_provider_branch",
            "remote_shell_string",
            "secret_material",
        ],
    )
}
