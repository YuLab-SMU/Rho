use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use ts_rs::TS;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct RuntimeLaunchBinding {
    pub r_executable: String,
    pub ark_executable: String,
    pub environment_realization_id: Option<String>,
    #[serde(default)]
    pub library_path: Option<String>,
    #[serde(default)]
    pub checkpoint_helper_path: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct RuntimeInstallationIdentity {
    pub r_home: String,
    pub r_version: String,
    pub platform: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct RuntimeProcessIdentity {
    pub native_session_id: String,
    pub pid: u32,
    pub start_time: u64,
}
