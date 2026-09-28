//! Project navigation is a projection of the existing native and Rho owners.
use crate::ApplicationStore;
use rho_application::{AgentTaskError, AgentTaskScope};
use rho_contract::*;
use rusqlite::params;

fn error(e: impl std::fmt::Display) -> AgentTaskError { AgentTaskError::Storage(e.to_string()) }
// Both branches apply visibility before any ordering, aggregation, or limiting.
const TASKS: &str = "WITH tasks AS (
 SELECT 'native' AS backend, task_id AS id, created_at, updated_at, archived,
 json_extract(value,'$.task.provider') AS provider, json_extract(value,'$.task.title') AS title,
 CASE WHEN json_extract(value,'$.host_incarnation')=?3 THEN json_extract(value,'$.attachment.state')
 WHEN json_extract(value,'$.task.native_session_id') IS NOT NULL THEN 'disconnected'
 WHEN json_extract(value,'$.active_request') IS NOT NULL THEN 'uncertain' ELSE 'draft' END AS state,
 COALESCE((SELECT length(json_extract(d.value,'$.content.text'))>0 OR json_array_length(d.value,'$.content.context')>0 OR json_array_length(d.value,'$.content.assets')>0 FROM agent_task_drafts d WHERE d.project=t.project AND d.principal=t.principal AND d.task_id=t.task_id),0) AS has_draft,
 CASE WHEN json_extract(value,'$.host_incarnation')=?3 THEN json_array_length(value,'$.attachment.decisions') ELSE 0 END AS permissions,
 CASE
 WHEN json_extract(value,'$.host_incarnation')<>?3 AND json_extract(value,'$.active_request') IS NOT NULL THEN 'unconfirmed_submission'
 WHEN EXISTS(SELECT 1 FROM agent_task_receipts q WHERE q.project=t.project AND q.principal=t.principal AND q.task_id=t.task_id AND (json_extract(q.value,'$.status')='uncertain' OR (json_extract(t.value,'$.host_incarnation')<>?3 AND json_extract(q.value,'$.status') IN ('prepared','submitted')))) THEN 'unconfirmed_submission'
 WHEN json_extract(value,'$.attachment.control_frozen')=1 THEN 'control_unconfirmed'
 WHEN json_extract(value,'$.attachment.state') IN ('failed','disconnected','uncertain') AND length(COALESCE(json_extract(value,'$.attachment.error'),''))>0 THEN 'connection_issue'
 ELSE NULL END AS attention_reason,
 history_gap
 FROM agent_tasks t WHERE project=?1 AND principal=?2
 UNION ALL
 SELECT 'rho', c.conversation_id, json_extract(c.value,'$.created_at_ms'), c.updated_at,
 COALESCE(json_extract(c.value,'$.archived'),0), NULL,
 COALESCE(NULLIF(json_extract(c.value,'$.title'),''),'New task'),
 CASE WHEN r.run_id IS NULL THEN 'draft'
 WHEN (r.host_incarnation<>?4 OR r.run_id NOT IN (SELECT value FROM json_each(?5))) AND r.state NOT IN ('completed','stopped','failed','interrupted') THEN 'interrupted'
 WHEN r.state='completed' THEN 'ready' ELSE r.state END,
 (length(COALESCE(json_extract(c.value,'$.draft_content.text'),json_extract(c.value,'$.draft'),''))>0 OR COALESCE(json_array_length(c.value,'$.draft_content.context'),0)>0 OR COALESCE(json_array_length(c.value,'$.draft_content.assets'),0)>0),
 CASE WHEN r.host_incarnation=?4 AND r.state='waiting_for_permission' AND r.run_id IN (SELECT value FROM json_each(?5)) THEN (SELECT COUNT(*) FROM json_each(r.value,'$.run.permissions') WHERE json_extract(json_each.value,'$.state')='pending') ELSE 0 END,
 CASE
 WHEN (r.host_incarnation<>?4 OR r.run_id NOT IN (SELECT value FROM json_each(?5))) AND r.state NOT IN ('completed','stopped','failed','interrupted') THEN 'interrupted_run'
 WHEN json_extract(r.value,'$.run.recovery.unresolved_mutations')>0 THEN 'unresolved_actions'
 WHEN r.state='failed' AND length(COALESCE(json_extract(r.value,'$.run.reason'),''))>0 THEN 'run_failed'
 ELSE NULL END,
 (r.event_cursor>0 AND COALESCE((SELECT MIN(e.sequence) FROM component_agent_events e WHERE e.project=c.project AND e.principal=c.principal AND e.run_id=r.run_id),r.event_cursor+1)>1)
 FROM component_agent_conversations c LEFT JOIN component_agent_runs r ON r.project=c.project AND r.principal=c.principal AND r.run_id=(SELECT rr.run_id FROM component_agent_runs rr WHERE rr.project=c.project AND rr.principal=c.principal AND rr.conversation_id=c.conversation_id ORDER BY json_extract(rr.value,'$.run.created_at_ms') DESC,rr.run_id DESC LIMIT 1)
 WHERE c.project=?1 AND c.principal=?2
) ";

fn row(r: &rusqlite::Row<'_>) -> rusqlite::Result<ProjectAgentTaskSummary> {
    let kind: String = r.get(0)?; let id: String = r.get(1)?;
    let provider: Option<String> = r.get(5)?;
    let provider = provider.map(|p| serde_json::from_value(serde_json::Value::String(p))).transpose().map_err(|e| rusqlite::Error::FromSqlConversionFailure(5, rusqlite::types::Type::Text, Box::new(e)))?;
    Ok(ProjectAgentTaskSummary { reference: if kind == "rho" { ProjectAgentTaskRef::Rho { conversation_id: id } } else { ProjectAgentTaskRef::Native { task_id: id } }, created_at_ms: r.get(2)?, updated_at_ms: r.get(3)?, archived: r.get(4)?, provider, title: r.get(6)?, state: r.get(7)?, has_draft: r.get(8)?, permissions: r.get(9)?, attention_reason: if r.get::<_,u32>(9)?>0 { Some("permission".into()) } else { r.get(10)? }, history_gap: r.get::<_,Option<bool>>(11)?.unwrap_or(false) })
}

impl ApplicationStore {
    pub(crate) fn read_project_agent_tasks(&self, scope: &AgentTaskScope, archived: Option<bool>, before: Option<&str>, limit: usize, native_host: &str, rho_host: &str, rho_live: &[String]) -> Result<ProjectAgentTaskPage, AgentTaskError> {
        if !(1..=100).contains(&limit) { return Err(AgentTaskError::InvalidInput("Task page limit must be 1–100".into())); }
        let cursor = before.map(|raw| {
            if raw.len()>256 { return Err(AgentTaskError::InvalidInput("Invalid task cursor".into())); }
            let (time, kind, id): (u64,String,String) = serde_json::from_str(raw).map_err(|_| AgentTaskError::InvalidInput("Invalid task cursor".into()))?;
            let valid_id = if kind == "native" { uuid::Uuid::parse_str(&id).is_ok() } else { kind == "rho" && !id.is_empty() && id.len() <= 160 && id.bytes().all(|b|b.is_ascii_alphanumeric() || b"-_.:".contains(&b)) };
            if !valid_id { return Err(AgentTaskError::InvalidInput("Invalid task cursor".into())); }
            Ok((time,kind,id))
        }).transpose()?;
        let live = serde_json::to_string(rho_live).map_err(error)?;
        let mut connection = self.0.lock().map_err(error)?;
        let tx = connection.transaction().map_err(error)?;
        let mut query = tx.prepare(&format!("{TASKS} SELECT * FROM tasks WHERE (?6 IS NULL OR archived=?6) AND (?7 IS NULL OR created_at<?7 OR (created_at=?7 AND (backend<?8 OR (backend=?8 AND id<?9)))) ORDER BY created_at DESC,backend DESC,id DESC LIMIT ?10")).map_err(error)?;
        let mut tasks = query.query_map(params![scope.project,scope.principal,native_host,rho_host,live,archived,cursor.as_ref().map(|c|c.0),cursor.as_ref().map(|c|c.1.as_str()),cursor.as_ref().map(|c|c.2.as_str()),limit+1],row).map_err(error)?.collect::<rusqlite::Result<Vec<_>>>().map_err(error)?;
        let more = tasks.len()>limit; tasks.truncate(limit);
        let next = if more { tasks.last().map(|t| { let (kind,id)=match &t.reference { ProjectAgentTaskRef::Native{task_id}=>("native",task_id),ProjectAgentTaskRef::Rho{conversation_id}=>("rho",conversation_id) }; serde_json::to_string(&(t.created_at_ms,kind,id)).expect("scalar cursor") }) } else { None };
        drop(query);
        let (running,permissions,attention_count) = tx.query_row(&format!("{TASKS} SELECT COALESCE(SUM(state IN ('connecting','resuming','queued','running','waiting_for_r','needs_input','stopping')),0),COALESCE(SUM(permissions),0),COALESCE(SUM(permissions>0 OR attention_reason IS NOT NULL),0) FROM tasks"),params![scope.project,scope.principal,native_host,rho_host,live],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?))).map_err(error)?;
        let mut query = tx.prepare(&format!("{TASKS} SELECT * FROM tasks WHERE permissions>0 OR attention_reason IS NOT NULL ORDER BY created_at DESC,backend DESC,id DESC LIMIT 8")).map_err(error)?;
        let attention = query.query_map(params![scope.project,scope.principal,native_host,rho_host,live],row).map_err(error)?.collect::<rusqlite::Result<Vec<_>>>().map_err(error)?;
        Ok(ProjectAgentTaskPage { tasks, attention, next, running, permissions, attention_count })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::sync::Mutex;
    fn store() -> ApplicationStore {
        let connection = rusqlite::Connection::open_in_memory().unwrap();
        crate::agent_tasks::initialize(&connection).unwrap();
        crate::component_agents::initialize(&connection).unwrap();
        ApplicationStore(Mutex::new(connection))
    }
    fn native(store: &ApplicationStore, project: &str, principal: &str, id: &str, archived: bool, host: &str) {
        let c = store.0.lock().unwrap();
        let value = json!({"task":{"provider":"codex","title":"Native task","native_session_id":"session"},"host_incarnation":host,"attachment":{"state":"running","decisions":[]}}).to_string();
        c.execute("INSERT INTO agent_tasks VALUES(?1,?2,?3,'1',100,100,?4,0,0,?5)",params![project,principal,id,archived,value]).unwrap();
        c.execute("INSERT INTO agent_task_drafts VALUES(?1,?2,?3,1,?4)",params![project,principal,id,json!({"content":{"text":"draft","assets":[],"context":[]}}).to_string()]).unwrap();
    }
    fn rho(store: &ApplicationStore, project: &str, principal: &str, id: &str, host: &str) {
        let c = store.0.lock().unwrap();
        c.execute("INSERT INTO component_agent_conversations VALUES(?1,?2,?3,1,'run',100,?4)",params![project,principal,id,json!({"title":"Rho task","archived":false,"created_at_ms":100,"draft_content":{"text":"","assets":[],"context":[{"label":"plot"}]}}).to_string()]).unwrap();
        c.execute("INSERT INTO component_agent_runs VALUES(?1,?2,'run',?3,'request','digest',?4,'waiting_for_permission',0,?5)",params![project,principal,id,host,json!({"run":{"created_at_ms":100,"permissions":[{"state":"pending"}]}}).to_string()]).unwrap();
    }
    #[test]
    fn projection_paginates_both_owners_with_scoped_counts_and_typed_identity() {
        let store=store(); let id="00000000-0000-0000-0000-000000000001";
        native(&store,"p","alice",id,false,"native-host"); rho(&store,"p","alice",id,"rho-host");
        native(&store,"p","bob",id,false,"native-host"); rho(&store,"other","alice",id,"rho-host");
        let scope=AgentTaskScope{project:"p".into(),principal:"alice".into()};
        let first=store.read_project_agent_tasks(&scope,Some(false),None,1,"native-host","rho-host",&["run".into()]).unwrap();
        assert_eq!(first.running,1); assert_eq!(first.permissions,1); assert_eq!(first.attention.len(),1);
        assert!(matches!(first.tasks[0].reference,ProjectAgentTaskRef::Rho{..})); assert!(first.tasks[0].has_draft);
        let second=store.read_project_agent_tasks(&scope,Some(false),first.next.as_deref(),1,"native-host","rho-host",&["run".into()]).unwrap();
        assert!(matches!(second.tasks[0].reference,ProjectAgentTaskRef::Native{..})); assert!(second.next.is_none());
        assert!(store.read_project_agent_tasks(&scope,Some(true),None,20,"native-host","rho-host",&["run".into()]).unwrap().tasks.is_empty());
        let stale=store.read_project_agent_tasks(&scope,Some(false),None,20,"new-native","new-rho",&[]).unwrap();
        assert_eq!((stale.running,stale.permissions),(0,0)); assert_eq!(stale.attention_count,1); assert_eq!(stale.attention[0].attention_reason.as_deref(),Some("interrupted_run"));
        assert_eq!(stale.tasks.iter().map(|t|t.state.as_str()).collect::<Vec<_>>(),vec!["interrupted","disconnected"]);
        assert!(store.read_project_agent_tasks(&scope,None,Some("100:native:bad"),20,"native-host","rho-host",&["run".into()]).is_err());
        assert!(store.read_project_agent_tasks(&scope,None,Some("[100,\"rho\",\"valid.component:task\"]"),20,"native-host","rho-host",&[]).is_ok());
    }
    #[test]
    fn attention_uses_original_uncertain_facts_and_marks_partial_history_without_alerting_normal_work() {
        let store=store(); let id="00000000-0000-0000-0000-000000000002";
        native(&store,"p","alice",id,false,"native-host"); rho(&store,"p","alice",id,"rho-host");
        let scope=AgentTaskScope{project:"p".into(),principal:"alice".into()};
        {
            let c=store.0.lock().unwrap();
            c.execute("UPDATE component_agent_runs SET state='stopped'",[]).unwrap();
            c.execute("UPDATE agent_tasks SET history_gap=1",[]).unwrap();
        }
        let normal=store.read_project_agent_tasks(&scope,None,None,20,"native-host","rho-host",&[]).unwrap();
        assert_eq!(normal.attention_count,0); assert_eq!(normal.permissions,0); assert_eq!(normal.running,1);
        assert!(normal.tasks.iter().find(|t|t.provider.is_some()).unwrap().history_gap);
        {
            let c=store.0.lock().unwrap();
            c.execute("INSERT INTO agent_task_receipts VALUES('p','alice','request',?1,'digest',100,?2)",params![id,json!({"status":"submitted"}).to_string()]).unwrap();
        }
        assert_eq!(store.read_project_agent_tasks(&scope,None,None,20,"native-host","rho-host",&[]).unwrap().attention_count,0);
        let restarted=store.read_project_agent_tasks(&scope,None,None,20,"new-native","rho-host",&[]).unwrap();
        assert_eq!(restarted.attention_count,1); assert_eq!(restarted.attention[0].attention_reason.as_deref(),Some("unconfirmed_submission"));
        store.0.lock().unwrap().execute("UPDATE agent_task_receipts SET value=json_set(value,'$.status','uncertain')",[]).unwrap();
        assert_eq!(store.read_project_agent_tasks(&scope,None,None,20,"native-host","rho-host",&[]).unwrap().attention_count,1);
        store.0.lock().unwrap().execute("UPDATE component_agent_runs SET value=json_set(value,'$.run.recovery.unresolved_mutations',2)",[]).unwrap();
        let unresolved=store.read_project_agent_tasks(&scope,None,None,20,"native-host","rho-host",&[]).unwrap();
        assert_eq!(unresolved.attention_count,2);
        assert!(unresolved.attention.iter().any(|t|t.attention_reason.as_deref()==Some("unresolved_actions")));
    }
}
