use serde::{Deserialize, Serialize};

use crate::{SEMANTIC_SCHEMA_FINGERPRINT, SemanticStore};

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum StoreHealthClass {
    Healthy,
    ProjectionRebuildRequired,
    BlockedCorrupt,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct StoreHealthReport {
    pub class: StoreHealthClass,
    pub reason_code: String,
    pub safe_action: String,
}

pub fn verify_semantic_store(store: &SemanticStore) -> StoreHealthReport {
    let quick_check = store
        .connection()
        .query_row("PRAGMA quick_check", [], |row| row.get::<_, String>(0));
    if !matches!(quick_check.as_deref(), Ok("ok")) {
        return StoreHealthReport {
            class: StoreHealthClass::BlockedCorrupt,
            reason_code: "sqlite_quick_check_failed".to_string(),
            safe_action: "block affected store; preserve file for operator recovery".to_string(),
        };
    }
    let fingerprint = store.connection().query_row(
        "SELECT value FROM semantic_metadata WHERE key = 'schema_fingerprint'",
        [],
        |row| row.get::<_, String>(0),
    );
    if fingerprint.as_deref() != Ok(SEMANTIC_SCHEMA_FINGERPRINT) {
        return StoreHealthReport {
            class: StoreHealthClass::BlockedCorrupt,
            reason_code: "schema_fingerprint_invalid".to_string(),
            safe_action: "block incompatible store; do not migrate or compatibility-read"
                .to_string(),
        };
    }
    let stale_projection = store.connection().query_row(
        "SELECT EXISTS(
           SELECT 1 FROM current_projection AS projection
           LEFT JOIN events AS event ON event.event_id = projection.source_event_id
           WHERE event.event_id IS NULL
         )",
        [],
        |row| row.get::<_, i64>(0),
    );
    if stale_projection.unwrap_or(1) != 0 {
        return StoreHealthReport {
            class: StoreHealthClass::ProjectionRebuildRequired,
            reason_code: "projection_source_missing".to_string(),
            safe_action: "rebuild disposable projections from durable semantic events".to_string(),
        };
    }
    StoreHealthReport {
        class: StoreHealthClass::Healthy,
        reason_code: "semantic_store_verified".to_string(),
        safe_action: "continue".to_string(),
    }
}
