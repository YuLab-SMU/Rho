//! Trusted BH4 handoff for exact workspace-plugin trash retention.
//!
//! This service owns ordering only: explicit Store expiry, exact purge-pending
//! truth, Broker filesystem purge, then terminal tombstone completion. It does
//! not choose a cutoff, schedule itself, expose a user command, or delete a
//! package from discovery.

use std::path::Path;

use rho_store::{
    PluginLifecycleMutationOutcome, PluginLifecycleMutationService, PluginLifecycleQueryService,
    Store, StoreError, WorkspacePluginPackageTombstone, WorkspacePluginPurgeDraft,
    WorkspacePluginRetentionSweep,
};
use thiserror::Error;

use crate::plugin_package_trash::{
    PluginPackageOwnershipOutcome, PluginPackageTrash, PluginPackageTrashError,
};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PluginRetentionPurgeReport {
    pub plugin_id: String,
    pub package_digest: String,
    pub tombstone_id: String,
    pub file_outcome: PluginPackageOwnershipOutcome,
    pub tombstone: WorkspacePluginPackageTombstone,
}

#[derive(Debug, Error)]
pub enum PluginRetentionError {
    #[error(transparent)]
    Store(#[from] StoreError),
    #[error(transparent)]
    Filesystem(#[from] PluginPackageTrashError),
    #[error("plugin retention purge is not ready: {0}")]
    NotReady(String),
}

#[derive(Debug, Clone, Default)]
pub struct PluginTrashRetentionService {
    trash: PluginPackageTrash,
}

impl PluginTrashRetentionService {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn expire(
        &self,
        store: &mut Store,
        project_root: &str,
        cutoff: &str,
        limit: usize,
    ) -> Result<WorkspacePluginRetentionSweep, PluginRetentionError> {
        PluginLifecycleMutationService::new(store)
            .expire_tombstones(project_root, cutoff, limit)
            .map_err(PluginRetentionError::from)
    }

    pub fn purge_exact_tombstone(
        &self,
        store: &mut Store,
        project_root: &str,
        tombstone_id: &str,
    ) -> Result<PluginRetentionPurgeReport, PluginRetentionError> {
        let tombstone = PluginLifecycleQueryService::new(store)
            .get_tombstone(project_root, tombstone_id)?
            .ok_or_else(|| PluginRetentionError::NotReady("tombstone is missing".to_string()))?;
        let draft = WorkspacePluginPurgeDraft {
            project_root: tombstone.project_root.clone(),
            tombstone_id: tombstone.tombstone_id.clone(),
            plugin_id: tombstone.plugin_id.clone(),
            package_digest: tombstone.package_digest.clone(),
            backup_path_key: tombstone.backup_path_key.clone(),
            original_directory_name: tombstone.original_directory_name.clone(),
        };
        let requested =
            PluginLifecycleMutationService::new(store).request_purge(project_root, &draft)?;
        if !matches!(
            requested.outcome,
            PluginLifecycleMutationOutcome::Applied | PluginLifecycleMutationOutcome::Unchanged
        ) {
            return Err(PluginRetentionError::NotReady(format!(
                "tombstone retention state is {}",
                requested.tombstone.retention_class
            )));
        }
        let file = self.trash.purge_exact(
            Path::new(project_root),
            &draft.original_directory_name,
            &draft.plugin_id,
            &draft.package_digest,
            &draft.backup_path_key,
        )?;
        if !matches!(
            file.outcome,
            PluginPackageOwnershipOutcome::Purged | PluginPackageOwnershipOutcome::AlreadyPurged
        ) {
            return Err(PluginRetentionError::NotReady(
                "filesystem did not prove exact purge completion".to_string(),
            ));
        }
        let completed =
            PluginLifecycleMutationService::new(store).complete_purge(project_root, &draft)?;
        if !matches!(
            completed.outcome,
            PluginLifecycleMutationOutcome::Applied | PluginLifecycleMutationOutcome::Unchanged
        ) {
            return Err(PluginRetentionError::NotReady(
                "terminal purge persistence was stale".to_string(),
            ));
        }
        Ok(PluginRetentionPurgeReport {
            plugin_id: draft.plugin_id,
            package_digest: draft.package_digest,
            tombstone_id: draft.tombstone_id,
            file_outcome: file.outcome,
            tombstone: completed.tombstone,
        })
    }
}

#[cfg(test)]
mod tests {
    use std::fs;

    use rho_store::{
        WorkspacePluginDiscoveredDraft, WorkspacePluginTombstoneDraft,
        WorkspacePluginTransitionAdvance, WorkspacePluginTransitionDraft, normalize_project_root,
    };
    use tempfile::tempdir;

    use super::*;

    fn uninstalled_fixture() -> (
        tempfile::TempDir,
        String,
        Store,
        WorkspacePluginTombstoneDraft,
    ) {
        let temporary = tempdir().unwrap();
        let project = temporary.path().join("project");
        let plugin = project.join(".rho/plugins/example");
        fs::create_dir_all(plugin.join("dist")).unwrap();
        fs::write(plugin.join("dist/plugin.wasm"), b"\0asm").unwrap();
        fs::write(
            plugin.join("rho-plugin.json"),
            serde_json::to_vec(&serde_json::json!({
                "schemaVersion": 1,
                "id": "org.example.plugin",
                "name": "Example",
                "version": "1.0.0",
                "apiVersion": "^1.0",
                "runtime": {"kind":"wasm","entry":"dist/plugin.wasm","scope":"project"}
            }))
            .unwrap(),
        )
        .unwrap();
        let discovered = rho_extension_runtime::discover_workspace_plugins(&project)
            .unwrap()
            .unwrap()
            .plugins
            .into_iter()
            .next()
            .unwrap();
        let project_root =
            normalize_project_root(project.canonicalize().unwrap().to_string_lossy().as_ref());
        let mut store = Store::open(temporary.path().join("rho.sqlite")).unwrap();
        store
            .upsert_discovered_workspace_plugin(&WorkspacePluginDiscoveredDraft {
                project_root: project_root.clone(),
                plugin_id: "org.example.plugin".to_string(),
                directory_name: "example".to_string(),
                plugin_version: "1.0.0".to_string(),
                runtime_kind: "wasm".to_string(),
                discovered_digest: discovered.digest.to_string(),
            })
            .unwrap();
        store
            .request_workspace_plugin_transition(&WorkspacePluginTransitionDraft {
                transition_id: "transition.enable.retention".to_string(),
                project_root: project_root.clone(),
                plugin_id: "org.example.plugin".to_string(),
                kind: "enable".to_string(),
                request_event_type: "user_requested".to_string(),
                desired_state: "enabled".to_string(),
                expected_old_digest: None,
                candidate_digest: Some(discovered.digest.to_string()),
                rollback_digest: None,
                backup_path_key: None,
            })
            .unwrap();
        store
            .advance_workspace_plugin_transition(&WorkspacePluginTransitionAdvance {
                project_root: project_root.clone(),
                transition_id: "transition.enable.retention".to_string(),
                expected_phase: "requested".to_string(),
                next_phase: "completed".to_string(),
                status: "completed".to_string(),
                observed_state: "active".to_string(),
                accepted_digest: Some(discovered.digest.to_string()),
                pending_digest: None,
                rollback_digest: None,
                clear_pending_digest: true,
                last_host_session_id: None,
                last_error_code: None,
                reason_code: None,
                event_type: "transition_completed".to_string(),
                event_status: "completed".to_string(),
                details_json: "{}".to_string(),
            })
            .unwrap();
        store
            .request_workspace_plugin_transition(&WorkspacePluginTransitionDraft {
                transition_id: "transition.uninstall.retention".to_string(),
                project_root: project_root.clone(),
                plugin_id: "org.example.plugin".to_string(),
                kind: "uninstall".to_string(),
                request_event_type: "user_requested".to_string(),
                desired_state: "uninstalled".to_string(),
                expected_old_digest: Some(discovered.digest.to_string()),
                candidate_digest: None,
                rollback_digest: None,
                backup_path_key: Some("trash.retention".to_string()),
            })
            .unwrap();
        PluginPackageTrash::new()
            .move_exact(
                &project,
                "example",
                "org.example.plugin",
                discovered.digest.as_str(),
                "trash.retention",
            )
            .unwrap();
        store
            .advance_workspace_plugin_transition(&WorkspacePluginTransitionAdvance {
                project_root: project_root.clone(),
                transition_id: "transition.uninstall.retention".to_string(),
                expected_phase: "requested".to_string(),
                next_phase: "package_moved".to_string(),
                status: "running".to_string(),
                observed_state: "disposing".to_string(),
                accepted_digest: None,
                pending_digest: None,
                rollback_digest: None,
                clear_pending_digest: false,
                last_host_session_id: None,
                last_error_code: None,
                reason_code: None,
                event_type: "recovery".to_string(),
                event_status: "completed".to_string(),
                details_json: r#"{"package_ownership":"trash"}"#.to_string(),
            })
            .unwrap();
        let tombstone = WorkspacePluginTombstoneDraft {
            tombstone_id: "tombstone.retention".to_string(),
            project_root: project_root.clone(),
            plugin_id: "org.example.plugin".to_string(),
            package_digest: discovered.digest.to_string(),
            backup_path_key: "trash.retention".to_string(),
            original_directory_name: "example".to_string(),
            retention_class: "recoverable".to_string(),
            reason_code: "user_uninstall".to_string(),
        };
        store
            .complete_workspace_plugin_uninstall("transition.uninstall.retention", &tombstone)
            .unwrap();
        (temporary, project_root, store, tombstone)
    }

    #[test]
    fn service_orders_expiry_filesystem_purge_and_terminal_truth() {
        let (temporary, project_root, mut store, tombstone) = uninstalled_fixture();
        let service = PluginTrashRetentionService::new();
        assert!(
            service
                .purge_exact_tombstone(&mut store, &project_root, &tombstone.tombstone_id)
                .is_err()
        );
        let cutoff = PluginLifecycleQueryService::new(&store)
            .get_tombstone(&project_root, &tombstone.tombstone_id)
            .unwrap()
            .unwrap()
            .moved_at;
        service
            .expire(&mut store, &project_root, &cutoff, 1)
            .unwrap();
        let purged = service
            .purge_exact_tombstone(&mut store, &project_root, &tombstone.tombstone_id)
            .unwrap();
        assert_eq!(purged.file_outcome, PluginPackageOwnershipOutcome::Purged);
        assert!(purged.tombstone.deleted_at.is_some());
        assert!(
            !temporary
                .path()
                .join("project/.rho/plugin-trash/trash.retention")
                .exists()
        );
        assert!(
            temporary
                .path()
                .join("project/.rho/plugin-trash")
                .read_dir()
                .unwrap()
                .filter_map(Result::ok)
                .any(|entry| entry
                    .path()
                    .extension()
                    .is_some_and(|value| value == "json"))
        );
        let replay = service
            .purge_exact_tombstone(&mut store, &project_root, &tombstone.tombstone_id)
            .unwrap();
        assert_eq!(
            replay.file_outcome,
            PluginPackageOwnershipOutcome::AlreadyPurged
        );
    }

    #[test]
    fn service_rejects_foreign_project_without_touching_exact_trash() {
        let (temporary, _project_root, mut store, tombstone) = uninstalled_fixture();
        let other = temporary.path().join("other");
        fs::create_dir_all(&other).unwrap();
        let other_root =
            normalize_project_root(other.canonicalize().unwrap().to_string_lossy().as_ref());
        assert!(
            PluginTrashRetentionService::new()
                .purge_exact_tombstone(&mut store, &other_root, &tombstone.tombstone_id)
                .is_err()
        );
        assert!(
            temporary
                .path()
                .join("project/.rho/plugin-trash/trash.retention")
                .is_dir()
        );
    }
}
