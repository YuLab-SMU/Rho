//! Unpublished capture material is qualified by its original Core admission.
//! Disposal requires confirmed source-provider release and a native preview;
//! neither missing bytes nor a failed disposal establishes a committed result.
use super::*;

pub(super) const ATTEMPT: &str = "r.capture_attempt";
pub(super) const DISCARD: &str = "r.discard_capture";
pub(super) const PREPARE_DISCARD: &str = "r.prepare_capture_disposal";

#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct AttemptSource {
    reference: RCaptureAttemptReference,
    capability: CapabilityKey,
    storage: Storage,
    status: PluginOutcome,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct DisposalQualification {
    session_target: String,
    arguments_digest: ContentDigest,
    storage: Storage,
    source: AttemptSource,
    material: RCaptureMaterial,
}
fn empty(material: &RCaptureMaterial) -> bool {
    material.payload_bytes.is_none() && material.staging_bytes.is_none()
}
impl Owner {
    fn attempt_grants(&self, call: &PluginCall) -> Result<(), String> {
        self.recovery_grants.check(call, false)?;
        if !self.recovery_grants.instance
            || !self.recovery_grants.coverage
            || !call.scopes.contains("plugins.read")
            || !call.scopes.contains("project.references.read")
        {
            return Err("Capture disposal needs explicit original-instance and project-coverage read grants".into());
        }
        Ok(())
    }
    async fn attempt_source(
        &self,
        call: &PluginCall,
        operation: &OperationId,
    ) -> Result<AttemptSource, String> {
        self.attempt_grants(call)?;
        let record = self.recovery_record(call, operation).await?;
        let (binding, qualification) = self.original_qualification(call, &record)?;
        let status: PluginOutcome = decode(record["status"].clone())?;
        if binding.capability.version != 1
            || !matches!(binding.capability.id.as_str(), CAPTURE | RECONCILE)
            || status == PluginOutcome::Succeeded
        {
            return Err("Dispose only a terminal unsuccessful capture or reconciliation; published copies use their normal deletion controls".into());
        }
        if (binding.capability.id.as_str() == CAPTURE) != qualification.source.is_none() {
            return Err("Original capture changed its admitted source chain".into());
        }
        Ok(AttemptSource {
            reference: RCaptureAttemptReference {
                project: binding.project,
                provider: binding.provider,
                operation_id: operation.clone(),
            },
            capability: binding.capability,
            storage: qualification.storage,
            status,
        })
    }
    async fn capture_owner_released(
        &self,
        call: &PluginCall,
        source: &AttemptSource,
    ) -> Result<bool, String> {
        let observed: PluginInstanceObservation = decode(
            self.recovery_read(
                call,
                "plugins.instance",
                json!({"instance":source.reference.provider}),
            )
            .await?,
        )?;
        if observed.instance.identity != source.reference.provider
            || observed.instance.project != call.binding.project
            || observed.instance.principal != call.principal
        {
            return Err("Capture owner observation changed its original identity or scope".into());
        }
        Ok(observed.instance.state == InstanceState::Released)
    }
    fn qualify_disposal(
        &self,
        call: &PluginCall,
        record: &Value,
    ) -> Result<DisposalQualification, String> {
        let operation = &record["operation"];
        let binding: ProviderBinding =
            decode(operation["normalized_arguments"]["binding"].clone())?;
        let admitted = &operation["admission"]["owner_context"];
        let qualification: DisposalQualification = decode(admitted["qualification"].clone())?;
        let args: DiscardRCapture = decode(operation["normalized_arguments"]["arguments"].clone())?;
        if binding.capability != key(DISCARD)
            || binding.project != call.binding.project
            || operation["capability"] != json!(binding.capability)
            || admitted["binding"] != json!(binding)
            || operation["idempotency_scope"] != self.environment.project_root
            || binding.target.as_deref() != Some(&qualification.session_target)
            || qualification.arguments_digest != arguments_digest(&json!(args))?
            || qualification.source.reference.operation_id != args.source_operation_id
            || qualification.material.fingerprint != args.expected_fingerprint
        {
            return Err("Disposal record differs from its exact original admission".into());
        }
        qualification
            .storage
            .validate(call, &self.environment.project_root, &binding.provider)?;
        qualification.source.storage.validate(
            call,
            &self.environment.project_root,
            &qualification.source.reference.provider,
        )?;
        Ok(qualification)
    }
    async fn discarded_capture(
        &self,
        call: &PluginCall,
        source: &AttemptSource,
        material: &RCaptureMaterial,
    ) -> Result<Option<OperationId>, String> {
        tokio::time::timeout(
            Duration::from_secs(30),
            self.capture_disposal_history(call, source, material),
        )
        .await
        .map_err(|_| "Capture disposal history exceeded its bounded deadline")?
    }
    async fn capture_disposal_history(
        &self,
        call: &PluginCall,
        source: &AttemptSource,
        material: &RCaptureMaterial,
    ) -> Result<Option<OperationId>, String> {
        let coverage: ProjectReadCoverage = decode(
            self.recovery_read(call, "operation.project_coverage", json!({}))
                .await?,
        )?;
        if !coverage.all_visible {
            return Err("Some capture disposal history is outside this caller's visibility".into());
        }
        let mut cursor = None;
        let mut discarded = None;
        for _ in 0..PAGES {
            let page = self.recovery_page(call, cursor, PAGE).await?;
            for item in page.operations {
                if item.operation_id == source.reference.operation_id {
                    if item.capability != source.capability
                        || decode::<PluginOutcome>(json!(item.status))? != source.status
                    {
                        return Err("Original capture changed during disposal observation".into());
                    }
                    return Ok(discarded);
                }
                if item.capability.id.as_str() != DISCARD
                    || call.operation_id.as_deref() == Some(item.operation_id.as_str())
                {
                    continue;
                }
                if item.capability.version != 1 {
                    return Err("Capture disposal history has an unsupported version".into());
                }
                let record = self.recovery_record(call, &item.operation_id).await?;
                if record["operation"]["normalized_arguments"]["arguments"]["source_operation_id"]
                    != json!(source.reference.operation_id)
                {
                    continue;
                }
                let qualified = self.qualify_disposal(call, &record)?;
                if json!(qualified.source) != json!(source) || record["status"] != item.status {
                    return Err("Capture disposal changed its original source or outcome".into());
                }
                let status: PluginOutcome = decode(record["status"].clone())
                    .map_err(|_| "Capture disposal is pending; wait for its original outcome")?;
                if status == PluginOutcome::Succeeded {
                    let output: RCaptureDiscarded = decode(record["output"].clone())?;
                    if output.operation_id != item.operation_id
                        || output.reference != source.reference
                        || output.before != qualified.material
                        || !empty(&output.after)
                    {
                        return Err("Committed disposal differs from its original preview or absence result".into());
                    }
                    if discarded.is_none() && empty(material) && output.after == *material {
                        discarded = Some(item.operation_id);
                    }
                }
            }
            cursor = page.next_cursor;
            if cursor.is_none() {
                break;
            }
        }
        Err(
            "Capture disposal history did not reach its original operation within the bounded scan"
                .into(),
        )
    }
    pub(super) async fn query_capture_attempt(&self, call: &PluginCall) -> Result<Value, String> {
        let args: RCaptureAttemptArguments = decode(call.arguments.clone())?;
        let source = self.attempt_source(call, &args.source_operation_id).await?;
        let owner_released = self.capture_owner_released(call, &source).await?;
        let native = RecoveryArchive::inspect_attempt(
            Path::new(&source.storage.data_root),
            source.storage.scope.clone(),
            &args.source_operation_id,
        )?;
        let discarded_by = self
            .discarded_capture(call, &source, &native.material)
            .await?;
        Ok(json!(RCaptureAttemptObservation {
            reference: source.reference,
            original_status: source.status,
            material: native.material,
            owner_released,
            can_discard: owner_released && discarded_by.is_none(),
            discarded_by,
            notices: if owner_released {
                vec![]
            } else {
                vec!["The original provider must be confirmed released before capture material can be discarded".into()]
            },
        }))
    }
    pub(super) async fn prepare_capture_disposal(
        &self,
        call: &PluginCall,
    ) -> Result<Value, String> {
        self.attempt_grants(call)?;
        let request: PluginPreflightRequest = decode(call.arguments.clone())?;
        let target = self.target();
        if request.capability != key(DISCARD)
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
            return Err(
                "Capture disposal preflight changed its capability, target or preconditions".into(),
            );
        }
        let args: DiscardRCapture = decode(request.arguments)?;
        let source = self.attempt_source(call, &args.source_operation_id).await?;
        if !self.capture_owner_released(call, &source).await? {
            return Err("Confirm release of the original capture provider before disposal".into());
        }
        let native = RecoveryArchive::inspect_attempt(
            Path::new(&source.storage.data_root),
            source.storage.scope.clone(),
            &args.source_operation_id,
        )?;
        if native.material.fingerprint != args.expected_fingerprint {
            return Err("Capture material changed since its preview".into());
        }
        if self
            .discarded_capture(call, &source, &native.material)
            .await?
            .is_some()
        {
            return Err("This exact capture material already has a committed disposal".into());
        }
        if self.target() != target {
            return Err("Capture disposal target changed during preflight".into());
        }
        let arguments = json!(args);
        Ok(json!(PluginPreflightResult {
            arguments: arguments.clone(),
            target: Some(target.clone()),
            owner_context: json!(DisposalQualification {
                session_target: target,
                arguments_digest: arguments_digest(&arguments)?,
                storage: self.recovery_storage(call),
                source,
                material: native.material,
            })
        }))
    }
    pub(super) fn admit_capture_disposal(&self, call: &PluginCall) -> Result<(), String> {
        self.attempt_grants(call)?;
        let args: DiscardRCapture = decode(call.arguments.clone())?;
        let qualified: DisposalQualification = decode(call.owner_context.clone())?;
        if call.binding.capability != key(DISCARD)
            || qualified.session_target != self.target()
            || call.binding.target.as_deref() != Some(&qualified.session_target)
            || qualified.arguments_digest != arguments_digest(&json!(args))?
            || qualified.source.reference.operation_id != args.source_operation_id
            || qualified.source.reference.project != call.binding.project
            || qualified.material.fingerprint != args.expected_fingerprint
            || json!(qualified.storage) != json!(self.recovery_storage(call))
        {
            return Err(
                "Capture disposal changed its admitted identity, material or target".into(),
            );
        }
        qualified.source.storage.validate(
            call,
            &self.environment.project_root,
            &qualified.source.reference.provider,
        )
    }
    pub(super) async fn execute_capture_disposal(
        &self,
        call: &PluginCall,
        cancellation: watch::Receiver<bool>,
    ) -> Result<PluginCommitPlan, NativeError> {
        self.admit_capture_disposal(call).map_err(before)?;
        let operation = OperationId::new(
            call.operation_id
                .as_deref()
                .ok_or_else(|| before("Original disposal operation required"))?,
        )
        .map_err(before)?;
        let args: DiscardRCapture = decode(call.arguments.clone()).map_err(before)?;
        let qualified: DisposalQualification =
            decode(call.owner_context.clone()).map_err(before)?;
        let source = self
            .attempt_source(call, &args.source_operation_id)
            .await
            .map_err(before)?;
        if json!(source) != json!(qualified.source)
            || !self
                .capture_owner_released(call, &source)
                .await
                .map_err(before)?
        {
            return Err(before(
                "Capture disposal source or confirmed provider release changed",
            ));
        }
        let native = RecoveryArchive::inspect_attempt(
            Path::new(&source.storage.data_root),
            source.storage.scope.clone(),
            &args.source_operation_id,
        )
        .map_err(before)?;
        if native.material != qualified.material {
            return Err(before(
                "Capture material changed since its admitted preview",
            ));
        }
        if self
            .discarded_capture(call, &source, &native.material)
            .await
            .map_err(before)?
            .is_some()
        {
            return Err(before("Capture material already has a committed disposal"));
        }
        if *cancellation.borrow() {
            return Err(cancelled_before_start());
        }
        let after = if let Some(lease) = native.lease {
            self.hold_recovery(call, &operation, vec![lease.clone()], None);
            lease.discard_capture_payloads(&args.expected_fingerprint).map_err(|error| NativeError::after_possible_effect(error, Some(json!({"source_operation_id":args.source_operation_id,"action":"inspect_capture_attempt","automatic_reexecution":false}))))?
        } else {
            native.material.clone()
        };
        if !empty(&after) {
            return Err(NativeError::after_possible_effect(
                "Capture material removal is incomplete",
                None,
            ));
        }
        Ok(plan(
            PluginOutcome::Succeeded,
            json!(RCaptureDiscarded {
                operation_id: operation,
                reference: source.reference,
                before: native.material,
                after
            }),
            vec![],
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::sync::mpsc;

    fn source_record(owner: &Owner, call: &PluginCall, status: PluginOutcome) -> Value {
        let args = normalize(CAPTURE, json!({"expected_session":"original-native"})).unwrap();
        let mut binding = call.binding.clone();
        binding.capability = key(CAPTURE);
        binding.target = Some("original-native".into());
        json!({"status":status,"output":null,"operation":{"operation_id":"capture","capability":binding.capability,
        "idempotency_scope":owner.environment.project_root,"normalized_arguments":{"binding":binding,"arguments":args},
        "admission":{"owner_context":{"binding":binding,"qualification":Qualification {
            session_target:"original-native".into(),arguments_digest:arguments_digest(&args).unwrap(),storage:owner.recovery_storage(call),environment:None,source:None,
        }}}}})
    }
    fn serve(
        mut requests: mpsc::Receiver<crate::host_calls::HostRequest>,
        original: Value,
        call: PluginCall,
        state: InstanceState,
        disposal: Option<Value>,
    ) -> tokio::task::JoinHandle<()> {
        tokio::spawn(async move {
            while let Some(request) = requests.recv().await {
                let data = match request.capability.id.as_str() {
                    "operation.get" => {
                        json!({"record":if request.arguments["operation_id"] == "capture" {original.clone()} else {disposal.clone().unwrap()}})
                    }
                    "plugins.instance" => json!(PluginInstanceObservation {
                        instance: PluginInstance {
                            purpose: rho_plugin_sdk::protocol::PluginInstancePurpose::Runtime,
                            identity: call.binding.provider.clone(),
                            project: call.binding.project.clone(),
                            principal: call.principal.clone(),
                            alias: InstanceAlias::new("original").unwrap(),
                            configuration: json!({}),
                            state,
                            suspension: None,
                            diagnostic: None
                        },
                        observed_in_this_host: false,
                        process_id: None,
                        retained_calls: None,
                        pending_messages: None,
                        stderr: None,
                    }),
                    "operation.project_coverage" => json!({"all_visible":true}),
                    "operation.list_recent" => {
                        let mut operations = vec![];
                        if let Some(record) = &disposal {
                            operations.push(json!({"cursor":2,"operation_id":"discard","capability":key(DISCARD),"status":record["status"]}));
                        }
                        operations.push(json!({"cursor":1,"operation_id":"capture","capability":key(CAPTURE),"status":original["status"]}));
                        json!({"operations":operations,"next_cursor":null})
                    }
                    other => panic!("Unexpected disposal read {other}"),
                };
                let _ = request.reply.send(Ok(
                    json!({"status":"ready","completeness":"complete","data":data}),
                ));
            }
        })
    }

    #[tokio::test]
    async fn unsuccessful_capture_observation_requires_its_original_scope_and_confirmed_release() {
        for (state, status, expected) in [
            (InstanceState::Active, PluginOutcome::Uncertain, false),
            (InstanceState::Failed, PluginOutcome::Failed, false),
            (
                InstanceState::CleanupFailed,
                PluginOutcome::Cancelled,
                false,
            ),
            (InstanceState::Disconnected, PluginOutcome::Uncertain, false),
            (InstanceState::Released, PluginOutcome::Uncertain, true),
        ] {
            let (directory, owner, mut call, requests) = super::super::tests::fixture();
            call.binding.capability = key(ATTEMPT);
            call.arguments = json!({"source_operation_id":"capture"});
            let source = source_record(&owner, &call, status);
            let responder = serve(requests, source, call.clone(), state, None);
            let observed: RCaptureAttemptObservation =
                decode(owner.query_recovery(&call).await.unwrap()).unwrap();
            assert_eq!(observed.owner_released, expected);
            assert_eq!(observed.can_discard, expected);
            assert_eq!(observed.original_status, status);
            assert!(observed.discarded_by.is_none());
            assert!(empty(&observed.material));
            assert!(!directory.path().join("r-recovery-v1").exists());
            assert_eq!(
                owner.target(),
                format!("unstarted:{}", call.binding.provider.instance)
            );
            responder.abort();
        }
    }

    #[tokio::test]
    async fn missing_bytes_and_lost_disposal_acknowledgement_need_an_explicit_committed_result() {
        for status in [
            PluginOutcome::Uncertain,
            PluginOutcome::Failed,
            PluginOutcome::Succeeded,
        ] {
            let (directory, owner, mut call, requests) = super::super::tests::fixture();
            let source = source_record(&owner, &call, PluginOutcome::Uncertain);
            let storage = owner.recovery_storage(&call);
            let material = RecoveryArchive::inspect_attempt(
                Path::new(&storage.data_root),
                storage.scope.clone(),
                &OperationId::new("capture").unwrap(),
            )
            .unwrap()
            .material;
            let args = DiscardRCapture {
                source_operation_id: OperationId::new("capture").unwrap(),
                expected_fingerprint: material.fingerprint.clone(),
            };
            let reference = RCaptureAttemptReference {
                project: call.binding.project.clone(),
                provider: call.binding.provider.clone(),
                operation_id: args.source_operation_id.clone(),
            };
            let mut binding = call.binding.clone();
            binding.capability = key(DISCARD);
            binding.target = Some(owner.target());
            let disposed = json!({"status":status,"output":RCaptureDiscarded {operation_id:OperationId::new("discard").unwrap(),reference:reference.clone(),before:material.clone(),after:material.clone()},
            "operation":{"operation_id":"discard","capability":binding.capability,"idempotency_scope":owner.environment.project_root,
            "normalized_arguments":{"binding":binding,"arguments":args},"admission":{"owner_context":{"binding":binding,"qualification":DisposalQualification {
                session_target:owner.target(),arguments_digest:arguments_digest(&json!(args)).unwrap(),storage:storage.clone(),
                source:AttemptSource {reference,capability:key(CAPTURE),storage,status:PluginOutcome::Uncertain},material,
            }}}}});
            let responder = serve(
                requests,
                source,
                call.clone(),
                InstanceState::Released,
                Some(disposed),
            );
            call.binding.capability = key(ATTEMPT);
            call.arguments = json!({"source_operation_id":"capture"});
            let observed: RCaptureAttemptObservation =
                decode(owner.query_recovery(&call).await.unwrap()).unwrap();
            assert_eq!(
                observed.discarded_by.is_some(),
                status == PluginOutcome::Succeeded
            );
            assert_eq!(observed.can_discard, status != PluginOutcome::Succeeded);
            assert_eq!(observed.original_status, PluginOutcome::Uncertain);
            assert!(!directory.path().join("r-recovery-v1").exists());
            responder.abort();
        }
    }

    #[tokio::test]
    async fn disposal_cannot_target_a_published_capture() {
        let (_directory, owner, mut call, requests) = super::super::tests::fixture();
        let source = source_record(&owner, &call, PluginOutcome::Succeeded);
        let responder = serve(
            requests,
            source,
            call.clone(),
            InstanceState::Released,
            None,
        );
        call.binding.capability = key(ATTEMPT);
        call.arguments = json!({"source_operation_id":"capture"});
        assert!(
            owner
                .query_recovery(&call)
                .await
                .unwrap_err()
                .contains("published copies")
        );
        responder.abort();
    }
}
