use std::fs;
use std::path::{Path, PathBuf};

use lbug::{Database, SystemConfig};
use rho_protocol::ProjectId;
use sha2::{Digest, Sha256};

use crate::{EVIDENCE_GRAPH_SCHEMA_VERSION, GraphError, GraphHealth};

use super::{EvidenceGraph, execute, expect_i64, expect_optional_string};

impl EvidenceGraph {
    pub fn open(project_root: impl AsRef<Path>, project_id: ProjectId) -> Result<Self, GraphError> {
        let project_root = contained_project_root(project_root.as_ref())?;
        let rho_dir = contained_rho_dir(&project_root)?;
        let database_path = rho_dir.join("evidence.lbdb");
        reject_link_or_special_path(&database_path)?;

        let database = Database::new(
            &database_path,
            SystemConfig::default()
                .buffer_pool_size(128 * 1024 * 1024)
                .max_num_threads(2)
                .throw_on_wal_replay_failure(true)
                .enable_checksums(true)
                .enable_multi_writes(false),
        )?;
        assert_created_path_is_contained(&rho_dir, &database_path)?;
        let graph = Self {
            database,
            project_id,
            project_root,
            database_path,
        };
        {
            let connection = graph.connection()?;
            crate::schema::initialize_or_validate(
                &connection,
                &graph.project_id,
                &root_digest(&graph.project_root),
            )?;
        }
        Ok(graph)
    }

    pub fn health(&self) -> Result<GraphHealth, GraphError> {
        let connection = self.connection()?;
        let rows = execute(
            &connection,
            "MATCH (cursor:IngestCursor)
                 WHERE cursor.project_id = $project_id
                 RETURN cursor.authority_cursor,
                        cursor.last_success_at,
                        cursor.last_error_code
                 ORDER BY cursor.authority_cursor DESC
                 LIMIT 1",
            vec![(
                "project_id",
                lbug::Value::String(self.project_id.as_str().to_string()),
            )],
        )?;
        let (authority_cursor, last_success_at, last_error_code) = if let Some(row) = rows.first() {
            let cursor = expect_i64(row.first(), "cursor.authority_cursor")?;
            (
                u64::try_from(cursor)
                    .map_err(|_| GraphError::Invariant("negative ingest cursor".to_string()))?,
                expect_optional_string(row.get(1), "cursor.last_success_at")?,
                expect_optional_string(row.get(2), "cursor.last_error_code")?,
            )
        } else {
            (0, None, None)
        };
        Ok(GraphHealth {
            project_id: self.project_id.clone(),
            available: true,
            schema_version: EVIDENCE_GRAPH_SCHEMA_VERSION,
            graph_revision: self.graph_revision()?,
            authority_cursor,
            last_ingest_success_at: last_success_at,
            last_ingest_error_code: last_error_code,
        })
    }
}

fn contained_project_root(root: &Path) -> Result<PathBuf, GraphError> {
    let metadata = fs::symlink_metadata(root).map_err(|_| GraphError::UnsafePath(root.into()))?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(GraphError::UnsafePath(root.into()));
    }
    fs::canonicalize(root).map_err(|_| GraphError::UnsafePath(root.into()))
}

fn contained_rho_dir(project_root: &Path) -> Result<PathBuf, GraphError> {
    let rho_dir = project_root.join(".rho");
    match fs::symlink_metadata(&rho_dir) {
        Ok(metadata) => {
            if metadata.file_type().is_symlink() || !metadata.is_dir() {
                return Err(GraphError::UnsafePath(rho_dir));
            }
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            fs::create_dir(&rho_dir).map_err(|_| GraphError::UnsafePath(rho_dir.clone()))?;
        }
        Err(_) => return Err(GraphError::UnsafePath(rho_dir)),
    }
    let canonical = fs::canonicalize(&rho_dir).map_err(|_| GraphError::UnsafePath(rho_dir))?;
    if !canonical.starts_with(project_root) {
        return Err(GraphError::UnsafePath(canonical));
    }
    Ok(canonical)
}

fn reject_link_or_special_path(path: &Path) -> Result<(), GraphError> {
    match fs::symlink_metadata(path) {
        Ok(metadata)
            if metadata.file_type().is_symlink() || (!metadata.is_file() && !metadata.is_dir()) =>
        {
            Err(GraphError::UnsafePath(path.into()))
        }
        Ok(_) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(_) => Err(GraphError::UnsafePath(path.into())),
    }
}

fn assert_created_path_is_contained(rho_dir: &Path, path: &Path) -> Result<(), GraphError> {
    let metadata = fs::symlink_metadata(path).map_err(|_| GraphError::UnsafePath(path.into()))?;
    if metadata.file_type().is_symlink() || (!metadata.is_file() && !metadata.is_dir()) {
        return Err(GraphError::UnsafePath(path.into()));
    }
    let canonical = fs::canonicalize(path).map_err(|_| GraphError::UnsafePath(path.into()))?;
    if !canonical.starts_with(rho_dir) {
        return Err(GraphError::UnsafePath(canonical));
    }
    Ok(())
}

fn root_digest(root: &Path) -> String {
    let normalized = root.to_string_lossy().replace('\\', "/");
    format!("sha256:{:x}", Sha256::digest(normalized.as_bytes()))
}
