use crate::host_reads::HostReads;
use crate::{
    source::{self, NativeScope, Qualification},
    storage::MaterialLease,
};
use base64::Engine;
use rho_environment_api::*;
use rho_environment_owner::{EnvironmentOwnerError, REnvironmentConfig, REnvironmentOwner};
use rho_plugin_sdk::{ResourceClient, protocol::*};
use rho_process_api::{ProcessActivity, ProcessPhase};
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
struct Entry {
    binding: ProviderBinding,
    phase: ProcessPhase,
    outcome: Option<PluginOutcome>,
    lane: Option<OwnedMutexGuard<()>>,
}
pub struct Owner {
    root: String,
    storage_root: String,
    native: Option<REnvironmentOwner>,
    scope: Option<NativeScope>,
    target: Option<String>,
    lease: Option<MaterialLease>,
    resources: ResourceClient,
    reads: HostReads,
    lane: Arc<tokio::sync::Mutex<()>>,
    accepted: Mutex<BTreeMap<OperationId, Entry>>,
}
impl Owner {
    pub fn new(
        environment: BackendEnvironment,
        configuration: Value,
        resources: ResourceClient,
        reads: HostReads,
    ) -> Result<Self, String> {
        let config: EnvironmentConfiguration =
            serde_json::from_value(configuration).map_err(error)?;
        if !(1..=86400).contains(&config.timeout_seconds) {
            return Err("Environment timeout must be 1–86400 seconds".into());
        }
        let storage_root = config.storage_root.unwrap_or(environment.data_root);
        for directory in [&environment.project_root, &storage_root] {
            let path = Path::new(directory);
            if !path.is_absolute() || !path.is_dir() || path.canonicalize().map_err(error)? != path
            {
                return Err(
                    "Environment requires existing normalized project and material directories"
                        .into(),
                );
            }
        }
        let (native, scope, lease) = match config.rscript {
            None => (None, None, None),
            Some(rscript) => {
                let executable = Path::new(&rscript);
                if !executable.is_absolute()
                    || !executable.is_file()
                    || executable.canonicalize().map_err(error)? != executable
                {
                    return Err("Select an existing normalized Rscript executable".into());
                }
                let lease = MaterialLease::acquire(Path::new(&storage_root))?;
                let native = REnvironmentOwner::open(REnvironmentConfig {
                    rscript: rscript.clone().into(),
                    project_root: environment.project_root.clone().into(),
                    data_root: storage_root.clone().into(),
                    timeout: Duration::from_secs(config.timeout_seconds),
                })?;
                let scope = NativeScope {
                    project_root: environment.project_root.clone(),
                    rscript,
                    storage_root: storage_root.clone(),
                };
                (Some(native), Some(scope), Some(lease))
            }
        };
        let target = scope.as_ref().map(|scope| {
            format!(
                "environment:sha256:{:x}",
                Sha256::digest(serde_json::to_vec(scope).unwrap())
            )
        });
        Ok(Self {
            root: environment.project_root,
            storage_root,
            native,
            scope,
            target,
            lease,
            resources,
            reads,
            lane: Arc::new(tokio::sync::Mutex::new(())),
            accepted: Mutex::new(BTreeMap::new()),
        })
    }
    fn native(&self) -> Result<&REnvironmentOwner, String> {
        self.native.as_ref().ok_or_else(|| {
            "Configure an installed Rscript executable before Environment work".into()
        })
    }
    fn scope(&self) -> Result<&NativeScope, String> {
        self.scope
            .as_ref()
            .ok_or_else(|| "Environment is not configured".into())
    }
    fn common(&self, call: &PluginCall) -> Result<(), String> {
        if !source::scopes(call.binding.capability.id.as_str()).is_subset(&call.scopes)
            || call
                .binding
                .target
                .as_ref()
                .is_some_and(|target| Some(target) != self.target.as_ref())
            || !(call.preconditions.is_null() || call.preconditions == json!([]))
        {
            return Err("Environment call is missing its declared scope or exact target".into());
        }
        if Path::new(&self.root).canonicalize().map_err(error)? != Path::new(&self.root) {
            return Err("Environment project identity changed".into());
        }
        if let Some(lease) = &self.lease {
            lease.check()?;
        }
        if call.binding.capability.id.as_str() == source::STATUS
            && call.binding.capability.version == 1
        {
            return Ok(());
        }
        if call.binding.capability.version != 2 {
            return Err("Unsupported Environment capability version".into());
        }
        self.native()?;
        Ok(())
    }
    fn query_call(&self, call: &PluginCall) -> Result<(), String> {
        self.common(call)?;
        if call.operation_id.is_some()
            || !call.owner_context.is_null()
            || !call.preconditions.is_null()
        {
            return Err("Environment queries cannot carry mutation qualifications".into());
        }
        Ok(())
    }
    fn preflight(&self, call: &PluginCall) -> Result<PluginPreflightRequest, String> {
        self.query_call(call)?;
        let action = source::prepared_operation(call.binding.capability.id.as_str())
            .ok_or("Unsupported Environment preflight")?;
        let mut request: PluginPreflightRequest =
            serde_json::from_value(call.arguments.clone()).map_err(error)?;
        if request.capability.id.as_str() != action
            || request.capability.version != 2
            || request
                .target
                .as_ref()
                .is_some_and(|target| Some(target) != self.target.as_ref())
            || !(request.preconditions.is_null() || request.preconditions == json!([]))
        {
            return Err(
                "Environment preflight changed its capability, target or preconditions".into(),
            );
        }
        request.arguments = source::normalize(action, request.arguments)?;
        Ok(request)
    }
    fn query_arguments(&self, call: &PluginCall) -> Result<(String, Value), String> {
        self.query_call(call)?;
        if matches!(
            call.binding.capability.id.as_str(),
            source::OBSERVE | source::LIBRARY
        ) {
            Ok((
                call.binding.capability.id.to_string(),
                source::normalize(call.binding.capability.id.as_str(), call.arguments.clone())?,
            ))
        } else {
            let request = self.preflight(call)?;
            Ok((request.capability.id.to_string(), request.arguments))
        }
    }
    pub fn source_request(&self, call: &PluginCall) -> Result<Option<OperationId>, String> {
        if call.binding.capability.id.as_str() == source::STATUS {
            self.query_call(call)?;
            return Ok(None);
        }
        let (action, args) = self.query_arguments(call)?;
        source::source_id(&action, &args)
    }
    pub async fn query(&self, call: &PluginCall) -> Result<Value, String> {
        self.query_call(call)?;
        if call.binding.capability.id.as_str() == source::STATUS {
            source::normalize(source::STATUS, call.arguments.clone())?;
            return Ok(json!(EnvironmentStatus {
                project_root: self.root.clone(),
                storage_root: self.storage_root.clone(),
                rscript: self.scope.as_ref().map(|scope| scope.rscript.clone()),
                target_key: self.target.clone(),
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
        let (action, args) = self.query_arguments(call)?;
        if source::source_id(&action, &args)?.is_some() {
            return Err("Original Environment observation is required".into());
        }
        if action == source::OBSERVE {
            return self
                .observe(None, args["limit"].as_u64().unwrap() as usize)
                .await;
        }
        Ok(json!(PluginPreflightResult {
            arguments: args,
            target: self.target.clone(),
            owner_context: json!(Qualification {
                scope: self.scope()?.clone(),
                source: None
            })
        }))
    }
    pub async fn complete_source(
        &self,
        call: &PluginCall,
        observation: Value,
    ) -> Result<Value, String> {
        let (action, args) = self.query_arguments(call)?;
        let qualified = source::qualify(
            call,
            self.scope()?,
            self.target.as_deref().unwrap(),
            &action,
            &args,
            &observation,
        )?;
        if matches!(action.as_str(), source::OBSERVE | source::LIBRARY) {
            let source = qualified.source.unwrap();
            let receipt: EnvironmentRealization =
                serde_json::from_slice(&self.read(call, source.report.as_ref().unwrap()).await?)
                    .map_err(error)?;
            if receipt.project_root != self.root || !receipt.verified {
                return Err(
                    "Original Environment realization is not verified for this project".into(),
                );
            }
            if action == source::LIBRARY {
                let _lane = self.lane.try_lock().map_err(
                    |_| "Environment work or settlement is pending; retry library selection",
                )?;
                self.common(call)?;
                self.native()?.inspect_realization_library(&receipt).await?;
                self.common(call)?;
                let scope = self.scope()?;
                let mut binding = call.binding.clone();
                binding.target = self.target.clone();
                return Ok(json!(EnvironmentLibrary {
                    binding,
                    realization: source.operation,
                    source: source.binding,
                    report: source.report.unwrap(),
                    project_root: self.root.clone(),
                    storage_root: scope.storage_root.clone(),
                    rscript: scope.rscript.clone(),
                    library_path: receipt.library_path,
                    library_digest: ContentDigest::new(receipt.library_digest).map_err(error)?,
                    r_version: receipt.r_version,
                    platform: receipt.platform,
                }));
            }
            return self
                .observe(
                    Some(&receipt.library_path),
                    args["limit"].as_u64().unwrap() as usize,
                )
                .await;
        }
        Ok(json!(PluginPreflightResult {
            arguments: args,
            target: self.target.clone(),
            owner_context: json!(qualified)
        }))
    }
    async fn observe(&self, library: Option<&str>, limit: usize) -> Result<Value, String> {
        let snapshot = match self.lane.try_lock() {
            Err(_) => EnvironmentSnapshot {
                status: EnvironmentSnapshotStatus::Busy,
                observation: None,
                notices: vec![
                    "Native Environment work or original commit settlement is pending.".into(),
                ],
            },
            Ok(_lane) => match self.native()?.observe(library, limit).await {
                Ok(observation) => EnvironmentSnapshot {
                    status: EnvironmentSnapshotStatus::Ready,
                    notices: vec![],
                    observation: Some(bounded_observation(observation)?),
                },
                Err(error) => EnvironmentSnapshot {
                    status: EnvironmentSnapshotStatus::Unavailable,
                    observation: None,
                    notices: vec![error],
                },
            },
        };
        Ok(json!(snapshot))
    }
    fn qualification(&self, call: &PluginCall) -> Result<Qualification, String> {
        self.common(call)?;
        let action = call.binding.capability.id.as_str();
        if !matches!(
            action,
            source::PLAN | source::REALIZE | source::VERIFY | source::RECONCILE | source::REFRESH
        ) || call.binding.target != self.target
            || call.operation_id.is_none()
        {
            return Err("Unsupported admitted Environment operation".into());
        }
        source::normalize(action, call.arguments.clone())?;
        let qualification: Qualification =
            serde_json::from_value(call.owner_context.clone()).map_err(error)?;
        qualification.validate(
            call,
            self.scope()?,
            self.target.as_deref().unwrap(),
            action,
            &call.arguments,
        )?;
        Ok(qualification)
    }
    pub fn admit(&self, call: &PluginCall) -> Result<(), String> {
        self.qualification(call)?;
        let id = original(call)?;
        let mut accepted = self.accepted.lock().unwrap();
        if accepted.len() >= CAPACITY || accepted.contains_key(&id) {
            return Err(
                "Environment capacity reached or original operation already dispatched".into(),
            );
        }
        accepted.insert(
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
        let result = if lane.is_none() || *cancellation.borrow() {
            if call.binding.capability.id.as_str() == source::RECONCILE {
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
            match self.qualification(call) {
                Err(error) => failed(error),
                Ok(qualification) => {
                    match self.perform(call, &id, qualification, cancellation).await {
                        Ok((kind, value, verified)) => {
                            self.publish(call, &id, kind, value, verified).await
                        }
                        Err(error) => self.native_error(call, &id, error).await,
                    }
                }
            }
        };
        let mut accepted = self.accepted.lock().unwrap();
        let entry = accepted.get_mut(&id).expect("admitted original operation");
        entry.phase = ProcessPhase::AwaitingSettlement;
        entry.outcome = Some(result.outcome);
        entry.lane = lane;
        result
    }
    async fn perform(
        &self,
        call: &PluginCall,
        id: &OperationId,
        qualification: Qualification,
        cancellation: watch::Receiver<bool>,
    ) -> Result<(EnvironmentReportKind, Value, Option<bool>), EnvironmentOwnerError> {
        let native = self
            .native()
            .map_err(EnvironmentOwnerError::before_effect)?;
        Ok(match call.binding.capability.id.as_str() {
            source::PLAN => (
                EnvironmentReportKind::Plan,
                json!(
                    native
                        .plan(
                            id.as_str(),
                            &serde_json::from_value(call.arguments.clone()).unwrap(),
                            cancellation
                        )
                        .await?
                ),
                None,
            ),
            source::REALIZE | source::VERIFY => {
                let source = qualification.source.unwrap();
                let bytes = self
                    .read(call, source.report.as_ref().unwrap())
                    .await
                    .map_err(EnvironmentOwnerError::before_effect)?;
                self.common(call)
                    .map_err(EnvironmentOwnerError::before_effect)?;
                if *cancellation.borrow() {
                    let mut error = EnvironmentOwnerError::before_effect(
                        "Environment work was cancelled before consuming the original report",
                    );
                    error.cancellation_confirmed = true;
                    return Err(error);
                }
                if call.binding.capability.id.as_str() == source::REALIZE {
                    let plan = serde_json::from_slice(&bytes)
                        .map_err(|e| EnvironmentOwnerError::before_effect(error(e)))?;
                    let result = native
                        .realize(id.as_str(), source.operation.as_str(), &plan, cancellation)
                        .await?;
                    (
                        EnvironmentReportKind::Realization,
                        json!(result),
                        Some(result.verified),
                    )
                } else {
                    let receipt = serde_json::from_slice(&bytes)
                        .map_err(|e| EnvironmentOwnerError::before_effect(error(e)))?;
                    let result = native.verify(id.as_str(), &receipt, cancellation).await?;
                    (
                        EnvironmentReportKind::Verification,
                        json!(result),
                        Some(result.verified),
                    )
                }
            }
            source::RECONCILE => {
                let result = native
                    .reconcile(qualification.source.unwrap().operation.as_str())
                    .await?;
                (
                    EnvironmentReportKind::Reconciliation,
                    json!(result),
                    Some(result.cleanup_confirmed),
                )
            }
            source::REFRESH => (
                EnvironmentReportKind::Configuration,
                json!(
                    native
                        .refresh_configuration(id.as_str(), cancellation)
                        .await?
                ),
                None,
            ),
            _ => unreachable!("validated admission"),
        })
    }
    async fn retain(&self, call: &PluginCall, bytes: &[u8]) -> Result<ResourceReference, String> {
        if bytes.is_empty() || bytes.len() as u64 > source::MAX_REPORT_BYTES {
            return Err("Environment report exceeds its resource bound".into());
        }
        let declaration = ResourceDeclaration {
            digest: ContentDigest::new(format!("sha256:{:x}", Sha256::digest(bytes))).unwrap(),
            media_type: "application/json".into(),
            bytes: bytes.len() as u64,
        };
        let reference = tokio::time::timeout(
            Duration::from_secs(30),
            self.resources.put(call.request.clone(), declaration, bytes),
        )
        .await
        .map_err(|_| "Environment resource transfer is unconfirmed")?
        .map_err(error)?;
        source::validate_report(&reference, &call.binding)?;
        Ok(reference)
    }
    async fn read(
        &self,
        call: &PluginCall,
        reference: &ResourceReference,
    ) -> Result<Vec<u8>, String> {
        if reference.bytes == 0
            || reference.bytes > source::MAX_REPORT_BYTES
            || reference.media_type != "application/json"
        {
            return Err("Invalid Environment report bounds".into());
        }
        let read = async {
            let mut bytes = Vec::with_capacity(reference.bytes as usize);
            while (bytes.len() as u64) < reference.bytes {
                let offset = bytes.len() as u64;
                let observation = self
                    .reads
                    .query(
                        call.request.clone(),
                        "resources.read",
                        json!(ResourceRead {
                            reference: reference.clone(),
                            offset,
                            limit: MAX_RESOURCE_READ_BYTES
                        }),
                    )
                    .await?;
                if observation["status"] != "ready" || observation["completeness"] != "complete" {
                    return Err("Original report observation is incomplete or unavailable".into());
                }
                let chunk: ResourceChunk =
                    serde_json::from_value(observation["data"].clone()).map_err(error)?;
                let expected = (reference.bytes - offset).min(u64::from(MAX_RESOURCE_READ_BYTES));
                let end = offset + expected;
                let data = base64::engine::general_purpose::STANDARD
                    .decode(&chunk.base64)
                    .map_err(error)?;
                if chunk.reference != *reference
                    || chunk.offset != offset
                    || chunk.next != (end < reference.bytes).then_some(end)
                    || data.len() as u64 != expected
                {
                    return Err("Original report chunk changed identity, offset or length".into());
                }
                bytes.extend(data);
            }
            if format!("sha256:{:x}", Sha256::digest(&bytes)) != reference.digest.as_str() {
                return Err("Environment report digest changed".into());
            }
            Ok(bytes)
        };
        tokio::time::timeout(Duration::from_secs(30), read)
            .await
            .map_err(|_| "Environment source report read is unconfirmed")?
    }
    fn recovery(
        &self,
        id: &OperationId,
        reference: Option<ResourceReference>,
        digest: Option<ContentDigest>,
    ) -> Value {
        json!(EnvironmentRecovery {
            operation: id.clone(),
            storage_root: self.storage_root.clone(),
            native_recovery: reference,
            report_digest: digest,
            automatic_reexecution: false,
            action: "inspect_original_operation_and_native_material_before_any_new_execution"
                .into()
        })
    }
    async fn publish(
        &self,
        call: &PluginCall,
        id: &OperationId,
        kind: EnvironmentReportKind,
        value: Value,
        verified: Option<bool>,
    ) -> PluginCommitPlan {
        let bytes = serde_json::to_vec(&value).expect("native report serialization");
        let report = match self.retain(call, &bytes).await {
            Ok(report) => report,
            Err(error) => {
                return uncertain(
                    error,
                    self.recovery(
                        id,
                        None,
                        Some(
                            ContentDigest::new(format!("sha256:{:x}", Sha256::digest(&bytes)))
                                .unwrap(),
                        ),
                    ),
                );
            }
        };
        let unresolved = kind == EnvironmentReportKind::Reconciliation && verified == Some(false);
        PluginCommitPlan {
            outcome: if unresolved {
                PluginOutcome::Uncertain
            } else if verified == Some(false) {
                PluginOutcome::Failed
            } else {
                PluginOutcome::Succeeded
            },
            output: Some(json!(EnvironmentResult {
                operation: id.clone(),
                kind,
                report: report.clone(),
                verified
            })),
            error: if unresolved {
                Some("Environment native cleanup is not confirmed".into())
            } else {
                (verified == Some(false)).then(|| "Environment verification did not pass".into())
            },
            recovery: unresolved.then(|| self.recovery(id, Some(report.clone()), None)),
            facts: vec![],
            evidence: vec![report],
            cancellation_confirmed: false,
        }
    }
    async fn native_error(
        &self,
        call: &PluginCall,
        id: &OperationId,
        native: EnvironmentOwnerError,
    ) -> PluginCommitPlan {
        let mut evidence = vec![];
        if let Some(recovery) = native.recovery {
            let bytes = serde_json::to_vec(&recovery).expect("native recovery serialization");
            match self.retain(call, &bytes).await {
                Ok(reference) => evidence.push(reference),
                Err(error) => {
                    return uncertain(
                        format!("{}; {error}", preview(&native.message)),
                        self.recovery(
                            id,
                            None,
                            Some(
                                ContentDigest::new(format!("sha256:{:x}", Sha256::digest(&bytes)))
                                    .unwrap(),
                            ),
                        ),
                    );
                }
            }
        }
        PluginCommitPlan {
            outcome: if native.cancellation_confirmed {
                PluginOutcome::Cancelled
            } else if native.possible_effect {
                PluginOutcome::Uncertain
            } else {
                PluginOutcome::Failed
            },
            output: None,
            error: Some(preview(&native.message).into()),
            recovery: native
                .possible_effect
                .then(|| self.recovery(id, evidence.first().cloned(), None)),
            facts: vec![],
            evidence,
            cancellation_confirmed: native.cancellation_confirmed,
        }
    }
    pub fn settle(&self, settlement: &OperationSettlement) -> Result<(), String> {
        let mut accepted = self.accepted.lock().unwrap();
        let Some(entry) = accepted.get(&settlement.operation_id) else {
            return Ok(());
        };
        if entry.binding != settlement.binding
            || entry.phase != ProcessPhase::AwaitingSettlement
            || (settlement.outcome == PluginOutcome::Succeeded
                && entry.outcome != Some(PluginOutcome::Succeeded))
            || (settlement.outcome == PluginOutcome::Cancelled
                && entry.outcome != Some(PluginOutcome::Cancelled))
        {
            return Err("Settlement differs from original Environment result".into());
        }
        accepted.remove(&settlement.operation_id);
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
            .ok_or("Original Operation identity required")?,
    )
    .map_err(error)
}
fn error(e: impl std::fmt::Display) -> String {
    e.to_string()
}
fn bounded_observation(
    mut observation: EnvironmentObservation,
) -> Result<EnvironmentObservation, String> {
    // Native inventory counts are bounded separately. Long installed paths can
    // still exceed the control frame, so retain a labelled prefix of packages.
    const MAX_BYTES: usize = 512 * 1024;
    if serde_json::to_vec(&observation).map_err(error)?.len() > MAX_BYTES {
        observation.truncated = true;
        observation
            .notices
            .push("Package inventory was shortened to fit the bounded plugin response.".into());
        while serde_json::to_vec(&observation).map_err(error)?.len() > MAX_BYTES {
            if observation.packages.is_empty() {
                return Err(
                    "Native Environment configuration exceeds the bounded plugin response".into(),
                );
            }
            observation
                .packages
                .truncate(observation.packages.len() / 2);
        }
    }
    Ok(observation)
}
fn preview(value: &str) -> &str {
    let mut end = value.len().min(4096);
    while !value.is_char_boundary(end) {
        end -= 1;
    }
    &value[..end]
}
pub fn failed(error: impl Into<String>) -> PluginCommitPlan {
    PluginCommitPlan {
        outcome: PluginOutcome::Failed,
        output: None,
        error: Some(preview(&error.into()).into()),
        recovery: None,
        facts: vec![],
        evidence: vec![],
        cancellation_confirmed: false,
    }
}
fn uncertain(error: impl Into<String>, recovery: Value) -> PluginCommitPlan {
    let mut plan = failed(error);
    plan.outcome = PluginOutcome::Uncertain;
    plan.recovery = Some(recovery);
    plan
}
async fn cancelled(cancellation: &mut watch::Receiver<bool>) {
    while !*cancellation.borrow() {
        if cancellation.changed().await.is_err() {
            std::future::pending::<()>().await;
        }
    }
}

#[cfg(test)]
mod observation_tests {
    use super::*;
    #[test]
    fn long_inventory_paths_stay_bounded_and_never_claim_completeness() {
        let observation: EnvironmentObservation = serde_json::from_value(json!({
            "r_version":"4.5","platform":"fixture","r_home":"/R","library_paths":["/library"],
            "packages":(0..500).map(|i|json!({"name":format!("package{i}"),"version":"1.0","library":"x".repeat(4096)})).collect::<Vec<_>>(),
            "truncated":false,"jsonlite_library":"/jsonlite","renv_available":true,"pak_available":true,
            "configuration_observed_at_ms":1,"configuration_source":"operation:original","inventory_observed_at_ms":2,
            "active_workspace_library":null,"notices":[]
        })).unwrap();
        let result = bounded_observation(observation.clone()).unwrap();
        assert!(result.truncated);
        assert!(!result.packages.is_empty());
        assert!(result.packages.len() < 500);
        assert_eq!(result.packages[0].name, "package0");
        assert!(serde_json::to_vec(&result).unwrap().len() <= 512 * 1024);
        let mut oversized = observation;
        oversized.library_paths = vec!["x".repeat(600000)];
        assert!(bounded_observation(oversized).is_err());
    }
}
