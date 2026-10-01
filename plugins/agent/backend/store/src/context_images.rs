use crate::AgentStore;
use rho_agent_owner::{
    AgentContextImage, AgentTaskError, AgentTaskScope, MAX_PROJECT_CONTEXT_IMAGE_BYTES,
};
use rusqlite::{Connection, OptionalExtension, TransactionBehavior, params};
fn error(e: impl std::fmt::Display) -> AgentTaskError {
    AgentTaskError::Storage(e.to_string())
}
pub(crate) fn initialize(c: &Connection) -> Result<(), String> {
    c.execute_batch(
        "CREATE TABLE IF NOT EXISTS agent_context_images (
        project TEXT NOT NULL, principal TEXT NOT NULL, digest TEXT NOT NULL,
        mime_type TEXT NOT NULL, data BLOB NOT NULL,
        PRIMARY KEY(project,principal,digest));",
    )
    .map_err(|e| e.to_string())
}
impl AgentStore {
    pub(crate) fn store_context_images(
        &self,
        scope: &AgentTaskScope,
        images: &[(AgentContextImage, Vec<u8>)],
    ) -> Result<(), AgentTaskError> {
        if images.len() > 2 {
            return Err(AgentTaskError::Budget(
                "Select at most two context images".into(),
            ));
        }
        for (image, bytes) in images {
            image.verify(bytes)?;
        }
        let mut c = self.0.lock().map_err(error)?;
        let tx = c
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(error)?;
        for (image, bytes) in images {
            let saved: Option<(String,Vec<u8>)> = tx.query_row("SELECT mime_type,data FROM agent_context_images WHERE project=?1 AND principal=?2 AND digest=?3", params![scope.project,scope.principal,image.sha256], |r| Ok((r.get(0)?,r.get(1)?))).optional().map_err(error)?;
            if let Some((mime, saved)) = saved {
                if mime != image.mime_type || saved != *bytes {
                    return Err(AgentTaskError::RequestConflict);
                }
                continue;
            }
            let (size,count):(u64,u64) = tx.query_row("SELECT COALESCE(SUM(length(data)),0),COUNT(*) FROM agent_context_images WHERE project=?1", [&scope.project], |r|Ok((r.get(0)?,r.get(1)?))).map_err(error)?;
            if size + image.bytes > MAX_PROJECT_CONTEXT_IMAGE_BYTES || count >= 4096 {
                return Err(AgentTaskError::Budget(
                    "Retained context images exceed the project budget".into(),
                ));
            }
            tx.execute(
                "INSERT INTO agent_context_images VALUES(?1,?2,?3,?4,?5)",
                params![
                    scope.project,
                    scope.principal,
                    image.sha256,
                    image.mime_type,
                    bytes
                ],
            )
            .map_err(error)?;
        }
        tx.commit().map_err(error)
    }
    pub(crate) fn read_context_image(
        &self,
        scope: &AgentTaskScope,
        image: &AgentContextImage,
    ) -> Result<Vec<u8>, AgentTaskError> {
        image.validate()?;
        let c = self.0.lock().map_err(error)?;
        let (mime, bytes):(String,Vec<u8>)=c.query_row("SELECT mime_type,data FROM agent_context_images WHERE project=?1 AND principal=?2 AND digest=?3",params![scope.project,scope.principal,image.sha256],|r|Ok((r.get(0)?,r.get(1)?))).optional().map_err(error)?.ok_or(AgentTaskError::NotFound)?;
        if mime != image.mime_type {
            return Err(AgentTaskError::RequestConflict);
        }
        image.verify(&bytes)?;
        Ok(bytes)
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    use sha2::{Digest, Sha256};
    #[test]
    fn context_images_reopen_deduplicate_and_reject_changed_bytes_or_scope() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("agent.sqlite");
        let scope = AgentTaskScope {
            project: "project".into(),
            principal: "one".into(),
        };
        let bytes = b"retained-image".to_vec();
        let image = AgentContextImage {
            reference: serde_json::json!({"source":"original"}),
            sha256: format!("sha256:{:x}", Sha256::digest(&bytes)),
            mime_type: "image/png".into(),
            bytes: bytes.len() as u64,
        };
        let store = AgentStore::open(&path).unwrap();
        store
            .store_context_images(&scope, &[(image.clone(), bytes.clone())])
            .unwrap();
        store
            .store_context_images(&scope, &[(image.clone(), bytes.clone())])
            .unwrap();
        assert!(
            store
                .store_context_images(&scope, &[(image.clone(), b"changed".to_vec())])
                .is_err()
        );
        drop(store);
        let store = AgentStore::open(&path).unwrap();
        assert_eq!(store.read_context_image(&scope, &image).unwrap(), bytes);
        assert!(
            store
                .read_context_image(
                    &AgentTaskScope {
                        principal: "other".into(),
                        ..scope.clone()
                    },
                    &image
                )
                .is_err()
        );
        assert!(
            store
                .read_context_image(
                    &AgentTaskScope {
                        project: "other".into(),
                        ..scope
                    },
                    &image
                )
                .is_err()
        );
        store
            .0
            .lock()
            .unwrap()
            .execute("UPDATE agent_context_images SET data=X'00'", [])
            .unwrap();
        assert!(
            store
                .read_context_image(
                    &AgentTaskScope {
                        project: "project".into(),
                        principal: "one".into()
                    },
                    &image
                )
                .is_err()
        );
    }
}
