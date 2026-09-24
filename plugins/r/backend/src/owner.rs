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

/// One exact plugin instance owns one native session and its execution lane.
/// No journal or second result authority is available to this process.
pub struct Owner {
    config: Configuration,
    environment: BackendEnvironment,
    instance: InstanceRef,
    runtime: Mutex<Option<Arc<ArkRuntime>>>,
    launch_attempt: Mutex<Option<OperationId>>,
    lane: Lane<()>,
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
            lane: Lane::new(()),
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
    fn validate_execute(&self, value: &Value) -> Result<Execute, String> {
        let args: Execute = serde_json::from_value(value.clone()).map_err(|e| e.to_string())?;
        if args.expected_session != self.runtime()?.session_id() {
            return Err("R session precondition changed".into());
        }
        if args.code.is_empty() || args.code.contains('\0') || args.code.len() > 256 * 1024 {
            return Err("R code must contain 1–262144 bytes".into());
        }
        Ok(args)
    }
    /// Input answers belong to a pending native request, never to a new
    /// scientific Operation. Do not take the execution lane held by that request.
    pub fn control(&self, call: &PluginCall) -> Result<Value, String> {
        if call.binding.capability.id.as_str() != "r.respond_input"
            || call.binding.capability.version != 1
            || call.operation_id.is_some()
            || (!call.preconditions.is_null() && call.preconditions != json!({}))
        {
            return Err("Unsupported R control".into());
        }
        let reply: RespondInput = serde_json::from_value(call.arguments.clone())
            .map_err(|_| "Invalid input response (redacted)")?;
        let runtime = self.runtime()?;
        if call.binding.target.as_deref() != Some(runtime.session_id())
            || reply.session_id != runtime.session_id()
        {
            return Err("Input response requires this exact native session".into());
        }
        // The native owner checks original Operation, request, submission state
        // and byte bounds. Neither the payload nor transport diagnostics escape.
        runtime.respond_input(reply)
            .map_err(|_| "Input was not confirmed; inspect the pending native request (redacted)")?;
        Ok(json!({"submitted":true}))
    }
    pub async fn query(&self, call: &PluginCall) -> Result<Value, String> {
        match call.binding.capability.id.as_str() {
            "r.session" => Ok(match self.runtime.lock().unwrap().as_ref() {
                Some(runtime) => {
                    json!({"state":runtime.execution_state(), "session_id":runtime.session_id(),
                    "process":runtime.process_identity(), "installation":runtime.installation_identity(), "input":runtime.input_request()})
                }
                None => {
                    let attempt = self.launch_attempt.lock().unwrap();
                    json!({"state":if attempt.is_some() { "launch_unconfirmed" } else { "unstarted" }, "session_id":null, "launch_operation":*attempt})
                }
            }),
            "r.prepare" => {
                let args: PluginPreflightRequest =
                    serde_json::from_value(call.arguments.clone()).map_err(|e| e.to_string())?;
                if args.capability.version != 1 {
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
                        self.validate_execute(&args.arguments)?;
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
            "r.snapshot" => {
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
    pub async fn invoke(
        &self,
        call: &PluginCall,
        cancellation: watch::Receiver<bool>,
    ) -> PluginCommitPlan {
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
    }
    async fn execute(
        &self,
        call: &PluginCall,
        cancellation: watch::Receiver<bool>,
    ) -> Result<PluginCommitPlan, NativeError> {
        let _lane = self
            .lane
            .try_lock()
            .map_err(|_| NativeError::before_effect("R execution lane is busy"))?;
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
                    .validate_execute(&call.arguments)
                    .map_err(NativeError::before_effect)?;
                let runtime = self.runtime().map_err(NativeError::before_effect)?;
                let report = runtime
                    .execute_controlled(
                        &operation,
                        &RunRArguments {
                            code: args.code,
                            ..Default::default()
                        },
                        cancellation,
                    )
                    .await?;
                let retained = self.retain_report(call, &report).await;
                match retained {
                    Ok((report_reference, events_reference, outputs)) => {
                        let mut evidence = vec![report_reference.clone(), events_reference.clone()];
                        evidence.extend(outputs.iter().map(|(_, reference)| reference.clone()));
                        let value = serde_json::to_vec(&report.value)
                            .map_err(|e| NativeError::after_possible_effect(e.to_string(), None))?;
                        let mut result = plan(
                            report.outcome,
                            json!({"operation_id":operation, "session_id":report.session_id,
                            "value":if value.len() <= 32768 { report.value.clone() } else { Value::Null },
                            "value_in_report":value.len() > 32768, "stdout":preview(&report.stdout), "stderr":preview(&report.stderr),
                            "report":report_reference, "events":events_reference, "outputs":outputs.iter().map(|(native, reference)| json!({"native":native,"reference":reference})).collect::<Vec<_>>()}),
                            evidence,
                        );
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
        let store = OutputStore::open_read_only(
            &PathBuf::from(&self.environment.data_root),
            &self.environment.project_root,
        )?
        .ok_or("original native output store unavailable")?;
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
    pub fn begin_shutdown(&self) {
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
