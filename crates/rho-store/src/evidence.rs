use chrono::Utc;
use rusqlite::{Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use super::{DEFAULT_LIMIT, StoreError, normalize_project_root};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EvidenceEntry {
    pub id: i64,
    pub project_root: String,
    pub title: String,
    pub notes: String,
    pub doi: Option<String>,
    pub run_id: Option<String>,
    pub artifact_id: Option<String>,
    pub citation_json: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EvidenceEntryDraft {
    pub project_root: String,
    pub title: String,
    pub notes: String,
    pub doi: Option<String>,
    pub run_id: Option<String>,
    pub artifact_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ClaimReviewStatus {
    Linked,
    MissingEvidence,
    UnresolvedSource,
    IncompleteEvidence,
    CrossProjectRejected,
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct EvidenceClaim {
    pub claim_id: String,
    pub project_root: String,
    pub kind: String,
    pub summary: String,
    pub anchor_kind: String,
    pub source_path: Option<String>,
    #[specta(type = Option<i32>)]
    pub start_line: Option<i64>,
    #[specta(type = Option<i32>)]
    pub start_column: Option<i64>,
    #[specta(type = Option<i32>)]
    pub end_line: Option<i64>,
    #[specta(type = Option<i32>)]
    pub end_column: Option<i64>,
    pub source_sha256: Option<String>,
    pub source_excerpt: Option<String>,
    pub artifact_id: Option<String>,
    #[specta(type = Vec<i32>)]
    pub linked_evidence_ids: Vec<i64>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EvidenceClaimDraft {
    pub project_root: String,
    pub kind: String,
    pub summary: String,
    pub anchor_kind: String,
    pub source_path: Option<String>,
    pub start_line: Option<i64>,
    pub start_column: Option<i64>,
    pub end_line: Option<i64>,
    pub end_column: Option<i64>,
    pub source_sha256: Option<String>,
    pub source_excerpt: Option<String>,
    pub artifact_id: Option<String>,
    pub evidence_ids: Vec<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EvidenceClaimReview {
    pub status: ClaimReviewStatus,
    pub claim: Option<EvidenceClaim>,
    pub evidence: Vec<EvidenceEntry>,
    pub limitations: Vec<String>,
}

impl<C> super::Store<C>
where
    C: std::ops::Deref<Target = Connection> + std::ops::DerefMut,
{
    pub fn create_evidence_entry(
        &mut self,
        draft: &EvidenceEntryDraft,
    ) -> Result<EvidenceEntry, StoreError> {
        create_evidence_entry_on(&self.connection, draft)
    }

    pub fn list_evidence_entries(
        &self,
        project_root: &str,
        limit: Option<usize>,
        search: Option<&str>,
    ) -> Result<Vec<EvidenceEntry>, StoreError> {
        list_evidence_entries_on(&self.connection, project_root, limit, search)
    }

    pub fn get_evidence_entry(
        &self,
        project_root: &str,
        id: i64,
    ) -> Result<Option<EvidenceEntry>, StoreError> {
        get_evidence_entry_on(&self.connection, project_root, id)
    }

    pub fn delete_evidence_entry(
        &mut self,
        project_root: &str,
        id: i64,
    ) -> Result<bool, StoreError> {
        delete_evidence_entry_on(&self.connection, project_root, id)
    }

    pub fn set_evidence_citation(
        &mut self,
        project_root: &str,
        id: i64,
        citation_json: &str,
    ) -> Result<bool, StoreError> {
        set_evidence_citation_on(&self.connection, project_root, id, citation_json)
    }

    pub fn create_evidence_claim(
        &mut self,
        draft: &EvidenceClaimDraft,
    ) -> Result<EvidenceClaim, StoreError> {
        create_evidence_claim_on(&mut self.connection, draft)
    }

    pub fn list_evidence_claims(
        &self,
        project_root: &str,
        limit: Option<usize>,
    ) -> Result<Vec<EvidenceClaim>, StoreError> {
        list_evidence_claims_on(&self.connection, project_root, limit)
    }

    pub fn get_evidence_claim(
        &self,
        project_root: &str,
        claim_id: &str,
    ) -> Result<Option<EvidenceClaim>, StoreError> {
        get_evidence_claim_on(&self.connection, project_root, claim_id)
    }

    pub fn review_evidence_claim(
        &self,
        project_root: &str,
        claim_id: &str,
        source_anchor_resolved: Option<bool>,
    ) -> Result<EvidenceClaimReview, StoreError> {
        review_evidence_claim_on(
            &self.connection,
            project_root,
            claim_id,
            source_anchor_resolved,
        )
    }

    pub fn delete_evidence_claim(
        &mut self,
        project_root: &str,
        claim_id: &str,
    ) -> Result<bool, StoreError> {
        delete_evidence_claim_on(&self.connection, project_root, claim_id)
    }
}

pub(crate) fn create_evidence_entry_on(
    connection: &Connection,
    draft: &EvidenceEntryDraft,
) -> Result<EvidenceEntry, StoreError> {
    let now = Utc::now().to_rfc3339();
    connection.execute(
        "INSERT INTO evidence_entries(
            project_root, title, notes, doi, run_id, artifact_id, created_at, updated_at
         ) VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)",
        rusqlite::params![
            draft.project_root,
            draft.title,
            draft.notes,
            draft.doi,
            draft.run_id,
            draft.artifact_id,
            now,
        ],
    )?;
    let id = connection.last_insert_rowid();
    Ok(EvidenceEntry {
        id,
        project_root: draft.project_root.clone(),
        title: draft.title.clone(),
        notes: draft.notes.clone(),
        doi: draft.doi.clone(),
        run_id: draft.run_id.clone(),
        artifact_id: draft.artifact_id.clone(),
        citation_json: None,
        created_at: now.clone(),
        updated_at: now,
    })
}

pub(crate) fn list_evidence_entries_on(
    connection: &Connection,
    project_root: &str,
    limit: Option<usize>,
    search: Option<&str>,
) -> Result<Vec<EvidenceEntry>, StoreError> {
    let limit_val = limit.unwrap_or(DEFAULT_LIMIT) as i64;
    if let Some(term) = search {
        let like_pattern = format!("%{term}%");
        let mut stmt = connection.prepare(
            "SELECT id, project_root, title, notes, doi, run_id, artifact_id,
                    citation_json, created_at, updated_at
             FROM evidence_entries
             WHERE project_root = ?1 AND (title LIKE ?2 OR notes LIKE ?2)
             ORDER BY created_at DESC
             LIMIT ?3",
        )?;
        let rows = stmt.query_map(
            rusqlite::params![project_root, like_pattern, limit_val],
            decode_evidence_entry,
        )?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(StoreError::from)
    } else {
        let mut stmt = connection.prepare(
            "SELECT id, project_root, title, notes, doi, run_id, artifact_id,
                    citation_json, created_at, updated_at
             FROM evidence_entries
             WHERE project_root = ?1
             ORDER BY created_at DESC
             LIMIT ?2",
        )?;
        let rows = stmt.query_map(
            rusqlite::params![project_root, limit_val],
            decode_evidence_entry,
        )?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(StoreError::from)
    }
}

pub(crate) fn get_evidence_entry_on(
    connection: &Connection,
    project_root: &str,
    id: i64,
) -> Result<Option<EvidenceEntry>, StoreError> {
    connection
        .query_row(
            "SELECT id, project_root, title, notes, doi, run_id, artifact_id,
                    citation_json, created_at, updated_at
             FROM evidence_entries
             WHERE project_root = ?1 AND id = ?2",
            rusqlite::params![project_root, id],
            decode_evidence_entry,
        )
        .optional()
        .map_err(StoreError::from)
}

pub(crate) fn delete_evidence_entry_on(
    connection: &Connection,
    project_root: &str,
    id: i64,
) -> Result<bool, StoreError> {
    let changed = connection.execute(
        "DELETE FROM evidence_entries WHERE project_root = ?1 AND id = ?2",
        rusqlite::params![project_root, id],
    )?;
    Ok(changed > 0)
}

pub(crate) fn set_evidence_citation_on(
    connection: &Connection,
    project_root: &str,
    id: i64,
    citation_json: &str,
) -> Result<bool, StoreError> {
    let changed = connection.execute(
        "UPDATE evidence_entries
         SET citation_json = ?3, updated_at = ?4
         WHERE project_root = ?1 AND id = ?2",
        rusqlite::params![project_root, id, citation_json, Utc::now().to_rfc3339()],
    )?;
    Ok(changed > 0)
}

pub(crate) fn create_evidence_claim_on(
    connection: &mut Connection,
    draft: &EvidenceClaimDraft,
) -> Result<EvidenceClaim, StoreError> {
    validate_claim_draft(draft)?;
    let mut evidence_ids = draft.evidence_ids.clone();
    evidence_ids.sort_unstable();
    evidence_ids.dedup();
    if evidence_ids.len() > 20 {
        return Err(StoreError::Validation(
            "a claim may link at most 20 Evidence entries".to_string(),
        ));
    }
    let transaction = connection.transaction()?;
    for evidence_id in &evidence_ids {
        let owner: Option<String> = transaction
            .query_row(
                "SELECT project_root FROM evidence_entries WHERE id = ?1",
                [evidence_id],
                |row| row.get(0),
            )
            .optional()?;
        match owner.as_deref() {
            Some(owner) if owner == draft.project_root => {}
            Some(_) => {
                return Err(StoreError::Validation(
                    "cross-project Evidence link rejected".to_string(),
                ));
            }
            None => {
                return Err(StoreError::Validation(
                    "linked Evidence entry was not found".to_string(),
                ));
            }
        }
    }
    if let Some(artifact_id) = draft.artifact_id.as_deref() {
        let exists = transaction
            .query_row(
                "SELECT 1 FROM artifact_records WHERE project_root = ?1 AND artifact_id = ?2",
                rusqlite::params![draft.project_root, artifact_id],
                |_row| Ok(()),
            )
            .optional()?
            .is_some();
        if !exists {
            return Err(StoreError::Validation(
                "Artifact anchor was not found in the active project".to_string(),
            ));
        }
    }
    let now = Utc::now().to_rfc3339();
    let mut hasher = Sha256::new();
    hasher.update(draft.project_root.as_bytes());
    hasher.update(draft.kind.as_bytes());
    hasher.update(draft.summary.as_bytes());
    hasher.update(now.as_bytes());
    let digest = format!("{:x}", hasher.finalize());
    let mut claim_id = format!("cl_{}", &digest[..24]);
    let mut suffix = 0u32;
    while transaction
        .query_row(
            "SELECT 1 FROM evidence_claims WHERE claim_id = ?1",
            [&claim_id],
            |_row| Ok(()),
        )
        .optional()?
        .is_some()
    {
        suffix += 1;
        claim_id = format!("cl_{}_{}", &digest[..24], suffix);
    }
    transaction.execute(
        "INSERT INTO evidence_claims(
            claim_id, project_root, kind, summary, anchor_kind, source_path,
            start_line, start_column, end_line, end_column, source_sha256,
            source_excerpt, artifact_id, created_at, updated_at
         ) VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?14)",
        rusqlite::params![
            claim_id,
            draft.project_root,
            draft.kind,
            draft.summary,
            draft.anchor_kind,
            draft.source_path,
            draft.start_line,
            draft.start_column,
            draft.end_line,
            draft.end_column,
            draft.source_sha256,
            draft.source_excerpt,
            draft.artifact_id,
            now,
        ],
    )?;
    for evidence_id in &evidence_ids {
        transaction.execute(
            "INSERT INTO claim_evidence_links(claim_id, evidence_id, project_root, created_at)
             VALUES(?1, ?2, ?3, ?4)",
            rusqlite::params![claim_id, evidence_id, draft.project_root, now],
        )?;
    }
    transaction.commit()?;
    get_evidence_claim_on(connection, &draft.project_root, &claim_id)?
        .ok_or_else(|| StoreError::Validation("created claim could not be reloaded".to_string()))
}

pub(crate) fn list_evidence_claims_on(
    connection: &Connection,
    project_root: &str,
    limit: Option<usize>,
) -> Result<Vec<EvidenceClaim>, StoreError> {
    let limit = limit.unwrap_or(DEFAULT_LIMIT).min(100) as i64;
    let mut statement = connection.prepare(
        "SELECT claim_id, project_root, kind, summary, anchor_kind, source_path,
                start_line, start_column, end_line, end_column, source_sha256,
                source_excerpt, artifact_id, created_at, updated_at
         FROM evidence_claims WHERE project_root = ?1
         ORDER BY created_at DESC LIMIT ?2",
    )?;
    let rows = statement.query_map(rusqlite::params![project_root, limit], decode_claim)?;
    let mut claims = rows.collect::<Result<Vec<_>, _>>()?;
    for claim in &mut claims {
        claim.linked_evidence_ids =
            claim_evidence_ids_on(connection, project_root, &claim.claim_id)?;
    }
    Ok(claims)
}

pub(crate) fn get_evidence_claim_on(
    connection: &Connection,
    project_root: &str,
    claim_id: &str,
) -> Result<Option<EvidenceClaim>, StoreError> {
    let mut claim = connection
        .query_row(
            "SELECT claim_id, project_root, kind, summary, anchor_kind, source_path,
                    start_line, start_column, end_line, end_column, source_sha256,
                    source_excerpt, artifact_id, created_at, updated_at
             FROM evidence_claims WHERE project_root = ?1 AND claim_id = ?2",
            rusqlite::params![project_root, claim_id],
            decode_claim,
        )
        .optional()?;
    if let Some(claim) = &mut claim {
        claim.linked_evidence_ids = claim_evidence_ids_on(connection, project_root, claim_id)?;
    }
    Ok(claim)
}

pub(crate) fn review_evidence_claim_on(
    connection: &Connection,
    project_root: &str,
    claim_id: &str,
    source_anchor_resolved: Option<bool>,
) -> Result<EvidenceClaimReview, StoreError> {
    let owner: Option<String> = connection
        .query_row(
            "SELECT project_root FROM evidence_claims WHERE claim_id = ?1",
            [claim_id],
            |row| row.get(0),
        )
        .optional()?;
    if owner.as_deref().is_some_and(|owner| owner != project_root) {
        return Ok(EvidenceClaimReview {
            status: ClaimReviewStatus::CrossProjectRejected,
            claim: None,
            evidence: Vec::new(),
            limitations: vec!["The claim belongs to another project.".to_string()],
        });
    }
    let Some(claim) = get_evidence_claim_on(connection, project_root, claim_id)? else {
        return Err(StoreError::Validation("claim was not found".to_string()));
    };
    let mut evidence = Vec::new();
    for evidence_id in &claim.linked_evidence_ids {
        if let Some(entry) = get_evidence_entry_on(connection, project_root, *evidence_id)? {
            evidence.push(entry);
        }
    }
    let anchor_resolved = if claim.anchor_kind == "source_range" {
        source_anchor_resolved.unwrap_or(false)
    } else {
        connection
            .query_row(
                "SELECT 1 FROM artifact_records WHERE project_root = ?1 AND artifact_id = ?2",
                rusqlite::params![project_root, claim.artifact_id],
                |_row| Ok(()),
            )
            .optional()?
            .is_some()
    };
    let (status, limitations) = if !anchor_resolved {
        (
            ClaimReviewStatus::UnresolvedSource,
            vec!["The exact claim anchor no longer resolves.".to_string()],
        )
    } else if claim.linked_evidence_ids.is_empty() {
        (
            ClaimReviewStatus::MissingEvidence,
            vec!["No Evidence entry is linked to this claim.".to_string()],
        )
    } else if evidence.len() != claim.linked_evidence_ids.len()
        || evidence.iter().any(|entry| {
            entry
                .doi
                .as_deref()
                .is_none_or(|value| value.trim().is_empty())
                && entry
                    .citation_json
                    .as_deref()
                    .is_none_or(|value| value.trim().is_empty())
                && entry.notes.trim().is_empty()
        })
    {
        (
            ClaimReviewStatus::IncompleteEvidence,
            vec![
                "At least one linked Evidence entry lacks inspectable metadata or notes."
                    .to_string(),
            ],
        )
    } else {
        (ClaimReviewStatus::Linked, Vec::new())
    };
    Ok(EvidenceClaimReview {
        status,
        claim: Some(claim),
        evidence,
        limitations,
    })
}

pub(crate) fn delete_evidence_claim_on(
    connection: &Connection,
    project_root: &str,
    claim_id: &str,
) -> Result<bool, StoreError> {
    let changed = connection.execute(
        "DELETE FROM evidence_claims WHERE project_root = ?1 AND claim_id = ?2",
        rusqlite::params![project_root, claim_id],
    )?;
    Ok(changed > 0)
}

fn claim_evidence_ids_on(
    connection: &Connection,
    project_root: &str,
    claim_id: &str,
) -> Result<Vec<i64>, StoreError> {
    let mut statement = connection.prepare(
        "SELECT evidence_id FROM claim_evidence_links
         WHERE project_root = ?1 AND claim_id = ?2 ORDER BY evidence_id",
    )?;
    statement
        .query_map(rusqlite::params![project_root, claim_id], |row| row.get(0))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(StoreError::from)
}

fn validate_claim_draft(draft: &EvidenceClaimDraft) -> Result<(), StoreError> {
    let bytes = |value: &str| value.len();
    let normalized_root = normalize_project_root(draft.project_root.trim());
    if normalized_root.is_empty() || normalized_root != draft.project_root {
        return Err(StoreError::Validation(
            "project root is required".to_string(),
        ));
    }
    if draft.kind.trim().is_empty() || bytes(&draft.kind) > 64 {
        return Err(StoreError::Validation("claim kind is invalid".to_string()));
    }
    if draft.summary.trim().is_empty() || bytes(&draft.summary) > 4096 {
        return Err(StoreError::Validation(
            "claim summary is invalid".to_string(),
        ));
    }
    match draft.anchor_kind.as_str() {
        "source_range" => {
            let path = draft.source_path.as_deref().unwrap_or_default();
            let start = draft.start_line.unwrap_or(0);
            let end = draft.end_line.unwrap_or(0);
            let normalized_path = normalize_claim_path(path);
            if normalized_path.as_deref() != Some(path)
                || bytes(path) > 1000
                || start < 1
                || end < start
                || end - start >= 200
                || draft.start_column.is_some_and(|column| column < 1)
                || draft.end_column.is_some_and(|column| column < 1)
                || (draft.start_line == draft.end_line
                    && draft.start_column.is_some()
                    && draft.end_column.is_some()
                    && draft.start_column > draft.end_column)
            {
                return Err(StoreError::Validation(
                    "source anchor is invalid".to_string(),
                ));
            }
            if draft.source_sha256.as_deref().is_none_or(|value| {
                value.len() != 64
                    || !value.bytes().all(|byte| byte.is_ascii_hexdigit())
                    || value != value.to_ascii_lowercase()
            }) || draft
                .source_excerpt
                .as_deref()
                .is_none_or(|value| value.len() > 16 * 1024)
            {
                return Err(StoreError::Validation(
                    "source anchor digest or excerpt is invalid".to_string(),
                ));
            }
            if draft.artifact_id.is_some() {
                return Err(StoreError::Validation(
                    "source claim cannot also anchor an Artifact".to_string(),
                ));
            }
        }
        "artifact" => {
            if draft
                .artifact_id
                .as_deref()
                .is_none_or(|value| value.trim().is_empty() || value.len() > 256)
                || draft.source_path.is_some()
                || draft.start_line.is_some()
                || draft.start_column.is_some()
                || draft.end_line.is_some()
                || draft.end_column.is_some()
                || draft.source_sha256.is_some()
                || draft.source_excerpt.is_some()
            {
                return Err(StoreError::Validation(
                    "Artifact anchor is invalid".to_string(),
                ));
            }
        }
        _ => {
            return Err(StoreError::Validation(
                "claim anchor kind is invalid".to_string(),
            ));
        }
    }
    Ok(())
}

fn normalize_claim_path(path: &str) -> Option<String> {
    let normalized = path.replace('\\', "/");
    if normalized.is_empty() || normalized.starts_with('/') || normalized.contains(':') {
        return None;
    }
    let mut parts = Vec::new();
    for part in normalized.split('/') {
        if part.is_empty() || part == "." || part == ".." {
            return None;
        }
        parts.push(part);
    }
    Some(parts.join("/"))
}

fn decode_claim(row: &rusqlite::Row<'_>) -> rusqlite::Result<EvidenceClaim> {
    Ok(EvidenceClaim {
        claim_id: row.get(0)?,
        project_root: row.get(1)?,
        kind: row.get(2)?,
        summary: row.get(3)?,
        anchor_kind: row.get(4)?,
        source_path: row.get(5)?,
        start_line: row.get(6)?,
        start_column: row.get(7)?,
        end_line: row.get(8)?,
        end_column: row.get(9)?,
        source_sha256: row.get(10)?,
        source_excerpt: row.get(11)?,
        artifact_id: row.get(12)?,
        linked_evidence_ids: Vec::new(),
        created_at: row.get(13)?,
        updated_at: row.get(14)?,
    })
}

fn decode_evidence_entry(row: &rusqlite::Row<'_>) -> rusqlite::Result<EvidenceEntry> {
    Ok(EvidenceEntry {
        id: row.get(0)?,
        project_root: row.get(1)?,
        title: row.get(2)?,
        notes: row.get(3)?,
        doi: row.get(4)?,
        run_id: row.get(5)?,
        artifact_id: row.get(6)?,
        citation_json: row.get(7)?,
        created_at: row.get(8)?,
        updated_at: row.get(9)?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn source_claim(
        project_root: &str,
        summary: &str,
        evidence_ids: Vec<i64>,
    ) -> EvidenceClaimDraft {
        EvidenceClaimDraft {
            project_root: project_root.to_string(),
            kind: "result".to_string(),
            summary: summary.to_string(),
            anchor_kind: "source_range".to_string(),
            source_path: Some("reports/claim-review-demo.qmd".to_string()),
            start_line: Some(4),
            start_column: Some(1),
            end_line: Some(5),
            end_column: Some(40),
            source_sha256: Some("a".repeat(64)),
            source_excerpt: Some("The observed response was higher in group A.".to_string()),
            artifact_id: None,
            evidence_ids,
        }
    }

    fn evidence_entry(store: &mut crate::Store, project_root: &str, notes: &str) -> EvidenceEntry {
        store
            .create_evidence_entry(&EvidenceEntryDraft {
                project_root: project_root.to_string(),
                title: "Shared paper title".to_string(),
                notes: notes.to_string(),
                doi: None,
                run_id: None,
                artifact_id: None,
            })
            .unwrap()
    }

    #[test]
    fn persists_and_lists_evidence_entries() {
        let directory = TempDir::new().unwrap();
        let mut store = crate::Store::open(directory.path().join("rho.sqlite")).unwrap();

        let entry = store
            .create_evidence_entry(&EvidenceEntryDraft {
                project_root: "D:/Rho/project".to_string(),
                title: "Key finding".to_string(),
                notes: "Notable observation about the data.".to_string(),
                doi: Some("10.1234/example".to_string()),
                run_id: Some("run_1".to_string()),
                artifact_id: None,
            })
            .unwrap();
        assert_eq!(entry.title, "Key finding");
        assert_eq!(entry.doi.as_deref(), Some("10.1234/example"));

        let listed = store
            .list_evidence_entries("D:/Rho/project", None, None)
            .unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].title, "Key finding");
    }

    #[test]
    fn isolates_entries_by_project() {
        let directory = TempDir::new().unwrap();
        let mut store = crate::Store::open(directory.path().join("rho.sqlite")).unwrap();

        store
            .create_evidence_entry(&EvidenceEntryDraft {
                project_root: "D:/Rho/project-a".to_string(),
                title: "Entry A".to_string(),
                notes: "".to_string(),
                doi: None,
                run_id: None,
                artifact_id: None,
            })
            .unwrap();
        store
            .create_evidence_entry(&EvidenceEntryDraft {
                project_root: "D:/Rho/project-b".to_string(),
                title: "Entry B".to_string(),
                notes: "".to_string(),
                doi: None,
                run_id: None,
                artifact_id: None,
            })
            .unwrap();

        let a = store
            .list_evidence_entries("D:/Rho/project-a", None, None)
            .unwrap();
        assert_eq!(a.len(), 1);
        assert_eq!(a[0].title, "Entry A");

        let b = store
            .list_evidence_entries("D:/Rho/project-b", None, None)
            .unwrap();
        assert_eq!(b.len(), 1);
        assert_eq!(b[0].title, "Entry B");
    }

    #[test]
    fn searches_entries_by_title_and_notes() {
        let directory = TempDir::new().unwrap();
        let mut store = crate::Store::open(directory.path().join("rho.sqlite")).unwrap();

        store
            .create_evidence_entry(&EvidenceEntryDraft {
                project_root: "D:/Rho/project".to_string(),
                title: "Cell type annotation".to_string(),
                notes: "Used SingleR for annotation.".to_string(),
                doi: None,
                run_id: None,
                artifact_id: None,
            })
            .unwrap();
        store
            .create_evidence_entry(&EvidenceEntryDraft {
                project_root: "D:/Rho/project".to_string(),
                title: "Differential expression".to_string(),
                notes: "DESeq2 results.".to_string(),
                doi: None,
                run_id: None,
                artifact_id: None,
            })
            .unwrap();

        let results = store
            .list_evidence_entries("D:/Rho/project", None, Some("SingleR"))
            .unwrap();
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].title, "Cell type annotation");

        let results = store
            .list_evidence_entries("D:/Rho/project", None, Some("DESeq2"))
            .unwrap();
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].title, "Differential expression");
    }

    #[test]
    fn gets_and_deletes_entry_by_id() {
        let directory = TempDir::new().unwrap();
        let mut store = crate::Store::open(directory.path().join("rho.sqlite")).unwrap();

        let entry = store
            .create_evidence_entry(&EvidenceEntryDraft {
                project_root: "D:/Rho/project".to_string(),
                title: "To delete".to_string(),
                notes: "".to_string(),
                doi: None,
                run_id: None,
                artifact_id: None,
            })
            .unwrap();

        let found = store
            .get_evidence_entry("D:/Rho/project", entry.id)
            .unwrap()
            .unwrap();
        assert_eq!(found.title, "To delete");

        assert!(
            store
                .delete_evidence_entry("D:/Rho/project", entry.id)
                .unwrap()
        );
        assert!(
            !store
                .delete_evidence_entry("D:/Rho/project", entry.id)
                .unwrap()
        );

        assert!(
            store
                .get_evidence_entry("D:/Rho/project", entry.id)
                .unwrap()
                .is_none()
        );
    }

    #[test]
    fn sets_citation_json() {
        let directory = TempDir::new().unwrap();
        let mut store = crate::Store::open(directory.path().join("rho.sqlite")).unwrap();

        let entry = store
            .create_evidence_entry(&EvidenceEntryDraft {
                project_root: "D:/Rho/project".to_string(),
                title: "Cited paper".to_string(),
                notes: "".to_string(),
                doi: None,
                run_id: None,
                artifact_id: None,
            })
            .unwrap();

        let citation = r#"{"title":"Example","authors":"Smith J","year":2024,"journal":"Nature"}"#;
        assert!(
            store
                .set_evidence_citation("D:/Rho/project", entry.id, citation)
                .unwrap()
        );

        let found = store
            .get_evidence_entry("D:/Rho/project", entry.id)
            .unwrap()
            .unwrap();
        assert_eq!(found.citation_json.as_deref(), Some(citation));
    }

    #[test]
    fn creates_lists_reopens_and_deletes_source_claim() {
        let directory = TempDir::new().unwrap();
        let database = directory.path().join("rho.sqlite");
        let mut store = crate::Store::open(&database).unwrap();
        let entry = evidence_entry(&mut store, "D:/projects/A", "Inspectable notes");
        let claim = store
            .create_evidence_claim(&source_claim(
                "D:/projects/A",
                "A bounded scientific statement",
                vec![entry.id, entry.id],
            ))
            .unwrap();
        assert_eq!(claim.linked_evidence_ids, vec![entry.id]);
        assert_eq!(
            store
                .list_evidence_claims("D:/projects/A", None)
                .unwrap()
                .len(),
            1
        );
        drop(store);

        let mut reopened = crate::Store::open(&database).unwrap();
        assert_eq!(
            reopened
                .get_evidence_claim("D:/projects/A", &claim.claim_id)
                .unwrap()
                .unwrap()
                .summary,
            "A bounded scientific statement"
        );
        assert!(
            reopened
                .delete_evidence_claim("D:/projects/A", &claim.claim_id)
                .unwrap()
        );
        let link_count: i64 = reopened
            .connection
            .query_row("SELECT COUNT(*) FROM claim_evidence_links", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(link_count, 0);
    }

    #[test]
    fn rejects_invalid_source_shapes_and_leaves_no_partial_claim() {
        let directory = TempDir::new().unwrap();
        let mut store = crate::Store::open(directory.path().join("rho.sqlite")).unwrap();
        let entry = evidence_entry(&mut store, "D:/projects/A", "notes");
        for mutate in 0..5 {
            let mut draft = source_claim("D:/projects/A", "Valid summary", vec![entry.id]);
            match mutate {
                0 => draft.source_path = Some("../outside.R".to_string()),
                1 => draft.source_path = Some("reports\\demo.R".to_string()),
                2 => draft.source_sha256 = Some("A".repeat(64)),
                3 => draft.start_column = Some(0),
                _ => draft.artifact_id = Some("artifact_1".to_string()),
            }
            assert!(matches!(
                store.create_evidence_claim(&draft),
                Err(StoreError::Validation(_))
            ));
        }
        assert!(
            store
                .list_evidence_claims("D:/projects/A", None)
                .unwrap()
                .is_empty()
        );
    }

    #[test]
    fn rejects_foreign_evidence_and_artifact_without_partial_writes() {
        let directory = TempDir::new().unwrap();
        let mut store = crate::Store::open(directory.path().join("rho.sqlite")).unwrap();
        let foreign_entry = evidence_entry(&mut store, "D:/projects/B", "notes");
        assert!(matches!(
            store.create_evidence_claim(&source_claim(
                "D:/projects/A",
                "Foreign Evidence is rejected",
                vec![foreign_entry.id],
            )),
            Err(StoreError::Validation(_))
        ));
        store
            .connection
            .execute(
                "INSERT INTO artifact_records(
                    artifact_id, artifact_kind, project_root, output_path, media_type,
                    metadata_json, provenance_complete, created_at
                 ) VALUES('artifact_b', 'render_output', 'D:/projects/B', 'report.html',
                          'text/html', '{}', 1, ?1)",
                [Utc::now().to_rfc3339()],
            )
            .unwrap();
        let artifact_draft = EvidenceClaimDraft {
            project_root: "D:/projects/A".to_string(),
            kind: "result".to_string(),
            summary: "Foreign Artifact is rejected".to_string(),
            anchor_kind: "artifact".to_string(),
            source_path: None,
            start_line: None,
            start_column: None,
            end_line: None,
            end_column: None,
            source_sha256: None,
            source_excerpt: None,
            artifact_id: Some("artifact_b".to_string()),
            evidence_ids: Vec::new(),
        };
        assert!(matches!(
            store.create_evidence_claim(&artifact_draft),
            Err(StoreError::Validation(_))
        ));
        let count: i64 = store
            .connection
            .query_row("SELECT COUNT(*) FROM evidence_claims", [], |row| row.get(0))
            .unwrap();
        assert_eq!(count, 0);
    }

    #[test]
    fn isolates_claims_and_rejects_cross_project_review_without_content() {
        let directory = TempDir::new().unwrap();
        let mut store = crate::Store::open(directory.path().join("rho.sqlite")).unwrap();
        let entry_a = evidence_entry(&mut store, "D:/projects/A", "same notes");
        let entry_b = evidence_entry(&mut store, "D:/projects/B", "same notes");
        let claim_a = store
            .create_evidence_claim(&source_claim(
                "D:/projects/A",
                "Same summary",
                vec![entry_a.id],
            ))
            .unwrap();
        store
            .create_evidence_claim(&source_claim(
                "D:/projects/B",
                "Same summary",
                vec![entry_b.id],
            ))
            .unwrap();
        assert_eq!(
            store
                .list_evidence_claims("D:/projects/A", None)
                .unwrap()
                .len(),
            1
        );
        assert_eq!(
            store
                .list_evidence_claims("D:/projects/B", None)
                .unwrap()
                .len(),
            1
        );
        assert!(
            !store
                .delete_evidence_claim("D:/projects/B", &claim_a.claim_id)
                .unwrap()
        );
        let review = store
            .review_evidence_claim("D:/projects/B", &claim_a.claim_id, Some(true))
            .unwrap();
        assert_eq!(review.status, ClaimReviewStatus::CrossProjectRejected);
        assert!(review.claim.is_none());
        assert!(review.evidence.is_empty());
    }

    #[test]
    fn reports_source_review_statuses_and_recovers_incomplete_evidence() {
        let directory = TempDir::new().unwrap();
        let mut store = crate::Store::open(directory.path().join("rho.sqlite")).unwrap();
        let incomplete = evidence_entry(&mut store, "D:/projects/A", "");
        let unresolved = store
            .create_evidence_claim(&source_claim("D:/projects/A", "Unresolved", vec![]))
            .unwrap();
        assert_eq!(
            store
                .review_evidence_claim("D:/projects/A", &unresolved.claim_id, Some(false))
                .unwrap()
                .status,
            ClaimReviewStatus::UnresolvedSource
        );
        assert_eq!(
            store
                .review_evidence_claim("D:/projects/A", &unresolved.claim_id, Some(true))
                .unwrap()
                .status,
            ClaimReviewStatus::MissingEvidence
        );
        let claim = store
            .create_evidence_claim(&source_claim(
                "D:/projects/A",
                "Incomplete",
                vec![incomplete.id],
            ))
            .unwrap();
        assert_eq!(
            store
                .review_evidence_claim("D:/projects/A", &claim.claim_id, Some(true))
                .unwrap()
                .status,
            ClaimReviewStatus::IncompleteEvidence
        );
        store
            .set_evidence_citation("D:/projects/A", incomplete.id, r#"{"title":"Paper"}"#)
            .unwrap();
        assert_eq!(
            store
                .review_evidence_claim("D:/projects/A", &claim.claim_id, Some(true))
                .unwrap()
                .status,
            ClaimReviewStatus::Linked
        );
        store
            .delete_evidence_entry("D:/projects/A", incomplete.id)
            .unwrap();
        assert_eq!(
            store
                .review_evidence_claim("D:/projects/A", &claim.claim_id, Some(true))
                .unwrap()
                .status,
            ClaimReviewStatus::MissingEvidence
        );
    }

    #[test]
    fn treats_whitespace_only_citation_identity_as_incomplete() {
        let directory = TempDir::new().unwrap();
        let mut store = crate::Store::open(directory.path().join("rho.sqlite")).unwrap();
        let entry = store
            .create_evidence_entry(&EvidenceEntryDraft {
                project_root: "D:/projects/A".to_string(),
                title: "Whitespace citation".to_string(),
                notes: " \t".to_string(),
                doi: Some(" \r\n".to_string()),
                run_id: None,
                artifact_id: None,
            })
            .unwrap();
        store
            .set_evidence_citation("D:/projects/A", entry.id, " \n\t")
            .unwrap();
        let claim = store
            .create_evidence_claim(&source_claim(
                "D:/projects/A",
                "Whitespace metadata remains incomplete",
                vec![entry.id],
            ))
            .unwrap();

        assert_eq!(
            store
                .review_evidence_claim("D:/projects/A", &claim.claim_id, Some(true))
                .unwrap()
                .status,
            ClaimReviewStatus::IncompleteEvidence
        );

        store
            .connection
            .execute(
                "UPDATE evidence_entries SET notes = 'Inspectable methods note' WHERE id = ?1",
                [entry.id],
            )
            .unwrap();
        assert_eq!(
            store
                .review_evidence_claim("D:/projects/A", &claim.claim_id, Some(true))
                .unwrap()
                .status,
            ClaimReviewStatus::Linked
        );
    }

    #[test]
    fn reports_artifact_disappearance_and_recovery() {
        let directory = TempDir::new().unwrap();
        let mut store = crate::Store::open(directory.path().join("rho.sqlite")).unwrap();
        store
            .connection
            .execute(
                "INSERT INTO artifact_records(
                artifact_id, artifact_kind, project_root, output_path, media_type,
                metadata_json, provenance_complete, created_at
             ) VALUES('artifact_a', 'render_output', 'D:/projects/A', 'report.html',
                      'text/html', '{}', 1, ?1)",
                [Utc::now().to_rfc3339()],
            )
            .unwrap();
        let mut draft = source_claim("D:/projects/A", "Artifact claim", Vec::new());
        draft.anchor_kind = "artifact".to_string();
        draft.source_path = None;
        draft.start_line = None;
        draft.start_column = None;
        draft.end_line = None;
        draft.end_column = None;
        draft.source_sha256 = None;
        draft.source_excerpt = None;
        draft.artifact_id = Some("artifact_a".to_string());
        let claim = store.create_evidence_claim(&draft).unwrap();
        assert_eq!(
            store
                .review_evidence_claim("D:/projects/A", &claim.claim_id, None)
                .unwrap()
                .status,
            ClaimReviewStatus::MissingEvidence
        );
        store
            .connection
            .execute(
                "DELETE FROM artifact_records WHERE artifact_id = 'artifact_a'",
                [],
            )
            .unwrap();
        assert_eq!(
            store
                .review_evidence_claim("D:/projects/A", &claim.claim_id, None)
                .unwrap()
                .status,
            ClaimReviewStatus::UnresolvedSource
        );
        store
            .connection
            .execute(
                "INSERT INTO artifact_records(
                artifact_id, artifact_kind, project_root, output_path, media_type,
                metadata_json, provenance_complete, created_at
             ) VALUES('artifact_a', 'render_output', 'D:/projects/A', 'report.html',
                      'text/html', '{}', 1, ?1)",
                [Utc::now().to_rfc3339()],
            )
            .unwrap();
        assert_eq!(
            store
                .review_evidence_claim("D:/projects/A", &claim.claim_id, None)
                .unwrap()
                .status,
            ClaimReviewStatus::MissingEvidence
        );
    }
}
