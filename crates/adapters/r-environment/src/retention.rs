use super::{
    MaterialAction, MaterialChange, MaterialKind, MaterialState, REnvironment, before, display,
};
use rho_environment::{EnvironmentMaterialRecovery, MaterialObject};
use rho_operation::HandlerError;
use serde_json::json;
use sha2::{Digest, Sha256};
use std::{
    fs,
    path::{Path, PathBuf},
    time::UNIX_EPOCH,
};

fn name(id: &str) -> String {
    format!("{:x}", Sha256::digest(id.as_bytes()))
}
impl REnvironment {
    fn material_paths(
        &self,
        source: &str,
        kind: MaterialKind,
        cleanup: Option<&str>,
    ) -> Result<(PathBuf, Option<PathBuf>), String> {
        if self.config.data_root.canonicalize().map_err(display)? != self.config.data_root {
            return Err("Environment data root identity changed".into());
        }
        let group = match kind {
            MaterialKind::Plan => "plans",
            MaterialKind::Realization => "realizations",
        };
        let stage = self.config.data_root.join(group).join(name(source));
        let trash = cleanup.map(|id| self.config.data_root.join("trash").join(name(id)));
        for parent in [
            stage.parent(),
            trash.as_ref().and_then(|path| path.parent()),
        ]
        .into_iter()
        .flatten()
        {
            match fs::symlink_metadata(parent) {
                Ok(metadata)
                    if metadata.is_dir() && parent.canonicalize().map_err(display)? == parent => {}
                Ok(_) => return Err("material parent is not an owned directory".into()),
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => return Err(display(error)),
            }
        }
        Ok((stage, trash))
    }
    pub(super) async fn inspect_material(
        &self,
        source: &str,
        kind: MaterialKind,
        cleanup: Option<&str>,
    ) -> Result<MaterialState, String> {
        let (stage, trash) = self.material_paths(source, kind, cleanup)?;
        let marker = self.read_marker(source)?;
        let live_processes = if let Some(marker) = &marker {
            let marker = marker.marker.clone();
            let source = source.to_string();
            tokio::task::spawn_blocking(move || {
                rho_process::inspect_process_marker(&marker, &source)
            })
            .await
            .map_err(display)??
            .into_iter()
            .map(|process| process.pid)
            .collect()
        } else {
            Vec::new()
        };
        let (stage, trash) = tokio::task::spawn_blocking(move || {
            Ok::<_, String>((
                inspect_tree(&stage)?,
                trash.as_deref().map(inspect_tree).transpose()?.flatten(),
            ))
        })
        .await
        .map_err(display)??;
        Ok(MaterialState {
            stage,
            trash,
            native_marker_present: marker.is_some(),
            live_processes,
        })
    }
    pub(super) async fn apply_material_change(
        &self,
        source: &str,
        kind: MaterialKind,
        cleanup: &str,
        action: MaterialAction,
        expected: &str,
    ) -> Result<MaterialChange, HandlerError> {
        let state = self
            .inspect_material(source, kind, Some(cleanup))
            .await
            .map_err(before)?;
        if !state.native_marker_present || !state.live_processes.is_empty() {
            return Err(before(
                "material still has live or unverified native processes",
            ));
        }
        let (stage, trash) = self
            .material_paths(source, kind, Some(cleanup))
            .map_err(before)?;
        let trash = trash.unwrap();
        let selected = match action {
            MaterialAction::Quarantine => state.stage.as_ref(),
            _ => state.trash.as_ref(),
        }
        .ok_or_else(|| before("selected material is not present"))?;
        if selected.fingerprint != expected {
            return Err(before("material changed since preview"));
        }
        match action {
            MaterialAction::Quarantine if state.trash.is_some() => {
                return Err(before("quarantine destination already exists"));
            }
            MaterialAction::Restore | MaterialAction::Purge if state.stage.is_some() => {
                return Err(before("original staging path is occupied"));
            }
            _ => {}
        }
        let bytes = selected.bytes;
        let (stage_action, trash_action) = (stage.clone(), trash.clone());
        let result = tokio::task::spawn_blocking(move || -> Result<(), String> {
            match action {
                MaterialAction::Quarantine => {
                    fs::create_dir_all(trash_action.parent().unwrap()).map_err(display)?;
                    if trash_action
                        .parent()
                        .unwrap()
                        .canonicalize()
                        .map_err(display)?
                        != trash_action.parent().unwrap()
                    {
                        return Err("quarantine parent changed".into());
                    }
                    fs::rename(&stage_action, &trash_action).map_err(display)?;
                }
                MaterialAction::Restore => {
                    fs::create_dir_all(stage_action.parent().unwrap()).map_err(display)?;
                    if stage_action
                        .parent()
                        .unwrap()
                        .canonicalize()
                        .map_err(display)?
                        != stage_action.parent().unwrap()
                    {
                        return Err("staging parent changed".into());
                    }
                    fs::rename(&trash_action, &stage_action).map_err(display)?;
                }
                MaterialAction::Purge => fs::remove_dir_all(&trash_action).map_err(display)?,
            }
            #[cfg(unix)]
            for parent in [
                stage_action.parent().unwrap(),
                trash_action.parent().unwrap(),
            ] {
                if parent.exists() {
                    fs::File::open(parent)
                        .and_then(|directory| directory.sync_all())
                        .map_err(display)?;
                }
            }
            Ok(())
        })
        .await
        .map_err(display)
        .and_then(|result| result);
        result.map_err(|error| {
            HandlerError::after_possible_effect(
                error,
                Some(json!(EnvironmentMaterialRecovery::Paths {
                    source_operation_id: source.into(),
                    cleanup_operation_id: cleanup.into(),
                    stage_path: stage.to_string_lossy().into_owned(),
                    trash_path: trash.to_string_lossy().into_owned(),
                    action: "query_cleanup_status_before_retry".into()
                })),
            )
        })?;
        let (check_stage, check_trash) =
            self.material_paths(source, kind, Some(cleanup))
                .map_err(|error| {
                    HandlerError::after_possible_effect(
                        error,
                        Some(json!(EnvironmentMaterialRecovery::Identity {
                            cleanup_operation_id: cleanup.into()
                        })),
                    )
                })?;
        let agrees = match action {
            MaterialAction::Quarantine => {
                !check_stage.exists() && check_trash.as_ref().is_some_and(|path| path.is_dir())
            }
            MaterialAction::Restore => {
                check_stage.is_dir() && check_trash.as_ref().is_some_and(|path| !path.exists())
            }
            MaterialAction::Purge => check_trash.as_ref().is_some_and(|path| !path.exists()),
        };
        if !agrees {
            return Err(HandlerError::after_possible_effect(
                "filesystem does not agree with material change",
                Some(json!(EnvironmentMaterialRecovery::Identity {
                    cleanup_operation_id: cleanup.into()
                })),
            ));
        }
        Ok(MaterialChange {
            source_operation_id: source.into(),
            cleanup_operation_id: cleanup.into(),
            action,
            stage_path: stage.to_string_lossy().into_owned(),
            trash_path: trash.to_string_lossy().into_owned(),
            bytes,
            recoverable: !matches!(action, MaterialAction::Purge),
        })
    }
}

// Metadata token for stale-preview detection, not a scientific content identity.
// Internal symbolic links are recorded but never followed, including during purge.
fn inspect_tree(root: &Path) -> Result<Option<MaterialObject>, String> {
    let metadata = match fs::symlink_metadata(root) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(display(error)),
    };
    if !metadata.is_dir() || root.canonicalize().map_err(display)? != root {
        return Err("material root is not an owned directory".into());
    }
    let mut digest = Sha256::new();
    let mut pending = vec![root.to_path_buf()];
    let mut bytes = 0_u64;
    let mut entries = 0_u64;
    while let Some(path) = pending.pop() {
        entries += 1;
        if entries > 50000 {
            return Err("material inventory exceeds 50000 entries".into());
        }
        let meta = fs::symlink_metadata(&path).map_err(display)?;
        let relative = path
            .strip_prefix(root)
            .map_err(display)?
            .to_str()
            .ok_or("material names must be UTF-8")?;
        let kind = if meta.file_type().is_symlink() {
            "symlink"
        } else if meta.is_dir() {
            "directory"
        } else if meta.is_file() {
            "file"
        } else {
            return Err("special files prevent safe material collection".into());
        };
        digest.update(relative.len().to_le_bytes());
        digest.update(relative.as_bytes());
        digest.update(kind.as_bytes());
        digest.update(meta.len().to_le_bytes());
        let modified = meta
            .modified()
            .map_err(display)?
            .duration_since(UNIX_EPOCH)
            .map_err(display)?
            .as_nanos();
        digest.update(modified.to_le_bytes());
        #[cfg(unix)]
        {
            use std::os::unix::fs::MetadataExt;
            digest.update(meta.dev().to_le_bytes());
            digest.update(meta.ino().to_le_bytes());
        }
        if meta.file_type().is_symlink() {
            let link = fs::read_link(&path).map_err(display)?;
            let text = link.to_str().ok_or("link target must be UTF-8")?;
            digest.update(text.as_bytes());
        } else if meta.is_dir() {
            let mut children = Vec::new();
            for child in fs::read_dir(&path).map_err(display)? {
                if children.len() + pending.len() + entries as usize >= 50000 {
                    return Err("material inventory exceeds 50000 entries".into());
                }
                children.push(child.map_err(display)?.path());
            }
            children.sort();
            pending.extend(children);
        } else {
            bytes = bytes
                .checked_add(meta.len())
                .ok_or("material byte count overflow")?;
        }
    }
    Ok(Some(MaterialObject {
        path: root.to_string_lossy().into_owned(),
        fingerprint: format!("sha256:{:x}", digest.finalize()),
        bytes,
        entries,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn retention_observation_never_runs_r_or_recovers_processes() {
        let (_dir, runtime) = crate::recovery_tests::environment();
        #[cfg(unix)]
        let mut runtime = runtime;
        // Independently record any attempted helper launch; an implementation
        // that catches a helper error must still fail the read-only invariant.
        let forbidden_launch = runtime.config.data_root.join("native-helper-called");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let script = runtime.config.data_root.join("forbidden-rscript");
            fs::write(
                &script,
                "#!/bin/sh\nprintf called > \"${0%/*}/native-helper-called\"\nexit 1\n",
            )
            .unwrap();
            fs::set_permissions(&script, fs::Permissions::from_mode(0o700)).unwrap();
            runtime.config.rscript = script;
        }
        let temporary = tempfile::NamedTempFile::new_in(&runtime.config.data_root).unwrap();
        let since = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs();
        let marker = format!("PSreadfixture_{since}");
        runtime
            .persist_marker(temporary, "op_retention_read", &marker)
            .unwrap();
        let stage = runtime.stage("plans", "op_retention_read").unwrap();
        fs::write(stage.join("retained.txt"), "retain these bytes").unwrap();
        let before = fs::read(stage.join("retained.txt")).unwrap();
        let state = runtime
            .inspect_material("op_retention_read", MaterialKind::Plan, None)
            .await
            .unwrap();
        assert!(state.native_marker_present);
        assert!(state.live_processes.is_empty());
        assert!(state.stage.unwrap().fingerprint.starts_with("sha256:"));
        assert_eq!(fs::read(stage.join("retained.txt")).unwrap(), before);
        // The durable marker and retained bytes must survive the observation;
        // neither helper execution nor recovery is part of this query.
        assert!(runtime.read_marker("op_retention_read").unwrap().is_some());
        assert!(
            !forbidden_launch.exists(),
            "retention observation must not launch an R or ps helper, even if its error is swallowed"
        );
    }
}
