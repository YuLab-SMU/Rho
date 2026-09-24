use crate::*;
use async_trait::async_trait;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

pub const PROJECT_READ_SCOPE: &str = "project.read";
pub const PROJECT_WRITE_SCOPE: &str = "project.write";
pub const MAX_PROJECT_PATHS: usize = 64;
pub const MAX_PATH_BYTES: usize = 1024;
pub const MAX_PATCH_BYTES: usize = 200 * 1024;

pub fn validate_path(path: &str) -> Result<(), String> {
    if path.is_empty()
        || path.len() > MAX_PATH_BYTES
        || path.starts_with('/')
        || path.contains(['\\', '\0', ':'])
        || path.chars().any(char::is_control)
        || path.split('/').any(|part| {
            part.is_empty() || part == "." || part == ".." || part.eq_ignore_ascii_case(".git")
        })
    {
        return Err("path must be a normalized project-relative path outside .git".into());
    }
    Ok(())
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, ts_rs::TS)]
#[serde(deny_unknown_fields)]
pub struct ReadFileArguments {
    pub path: String,
    #[serde(default)]
    pub offset: u64,
    #[serde(default = "default_read_limit")]
    #[schemars(range(min = 1, max = 65536))]
    pub limit_bytes: u32,
    #[serde(default)]
    pub expected_sha256: Option<String>,
}
fn default_read_limit() -> u32 {
    32 * 1024
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, ts_rs::TS)]
#[serde(deny_unknown_fields)]
pub struct ProjectSnapshotArguments {
    #[serde(default)]
    #[schemars(length(max = 64))]
    pub paths: Vec<String>,
    #[serde(default = "default_limit")]
    #[schemars(range(min = 1, max = 200))]
    pub limit: usize,
}
fn default_limit() -> usize {
    100
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, ts_rs::TS)]
#[serde(deny_unknown_fields)]
pub struct ApplyPatchArguments {
    #[schemars(length(min = 1))]
    pub patch: String,
}

pub struct GitApplyReport {
    pub exit_code: Option<i32>,
    pub diagnostic: String,
}

#[async_trait]
pub trait ProjectRuntime: Send + Sync {
    async fn storage_status(&self) -> Result<ProjectStorage, String> {
        Err("Project disk capacity is unavailable in this provider".into())
    }
    async fn list_directory(
        &self,
        _args: &crate::ListDirectoryArguments,
    ) -> Result<crate::DirectoryPage, String> {
        Err("directory listing unavailable".into())
    }
    async fn read_text(&self, _args: &ReadTextArguments) -> Result<TextPage, ProjectTextError> {
        Err(ProjectTextError::Unavailable(
            "text reads are unavailable in this provider".into(),
        ))
    }
    async fn search_text(
        &self,
        _args: &SearchTextArguments,
    ) -> Result<SearchTextPage, ProjectTextError> {
        Err(ProjectTextError::Unavailable(
            "text search is unavailable in this provider".into(),
        ))
    }
    fn root(&self) -> &str;
    async fn snapshot(&self, paths: &[String], limit: usize) -> Result<ProjectSnapshot, String>;
    async fn patch_paths(&self, patch: &str) -> Result<Vec<String>, String>;
    async fn check_patch(&self, patch: &str) -> Result<(), String>;
    async fn apply_patch(&self, patch: &str) -> GitApplyReport;
    async fn read_file(&self, _args: &ReadFileArguments) -> Result<FilePage, String> {
        Err("file byte reads are unavailable in this provider".into())
    }
}
