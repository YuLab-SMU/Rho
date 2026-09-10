//! Deterministic, user-configured maintenance. The idle task holds only a Weak
//! reference; accepted maintenance retains the ordinary owner, journal and lease.
use super::*;
use sha2::{Digest, Sha256};
use std::time::Instant;
fn stored(error:impl std::fmt::Display)->OperationError {OperationError::Storage(error.to_string())}

#[derive(Default, Clone, Serialize, Deserialize)]
struct ProtectionMetadata {
    #[serde(default)] lineage: String,
    #[serde(default)] activity: u64,
    #[serde(default)] last_attempt_ms: i64,
    #[serde(default)] pending_request: Option<String>,
    #[serde(default)] pending_operation: Option<OperationId>,
    #[serde(default)] checkpoint: Option<OperationId>,
    #[serde(default)] saved_at_ms: Option<i64>,
    #[serde(default)] saved_objects: Option<u32>,
    #[serde(default)] skipped_objects: Option<u32>,
    #[serde(default)] error: Option<String>,
}
fn key(id:&str)->String {format!("hosting.protection.{}",hex_name(id))}
fn hex_name(value:&str)->String {format!("{:x}",Sha256::digest(value.as_bytes()))}
fn metadata(store:&ApplicationStore,scope:&str,id:&str)->Result<ProtectionMetadata,OperationError>{
    let state=store.read(scope,&key(id)).map_err(stored)?;
    if state.value.is_null(){Ok(ProtectionMetadata::default())}else{serde_json::from_value(state.value).map_err(stored)}
}
fn update_metadata(store:&ApplicationStore,scope:&str,id:&str,change:impl Fn(&mut ProtectionMetadata))->Result<(),OperationError>{
    for _ in 0..3 {
        let mut state=store.read(scope,&key(id)).map_err(stored)?;
        let mut value=if state.value.is_null(){ProtectionMetadata::default()}else{serde_json::from_value(state.value.clone()).map_err(stored)?};
        change(&mut value);state.value=serde_json::to_value(value).map_err(stored)?;
        match store.write(scope,&state){Ok(_)=>return Ok(()),Err(e) if e.contains("changed in another window")=>continue,Err(e)=>return Err(stored(e))}
    }
    Err(OperationError::Storage("Recovery summary changed concurrently; original records remain available".into()))
}
fn observe_result(value:&mut ProtectionMetadata,record:&OperationRecord){
    value.pending_request=None;value.pending_operation=None;
    if record.outcome==Some(OperationOutcome::Succeeded) {
        if let Some(manifest)=record.output.clone().and_then(|v|serde_json::from_value::<CheckpointManifest>(v).ok()){
            value.lineage=manifest.continuation_lineage_id;value.activity=manifest.activity_boundary;
            value.checkpoint=Some(manifest.checkpoint_id);value.saved_at_ms=Some(manifest.created_at_ms);
            value.saved_objects=Some(manifest.report.saved_names.len() as u32);
            value.skipped_objects=Some(manifest.report.skipped.len() as u32);value.error=None;
        }
    } else {value.error=record.error.clone().or_else(||Some("Recovery copy was not confirmed; the previous copy remains available".into()));}
}

struct Budget {project:String,instance:String,root:Option<PathBuf>,store:Arc<ApplicationStore>,app:Arc<ApplicationStore>}
impl Budget {
    fn policy(&self)->Result<RuntimePolicy,OperationError>{
        let mut policy=RuntimePolicy::default();
        for (store,scope,key) in [(&self.app,"user".to_string(),POLICY_KEY.to_string()),
            (&self.store,format!("project:{}",self.project),POLICY_KEY.to_string()),
            (&self.store,format!("project:{}",self.project),format!("hosting.instance_policy.{}",self.instance))]{
            InstanceOwner::decode_policy(&store.read(&scope,&key).map_err(stored)?)?.apply_to(&mut policy);
        }
        validate_policy(&policy)?;Ok(policy)
    }
}
#[async_trait]
impl CheckpointBudget for Budget {
    async fn reserve(&self,operation:&Operation,max_bytes:u64)->Result<Box<dyn CheckpointReservation>,HandlerError>{
        let policy=self.policy().map_err(before)?;
        let automatic=operation.normalized_arguments["automatic"]==true;
        if policy.mode==RuntimeContinuationMode::Off {return Err(before("Object recovery copies are disabled for this session"));}
        if automatic && (policy.mode==RuntimeContinuationMode::Manual || max_bytes>policy.automatic_payload_limit_bytes){return Err(before("Automatic capture exceeds the selected recovery policy"));}
        let Some(base)=self.root.clone() else{return Ok(Box::new(NoReservation));};
        let path=base.join("checkpoints").join(hex_name(&self.project)).join(hex_name(operation.operation_id.as_str()));
        let available=fs4::available_space(&base).map_err(before)?;
        let reserved=max_bytes.checked_add(2*1024*1024).ok_or_else(||before("Recovery reservation overflow"))?;
        if available.checked_sub(reserved).is_none_or(|left|left<policy.minimum_free_bytes){return Err(before("Not enough available disk space to preserve the recovery free-space reserve"));}
        self.app.reserve_runtime_storage(&self.project,operation.operation_id.as_str(),&path.to_string_lossy(),reserved,policy.project_storage_limit_bytes,policy.global_storage_limit_bytes).map_err(before)?;
        if automatic {
            update_metadata(&self.store,&format!("project:{}",self.project),&self.instance,|m|m.pending_operation=Some(operation.operation_id.clone())).map_err(before)?;
        }
        Ok(Box::new(Reservation {project:self.project.clone(),instance:self.instance.clone(),operation:operation.operation_id.clone(),path,store:self.store.clone(),app:self.app.clone()}))
    }
}
struct NoReservation;
impl CheckpointReservation for NoReservation {fn completed(&mut self,_:&Result<OperationRecord,OperationError>) {}}
struct Reservation {project:String,instance:String,operation:OperationId,path:PathBuf,store:Arc<ApplicationStore>,app:Arc<ApplicationStore>}
fn artifact_bytes(path:&Path)->Result<u64,String>{
    if !path.exists(){return Ok(0)}
    let metadata=std::fs::symlink_metadata(path).map_err(|e|e.to_string())?;
    if !metadata.is_dir() || metadata.file_type().is_symlink(){return Err("Unexpected recovery artifact directory".into());}
    let mut bytes=0u64;
    for (index,entry) in std::fs::read_dir(path).map_err(|e|e.to_string())?.enumerate(){
        if index>=256{return Err("Recovery accounting metadata budget exceeded".into());}
        let entry=entry.map_err(|e|e.to_string())?;let m=entry.file_type().map_err(|e|e.to_string())?;
        if !m.is_file() || m.is_symlink(){return Err("Unexpected entry in recovery artifact storage".into());}
        bytes=bytes.checked_add(entry.metadata().map_err(|e|e.to_string())?.len()).ok_or("Recovery size overflow")?;
    }
    Ok(bytes)
}
impl CheckpointReservation for Reservation {
    fn completed(&mut self,result:&Result<OperationRecord,OperationError>){
        if let Ok(record)=result {
            if record.outcome!=Some(OperationOutcome::Uncertain) {
                if let Ok(bytes)=artifact_bytes(&self.path){let _=self.app.settle_runtime_storage(&self.project,self.operation.as_str(),bytes);}
            }
            let _=update_metadata(&self.store,&format!("project:{}",self.project),&self.instance,|m|observe_result(m,record));
        }
        // No Drop release: an unconfirmed native writer may still own its bytes.
    }
}

impl InstanceOwner {
    pub(crate) fn checkpoint_budget(&self,id:&str)->Result<Arc<dyn CheckpointBudget>,OperationError>{
        validate_id(id)?;
        Ok(Arc::new(Budget {project:self.project.clone(),instance:id.into(),root:self.launcher.storage_root(),store:self.store.clone(),app:self.app_store.clone()}))
    }
    pub(crate) fn protection_status(&self,id:&str)->Result<RuntimeProtectionStatus,OperationError>{
        let m=metadata(&self.store,&self.scope(),id)?;
        let state=self.state.lock().unwrap_or_else(|e|e.into_inner());
        let slot=state.instances.get(id).ok_or_else(||OperationError::NotFound(id.into()))?;
        let current=m.lineage==slot.stored.lineage;
        Ok(RuntimeProtectionStatus {latest_checkpoint_id:current.then_some(m.checkpoint).flatten(),
            saved_at_ms:current.then_some(m.saved_at_ms).flatten(),saved_objects:current.then_some(m.saved_objects).flatten(),
            skipped_objects:current.then_some(m.skipped_objects).flatten(),
            activity_since_copy:slot.stored.activity>0 && (!current || slot.stored.activity>m.activity),
            capture_available:slot.live.as_ref().is_some_and(|live|live.checkpoint.capture_available()),
            automatic_pending:m.error.is_none()&&(m.pending_request.is_some()||m.pending_operation.is_some()),last_error:m.error})
    }
    pub(crate) fn request_protection_yield(&self,id:&str){
        let Ok(m)=metadata(&self.store,&self.scope(),id) else{return};
        let (Some(operation),Ok(gateway))=(m.pending_operation,self.gateway())else{return};
        tokio::spawn(async move{let _=gateway.request_cancellation(&crate::NextHost::local_context(),&operation).await;});
    }
    pub(crate) fn start_protection(self:&Arc<Self>){
        let weak=Arc::downgrade(self);
        tokio::spawn(async move{
            let mut quiet:BTreeMap<String,(String,u64,Instant)>=BTreeMap::new();
            let mut unattended:BTreeMap<String,(String,u64,Instant)>=BTreeMap::new();
            let mut interval=tokio::time::interval(Duration::from_secs(1));
            interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
            loop {
                interval.tick().await;
                let Some(owner)=weak.upgrade()else{break};
                if owner.state.lock().unwrap_or_else(|e|e.into_inner()).shutdown{break;}
                owner.protection_tick(&mut quiet,&mut unattended).await;
            }
        });
    }
    async fn protection_tick(&self,quiet:&mut BTreeMap<String,(String,u64,Instant)>,unattended:&mut BTreeMap<String,(String,u64,Instant)>){
        let candidates={let state=self.state.lock().unwrap_or_else(|e|e.into_inner());
            state.instances.iter().filter_map(|(id,slot)|{
                if slot.stored.state!=RuntimeInstanceState::Ready {return None;}
                let live=slot.live.clone()?;Some((id.clone(),slot.stored.lineage.clone(),slot.stored.activity,live))
            }).collect::<Vec<_>>()};
        let ids:BTreeSet<_>=candidates.iter().map(|(id,_,_,_)|id.clone()).collect();
        quiet.retain(|id,_|ids.contains(id));
        unattended.retain(|id,_|ids.contains(id));
        self.idle_release(unattended,&candidates).await;
        for (id,lineage,activity,live) in candidates {
            if !live.checkpoint.capture_available() || live.runtime.execution_state()!="idle"{quiet.remove(&id);continue;}
            let entry=quiet.entry(id.clone()).or_insert_with(||(live.runtime.session_id().into(),activity,Instant::now()));
            if entry.0!=live.runtime.session_id()||entry.1!=activity{*entry=(live.runtime.session_id().into(),activity,Instant::now());}
            let Ok(policy)=self.settings(Some(&id)).map(|s|s.effective.value)else{continue};
            if !matches!(policy.mode,RuntimeContinuationMode::AutoContinue|RuntimeContinuationMode::SaveStartEmpty){continue;}
            if entry.2.elapsed()<Duration::from_secs(policy.idle_delay_seconds.into()){continue;}
            if !Self::blockers_locked(&self.state.lock().unwrap_or_else(|e|e.into_inner()),&id).is_empty(){continue;}
            let Ok(mut meta)=metadata(&self.store,&self.scope(),&id)else{continue};
            if let Some(request)=meta.pending_request.clone(){
                if let Ok(page)=self.journal.list_recent(&self.project,crate::NextHost::local_context().principal(),&RecentOperationsArguments{before_cursor:None,client_request_id:Some(request),operation_id:None,limit:1}).await {
                    if let Some(summary)=page.operations.first(){
                        if let Ok(Some(record))=self.journal.get(&summary.operation_id).await {
                            if record.outcome.is_none(){continue;}
                            let _=update_metadata(&self.store,&self.scope(),&id,|m|observe_result(m,&record));
                        }
                    }else{let _=update_metadata(&self.store,&self.scope(),&id,|m|{m.pending_request=None;m.pending_operation=None;});}
                }else{continue;}
                meta=match metadata(&self.store,&self.scope(),&id){Ok(m)=>m,Err(_)=>continue};
            }
            let now=match now(){Ok(v)=>v,Err(_)=>continue};
            if meta.lineage==lineage&&meta.checkpoint.is_some()&&meta.activity>=activity{continue;}
            if now.saturating_sub(meta.last_attempt_ms)<i64::from(policy.automatic_interval_seconds)*1000{continue;}
            let request=format!("auto-copy-{}",uuid::Uuid::new_v4().simple());
            if update_metadata(&self.store,&self.scope(),&id,|m|{m.last_attempt_ms=now;m.pending_request=Some(request.clone());m.error=None;}).is_err(){continue;}
            let selected=policy.object_selection==CheckpointObjectSelection::Selected;
            let arguments=json!({"workspace_instance_id":id,"expected_session":live.runtime.session_id(),"automatic":true,
                "max_bytes":policy.automatic_payload_limit_bytes,"max_seconds":f64::from(policy.capture_budget_ms)/1000.0,
                "include_names":if selected{Some(&policy.include_names)}else{None},"exclude_names":policy.exclude_names,
                "include_patterns":if selected{policy.include_patterns.as_slice()}else{&[]},"exclude_patterns":policy.exclude_patterns});
            let result=match self.gateway(){Ok(gateway)=>gateway.invoke(&crate::NextHost::local_context(),Invocation{client_request_id:request,
                capability:CapabilityRef::new("workspace.checkpoint_capture",1).unwrap(),arguments,preconditions:vec![Precondition{kind:"workspace.session".into(),subject:"active".into(),expected:json!(live.runtime.session_id())}]}).await,Err(e)=>Err(e)};
            match result{Ok(record)=>{let _=update_metadata(&self.store,&self.scope(),&id,|m|observe_result(m,&record));
                if record.outcome==Some(OperationOutcome::Succeeded){self.prune_copies(&id,&live,&policy,now).await;}
            },Err(error)=>{
                let _=update_metadata(&self.store,&self.scope(),&id,|m|m.error=Some(error.to_string()));
            }}
        }
    }

    /// Optional advanced policy: end a session nobody is watching, and only once
    /// its objects are completely protected. Anything uncertain keeps it running,
    /// because ending live R memory cannot be undone.
    async fn idle_release(&self,unattended:&mut BTreeMap<String,(String,u64,Instant)>,candidates:&[(String,String,u64,Arc<InstanceLive>)]){
        if self.windows_online(){unattended.clear();return;}
        for (id,_lineage,activity,live) in candidates {
            let session=live.runtime.session_id().to_string();
            let Ok(policy)=self.settings(Some(id)).map(|s|s.effective.value)else{unattended.remove(id);continue};
            let Some(seconds)=policy.idle_stop_without_windows_seconds else{unattended.remove(id);continue};
            if live.runtime.execution_state()!="idle"
                ||!Self::blockers_locked(&self.state.lock().unwrap_or_else(|e|e.into_inner()),id).is_empty(){unattended.remove(id);continue;}
            let since={
                let entry=unattended.entry(id.clone()).or_insert_with(||(session.clone(),*activity,Instant::now()));
                if entry.0!=session||entry.1!=*activity{*entry=(session.clone(),*activity,Instant::now());}
                entry.2
            };
            if since.elapsed()<Duration::from_secs(seconds.into()){continue;}
            let Ok(protection)=self.protection_status(id)else{continue};
            // A pending, failed, missing or stale copy is never a reason to end live
            // memory; producing one stays the ordinary automatic-protection job.
            if protection.automatic_pending||protection.last_error.is_some()||protection.activity_since_copy
                ||(*activity>0&&protection.latest_checkpoint_id.is_none()){continue;}
            let Ok(gateway)=self.gateway()else{continue};
            let result=gateway.invoke(&crate::NextHost::local_context(),Invocation{
                client_request_id:format!("idle-release-{}",uuid::Uuid::new_v4().simple()),
                capability:CapabilityRef::new("runtime.stop_instance",1).unwrap(),
                arguments:json!({"workspace_instance_id":id,"expected_native_session_id":session,"discard_unsaved_objects":false}),
                preconditions:vec![]}).await;
            if result.is_ok_and(|record|record.outcome==Some(OperationOutcome::Succeeded)){unattended.remove(id);}
            else{unattended.insert(id.clone(),(session,*activity,Instant::now()));}
        }
    }

    async fn prune_copies(&self,id:&str,live:&InstanceLive,policy:&RuntimePolicy,at_ms:i64){
        let context=crate::NextHost::local_context();
        let mut entries=Vec::new();let mut before=None;let mut complete=false;
        for _ in 0..10 {
            let page=match live.checkpoint.list_for(&context,&CheckpointListArguments{before,limit:50}).await{Ok(p)=>p,Err(_)=>return};
            entries.extend(page.entries);before=page.next;
            if before.is_none(){complete=true;break;}
        }
        // Incomplete enumeration cannot establish that a recovery point is redundant.
        if !complete{return;}
        entries.sort_by(|a,b|b.manifest.created_at_ms.cmp(&a.manifest.created_at_ms));
        let retained=retained_copies(&entries,policy,at_ms);
        let Ok(gateway)=self.gateway()else{return};
        for entry in entries.iter().rev().filter(|e|e.manifest.automatic&&!retained.contains(e.manifest.checkpoint_id.as_str())).take(5){
            let checkpoint=&entry.manifest.checkpoint_id;
            let result=gateway.invoke(&context,Invocation{client_request_id:format!("retire-copy-{}",uuid::Uuid::new_v4().simple()),
                capability:CapabilityRef::new("workspace.checkpoint_delete",1).unwrap(),
                arguments:json!({"workspace_instance_id":id,"checkpoint_id":checkpoint,"pinned":false}),preconditions:vec![]}).await;
            if result.as_ref().is_ok_and(|r|r.outcome==Some(OperationOutcome::Succeeded)){
                if let Some(base)=self.launcher.storage_root(){
                    let path=base.join("checkpoints").join(hex_name(&self.project)).join(hex_name(checkpoint.as_str()));
                    if let Ok(bytes)=artifact_bytes(&path){let _=self.app_store.settle_runtime_storage(&self.project,checkpoint.as_str(),bytes);}
                }
            }
        }
    }
}

fn retained_copies(entries:&[CheckpointEntry],policy:&RuntimePolicy,at_ms:i64)->BTreeSet<String>{
    let mut retained=BTreeSet::new();
    if let Some(latest)=entries.iter().find(|e|e.available){retained.insert(latest.manifest.checkpoint_id.as_str().into());}
    if let Some(complete)=entries.iter().find(|e|e.available&&e.manifest.report.coverage==CheckpointCoverage::CompleteEligibleGraph){retained.insert(complete.manifest.checkpoint_id.as_str().into());}
    let mut recent=0;let mut days=BTreeSet::new();
    let earliest=at_ms.saturating_sub(i64::from(policy.daily_retention_days)*86_400_000);
    for entry in entries {
        let manifest=&entry.manifest;let id=manifest.checkpoint_id.as_str();
        if entry.pinned||!manifest.automatic{retained.insert(id.into());continue;}
        if recent<policy.recent_checkpoints{retained.insert(id.into());recent+=1;}
        if policy.daily_retention_days>0&&manifest.created_at_ms>=earliest&&days.insert(manifest.created_at_ms.div_euclid(86_400_000)){retained.insert(id.into());}
    }
    retained
}
