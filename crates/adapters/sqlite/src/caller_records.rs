//! Scope, principal and exact owning caller all precede pagination.
use super::{SqliteOperationJournal, OPERATION_VISIBILITY, caller_kind, storage};
use rho_contract::{CallerIdentity, CapabilityRef, OperationId, OperationSummary, RecentOperations, RecentOperationsArguments};
use rho_operation::OperationError;
use rusqlite::params;
use serde_json::json;

pub(crate) fn read(journal: &SqliteOperationJournal, scope: &str, principal: &CallerIdentity, caller: &CallerIdentity, args: &RecentOperationsArguments) -> Result<RecentOperations, OperationError> {
    rho_operation::validate_recent_arguments(args)?; caller.validate()?;
    let connection=journal.connection()?;
    let mut statement=connection.prepare(&format!("SELECT op.rowid,op.operation_id,op.client_request_id,op.capability_id,op.capability_version,op.status,op.accepted_at_ms,op.updated_at_ms,substr(op.error,1,2048) FROM operations op WHERE {OPERATION_VISIBILITY} AND op.caller_kind=?8 AND op.caller_id=?9 AND op.rowid<?4 AND (?5 IS NULL OR op.client_request_id=?5) AND (?6 IS NULL OR op.operation_id=?6) ORDER BY op.rowid DESC LIMIT ?7")).map_err(storage)?;
    let mut rows=statement.query(params![scope,caller_kind(principal.kind),principal.id,args.before_cursor.unwrap_or(i64::MAX as u64) as i64,args.client_request_id,args.operation_id.as_ref().map(OperationId::as_str),args.limit+1,caller_kind(caller.kind),caller.id]).map_err(storage)?;
    let mut operations=Vec::new();
    while let Some(row)=rows.next().map_err(storage)? {
        let status:String=row.get(5).map_err(storage)?;
        operations.push(OperationSummary { cursor:row.get(0).map_err(storage)?,operation_id:OperationId::new(row.get::<_,String>(1).map_err(storage)?)?,client_request_id:row.get(2).map_err(storage)?,capability:CapabilityRef::new(row.get::<_,String>(3).map_err(storage)?,row.get(4).map_err(storage)?)?,status:serde_json::from_value(json!(status)).map_err(storage)?,accepted_at_ms:row.get(6).map_err(storage)?,updated_at_ms:row.get(7).map_err(storage)?,error:row.get(8).map_err(storage)? });
    }
    let next_cursor=(operations.len()>args.limit as usize).then(||operations[args.limit as usize-1].cursor);
    operations.truncate(args.limit as usize); Ok(RecentOperations{operations,next_cursor})
}

#[cfg(test)]
mod tests {
    use super::*;
    use rho_contract::*;
    use rho_operation::{CapabilityRegistry,OperationGateway,OperationJournal,SystemClock,UuidOperationIdGenerator};
    use std::sync::Arc;
    fn actor(id:&str)->CallerIdentity {CallerIdentity{kind:CallerKind::Agent,id:id.into()}}
    fn principal(id:&str)->CallerIdentity {CallerIdentity{kind:CallerKind::Human,id:id.into()}}
    fn operation(id:&str,caller:&str)->Operation {
        Operation { admission: None,operation_id:OperationId::new(id).unwrap(),client_request_id:id.into(),caller:actor(caller),principal:Some(principal("alice")),capability:CapabilityRef::new("workspace.run_r",1).unwrap(),domain:"workspace".into(),target:TargetRef{kind:"workspace".into(),identity:"original-session".into()},normalized_arguments:json!({"workspace_instance_id":"main","expected_session":"original-session"}),invocation_digest:id.into(),idempotency_scope:Some("/project".into()),preconditions:vec![],potential_effects:Default::default(),correlation_id:id.into(),causation_id:None,trace_parent:None,accepted_at_ms:1}
    }
    #[tokio::test]
    async fn caller_filter_preserves_principal_and_project_before_pagination() {
        let journal=SqliteOperationJournal::open_in_memory().unwrap();
        for (id,caller) in [("operation-a1","task:a"),("operation-b1","task:b"),("operation-a2","task:a")] {journal.admit(&operation(id,caller)).await.unwrap();}
        let mut args=RecentOperationsArguments{before_cursor:None,client_request_id:None,operation_id:None,limit:1};
        let first=journal.list_recent_for_caller("/project",&principal("alice"),&actor("task:a"),&args).await.unwrap();
        assert_eq!(first.operations[0].operation_id.as_str(),"operation-a2");
        args.before_cursor=first.next_cursor;
        let second=journal.list_recent_for_caller("/project",&principal("alice"),&actor("task:a"),&args).await.unwrap();
        assert_eq!(second.operations[0].operation_id.as_str(),"operation-a1"); assert!(second.next_cursor.is_none());
        args.before_cursor=None;
        assert_eq!(journal.list_recent_for_caller("/project",&principal("alice"),&actor("task:b"),&args).await.unwrap().operations[0].operation_id.as_str(),"operation-b1");
        assert!(journal.list_recent_for_caller("/project",&principal("bob"),&actor("task:a"),&args).await.unwrap().operations.is_empty());
        assert!(journal.list_recent_for_caller("/other",&principal("alice"),&actor("task:a"),&args).await.unwrap().operations.is_empty());
    }
    #[tokio::test]
    async fn task_operation_lookup_keeps_the_original_operation_read_permission() {
        let journal=Arc::new(SqliteOperationJournal::open_in_memory().unwrap()); journal.admit(&operation("operation-original","task:a")).await.unwrap();
        let gateway=OperationGateway::new(Arc::new(CapabilityRegistry::new()),journal,Arc::new(SystemClock),Arc::new(UuidOperationIdGenerator)).with_project_scope(Some("/project".into()));
        let mut context=CallContext{view_scope: None,caller:principal("alice"),principal:None,scopes:Default::default(),connection_id:"test".into(),correlation_id:None,causation_id:None,trace_parent:None};
        let args=RecentOperationsArguments{before_cursor:None,client_request_id:None,operation_id:None,limit:8};
        assert!(matches!(gateway.recent_for_caller(&context,&actor("task:a"),&args).await,Err(OperationError::AccessDenied{..})));
        context.scopes.insert("operation.read".into());
        let work=gateway.recent_for_caller(&context,&actor("task:a"),&args).await.unwrap();
        assert_eq!(work.operations[0].operation_id.as_str(),"operation-original");
        assert_eq!(gateway.get_operation(&context,&work.operations[0].operation_id).await.unwrap().unwrap().operation.target.identity,"original-session");
    }
}
