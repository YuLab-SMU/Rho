//! Shared immutable byte storage for native-task and Rho-conversation uploads.
use crate::ApplicationStore;
use rho_application::{ApplicationError, ApplicationScope};
use rho_contract::AgentAsset;
use rusqlite::{Connection, OptionalExtension, TransactionBehavior, params};

pub(crate) enum AssetOwner<'a> {
    Native(&'a str),
    Component(&'a str),
}
fn storage(error: impl std::fmt::Display) -> ApplicationError {
    ApplicationError::Storage(error.to_string())
}
fn owner_key(
    connection: &Connection,
    scope: &ApplicationScope,
    owner: AssetOwner<'_>,
) -> Result<String, ApplicationError> {
    let (table, field, id, key) = match owner {
        AssetOwner::Native(id) => ("agent_tasks", "task_id", id, id.to_owned()),
        AssetOwner::Component(id) => (
            "component_agent_conversations",
            "conversation_id",
            id,
            format!("component:{id}"),
        ),
    };
    let exists: bool = connection.query_row(&format!("SELECT EXISTS(SELECT 1 FROM {table} WHERE project=?1 AND principal=?2 AND {field}=?3)"), params![scope.project, scope.principal, id], |row| row.get(0)).map_err(storage)?;
    if !exists {
        return Err(ApplicationError::NotFound);
    }
    Ok(key)
}
pub(crate) fn list(
    store: &ApplicationStore,
    scope: &ApplicationScope,
    owner: AssetOwner<'_>,
) -> Result<Vec<AgentAsset>, ApplicationError> {
    let connection = store.0.lock().map_err(storage)?;
    let key = owner_key(&connection, scope, owner)?;
    let mut statement = connection.prepare("SELECT value FROM agent_task_assets WHERE project=?1 AND principal=?2 AND task_id=?3 ORDER BY asset_id LIMIT 64").map_err(storage)?;
    statement
        .query_map(params![scope.project, scope.principal, key], |row| {
            row.get::<_, String>(0)
        })
        .map_err(storage)?
        .map(|value| serde_json::from_str(&value.map_err(storage)?).map_err(storage))
        .collect()
}
pub(crate) fn read(
    store: &ApplicationStore,
    scope: &ApplicationScope,
    owner: AssetOwner<'_>,
    id: &str,
) -> Result<(AgentAsset, Vec<u8>), ApplicationError> {
    let connection = store.0.lock().map_err(storage)?;
    let key = owner_key(&connection, scope, owner)?;
    let row: Option<(String, Vec<u8>)> = connection.query_row("SELECT value,data FROM agent_task_assets WHERE project=?1 AND principal=?2 AND task_id=?3 AND asset_id=?4", params![scope.project, scope.principal, key, id], |row| Ok((row.get(0)?, row.get(1)?))).optional().map_err(storage)?;
    let (value, data) = row.ok_or(ApplicationError::NotFound)?;
    Ok((serde_json::from_str(&value).map_err(storage)?, data))
}
pub(crate) fn put(
    store: &ApplicationStore,
    scope: &ApplicationScope,
    owner: AssetOwner<'_>,
    asset: &AgentAsset,
    bytes: &[u8],
) -> Result<(), ApplicationError> {
    if bytes.len() > 8 * 1024 * 1024 || asset.bytes != bytes.len() as u64 {
        return Err(ApplicationError::Budget(
            "Attachments are limited to 8 MiB each".into(),
        ));
    }
    let mut connection = store.0.lock().map_err(storage)?;
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(storage)?;
    let key = owner_key(&transaction, scope, owner)?;
    let encoded = serde_json::to_string(asset).map_err(storage)?;
    let prior: Option<(String, Vec<u8>)> = transaction.query_row("SELECT value,data FROM agent_task_assets WHERE project=?1 AND principal=?2 AND task_id=?3 AND asset_id=?4", params![scope.project, scope.principal, key, asset.asset_id], |row| Ok((row.get(0)?, row.get(1)?))).optional().map_err(storage)?;
    if let Some((prior, data)) = prior {
        if prior != encoded || data != bytes {
            return Err(ApplicationError::RequestConflict);
        }
        return Ok(());
    }
    let (count, total): (usize, usize) = transaction.query_row("SELECT COUNT(*),COALESCE(SUM(length(data)),0) FROM agent_task_assets WHERE project=?1 AND principal=?2 AND task_id=?3", params![scope.project, scope.principal, key], |row| Ok((row.get(0)?, row.get(1)?))).map_err(storage)?;
    if count >= 64 || total.saturating_add(bytes.len()) > 32 * 1024 * 1024 {
        return Err(ApplicationError::Budget(
            "Task attachment storage is full".into(),
        ));
    }
    transaction.execute("INSERT INTO agent_task_assets(project,principal,task_id,asset_id,value,data) VALUES(?1,?2,?3,?4,?5,?6)", params![scope.project, scope.principal, key, asset.asset_id, encoded, bytes]).map_err(storage)?;
    transaction.commit().map_err(storage)
}
