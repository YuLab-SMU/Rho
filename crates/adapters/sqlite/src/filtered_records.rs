//! Bounded owner-history reads. Scope, principal and domain selectors all apply
//! before LIMIT so unrelated analysis cannot hide the latest recovery copy.
use super::{OPERATION_VISIBILITY, SqliteOperationJournal, caller_kind, storage};
use rho_contract::{
    CallerIdentity, CapabilityRef, OperationId, OperationSummary, RecentOperations,
    RecentOperationsArguments,
};
use rho_operation::{OperationError, OperationRecordFilter};
use rusqlite::params;
use serde_json::json;

pub(crate) fn read(
    journal: &SqliteOperationJournal,
    scope: &str,
    caller: &CallerIdentity,
    args: &RecentOperationsArguments,
    filter: &OperationRecordFilter,
) -> Result<RecentOperations, OperationError> {
    rho_operation::validate_recent_arguments(args)?;
    filter.capability.validate()?;
    if let Some(capability) = &filter.secondary_capability {
        capability.validate()?;
    }
    for id in [
        &filter.workspace_instance_id,
        &filter.continuation_lineage_id,
    ]
    .into_iter()
    .flatten()
    {
        if id.is_empty() || id.len() > 160 || id.chars().any(char::is_control) {
            return Err(OperationError::InvalidInput(
                "invalid record identity filter".into(),
            ));
        }
    }
    let connection = journal.connection()?;
    let mut statement = connection.prepare(&format!(
        "SELECT op.rowid, op.operation_id, op.client_request_id, op.capability_id,
            op.capability_version, op.status, op.accepted_at_ms, op.updated_at_ms, substr(op.error,1,2048)
         FROM operations op WHERE {OPERATION_VISIBILITY}
            AND op.rowid < ?4 AND (?5 IS NULL OR op.client_request_id=?5)
            AND (?6 IS NULL OR op.operation_id=?6)
            AND ((op.capability_id=?8 AND op.capability_version=?9)
                OR (?12 IS NOT NULL AND op.capability_id=?12 AND op.capability_version=?13))
            AND (?10 IS NULL OR json_extract(op.output_json,'$.workspace_instance_id')=?10)
            AND (?11 IS NULL OR json_extract(op.output_json,'$.continuation_lineage_id')=?11)
         ORDER BY op.rowid DESC LIMIT ?7"
    )).map_err(storage)?;
    let mut rows = statement
        .query(params![
            scope,
            caller_kind(caller.kind),
            caller.id,
            args.before_cursor.unwrap_or(i64::MAX as u64) as i64,
            args.client_request_id,
            args.operation_id.as_ref().map(OperationId::as_str),
            args.limit + 1,
            filter.capability.id,
            filter.capability.version,
            filter.workspace_instance_id,
            filter.continuation_lineage_id,
            filter.secondary_capability.as_ref().map(|c| c.id.as_str()),
            filter.secondary_capability.as_ref().map(|c| c.version)
        ])
        .map_err(storage)?;
    let mut operations = Vec::new();
    while let Some(row) = rows.next().map_err(storage)? {
        let status: String = row.get(5).map_err(storage)?;
        operations.push(OperationSummary {
            cursor: row.get(0).map_err(storage)?,
            operation_id: OperationId::new(row.get::<_, String>(1).map_err(storage)?)?,
            client_request_id: row.get(2).map_err(storage)?,
            capability: CapabilityRef::new(
                row.get::<_, String>(3).map_err(storage)?,
                row.get(4).map_err(storage)?,
            )?,
            status: serde_json::from_value(json!(status)).map_err(storage)?,
            accepted_at_ms: row.get(6).map_err(storage)?,
            updated_at_ms: row.get(7).map_err(storage)?,
            error: row.get(8).map_err(storage)?,
        });
    }
    let next_cursor = (operations.len() > args.limit as usize)
        .then(|| operations[args.limit as usize - 1].cursor);
    operations.truncate(args.limit as usize);
    Ok(RecentOperations {
        operations,
        next_cursor,
    })
}
