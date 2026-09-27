//! Ordinary recovery uses scoped public Host reads and the single core journal.
//! Native files are evidence, and leases survive until exact Host settlement.
use super::*;
use base64::Engine;
use rho_r_engine::recovery::{
    RecoveryArchive, RecoveryCapture, RecoveryControl, RecoveryLease, RecoveryScope,
};
use serde::{Serialize, de::DeserializeOwned};
use std::{
    collections::BTreeSet,
    path::{Component, Path},
};

pub const CAPTURE: &str = "r.capture_checkpoint";
pub const RESTORE: &str = "r.restore_checkpoint";
pub const RECONCILE: &str = "r.reconcile_checkpoint";
pub const PIN: &str = "r.pin_checkpoint";
pub const DELETE: &str = "r.delete_checkpoint";
pub const PURGE: &str = "r.purge_checkpoint";
pub const PREPARE: &str = "r.prepare_checkpoint";
pub const OBSERVE: &str = "r.checkpoint";
pub const READ: &str = "r.read_checkpoint";
pub const LIST: &str = "r.checkpoints";
const MAX_MANIFEST: u64 = 1024 * 1024;
const PAGE: u32 = 32;
const PAGES: usize = 128;

pub fn is_operation(id: &str) -> bool {
    matches!(id, CAPTURE | RESTORE | RECONCILE | PIN | DELETE | PURGE)
}
pub fn is_query(id: &str) -> bool {
    matches!(id, PREPARE | OBSERVE | READ | LIST)
}
fn key(id: &str) -> CapabilityKey {
    environment_binding::key(id, 1)
}
fn decode<T: DeserializeOwned>(value: Value) -> Result<T, String> {
    serde_json::from_value(value).map_err(display)
}
fn display(e: impl std::fmt::Display) -> String {
    e.to_string()
}
fn before(e: impl std::fmt::Display) -> NativeError {
    NativeError::before_effect(e.to_string())
}

pub struct Grants {
    get: bool,
    list: bool,
    resources: bool,
    coverage: bool,
}
impl Grants {
    pub fn new(grants: &[CapabilityRequirement]) -> Self {
        let has = |id: &str, scope: &str| {
            grants
                .iter()
                .any(|grant| grant.capability == key(id) && grant.scopes.contains(scope))
        };
        Self {
            get: has("operation.get", "operation.read"),
            list: has("operation.list_recent", "operation.read"),
            resources: has("resources.read", "resources.read"),
            coverage: has("operation.project_coverage", "operation.read")
                && has("operation.project_coverage", "project.references.read"),
        }
    }
    fn check(&self, call: &PluginCall, resources: bool) -> Result<(), String> {
        if !self.get
            || !self.list
            || (resources && !self.resources)
            || !call.scopes.contains("workspace.read")
            || !call.scopes.contains("operation.read")
            || (resources && !call.scopes.contains("resources.read"))
        {
            return Err("Recovery requires explicitly selected original-operation and resource read grants and their scopes".into());
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Storage {
    scope: RecoveryScope,
    data_root: String,
}
impl Storage {
    fn validate(
        &self,
        call: &PluginCall,
        project_root: &str,
        provider: &InstanceRef,
    ) -> Result<(), String> {
        let path = Path::new(&self.data_root);
        if self.scope.project != call.binding.project
            || self.scope.principal != call.principal
            || self.scope.project_root != Path::new(project_root)
            || &self.scope.provider != provider
            || self.data_root.len() > 4096
            || !path.is_absolute()
            || path
                .components()
                .any(|part| matches!(part, Component::CurDir | Component::ParentDir))
        {
            return Err(
                "Recovery storage differs from its original project, principal or provider".into(),
            );
        }
        Ok(())
    }
    fn open(&self) -> Result<RecoveryArchive, String> {
        RecoveryArchive::open(Path::new(&self.data_root), self.scope.clone())?
            .ok_or_else(|| "Original native recovery archive is unavailable".into())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Source {
    binding: ProviderBinding,
    storage: Storage,
    reference: RCheckpointReference,
    native_session_id: String,
    environment: Option<RSessionEnvironment>,
    original_source: Option<RCheckpointReference>,
    result: Option<RCheckpointResult>,
    status: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Qualification {
    session_target: String,
    arguments_digest: ContentDigest,
    storage: Storage,
    environment: Option<RSessionEnvironment>,
    source: Option<Source>,
}

pub struct Pending {
    binding: ProviderBinding,
    leases: Vec<Arc<RecoveryLease>>,
    deletion: Option<OperationId>,
}

#[derive(Default, Debug, Clone, PartialEq, Eq)]
struct ControlState {
    head: Option<OperationId>,
    pinned: bool,
    deleted: bool,
}

// Only the bounded fields needed from the public journal observation. The
// journal owns the complete record and may add unrelated summary fields.
#[derive(Deserialize)]
struct JournalPage {
    operations: Vec<JournalItem>,
    next_cursor: Option<u64>,
}
#[derive(Deserialize)]
struct JournalItem {
    cursor: u64,
    operation_id: OperationId,
    capability: CapabilityKey,
    status: String,
}

impl Owner {
    fn recovery_native_ready(&self, id: &str, arguments: &Value) -> Result<(), String> {
        if matches!(id, CAPTURE | RESTORE) {
            let runtime = self.runtime()?;
            if !runtime.checkpoint_available()
                || arguments["expected_session"] != runtime.session_id()
            {
                return Err("Recovery requires the exact existing session and its verified native component".into());
            }
        }
        Ok(())
    }

    pub(super) fn admit_recovery(&self, call: &PluginCall) -> Result<(), String> {
        if call.binding.capability.version != 1 {
            return Err("Unsupported recovery version".into());
        }
        let id = call.binding.capability.id.as_str();
        let normalized = normalize(id, call.arguments.clone())?;
        let qualification: Qualification = decode(call.owner_context.clone())?;
        // JSON peers may encode 10.0 as 10. Freeze semantic arguments in the
        // admission rather than depending on a transport's number spelling.
        if arguments_digest(&normalized)? != qualification.arguments_digest {
            return Err("Recovery arguments changed after preflight".into());
        }
        if qualification.session_target != self.target()
            || json!(qualification.storage) != json!(self.recovery_storage(call))
            || json!(qualification.environment) != json!(*self.selected_environment.lock().unwrap())
            || (id == CAPTURE) != qualification.source.is_none()
        {
            return Err(
                "Recovery target, storage, Environment or source changed after admission".into(),
            );
        }
        if let Some(source) = &qualification.source {
            self.recovery_grants.check(call, true)?;
            source.storage.validate(
                call,
                &self.environment.project_root,
                &source.binding.provider,
            )?;
            if id == RECONCILE {
                if call.arguments["source_operation_id"] != json!(source.reference.operation_id) {
                    return Err("Recovery reconciliation source changed".into());
                }
            } else if call.arguments["reference"] != json!(source.reference) {
                return Err("Recovery reference changed after admission".into());
            }
        }
        self.recovery_native_ready(id, &call.arguments)
    }

    pub(super) fn settle_recovery(&self, settlement: &OperationSettlement) -> Result<(), String> {
        let mut pending = self.recovery_pending.lock().unwrap();
        if let Some(item) = pending.get(&settlement.operation_id) {
            if item.binding != settlement.binding {
                return Err("Recovery settlement changed its admitted binding".into());
            }
            if settlement.outcome == PluginOutcome::Succeeded {
                if let Some(deletion) = &item.deletion {
                    if let Err(error) = item.leases[0].remove_payload_after_commit(deletion) {
                        // The core committed logical retirement. A cleanup failure
                        // does not rewrite that truth or strand the native queue.
                        eprintln!(
                            "Committed recovery deletion needs explicit cleanup: {}",
                            preview(&error)
                        );
                    }
                }
            }
        }
        pending.remove(&settlement.operation_id);
        Ok(())
    }

    async fn recovery_page(
        &self,
        call: &PluginCall,
        cursor: Option<u64>,
        limit: u32,
    ) -> Result<JournalPage, String> {
        let page: JournalPage = decode(
            self.recovery_read(
                call,
                "operation.list_recent",
                json!({"before_cursor":cursor,"limit":limit}),
            )
            .await?,
        )?;
        let mut previous = cursor.unwrap_or(i64::MAX as u64);
        let mut ids = BTreeSet::new();
        if page.operations.len() > limit as usize {
            return Err("Recovery journal exceeded its requested page".into());
        }
        for item in &page.operations {
            if item.cursor == 0 || item.cursor >= previous || !ids.insert(item.operation_id.clone())
            {
                return Err("Recovery journal page changed order or identity".into());
            }
            previous = item.cursor;
        }
        if page.next_cursor.is_some()
            && page.next_cursor != page.operations.last().map(|item| item.cursor)
        {
            return Err("Recovery journal cursor does not continue this page".into());
        }
        Ok(page)
    }

    async fn checkpoint_controls(
        &self,
        call: &PluginCall,
        source: &Source,
        lease: &RecoveryLease,
    ) -> Result<ControlState, String> {
        if !self.recovery_grants.coverage || !call.scopes.contains("project.references.read") {
            return Err(
                "Recovery control state requires an explicit project journal coverage grant".into(),
            );
        }
        let coverage: ProjectReadCoverage = decode(
            self.recovery_read(call, "operation.project_coverage", json!({}))
                .await?,
        )?;
        if !coverage.all_visible {
            return Err(
                "Some project recovery controls are outside this caller's visibility".into(),
            );
        }
        let scan = async {
            let mut cursor = None;
            let mut controls = Vec::new();
            for _ in 0..PAGES {
                let page = self.recovery_page(call, cursor, PAGE).await?;
                for item in page.operations {
                    if item.operation_id == source.reference.operation_id {
                        // Native exclusion fences effects while this bounded
                        // journal scan qualifies every later committed control.
                        let mut state = ControlState::default();
                        for (operation, expected, action, output) in controls.into_iter().rev() {
                            apply_control(
                                &mut state,
                                &source.reference,
                                &operation,
                                expected,
                                action,
                                output,
                            )?;
                        }
                        return Ok(state);
                    }
                    if !matches!(item.capability.id.as_str(), PIN | DELETE)
                        || call.operation_id.as_deref() == Some(item.operation_id.as_str())
                    {
                        continue;
                    }
                    if item.capability.version != 1 {
                        return Err(
                            "Recovery history contains an unsupported control version".into()
                        );
                    }
                    let record = self.recovery_record(call, &item.operation_id).await?;
                    let arguments = &record["operation"]["normalized_arguments"]["arguments"];
                    if arguments["reference"]["operation_id"]
                        != json!(source.reference.operation_id)
                    {
                        continue;
                    }
                    let (binding, qualification) = self.original_qualification(call, &record)?;
                    if binding.capability != item.capability
                        || arguments["reference"] != json!(source.reference)
                        || qualification.source.as_ref().is_none_or(|original| {
                            original.reference != source.reference
                                || json!(original.storage) != json!(source.storage)
                        })
                    {
                        return Err("Original recovery control changed its admitted source".into());
                    }
                    match record["status"].as_str() {
                        Some("failed" | "cancelled") => continue,
                        Some("succeeded") => (),
                        _ => return Err("Original recovery control is pending or uncertain; reconcile its original operation before changing this copy".into()),
                    }
                    let expected: Option<OperationId> =
                        decode(arguments["expected_control"].clone())?;
                    let action = if binding.capability.id.as_str() == PIN {
                        RecoveryControl::Pin {
                            pinned: decode(arguments["pinned"].clone())?,
                        }
                    } else {
                        RecoveryControl::Delete
                    };
                    if lease.control(&item.operation_id)?.control != action {
                        return Err(
                            "Committed recovery control differs from native evidence".into()
                        );
                    }
                    controls.push((
                        item.operation_id,
                        expected,
                        action,
                        decode::<RCheckpointControlResult>(record["output"].clone())?,
                    ));
                }
                cursor = page.next_cursor;
                if cursor.is_none() {
                    break;
                }
            }
            Err("Recovery control history did not reach the original capture within its bounded scan".into())
        };
        tokio::time::timeout(Duration::from_secs(30), scan)
            .await
            .map_err(|_| "Recovery control scan exceeded its bounded deadline")?
    }

    async fn prepare_recovery(&self, call: &PluginCall) -> Result<Value, String> {
        let request: PluginPreflightRequest = decode(call.arguments.clone())?;
        let target = self.target();
        if request.capability.version != 1
            || !is_operation(request.capability.id.as_str())
            || request
                .target
                .as_ref()
                .is_some_and(|value| value != &target)
            || call
                .binding
                .target
                .as_ref()
                .is_some_and(|value| value != &target)
            || !call.owner_context.is_null()
            || !(call.preconditions.is_null() || call.preconditions == json!({}))
            || !(request.preconditions.is_null() || request.preconditions == json!({}))
        {
            return Err("Recovery preflight changed its target, version or preconditions".into());
        }
        let id = request.capability.id.as_str();
        let arguments = normalize(id, request.arguments)?;
        self.recovery_native_ready(id, &arguments)?;
        if id == CAPTURE && arguments["automatic"] == true && !self.queue.is_empty() {
            return Err("Automatic capture requires an idle, settled native queue".into());
        }
        let source = if id == CAPTURE {
            None
        } else {
            self.recovery_grants.check(call, true)?;
            let operation: OperationId = decode(if id == RECONCILE {
                arguments["source_operation_id"].clone()
            } else {
                arguments["reference"]["operation_id"].clone()
            })?;
            let source = self
                .checkpoint_source(call, &operation, id == RECONCILE)
                .await?;
            if id != RECONCILE && arguments["reference"] != json!(source.reference) {
                return Err(
                    "Recovery reference differs from its original succeeded operation".into(),
                );
            }
            let lease = source.storage.open()?.acquire(&operation)?;
            self.checkpoint_manifest(call, &source, &lease).await?;
            if id != RECONCILE {
                let state = self.checkpoint_controls(call, &source, &lease).await?;
                check_action(id, &arguments, &state)?;
            }
            Some(source)
        };
        if target != self.target() {
            return Err("Recovery native target changed during preflight".into());
        }
        Ok(json!(PluginPreflightResult {
            arguments: arguments.clone(),
            target: Some(target.clone()),
            owner_context: json!(Qualification {
                session_target: target,
                arguments_digest: arguments_digest(&arguments)?,
                storage: self.recovery_storage(call),
                environment: self.selected_environment.lock().unwrap().clone(),
                source,
            })
        }))
    }

    pub(super) async fn query_recovery(&self, call: &PluginCall) -> Result<Value, String> {
        tokio::time::timeout(Duration::from_secs(30), self.query_recovery_inner(call))
            .await
            .map_err(|_| "Recovery observation exceeded its bounded deadline")?
    }

    async fn query_recovery_inner(&self, call: &PluginCall) -> Result<Value, String> {
        if call.binding.capability.version != 1 || call.operation_id.is_some() {
            return Err("Unsupported recovery observation".into());
        }
        if call.binding.capability.id.as_str() == PREPARE {
            return self.prepare_recovery(call).await;
        }
        self.recovery_grants
            .check(call, call.binding.capability.id.as_str() != LIST)?;
        if !call.owner_context.is_null()
            || !(call.preconditions.is_null() || call.preconditions == json!({}))
            || call
                .binding
                .target
                .as_ref()
                .is_some_and(|target| target != &self.target())
        {
            return Err("Recovery observation changed its target or preconditions".into());
        }
        if call.binding.capability.id.as_str() == LIST {
            let args: RCheckpointList = decode(call.arguments.clone())?;
            if !(1..=32).contains(&args.limit) {
                return Err("Recovery journal pages require 1–32 entries".into());
            }
            let page = self
                .recovery_page(call, args.before_cursor, args.limit)
                .await?;
            let mut checkpoints = Vec::new();
            for item in page.operations {
                if matches!(item.capability.id.as_str(), CAPTURE | RECONCILE)
                    && item.status == "succeeded"
                {
                    if item.capability.version != 1 {
                        return Err(
                            "Recovery history contains an unsupported result version".into()
                        );
                    }
                    checkpoints.push(
                        self.checkpoint_source(call, &item.operation_id, false)
                            .await?
                            .result
                            .unwrap(),
                    );
                }
            }
            return Ok(json!(RCheckpointPage {
                checkpoints,
                next_cursor: page.next_cursor
            }));
        }
        let (reference, reading) = match call.binding.capability.id.as_str() {
            OBSERVE => (
                decode::<RCheckpointArguments>(call.arguments.clone())?.reference,
                None,
            ),
            READ => {
                let args: RCheckpointRead = decode(call.arguments.clone())?;
                if !(1..=65536).contains(&args.limit) {
                    return Err("Recovery reads require 1–65536 bytes".into());
                }
                (args.reference.clone(), Some(args))
            }
            _ => return Err("Unknown recovery query".into()),
        };
        let source = self
            .checkpoint_source(call, &reference.operation_id, false)
            .await?;
        if reference != source.reference {
            return Err("Recovery reference differs from its original succeeded operation".into());
        }
        let lease = source.storage.open()?.acquire(&reference.operation_id)?;
        self.checkpoint_manifest(call, &source, &lease).await?;
        let state = self.checkpoint_controls(call, &source, &lease).await?;
        if let Some(args) = reading {
            if state.deleted {
                return Err("This recovery copy was logically deleted".into());
            }
            let bytes = lease.read(args.offset, args.limit)?;
            let end = args.offset + bytes.len() as u64;
            Ok(json!(RCheckpointChunk {
                reference: reference.clone(),
                offset: args.offset,
                base64: base64::engine::general_purpose::STANDARD.encode(bytes),
                next: (end < reference.bytes).then_some(end)
            }))
        } else {
            let mut notices = Vec::new();
            let payload = match lease.payload_present() {
                Ok(true) => {
                    if state.deleted {
                        notices.push("Logical deletion is committed; native payload cleanup is still required.".into());
                    }
                    RCheckpointPayloadState::Present
                }
                Ok(false) => RCheckpointPayloadState::Missing,
                Err(error) => {
                    notices.push(preview(&error).into());
                    RCheckpointPayloadState::Unavailable
                }
            };
            Ok(json!(RCheckpointObservation {
                checkpoint: source.result.unwrap(),
                control_head: state.head,
                pinned: state.pinned,
                deleted: state.deleted,
                payload,
                notices
            }))
        }
    }

    fn hold_recovery(
        &self,
        call: &PluginCall,
        operation: &OperationId,
        leases: Vec<Arc<RecoveryLease>>,
        deletion: Option<OperationId>,
    ) {
        self.recovery_pending.lock().unwrap().insert(
            operation.clone(),
            Pending {
                binding: call.binding.clone(),
                leases,
                deletion,
            },
        );
    }

    async fn publish_checkpoint(
        &self,
        call: &PluginCall,
        manifest: &RCheckpointManifest,
        lease: &RecoveryLease,
    ) -> Result<PluginCommitPlan, NativeError> {
        let publish = async {
            let bytes = serde_json::to_vec(manifest).map_err(display)?;
            if bytes.len() as u64 > MAX_MANIFEST {
                return Err("Recovery manifest exceeds its retained metadata bound".into());
            }
            lease.write_context(manifest)?;
            let retained = self.retain(call, "application/json", &bytes).await?;
            let result = RCheckpointResult {
                reference: manifest.reference.clone(),
                manifest: retained.clone(),
                native_session_id: manifest.native_session_id.clone(),
                saved_count: manifest
                    .report
                    .saved_names
                    .len()
                    .try_into()
                    .map_err(display)?,
                skipped_count: manifest.report.skipped.len().try_into().map_err(display)?,
                coverage: manifest.report.coverage.clone(),
            };
            Ok(plan(
                PluginOutcome::Succeeded,
                json!(result),
                vec![retained],
            ))
        };
        publish.await.map_err(|error:String| NativeError::after_possible_effect(error, Some(json!({"operation_id":call.operation_id,"data_root":self.environment.data_root,"action":"reconcile_original_capture","automatic_reexecution":false}))))
    }

    pub(super) async fn execute_recovery(
        &self,
        call: &PluginCall,
        cancellation: watch::Receiver<bool>,
    ) -> Result<PluginCommitPlan, NativeError> {
        self.admit_recovery(call).map_err(before)?;
        let operation = OperationId::new(
            call.operation_id
                .as_deref()
                .ok_or_else(|| before("Original recovery operation required"))?,
        )
        .map_err(before)?;
        if *cancellation.borrow() {
            return Err(cancelled_before_start());
        }
        let qualification: Qualification = decode(call.owner_context.clone()).map_err(before)?;
        let id = call.binding.capability.id.as_str();
        if id == CAPTURE {
            let runtime = self.runtime().map_err(before)?;
            let args: CheckpointCaptureArguments =
                decode(call.arguments.clone()).map_err(before)?;
            let archive = RecoveryArchive::create(
                Path::new(&qualification.storage.data_root),
                qualification.storage.scope.clone(),
            )
            .map_err(before)?;
            let lease = runtime
                .capture_recovery(&archive, &operation, &args, cancellation)
                .await?;
            self.hold_recovery(call, &operation, vec![lease.clone()], None);
            let capture = lease
                .capture()
                .map_err(|e| NativeError::after_possible_effect(e, None))?;
            let mut libraries = RCheckpointLibraries {
                library_paths: capture.artifact.report.library_paths.clone(),
                namespace_paths: vec![],
                complete: false,
            };
            if let Ok(observation) = runtime
                .query(&WorkspaceQuery::Snapshot(SnapshotArguments {
                    limit: 1,
                    expected_session: Some(runtime.session_id().into()),
                }))
                .await
            {
                if observation.session_id == runtime.session_id() {
                    if let Ok(snapshot) = decode::<WorkspaceSnapshotData>(observation.data) {
                        if snapshot.library_paths == libraries.library_paths
                            && snapshot.library_usage_complete
                            && snapshot.namespace_paths.len() <= 512
                        {
                            libraries.namespace_paths = snapshot.namespace_paths;
                            libraries.complete = true;
                        }
                    }
                }
            }
            let manifest = RCheckpointManifest {
                reference: reference(lease.scope(), &capture)
                    .map_err(|e| NativeError::after_possible_effect(e, None))?,
                native_session_id: capture.native_session_id,
                report: capture.artifact.report,
                environment: qualification.environment,
                libraries,
                source: None,
            };
            return self.publish_checkpoint(call, &manifest, &lease).await;
        }
        let admitted = qualification
            .source
            .ok_or_else(|| before("Original recovery source is missing"))?;
        let source = self
            .checkpoint_source(call, &admitted.reference.operation_id, id == RECONCILE)
            .await
            .map_err(before)?;
        if json!(source) != json!(admitted) {
            return Err(before("Original recovery source changed after admission"));
        }
        let lease = Arc::new(
            source
                .storage
                .open()
                .and_then(|archive| archive.acquire(&source.reference.operation_id))
                .map_err(before)?,
        );
        let manifest = self
            .checkpoint_manifest(call, &source, &lease)
            .await
            .map_err(before)?;
        if id != RECONCILE {
            let state = self
                .checkpoint_controls(call, &source, &lease)
                .await
                .map_err(before)?;
            check_action(id, &call.arguments, &state).map_err(before)?;
        }
        if *cancellation.borrow() {
            return Err(cancelled_before_start());
        }
        self.hold_recovery(call, &operation, vec![lease.clone()], None);
        match id {
            RESTORE => {
                let runtime = self.runtime().map_err(before)?;
                *self.inspection_cache_key.lock().unwrap() = format!("{operation}:running");
                let result = runtime
                    .restore_recovery(&operation, lease, cancellation)
                    .await;
                *self.inspection_cache_key.lock().unwrap() = format!("{operation}:returned");
                let restored = result?;
                let bytes = serde_json::to_vec(&restored)
                    .map_err(|e| NativeError::after_possible_effect(e.to_string(), None))?;
                let report = self
                    .retain(call, "application/json", &bytes)
                    .await
                    .map_err(|e| NativeError::after_possible_effect(e, None))?;
                Ok(plan(
                    PluginOutcome::Succeeded,
                    json!(RCheckpointRestored {
                        operation_id: operation,
                        session_id: runtime.session_id().into(),
                        reference: source.reference,
                        report: report.clone(),
                        restored_count: restored
                            .restored_names
                            .len()
                            .try_into()
                            .map_err(|e| NativeError::after_possible_effect(display(e), None))?,
                        initialized_namespace_count: restored
                            .initialized_namespaces
                            .len()
                            .try_into()
                            .map_err(|e| NativeError::after_possible_effect(display(e), None))?
                    }),
                    vec![report],
                ))
            }
            RECONCILE => {
                let archive = RecoveryArchive::create(
                    Path::new(&qualification.storage.data_root),
                    qualification.storage.scope,
                )
                .map_err(before)?;
                let old = lease.clone();
                let new_id = operation.clone();
                let adopted = Arc::new(
                    tokio::task::spawn_blocking(move || archive.adopt(&new_id, &old))
                        .await
                        .map_err(|e| NativeError::after_possible_effect(e.to_string(), None))?
                        .map_err(|e| NativeError::after_possible_effect(e, None))?,
                );
                self.hold_recovery(call, &operation, vec![lease, adopted.clone()], None);
                let capture = adopted
                    .capture()
                    .map_err(|e| NativeError::after_possible_effect(e, None))?;
                let manifest = RCheckpointManifest {
                    reference: reference(adopted.scope(), &capture)
                        .map_err(|e| NativeError::after_possible_effect(e, None))?,
                    source: Some(source.reference),
                    ..manifest
                };
                self.publish_checkpoint(call, &manifest, &adopted).await
            }
            PIN | DELETE => {
                let pinned = id == PIN && call.arguments["pinned"] == true;
                lease
                    .record_control(
                        &operation,
                        if id == PIN {
                            RecoveryControl::Pin { pinned }
                        } else {
                            RecoveryControl::Delete
                        },
                    )
                    .map_err(|e| NativeError::after_possible_effect(e, None))?;
                if id == DELETE {
                    self.hold_recovery(call, &operation, vec![lease], Some(operation.clone()));
                }
                Ok(plan(
                    PluginOutcome::Succeeded,
                    json!(RCheckpointControlResult {
                        operation_id: operation,
                        reference: source.reference,
                        pinned,
                        deleted: id == DELETE
                    }),
                    vec![],
                ))
            }
            PURGE => {
                let deletion: OperationId =
                    decode(call.arguments["deletion_operation_id"].clone()).map_err(before)?;
                lease
                    .remove_payload_after_commit(&deletion)
                    .map_err(|e| NativeError::after_possible_effect(e, None))?;
                Ok(plan(
                    PluginOutcome::Succeeded,
                    json!(RCheckpointPurged {
                        operation_id: operation,
                        reference: source.reference,
                        payload_removed: true
                    }),
                    vec![],
                ))
            }
            _ => Err(before("Unsupported recovery operation")),
        }
    }
}

fn cancelled_before_start() -> NativeError {
    let mut error = before("Recovery cancelled before native work");
    error.query_code = Some("checkpoint_cancelled".into());
    error
}

fn check_action(id: &str, arguments: &Value, state: &ControlState) -> Result<(), String> {
    if id == PURGE {
        if !state.deleted || json!(state.head) != arguments["deletion_operation_id"] {
            return Err("Cleanup requires the exact latest committed deletion".into());
        }
    } else {
        if state.deleted {
            return Err("This recovery copy was logically deleted".into());
        }
        if matches!(id, PIN | DELETE) && json!(state.head) != arguments["expected_control"] {
            return Err("Recovery control precondition changed".into());
        }
        if id == DELETE && state.pinned {
            return Err("Unpin this recovery copy before deletion".into());
        }
    }
    Ok(())
}

fn apply_control(
    state: &mut ControlState,
    reference: &RCheckpointReference,
    operation: &OperationId,
    expected: Option<OperationId>,
    action: RecoveryControl,
    output: RCheckpointControlResult,
) -> Result<(), String> {
    if state.deleted
        || state.head != expected
        || output.operation_id != *operation
        || output.reference != *reference
    {
        return Err(
            "Committed recovery controls do not form the original precondition chain".into(),
        );
    }
    match action {
        RecoveryControl::Pin { pinned } => state.pinned = pinned,
        RecoveryControl::Delete if !state.pinned => state.deleted = true,
        _ => return Err("A pinned recovery copy has an invalid deletion".into()),
    }
    if output.pinned != state.pinned || output.deleted != state.deleted {
        return Err("Committed recovery result differs from its original native control".into());
    }
    state.head = Some(operation.clone());
    Ok(())
}

impl Owner {
    fn recovery_storage(&self, call: &PluginCall) -> Storage {
        Storage {
            data_root: self.environment.data_root.clone(),
            scope: RecoveryScope {
                project: call.binding.project.clone(),
                project_root: self.environment.project_root.clone().into(),
                principal: call.principal.clone(),
                provider: self.instance.clone(),
            },
        }
    }

    async fn recovery_read(
        &self,
        call: &PluginCall,
        id: &str,
        arguments: Value,
    ) -> Result<Value, String> {
        let observation = self
            .host
            .call(
                call.request.clone(),
                None,
                key(id),
                arguments,
                Duration::from_secs(30),
            )
            .await?;
        if observation["status"] != "ready"
            || !(observation["completeness"] == "complete"
                || id == "operation.list_recent" && observation["completeness"] == "partial")
        {
            return Err("Original recovery observation is unavailable or incomplete".into());
        }
        observation
            .get("data")
            .cloned()
            .ok_or_else(|| "Original recovery observation has no data".into())
    }

    async fn recovery_record(
        &self,
        call: &PluginCall,
        operation: &OperationId,
    ) -> Result<Value, String> {
        let data = self
            .recovery_read(call, "operation.get", json!({"operation_id":operation}))
            .await?;
        let record = data
            .get("record")
            .filter(|value| value.is_object())
            .ok_or("Original recovery record is unavailable")?;
        if record["operation"]["operation_id"] != operation.as_str()
            || record["operation"]["idempotency_scope"] != self.environment.project_root
        {
            return Err("Original recovery operation changed identity or project".into());
        }
        Ok(record.clone())
    }

    async fn recovery_manifest_bytes(
        &self,
        call: &PluginCall,
        reference: &ResourceReference,
    ) -> Result<Vec<u8>, String> {
        if reference.bytes == 0
            || reference.bytes > MAX_MANIFEST
            || reference.media_type != "application/json"
        {
            return Err("Original recovery manifest has unsupported resource bounds".into());
        }
        let read = async {
            let mut bytes = Vec::with_capacity(reference.bytes as usize);
            while (bytes.len() as u64) < reference.bytes {
                let offset = bytes.len() as u64;
                let chunk: ResourceChunk = decode(
                    self.recovery_read(
                        call,
                        "resources.read",
                        json!(ResourceRead {
                            reference: reference.clone(),
                            offset,
                            limit: MAX_RESOURCE_READ_BYTES
                        }),
                    )
                    .await?,
                )?;
                let expected = (reference.bytes - offset).min(u64::from(MAX_RESOURCE_READ_BYTES));
                let end = offset + expected;
                let content = base64::engine::general_purpose::STANDARD
                    .decode(&chunk.base64)
                    .map_err(display)?;
                if chunk.reference != *reference
                    || chunk.offset != offset
                    || content.len() as u64 != expected
                    || chunk.next != (end < reference.bytes).then_some(end)
                {
                    return Err(
                        "Recovery manifest chunk changed identity, position or length".into(),
                    );
                }
                bytes.extend(content);
            }
            if format!("sha256:{:x}", Sha256::digest(&bytes)) != reference.digest.as_str() {
                return Err("Original recovery manifest digest differs".into());
            }
            Ok(bytes)
        };
        tokio::time::timeout(Duration::from_secs(30), read)
            .await
            .map_err(|_| "Recovery manifest read exceeded its bounded deadline")?
    }

    fn original_qualification(
        &self,
        call: &PluginCall,
        record: &Value,
    ) -> Result<(ProviderBinding, Qualification), String> {
        let operation = &record["operation"];
        let binding: ProviderBinding =
            decode(operation["normalized_arguments"]["binding"].clone())?;
        let admission = &operation["admission"]["owner_context"];
        if binding.project != call.binding.project
            || binding.capability.version != 1
            || operation["capability"] != json!(binding.capability)
            || admission["binding"] != json!(binding)
            || operation["idempotency_scope"] != self.environment.project_root
        {
            return Err("Original recovery record lacks its exact admitted binding".into());
        }
        let qualification: Qualification = decode(admission["qualification"].clone())?;
        qualification
            .storage
            .validate(call, &self.environment.project_root, &binding.provider)?;
        if binding.target.as_deref() != Some(&qualification.session_target) {
            return Err("Original recovery operation changed its native target".into());
        }
        let normalized = normalize(
            binding.capability.id.as_str(),
            operation["normalized_arguments"]["arguments"].clone(),
        )?;
        if arguments_digest(&normalized)? != qualification.arguments_digest
            || matches!(binding.capability.id.as_str(), CAPTURE | RESTORE)
                && normalized["expected_session"] != qualification.session_target
        {
            return Err("Original recovery operation differs from its frozen arguments".into());
        }
        Ok((binding, qualification))
    }

    async fn checkpoint_source(
        &self,
        call: &PluginCall,
        operation: &OperationId,
        reconcile: bool,
    ) -> Result<Source, String> {
        let record = self.recovery_record(call, operation).await?;
        let (binding, qualification) = self.original_qualification(call, &record)?;
        if !matches!(binding.capability.id.as_str(), CAPTURE | RECONCILE)
            || if reconcile {
                !matches!(
                    record["status"].as_str(),
                    Some("failed" | "cancelled" | "uncertain")
                )
            } else {
                record["status"] != "succeeded"
            }
        {
            return Err(
                "Original capture has no suitable terminal outcome for this recovery action".into(),
            );
        }
        let is_capture = binding.capability.id.as_str() == CAPTURE;
        if is_capture != qualification.source.is_none() {
            return Err("Original recovery admission changed its source chain".into());
        }
        let original_source = qualification
            .source
            .as_ref()
            .map(|source| source.reference.clone());
        let (reference, native_session_id, result) = if reconcile {
            let lease = qualification.storage.open()?.acquire(operation)?;
            let capture = lease.capture()?;
            let reference = reference(&qualification.storage.scope, &capture)?;
            (reference, capture.native_session_id, None)
        } else {
            let result: RCheckpointResult = decode(record["output"].clone())?;
            validate_result(&result, &binding, operation)?;
            (
                result.reference.clone(),
                result.native_session_id.clone(),
                Some(result),
            )
        };
        if reference.project != call.binding.project
            || reference.provider != binding.provider
            || reference.operation_id != *operation
            || if is_capture {
                native_session_id != qualification.session_target
            } else {
                qualification
                    .source
                    .as_ref()
                    .is_none_or(|source| source.native_session_id != native_session_id)
            }
        {
            return Err("Original recovery evidence changed its native origin".into());
        }
        reference.validate()?;
        Ok(Source {
            binding,
            storage: qualification.storage,
            reference,
            native_session_id,
            environment: if is_capture {
                qualification.environment
            } else {
                qualification.source.and_then(|source| source.environment)
            },
            original_source,
            result,
            status: record["status"].as_str().unwrap().into(),
        })
    }

    async fn checkpoint_manifest(
        &self,
        call: &PluginCall,
        source: &Source,
        lease: &RecoveryLease,
    ) -> Result<RCheckpointManifest, String> {
        let manifest: RCheckpointManifest = if let Some(result) = &source.result {
            serde_json::from_slice(&self.recovery_manifest_bytes(call, &result.manifest).await?)
                .map_err(display)?
        } else if let Some(context) = lease.read_context::<RCheckpointManifest>()? {
            context
        } else {
            // Lost publication must not invent later namespace or library usage.
            let capture = lease.capture()?;
            RCheckpointManifest {
                reference: source.reference.clone(),
                native_session_id: capture.native_session_id,
                libraries: RCheckpointLibraries {
                    library_paths: capture.artifact.report.library_paths.clone(),
                    namespace_paths: vec![],
                    complete: false,
                },
                report: capture.artifact.report,
                environment: source.environment.clone(),
                source: source.original_source.clone(),
            }
        };
        validate_manifest(source, lease, &manifest)?;
        Ok(manifest)
    }
}

fn reference(
    scope: &RecoveryScope,
    capture: &RecoveryCapture,
) -> Result<RCheckpointReference, String> {
    let reference = RCheckpointReference {
        project: scope.project.clone(),
        provider: scope.provider.clone(),
        operation_id: capture.operation_id.clone(),
        digest: ContentDigest::new(&capture.artifact.sha256).map_err(display)?,
        bytes: capture.artifact.byte_size,
    };
    reference.validate()?;
    Ok(reference)
}

fn validate_result(
    result: &RCheckpointResult,
    binding: &ProviderBinding,
    operation: &OperationId,
) -> Result<(), String> {
    result.reference.validate()?;
    if result.reference.operation_id != *operation
        || result.reference.provider != binding.provider
        || result.reference.project != binding.project
        || result.manifest.owner != binding.provider
        || result.manifest.media_type != "application/json"
        || result.manifest.bytes == 0
        || result.manifest.bytes > MAX_MANIFEST
        || result.native_session_id.is_empty()
        || result.native_session_id.len() > 160
    {
        return Err(
            "Recovery result differs from its original operation, provider or resource bounds"
                .into(),
        );
    }
    Ok(())
}

fn validate_manifest(
    source: &Source,
    lease: &RecoveryLease,
    manifest: &RCheckpointManifest,
) -> Result<(), String> {
    let capture = lease.capture()?;
    let native_source = capture
        .source
        .as_ref()
        .map(|original| (&original.scope, &original.operation_id));
    let source_matches = match (&source.original_source, native_source) {
        (None, None) => true,
        (Some(expected), Some((scope, operation))) => {
            scope.project == expected.project
                && scope.provider == expected.provider
                && scope.principal == source.storage.scope.principal
                && scope.project_root == source.storage.scope.project_root
                && operation == &expected.operation_id
        }
        _ => false,
    };
    if !source_matches
        || manifest.reference != source.reference
        || manifest.native_session_id != source.native_session_id
        || manifest.source != source.original_source
        || json!(manifest.environment) != json!(source.environment)
        || reference(lease.scope(), &capture)? != source.reference
        || capture.native_session_id != source.native_session_id
        || capture.artifact.report != manifest.report
        || manifest.libraries.library_paths != manifest.report.library_paths
        || manifest.libraries.library_paths.len() > 128
        || manifest.libraries.namespace_paths.len() > 512
        || manifest
            .libraries
            .library_paths
            .iter()
            .chain(&manifest.libraries.namespace_paths)
            .any(|path| path.len() > 4096 || !Path::new(path).is_absolute() || path.contains('\0'))
    {
        return Err("Recovery manifest differs from the original native capture, environment or bounded library references".into());
    }
    if let Some(result) = &source.result {
        if result.saved_count as usize != manifest.report.saved_names.len()
            || result.skipped_count as usize != manifest.report.skipped.len()
            || result.coverage != manifest.report.coverage
        {
            return Err("Recovery summary differs from its complete retained manifest".into());
        }
    }
    Ok(())
}

fn normalize(id: &str, value: Value) -> Result<Value, String> {
    Ok(match id {
        CAPTURE => {
            let args: CheckpointCaptureArguments = decode(value)?;
            args.validate()?;
            json!(args)
        }
        RESTORE => {
            let args: RestoreRCheckpoint = decode(value)?;
            args.reference.validate()?;
            if args.expected_session.is_empty()
                || args.expected_session.len() > 160
                || args.expected_session.contains('\0')
            {
                return Err("Restore requires an exact native session".into());
            }
            json!(args)
        }
        RECONCILE => json!(decode::<ReconcileRCheckpoint>(value)?),
        PIN => {
            let args: PinRCheckpoint = decode(value)?;
            args.reference.validate()?;
            json!(args)
        }
        DELETE => {
            let args: DeleteRCheckpoint = decode(value)?;
            args.reference.validate()?;
            json!(args)
        }
        PURGE => {
            let args: PurgeRCheckpoint = decode(value)?;
            args.reference.validate()?;
            json!(args)
        }
        _ => return Err("Unsupported recovery operation".into()),
    })
}

fn arguments_digest(normalized: &Value) -> Result<ContentDigest, String> {
    let bytes = serde_json::to_vec(normalized).map_err(display)?;
    ContentDigest::new(format!("sha256:{:x}", Sha256::digest(bytes))).map_err(display)
}

#[cfg(test)]
mod tests;
