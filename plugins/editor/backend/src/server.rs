use crate::context::{Job, Step};
use rho_plugin_sdk::{BackendConnection, host_call_channel, protocol::*, validate_settlement};
use std::collections::{BTreeMap, BTreeSet, VecDeque};
use tokio::{
    io::{AsyncRead, AsyncWrite},
    sync::mpsc,
    task::JoinSet,
};
fn error(message: impl Into<String>) -> RpcBody {
    RpcBody::Error {
        code: "editor_unavailable".into(),
        message: message.into(),
        recovery: None,
    }
}
/// The Editor interprets its own captures. Scientific effects are delegated to
/// their original native owners, and all accepted child calls settle before release.
pub async fn serve<R, W>(mut connection: BackendConnection<R, W>) -> Result<(), String>
where
    R: AsyncRead + Unpin + Send + 'static,
    W: AsyncWrite + Unpin + Send + 'static,
{
    for id in ["documents.list", "documents.inspect", "documents.read"] {
        if !connection.grants.iter().any(|g| {
            g.capability.id.as_str() == id
                && g.capability.version == 1
                && g.scopes.contains("documents.read")
        }) {
            return Err(format!("Editor requires {id} with documents.read"));
        }
    }
    let instance = connection.instance.clone();
    let (host, mut pump) = host_call_channel(32).map_err(|e| e.to_string())?;
    connection.ready().await.map_err(|e| e.to_string())?;
    let (tx, mut incoming) = mpsc::channel(32);
    let mut reader = connection.reader;
    let reader_task = tokio::spawn(async move {
        loop {
            let next = reader.receive().await.map_err(|e| e.to_string());
            let end = !matches!(&next, Ok(Some(_)));
            if tx.send(next).await.is_err() || end {
                break;
            }
        }
    });
    let mut writer = connection.writer;
    let mut jobs = JoinSet::new();
    let mut active = BTreeSet::new();
    let mut operations: BTreeMap<OperationId, (RequestId, Option<PluginOutcome>)> = BTreeMap::new();
    let mut settled = VecDeque::new();
    let result = loop {
        tokio::select! {
            completed=jobs.join_next(),if !jobs.is_empty()=>{
                let Some(Ok((request,operation,reply)))=completed else {break Err("Editor job ended without its original result".into())};
                active.remove(&request);
                if let Some(operation)=operation {
                    let RpcBody::CommitPlan(plan)=&reply else {break Err("Editor operation lost its commit plan".into())};
                    operations.get_mut(&operation).ok_or("Missing original Editor operation")?.1=Some(plan.outcome);
                }
                if let Err(e)=writer.send(request,reply).await{break Err(e.to_string())}
            },
            outgoing=pump.next()=>{
                let Some(outgoing)=outgoing else{break Err("Editor reverse channel ended".into())};
                let RpcBody::HostCall{parent_request,..}=&outgoing.body else{unreachable!()};
                if !active.contains(parent_request){break Err("Editor reverse call lost its parent".into())}
                if let Err(e)=writer.send(outgoing.request,outgoing.body).await{break Err(e.to_string())}
            },
            next=incoming.recv()=>{
                let frame=match next{Some(Ok(Some(frame)))=>frame,Some(Err(e))=>break Err(e),_=>break Ok(())};
                if pump.contains(&frame.request){pump.respond(&frame.request,frame.body).map_err(|e|e.to_string())?;continue;}
                let request=frame.request;
                let mutation=matches!(&frame.body,RpcBody::Invoke(_));
                let reply=match frame.body {
                    RpcBody::Query(call)|RpcBody::Invoke(call)=>{
                        if call.request!=request || call.binding.provider!=instance.identity || call.binding.project!=instance.project
                            || call.principal!=instance.principal || call.operation_id.is_some()!=mutation
                            || call.binding.capability.version!=1 || call.binding.target.is_some() || !call.preconditions.is_null() {
                            break Err("Editor call differs from its original instance or scope".into());
                        }
                        let id=call.binding.capability.id.as_str();
                        let allowed=call.scopes.contains("documents.read") && if mutation {
                            call.scopes.contains("documents.write") && match id {
                                "editor.edit"=>true,
                                "editor.save"=>call.scopes.contains("project.write") && call.scopes.contains("project.read"),
                                "editor.run"=>call.scopes.contains("workspace.run_r"),_=>false,
                            }
                        }else{matches!(id,"editor.context.search"|"editor.context.preview")};
                        if !allowed{Some(error("Unsupported Editor capability or missing original scope"))}
                        else if active.len()>=16 || mutation && operations.len()>=32{Some(error("Editor capacity reached; inspect original requests"))}
                        else{
                            let operation=call.operation_id.as_ref().map(|id|OperationId::new(id).unwrap());
                            if let Some(id)=&operation {
                                if operations.contains_key(id)||settled.iter().any(|s:&OperationSettlement|s.operation_id==*id){break Err("Editor operation was dispatched twice".into())}
                                operations.insert(id.clone(),(request.clone(),None));
                            }
                            active.insert(request.clone());let instance=instance.clone();let host=host.clone();
                            let original = request.clone();
                            jobs.spawn(async move {
                                let reply=if mutation{RpcBody::CommitPlan(crate::actions::invoke(host,instance,call).await)}else{
                                    match context(&host,&instance,&call).await{Ok((data,completeness))=>RpcBody::QueryResult{data,completeness,source:None},Err(e)=>error(e)}
                                };(original,operation,reply)
                            });None
                        }
                    },
                    RpcBody::OperationSettled(value)=>{
                        validate_settlement(&instance,&value).map_err(|e|e.to_string())?;
                        if let Some((_,Some(outcome)))=operations.get(&value.operation_id) {
                            if *outcome!=value.outcome{break Err("Editor settlement differs from its original outcome".into())}
                            operations.remove(&value.operation_id);settled.push_back(value.clone());if settled.len()>128{settled.pop_front();}
                            Some(RpcBody::SettlementAcknowledged(value))
                        }else if settled.contains(&value){Some(RpcBody::SettlementAcknowledged(value))}
                        else{Some(error("Original Editor action has not settled"))}
                    },
                    RpcBody::Cancel{operation_id}=>Some(RpcBody::CancelAcknowledged{operation_id,confirmed:false}),
                    RpcBody::Release if jobs.is_empty()&&operations.is_empty()=>{break writer.send(request,RpcBody::Released).await.map_err(|e|e.to_string())},
                    RpcBody::Release=>Some(error("Original Editor actions are still pending")),
                    _=>Some(error("Unexpected Editor message")),
                };
                if let Some(reply)=reply{if let Err(e)=writer.send(request,reply).await{break Err(e.to_string())}}
            }
        }
    };
    pump.close();
    while jobs.join_next().await.is_some() {}
    reader_task.abort();
    result
}
async fn context(
    host: &rho_plugin_sdk::HostCallClient,
    instance: &PluginInstance,
    call: &PluginCall,
) -> Result<(serde_json::Value, ObservationCompleteness), String> {
    let (mut job, mut step) = Job::start(instance, call).map_err(|e| e.message)?;
    let mut serial = 0;
    loop {
        match step {
            Step::Complete { data, completeness } => return Ok((data, completeness)),
            Step::Read {
                capability,
                arguments,
            } => {
                use sha2::{Digest, Sha256};
                serial += 1;
                let request = RequestId::new(format!(
                    "context-{:x}-{serial}",
                    Sha256::digest(call.request.as_str().as_bytes())
                ))
                .map_err(|e| e.to_string())?;
                let result = host
                    .begin(
                        request,
                        call.request.clone(),
                        CapabilityKey {
                            id: ContributionId::new(capability).unwrap(),
                            version: 1,
                        },
                        arguments,
                    )
                    .map_err(|e| e.to_string())?
                    .receive()
                    .await
                    .map_err(|e| e.to_string())?;
                step = job.resume(result).map_err(|e| e.message)?;
            }
        }
    }
}
