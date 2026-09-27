//! Consume the R owner's public observations. Native archives and control
//! qualification remain private to R; Environment only protects published paths.
use super::*;
use rho_r_api::{
    DeleteRCheckpoint, PinRCheckpoint, PurgeRCheckpoint, RCheckpointControlObservation,
    RCheckpointControlResolution, RCheckpointControlResult, RCheckpointManifest,
    RCheckpointObservation, RCheckpointPurged, RCheckpointReference, RCheckpointRestored,
    RCheckpointResult, RExecutionNotStarted, ResolveRCheckpointControl, RestoreRCheckpoint,
};

pub(super) fn supports(capability: &CapabilityKey) -> bool {
    capability.version == 1
        && matches!(
            capability.id.as_str(),
            "r.capture_checkpoint"
                | "r.reconcile_checkpoint"
                | "r.restore_checkpoint"
                | "r.pin_checkpoint"
                | "r.delete_checkpoint"
                | "r.purge_checkpoint"
        )
        || capability.version == 2
            && matches!(
                capability.id.as_str(),
                "r.pin_checkpoint" | "r.delete_checkpoint"
            )
}

fn reader<'a>(
    configured: Option<&InstanceRef>,
    original: &InstanceRef,
    readers: &'a [InstanceRef],
) -> Result<&'a InstanceRef, String> {
    if let Some(configured) = configured {
        return readers
            .iter()
            .find(|candidate| *candidate == configured)
            .ok_or_else(|| {
                "The configured checkpoint reader is unavailable; material is retained".into()
            });
    }
    if let Some(original) = readers.iter().find(|candidate| *candidate == original) {
        return Ok(original);
    }
    match readers {
        [only] => Ok(only),
        [] => Err("No active R checkpoint reader is available; material is retained".into()),
        _ => Err(
            "Multiple R checkpoint readers are available; select checkpoint_reader explicitly"
                .into(),
        ),
    }
}

fn reference(reference: &RCheckpointReference, call: &PluginCall) -> Result<(), String> {
    reference.validate()?;
    if reference.project != call.binding.project {
        return Err("Checkpoint reference belongs to another project".into());
    }
    Ok(())
}

impl Owner {
    pub(super) async fn checkpoint_references(
        &self,
        call: &PluginCall,
        references: &mut References,
        readers: &[InstanceRef],
        id: &OperationId,
        capability: &CapabilityKey,
        status: &str,
    ) -> Result<(), String> {
        let control = matches!(
            capability.id.as_str(),
            "r.pin_checkpoint" | "r.delete_checkpoint"
        );
        if !matches!(status, "succeeded" | "failed" | "cancelled")
            && !(status == "uncertain" && control)
        {
            return Err(
                "Live or uncertain scientific work still needs its original recovery references"
                    .into(),
            );
        }
        let record = self
            .reference_query(call, "operation.get", json!({"operation_id":id}), false)
            .await?["record"]
            .clone();
        let operation = &record["operation"];
        let binding: ProviderBinding =
            serde_json::from_value(operation["normalized_arguments"]["binding"].clone())
                .map_err(error)?;
        if record["status"] != status
            || operation["operation_id"] != id.as_str()
            || operation["idempotency_scope"] != self.root
            || binding.project != call.binding.project
            || binding.capability != *capability
            || operation["capability"] != json!(capability)
            || operation["admission"]["owner_context"]["binding"] != json!(binding)
        {
            return Err("R recovery reference differs from its original admitted record".into());
        }
        let name = capability.id.as_str();
        if status == "uncertain" {
            let args = &operation["normalized_arguments"]["arguments"];
            let original: RCheckpointReference =
                serde_json::from_value(args["reference"].clone()).map_err(error)?;
            reference(&original, call)?;
            let source_operation = if capability.version == 2 {
                let args: ResolveRCheckpointControl =
                    serde_json::from_value(args.clone()).map_err(error)?;
                args.source_operation_id
            } else {
                id.clone()
            };
            let provider = reader(self.checkpoint_reader.as_ref(), &binding.provider, readers)?;
            let observation: RCheckpointControlObservation = serde_json::from_value(self.reference_query(
                call, "r.checkpoint_control", json!({"binding":ProviderBinding {
                    capability:CapabilityKey {id:ContributionId::new("r.checkpoint_control").unwrap(),version:1},
                    provider:provider.clone(),project:call.binding.project.clone(),target:None,
                },"arguments":{"reference":original,"operation_id":id}}), false,
            ).await?).map_err(error)?;
            if observation.operation_id != *id
                || observation.reference != original
                || observation.status != PluginOutcome::Uncertain
                || observation.source_operation_id != source_operation
                || observation
                    .resolution
                    .as_ref()
                    .is_none_or(|resolution| resolution == id)
                || observation.can_resolve
                || observation.can_apply
            {
                return Err("An uncertain R control has no confirmed original resolution; material is retained".into());
            }
            return Ok(());
        }
        if capability.version == 2 && status == "succeeded" {
            let args: ResolveRCheckpointControl =
                serde_json::from_value(operation["normalized_arguments"]["arguments"].clone())
                    .map_err(error)?;
            let out: RCheckpointControlResolution =
                serde_json::from_value(record["output"].clone()).map_err(error)?;
            reference(&args.reference, call)?;
            if out.operation_id != *id
                || out.reference != args.reference
                || out.source_operation_id != args.source_operation_id
                || out.previous_attempt != args.expected_attempt
                || out.decision != args.decision
            {
                return Err(
                    "R control resolution differs from its original admitted arguments".into(),
                );
            }
            return Ok(());
        }
        if status != "succeeded" {
            // Capture/adoption can leave complete or partial independent bytes.
            // Only the owner's confirmed not-started outcome excludes that case.
            if matches!(name, "r.capture_checkpoint" | "r.reconcile_checkpoint") {
                let output: RExecutionNotStarted = serde_json::from_value(record["output"].clone())
                    .map_err(|_| "An unsuccessful R capture has unknown recovery references")?;
                if output.operation_id != *id || output.started {
                    return Err("R capture was not confirmed unstarted".into());
                }
            }
            // Failed controls cannot retire a copy. The original successful
            // capture below asks R to qualify all control history. Restore creates
            // no new archive; its live session dependencies are observed separately.
            return Ok(());
        }
        if !matches!(name, "r.capture_checkpoint" | "r.reconcile_checkpoint") {
            return validate_consumer(call, id, name, &record);
        }
        let result: RCheckpointResult =
            serde_json::from_value(record["output"].clone()).map_err(error)?;
        reference(&result.reference, call)?;
        if result.reference.operation_id != *id
            || result.reference.provider != binding.provider
            || result.native_session_id.is_empty()
            || result.manifest.bytes > 1024 * 1024
        {
            return Err("R checkpoint summary differs from its original capture".into());
        }
        source::validate_report(&result.manifest, &binding)?;
        let provider = reader(self.checkpoint_reader.as_ref(), &binding.provider, readers)?;
        let checkpoint: RCheckpointObservation = serde_json::from_value(
            self.reference_query(
                call,
                "r.checkpoint",
                json!({"binding":ProviderBinding {
                    capability:CapabilityKey {id:ContributionId::new("r.checkpoint").unwrap(),version:1},
                    provider:provider.clone(),project:call.binding.project.clone(),target:None,
                },"arguments":{"reference":result.reference}}),
                false,
            ).await?,
        ).map_err(error)?;
        if json!(checkpoint.checkpoint) != json!(result)
            || checkpoint.deleted && (checkpoint.pinned || checkpoint.control_head.is_none())
        {
            return Err(
                "R checkpoint observation changed the original result or control state".into(),
            );
        }
        if checkpoint.deleted {
            // Logical retirement prevents restore/read even if post-commit payload
            // cleanup is pending. Missing bytes alone never prove retirement.
            return Ok(());
        }
        let manifest: RCheckpointManifest =
            serde_json::from_slice(&self.read(call, &result.manifest).await?).map_err(error)?;
        if manifest.reference != result.reference
            || manifest.native_session_id != result.native_session_id
            || manifest.report.saved_names.len() != result.saved_count as usize
            || manifest.report.skipped.len() != result.skipped_count as usize
            || manifest.report.coverage != result.coverage
            || manifest.libraries.library_paths != manifest.report.library_paths
        {
            return Err("R checkpoint manifest differs from the original result".into());
        }
        if !manifest.libraries.complete {
            return Err(
                "R checkpoint library dependencies remain incomplete; material is retained".into(),
            );
        }
        references.protect_values(&json!(manifest.libraries.library_paths), 128)?;
        references.protect_values(&json!(manifest.libraries.namespace_paths), 512)?;
        if let Some(environment) = manifest.environment {
            if environment.selection.binding.project != call.binding.project
                || environment.source.project != call.binding.project
            {
                return Err("R checkpoint Environment belongs to another project".into());
            }
            references.protect(&environment.library_path)?;
        }
        Ok(())
    }
}

/// Recognize public v1 consumers without interpreting R's private control chain.
/// All successful captures are independently covered by the complete journal scan.
fn validate_consumer(
    call: &PluginCall,
    id: &OperationId,
    name: &str,
    record: &Value,
) -> Result<(), String> {
    let arguments = record["operation"]["normalized_arguments"]["arguments"].clone();
    let output = record["output"].clone();
    let (source, result, correlated) = match name {
        "r.restore_checkpoint" => {
            let args: RestoreRCheckpoint = serde_json::from_value(arguments).map_err(error)?;
            let out: RCheckpointRestored = serde_json::from_value(output).map_err(error)?;
            (
                args.reference,
                out.reference,
                out.operation_id == *id && out.session_id == args.expected_session,
            )
        }
        "r.pin_checkpoint" => {
            let args: PinRCheckpoint = serde_json::from_value(arguments).map_err(error)?;
            let out: RCheckpointControlResult = serde_json::from_value(output).map_err(error)?;
            (
                args.reference,
                out.reference,
                out.operation_id == *id && out.pinned == args.pinned && !out.deleted,
            )
        }
        "r.delete_checkpoint" => {
            let args: DeleteRCheckpoint = serde_json::from_value(arguments).map_err(error)?;
            let out: RCheckpointControlResult = serde_json::from_value(output).map_err(error)?;
            (
                args.reference,
                out.reference,
                out.operation_id == *id && !out.pinned && out.deleted,
            )
        }
        "r.purge_checkpoint" => {
            let args: PurgeRCheckpoint = serde_json::from_value(arguments).map_err(error)?;
            let out: RCheckpointPurged = serde_json::from_value(output).map_err(error)?;
            (
                args.reference,
                out.reference,
                out.operation_id == *id && out.payload_removed,
            )
        }
        _ => return Err("Unsupported R recovery consumer".into()),
    };
    reference(&source, call)?;
    if !correlated || source != result {
        return Err("R recovery consumer differs from its admitted arguments".into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use rho_r_api::RCheckpointPayloadState;

    #[test]
    fn checkpoint_reader_selection_preserves_exact_choice_and_ambiguity() {
        let original = crate::tests::identity();
        let mut replacement = original.clone();
        replacement.instance = PluginInstanceId::new("replacement").unwrap();
        let mut other = replacement.clone();
        other.instance = PluginInstanceId::new("other").unwrap();
        assert_eq!(
            reader(None, &original, &[replacement.clone()]).unwrap(),
            &replacement
        );
        assert_eq!(
            reader(None, &original, &[replacement.clone(), original.clone()]).unwrap(),
            &original
        );
        assert_eq!(
            reader(
                Some(&replacement),
                &original,
                &[replacement.clone(), original.clone()]
            )
            .unwrap(),
            &replacement
        );
        assert!(
            reader(None, &original, &[])
                .unwrap_err()
                .contains("No active")
        );
        assert!(
            reader(None, &original, &[replacement.clone(), other])
                .unwrap_err()
                .contains("Multiple")
        );
        assert!(
            reader(Some(&original), &original, &[replacement])
                .unwrap_err()
                .contains("configured")
        );
    }

    #[tokio::test]
    async fn checkpoint_references_require_original_public_evidence() {
        for (scenario, reason) in [
            ("library", Some("still references")),
            ("namespace", Some("still references")),
            ("unrelated", None),
            ("deleted", None),
            ("deleted_payload_pending", None),
            ("missing_payload", Some("still references")),
            ("partial", Some("dependencies remain incomplete")),
            ("unavailable", Some("unavailable or incomplete")),
            ("changed_result", Some("changed the original result")),
            ("changed_record", Some("original admitted record")),
            ("changed_manifest", Some("manifest differs")),
            ("digest", Some("digest changed")),
            ("unconfirmed_delete", Some("control state")),
            ("failed", Some("unknown recovery references")),
            ("cancelled_unstarted", None),
            ("no_reader", Some("No active")),
        ] {
            let (directory, owner, mut requests) = crate::tests::fixture(true);
            let root = directory.path().canonicalize().unwrap();
            let material = root.join("materials/stage").to_str().unwrap().to_owned();
            let query =
                crate::tests::query(source::RETENTION, json!({"operation_id":"stage-source"}));
            let id = OperationId::new("capture").unwrap();
            let capability = CapabilityKey {
                id: ContributionId::new("r.capture_checkpoint").unwrap(),
                version: 1,
            };
            let mut binding = query.binding.clone();
            binding.capability = capability.clone();
            binding.provider.plugin = PluginId::new("org.rho.r").unwrap();
            binding.target = Some("original-native".into());
            let reference = RCheckpointReference {
                project: binding.project.clone(),
                provider: binding.provider.clone(),
                operation_id: id.clone(),
                digest: ContentDigest::new(format!("sha256:{}", "c".repeat(64))).unwrap(),
                bytes: 128,
            };
            let library = if matches!(scenario, "namespace" | "unrelated") {
                root.join("other").to_str().unwrap().to_owned()
            } else {
                material.clone()
            };
            let manifest = json!({
                "reference":reference,"native_session_id":if scenario=="changed_manifest" {"replacement-native"}else{"original-native"},"environment":null,"source":null,
                "libraries":{"library_paths":[library],"namespace_paths":if scenario=="namespace"{vec![format!("{material}/pkg")]}else{vec![]},"complete":scenario!="partial"},
                "report":{"saved_names":["x"],"skipped":[],"r_version":"4.5.2","platform":"fixture","library_paths":[library],"package_inventory_digest":"fixture","working_directory":null,
                    "safe_options":{"digits":null,"width":null,"scipen":null,"out_dec":null,"warn":null},"context_notices":[],"required_core_namespaces":[],"required_class_namespaces":[],"coverage":"complete_eligible_graph"}
            });
            let bytes = serde_json::to_vec(&manifest).unwrap();
            let result: RCheckpointResult = serde_json::from_value(json!({"reference":reference,
                "manifest":{"owner":binding.provider,"resource":"manifest","digest":format!("sha256:{:x}",Sha256::digest(&bytes)),"bytes":bytes.len(),"media_type":"application/json"},
                "native_session_id":"original-native","saved_count":1,"skipped_count":0,"coverage":"complete_eligible_graph"})).unwrap();
            let status = if scenario == "failed" {
                "failed"
            } else if scenario == "cancelled_unstarted" {
                "cancelled"
            } else {
                "succeeded"
            };
            let mut record = json!({"status":status,"output":result,"operation":{
                "operation_id":id,"idempotency_scope":root,"capability":capability,
                "normalized_arguments":{"binding":binding,"arguments":{"expected_session":"original-native"}},
                "admission":{"owner_context":{"binding":binding}}
            }});
            if scenario == "changed_record" {
                record["operation"]["admission"]["owner_context"]["binding"]["target"] =
                    json!("other");
            }
            if scenario == "failed" {
                record["output"] = Value::Null;
            }
            if scenario == "cancelled_unstarted" {
                record["output"] = json!({"operation_id":id,"started":false});
            }
            let deleted = matches!(
                scenario,
                "deleted" | "deleted_payload_pending" | "unconfirmed_delete"
            );
            let mut observation = RCheckpointObservation {
                checkpoint: result.clone(),
                control_head: deleted.then(|| OperationId::new("deletion").unwrap()),
                pinned: false,
                deleted,
                payload: if matches!(scenario, "deleted" | "missing_payload") {
                    RCheckpointPayloadState::Missing
                } else {
                    RCheckpointPayloadState::Present
                },
                notices: vec![],
            };
            if scenario == "unconfirmed_delete" {
                observation.control_head = None;
            }
            if scenario == "changed_result" {
                observation.checkpoint.saved_count = 2;
            }
            let expected_reference = reference.clone();
            let expected_reader = binding.provider.clone();
            let responder = tokio::spawn(async move {
                while let Some(request) = requests.recv().await {
                    let value = match request.capability.id.as_str() {
                        "operation.get" => json!({"record":record}),
                        "r.checkpoint" => {
                            assert_eq!(
                                request.arguments["binding"]["provider"],
                                json!(expected_reader)
                            );
                            assert!(request.arguments["binding"]["target"].is_null());
                            assert_eq!(
                                request.arguments["arguments"]["reference"],
                                json!(expected_reference)
                            );
                            json!(observation)
                        }
                        "resources.read" => {
                            assert!(
                                !deleted,
                                "Retired graphs have no live dependencies, including pending payload cleanup"
                            );
                            let mut chunk = bytes.clone();
                            if scenario == "digest" {
                                chunk[0] = b' ';
                            }
                            json!({"reference":request.arguments["reference"],"offset":0,"next":null,"base64":base64::engine::general_purpose::STANDARD.encode(chunk)})
                        }
                        unexpected => panic!("Unexpected checkpoint reference query {unexpected}"),
                    };
                    let _=request.reply.send(Ok(json!({"status":if scenario=="unavailable" && request.capability.id.as_str()=="r.checkpoint" {"unavailable"}else{"ready"},"completeness":"complete","data":value})));
                }
            });
            let readers = if scenario == "no_reader" {
                vec![]
            } else {
                vec![binding.provider]
            };
            let mut refs = References::new(&[material]).unwrap();
            let result = owner
                .checkpoint_references(&query, &mut refs, &readers, &id, &capability, status)
                .await;
            responder.abort();
            let _ = responder.await;
            if let Some(reason) = reason {
                assert!(
                    result.as_ref().unwrap_err().contains(reason),
                    "{scenario}: {result:?}"
                );
            } else {
                assert!(result.is_ok(), "{scenario}: {result:?}");
            }
            assert_eq!(
                std::fs::read(root.join("Rscript")).unwrap(),
                b"must never execute in these tests"
            );
            assert!(!root.join("materials/recovery").exists());
        }
    }

    #[tokio::test]
    async fn uncertain_controls_require_a_matching_committed_public_resolution() {
        for case in [
            "resolved",
            "retry_resolved",
            "unresolved",
            "wrong_id",
            "wrong_source",
            "wrong_reference",
            "wrong_status",
            "self_resolution",
            "still_open",
        ] {
            let (directory, owner, mut requests) = crate::tests::fixture(true);
            let root = directory.path().canonicalize().unwrap();
            let query = crate::tests::query(source::RETENTION, json!({"operation_id":"stage"}));
            let id = OperationId::new("uncertain-control").unwrap();
            let capability = CapabilityKey {
                id: ContributionId::new("r.pin_checkpoint").unwrap(),
                version: if case == "retry_resolved" { 2 } else { 1 },
            };
            let mut binding = query.binding.clone();
            binding.capability = capability.clone();
            let reference = RCheckpointReference {
                project: binding.project.clone(),
                provider: binding.provider.clone(),
                operation_id: OperationId::new("capture").unwrap(),
                digest: ContentDigest::new(format!("sha256:{}", "c".repeat(64))).unwrap(),
                bytes: 128,
            };
            let source_id = if case == "retry_resolved" {
                OperationId::new("original-pin").unwrap()
            } else {
                id.clone()
            };
            let arguments = if case == "retry_resolved" {
                json!({"reference":reference,"source_operation_id":source_id,"expected_attempt":null,"decision":"apply"})
            } else {
                json!({"reference":reference,"expected_control":null,"pinned":true})
            };
            let record = json!({"status":"uncertain","output":null,"operation":{"operation_id":id,"idempotency_scope":root,"capability":capability,"normalized_arguments":{"binding":binding,"arguments":arguments},"admission":{"owner_context":{"binding":binding}}}});
            let mut observation = RCheckpointControlObservation {
                operation_id: id.clone(),
                reference: reference.clone(),
                status: PluginOutcome::Uncertain,
                source_operation_id: source_id,
                latest_attempt: Some(OperationId::new("resolved-control").unwrap()),
                resolution: Some(OperationId::new("resolved-control").unwrap()),
                can_resolve: false,
                can_apply: false,
                notices: vec![],
            };
            match case {
                "unresolved" => observation.resolution = None,
                "wrong_id" => observation.operation_id = OperationId::new("other").unwrap(),
                "wrong_source" => {
                    observation.source_operation_id = OperationId::new("other").unwrap()
                }
                "wrong_reference" => observation.reference.bytes += 1,
                "wrong_status" => observation.status = PluginOutcome::Succeeded,
                "self_resolution" => observation.resolution = Some(id.clone()),
                "still_open" => observation.can_resolve = true,
                _ => (),
            }
            let expected = id.clone();
            let responder = tokio::spawn(async move {
                while let Some(request) = requests.recv().await {
                    let data = match request.capability.id.as_str() {
                        "operation.get" => json!({"record":record}),
                        "r.checkpoint_control" => {
                            assert_eq!(
                                request.arguments["arguments"],
                                json!({"reference":reference,"operation_id":expected})
                            );
                            json!(observation)
                        }
                        other => panic!("Unexpected control reference read {other}"),
                    };
                    let _ = request.reply.send(Ok(
                        json!({"status":"ready","completeness":"complete","data":data}),
                    ));
                }
            });
            let mut refs =
                References::new(&[root.join("materials/stage").to_str().unwrap().into()]).unwrap();
            let result = owner
                .checkpoint_references(
                    &query,
                    &mut refs,
                    &[binding.provider],
                    &id,
                    &capability,
                    "uncertain",
                )
                .await;
            responder.abort();
            let _ = responder.await;
            assert_eq!(
                result.is_ok(),
                matches!(case, "resolved" | "retry_resolved"),
                "{case}: {result:?}"
            );
            assert!(!root.join("materials/recovery").exists());
        }
    }
}
