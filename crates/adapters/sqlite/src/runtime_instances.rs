//! Indexed application metadata for logical R instances. Scientific results stay
//! in the Operation journal; browser generic-state writes cannot reach this table.
use crate::ApplicationStore;
use rho_contract::ApplicationState;
use rusqlite::{Connection, OptionalExtension, TransactionBehavior, params};

pub struct RuntimeInstancePage {
    pub records: Vec<ApplicationState>,
    pub total: u64,
    pub next_after_instance_id: Option<String>,
}

pub(crate) fn initialize(connection: &Connection) -> Result<(), String> {
    connection.execute_batch("CREATE TABLE IF NOT EXISTS runtime_instances (
        scope TEXT NOT NULL, instance_id TEXT NOT NULL, version TEXT NOT NULL,
        value TEXT NOT NULL CHECK(json_valid(value)), PRIMARY KEY(scope,instance_id));
        CREATE TABLE IF NOT EXISTS runtime_storage_reservations (
            project TEXT NOT NULL, operation_id TEXT NOT NULL, artifact_path TEXT NOT NULL,
            bytes INTEGER NOT NULL CHECK(bytes>=0), reserved INTEGER NOT NULL,
            PRIMARY KEY(project,operation_id));")
        .map_err(error)
}

fn error(value: impl std::fmt::Display) -> String { value.to_string() }
fn validate(scope: &str, id: &str) -> Result<(), String> {
    if scope.is_empty() || scope.len() > 4096 || scope.chars().any(char::is_control)
        || id.is_empty() || id.len() > 160
        || !id.bytes().all(|b| b.is_ascii_alphanumeric() || b"_-".contains(&b)) {
        return Err("invalid runtime instance scope or identity".into());
    }
    Ok(())
}
fn record(id: String, version: String, value: String) -> Result<ApplicationState, String> {
    Ok(ApplicationState { key: id, version: Some(version), value: serde_json::from_str(&value).map_err(error)? })
}

impl ApplicationStore {
    /// Shared across project Hosts using the same application storage root.
    /// A reservation remains counted after a crash until original files are inspected.
    pub fn reserve_runtime_storage(&self, project: &str, operation_id: &str,
        artifact_path: &str, bytes: u64, project_limit: u64, global_limit: u64) -> Result<(), String> {
        validate(project, operation_id)?;
        if artifact_path.is_empty() || artifact_path.len() > 8192 || bytes > i64::MAX as u64 {
            return Err("invalid recovery storage reservation".into());
        }
        let mut connection = self.0.lock().map_err(error)?;
        let tx = connection.transaction_with_behavior(TransactionBehavior::Immediate).map_err(error)?;
        let existing: Option<(String,u64)> = tx.query_row(
            "SELECT artifact_path,bytes FROM runtime_storage_reservations WHERE project=?1 AND operation_id=?2",
            params![project,operation_id], |r|Ok((r.get(0)?,r.get(1)?)),
        ).optional().map_err(error)?;
        if existing.is_some() { return Err("recovery storage already reserved; inspect the original operation".into()); }
        let (project_used,global_used): (u64,u64) = tx.query_row(
            "SELECT COALESCE(SUM(CASE WHEN project=?1 THEN bytes ELSE 0 END),0),COALESCE(SUM(bytes),0)
             FROM runtime_storage_reservations", [project], |r|Ok((r.get(0)?,r.get(1)?)),
        ).map_err(error)?;
        if project_used.checked_add(bytes).is_none_or(|v|v>project_limit)
            || global_used.checked_add(bytes).is_none_or(|v|v>global_limit) {
            return Err("recovery storage budget reached; existing copies were retained".into());
        }
        tx.execute("INSERT INTO runtime_storage_reservations(project,operation_id,artifact_path,bytes,reserved)
            VALUES(?1,?2,?3,?4,1)",params![project,operation_id,artifact_path,bytes]).map_err(error)?;
        tx.commit().map_err(error)
    }

    pub fn settle_runtime_storage(&self, project:&str, operation_id:&str, observed_bytes:u64) -> Result<(),String> {
        validate(project,operation_id)?;
        if observed_bytes > i64::MAX as u64 {return Err("invalid observed recovery size".into());}
        let connection=self.0.lock().map_err(error)?;
        let changed=connection.execute("UPDATE runtime_storage_reservations SET bytes=?3,reserved=0
            WHERE project=?1 AND operation_id=?2",params![project,operation_id,observed_bytes]).map_err(error)?;
        if changed!=1 {return Err("recovery storage reservation is missing".into());} Ok(())
    }

    pub fn runtime_storage_usage(&self, project:&str) -> Result<(u64,u64,u64),String> {
        validate(project,"main")?;
        let connection=self.0.lock().map_err(error)?;
        connection.query_row("SELECT COALESCE(SUM(CASE WHEN project=?1 THEN bytes ELSE 0 END),0),
            COALESCE(SUM(bytes),0),COALESCE(SUM(CASE WHEN reserved=1 THEN bytes ELSE 0 END),0)
            FROM runtime_storage_reservations",[project],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?))).map_err(error)
    }

    /// Bounded accounting observations; never guesses that an interrupted writer stopped.
    pub fn runtime_storage_records(&self, project:&str, after:Option<&str>, limit:usize)
        -> Result<Vec<(String,String,u64,bool)>,String> {
        validate(project,after.unwrap_or("main"))?;
        if !(1..=200).contains(&limit){return Err("storage page limit must be 1..=200".into());}
        let connection=self.0.lock().map_err(error)?;
        let mut statement=connection.prepare("SELECT operation_id,artifact_path,bytes,reserved
            FROM runtime_storage_reservations WHERE project=?1 AND (?2 IS NULL OR operation_id>?2)
            ORDER BY operation_id LIMIT ?3").map_err(error)?;
        statement.query_map(params![project,after,limit as i64],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get::<_,i64>(3)?!=0)))
            .map_err(error)?.map(|row|row.map_err(error)).collect()
    }

    pub fn runtime_instance(&self, scope: &str, id: &str) -> Result<ApplicationState, String> {
        validate(scope, id)?;
        let connection = self.0.lock().map_err(error)?;
        let found: Option<(String, String)> = connection.query_row(
            "SELECT version,value FROM runtime_instances WHERE scope=?1 AND instance_id=?2",
            params![scope, id], |r| Ok((r.get(0)?, r.get(1)?)),
        ).optional().map_err(error)?;
        match found {
            Some((version, value)) => record(id.into(), version, value),
            None => Ok(ApplicationState { key: id.into(), version: None, value: serde_json::Value::Null }),
        }
    }

    pub fn runtime_instances(&self, scope: &str, after: Option<&str>, limit: usize) -> Result<RuntimeInstancePage, String> {
        validate(scope, after.unwrap_or("main"))?;
        if !(1..=200).contains(&limit) { return Err("runtime page limit must be 1..=200".into()); }
        let mut connection = self.0.lock().map_err(error)?;
        let tx = connection.transaction().map_err(error)?;
        let total: u64 = tx.query_row("SELECT count(*) FROM runtime_instances WHERE scope=?1", [scope], |r| r.get(0)).map_err(error)?;
        let mut statement = tx.prepare("SELECT instance_id,version,value FROM runtime_instances
            WHERE scope=?1 AND (?2 IS NULL OR instance_id>?2) ORDER BY instance_id LIMIT ?3").map_err(error)?;
        let mut rows = statement.query(params![scope, after, (limit + 1) as i64]).map_err(error)?;
        let mut records = Vec::new();
        let mut bytes = 0usize;
        let mut has_more = false;
        while let Some(row) = rows.next().map_err(error)? {
            let id: String = row.get(0).map_err(error)?;
            let version: String = row.get(1).map_err(error)?;
            let value: String = row.get(2).map_err(error)?;
            let cost = id.len() + version.len() + value.len();
            if records.len() == limit || (!records.is_empty() && bytes + cost > 1024 * 1024) {
                has_more = true; break;
            }
            bytes += cost;
            records.push(record(id, version, value)?);
        }
        let next_after_instance_id = has_more.then(|| records.last().unwrap().key.clone());
        Ok(RuntimeInstancePage { records, total, next_after_instance_id })
    }

    pub fn write_runtime_instance(&self, scope: &str, state: &ApplicationState) -> Result<ApplicationState, String> {
        validate(scope, &state.key)?;
        let value = serde_json::to_string(&state.value).map_err(error)?;
        if value.len() > 64 * 1024 { return Err("runtime instance metadata exceeds 64 KiB".into()); }
        let mut connection = self.0.lock().map_err(error)?;
        let tx = connection.transaction_with_behavior(TransactionBehavior::Immediate).map_err(error)?;
        let previous: Option<String> = tx.query_row(
            "SELECT version FROM runtime_instances WHERE scope=?1 AND instance_id=?2",
            params![scope, state.key], |r| r.get(0),
        ).optional().map_err(error)?;
        if previous != state.version { return Err("runtime instance changed; stale metadata was not written".into()); }
        let version = uuid::Uuid::new_v4().to_string();
        tx.execute("INSERT INTO runtime_instances(scope,instance_id,version,value) VALUES(?1,?2,?3,?4)
            ON CONFLICT(scope,instance_id) DO UPDATE SET version=excluded.version,value=excluded.value",
            params![scope, state.key, version, value]).map_err(error)?;
        tx.commit().map_err(error)?;
        Ok(ApplicationState { key: state.key.clone(), version: Some(version), value: state.value.clone() })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn runtime_index_is_paginated_scoped_and_compare_and_swap() {
        let directory = tempfile::tempdir().unwrap();
        let store = ApplicationStore::open(&directory.path().join("app.sqlite")).unwrap();
        for i in 0..215 {
            store.write_runtime_instance("project:a", &ApplicationState {
                key: format!("session-{i:04}"), version: None, value: json!({"name":format!("R {i}")}),
            }).unwrap();
        }
        assert_eq!(store.runtime_instances("project:b", None, 50).unwrap().total, 0);
        let first = store.runtime_instances("project:a", None, 200).unwrap();
        assert_eq!(first.total, 215); assert_eq!(first.records.len(), 200);
        let last = store.runtime_instances("project:a", first.next_after_instance_id.as_deref(), 200).unwrap();
        assert_eq!(last.records.len(), 15); assert!(last.next_after_instance_id.is_none());
        let old = store.runtime_instance("project:a", "session-0001").unwrap();
        let mut update = old.clone(); update.value = json!({"name":"renamed"});
        store.write_runtime_instance("project:a", &update).unwrap();
        assert!(store.write_runtime_instance("project:a", &old).is_err());
        assert_eq!(store.runtime_instance("project:a", "session-0001").unwrap().value["name"], "renamed");
        assert!(store.read("project:a", "session-0001").unwrap().version.is_none());
    }

    #[test]
    fn runtime_index_respects_page_bytes_and_rejects_oversized_rows() {
        let directory = tempfile::tempdir().unwrap();
        let store = ApplicationStore::open(&directory.path().join("app.sqlite")).unwrap();
        for i in 0..30 {
            store.write_runtime_instance("project:a", &ApplicationState {
                key: format!("session-{i:04}"), version: None, value: json!({"diagnostic":"x".repeat(60_000)}),
            }).unwrap();
        }
        let first = store.runtime_instances("project:a", None, 200).unwrap();
        assert!(first.records.len() < 30); assert!(first.next_after_instance_id.is_some());
        assert!(store.write_runtime_instance("project:a", &ApplicationState {
            key:"huge".into(), version:None, value:json!({"diagnostic":"x".repeat(70_000)}),
        }).is_err());
        assert_eq!(store.runtime_instances("project:a", None, 200).unwrap().total, 30);
    }

    #[test]
    fn recovery_reservations_enforce_global_limits_and_preserve_uncertain_writers() {
        let directory=tempfile::tempdir().unwrap();
        let path=directory.path().join("app.sqlite");
        let a=ApplicationStore::open(&path).unwrap();
        let b=ApplicationStore::open(&path).unwrap();
        a.reserve_runtime_storage("project:a","capture-a","/private/a",60,100,100).unwrap();
        assert!(b.reserve_runtime_storage("project:b","capture-b","/private/b",50,100,100).is_err());
        assert_eq!(b.runtime_storage_usage("project:b").unwrap(),(0,60,60));
        a.settle_runtime_storage("project:a","capture-a",30).unwrap();
        b.reserve_runtime_storage("project:b","capture-b","/private/b",50,100,100).unwrap();
        assert!(a.reserve_runtime_storage("project:a","capture-a","/private/changed",1,100,100).is_err());
        drop(a);drop(b);
        let reopened=ApplicationStore::open(&path).unwrap();
        assert_eq!(reopened.runtime_storage_usage("project:b").unwrap(),(50,80,50));
        assert_eq!(reopened.runtime_storage_records("project:b",None,20).unwrap()[0].0,"capture-b");
        reopened.settle_runtime_storage("project:b","capture-b",0).unwrap();
        assert_eq!(reopened.runtime_storage_usage("project:b").unwrap(),(0,30,0));
    }
}
