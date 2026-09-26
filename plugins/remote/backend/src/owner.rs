use crate::source::{self, Qualification};
use rho_plugin_sdk::{ResourceClient, protocol::*};
use rho_process_api::{OutputCapture, ProcessActivity, ProcessPhase};
use rho_remote_api::*;
use rho_remote_owner::{RemoteOwnerError, SshRemoteOwner};
use serde::Deserialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    path::Path,
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::sync::{OwnedMutexGuard, watch};

const CAPACITY: usize = 16;
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Empty {}
struct Entry {
    binding: ProviderBinding,
    phase: ProcessPhase,
    outcome: Option<PluginOutcome>,
    lane: Option<OwnedMutexGuard<()>>,
}
pub struct Owner {
    root: String,
    native: Option<SshRemoteOwner>,
    target_key: Option<String>,
    lane: Arc<tokio::sync::Mutex<()>>,
    accepted: Mutex<BTreeMap<OperationId, Entry>>,
    resources: ResourceClient,
}
impl Owner {
    pub fn new(
        environment: BackendEnvironment,
        configuration: Value,
        resources: ResourceClient,
    ) -> Result<Self, String> {
        let config: RemoteConfiguration =
            serde_json::from_value(configuration).map_err(|e| e.to_string())?;
        let root = Path::new(&environment.project_root);
        if !root.is_absolute()
            || !root.is_dir()
            || root.canonicalize().map_err(|e| e.to_string())? != root
        {
            return Err("Remote requires the normalized Host project root".into());
        }
        let native = config
            .target
            .map(|target| SshRemoteOwner::new(root, target))
            .transpose()?;
        // A short opaque target identity supports full-length native POSIX paths.
        // Original root/host/cluster evidence remains in the frozen qualification.
        let target_key = native
            .as_ref()
            .map(|native| format!("ssh:sha256:{:x}", Sha256::digest(native.scope().as_bytes())));
        Ok(Self {
            root: environment.project_root,
            native,
            target_key,
            lane: Arc::new(tokio::sync::Mutex::new(())),
            accepted: Mutex::new(BTreeMap::new()),
            resources,
        })
    }
    fn native(&self) -> Result<&SshRemoteOwner, String> {
        self.native
            .as_ref()
            .ok_or_else(|| "Configure an explicit SSH target before remote work".into())
    }
    fn base(&self) -> Result<Qualification, String> {
        Ok(Qualification {
            project_root: self.root.clone(),
            remote_target: self.native()?.target().clone(),
            source: None,
        })
    }
    fn common(&self, call: &PluginCall) -> Result<(), String> {
        let cap = &call.binding.capability;
        if !source::scopes(cap.id.as_str()).is_subset(&call.scopes)
            || call
                .binding
                .target
                .as_ref()
                .is_some_and(|value| Some(value) != self.target_key.as_ref())
            || !(call.preconditions.is_null() || call.preconditions == json!([]))
        {
            return Err("Remote call is missing its declared scope or exact target".into());
        }
        if Path::new(&self.root)
            .canonicalize()
            .map_err(|e| e.to_string())?
            != Path::new(&self.root)
            || !Path::new(&self.root).is_dir()
        {
            return Err("Remote project root changed".into());
        }
        if cap.id.as_str() == "remote.status" && cap.version == 1 {
            return Ok(());
        }
        if cap.version != 2 {
            return Err("Unsupported remote capability version".into());
        }
        let native = self.native()?;
        native.check_root()?;
        if cap.id.as_str().starts_with("slurm.") && !native.has_slurm() {
            return Err("The configured target has no Slurm cluster".into());
        }
        Ok(())
    }
    fn query_call(&self, call: &PluginCall) -> Result<(), String> {
        self.common(call)?;
        if call.operation_id.is_some()
            || !call.owner_context.is_null()
            || !call.preconditions.is_null()
        {
            return Err("Remote queries cannot carry mutation qualifications".into());
        }
        Ok(())
    }
    fn preflight(&self, call: &PluginCall) -> Result<PluginPreflightRequest, String> {
        self.query_call(call)?;
        let expected = source::prepared_operation(call.binding.capability.id.as_str())
            .ok_or("Unsupported remote preflight")?;
        let mut request: PluginPreflightRequest =
            serde_json::from_value(call.arguments.clone()).map_err(|e| e.to_string())?;
        if request.capability.id.as_str() != expected
            || request.capability.version != 2
            || request
                .target
                .as_ref()
                .is_some_and(|value| Some(value) != self.target_key.as_ref())
            || !(request.preconditions.is_null() || request.preconditions == json!([]))
        {
            return Err(
                "Remote preflight changed its capability, target or native preconditions".into(),
            );
        }
        request.arguments = source::normalize(expected, request.arguments)?;
        Ok(request)
    }
    pub fn query(&self, call: &PluginCall) -> Result<Value, String> {
        self.query_call(call)?;
        if call.binding.capability.id.as_str() == "remote.status" {
            serde_json::from_value::<Empty>(call.arguments.clone()).map_err(|e| e.to_string())?;
            return Ok(json!(RemoteStatus {
                target: self.native.as_ref().map(|native| native.target().clone()),
                target_key: self.target_key.clone(),
                activities: self
                    .accepted
                    .lock()
                    .unwrap()
                    .iter()
                    .map(|(id, entry)| ProcessActivity {
                        operation: id.clone(),
                        phase: entry.phase
                    })
                    .collect(),
                capacity: CAPACITY as u16
            }));
        }
        let request = self.preflight(call)?;
        if source::needs_source(request.capability.id.as_str()) {
            return Err("An original-operation observation is required".into());
        }
        Ok(json!(PluginPreflightResult {
            arguments: request.arguments,
            target: self.target_key.clone(),
            owner_context: json!(self.base()?)
        }))
    }
    pub fn source_request(&self, call: &PluginCall) -> Result<OperationId, String> {
        self.query_call(call)?;
        let id = call.binding.capability.id.as_str();
        if id == source::SNAPSHOT {
            source::original_source(&call.arguments)
        } else if source::needs_source(id) {
            source::original_source(&self.preflight(call)?.arguments)
        } else {
            Err("Unsupported original-submission query".into())
        }
    }
    pub async fn complete_source(
        &self,
        call: &PluginCall,
        observation: Value,
    ) -> Result<Value, String> {
        let source = self.source_request(call)?;
        let (qualification, terminal) = source::qualify_original(
            call,
            &source,
            &self.base()?,
            self.target_key.as_deref().unwrap(),
            &observation,
        )?;
        if call.binding.capability.id.as_str() != source::SNAPSHOT {
            if !terminal {
                return Err(
                    "Original submission is still active; observe it before recovery".into(),
                );
            }
            return Ok(json!(PluginPreflightResult {
                arguments: self.preflight(call)?.arguments,
                target: self.target_key.clone(),
                owner_context: json!(qualification)
            }));
        }
        let snapshot = |status, lookup, notice: String| {
            json!(SlurmSnapshot {
                source_operation: source.clone(),
                status,
                lookup,
                notice
            })
        };
        if !terminal {
            return Ok(snapshot(
                SlurmSnapshotStatus::Busy,
                None,
                "Original submission is still active; this read does not resubmit it.".into(),
            ));
        }
        let Ok(_lane) = self.lane.try_lock() else {
            return Ok(snapshot(
                SlurmSnapshotStatus::Busy,
                None,
                "Native work or original settlement is still pending.".into(),
            ));
        };
        match self.native()?.find(&source).await {
            Ok(lookup) => {
                let notice = if lookup.jobs.len() == 1 {
                    "Observed one matching native allocation."
                } else {
                    "No unique native job is observed within the stated accounting lookback. Absence or ambiguity does not prove the submission failed."
                };
                Ok(snapshot(
                    SlurmSnapshotStatus::Ready,
                    Some(lookup),
                    notice.into(),
                ))
            }
            Err(error) => Ok(snapshot(SlurmSnapshotStatus::Unavailable, None, error)),
        }
    }
    fn qualification(&self, call: &PluginCall) -> Result<Qualification, String> {
        self.common(call)?;
        let id = call.binding.capability.id.as_str();
        if !matches!(
            id,
            source::RUN | source::SUBMIT | source::RECONCILE | source::CANCEL
        ) || call.binding.target != self.target_key
            || call.operation_id.is_none()
        {
            return Err("Unsupported admitted remote operation".into());
        }
        source::normalize(id, call.arguments.clone())?;
        let source = source::needs_source(id)
            .then(|| source::original_source(&call.arguments))
            .transpose()?;
        let qualification: Qualification =
            serde_json::from_value(call.owner_context.clone()).map_err(|e| e.to_string())?;
        qualification.validate(
            call,
            &self.base()?,
            self.target_key.as_deref().unwrap(),
            source.as_ref(),
        )?;
        Ok(qualification)
    }
    pub fn admit(&self, call: &PluginCall) -> Result<(), String> {
        self.qualification(call)?;
        let id = original(call)?;
        let mut entries = self.accepted.lock().unwrap();
        if entries.len() >= CAPACITY || entries.contains_key(&id) {
            return Err("Remote capacity reached or original operation already dispatched".into());
        }
        entries.insert(
            id,
            Entry {
                binding: call.binding.clone(),
                phase: ProcessPhase::Waiting,
                outcome: None,
                lane: None,
            },
        );
        Ok(())
    }
    pub async fn execute(
        &self,
        call: &PluginCall,
        mut cancellation: watch::Receiver<bool>,
    ) -> PluginCommitPlan {
        let id = original(call).expect("validated admission");
        let lane = tokio::select! { biased; _ = cancelled(&mut cancellation) => None, lane = self.lane.clone().lock_owned() => Some(lane) };
        let plan = if lane.is_none() || *cancellation.borrow() {
            if call.binding.capability.id.as_str() == source::RUN {
                PluginCommitPlan {
                    outcome: PluginOutcome::Cancelled,
                    output: None,
                    error: None,
                    recovery: None,
                    facts: vec![],
                    evidence: vec![],
                    cancellation_confirmed: true,
                }
            } else {
                failed("Scheduler work did not start before its control channel ended")
            }
        } else {
            self.accepted.lock().unwrap().get_mut(&id).unwrap().phase = ProcessPhase::Running;
            match self.qualification(call) {
                Err(error) => failed(error),
                Ok(qualification) => self.perform(call, &id, qualification, cancellation).await,
            }
        };
        let mut entries = self.accepted.lock().unwrap();
        let entry = entries.get_mut(&id).expect("admitted original operation");
        entry.phase = ProcessPhase::AwaitingSettlement;
        entry.outcome = Some(plan.outcome);
        entry.lane = lane;
        plan
    }
    async fn perform(
        &self,
        call: &PluginCall,
        id: &OperationId,
        qualification: Qualification,
        cancellation: watch::Receiver<bool>,
    ) -> PluginCommitPlan {
        let native = self.native().expect("validated admission");
        match call.binding.capability.id.as_str() {
            source::RUN => match native
                .execute(
                    id,
                    &serde_json::from_value(call.arguments.clone()).unwrap(),
                    cancellation,
                )
                .await
            {
                Ok(report) => self.publish(call, id, report).await,
                Err(error) => native_error(error),
            },
            source::SUBMIT => match native
                .submit(id, &serde_json::from_value(call.arguments.clone()).unwrap())
                .await
            {
                Ok(job) => result(call, json!(job), "submission"),
                Err(error) => native_error(error),
            },
            action => {
                let source = qualification.source.unwrap().operation;
                let lookup = match native.find(&source).await {
                    Ok(lookup) => lookup,
                    Err(error) => {
                        return uncertain(
                            error,
                            json!({"source_operation_id":source,"automatic_reexecution":false}),
                        );
                    }
                };
                if lookup.jobs.len() != 1 {
                    return if action == source::RECONCILE {
                        let mut plan = result(call, json!(lookup), "reconciliation");
                        plan.outcome = PluginOutcome::Uncertain;
                        plan.error = Some(
                            "No unique native allocation observed; no resubmission is authorized"
                                .into(),
                        );
                        plan.recovery = Some(json!(SlurmReconcileRecovery::Unresolved {
                            source_operation_id: source.to_string(),
                            action: "preserve_original_identity_and_observe_without_resubmission"
                                .into()
                        }));
                        plan
                    } else {
                        uncertain(
                            "Cancellation requires one current native allocation",
                            json!(SlurmCancelRecovery::Ambiguous {
                                source_operation_id: source.to_string(),
                                lookup
                            }),
                        )
                    };
                }
                if action == source::RECONCILE {
                    return result(call, json!(lookup), "reconciliation");
                }
                match native.request_cancel(&source, &lookup.jobs[0]).await {
                    Ok(report) => result(call, json!(report), "cancellation-observation"),
                    Err(error) => native_error(error),
                }
            }
        }
    }
    async fn publish(
        &self,
        call: &PluginCall,
        id: &OperationId,
        report: RemoteExecutionReport,
    ) -> PluginCommitPlan {
        let bytes = serde_json::to_vec(&report).expect("native report serialization");
        let digest = ContentDigest::new(format!("sha256:{:x}", Sha256::digest(&bytes))).unwrap();
        let transfer = self.resources.put(
            call.request.clone(),
            ResourceDeclaration {
                digest: digest.clone(),
                media_type: "application/json".into(),
                bytes: bytes.len() as u64,
            },
            bytes.as_slice(),
        );
        let resource = match tokio::time::timeout(Duration::from_secs(30), transfer).await {
            Ok(Ok(resource)) if resource.owner == call.binding.provider => resource,
            response => {
                return uncertain(
                    match response {
                        Ok(Err(error)) => error.to_string(),
                        Ok(Ok(_)) => "Remote report acknowledgement changed its owner".into(),
                        Err(_) => "Remote report transfer is unconfirmed".into(),
                    },
                    json!(self.recovery(id, &report, None, digest)),
                );
            }
        };
        let native_outcome = report.outcome;
        let output = RemoteRunResult {
            operation: id.clone(),
            target: report.target.clone(),
            report: resource.clone(),
            remote_exit_code: report.remote_exit_code,
            native_outcome,
        };
        let mut plan = result(call, json!(output), "remote-report");
        plan.outcome = match native_outcome {
            RemoteExecutionOutcome::Succeeded => PluginOutcome::Succeeded,
            RemoteExecutionOutcome::Failed => PluginOutcome::Failed,
            RemoteExecutionOutcome::Cancelled => PluginOutcome::Cancelled,
            RemoteExecutionOutcome::Uncertain => PluginOutcome::Uncertain,
        };
        plan.error = match plan.outcome {
            PluginOutcome::Uncertain => Some(report.notice.clone()),
            PluginOutcome::Failed => {
                Some(format!("Remote exit code {:?}", report.remote_exit_code))
            }
            _ => None,
        };
        plan.recovery = (plan.outcome == PluginOutcome::Uncertain)
            .then(|| json!(self.recovery(id, &report, Some(resource.clone()), digest)));
        plan.cancellation_confirmed = plan.outcome == PluginOutcome::Cancelled;
        plan.evidence = vec![resource];
        plan
    }
    fn recovery(
        &self,
        id: &OperationId,
        report: &RemoteExecutionReport,
        resource: Option<ResourceReference>,
        digest: ContentDigest,
    ) -> RemoteRunRecovery {
        let prefix = |capture: &OutputCapture| OutputCapture {
            bytes: capture.bytes.iter().take(4096).copied().collect(),
            total_bytes: capture.total_bytes,
            truncated: capture.truncated || capture.bytes.len() > 4096,
            eof: capture.eof,
        };
        RemoteRunRecovery {
            operation: id.clone(),
            project_root: self.root.clone(),
            target: report.target.clone(),
            report_transfer_confirmed: resource.is_some(),
            report: resource,
            report_digest: Some(digest),
            native_outcome: report.outcome,
            stdout: prefix(&report.transport.stdout),
            stderr: prefix(&report.transport.stderr),
            automatic_reexecution: false,
            action: "observe_remote_owner_before_any_new_execution".into(),
        }
    }
    pub fn settle(&self, settlement: &OperationSettlement) -> Result<(), String> {
        let mut entries = self.accepted.lock().unwrap();
        let Some(entry) = entries.get(&settlement.operation_id) else {
            return Ok(());
        };
        if entry.binding != settlement.binding
            || entry.phase != ProcessPhase::AwaitingSettlement
            || (settlement.outcome == PluginOutcome::Succeeded
                && entry.outcome != Some(PluginOutcome::Succeeded))
            || (settlement.outcome == PluginOutcome::Cancelled
                && entry.outcome != Some(PluginOutcome::Cancelled))
        {
            return Err("Settlement differs from the original native remote result".into());
        }
        entries.remove(&settlement.operation_id);
        Ok(())
    }
    pub fn contains(&self, id: &str) -> bool {
        OperationId::new(id).is_ok_and(|id| self.accepted.lock().unwrap().contains_key(&id))
    }
    pub fn ready_to_release(&self) -> bool {
        self.accepted.lock().unwrap().is_empty()
    }
}
fn original(call: &PluginCall) -> Result<OperationId, String> {
    OperationId::new(
        call.operation_id
            .as_deref()
            .ok_or("Original remote operation is required")?,
    )
    .map_err(|e| e.to_string())
}
pub fn failed(message: impl Into<String>) -> PluginCommitPlan {
    PluginCommitPlan {
        outcome: PluginOutcome::Failed,
        output: None,
        error: Some(message.into()),
        recovery: None,
        facts: vec![],
        evidence: vec![],
        cancellation_confirmed: false,
    }
}
fn uncertain(message: impl Into<String>, recovery: Value) -> PluginCommitPlan {
    PluginCommitPlan {
        outcome: PluginOutcome::Uncertain,
        recovery: Some(recovery),
        ..failed(message)
    }
}
fn native_error(error: RemoteOwnerError) -> PluginCommitPlan {
    PluginCommitPlan {
        outcome: if error.possible_effect {
            PluginOutcome::Uncertain
        } else {
            PluginOutcome::Failed
        },
        recovery: error.recovery,
        ..failed(error.message)
    }
}
fn result(call: &PluginCall, output: Value, kind: &str) -> PluginCommitPlan {
    PluginCommitPlan {
        outcome: PluginOutcome::Succeeded,
        facts: vec![ProposedFact {
            schema: format!("org.rho.remote.{kind}.v1"),
            key: call.operation_id.clone().unwrap(),
            value: output.clone(),
        }],
        output: Some(output),
        error: None,
        recovery: None,
        evidence: vec![],
        cancellation_confirmed: false,
    }
}
async fn cancelled(cancellation: &mut watch::Receiver<bool>) {
    loop {
        if *cancellation.borrow() {
            return;
        }
        if cancellation.changed().await.is_err() {
            std::future::pending::<()>().await;
        }
    }
}
