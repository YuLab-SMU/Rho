//! Reconstruct control state exclusively from qualified core outcomes. Explicit
//! resolutions close terminal attempts without rewriting their original records.
use super::*;
use std::collections::BTreeMap;

struct Group {
    kind: String,
    expected: Option<OperationId>,
    action: RecoveryControl,
    status: PluginOutcome,
    latest: Option<OperationId>,
    resolved: Option<OperationId>,
}

#[derive(Default)]
pub(super) struct ControlHistory {
    state: ControlState,
    groups: BTreeMap<OperationId, Group>,
    records: BTreeMap<OperationId, (OperationId, PluginOutcome)>,
    unresolved: BTreeSet<OperationId>,
}

pub(super) fn resolution_result(
    operation: &OperationId,
    args: &ResolveRCheckpointControl,
    state: &ControlState,
) -> RCheckpointControlResolution {
    RCheckpointControlResolution {
        operation_id: operation.clone(),
        reference: args.reference.clone(),
        source_operation_id: args.source_operation_id.clone(),
        previous_attempt: args.expected_attempt.clone(),
        decision: args.decision,
        pinned: state.pinned,
        deleted: state.deleted,
    }
}

pub(super) fn resolution_evidence(result: &RCheckpointControlResolution) -> RecoveryControl {
    RecoveryControl::Resolved {
        source: result.source_operation_id.clone(),
        previous_attempt: result.previous_attempt.clone(),
        apply: result.decision == RCheckpointControlDecision::Apply,
        pinned: result.pinned,
        deleted: result.deleted,
    }
}

impl ControlHistory {
    pub(super) fn confirmed_state(&self) -> Result<ControlState, String> {
        if !self.unresolved.is_empty() {
            return Err("Original recovery control is uncertain; inspect r.checkpoint_control and explicitly resolve its original request".into());
        }
        Ok(self.state.clone())
    }

    pub(super) fn prepare_resolution(
        &self,
        kind: &str,
        args: &ResolveRCheckpointControl,
        reference: &RCheckpointReference,
    ) -> Result<ControlState, String> {
        let group = self
            .groups
            .get(&args.source_operation_id)
            .ok_or("Resolution requires an original version-1 pin or deletion request")?;
        if args.reference != *reference || group.kind != kind {
            return Err("Resolution changed the original copy or control kind".into());
        }
        if group.status == PluginOutcome::Succeeded || group.resolved.is_some() {
            return Err(
                "The original control already has a committed outcome or resolution".into(),
            );
        }
        if args.expected_attempt != group.latest {
            return Err(
                "Recovery resolution attempt changed; inspect the latest original attempt".into(),
            );
        }
        let mut result = self.state.clone();
        if args.decision == RCheckpointControlDecision::Apply {
            check_action(kind, &json!({"expected_control":group.expected}), &result)?;
            match group.action {
                RecoveryControl::Pin { pinned } => result.pinned = pinned,
                RecoveryControl::Delete => result.deleted = true,
                _ => return Err("Resolution source is not an original control".into()),
            }
        }
        // Discard only closes this request. It must not change the graph's
        // control head, including after a different request deleted the graph.
        Ok(result)
    }

    fn original(
        &mut self,
        reference: &RCheckpointReference,
        operation: OperationId,
        kind: String,
        status: PluginOutcome,
        arguments: Value,
        output: Value,
    ) -> Result<(), String> {
        let expected: Option<OperationId> = decode(arguments["expected_control"].clone())?;
        let action = if kind == PIN {
            RecoveryControl::Pin {
                pinned: decode(arguments["pinned"].clone())?,
            }
        } else {
            RecoveryControl::Delete
        };
        if status == PluginOutcome::Succeeded {
            self.confirmed_state()?;
            apply_control(
                &mut self.state,
                reference,
                &operation,
                expected.clone(),
                action.clone(),
                decode(output)?,
            )?;
        } else if status == PluginOutcome::Uncertain {
            self.unresolved.insert(operation.clone());
        }
        self.records
            .insert(operation.clone(), (operation.clone(), status));
        self.groups.insert(
            operation,
            Group {
                kind,
                expected,
                action,
                status,
                latest: None,
                resolved: None,
            },
        );
        Ok(())
    }

    fn attempt(
        &mut self,
        reference: &RCheckpointReference,
        operation: OperationId,
        kind: String,
        status: PluginOutcome,
        args: ResolveRCheckpointControl,
        output: Value,
    ) -> Result<(), String> {
        let group = self
            .groups
            .get(&args.source_operation_id)
            .ok_or("Resolution history has no original pin or deletion request")?;
        if group.kind != kind
            || group.status == PluginOutcome::Succeeded
            || args.reference != *reference
        {
            return Err("Resolution history changed its original control or copy".into());
        }
        if status == PluginOutcome::Succeeded {
            let mut next = self.prepare_resolution(&kind, &args, reference)?;
            let expected = resolution_result(&operation, &args, &next);
            if decode::<RCheckpointControlResolution>(output)? != expected {
                return Err("Committed resolution differs from its original request and current control state".into());
            }
            if args.decision == RCheckpointControlDecision::Apply {
                next.head = Some(operation.clone());
            }
            self.state = next;
            self.groups
                .get_mut(&args.source_operation_id)
                .unwrap()
                .resolved = Some(operation.clone());
            self.unresolved.remove(&args.source_operation_id);
        } else if status == PluginOutcome::Uncertain && group.resolved.is_none() {
            self.unresolved.insert(args.source_operation_id.clone());
        }
        // Terminal attempts accepted before a competing resolution can settle
        // afterwards. They cannot reopen its closed source or establish a new
        // logical pin/deletion. Their original status remains observable.
        self.groups
            .get_mut(&args.source_operation_id)
            .unwrap()
            .latest = Some(operation.clone());
        self.records
            .insert(operation, (args.source_operation_id, status));
        Ok(())
    }

    pub(super) fn observation(
        &self,
        operation: &OperationId,
        reference: &RCheckpointReference,
    ) -> Result<RCheckpointControlObservation, String> {
        let (source, status) = self
            .records
            .get(operation)
            .ok_or("The requested original control is outside this copy's qualified history")?;
        let group = &self.groups[source];
        let args = ResolveRCheckpointControl {
            reference: reference.clone(),
            source_operation_id: source.clone(),
            expected_attempt: group.latest.clone(),
            decision: RCheckpointControlDecision::Apply,
        };
        let can_resolve = group.status != PluginOutcome::Succeeded && group.resolved.is_none();
        let applying = self.prepare_resolution(&group.kind, &args, reference);
        Ok(RCheckpointControlObservation {
            operation_id: operation.clone(),
            reference: reference.clone(),
            status: *status,
            source_operation_id: source.clone(),
            latest_attempt: group.latest.clone(),
            resolution: group.resolved.clone(),
            can_resolve,
            can_apply: can_resolve && applying.is_ok(),
            notices: if can_resolve {
                applying.err().into_iter().collect()
            } else {
                vec![]
            },
        })
    }
}

impl Owner {
    pub(super) async fn control_history(
        &self,
        call: &PluginCall,
        source: &Source,
        lease: &RecoveryLease,
    ) -> Result<ControlHistory, String> {
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
            let mut controls: Vec<(OperationId, CapabilityKey, PluginOutcome, Value, Value)> =
                Vec::new();
            for _ in 0..PAGES {
                let page = self.recovery_page(call, cursor, PAGE).await?;
                for item in page.operations {
                    if item.operation_id == source.reference.operation_id {
                        if item.capability != source.binding.capability
                            || item.status != source.status
                        {
                            return Err(
                                "Recovery inventory changed its original capture outcome".into()
                            );
                        }
                        let mut history = ControlHistory::default();
                        for (operation, capability, status, arguments, output) in
                            controls.into_iter().rev()
                        {
                            if capability.version == 1 {
                                history.original(
                                    &source.reference,
                                    operation,
                                    capability.id.to_string(),
                                    status,
                                    arguments,
                                    output,
                                )?;
                            } else {
                                history.attempt(
                                    &source.reference,
                                    operation,
                                    capability.id.to_string(),
                                    status,
                                    decode(arguments)?,
                                    output,
                                )?;
                            }
                        }
                        return Ok(history);
                    }
                    if !matches!(item.capability.id.as_str(), PIN | DELETE)
                        || call.operation_id.as_deref() == Some(item.operation_id.as_str())
                    {
                        continue;
                    }
                    if !supported_version(&item.capability) {
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
                        || record["status"] != item.status
                        || arguments["reference"] != json!(source.reference)
                        || qualification.source.as_ref().is_none_or(|original| {
                            original.reference != source.reference
                                || json!(original.storage) != json!(source.storage)
                        })
                    {
                        return Err(
                            "Original recovery control changed its admitted source or outcome"
                                .into(),
                        );
                    }
                    let status: PluginOutcome = decode(record["status"].clone()).map_err(
                        |_| "Original recovery control is pending; wait for its terminal outcome",
                    )?;
                    if status == PluginOutcome::Succeeded {
                        let expected = if binding.capability.version == 2 {
                            resolution_evidence(&decode::<RCheckpointControlResolution>(
                                record["output"].clone(),
                            )?)
                        } else if binding.capability.id.as_str() == PIN {
                            RecoveryControl::Pin {
                                pinned: decode(arguments["pinned"].clone())?,
                            }
                        } else {
                            RecoveryControl::Delete
                        };
                        if lease.control(&item.operation_id)?.control != expected {
                            return Err(
                                "Committed recovery control differs from native evidence".into()
                            );
                        }
                    }
                    controls.push((
                        item.operation_id,
                        binding.capability,
                        status,
                        arguments.clone(),
                        record["output"].clone(),
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
}

#[cfg(test)]
mod tests {
    use super::*;
    fn id(value: &str) -> OperationId {
        OperationId::new(value).unwrap()
    }
    fn reference() -> RCheckpointReference {
        decode(json!({"project":"project","provider":{"plugin":"org.rho.r","instance":"original","revision":format!("sha256:{}","a".repeat(64)),"artifact":format!("sha256:{}","b".repeat(64))},"operation_id":"capture","digest":format!("sha256:{}","c".repeat(64)),"bytes":64})).unwrap()
    }
    fn original(
        history: &mut ControlHistory,
        operation: &str,
        kind: &str,
        status: PluginOutcome,
        expected: Option<&str>,
        pinned: bool,
    ) {
        history
            .original(
                &reference(),
                id(operation),
                kind.into(),
                status,
                json!({"reference":reference(),"expected_control":expected,"pinned":pinned}),
                json!(RCheckpointControlResult {
                    operation_id: id(operation),
                    reference: reference(),
                    pinned,
                    deleted: kind == DELETE
                }),
            )
            .unwrap();
    }
    fn args(
        source: &str,
        previous: Option<&str>,
        decision: RCheckpointControlDecision,
    ) -> ResolveRCheckpointControl {
        ResolveRCheckpointControl {
            reference: reference(),
            source_operation_id: id(source),
            expected_attempt: previous.map(id),
            decision,
        }
    }
    fn resolve(
        history: &mut ControlHistory,
        operation: &str,
        kind: &str,
        args: ResolveRCheckpointControl,
    ) -> RCheckpointControlResolution {
        let state = history
            .prepare_resolution(kind, &args, &reference())
            .unwrap();
        let output = resolution_result(&id(operation), &args, &state);
        history
            .attempt(
                &reference(),
                id(operation),
                kind.into(),
                PluginOutcome::Succeeded,
                args,
                json!(output),
            )
            .unwrap();
        output
    }

    #[test]
    fn applying_an_uncertain_request_creates_a_new_head_and_preserves_original_outcomes() {
        let mut history = ControlHistory::default();
        original(
            &mut history,
            "pin",
            PIN,
            PluginOutcome::Uncertain,
            None,
            true,
        );
        assert!(history.confirmed_state().is_err());
        let before = history.observation(&id("pin"), &reference()).unwrap();
        assert!(before.can_resolve && before.can_apply);
        assert!(before.resolution.is_none());
        let output = resolve(
            &mut history,
            "resolve",
            PIN,
            args("pin", None, RCheckpointControlDecision::Apply),
        );
        assert!(output.pinned);
        assert!(!output.deleted);
        assert_eq!(history.confirmed_state().unwrap().head, Some(id("resolve")));
        let after = history.observation(&id("pin"), &reference()).unwrap();
        assert_eq!(after.status, PluginOutcome::Uncertain);
        assert_eq!(after.resolution, Some(id("resolve")));
        assert!(!after.can_resolve);
        assert!(
            history
                .prepare_resolution(
                    PIN,
                    &args("pin", Some("resolve"), RCheckpointControlDecision::Discard),
                    &reference()
                )
                .is_err()
        );
        original(
            &mut history,
            "unpin",
            PIN,
            PluginOutcome::Succeeded,
            Some("resolve"),
            false,
        );
        assert!(!history.confirmed_state().unwrap().pinned);
    }

    #[test]
    fn competing_uncertainties_can_be_closed_without_overwriting_a_newer_choice() {
        let mut history = ControlHistory::default();
        original(
            &mut history,
            "pin",
            PIN,
            PluginOutcome::Uncertain,
            None,
            true,
        );
        original(
            &mut history,
            "delete",
            DELETE,
            PluginOutcome::Uncertain,
            None,
            false,
        );
        resolve(
            &mut history,
            "apply-pin",
            PIN,
            args("pin", None, RCheckpointControlDecision::Apply),
        );
        assert!(history.confirmed_state().is_err());
        let deletion = history.observation(&id("delete"), &reference()).unwrap();
        assert!(deletion.can_resolve);
        assert!(!deletion.can_apply);
        resolve(
            &mut history,
            "discard-delete",
            DELETE,
            args("delete", None, RCheckpointControlDecision::Discard),
        );
        let state = history.confirmed_state().unwrap();
        assert!(state.pinned);
        assert!(!state.deleted);
        assert_eq!(state.head, Some(id("apply-pin")));
    }

    #[test]
    fn lost_resolution_acknowledgement_requires_the_exact_latest_attempt() {
        let mut history = ControlHistory::default();
        original(&mut history, "pin", PIN, PluginOutcome::Failed, None, true);
        history
            .attempt(
                &reference(),
                id("lost"),
                PIN.into(),
                PluginOutcome::Uncertain,
                args("pin", None, RCheckpointControlDecision::Apply),
                Value::Null,
            )
            .unwrap();
        assert!(history.confirmed_state().is_err());
        assert!(
            history
                .prepare_resolution(
                    PIN,
                    &args("pin", None, RCheckpointControlDecision::Discard),
                    &reference()
                )
                .unwrap_err()
                .contains("attempt changed")
        );
        resolve(
            &mut history,
            "discard",
            PIN,
            args("pin", Some("lost"), RCheckpointControlDecision::Discard),
        );
        assert_eq!(history.confirmed_state().unwrap(), ControlState::default());
        for (operation, status) in [
            ("pin", PluginOutcome::Failed),
            ("lost", PluginOutcome::Uncertain),
        ] {
            let observed = history.observation(&id(operation), &reference()).unwrap();
            assert_eq!(observed.status, status);
            assert_eq!(observed.resolution, Some(id("discard")));
        }
        // An already accepted stale attempt settling later cannot reopen its
        // resolved source; it still retains its own uncertain original record.
        history
            .attempt(
                &reference(),
                id("stale"),
                PIN.into(),
                PluginOutcome::Uncertain,
                args("pin", None, RCheckpointControlDecision::Apply),
                Value::Null,
            )
            .unwrap();
        assert_eq!(history.confirmed_state().unwrap(), ControlState::default());
        assert_eq!(
            history
                .observation(&id("stale"), &reference())
                .unwrap()
                .resolution,
            Some(id("discard"))
        );
    }

    #[test]
    fn discard_after_deletion_preserves_the_original_cleanup_precondition() {
        let mut history = ControlHistory::default();
        original(
            &mut history,
            "failed-pin",
            PIN,
            PluginOutcome::Failed,
            None,
            true,
        );
        original(
            &mut history,
            "delete",
            DELETE,
            PluginOutcome::Succeeded,
            None,
            false,
        );
        let observed = history
            .observation(&id("failed-pin"), &reference())
            .unwrap();
        assert!(observed.can_resolve);
        assert!(!observed.can_apply);
        let discarded = resolve(
            &mut history,
            "discard",
            PIN,
            args("failed-pin", None, RCheckpointControlDecision::Discard),
        );
        assert!(discarded.deleted);
        let state = history.confirmed_state().unwrap();
        assert_eq!(state.head, Some(id("delete")));
        check_action(PURGE, &json!({"deletion_operation_id":"delete"}), &state).unwrap();
        assert!(check_action(PURGE, &json!({"deletion_operation_id":"discard"}), &state).is_err());
    }

    #[test]
    fn invalid_resolution_results_and_wrong_families_never_establish_facts() {
        for field in [
            "operation",
            "source",
            "reference",
            "previous",
            "decision",
            "pin",
            "delete",
        ] {
            let mut history = ControlHistory::default();
            original(
                &mut history,
                "pin",
                PIN,
                PluginOutcome::Uncertain,
                None,
                true,
            );
            let args = args("pin", None, RCheckpointControlDecision::Apply);
            assert!(
                history
                    .prepare_resolution(DELETE, &args, &reference())
                    .is_err()
            );
            let state = history
                .prepare_resolution(PIN, &args, &reference())
                .unwrap();
            let mut output = resolution_result(&id("resolve"), &args, &state);
            match field {
                "operation" => output.operation_id = id("other"),
                "source" => output.source_operation_id = id("other"),
                "reference" => output.reference.bytes += 1,
                "previous" => output.previous_attempt = Some(id("other")),
                "decision" => output.decision = RCheckpointControlDecision::Discard,
                "pin" => output.pinned = false,
                _ => output.deleted = true,
            }
            assert!(
                history
                    .attempt(
                        &reference(),
                        id("resolve"),
                        PIN.into(),
                        PluginOutcome::Succeeded,
                        args,
                        json!(output)
                    )
                    .is_err(),
                "{field}"
            );
            assert_eq!(history.state, ControlState::default());
            assert!(history.confirmed_state().is_err());
        }
    }
}
