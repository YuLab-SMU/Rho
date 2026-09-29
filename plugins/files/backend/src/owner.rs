mod context;
use rho_files_api::*;
use rho_files_engine::GitProject;
use rho_files_owner::{PatchFailure, PatchOutcome};
use rho_plugin_sdk::protocol::*;
use serde::{Deserialize, de::DeserializeOwned};
use serde_json::{Value, json};
use std::{
    collections::BTreeMap,
    path::Path,
    sync::{Arc, Mutex, OnceLock},
};
use tokio::sync::{OwnedMutexGuard, watch};

pub const MAX_ACCEPTED: usize = 32;
const MAX_QUERY_BYTES: usize = 512 * 1024;

#[derive(Debug)]
pub struct Failure {
    pub code: &'static str,
    pub message: String,
}
impl Failure {
    fn input(message: impl ToString) -> Self {
        Self {
            code: "invalid_input",
            message: message.to_string(),
        }
    }
    fn unavailable(message: impl ToString) -> Self {
        Self {
            code: "unavailable",
            message: message.to_string(),
        }
    }
    fn text(error: ProjectTextError) -> Self {
        let code = match &error {
            ProjectTextError::InvalidInput(_) => "invalid_input",
            ProjectTextError::ObservationExpired(_) => "observation_expired",
            ProjectTextError::ContentChanged(_) => "content_changed",
            ProjectTextError::BudgetExceeded(_) => "budget_exceeded",
            ProjectTextError::Unavailable(_) => "unavailable",
        };
        Self {
            code,
            message: error.to_string(),
        }
    }
}
pub fn supported(capability: &CapabilityKey, query: bool) -> bool {
    capability.version == 1
        && match capability.id.as_str() {
            "files.apply_patch" => !query,
            "files.prepare_patch"
            | "files.snapshot"
            | "files.read_file"
            | "files.read_text"
            | "files.search_text"
            | "files.list_directory"
            | "files.search_files"
            | "files.storage_status"
            | "files.context.search"
            | "files.context.preview" => query,
            _ => false,
        }
}
fn decode<T: DeserializeOwned>(value: &Value) -> Result<T, Failure> {
    serde_json::from_value(value.clone()).map_err(Failure::input)
}
fn encode(value: impl serde::Serialize) -> Result<Value, Failure> {
    serde_json::to_value(value).map_err(Failure::unavailable)
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Empty {}
fn conditions(value: &Value) -> Result<Vec<FilePrecondition>, Failure> {
    let conditions: Vec<FilePrecondition> = if value.is_null() {
        vec![]
    } else {
        decode(value)?
    };
    if conditions.len() > 128 {
        return Err(Failure::input(
            "At most 128 file/Git preconditions are accepted",
        ));
    }
    for condition in &conditions {
        match condition.kind.as_str() {
            "file.sha256" => validate_path(&condition.subject).map_err(Failure::input)?,
            "git.head" if condition.subject == "project" => (),
            _ => return Err(Failure::input("Unsupported file/Git precondition")),
        }
    }
    Ok(conditions)
}
struct Accepted {
    binding: ProviderBinding,
    outcome: Option<PluginOutcome>,
    lane: Option<OwnedMutexGuard<()>>,
}
pub struct Owner {
    root: String,
    context_catalog: Mutex<context::Catalog>,
    runtime: OnceLock<GitProject>,
    paths: OnceLock<WorkspacePaths>,
    lane: Arc<tokio::sync::Mutex<()>>,
    accepted: Mutex<BTreeMap<String, Accepted>>,
}
impl Owner {
    pub fn new(environment: BackendEnvironment, configuration: Value) -> Result<Self, String> {
        serde_json::from_value::<Empty>(configuration).map_err(|error| error.to_string())?;
        let root = Path::new(&environment.project_root);
        if !root.is_absolute()
            || !root.is_dir()
            || root.canonicalize().map_err(|error| error.to_string())? != root
        {
            return Err("Files requires the normalized Host project root".into());
        }
        Ok(Self {
            root: environment.project_root,
            context_catalog: Mutex::new(context::Catalog::default()),
            runtime: OnceLock::new(),
            paths: OnceLock::new(),
            lane: Arc::new(tokio::sync::Mutex::new(())),
            accepted: Mutex::new(BTreeMap::new()),
        })
    }
    pub fn bound(&self) -> bool {
        self.runtime.get().is_some()
    }
    /// Only the server's correlated HostResult can install these boundaries.
    pub fn bind_paths(&self, result: &Value) -> Result<(), String> {
        if result.get("status") != Some(&json!("ready"))
            || result.get("completeness") != Some(&json!("complete"))
        {
            return Err("Host path boundaries are not a complete ready observation".into());
        }
        let paths: WorkspacePaths = serde_json::from_value(
            result
                .get("data")
                .cloned()
                .ok_or("Host paths are missing")?,
        )
        .map_err(|e| e.to_string())?;
        if paths.project_root != self.root
            || paths.protected_paths.len() > 256
            || paths
                .protected_paths
                .iter()
                .any(|path| !Path::new(path).is_absolute() || path.len() > 4096)
            || serde_json::to_vec(&paths.protected_paths)
                .map_err(|e| e.to_string())?
                .len()
                > 128 * 1024
        {
            return Err(
                "Host path boundaries differ from the initialized root or exceed their budget"
                    .into(),
            );
        }
        if let Some(original) = self.paths.get() {
            return if original == &paths {
                Ok(())
            } else {
                Err("Host path boundaries changed for this instance".into())
            };
        }
        let runtime = GitProject::open(
            &self.root,
            paths.protected_paths.iter().map(Into::into).collect(),
        )?;
        self.paths
            .set(paths)
            .map_err(|_| "Paths were initialized twice")?;
        self.runtime
            .set(runtime)
            .map_err(|_| "Native provider was initialized twice")?;
        Ok(())
    }
    fn runtime(&self) -> Result<&GitProject, Failure> {
        self.runtime
            .get()
            .ok_or_else(|| Failure::unavailable("Host path boundaries have not been observed"))
    }
    pub fn check_call(&self, call: &PluginCall) -> Result<(), Failure> {
        if !supported(&call.binding.capability, call.operation_id.is_none()) {
            return Err(Failure::input(
                "Unsupported Files capability or message kind",
            ));
        }
        if !call.scopes.contains(PROJECT_READ_SCOPE)
            || (matches!(
                call.binding.capability.id.as_str(),
                "files.apply_patch" | "files.prepare_patch"
            ) && !call.scopes.contains(PROJECT_WRITE_SCOPE))
        {
            return Err(Failure {
                code: "access_denied",
                message: "Files requires the declared read/write scopes".into(),
            });
        }
        if call
            .binding
            .target
            .as_ref()
            .is_some_and(|target| target != &self.root)
        {
            return Err(Failure::input(
                "Files target differs from the initialized project",
            ));
        }
        Ok(())
    }
    pub async fn query(
        &self,
        call: &PluginCall,
    ) -> Result<(Value, ObservationCompleteness), Failure> {
        self.check_call(call)?;
        if !call.preconditions.is_null() || !call.owner_context.is_null() {
            return Err(Failure::input(
                "Query qualifications belong only in a preflight payload",
            ));
        }
        let runtime = self.runtime()?;
        if call.binding.capability.id.as_str().starts_with("files.context.") {
            return Ok((self.context(call).await?, ObservationCompleteness::Complete));
        }
        if call.binding.capability.id.as_str() == "files.prepare_patch" {
            let request: PluginPreflightRequest = decode(&call.arguments)?;
            if request.capability.id.as_str() != "files.apply_patch"
                || request.capability.version != 1
                || request
                    .target
                    .as_ref()
                    .is_some_and(|target| target != &self.root)
            {
                return Err(Failure::input("Preflight requires this Files patch target"));
            }
            let args: ApplyPatchArguments = decode(&request.arguments)?;
            validate_patch(&args).map_err(Failure::input)?;
            let conditions = conditions(&request.preconditions)?;
            let paths = runtime
                .patch_paths(&args.patch)
                .await
                .map_err(Failure::input)?;
            if paths.is_empty() || paths.len() > MAX_PROJECT_PATHS {
                return Err(Failure::input("Patch must affect 1..=64 paths"));
            }
            let mut observed = paths;
            observed.extend(
                conditions
                    .iter()
                    .filter(|condition| condition.kind == "file.sha256")
                    .map(|condition| condition.subject.clone()),
            );
            observed.sort();
            observed.dedup();
            if observed.len() > MAX_PROJECT_PATHS {
                return Err(Failure::input(
                    "Preconditions exceed the file observation limit",
                ));
            }
            return Ok((
                encode(PluginPreflightResult {
                    arguments: encode(args)?,
                    target: Some(self.root.clone()),
                    owner_context: json!({"project_root":self.root}),
                })?,
                ObservationCompleteness::Complete,
            ));
        }
        let _lane = self.lane.try_lock().map_err(|_| Failure {
            code: "busy",
            message:
                "Files is applying or settling an original patch; no new observation was submitted"
                    .into(),
        })?;
        let data = match call.binding.capability.id.as_str() {
            "files.snapshot" => {
                let mut args = decode(&call.arguments)?;
                validate_snapshot(&mut args).map_err(Failure::input)?;
                encode(
                    runtime
                        .snapshot(&args.paths, args.limit)
                        .await
                        .map_err(Failure::unavailable)?,
                )?
            }
            "files.read_file" => {
                let args = decode(&call.arguments)?;
                validate_read_file(&args).map_err(Failure::input)?;
                encode(
                    runtime
                        .read_file(&args)
                        .await
                        .map_err(Failure::unavailable)?,
                )?
            }
            "files.read_text" => {
                let args = decode(&call.arguments)?;
                validate_read(&args).map_err(Failure::text)?;
                { let page = runtime.read_text(&args).await.map_err(Failure::text)?;
                self.context_catalog.lock().unwrap().observe(call.principal.as_str(), &page);
                encode(page)? }
            }
            "files.search_text" => {
                let args = decode(&call.arguments)?;
                validate_search(&args).map_err(Failure::text)?;
                encode(runtime.search_text(&args).await.map_err(Failure::text)?)?
            }
            "files.list_directory" => {
                let args = decode(&call.arguments)?;
                validate_directory(&args).map_err(Failure::input)?;
                encode(
                    runtime
                        .list_directory(&args)
                        .await
                        .map_err(Failure::unavailable)?,
                )?
            }
            "files.search_files" => {
                let args = decode(&call.arguments)?;
                encode(
                    rho_files_owner::search_files(runtime, &args)
                        .await
                        .map_err(Failure::input)?,
                )?
            }
            "files.storage_status" => {
                let _: Empty = decode(&call.arguments)?;
                encode(
                    runtime
                        .storage_status()
                        .await
                        .map_err(Failure::unavailable)?,
                )?
            }
            _ => return Err(Failure::input("Unsupported Files query")),
        };
        if serde_json::to_vec(&data)
            .map_err(Failure::unavailable)?
            .len()
            > MAX_QUERY_BYTES
        {
            return Err(Failure {
                code: "budget_exceeded",
                message: "File observation exceeds 512 KiB; request a smaller page".into(),
            });
        }
        Ok((data, ObservationCompleteness::Partial))
    }
    pub fn admit(&self, call: &PluginCall) -> Result<(), Failure> {
        self.check_call(call)?;
        self.runtime()?;
        let operation = call
            .operation_id
            .as_ref()
            .ok_or_else(|| Failure::input("Original Operation required"))?;
        OperationId::new(operation).map_err(Failure::input)?;
        if call.binding.target.as_deref() != Some(&self.root)
            || call.owner_context != json!({"project_root":self.root})
        {
            return Err(Failure::input(
                "Files target or qualification changed after admission",
            ));
        }
        let args = decode(&call.arguments)?;
        validate_patch(&args).map_err(Failure::input)?;
        conditions(&call.preconditions)?;
        let mut accepted = self.accepted.lock().unwrap();
        if accepted.contains_key(operation) {
            return Err(Failure {
                code: "duplicate_operation",
                message: "Original Operation was already admitted".into(),
            });
        }
        if accepted.len() >= MAX_ACCEPTED {
            return Err(Failure {
                code: "busy",
                message: "Files accepted-operation capacity reached".into(),
            });
        }
        accepted.insert(
            operation.clone(),
            Accepted {
                binding: call.binding.clone(),
                outcome: None,
                lane: None,
            },
        );
        Ok(())
    }
    pub async fn invoke(
        &self,
        call: &PluginCall,
        mut cancellation: watch::Receiver<bool>,
    ) -> PluginCommitPlan {
        let acquiring = self.lane.clone().lock_owned();
        let lane = tokio::select! { lane = acquiring => Some(lane), _ = cancelled(&mut cancellation) => None };
        let plan = if lane.is_none() || *cancellation.borrow() {
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
            self.apply(call).await
        };
        // Returning a result is not the journal's settlement acknowledgement.
        let mut accepted = self.accepted.lock().unwrap();
        let entry = accepted
            .get_mut(call.operation_id.as_ref().unwrap())
            .expect("admitted original Operation");
        entry.outcome = Some(plan.outcome);
        entry.lane = lane;
        plan
    }
    async fn apply(&self, call: &PluginCall) -> PluginCommitPlan {
        let args: ApplyPatchArguments =
            serde_json::from_value(call.arguments.clone()).expect("validated arguments");
        let preconditions = conditions(&call.preconditions).expect("validated preconditions");
        match rho_files_owner::apply_patch(self.runtime.get().unwrap(), &args, &preconditions).await
        {
            Ok(assessment) => {
                let outcome = match assessment.outcome {
                    PatchOutcome::Succeeded => PluginOutcome::Succeeded,
                    PatchOutcome::Failed => PluginOutcome::Failed,
                    PatchOutcome::Uncertain => PluginOutcome::Uncertain,
                };
                let fact = ProposedFact {
                    schema: "rho.files.patch.v1".into(),
                    key: call.operation_id.clone().unwrap(),
                    value: json!({"operation_id":call.operation_id,"root":self.root,"changed_paths":assessment.result.changed_paths}),
                };
                PluginCommitPlan {
                    outcome,
                    output: Some(json!(assessment.result)),
                    error: assessment.error,
                    recovery: assessment.recovery,
                    facts: vec![fact],
                    evidence: vec![],
                    cancellation_confirmed: false,
                }
            }
            Err(PatchFailure::BeforeEffect { message }) => failed(message),
            Err(PatchFailure::AfterPossibleEffect { message, recovery }) => PluginCommitPlan {
                outcome: PluginOutcome::Uncertain,
                output: None,
                error: Some(message),
                recovery: Some(recovery),
                facts: vec![],
                evidence: vec![],
                cancellation_confirmed: false,
            },
        }
    }
    pub fn settle(&self, settlement: &OperationSettlement) -> Result<(), String> {
        let mut accepted = self.accepted.lock().unwrap();
        let Some(entry) = accepted.get(settlement.operation_id.as_str()) else {
            return Ok(());
        };
        if entry.binding != settlement.binding || entry.outcome.is_none() {
            return Err("Settlement does not match a returned Files operation".into());
        }
        if settlement.outcome == PluginOutcome::Succeeded
            && entry.outcome != Some(PluginOutcome::Succeeded)
        {
            return Err("Settlement cannot promote an unconfirmed native patch to success".into());
        }
        accepted.remove(settlement.operation_id.as_str());
        Ok(())
    }
    pub fn ready_to_release(&self) -> bool {
        self.accepted.lock().unwrap().is_empty()
    }
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
