use crate::*;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use ts_rs::TS;

/// An explicit backend test gets a fresh native project and journal. No existing
/// project path, session, provider binding or launch credential is accepted.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct CreatePluginTestProject {
    pub name: String,
    pub instances: BTreeMap<InstanceAlias, ScenarioInstance>,
}
impl CreatePluginTestProject {
    pub fn validate(&self) -> Result<(), ProtocolError> {
        bounded_text(&self.name, 160, "test project name")?;
        require(
            (1..=16).contains(&self.instances.len()),
            "a test project needs 1–16 exact instance selections",
        )?;
        require(
            serde_json::to_vec(self)
                .map_err(|e| ProtocolError(e.to_string()))?
                .len()
                <= MAX_CONTROL_BYTES / 4,
            "test project selection exceeds 256 KiB",
        )?;
        for instance in self.instances.values() {
            require(
                instance
                    .dependencies
                    .values()
                    .all(|alias| self.instances.contains_key(alias)),
                "test project dependency alias is absent",
            )?;
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "snake_case")]
pub enum PluginTestProjectState {
    Preparing,
    Ready,
    Stopping,
    Stopped,
    Failed,
}

/// Historical lifecycle metadata. Ready alone never proves a prior Host or
/// backend still exists; use the observation's explicit native-presence flag.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct PluginTestProject {
    pub id: TestProjectId,
    pub source_project: ProjectId,
    pub principal: PrincipalId,
    pub source_operation_id: OperationId,
    pub project: ProjectId,
    pub directory: String,
    pub selection: CreatePluginTestProject,
    pub version: u64,
    pub state: PluginTestProjectState,
    pub instances: BTreeMap<InstanceAlias, InstanceRef>,
    pub activation_operations: BTreeMap<InstanceAlias, OperationId>,
    pub diagnostic: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct PluginTestProjectObservation {
    pub project: PluginTestProject,
    pub observed_in_this_host: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct PluginTestProjectArguments {
    pub id: TestProjectId,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct PluginTestOperationArguments {
    pub id: TestProjectId,
    pub operation_id: OperationId,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct StopPluginTestProject {
    pub id: TestProjectId,
    pub expected_version: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct ListPluginTestProjects {
    pub after: Option<TestProjectId>,
    #[schemars(range(min = 1, max = 100))]
    pub limit: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct PluginTestProjectPage {
    #[schemars(length(max = 100))]
    pub projects: Vec<PluginTestProjectObservation>,
    pub next: Option<TestProjectId>,
}
