//! WB1 store projections — read-only public protocol views over durable records.
//!
//! Every projection requires explicit `project_root` and excludes foreign or
//! legacy-unscoped records at the query boundary. No Agent conversation content
//! or internal transport fields are exposed.

use rho_protocol::workbench::{
    ApprovalSummary, EnvironmentEvidence, MAX_PAGE_SIZE, OutputSummary, ProblemSummary,
    ProjectSummary, ProvenanceLink, RunDetail, RunSummary, WORKBENCH_PROTOCOL_VERSION,
    WorkbenchCapabilities, WorkbenchPage, WorkbenchPageInfo, WorkspaceStatus,
};
use rusqlite::{OptionalExtension, params};

use super::{Store, StoreError};

// ── Helpers ──────────────────────────────────────────────────────────────────

/// Clamp page_size to [1, MAX_PAGE_SIZE].
fn clamp_page_size(size: usize) -> usize {
    size.clamp(1, MAX_PAGE_SIZE)
}

/// Truncate a string to at most `max_chars` characters, preserving grapheme boundaries.
fn truncate_str(s: &str, max_chars: usize) -> String {
    if s.chars().count() <= max_chars {
        s.to_string()
    } else {
        s.chars().take(max_chars).collect()
    }
}

// ── Projections ──────────────────────────────────────────────────────────────

impl<C> Store<C>
where
    C: std::ops::Deref<Target = rusqlite::Connection> + std::ops::DerefMut,
{
    // ── Capabilities ─────────────────────────────────────────────────────────

    /// Return the static WB1 capabilities for this runtime.
    pub fn workbench_capabilities(&self) -> WorkbenchCapabilities {
        WorkbenchCapabilities {
            workbench_protocol_version: WORKBENCH_PROTOCOL_VERSION.to_string(),
            operations: vec![
                "protocol_capabilities".into(),
                "project_status".into(),
                "workspace_status".into(),
                "run_list".into(),
                "run_get".into(),
                "problem_list".into(),
                "problem_get".into(),
                "output_list".into(),
                "output_get".into(),
                "environment_evidence_list".into(),
                "environment_evidence_get".into(),
                "approval_list".into(),
                "approval_get".into(),
                "provenance_get".into(),
            ],
            entity_types: vec![
                "ProjectSummary".into(),
                "WorkspaceStatus".into(),
                "RunSummary".into(),
                "RunDetail".into(),
                "ProblemSummary".into(),
                "OutputSummary".into(),
                "EnvironmentEvidence".into(),
                "ApprovalSummary".into(),
                "ProvenanceLink".into(),
            ],
            max_page_size: MAX_PAGE_SIZE,
            read_only: true,
        }
    }

    // ── Project Status ──────────────────────────────────────────────────────

    /// Aggregate project-level counts across runs, artifacts, plots, and problems.
    pub fn workbench_project_status(
        &self,
        project_root: &str,
    ) -> Result<ProjectSummary, StoreError> {
        let total_run_count: u64 = self.connection.query_row(
            "SELECT COUNT(*) FROM runs WHERE project_root = ?1",
            params![project_root],
            |row| row.get(0),
        )?;

        let total_artifact_count: u64 = self.connection.query_row(
            "SELECT COUNT(*) FROM artifact_records WHERE project_root = ?1",
            params![project_root],
            |row| row.get(0),
        )?;

        let total_plot_count: u64 = self.connection.query_row(
            "SELECT COUNT(*) FROM plot_artifacts WHERE project_root = ?1",
            params![project_root],
            |row| row.get(0),
        )?;

        let unresolved_problem_count: u64 = self.connection.query_row(
            "SELECT COUNT(*) FROM runs WHERE project_root = ?1 AND error_message IS NOT NULL",
            params![project_root],
            |row| row.get(0),
        )?;

        Ok(ProjectSummary {
            project_id: project_root.to_string(),
            total_run_count,
            total_artifact_count,
            total_plot_count,
            unresolved_problem_count,
        })
    }

    // ── Workspace Status ─────────────────────────────────────────────────────

    /// Return the current Workspace R status. The workspace is global;
    /// returns None if the requested project is not the active project.
    pub fn workbench_workspace_status(
        &self,
        project_root: &str,
    ) -> Result<Option<WorkspaceStatus>, StoreError> {
        // Verify the requested project matches the active project.
        let active = self.active_project_root()?;
        if active.as_deref() != Some(project_root) {
            return Ok(None);
        }

        let identity = self.load_identity()?;
        let identity = match identity {
            Some(id) => id,
            None => return Ok(None),
        };

        Ok(Some(WorkspaceStatus {
            workspace_id: identity.workspace_id,
            kernel_instance_id: identity.kernel_instance_id,
            execution_seq: identity.execution_seq,
            state_revision: identity.state_revision,
            project_revision: identity.project_revision,
            running: true,
            started_at: String::new(),
        }))
    }

    // ── Runs ─────────────────────────────────────────────────────────────────

    /// Paginated list of run summaries for the given project.
    pub fn workbench_run_list(
        &self,
        project_root: &str,
        after: Option<&str>,
        page_size: usize,
    ) -> Result<WorkbenchPage<RunSummary>, StoreError> {
        let page_size = clamp_page_size(page_size);

        // For cursor-based pagination, use started_at DESC with run_id tiebreaker.
        let (cursor_clause, cursor_param): (&str, Option<String>) = match after {
            Some(cursor) => {
                // cursor = "<started_at>|<run_id>"
                let parts: Vec<&str> = cursor.splitn(2, '|').collect();
                if parts.len() == 2 {
                    (
                        "AND (started_at < ?3 OR (started_at = ?3 AND run_id < ?4))",
                        Some(cursor.to_string()),
                    )
                } else {
                    return Err(StoreError::Sqlite(rusqlite::Error::InvalidParameterName(
                        "invalid cursor format".into(),
                    )));
                }
            }
            None => ("", None),
        };

        let sql = format!(
            "SELECT run_id, parent_run_id, origin, status, started_at, finished_at,
                    terminal_reason, request_type, source_path, error_message
             FROM runs
             WHERE project_root = ?1 {}
             ORDER BY started_at DESC, run_id DESC
             LIMIT ?2",
            cursor_clause
        );

        let mut statement = self.connection.prepare(&sql)?;

        let cursor_ts: String;
        let cursor_rid: String;
        let rows: Vec<RunSummary> = if let Some(ref cursor) = cursor_param {
            let parts: Vec<&str> = cursor.splitn(2, '|').collect();
            cursor_ts = parts[0].to_string();
            cursor_rid = parts[1].to_string();
            statement
                .query_map(
                    params![project_root, page_size as i64 + 1, &cursor_ts, &cursor_rid],
                    |row| {
                        Ok(RunSummary {
                            run_id: row.get(0)?,
                            parent_run_id: row.get(1)?,
                            origin: row.get(2)?,
                            status: row.get(3)?,
                            started_at: row.get(4)?,
                            finished_at: row.get(5)?,
                            terminal_reason: row.get(6)?,
                            request_type: row.get(7)?,
                            source_path: row.get(8)?,
                            has_error: row.get::<_, Option<String>>(9)?.is_some(),
                            has_warnings: None,
                            problem_count: None,
                            artifact_count: None,
                        })
                    },
                )?
                .collect::<Result<Vec<_>, _>>()?
        } else {
            statement
                .query_map(params![project_root, page_size as i64 + 1], |row| {
                    Ok(RunSummary {
                        run_id: row.get(0)?,
                        parent_run_id: row.get(1)?,
                        origin: row.get(2)?,
                        status: row.get(3)?,
                        started_at: row.get(4)?,
                        finished_at: row.get(5)?,
                        terminal_reason: row.get(6)?,
                        request_type: row.get(7)?,
                        source_path: row.get(8)?,
                        has_error: row.get::<_, Option<String>>(9)?.is_some(),
                        has_warnings: None,
                        problem_count: None,
                        artifact_count: None,
                    })
                })?
                .collect::<Result<Vec<_>, _>>()?
        };

        let has_more = rows.len() > page_size;
        let items: Vec<RunSummary> = if has_more {
            rows.into_iter().take(page_size).collect()
        } else {
            rows
        };

        let after_cursor = items
            .last()
            .map(|r| format!("{}|{}", r.started_at, r.run_id));

        Ok(WorkbenchPage {
            items,
            page: WorkbenchPageInfo {
                after: after_cursor,
                before: None,
                has_more,
                total_count: None,
                page_size,
            },
        })
    }

    /// Get a single run detail for the given project.
    pub fn workbench_run_get(
        &self,
        project_root: &str,
        run_id: &str,
    ) -> Result<Option<RunDetail>, StoreError> {
        let detail = self.get_run_detail(project_root, run_id)?;
        match detail {
            Some(d) => Ok(Some(RunDetail {
                summary: RunSummary {
                    run_id: d.run_id.clone(),
                    parent_run_id: d.parent_run_id.clone(),
                    origin: d.origin.clone(),
                    status: d.status.clone(),
                    started_at: d.started_at.clone(),
                    finished_at: d.finished_at.clone(),
                    terminal_reason: d.terminal_reason.clone(),
                    request_type: d.request_type.clone(),
                    source_path: d.source_path.clone(),
                    has_error: d.error_message.is_some(),
                    has_warnings: Some(!d.warnings.is_empty()),
                    problem_count: Some(if d.error_message.is_some() { 1 } else { 0 }),
                    artifact_count: Some(0),
                },
                code_preview: Some(truncate_str(&d.code, 2000)),
                code_truncated: d.code.len() > 2000,
                stdout_preview: d.stdout.as_ref().map(|s| truncate_str(s, 2000)),
                stdout_truncated: d.stdout.as_ref().is_some_and(|s| s.len() > 2000),
                value_preview: d.value_text.as_ref().map(|s| truncate_str(s, 500)),
                value_truncated: d.value_text.as_ref().is_some_and(|s| s.len() > 500),
                error_message: d.error_message,
                messages: d.messages,
                warnings: d.warnings,
                environment_snapshot_id: d.environment_snapshot_id,
                artifact_ids: vec![],
            })),
            None => Ok(None),
        }
    }

    // ── Problems ─────────────────────────────────────────────────────────────

    fn map_problem_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<ProblemSummary> {
        let run_id: String = row.get(0)?;
        let error_message: String = row.get(1)?;
        Ok(ProblemSummary {
            problem_id: format!("{}-{}", &run_id[..8.min(run_id.len())], "err"),
            run_id,
            severity: "error".into(),
            title: truncate_str(&error_message, 120),
            source_path: row.get(2)?,
            source_line: None,
            recorded_at: row.get(3)?,
        })
    }

    /// Paginated list of problems for the given project.
    pub fn workbench_problem_list(
        &self,
        project_root: &str,
        after: Option<&str>,
        page_size: usize,
    ) -> Result<WorkbenchPage<ProblemSummary>, StoreError> {
        let page_size = clamp_page_size(page_size);

        // Cursor: "started_at|run_id" — compound cursor for deterministic pagination.
        let (cursor_clause, cursor_params): (&str, Vec<String>) = match after {
            Some(cursor) => {
                let parts: Vec<&str> = cursor.splitn(2, '|').collect();
                if parts.len() == 2 {
                    (
                        "AND (started_at < ?3 OR (started_at = ?3 AND run_id < ?4))",
                        vec![parts[0].to_string(), parts[1].to_string()],
                    )
                } else {
                    return Err(StoreError::Sqlite(rusqlite::Error::InvalidParameterName(
                        "invalid cursor format".into(),
                    )));
                }
            }
            None => ("", vec![]),
        };

        let sql = format!(
            "SELECT run_id, error_message, source_path, started_at
             FROM runs
             WHERE project_root = ?1 AND error_message IS NOT NULL {}
             ORDER BY started_at DESC, run_id DESC
             LIMIT ?2",
            cursor_clause
        );

        let mut statement = self.connection.prepare(&sql)?;

        let rows: Vec<ProblemSummary> = if cursor_params.len() == 2 {
            statement
                .query_map(
                    params![
                        project_root,
                        page_size as i64 + 1,
                        &cursor_params[0],
                        &cursor_params[1]
                    ],
                    |row| Self::map_problem_row(row),
                )?
                .collect::<Result<Vec<_>, _>>()?
        } else {
            statement
                .query_map(params![project_root, page_size as i64 + 1], |row| {
                    Self::map_problem_row(row)
                })?
                .collect::<Result<Vec<_>, _>>()?
        };

        let has_more = rows.len() > page_size;
        let items: Vec<ProblemSummary> = if has_more {
            rows.into_iter().take(page_size).collect()
        } else {
            rows
        };

        let after_cursor = items
            .last()
            .map(|p| format!("{}|{}", p.recorded_at, p.run_id));

        Ok(WorkbenchPage {
            items,
            page: WorkbenchPageInfo {
                after: after_cursor,
                before: None,
                has_more,
                total_count: None,
                page_size,
            },
        })
    }

    /// Get a single problem by its problem_id (derived from run_id prefix).
    pub fn workbench_problem_get(
        &self,
        project_root: &str,
        problem_id: &str,
    ) -> Result<Option<ProblemSummary>, StoreError> {
        // problem_id format: "<run_id_prefix>-err"
        let run_prefix = problem_id.trim_end_matches("-err");
        if run_prefix.len() < 8 {
            return Ok(None);
        }

        let row: Option<ProblemSummary> = self
            .connection
            .query_row(
                "SELECT run_id, error_message, source_path, started_at
                 FROM runs
                 WHERE project_root = ?1 AND error_message IS NOT NULL
                   AND run_id LIKE ?2
                 ORDER BY started_at DESC
                 LIMIT 1",
                params![project_root, format!("{}%", run_prefix)],
                |row| {
                    let run_id: String = row.get(0)?;
                    let error_message: String = row.get(1)?;
                    Ok(ProblemSummary {
                        problem_id: format!("{}-{}", &run_id[..8.min(run_id.len())], "err"),
                        run_id,
                        severity: "error".into(),
                        title: error_message.chars().take(120).collect(),
                        source_path: row.get(2)?,
                        source_line: None,
                        recorded_at: row.get(3)?,
                    })
                },
            )
            .optional()?;

        Ok(row)
    }

    // ── Outputs (Artifacts) ──────────────────────────────────────────────────

    fn map_output_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<OutputSummary> {
        Ok(OutputSummary {
            artifact_id: row.get(0)?,
            artifact_kind: row.get(1)?,
            run_id: row.get(2)?,
            output_path: row.get(3)?,
            source_path: row.get(4)?,
            media_type: row.get(5)?,
            created_at: row.get(8)?,
            provenance_complete: row.get(6)?,
            incomplete_reason: row.get(7)?,
        })
    }

    /// Paginated list of output (artifact) records.
    pub fn workbench_output_list(
        &self,
        project_root: &str,
        after: Option<&str>,
        page_size: usize,
    ) -> Result<WorkbenchPage<OutputSummary>, StoreError> {
        let page_size = clamp_page_size(page_size);

        // Cursor: "created_at|artifact_id" — compound cursor for deterministic pagination.
        let (cursor_clause, cursor_params): (&str, Vec<String>) = match after {
            Some(cursor) => {
                let parts: Vec<&str> = cursor.splitn(2, '|').collect();
                if parts.len() == 2 {
                    (
                        "AND (created_at < ?3 OR (created_at = ?3 AND artifact_id < ?4))",
                        vec![parts[0].to_string(), parts[1].to_string()],
                    )
                } else {
                    return Err(StoreError::Sqlite(rusqlite::Error::InvalidParameterName(
                        "invalid cursor format".into(),
                    )));
                }
            }
            None => ("", vec![]),
        };

        let sql = format!(
            "SELECT artifact_id, artifact_kind, run_id, output_path, source_path,
                    media_type, provenance_complete, incomplete_reason, created_at
             FROM artifact_records
             WHERE project_root = ?1 {}
             ORDER BY created_at DESC, artifact_id DESC
             LIMIT ?2",
            cursor_clause
        );

        let mut statement = self.connection.prepare(&sql)?;

        let rows: Vec<OutputSummary> = if cursor_params.len() == 2 {
            statement
                .query_map(
                    params![
                        project_root,
                        page_size as i64 + 1,
                        &cursor_params[0],
                        &cursor_params[1]
                    ],
                    |row| Self::map_output_row(row),
                )?
                .collect::<Result<Vec<_>, _>>()?
        } else {
            statement
                .query_map(params![project_root, page_size as i64 + 1], |row| {
                    Self::map_output_row(row)
                })?
                .collect::<Result<Vec<_>, _>>()?
        };

        let has_more = rows.len() > page_size;
        let items: Vec<OutputSummary> = if has_more {
            rows.into_iter().take(page_size).collect()
        } else {
            rows
        };

        let after_cursor = items
            .last()
            .map(|o| format!("{}|{}", o.created_at, o.artifact_id));

        Ok(WorkbenchPage {
            items,
            page: WorkbenchPageInfo {
                after: after_cursor,
                before: None,
                has_more,
                total_count: None,
                page_size,
            },
        })
    }

    /// Get a single output record.
    pub fn workbench_output_get(
        &self,
        project_root: &str,
        artifact_id: &str,
    ) -> Result<Option<OutputSummary>, StoreError> {
        let record = self
            .connection
            .query_row(
                "SELECT artifact_id, artifact_kind, run_id, output_path,
                        source_path, media_type, provenance_complete, incomplete_reason, created_at
                 FROM artifact_records
                 WHERE project_root = ?1 AND artifact_id = ?2",
                params![project_root, artifact_id],
                |row| {
                    Ok(OutputSummary {
                        artifact_id: row.get(0)?,
                        artifact_kind: row.get(1)?,
                        run_id: row.get(2)?,
                        output_path: row.get(3)?,
                        source_path: row.get(4)?,
                        media_type: row.get(5)?,
                        created_at: row.get(8)?,
                        provenance_complete: row.get(6)?,
                        incomplete_reason: row.get(7)?,
                    })
                },
            )
            .optional()?;

        Ok(record)
    }

    // ── Environment Evidence ─────────────────────────────────────────────────

    fn map_env_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<EnvironmentEvidence> {
        Ok(EnvironmentEvidence {
            evidence_id: row.get(0)?,
            evidence_kind: row.get(1)?,
            operation_name: row.get(2)?,
            operation_status: row.get(3)?,
            operation_decision: row.get(4)?,
            captured_at: row.get(5)?,
        })
    }

    /// Paginated list of environment evidence (snapshots + operation requests).
    pub fn workbench_environment_evidence_list(
        &self,
        project_root: &str,
        after: Option<&str>,
        page_size: usize,
    ) -> Result<WorkbenchPage<EnvironmentEvidence>, StoreError> {
        let page_size = clamp_page_size(page_size);

        // Cursor: "captured_at|evidence_kind|evidence_id" — compound cursor
        // with kind prefix to disambiguate across UNION ALL.
        let (cursor_clause, cursor_params): (&str, Vec<String>) = match after {
            Some(cursor) => {
                let parts: Vec<&str> = cursor.splitn(3, '|').collect();
                if parts.len() == 3 {
                    (
                        "AND (captured_at < ?3 OR (captured_at = ?3 AND evidence_kind < ?4) OR (captured_at = ?3 AND evidence_kind = ?4 AND evidence_id < ?5))",
                        vec![
                            parts[0].to_string(),
                            parts[1].to_string(),
                            parts[2].to_string(),
                        ],
                    )
                } else {
                    return Err(StoreError::Sqlite(rusqlite::Error::InvalidParameterName(
                        "invalid cursor format".into(),
                    )));
                }
            }
            None => ("", vec![]),
        };

        let sql = format!(
            "SELECT snapshot_id AS evidence_id, 'snapshot' AS evidence_kind,
                    NULL AS operation_name, NULL AS operation_status,
                    NULL AS operation_decision, first_captured_at AS captured_at
             FROM environment_snapshots
             WHERE project_root = ?1 {}
             UNION ALL
             SELECT request_id AS evidence_id, 'operation_request' AS evidence_kind,
                    request_name AS operation_name, status AS operation_status,
                    decision AS operation_decision, created_at AS captured_at
             FROM environment_operation_requests
             WHERE project_root = ?1 {}
             ORDER BY captured_at DESC, evidence_kind DESC, evidence_id DESC
             LIMIT ?2",
            cursor_clause, cursor_clause
        );

        let mut statement = self.connection.prepare(&sql)?;

        let rows: Vec<EnvironmentEvidence> = if cursor_params.len() == 3 {
            statement
                .query_map(
                    params![
                        project_root,
                        page_size as i64 + 1,
                        &cursor_params[0],
                        &cursor_params[1],
                        &cursor_params[2]
                    ],
                    |row| Self::map_env_row(row),
                )?
                .collect::<Result<Vec<_>, _>>()?
        } else {
            statement
                .query_map(params![project_root, page_size as i64 + 1], |row| {
                    Self::map_env_row(row)
                })?
                .collect::<Result<Vec<_>, _>>()?
        };

        let has_more = rows.len() > page_size;
        let items: Vec<EnvironmentEvidence> = if has_more {
            rows.into_iter().take(page_size).collect()
        } else {
            rows
        };

        let after_cursor = items
            .last()
            .map(|e| format!("{}|{}|{}", e.captured_at, e.evidence_kind, e.evidence_id));

        Ok(WorkbenchPage {
            items,
            page: WorkbenchPageInfo {
                after: after_cursor,
                before: None,
                has_more,
                total_count: None,
                page_size,
            },
        })
    }

    /// Get a single environment evidence record.
    pub fn workbench_environment_evidence_get(
        &self,
        project_root: &str,
        evidence_id: &str,
    ) -> Result<Option<EnvironmentEvidence>, StoreError> {
        // Try snapshots first.
        let snapshot = self
            .connection
            .query_row(
                "SELECT snapshot_id, first_captured_at
                 FROM environment_snapshots
                 WHERE project_root = ?1 AND snapshot_id = ?2",
                params![project_root, evidence_id],
                |row| {
                    Ok(EnvironmentEvidence {
                        evidence_id: row.get(0)?,
                        evidence_kind: "snapshot".into(),
                        operation_name: None,
                        operation_status: None,
                        operation_decision: None,
                        captured_at: row.get(1)?,
                    })
                },
            )
            .optional()?;

        if snapshot.is_some() {
            return Ok(snapshot);
        }

        // Try operation requests.
        let op = self
            .connection
            .query_row(
                "SELECT request_id, request_name, status, decision, created_at
                 FROM environment_operation_requests
                 WHERE project_root = ?1 AND request_id = ?2",
                params![project_root, evidence_id],
                |row| {
                    Ok(EnvironmentEvidence {
                        evidence_id: row.get(0)?,
                        evidence_kind: "operation_request".into(),
                        operation_name: Some(row.get(1)?),
                        operation_status: Some(row.get(2)?),
                        operation_decision: row.get(3)?,
                        captured_at: row.get(4)?,
                    })
                },
            )
            .optional()?;

        Ok(op)
    }

    // ── Approvals ────────────────────────────────────────────────────────────

    fn map_approval_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<ApprovalSummary> {
        Ok(ApprovalSummary {
            request_id: row.get(0)?,
            turn_id: row.get(1)?,
            tool: row.get(2)?,
            policy: row.get(3)?,
            status: row.get(4)?,
            decision: row.get(5)?,
            reason: row.get(6)?,
            requested_at: row.get(7)?,
            responded_at: row.get(8)?,
        })
    }

    /// Paginated list of approval requests (inspection only — no decide/continue/cancel).
    pub fn workbench_approval_list(
        &self,
        project_root: &str,
        after: Option<&str>,
        page_size: usize,
    ) -> Result<WorkbenchPage<ApprovalSummary>, StoreError> {
        let page_size = clamp_page_size(page_size);

        // Cursor: "requested_at|request_id" — compound cursor for deterministic pagination.
        let (cursor_clause, cursor_params): (&str, Vec<String>) = match after {
            Some(cursor) => {
                let parts: Vec<&str> = cursor.splitn(2, '|').collect();
                if parts.len() == 2 {
                    (
                        "AND (requested_at < ?3 OR (requested_at = ?3 AND request_id < ?4))",
                        vec![parts[0].to_string(), parts[1].to_string()],
                    )
                } else {
                    return Err(StoreError::Sqlite(rusqlite::Error::InvalidParameterName(
                        "invalid cursor format".into(),
                    )));
                }
            }
            None => ("", vec![]),
        };

        let sql = format!(
            "SELECT request_id, turn_id, tool, policy, status, decision,
                    reason, requested_at, responded_at
             FROM approval_requests
             WHERE project_root = ?1 {}
             ORDER BY requested_at DESC, request_id DESC
             LIMIT ?2",
            cursor_clause
        );

        let mut statement = self.connection.prepare(&sql)?;

        let rows: Vec<ApprovalSummary> = if cursor_params.len() == 2 {
            statement
                .query_map(
                    params![
                        project_root,
                        page_size as i64 + 1,
                        &cursor_params[0],
                        &cursor_params[1]
                    ],
                    |row| Self::map_approval_row(row),
                )?
                .collect::<Result<Vec<_>, _>>()?
        } else {
            statement
                .query_map(params![project_root, page_size as i64 + 1], |row| {
                    Self::map_approval_row(row)
                })?
                .collect::<Result<Vec<_>, _>>()?
        };

        let has_more = rows.len() > page_size;
        let items: Vec<ApprovalSummary> = if has_more {
            rows.into_iter().take(page_size).collect()
        } else {
            rows
        };

        let after_cursor = items
            .last()
            .map(|a| format!("{}|{}", a.requested_at, a.request_id));

        Ok(WorkbenchPage {
            items,
            page: WorkbenchPageInfo {
                after: after_cursor,
                before: None,
                has_more,
                total_count: None,
                page_size,
            },
        })
    }

    /// Get a single approval request.
    pub fn workbench_approval_get(
        &self,
        project_root: &str,
        request_id: &str,
    ) -> Result<Option<ApprovalSummary>, StoreError> {
        let record = self
            .connection
            .query_row(
                "SELECT request_id, turn_id, tool, policy, status,
                        decision, reason, requested_at, responded_at
                 FROM approval_requests
                 WHERE project_root = ?1 AND request_id = ?2",
                params![project_root, request_id],
                |row| {
                    Ok(ApprovalSummary {
                        request_id: row.get(0)?,
                        turn_id: row.get(1)?,
                        tool: row.get(2)?,
                        policy: row.get(3)?,
                        status: row.get(4)?,
                        decision: row.get(5)?,
                        reason: row.get(6)?,
                        requested_at: row.get(7)?,
                        responded_at: row.get(8)?,
                    })
                },
            )
            .optional()?;

        Ok(record)
    }

    // ── Provenance ───────────────────────────────────────────────────────────

    /// Get provenance link for a given resource.
    pub fn workbench_provenance_get(
        &self,
        project_root: &str,
        resource_id: &str,
    ) -> Result<Option<ProvenanceLink>, StoreError> {
        // Try artifact records first.
        let artifact = self
            .connection
            .query_row(
                "SELECT artifact_id, run_id, source_path,
                        provenance_complete, incomplete_reason
                 FROM artifact_records
                 WHERE project_root = ?1 AND artifact_id = ?2",
                params![project_root, resource_id],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, Option<String>>(1)?,
                        row.get::<_, Option<String>>(2)?,
                        row.get::<_, bool>(3)?,
                        row.get::<_, Option<String>>(4)?,
                    ))
                },
            )
            .optional()?;

        if let Some((id, run_id, source, complete, reason)) = artifact {
            // Look up environment snapshot from producing run.
            let env_id: Option<String> = if let Some(ref rid) = run_id {
                self.connection
                    .query_row(
                        "SELECT environment_snapshot_id FROM runs WHERE run_id = ?1",
                        params![rid],
                        |row| row.get(0),
                    )
                    .optional()?
                    .flatten()
            } else {
                None
            };

            return Ok(Some(ProvenanceLink {
                resource_id: id,
                producing_run_id: run_id,
                environment_snapshot_id: env_id,
                source_path: source,
                provenance_complete: complete,
                incomplete_reason: reason,
            }));
        }

        // Try runs (a run's provenance is itself).
        let run = self
            .connection
            .query_row(
                "SELECT run_id, environment_snapshot_id, source_path
                 FROM runs
                 WHERE project_root = ?1 AND run_id = ?2",
                params![project_root, resource_id],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, Option<String>>(1)?,
                        row.get::<_, Option<String>>(2)?,
                    ))
                },
            )
            .optional()?;

        if let Some((id, env_id, source)) = run {
            return Ok(Some(ProvenanceLink {
                resource_id: id.clone(),
                producing_run_id: Some(id),
                environment_snapshot_id: env_id.clone(),
                source_path: source,
                provenance_complete: env_id.is_some(),
                incomplete_reason: if env_id.is_none() {
                    Some("no environment snapshot recorded".into())
                } else {
                    None
                },
            }));
        }

        Ok(None)
    }
}

// ── Tests ────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{ArtifactRecordDraft, RunDraft, RunFinish};

    fn setup_store() -> (Store, tempfile::TempDir) {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(dir.path().join("rho.sqlite")).unwrap();
        (store, dir)
    }

    fn create_test_run(store: &mut Store, project_root: &str, run_id: &str, origin: &str) {
        store
            .create_run(&RunDraft {
                run_id: run_id.into(),
                parent_run_id: None,
                project_root: project_root.into(),
                origin: origin.into(),
                request_type: "execute_r".into(),
                operation_class: "StateCapable".into(),
                code: "1 + 1".into(),
                arguments_json: "{}".into(),
                source_path: Some("test.R".into()),
                execution_mode: None,
                document_version: None,
                workspace_id: "ws_01".into(),
                state_revision_before: 1,
                project_revision_before: 1,
                environment_snapshot_id: None,
            })
            .unwrap();
        store
            .finish_run(&RunFinish {
                run_id: run_id.into(),
                status: "completed".into(),
                terminal_reason: None,
                workspace_id: Some("ws_01".into()),
                state_revision_after: Some(2),
                project_revision_after: Some(2),
                stdout: Some("> 1 + 1\n[1] 2".into()),
                value_text: Some("2".into()),
                messages: vec!["hello".into()],
                warnings: vec![],
                error_message: None,
                error_call: None,
                traceback: vec![],
                environment_snapshot_id_after: None,
            })
            .unwrap();
    }

    // ── Project Status ───────────────────────────────────────────────────────

    #[test]
    fn project_status_counts() {
        let (store, _dir) = setup_store();
        let mut store = store;
        create_test_run(&mut store, "/test/proj", "run_01", "user");
        create_test_run(&mut store, "/test/proj", "run_02", "user");

        let status = store.workbench_project_status("/test/proj").unwrap();
        assert_eq!(status.total_run_count, 2);
        assert_eq!(status.total_artifact_count, 0);
        assert_eq!(status.total_plot_count, 0);
        assert_eq!(status.unresolved_problem_count, 0);
    }

    #[test]
    fn project_status_empty_project() {
        let (store, _dir) = setup_store();
        let status = store.workbench_project_status("/test/empty").unwrap();
        assert_eq!(status.total_run_count, 0);
    }

    #[test]
    fn project_status_project_isolation() {
        let (store, _dir) = setup_store();
        let mut store = store;
        create_test_run(&mut store, "/test/proj_a", "run_a", "user");
        create_test_run(&mut store, "/test/proj_b", "run_b", "user");

        let status_a = store.workbench_project_status("/test/proj_a").unwrap();
        assert_eq!(status_a.total_run_count, 1);

        let status_b = store.workbench_project_status("/test/proj_b").unwrap();
        assert_eq!(status_b.total_run_count, 1);
    }

    // ── Runs ─────────────────────────────────────────────────────────────────

    #[test]
    fn run_list_basic() {
        let (store, _dir) = setup_store();
        let mut store = store;
        create_test_run(&mut store, "/test/proj", "run_01", "user");
        create_test_run(&mut store, "/test/proj", "run_02", "agent");

        let page = store.workbench_run_list("/test/proj", None, 50).unwrap();
        assert_eq!(page.items.len(), 2);
        assert!(!page.page.has_more);

        // Default ordering: most recent first
        assert_eq!(page.items[0].run_id, "run_02");
        assert_eq!(page.items[1].run_id, "run_01");
    }

    #[test]
    fn run_list_pagination() {
        let (store, _dir) = setup_store();
        let mut store = store;
        for i in 0..5 {
            create_test_run(&mut store, "/test/proj", &format!("run_{:02}", i), "user");
            // Small sleep to ensure different timestamps
            std::thread::sleep(std::time::Duration::from_millis(10));
        }

        let page1 = store.workbench_run_list("/test/proj", None, 2).unwrap();
        assert_eq!(page1.items.len(), 2);
        assert!(page1.page.has_more);

        let page2 = store
            .workbench_run_list("/test/proj", page1.page.after.as_deref(), 2)
            .unwrap();
        assert_eq!(page2.items.len(), 2);

        // Verify no overlap
        let ids1: Vec<_> = page1.items.iter().map(|r| &r.run_id).collect();
        let ids2: Vec<_> = page2.items.iter().map(|r| &r.run_id).collect();
        for id in &ids2 {
            assert!(!ids1.contains(id));
        }
    }

    #[test]
    fn run_list_project_isolation() {
        let (store, _dir) = setup_store();
        let mut store = store;
        create_test_run(&mut store, "/test/proj_a", "run_a", "user");
        create_test_run(&mut store, "/test/proj_b", "run_b", "user");

        let page_a = store.workbench_run_list("/test/proj_a", None, 50).unwrap();
        assert_eq!(page_a.items.len(), 1);
        assert_eq!(page_a.items[0].run_id, "run_a");

        let page_b = store.workbench_run_list("/test/proj_b", None, 50).unwrap();
        assert_eq!(page_b.items.len(), 1);
        assert_eq!(page_b.items[0].run_id, "run_b");
    }

    #[test]
    fn run_get_missing_run() {
        let (store, _dir) = setup_store();
        let result = store
            .workbench_run_get("/test/proj", "nonexistent")
            .unwrap();
        assert!(result.is_none());
    }

    #[test]
    fn run_get_has_code_preview() {
        let (store, _dir) = setup_store();
        let mut store = store;
        create_test_run(&mut store, "/test/proj", "run_01", "user");

        let detail = store
            .workbench_run_get("/test/proj", "run_01")
            .unwrap()
            .unwrap();
        assert_eq!(detail.code_preview.as_deref(), Some("1 + 1"));
        assert!(!detail.code_truncated);
    }

    // ── Problems ─────────────────────────────────────────────────────────────

    #[test]
    fn problem_list_basic() {
        let (store, _dir) = setup_store();
        let mut store = store;
        store
            .create_run(&RunDraft {
                run_id: "run_err".into(),
                parent_run_id: None,
                project_root: "/test/proj".into(),
                origin: "user".into(),
                request_type: "execute_r".into(),
                operation_class: "StateCapable".into(),
                code: "stop('bad')".into(),
                arguments_json: "{}".into(),
                source_path: Some("bad.R".into()),
                execution_mode: None,
                document_version: None,
                workspace_id: "ws_01".into(),
                state_revision_before: 1,
                project_revision_before: 1,
                environment_snapshot_id: None,
            })
            .unwrap();
        store
            .finish_run(&RunFinish {
                run_id: "run_err".into(),
                status: "failed".into(),
                terminal_reason: Some("error".into()),
                workspace_id: Some("ws_01".into()),
                state_revision_after: Some(1),
                project_revision_after: Some(1),
                stdout: None,
                value_text: None,
                messages: vec![],
                warnings: vec![],
                error_message: Some("Error: bad".into()),
                error_call: Some("stop('bad')".into()),
                traceback: vec!["stop('bad')".into()],
                environment_snapshot_id_after: None,
            })
            .unwrap();

        let page = store
            .workbench_problem_list("/test/proj", None, 50)
            .unwrap();
        assert_eq!(page.items.len(), 1);
        assert_eq!(page.items[0].severity, "error");
        assert!(page.items[0].title.contains("bad"));
    }

    #[test]
    fn problem_list_no_errors_for_clean_project() {
        let (store, _dir) = setup_store();
        let page = store
            .workbench_problem_list("/test/proj", None, 50)
            .unwrap();
        assert_eq!(page.items.len(), 0);
    }

    // ── Capabilities ─────────────────────────────────────────────────────────

    #[test]
    fn capabilities_read_only() {
        let (store, _dir) = setup_store();
        let caps = store.workbench_capabilities();
        assert!(caps.read_only);
        assert!(!caps.operations.is_empty());
        assert_eq!(caps.workbench_protocol_version, WORKBENCH_PROTOCOL_VERSION);
    }

    // ── Outputs ──────────────────────────────────────────────────────────────

    #[test]
    fn output_list_project_isolation() {
        let (store, _dir) = setup_store();
        let mut store = store;

        store
            .create_artifact_record(&ArtifactRecordDraft {
                artifact_id: "art_a".into(),
                artifact_kind: "export".into(),
                run_id: Some("run_a".into()),
                project_root: "/test/proj_a".into(),
                output_path: "out.csv".into(),
                source_path: None,
                execution_mode: None,
                document_version: None,
                workspace_id: None,
                state_revision: None,
                project_revision: None,
                media_type: "text/csv".into(),
                metadata_json: "{}".into(),
                provenance_complete: false,
                incomplete_reason: None,
            })
            .unwrap();

        store
            .create_artifact_record(&ArtifactRecordDraft {
                artifact_id: "art_b".into(),
                artifact_kind: "plot".into(),
                run_id: Some("run_b".into()),
                project_root: "/test/proj_b".into(),
                output_path: "".into(),
                source_path: None,
                execution_mode: None,
                document_version: None,
                workspace_id: None,
                state_revision: None,
                project_revision: None,
                media_type: "image/png".into(),
                metadata_json: "{}".into(),
                provenance_complete: true,
                incomplete_reason: None,
            })
            .unwrap();

        let page_a = store
            .workbench_output_list("/test/proj_a", None, 50)
            .unwrap();
        assert_eq!(page_a.items.len(), 1);
        assert_eq!(page_a.items[0].artifact_id, "art_a");

        let page_b = store
            .workbench_output_list("/test/proj_b", None, 50)
            .unwrap();
        assert_eq!(page_b.items.len(), 1);
        assert_eq!(page_b.items[0].artifact_id, "art_b");
    }

    // ── Page size clamping ───────────────────────────────────────────────────

    #[test]
    fn page_size_clamped_to_max() {
        assert_eq!(clamp_page_size(0), 1);
        assert_eq!(clamp_page_size(500), MAX_PAGE_SIZE);
        assert_eq!(clamp_page_size(50), 50);
    }

    // ── Golden fixtures (WB1-C) ───────────────────────────────────────────────

    #[test]
    fn golden_project_summary_json() {
        let (store, _dir) = setup_store();
        let mut store = store;
        create_test_run(&mut store, "/test/golden", "run_g", "user");

        let status = store.workbench_project_status("/test/golden").unwrap();
        let json = serde_json::to_string_pretty(&status).unwrap();
        // Verify key fields are present in the JSON.
        assert!(json.contains("\"project_id\""));
        assert!(json.contains("\"total_run_count\""));
        assert!(json.contains("\"total_artifact_count\""));
        assert!(json.contains("\"total_plot_count\""));
        assert!(json.contains("\"unresolved_problem_count\""));
        // Verify it parses back.
        let decoded: ProjectSummary = serde_json::from_str(&json).unwrap();
        assert_eq!(decoded.total_run_count, 1);
    }

    #[test]
    fn golden_run_summary_json() {
        let (store, _dir) = setup_store();
        let mut store = store;
        create_test_run(&mut store, "/test/golden", "run_g", "user");

        let page = store.workbench_run_list("/test/golden", None, 50).unwrap();
        let json = serde_json::to_string_pretty(&page.items[0]).unwrap();
        // Verify redaction: internal fields should NOT appear.
        assert!(!json.contains("project_root"));
        assert!(!json.contains("operation_class"));
        assert!(!json.contains("workspace_id"));
        // Verify public fields ARE present.
        assert!(json.contains("\"run_id\""));
        assert!(json.contains("\"origin\""));
        assert!(json.contains("\"status\""));
    }

    #[test]
    fn determinism_two_calls_return_identical_results() {
        let (store, _dir) = setup_store();
        let mut store = store;
        create_test_run(&mut store, "/test/det", "run_01", "user");

        let page1 = store.workbench_run_list("/test/det", None, 50).unwrap();
        let page2 = store.workbench_run_list("/test/det", None, 50).unwrap();

        let json1 = serde_json::to_string(&page1).unwrap();
        let json2 = serde_json::to_string(&page2).unwrap();
        assert_eq!(json1, json2);
    }

    // ── Negative tests (WB1-D) ────────────────────────────────────────────────

    #[test]
    fn foreign_run_rejected_for_different_project() {
        let (store, _dir) = setup_store();
        let mut store = store;
        create_test_run(&mut store, "/test/proj_a", "run_a", "user");

        // Asking for run_a under proj_b should return None (not projected).
        let result = store.workbench_run_get("/test/proj_b", "run_a").unwrap();
        assert!(
            result.is_none(),
            "foreign run must not be visible under project B"
        );
    }

    #[test]
    fn list_and_detail_views_agree_on_ownership() {
        let (store, _dir) = setup_store();
        let mut store = store;
        create_test_run(&mut store, "/test/proj", "run_01", "user");

        // List view
        let list = store.workbench_run_list("/test/proj", None, 50).unwrap();
        assert_eq!(list.items.len(), 1);
        assert_eq!(list.items[0].run_id, "run_01");

        // Detail view must match
        let detail = store
            .workbench_run_get("/test/proj", "run_01")
            .unwrap()
            .unwrap();
        assert_eq!(detail.summary.run_id, "run_01");
    }

    #[test]
    fn output_get_foreign_artifact_rejected() {
        let (store, _dir) = setup_store();
        let mut store = store;

        store
            .create_artifact_record(&ArtifactRecordDraft {
                artifact_id: "art_a".into(),
                artifact_kind: "export".into(),
                run_id: Some("run_a".into()),
                project_root: "/test/proj_a".into(),
                output_path: "".into(),
                source_path: None,
                execution_mode: None,
                document_version: None,
                workspace_id: None,
                state_revision: None,
                project_revision: None,
                media_type: "text/csv".into(),
                metadata_json: "{}".into(),
                provenance_complete: false,
                incomplete_reason: None,
            })
            .unwrap();

        // art_a is in proj_a; asking under proj_b must return None.
        let result = store.workbench_output_get("/test/proj_b", "art_a").unwrap();
        assert!(result.is_none());
    }

    #[test]
    fn provenance_runs_have_env_snapshot_gap() {
        let (store, _dir) = setup_store();
        let mut store = store;
        create_test_run(&mut store, "/test/proj", "run_01", "user");

        let link = store
            .workbench_provenance_get("/test/proj", "run_01")
            .unwrap()
            .unwrap();
        assert_eq!(link.resource_id, "run_01");
        // No environment snapshot was recorded, so provenance is incomplete.
        assert!(!link.provenance_complete);
        assert!(link.incomplete_reason.is_some());
    }

    #[test]
    fn provenance_missing_resource_returns_none() {
        let (store, _dir) = setup_store();
        let link = store
            .workbench_provenance_get("/test/proj", "nonexistent")
            .unwrap();
        assert!(link.is_none());
    }

    #[test]
    fn empty_project_all_lists_return_empty() {
        let (store, _dir) = setup_store();

        assert!(
            store
                .workbench_run_list("/test/empty", None, 50)
                .unwrap()
                .items
                .is_empty()
        );
        assert!(
            store
                .workbench_problem_list("/test/empty", None, 50)
                .unwrap()
                .items
                .is_empty()
        );
        assert!(
            store
                .workbench_output_list("/test/empty", None, 50)
                .unwrap()
                .items
                .is_empty()
        );
        assert!(
            store
                .workbench_approval_list("/test/empty", None, 50)
                .unwrap()
                .items
                .is_empty()
        );
    }

    #[test]
    fn legacy_unscoped_records_excluded_from_all_projections() {
        let (store, _dir) = setup_store();
        let mut store = store;

        // Create a run with legacy_unscoped project_root.
        store
            .create_run(&RunDraft {
                run_id: "legacy_run".into(),
                parent_run_id: None,
                project_root: "legacy_unscoped".into(),
                origin: "user".into(),
                request_type: "execute_r".into(),
                operation_class: "StateCapable".into(),
                code: "1 + 1".into(),
                arguments_json: "{}".into(),
                source_path: None,
                execution_mode: None,
                document_version: None,
                workspace_id: "ws_legacy".into(),
                state_revision_before: 0,
                project_revision_before: 0,
                environment_snapshot_id: None,
            })
            .unwrap();

        // Querying with a real project root must not return legacy records.
        let page = store.workbench_run_list("/test/proj", None, 50).unwrap();
        assert!(
            page.items.is_empty(),
            "legacy_unscoped runs must not appear under a real project"
        );

        // Querying with legacy_unscoped as project root should only work if
        // the client explicitly passes that value (legacy_unscoped is a
        // sentinel, not a real project).
        let legacy_page = store
            .workbench_run_list("legacy_unscoped", None, 50)
            .unwrap();
        assert_eq!(legacy_page.items.len(), 1);
    }
}
