use crate::reconcile;
use rho_plugin_sdk::{ResourceClient, protocol::*};
use rho_process_api::*;
use rho_process_owner::LocalProcessOwner;
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
    native: LocalProcessOwner,
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
        serde_json::from_value::<Empty>(configuration).map_err(|error| error.to_string())?;
        let root = Path::new(&environment.project_root);
        if !root.is_absolute() || root.canonicalize().map_err(|error| error.to_string())? != root {
            return Err("Process requires the normalized Host project root".into());
        }
        Ok(Self {
            native: LocalProcessOwner::new(root).map_err(|error| error.to_string())?,
            lane: Arc::new(tokio::sync::Mutex::new(())),
            accepted: Mutex::new(BTreeMap::new()),
            resources,
        })
    }
    fn root(&self) -> &str {
        self.native.root()
    }
    pub fn reconciliation_request(&self, call: &PluginCall) -> Result<OperationId, String> {
        self.native
            .check_root()
            .map_err(|error| error.to_string())?;
        reconcile::request(call, self.root())
    }
    pub fn prepare_reconciliation(
        &self,
        call: &PluginCall,
        observation: Value,
    ) -> Result<Value, String> {
        self.native
            .check_root()
            .map_err(|error| error.to_string())?;
        reconcile::prepare(call, self.root(), observation)
    }
    fn qualify(&self, call: &PluginCall, running: bool) -> Result<(), String> {
        if !call.scopes.contains("project.read")
            || (running && !call.scopes.contains("process.run_local"))
        {
            return Err("Process call is missing its declared scope".into());
        }
        if call
            .binding
            .target
            .as_ref()
            .is_some_and(|target| target != self.root())
        {
            return Err("Process target differs from the initialized project".into());
        }
        Ok(())
    }
    pub fn query(&self, call: &PluginCall) -> Result<Value, String> {
        let cap = &call.binding.capability;
        let prepare = cap.id.as_str() == "process.prepare_local" && cap.version == 2;
        self.qualify(call, prepare)?;
        if call.operation_id.is_some()
            || !call.preconditions.is_null()
            || !call.owner_context.is_null()
        {
            return Err("Process queries cannot carry mutation qualifications".into());
        }
        if prepare {
            let request: PluginPreflightRequest = serde_json::from_value(call.arguments.clone())
                .map_err(|error| error.to_string())?;
            if request.capability.id.as_str() != "process.run_local"
                || request.capability.version != 2
                || request
                    .target
                    .as_ref()
                    .is_some_and(|target| target != self.root())
                || !(request.preconditions.is_null() || request.preconditions == json!([]))
            {
                return Err("Unsupported local process capability, target or preconditions".into());
            }
            let args: RunLocalArguments =
                serde_json::from_value(request.arguments).map_err(|error| error.to_string())?;
            args.validate()?;
            self.native
                .check_root()
                .map_err(|error| error.to_string())?;
            Ok(json!(PluginPreflightResult {
                arguments: json!(args),
                target: Some(self.root().into()),
                owner_context: json!({"project_root":self.root()})
            }))
        } else if cap.id.as_str() == "process.status" && cap.version == 1 {
            serde_json::from_value::<Empty>(call.arguments.clone())
                .map_err(|error| error.to_string())?;
            let entries = self.accepted.lock().unwrap();
            Ok(json!(ProcessStatus {
                activities: entries
                    .iter()
                    .map(|(id, entry)| ProcessActivity {
                        operation: id.clone(),
                        phase: entry.phase
                    })
                    .collect(),
                capacity: CAPACITY as u16
            }))
        } else {
            Err("Unsupported process query".into())
        }
    }
    pub fn admit(&self, call: &PluginCall) -> Result<(), String> {
        self.qualify(call, true)?;
        if call.binding.capability.id.as_str() == reconcile::EXECUTE {
            reconcile::admitted(call, self.root())?;
        } else {
            if call.binding.capability.id.as_str() != "process.run_local"
                || call.binding.capability.version != 2
                || call.binding.target.as_deref() != Some(self.root())
                || call.owner_context != json!({"project_root":self.root()})
                || !(call.preconditions.is_null() || call.preconditions == json!([]))
            {
                return Err("Process call differs from its original preflight".into());
            }
            let args: RunLocalArguments = serde_json::from_value(call.arguments.clone())
                .map_err(|error| error.to_string())?;
            args.validate()?;
        }
        let id = original(call)?;
        let mut entries = self.accepted.lock().unwrap();
        if entries.contains_key(&id) {
            return Err("Original process operation is already admitted".into());
        }
        if entries.len() >= CAPACITY {
            return Err("Process capacity reached; no native work was started".into());
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
        let id = match original(call) {
            Ok(id) => id,
            Err(error) => return failed(error),
        };
        let reconciling = call.binding.capability.id.as_str() == reconcile::EXECUTE;
        let lane = tokio::select! {
                biased;
                _ = cancelled(&mut cancellation) => None,
                lane = self.lane.clone().lock_owned() => Some(lane),
        };
        let plan = if lane.is_none() || *cancellation.borrow() {
            if reconciling {
                // Core does not offer cancellation for reconciliation. Channel
                // loss must still release queued work before any native signal,
                // without waiting forever behind an unconfirmed settlement.
                failed("Reconciliation did not start before its control channel ended")
            } else {
                PluginCommitPlan {
                    outcome: PluginOutcome::Cancelled,
                    output: None,
                    error: None,
                    recovery: None,
                    facts: vec![],
                    evidence: vec![],
                    cancellation_confirmed: true,
                }
            }
        } else {
            self.accepted.lock().unwrap().get_mut(&id).unwrap().phase = ProcessPhase::Running;
            if reconciling {
                self.reconcile(call).await
            } else {
                let args = serde_json::from_value::<RunLocalArguments>(call.arguments.clone())
                    .expect("validated admission");
                match self.native.run(&id, &args, cancellation).await {
                    Ok(report) => self.publish(call, &id, report).await,
                    Err(error) => failed(error.to_string()),
                }
            }
        };
        let mut entries = self.accepted.lock().unwrap();
        let entry = entries.get_mut(&id).expect("admitted original operation");
        entry.phase = ProcessPhase::AwaitingSettlement;
        entry.outcome = Some(plan.outcome);
        entry.lane = lane;
        // Only Host settlement releases a native scheduling fence. Returning a
        // candidate here never declares that its scientific record was committed.
        plan
    }
    async fn reconcile(&self, call: &PluginCall) -> PluginCommitPlan {
        let source = match reconcile::admitted(call, self.root()) {
            Ok(qualification) => qualification.source_operation,
            Err(error) => return failed(error),
        };
        if let Err(error) = self.native.check_root() {
            return failed(error.to_string());
        }
        let operation = source.to_string();
        let result = tokio::task::spawn_blocking(move || {
            rho_process_owner::recovery::reconcile_tagged(&operation)
        })
        .await;
        let report = match result {
            Ok(Ok(report))
                if report.source_operation_id == source.as_str()
                    && report.no_matching_processes_observed == report.remaining.is_empty() =>
            {
                Ok(report)
            }
            Ok(Ok(_)) => {
                Err("Native reconciliation returned inconsistent original evidence".into())
            }
            Ok(Err(error)) => Err(error),
            Err(error) => Err(error.to_string()),
        };
        let recovery = || {
            json!(ProcessReconcileRecovery {
                source_operation_id: source.to_string(),
                action: Some("inspect_tagged_processes_without_reexecuting_source".into()),
            })
        };
        match report {
            Ok(report) => {
                let finished = report.no_matching_processes_observed;
                PluginCommitPlan {
                    outcome: if finished {
                        PluginOutcome::Succeeded
                    } else {
                        PluginOutcome::Uncertain
                    },
                    output: Some(json!(report)),
                    error: (!finished).then(|| {
                        "Tagged processes remain after bounded native reconciliation".into()
                    }),
                    recovery: (!finished).then(recovery),
                    facts: vec![ProposedFact {
                        schema: "org.rho.process.reconciliation.v1".into(),
                        key: call.operation_id.clone().unwrap(),
                        value: json!(report),
                    }],
                    evidence: vec![],
                    cancellation_confirmed: false,
                }
            }
            Err(error) => PluginCommitPlan {
                outcome: PluginOutcome::Uncertain,
                output: None,
                error: Some(error),
                recovery: Some(recovery()),
                facts: vec![],
                evidence: vec![],
                cancellation_confirmed: false,
            },
        }
    }
    async fn publish(
        &self,
        call: &PluginCall,
        id: &OperationId,
        report: ProcessReport,
    ) -> PluginCommitPlan {
        let bytes = match serde_json::to_vec(&report) {
            Ok(bytes) => bytes,
            Err(error) => {
                return uncertain(error.to_string(), self.recovery(id, &report, None, None));
            }
        };
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
            result => {
                return uncertain(
                    match result {
                        Ok(Err(error)) => error.to_string(),
                        Ok(Ok(_)) => {
                            "Report acknowledgement differs from its original owner".into()
                        }
                        Err(_) => "Report transfer is unconfirmed".into(),
                    },
                    self.recovery(id, &report, None, Some(digest)),
                );
            }
        };
        let outcome = match report.termination {
            ProcessTermination::Cancelled => PluginOutcome::Cancelled,
            ProcessTermination::Uncertain => PluginOutcome::Uncertain,
            ProcessTermination::Exited if report.exit_code == Some(0) => PluginOutcome::Succeeded,
            _ => PluginOutcome::Failed,
        };
        let result = ProcessRunResult {
            operation: id.clone(),
            report: resource.clone(),
            pid: report.pid,
            termination: report.termination,
            exit_code: report.exit_code,
            exit_signal: report.exit_signal,
        };
        PluginCommitPlan {
            outcome,
            output: Some(json!(result)),
            error: matches!(outcome, PluginOutcome::Failed | PluginOutcome::Uncertain).then(|| {
                format!(
                    "Process {:?}, exit code {:?}",
                    report.termination, report.exit_code
                )
            }),
            recovery: (outcome == PluginOutcome::Uncertain)
                .then(|| json!(self.recovery(id, &report, Some(resource.clone()), Some(digest)))),
            facts: vec![ProposedFact {
                schema: "org.rho.process.local-report.v1".into(),
                key: id.to_string(),
                value: json!(result),
            }],
            evidence: vec![resource],
            cancellation_confirmed: outcome == PluginOutcome::Cancelled,
        }
    }
    fn recovery(
        &self,
        id: &OperationId,
        report: &ProcessReport,
        reference: Option<ResourceReference>,
        digest: Option<ContentDigest>,
    ) -> ProcessRunRecovery {
        let prefix = |capture: &OutputCapture| OutputCapture {
            bytes: capture.bytes.iter().take(4096).copied().collect(),
            total_bytes: capture.total_bytes,
            truncated: capture.truncated || capture.bytes.len() > 4096,
            eof: capture.eof,
        };
        ProcessRunRecovery {
            operation: id.clone(),
            project_root: self.root().into(),
            pid: report.pid,
            report_transfer_confirmed: reference.is_some(),
            report: reference,
            native_termination: Some(report.termination),
            report_digest: digest,
            stdout: Some(prefix(&report.stdout)),
            stderr: Some(prefix(&report.stderr)),
            automatic_reexecution: false,
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
            return Err("Settlement differs from the original native process result".into());
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
            .ok_or("Original process operation is required")?,
    )
    .map_err(|error| error.to_string())
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
fn uncertain(message: String, recovery: ProcessRunRecovery) -> PluginCommitPlan {
    PluginCommitPlan {
        outcome: PluginOutcome::Uncertain,
        output: None,
        error: Some(message),
        recovery: Some(json!(recovery)),
        facts: vec![],
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
