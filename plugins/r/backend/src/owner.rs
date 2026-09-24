use crate::queue::Queue;
use rho_plugin_sdk::{ResourceClient, protocol::*};
use rho_r_api::*;
use rho_r_engine::{ArkConfig, ArkRuntime, OutputStore};
use serde::Deserialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    path::PathBuf,
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::sync::{Mutex as Lane, watch};

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Configuration {
    pub ark: Option<PathBuf>,
    pub r_home: Option<PathBuf>,
    #[serde(default = "timeout")]
    pub execution_timeout_seconds: u64,
}
fn timeout() -> u64 {
    60
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Execute {
    expected_session: String,
    code: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct SessionObservation {
    expected_session: String,
}

/// One exact plugin instance owns one native session and its execution lane.
/// No journal or second result authority is available to this process.
pub struct Owner {
    config: Configuration,
    environment: BackendEnvironment,
    instance: InstanceRef,
    runtime: Mutex<Option<Arc<ArkRuntime>>>,
    launch_attempt: Mutex<Option<OperationId>>,
    inspection_cache_key: Mutex<String>,
    lane: Arc<Lane<()>>,
    queue: Queue,
    resources: ResourceClient,
}
impl Owner {
    pub fn new(
        configuration: Value,
        environment: BackendEnvironment,
        instance: InstanceRef,
        resources: ResourceClient,
    ) -> Result<Self, String> {
        let config: Configuration =
            serde_json::from_value(configuration).map_err(|e| e.to_string())?;
        if config.execution_timeout_seconds == 0 || config.execution_timeout_seconds > 86400 {
            return Err("execution timeout must be 1–86400 seconds".into());
        }
        // Validate existing paths; initialization and observation never launch R.
        let project = PathBuf::from(&environment.project_root);
        let data = PathBuf::from(&environment.data_root);
        for path in [
            config.ark.as_ref(),
            config.r_home.as_ref(),
            Some(&project),
            Some(&data),
        ]
        .into_iter()
        .flatten()
        {
            if !path.is_absolute() || path.canonicalize().map_err(|e| e.to_string())? != *path {
                return Err("native paths must be existing, absolute and normalized".into());
            }
        }
        if config.ark.as_ref().is_some_and(|path| !path.is_file())
            || config.r_home.as_ref().is_some_and(|path| !path.is_dir())
        {
            return Err("select an existing Ark executable and R installation".into());
        }
        Ok(Self {
            config,
            environment,
            instance,
            runtime: Mutex::new(None),
            launch_attempt: Mutex::new(None),
            inspection_cache_key: Mutex::new("initial".into()),
            lane: Arc::new(Lane::new(())),
            queue: Queue::default(),
            resources,
        })
    }
    fn runtime(&self) -> Result<Arc<ArkRuntime>, String> {
        self.runtime
            .lock()
            .unwrap()
            .clone()
            .ok_or_else(|| "Create a session before executing or inspecting R".into())
    }
    fn target(&self) -> String {
        self.runtime
            .lock()
            .unwrap()
            .as_ref()
            .map(|r| r.session_id().into())
            .unwrap_or_else(|| format!("unstarted:{}", self.instance.instance))
    }
    fn validate_execute(&self, value: &Value, version: u32) -> Result<RunRArguments, String> {
        let (session, run) = match version {
            1 => {
                let args: Execute =
                    serde_json::from_value(value.clone()).map_err(|e| e.to_string())?;
                (
                    args.expected_session,
                    RunRArguments {
                        code: args.code,
                        ..Default::default()
                    },
                )
            }
            2 => {
                let args: ExecuteR =
                    serde_json::from_value(value.clone()).map_err(|e| e.to_string())?;
                (args.expected_session, args.run)
            }
            _ => return Err("Unsupported R execution version".into()),
        };
        if session != self.runtime()?.session_id() {
            return Err("R session precondition changed".into());
        }
        validate_r_input(&run.code, run.source.as_ref())?;
        Ok(run)
    }
    pub fn admit(&self, call: &PluginCall) -> Result<(), String> {
        if call.binding.target.as_deref() != Some(&self.target())
            || call.owner_context != json!({"session_target":self.target()})
            || (!call.preconditions.is_null() && call.preconditions != json!({}))
        {
            return Err("R target or preconditions changed after admission".into());
        }
        match call.binding.capability.id.as_str() {
            "r.execute" => {
                self.validate_execute(&call.arguments, call.binding.capability.version)?;
            }
            "r.create_session" if call.arguments == json!({}) => (),
            _ => return Err("Unsupported R invocation".into()),
        }
        self.queue.admit(call)
    }
    pub fn settle(&self, settlement: &OperationSettlement) -> Result<(), String> {
        self.queue.settle(settlement)
    }
    pub fn ready_to_release(&self) -> bool {
        self.queue.is_empty()
    }
    /// Input and queue controls affect existing work, without taking its lane or
    /// manufacturing another scientific result. Native identity remains exact.
    pub fn control(&self, call: &PluginCall) -> Result<Value, String> {
        if call.binding.capability.version != 1
            || call.operation_id.is_some()
            || (!call.preconditions.is_null() && call.preconditions != json!({}))
        {
            return Err("Unsupported R control".into());
        }
        let target = self.target();
        if call.binding.target.as_deref() != Some(&target) {
            return Err("Control requires this exact native queue target".into());
        }
        match call.binding.capability.id.as_str() {
            "r.respond_input" => {
                let runtime = self.runtime()?;
                let reply: RespondInput = serde_json::from_value(call.arguments.clone())
                    .map_err(|_| "Invalid input response (redacted)")?;
                if reply.session_id != runtime.session_id() {
                    return Err("Input response requires this exact native session".into());
                }
                runtime.respond_input(reply).map_err(
                    |_| "Input was not confirmed; inspect the pending native request (redacted)",
                )?;
                Ok(json!({"submitted":true}))
            }
            "r.pause_queue" | "r.resume_queue" => {
                let args: QueueControlArguments = serde_json::from_value(call.arguments.clone())
                    .map_err(|_| "Invalid queue control")?;
                if args.session_id != target {
                    return Err("Queue control requires this exact native queue target".into());
                }
                self.queue.control(
                    call.binding.capability.id.as_str() == "r.pause_queue",
                    &args,
                )?;
                Ok(json!(
                    self.queue.observe(
                        &target,
                        self.runtime
                            .lock()
                            .unwrap()
                            .as_ref()
                            .and_then(|r| r.input_request())
                    )
                ))
            }
            _ => Err("Unsupported R control".into()),
        }
    }
    pub async fn query(&self, call: &PluginCall) -> Result<Value, String> {
        if let Some(kind) = r_inspection_kind(call.binding.capability.id.as_str()) {
            return self.inspect(call, kind).await;
        }
        match call.binding.capability.id.as_str() {
            "r.inspection_state" => self.inspection_state(call),
            "r.session" => Ok(match self.runtime.lock().unwrap().as_ref() {
                Some(runtime) => {
                    json!({"state":runtime.execution_state(), "session_id":runtime.session_id(), "queue_target":runtime.session_id(),
                    "process":runtime.process_identity(), "installation":runtime.installation_identity(), "input":runtime.input_request()})
                }
                None => {
                    let attempt = self.launch_attempt.lock().unwrap();
                    json!({"state":if attempt.is_some() { "launch_unconfirmed" } else { "unstarted" }, "session_id":null, "queue_target":format!("unstarted:{}",self.instance.instance), "launch_operation":*attempt})
                }
            }),
            "r.console" => {
                let args: SessionObservation =
                    serde_json::from_value(call.arguments.clone()).map_err(|e| e.to_string())?;
                let target = self.target();
                if args.expected_session != target
                    || call
                        .binding
                        .target
                        .as_deref()
                        .is_some_and(|value| value != target)
                {
                    return Err(
                        "Console observation requires this exact native queue target".into(),
                    );
                }
                Ok(json!(
                    self.queue.observe(
                        &target,
                        self.runtime
                            .lock()
                            .unwrap()
                            .as_ref()
                            .and_then(|r| r.input_request())
                    )
                ))
            }
            "r.prepare" => {
                let args: PluginPreflightRequest =
                    serde_json::from_value(call.arguments.clone()).map_err(|e| e.to_string())?;
                if args.capability.version != 1
                    && !(args.capability.id.as_str() == "r.execute" && args.capability.version == 2)
                {
                    return Err("unsupported R capability version".into());
                }
                match args.capability.id.as_str() {
                    "r.create_session" => {
                        if self.config.ark.is_none() || self.config.r_home.is_none() {
                            return Err(
                                "Configure existing Ark and R paths before creating a session"
                                    .into(),
                            );
                        }
                        if self.runtime.lock().unwrap().is_some()
                            || self.launch_attempt.lock().unwrap().is_some()
                        {
                            return Err(
                                "This instance already owns a session or an unconfirmed launch"
                                    .into(),
                            );
                        }
                        if args.arguments != json!({}) {
                            return Err("session creation takes no arguments".into());
                        }
                    }
                    "r.execute" => {
                        self.validate_execute(&args.arguments, args.capability.version)?;
                    }
                    _ => return Err("unknown R operation".into()),
                }
                let target = self.target();
                if args.target.as_ref().is_some_and(|value| value != &target) {
                    return Err("R target differs from this session".into());
                }
                if !args.preconditions.is_null() && args.preconditions != json!({}) {
                    return Err("unsupported R preconditions".into());
                }
                Ok(json!(PluginPreflightResult {
                    arguments: args.arguments,
                    target: Some(target.clone()),
                    owner_context: json!({"session_target":target})
                }))
            }
            "r.output_events" => {
                let args: ReadREvents =
                    serde_json::from_value(call.arguments.clone()).map_err(|e| e.to_string())?;
                let runtime = self.runtime()?;
                if args.expected_session != runtime.session_id()
                    || call
                        .binding
                        .target
                        .as_deref()
                        .is_some_and(|value| value != runtime.session_id())
                    || !(1..=100).contains(&args.limit)
                {
                    return Err(
                        "Output observation requires this exact session and a limit of 1–100"
                            .into(),
                    );
                }
                // Reading the append-only observation log never takes the R lane,
                // starts R or turns an observed output event into terminal truth.
                let store = self.output_store()?;
                let output = bound_events(
                    store.events(&OutputEventsArguments {
                        operation_id: args.operation_id,
                        after_sequence: args.after_sequence,
                        limit: args.limit,
                    })?,
                    args.after_sequence,
                )?;
                Ok(json!(REventsObservation {
                    session_id: runtime.session_id().into(),
                    output
                }))
            }
            "r.check_code" => {
                let args: CheckRCode =
                    serde_json::from_value(call.arguments.clone()).map_err(|e| e.to_string())?;
                validate_r_input(&args.code, None)?;
                let runtime = self.runtime()?;
                if args.expected_session != runtime.session_id()
                    || call
                        .binding
                        .target
                        .as_deref()
                        .is_some_and(|value| value != runtime.session_id())
                {
                    return Err("Code check requires this exact native session".into());
                }
                if !self.queue.is_empty() {
                    return Err(
                        "R has queued work or an unsettled result; code was not checked".into(),
                    );
                }
                let _lane = self
                    .lane
                    .try_lock()
                    .map_err(|_| "R is busy; code was not checked")?;
                Ok(json!(runtime.check_code(&args.code).await?))
            }
            "r.snapshot" => {
                if !self.queue.is_empty() {
                    return Err("R has queued work or an unsettled result; this observation did not execute".into());
                }
                let _lane = self
                    .lane
                    .try_lock()
                    .map_err(|_| "R is busy; this observation did not execute")?;
                let args: SnapshotArguments =
                    serde_json::from_value(call.arguments.clone()).map_err(|e| e.to_string())?;
                let runtime = self.runtime()?;
                if args.expected_session.as_deref() != Some(runtime.session_id())
                    || args.limit == 0
                    || args.limit > 200
                {
                    return Err("snapshot requires this exact session and a limit of 1–200".into());
                }
                let observation = runtime
                    .query(&WorkspaceQuery::Snapshot(args))
                    .await
                    .map_err(|e| e.message)?;
                Ok(
                    json!({"session_id":observation.session_id, "data":observation.data,
                    "completeness":observation.completeness, "observed_at_ms":observation.observed_at_ms, "notices":observation.notices}),
                )
            }
            _ => Err("unknown R query".into()),
        }
    }
    async fn inspect(&self, call: &PluginCall, kind: WorkspaceQueryKind) -> Result<Value, String> {
        let mut query = kind.parse(&call.arguments).map_err(|error| error.to_string())?;
        let runtime = self.runtime()?;
        let session = runtime.session_id();
        if query.expected_session() != Some(session)
            || call.binding.target.as_deref().is_some_and(|target| target != session)
        {
            return Err("R inspection requires this exact native session".into());
        }
        // These values come from the initialized Host identity, never from
        // query arguments. Native observation references retain this scope.
        query.bind_scope(WorkspaceQueryScope {
            project: self.environment.project_root.clone(),
            principal: call.principal.to_string(),
            session: session.into(),
        });
        let mut observation = RInspection::<Value> {
            session_id: session.into(),
            status: RInspectionStatus::Busy,
            source: "org.rho.r".into(),
            observed_at_ms: std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH).map_err(|error| error.to_string())?
                .as_millis().try_into().map_err(|_| "Observation time exceeds its contract")?,
            completeness: NativeCompleteness::Unknown,
            data: None,
            notices: vec!["R has active, queued or unsettled work; no inspection was submitted.".into()],
            diagnostic: None,
        };
        if !self.queue.is_empty() {
            return inspection_value(observation);
        }
        let Ok(_lane) = self.lane.try_lock() else {
            return inspection_value(observation);
        };
        match runtime.query(&query).await {
            Ok(native) if native.session_id == session => {
                observation.status = RInspectionStatus::Ready;
                observation.source = native.source;
                observation.observed_at_ms = native.observed_at_ms;
                observation.completeness = native.completeness;
                observation.data = Some(native.data);
                observation.notices = native.notices;
            }
            result => {
                observation.status = RInspectionStatus::Unavailable;
                observation.notices.clear();
                let (code, message) = match result {
                    Err(error) => (error.query_code.map(|code| code.to_string()).unwrap_or_else(|| "unavailable".into()), error.message),
                    Ok(_) => ("session_changed".into(), "The native observation belongs to a different R session".into()),
                };
                observation.diagnostic = Some(RInspectionDiagnostic {
                    code,
                    message: preview(&message).to_owned(),
                });
            }
        }
        inspection_value(observation)
    }

    pub async fn invoke(
        &self,
        call: &PluginCall,
        cancellation: watch::Receiver<bool>,
    ) -> PluginCommitPlan {
        let id = OperationId::new(
            call.operation_id
                .as_deref()
                .expect("admitted original operation"),
        )
        .expect("validated operation identity");
        let lane = self
            .queue
            .acquire(&id, self.lane.clone(), cancellation.clone())
            .await
            .expect("native queue acquisition invariant");
        let result = if let Some(_lane) = lane {
            match self.execute(call, cancellation).await {
            Ok(plan) => plan,
            Err(error) => PluginCommitPlan {
                outcome: if error.effect_may_have_occurred {
                    PluginOutcome::Uncertain
                } else {
                    PluginOutcome::Failed
                },
                output: None,
                error: Some(preview(&error.message).to_owned()),
                recovery: error.recovery.or_else(|| error.effect_may_have_occurred.then(|| json!({
                    "operation_id":call.operation_id, "instance":self.instance,
                    "data_root":self.environment.data_root, "action":"inspect_original_native_output_before_retry"
                }))),
                facts: vec![],
                evidence: vec![],
                cancellation_confirmed: false,
            },
        }
        } else {
            plan(
                PluginOutcome::Cancelled,
                json!({"operation_id":id,"started":false}),
                vec![],
            )
        };
        self.queue
            .finished(&id, result.outcome)
            .expect("native queue result invariant");
        result
    }
    fn inspection_state(&self, call: &PluginCall) -> Result<Value, String> {
        let args: RInspectionStateArguments =
            serde_json::from_value(call.arguments.clone()).map_err(|error| error.to_string())?;
        let runtime = self.runtime.lock().unwrap().clone();
        let session = runtime.as_ref().map(|runtime| runtime.session_id().to_owned());
        if args.expected_session.as_ref().is_some_and(|expected| Some(expected) != session.as_ref())
            || call.binding.target.as_ref().is_some_and(|target| Some(target) != session.as_ref())
        {
            return Err("R inspection readiness requires the exact native session".into());
        }
        let (status, cache_key, notices) = match runtime {
            None => (RInspectionStatus::Unavailable, None, vec![
                if self.launch_attempt.lock().unwrap().is_some() {
                    "R session creation is not confirmed; inspect the original launch Operation."
                } else {
                    "Create an R session to inspect objects, packages and Help."
                }.into(),
            ]),
            Some(runtime) => {
                let key = Some(self.inspection_cache_key.lock().unwrap().clone());
                match runtime.execution_state().as_str() {
                    "idle" if self.queue.is_empty() && self.lane.try_lock().is_ok() =>
                        (RInspectionStatus::Ready, key, vec![]),
                    "idle" | "busy" | "starting" => (RInspectionStatus::Busy, key,
                        vec!["R has active, queued or unsettled work; previous inspections are retained.".into()]),
                    _ => (RInspectionStatus::Unavailable, key,
                        vec!["The original R session is unavailable; no replacement was started.".into()]),
                }
            }
        };
        serde_json::to_value(RInspectionState {
            session_id: session, status, cache_key,
            observed_at_ms: std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH)
                .map_err(|error| error.to_string())?.as_millis().try_into()
                .map_err(|_| "Observation time exceeds its contract")?,
            notices,
        }).map_err(|error| error.to_string())
    }
    async fn execute(
        &self,
        call: &PluginCall,
        cancellation: watch::Receiver<bool>,
    ) -> Result<PluginCommitPlan, NativeError> {
        let operation =
            OperationId::new(call.operation_id.as_deref().ok_or_else(|| {
                NativeError::before_effect("original Operation identity required")
            })?)
            .map_err(|e| NativeError::before_effect(e.to_string()))?;
        let target = self.target();
        if call.binding.target.as_deref() != Some(&target)
            || call.owner_context != json!({"session_target":target})
        {
            return Err(NativeError::before_effect(
                "R native target changed after admission",
            ));
        }
        if *cancellation.borrow() {
            return Ok(plan(
                PluginOutcome::Cancelled,
                json!({"operation_id":operation, "started":false}),
                vec![],
            ));
        }
        match call.binding.capability.id.as_str() {
            "r.create_session" => {
                if self.runtime.lock().unwrap().is_some()
                    || self.launch_attempt.lock().unwrap().is_some()
                    || call.arguments != json!({})
                {
                    return Err(NativeError::before_effect(
                        "This instance already owns a session or creation arguments are invalid",
                    ));
                }
                *self.launch_attempt.lock().unwrap() = Some(operation.clone());
                let runtime = Arc::new(ArkRuntime::launch(ArkConfig {
                    checkpoint_helper_path: None, executable: self.config.ark.clone().ok_or_else(|| NativeError::before_effect("Ark is not configured"))?,
                    r_home: self.config.r_home.clone().ok_or_else(|| NativeError::before_effect("R is not configured"))?,
                    project_root: self.environment.project_root.clone().into(), data_root: self.environment.data_root.clone().into(),
                    execution_timeout: Duration::from_secs(self.config.execution_timeout_seconds), library_path: None,
                }).await.map_err(|error| NativeError::after_possible_effect(error, Some(json!({"instance":self.instance, "data_root":self.environment.data_root, "action":"inspect_native_launch_before_retry"}))))?);
                let output = json!({"operation_id":operation, "session_id":runtime.session_id(), "process":runtime.process_identity(),
                    "installation":runtime.installation_identity(), "project_root":runtime.project_root()});
                *self.runtime.lock().unwrap() = Some(runtime);
                Ok(plan(PluginOutcome::Succeeded, output, vec![]))
            }
            "r.execute" => {
                let args = self
                    .validate_execute(&call.arguments, call.binding.capability.version)
                    .map_err(NativeError::before_effect)?;
                let runtime = self.runtime().map_err(NativeError::before_effect)?;
                *self.inspection_cache_key.lock().unwrap() = format!("{operation}:running");
                let report = runtime
                    .execute_controlled(&operation, &args, cancellation)
                    .await;
                // Native return includes failure/uncertainty. This invalidates
                // presentation only; the original journal decides the outcome.
                *self.inspection_cache_key.lock().unwrap() = format!("{operation}:returned");
                let report = report?;
                let retained = self.retain_report(call, &report).await;
                match retained {
                    Ok((report_reference, events_reference, outputs)) => {
                        let mut evidence = vec![report_reference.clone(), events_reference.clone()];
                        evidence.extend(outputs.iter().map(|(_, reference)| reference.clone()));
                        let value = serde_json::to_vec(&report.value)
                            .map_err(|e| NativeError::after_possible_effect(e.to_string(), None))?;
                        let output = if call.binding.capability.version == 2 {
                            json!(RExecutionResult {
                                operation_id: operation.clone(),
                                session_id: report.session_id.clone(),
                                value: if value.len() <= 32768 {
                                    report.value.clone()
                                } else {
                                    Value::Null
                                },
                                value_in_report: value.len() > 32768,
                                stdout: preview(&report.stdout).into(),
                                stderr: preview(&report.stderr).into(),
                                report: report_reference.clone(),
                                events: events_reference.clone(),
                                outputs: outputs
                                    .iter()
                                    .map(|(native, reference)| RetainedROutput {
                                        native: native.clone(),
                                        reference: reference.clone()
                                    })
                                    .collect(),
                                source: args.source,
                                output_mode: args.output_mode
                            })
                        } else {
                            json!({"operation_id":operation, "session_id":report.session_id,
                            "value":if value.len() <= 32768 { report.value.clone() } else { Value::Null },
                            "value_in_report":value.len() > 32768, "stdout":preview(&report.stdout), "stderr":preview(&report.stderr),
                            "report":report_reference, "events":events_reference, "outputs":outputs.iter().map(|(native, reference)| json!({"native":native,"reference":reference})).collect::<Vec<_>>()})
                        };
                        let mut result = plan(report.outcome, output, evidence);
                        result.error = report.error.map(|message| preview(&message).to_owned());
                        if report.outcome == PluginOutcome::Uncertain {
                            result.recovery =
                                Some(json!({"operation_id":operation,"report":report_reference,
                                "action":"inspect_original_native_output_before_retry"}));
                        }
                        if result.evidence.len() > 256
                            || serde_json::to_vec(&result)
                                .is_ok_and(|bytes| bytes.len() > MAX_CONTROL_BYTES / 2)
                        {
                            return Err(NativeError::after_possible_effect(
                                "R result exceeds the control budget; read the retained original report",
                                Some(json!({"operation_id":operation,"report":report_reference})),
                            ));
                        }
                        Ok(result)
                    }
                    Err(error) => Err(NativeError::after_possible_effect(
                        format!("R finished, but public output retention is incomplete: {error}"),
                        Some(
                            json!({"operation_id":operation,"session_id":report.session_id,"native_outcome":report.outcome,
                            "data_root":self.environment.data_root,"action":"inspect_original_native_output_before_retry"}),
                        ),
                    )),
                }
            }
            _ => Err(NativeError::before_effect("unknown R operation")),
        }
    }
    async fn retain_report(
        &self,
        call: &PluginCall,
        report: &NativeReport,
    ) -> Result<
        (
            ResourceReference,
            ResourceReference,
            Vec<(MediaReference, ResourceReference)>,
        ),
        String,
    > {
        let store = self.output_store()?;
        let mut outputs = vec![];
        for native in &report.output_references {
            let bytes = store.verified_original(native)?;
            let reference = self.retain(call, &native.mime_type, &bytes).await?;
            outputs.push((native.clone(), reference));
        }
        let bytes = serde_json::to_vec(report).map_err(|e| e.to_string())?;
        let reference = self.retain(call, "application/json", &bytes).await?;
        let operation = OperationId::new(
            call.operation_id
                .as_deref()
                .ok_or("original Operation required")?,
        )
        .map_err(|e| e.to_string())?;
        let events = store.events(&OutputEventsArguments {
            operation_id: operation,
            after_sequence: 0,
            limit: 4096,
        })?;
        if events.has_more {
            return Err("native output log exceeds its bound".into());
        }
        let bytes = serde_json::to_vec(&events).map_err(|e| e.to_string())?;
        let events_reference = self.retain(call, "application/json", &bytes).await?;
        Ok((reference, events_reference, outputs))
    }
    fn output_store(&self) -> Result<OutputStore, String> {
        OutputStore::open_read_only(
            &PathBuf::from(&self.environment.data_root),
            &self.environment.project_root,
        )?
        .ok_or_else(|| "Original native output store unavailable".into())
    }
    async fn retain(
        &self,
        call: &PluginCall,
        media_type: &str,
        bytes: &[u8],
    ) -> Result<ResourceReference, String> {
        self.resources
            .put(
                call.request.clone(),
                ResourceDeclaration {
                    digest: ContentDigest::new(format!("sha256:{:x}", Sha256::digest(bytes)))
                        .map_err(|e| e.to_string())?,
                    media_type: media_type.into(),
                    bytes: bytes.len() as u64,
                },
                bytes,
            )
            .await
            .map_err(|e| e.to_string())
    }
    pub fn prepare_pending_cancellation(&self, cancellation: &PendingCancellation) -> Result<bool, String> {
        let binding = &cancellation.binding;
        if binding.provider != self.instance || binding.target.as_deref() != Some(self.target().as_str())
            || binding.capability.id.as_str() != "r.execute" || !matches!(binding.capability.version, 1 | 2) {
            return Err("Pending cancellation requires the exact admitted R execution".into());
        }
        self.queue.prepare_pending_cancellation(cancellation)
    }
    pub fn begin_shutdown(&self) {
        self.queue.begin_shutdown();
        if let Ok(runtime) = self.runtime() {
            runtime.begin_shutdown();
        }
    }
    pub async fn shutdown(&self) -> Result<(), String> {
        if let Ok(runtime) = self.runtime() {
            runtime.shutdown().await.map_err(|e| e.message)?;
        }
        Ok(())
    }
}

/// Bound the entire observation, including JSON escaping. An oversized native
/// page becomes an explicit unavailable result, never a silently shortened page.
fn inspection_value(mut observation: RInspection<Value>) -> Result<Value, String> {
    let encoded = serde_json::to_value(&observation).map_err(|error| error.to_string())?;
    if serde_json::to_vec(&encoded).map_err(|error| error.to_string())?.len() <= 256 * 1024 {
        return Ok(encoded);
    }
    observation.status = RInspectionStatus::Unavailable;
    observation.completeness = NativeCompleteness::Unknown;
    observation.data = None;
    observation.notices.clear();
    observation.diagnostic = Some(RInspectionDiagnostic {
        code: "budget_exhausted".into(),
        message: "R observation exceeds 256 KiB including its envelope; narrow the filter, path or page size.".into(),
    });
    serde_json::to_value(observation).map_err(|error| error.to_string())
}

/// Count JSON bytes, including escaping, rather than assuming event count bounds
/// the framed response. The next page resumes at the last event actually sent.
fn bound_events(mut output: OutputEvents, after: u64) -> Result<OutputEvents, String> {
    let mut bytes = 0;
    let mut count = 0;
    for event in &output.events {
        let size = serde_json::to_vec(event)
            .map_err(|error| error.to_string())?
            .len();
        if bytes + size > 256 * 1024 {
            break;
        }
        bytes += size;
        count += 1;
    }
    if count == 0 && !output.events.is_empty() {
        return Err("Original output event exceeds its presentation bound".into());
    }
    if count < output.events.len() {
        output.events.truncate(count);
        output.has_more = true;
    }
    output.next_sequence = output.events.last().map_or(after, |event| event.sequence);
    Ok(output)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn oversized_inspection_preserves_identity_and_reports_missing_data() {
        let observation = RInspection {
            session_id: "original-session".into(), status: RInspectionStatus::Ready,
            source: "native".into(), observed_at_ms: 42, completeness: NativeCompleteness::Complete,
            data: Some(json!({"text":"\0".repeat(65536)})), notices: vec![], diagnostic: None,
        };
        let value = inspection_value(observation).unwrap();
        assert_eq!(value["session_id"], "original-session");
        assert_eq!(value["observed_at_ms"], 42);
        assert_eq!(value["status"], "unavailable");
        assert_eq!(value["completeness"], "unknown");
        assert!(value["data"].is_null());
        assert_eq!(value["diagnostic"]["code"], "budget_exhausted");
        assert!(serde_json::to_vec(&value).unwrap().len() < 1024);
    }

    #[test]
    fn output_pages_bound_escaped_bytes_without_skipping_events_or_erasing_gaps() {
        let id = OperationId::new("original").unwrap();
        let events = (1..=100)
            .map(|sequence| OutputEvent {
                operation_id: id.clone(),
                sequence,
                kind: "stdout".into(),
                text: Some("\0".repeat(4096)),
                media: None,
                observed_at_ms: 0,
            })
            .collect();
        let page = OutputEvents {
            operation_id: id,
            events,
            next_sequence: 100,
            has_more: false,
            truncated: true,
            gap: true,
            notices: vec!["Original gap".into()],
        };
        let first = bound_events(page.clone(), 0).unwrap();
        assert!(first.has_more && first.truncated && first.gap);
        assert!(first.events.len() < 100);
        assert!(serde_json::to_vec(&first).unwrap().len() < 300 * 1024);
        let mut remaining = page;
        remaining
            .events
            .retain(|event| event.sequence > first.next_sequence);
        let second = bound_events(remaining, first.next_sequence).unwrap();
        assert_eq!(second.events[0].sequence, first.next_sequence + 1);
        assert_eq!(second.notices, vec!["Original gap"]);
    }
}
fn plan(
    outcome: PluginOutcome,
    output: Value,
    evidence: Vec<ResourceReference>,
) -> PluginCommitPlan {
    PluginCommitPlan {
        outcome,
        output: Some(output),
        error: None,
        recovery: None,
        facts: vec![],
        evidence,
        cancellation_confirmed: outcome == PluginOutcome::Cancelled,
    }
}
fn preview(text: &str) -> &str {
    let mut end = text.len().min(16384);
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    &text[..end]
}
