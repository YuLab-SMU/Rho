//! Shared application mutation service for project-scoped data.
//!
//! This module provides [`ProjectMutationService`], a thin typed wrapper over
//! a mutable [`Store`] reference that normalizes project roots consistently
//! and delegates to existing store mutation methods. Like
//! [`ProjectQueryService`], it is the shared application seam used by both
//! Tauri commands and deterministic scenario tests.
//!
//! ## Design constraints
//!
//! * No `tauri` / TUI / DOM dependency — depends only on `rho-store` types.
//! * No new SQLite, runtime, project, credential, or approval authority.
//! * No schema / persistence / public protocol change.
//! * Mutations are project-scoped: the normalized `project_root` is passed to
//!   every underlying `Store` method so foreign-project rows are never touched.
//! * Stable error category via `StoreError`.

use crate::{Store, StoreError, query::required_project_root};

/// Read-write application mutation service for project-scoped data.
///
/// Each mutation method normalizes the project root using
/// the shared required-project validator before delegating to the underlying [`Store`]
/// method. This ensures consistent path handling across all adapters (Tauri,
/// CLI, MCP, tests) and fixes a pre-existing drift where some Tauri commands
/// used `replace('\\\\', "/")` (lightweight) while others used
/// `normalize_project_root` (full).
pub struct ProjectMutationService<'a> {
    store: &'a mut Store,
}

impl<'a> ProjectMutationService<'a> {
    /// Create a new mutation service wrapping the given mutable store
    /// reference.
    pub fn new(store: &'a mut Store) -> Self {
        Self { store }
    }

    /// Request cancellation of a run.
    ///
    /// The project root is normalized via `normalize_project_root` before
    /// mutating. Returns `true` if the run was active and cancel-requested,
    /// `false` otherwise.
    pub fn request_cancel(&mut self, project_root: &str, run_id: &str) -> Result<bool, StoreError> {
        let normalized = required_project_root(project_root)?;
        self.store.request_cancel(&normalized, run_id)
    }

    /// Clear agent conversation history for the given project.
    ///
    /// The project root is normalized via `normalize_project_root` before
    /// mutating. Returns the number of deleted turns.
    pub fn clear_agent_history(&mut self, project_root: &str) -> Result<usize, StoreError> {
        let normalized = required_project_root(project_root)?;
        self.store.clear_agent_history(&normalized)
    }

    /// Delete an agent conversation and its turns.
    ///
    /// The project root is normalized via `normalize_project_root` before
    /// mutating. Returns the number of deleted turns.
    pub fn delete_agent_conversation(
        &mut self,
        project_root: &str,
        conversation_id: &str,
    ) -> Result<usize, StoreError> {
        let normalized = required_project_root(project_root)?;
        self.store
            .delete_agent_conversation(&normalized, conversation_id)
    }

    /// Create a new evidence entry.
    ///
    /// The project root is normalized via `normalize_project_root` before
    /// mutating.
    pub fn create_evidence_entry(
        &mut self,
        draft: &crate::EvidenceEntryDraft,
    ) -> Result<crate::EvidenceEntry, StoreError> {
        let mut normalized_draft = draft.clone();
        normalized_draft.project_root = required_project_root(&draft.project_root)?;
        self.store.create_evidence_entry(&normalized_draft)
    }

    /// Delete an evidence entry.
    ///
    /// The project root is normalized via `normalize_project_root` before
    /// mutating. Returns `true` if a row was deleted.
    pub fn delete_evidence_entry(
        &mut self,
        project_root: &str,
        id: i64,
    ) -> Result<bool, StoreError> {
        let normalized = required_project_root(project_root)?;
        self.store.delete_evidence_entry(&normalized, id)
    }

    /// Clear plot artifacts for the given project.
    ///
    /// The project root is normalized via `normalize_project_root` before
    /// querying. Returns the number of deleted artifacts.
    pub fn clear_plot_artifacts(
        &mut self,
        project_root: &str,
        workspace_id: Option<&str>,
        session_only: bool,
    ) -> Result<usize, StoreError> {
        let normalized = required_project_root(project_root)?;
        self.store
            .clear_plot_artifacts(Some(&normalized), workspace_id, session_only)
    }

    /// Clear artifact records for the given project.
    ///
    /// The project root is normalized via `normalize_project_root` before
    /// mutating. Returns the number of deleted records.
    pub fn clear_artifact_records(
        &mut self,
        project_root: &str,
        workspace_id: Option<&str>,
        session_only: bool,
    ) -> Result<usize, StoreError> {
        let normalized = required_project_root(project_root)?;
        self.store
            .clear_artifact_records(&normalized, workspace_id, session_only)
    }
}
