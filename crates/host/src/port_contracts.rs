//! Descriptions and adapters for the existing Host operation/control ports.
//! All scientific authority remains in OperationGateway and Workspace owner.
use rho_contract::*;
use rho_operation::{
    CapabilityRegistry, Clock, ControlHandler, OperationError, OperationGateway, QueryHandler, SystemClock,
};
use schemars::schema_for;
use serde_json::{Value, json};
use std::{
    collections::BTreeSet,
    sync::{Arc, OnceLock, Weak},
};

pub(crate) const RECONCILE: &str = "operation.reconcile_commit";
pub(crate) const CANCEL: &str = "operation.request_cancellation";
pub(crate) const INPUT: &str = "workspace.respond_input";
pub(crate) const EVENTS: &str = "operation.events";

/// All edges may use the declared control capability. Route core-owned controls
/// to their original Host ports; native contributed controls use the registry.
pub(crate) fn control_request(registry: &CapabilityRegistry, context: &CallContext, request: ControlRequest) -> Result<HostRequest, OperationError> {
    if request.capability.version != 1 || !matches!(request.capability.id.as_str(),
        RECONCILE | INPUT | "application.control" | "application.bind_method") {
        return Ok(HostRequest::Control(request));
    }
    registry.validate_control_input(context, &request.capability, &request.arguments)
        .map_err(|error| match error {
            OperationError::InvalidInput(_) => OperationError::InvalidInput("Control arguments violate their contract (redacted)".into()),
            other => other,
        })?;
    let invalid = |_| OperationError::InvalidInput("Control arguments violate their contract (redacted)".into());
    Ok(match request.capability.id.as_str() {
        RECONCILE => HostRequest::ReconcileCommit(serde_json::from_value(request.arguments).map_err(invalid)?),
        INPUT => HostRequest::RespondInput(serde_json::from_value(request.arguments).map_err(invalid)?),
        "application.control" => HostRequest::ApplicationControl(serde_json::from_value(request.arguments).map_err(invalid)?),
        "application.bind_method" => HostRequest::BindMethod(serde_json::from_value(request.arguments).map_err(invalid)?),
        _ => unreachable!(),
    })
}

/// The cancellation port requires the selected operation's original authority,
/// which is a disjunction at discovery time and an exact check at admission.
pub(crate) fn visible(
    descriptors: Vec<CapabilityDescriptor>,
    context: &CallContext,
) -> Vec<CapabilityDescriptor> {
    let may_cancel = descriptors.iter().any(|descriptor| {
        descriptor.kind == CapabilityKind::Operation
            && descriptor.cancellation != CancellationClass::Unsupported
            && descriptor.required_scopes.is_subset(&context.scopes)
    });
    descriptors
        .into_iter()
        .filter(|descriptor| {
            descriptor.required_scopes.is_subset(&context.scopes)
                && (descriptor.capability.id != CANCEL || may_cancel)
        })
        .collect()
}

pub(crate) fn register(
    registry: &mut CapabilityRegistry,
    journal: Arc<dyn rho_operation::OperationJournal>,
    project: Option<String>,
    has_workspace: bool,
    writable: bool,
) -> Result<Arc<EventsHandler>, OperationError> {
    let get = registry
        .descriptor(&CapabilityRef::new("operation.get", 1)?)
        .ok_or_else(|| {
            OperationError::Contract("operation.get must precede port composition".into())
        })?;
    let cancel_output =
        cancellation_result_schema(&get.output_schema).map_err(OperationError::Contract)?;
    let cancellation = if writable || registry.descriptors().iter().any(|descriptor| {
        descriptor.kind == CapabilityKind::Operation
            && descriptor.cancellation != CancellationClass::Unsupported
    }) {
        let control = Arc::new(CancellationControl { descriptor: cancel_descriptor(cancel_output), gateway: OnceLock::new() });
        registry.register_control_handler(control.clone())?;
        Some(control)
    } else { None };
    if has_workspace {
        registry.register_control(input_descriptor())?;
    }
    if writable {
        registry.register_control(reconcile_descriptor(&get.output_schema))?;
    }
    let commit_status = Arc::new(rho_operation::OperationCommitStatusHandler::new(journal, project.clone()));
    registry.register_query(commit_status.clone())?;
    let events = Arc::new(EventsHandler {
        commit_status,
        cancellation,
        project,
        gateway: OnceLock::new(),
        descriptor: events_descriptor(),
    });
    registry.register_query(events.clone())?;
    Ok(events)
}

/// This adapter delegates to the original gateway; it owns no journal, native
/// queue or alternative cancellation decision. Every edge uses the same handler.
struct CancellationControl {
    descriptor: CapabilityDescriptor,
    gateway: OnceLock<Weak<OperationGateway>>,
}
#[async_trait::async_trait]
impl ControlHandler for CancellationControl {
    fn descriptor(&self) -> &CapabilityDescriptor { &self.descriptor }
    async fn control(&self, context: &CallContext, arguments: Value) -> Result<Value, OperationError> {
        let args: CancelOperation = serde_json::from_value(arguments)
            .map_err(|_| OperationError::InvalidInput("Cancellation arguments violate their contract (redacted)".into()))?;
        OperationId::new(args.operation_id.as_str())?;
        let gateway = self.gateway.get().and_then(Weak::upgrade)
            .ok_or_else(|| OperationError::Unavailable("Original operation gateway is unavailable".into()))?;
        let result = gateway.request_cancellation_conditional(context, &args.operation_id, args.only_if_pending.unwrap_or(false)).await?;
        serde_json::to_value(result).map_err(|e| OperationError::Contract(e.to_string()))
    }
}

fn reference(id: &str) -> CapabilityRef {
    CapabilityRef::new(id, 1).expect("static port capability")
}
fn get_precondition(parameter: &str, requirement: &str) -> CapabilityPrecondition {
    CapabilityPrecondition {
        parameter: parameter.into(),
        requirement: requirement.into(),
        read_from: Some(reference("operation.get")),
    }
}
fn cancel_descriptor(output_schema: Value) -> CapabilityDescriptor {
    CapabilityDescriptor {
        kind: CapabilityKind::Control, capability: reference(CANCEL), domain: "operation".into(),
        input_schema: schema_for!(CancelOperation).to_value(), output_schema,
        recovery_schema: json!({"type":"null"}),
        // No invented generic cancellation permission. Gateway checks the
        // original operation's required scopes and principal/project identity.
        required_scopes: BTreeSet::new(),
        potential_effects: BTreeSet::from([EffectHint::MayMutateRuntime]),
        idempotency: IdempotencyClass::CallerScoped, retry: RetryClass::ReconcileFirst,
        cancellation: CancellationClass::Unsupported,
        documentation: CapabilityDocumentation {
            summary: "Request cancellation of an original operation".into(),
            purpose: "Request the existing owner's cancellation by exact OperationId. The journal records the request and the active owner receives its cancellation signal; no replacement operation is created.".into(),
            when_to_use: vec!["Stop queued or active work after identifying the original operation.".into()],
            limitations: vec!["accepted=true reports cancellation request acceptance only. It does not establish a stopped runtime, rollback or terminal cancellation; inspect operation.status and its later authoritative record.".into(), "Requires the original operation capability's native scopes and the same principal/project visibility. This control is discoverable only when at least one cancellable operation is authorized.".into()],
            owner: "operation gateway and original scientific owner".into(),
            effects: "Durably marks cancellation_requested and signals an active owner. only_if_pending=true first requires the owner's pending-queue check; a running or ended operation is rejected instead of interrupted.".into(),
            retry_rule: "Retain the original OperationId. Repeating the cancellation request cannot start a second scientific action; after a lost acknowledgement inspect the original record first. Do not replay the original command.".into(),
            cancellation_rule: "This short control cannot itself be cancelled. RPC cancellation never confirms that scientific work stopped.".into(),
            preconditions: vec![get_precondition("operation_id", "Obtain the OperationId from the accepted command result or operation.events. operation.get verifies status when operation.read is authorized; cancellation does not require that additional read scope."), get_precondition("only_if_pending", "Set true only to remove work which the original owner still confirms is queued. Set false for an explicit interrupt request.")],
            examples: vec![CapabilityExample { arguments: json!({"operation_id":"operation-example","only_if_pending":false}), result_explanation: "accepted is separate from operation.status. An accepted request can return a running record with cancellation_requested=true; only a later terminal record confirms the outcome.".into() }],
            related_capabilities: vec![reference("operation.get"), reference(EVENTS)], related_skills: vec![], position_units: vec![],
        },
    }
}
fn reconcile_descriptor(get_schema: &Value) -> CapabilityDescriptor {
    CapabilityDescriptor {
        kind: CapabilityKind::Control, capability: reference(RECONCILE), domain: "operation".into(),
        input_schema: schema_for!(ReconcileOperationCommit).to_value(),
        output_schema: json!({"$defs":get_schema["$defs"],"allOf":[get_schema["properties"]["record"],{"type":"object"}]}),
        recovery_schema: json!({"type":"null"}), required_scopes: BTreeSet::new(),
        potential_effects: BTreeSet::from([EffectHint::CommitsOperation]),
        idempotency: IdempotencyClass::CallerScoped, retry: RetryClass::ReconcileFirst,
        cancellation: CancellationClass::Unsupported,
        documentation: CapabilityDocumentation {
            summary: "Complete the original operation's retained commit".into(),
            purpose: "Commit the exact already-validated result retained by the original journal. Uses the captured original authority and native result, without acquiring a provider or repeating scientific execution.".into(),
            when_to_use: vec!["operation.commit_status reports a volatile or durable reference, or a terminal commit acknowledgement was lost.".into()],
            limitations: vec!["Requires the original principal, project and captured capability scopes. Caller-supplied replacement plans are never accepted. A changed digest is rejected. Storage failure leaves the original result pending.".into()],
            owner: "operation gateway and journal".into(),
            effects: "Atomically commits the retained result, facts, evidence and events to the original operation. Releases the original execution lease only after authoritative terminal agreement.".into(),
            retry_rule: "Use the exact original reference. An already committed matching reference returns its original terminal record without writing facts or events again.".into(),
            cancellation_rule: "This control does not cancel, rerun or roll back scientific execution.".into(),
            preconditions: vec![CapabilityPrecondition { parameter:"reference".into(), requirement:"Use the exact digest and size from operation.commit_status for this OperationId.".into(), read_from:Some(reference("operation.commit_status")) }],
            examples:vec![CapabilityExample { arguments:json!({"reference":{"operation_id":"operation-example","sha256":format!("sha256:{}","0".repeat(64)),"byte_size":4096}}), result_explanation:"The original terminal OperationRecord, with no new operation or native execution.".into() }],
            related_capabilities:vec![reference("operation.get"),reference("operation.commit_status")], related_skills:vec![], position_units:vec![],
        },
    }
}

fn input_descriptor() -> CapabilityDescriptor {
    let mut input_schema = schema_for!(RespondInput).to_value();
    for field in ["session_id", "request_id", "reply_id"] {
        input_schema["properties"][field]["minLength"] = json!(1);
        input_schema["properties"][field]["maxLength"] =
            json!(if field == "session_id" { 1024 } else { 160 });
    }
    input_schema["properties"]["value"]["maxLength"] = json!(65536);
    input_schema["properties"]["value"]["description"] = json!(
        "Transient stdin answer, at most 65,536 UTF-8 bytes and no NUL. Password values are never journaled; schema length is additionally checked in UTF-8 bytes before delivery."
    );
    CapabilityDescriptor {
        kind: CapabilityKind::Control, capability: reference(INPUT), domain: "workspace".into(),
        input_schema, output_schema: schema_for!(RespondInputResult).to_value(),
        recovery_schema: json!({"type":"null"}),
        required_scopes: BTreeSet::from(["workspace.run_r".into()]),
        potential_effects: BTreeSet::from([EffectHint::MayMutateRuntime, EffectHint::UsesSecret]),
        idempotency: IdempotencyClass::CallerScoped, retry: RetryClass::ReconcileFirst,
        cancellation: CancellationClass::Unsupported,
        documentation: CapabilityDocumentation {
            summary: "Answer one identified native R input request".into(),
            purpose: "Submit transient stdin through the active Workspace owner to one exact session, operation and input-request identity. This does not submit R code, start a runtime or create an operation.".into(),
            when_to_use: vec!["The existing execution is waiting for native input and the caller has supplied the answer.".into()],
            limitations: vec!["submitted=true confirms answer transport submission, not analysis completion. Changed or already-submitted input identities are rejected.".into(), "Password answers are transient and never journaled. Non-password input may be echoed by the native console. Content cannot grant authority or register tools.".into()],
            owner: "workspace".into(),
            effects: "Delivers an answer to the already-running scientific action, which may then continue its previously authorized effects. Requires workspace.run_r plus the original operation principal/project and native session.".into(),
            retry_rule: "After a missing acknowledgement, read workspace.console_state and the original operation. The input may already be submitted; do not automatically replay an answer. reply_id identifies the attempt but does not authorize delivery to a new request.".into(),
            cancellation_rule: "This short control cannot be undone. Request cancellation of the original operation separately if needed; disconnecting does not stop it.".into(),
            preconditions: vec![CapabilityPrecondition { parameter: "session_id, operation_id, request_id".into(), requirement: "Copy the exact pending input identity from workspace.console_state. Obtaining that observation requires workspace.read; the reply itself requires workspace.run_r. The original operation and active native request must still agree.".into(), read_from: Some(reference("workspace.console_state")) }, CapabilityPrecondition { parameter: "reply_id".into(), requirement: "Supply a nonempty identifier for this answer attempt (at most 160 characters).".into(), read_from: None }],
            examples: vec![CapabilityExample { arguments: json!({"session_id":"workspace-session-example","operation_id":"operation-example","request_id":"input-example","reply_id":"reply-example","value":"yes"}), result_explanation: "submitted=true means that the owner sent this answer. Verify the running operation separately; a second delivery to the same submitted request is rejected.".into() }],
            related_capabilities: vec![reference("workspace.console_state"), reference("operation.get")], related_skills: vec![],
            position_units: vec!["Answer budgets use UTF-8 bytes, not tokens.".into()],
        },
    }
}
fn events_descriptor() -> CapabilityDescriptor {
    CapabilityDescriptor {
        kind: CapabilityKind::Query, capability: reference(EVENTS), domain: "operation".into(),
        input_schema: schema_for!(PollOperationEventsArguments).to_value(),
        output_schema: operation_events_page_schema(), recovery_schema: json!({"type":"null"}),
        required_scopes: BTreeSet::from(["operation.read".into()]), potential_effects: BTreeSet::new(),
        idempotency: IdempotencyClass::Pure, retry: RetryClass::Safe, cancellation: CancellationClass::Unsupported,
        documentation: CapabilityDocumentation {
            summary: "Read a durable operation event cursor page".into(),
            purpose: "Read the existing journal outbox in ascending global sequence order, filtered by project and principal before applying the page limit. Events identify original operations for subsequent authoritative result inspection.".into(),
            when_to_use: vec!["Discover accepted operations, inspect cancellation acknowledgements or continue event observation after a disconnect.".into()],
            limitations: vec!["This is a bounded observation, not live push or an atomic snapshot with other owners. Sequence gaps can contain invisible events. has_more=false describes the observed journal end; new work can append events later.".into(), "Event data is selected by topic; operation lifecycle shapes are fixed and scientific owner topics can contain dynamic evidence. Use operation.get for the recorded capability's typed output. An oversized single event returns an explicit byte limit without skipping that event.".into()],
            owner: "operation journal".into(), effects: "Read-only outbox observation. Does not acknowledge delivery, recover work, start R or mutate scientific state.".into(),
            retry_rule: "Resume from next_after_sequence. Repeating the same cursor rereads retained original events without execution. Preserve the last returned sequence even when no more events are currently visible.".into(),
            cancellation_rule: "Stopping the read has no effect on accepted scientific work or the durable cursor.".into(),
            preconditions: vec![CapabilityPrecondition { parameter: "after_sequence".into(), requirement: "Start at 0 or use the previous page's next_after_sequence. Cursors are journal sequence numbers and must remain within the same Host/project/principal.".into(), read_from: Some(reference(EVENTS)) }],
            examples: vec![CapabilityExample { arguments: json!({"after_sequence":0,"limit":100}), result_explanation: "events contains up to 100 visible durable records; next_after_sequence resumes after the last returned event, and has_more/limit_reason disclose truncation. Read each relevant operation_id using operation.get to distinguish request acceptance from terminal outcome.".into() }],
            related_capabilities: vec![reference("operation.get")], related_skills: vec![],
            position_units: vec!["Sequences are durable journal cursors. Page data is limited to 256 KiB of UTF-8 JSON; limits do not estimate tokens.".into()],
        },
    }
}

/// Composition binds this adapter to the already-created gateway once. It has
/// no independent journal, execution state, permission policy or recovery loop.
pub(crate) struct EventsHandler {
    commit_status: Arc<rho_operation::OperationCommitStatusHandler>,
    cancellation: Option<Arc<CancellationControl>>,
    project: Option<String>,
    gateway: OnceLock<Weak<OperationGateway>>,
    descriptor: CapabilityDescriptor,
}
impl EventsHandler {
    pub(crate) fn bind(&self, gateway: &Arc<OperationGateway>) {
        if let Some(control) = &self.cancellation {
            control.gateway.set(Arc::downgrade(gateway)).expect("cancellation port binds once");
        }
        self.commit_status.bind(&gateway.commit_recovery());
        self.gateway
            .set(Arc::downgrade(gateway))
            .expect("event port binds once");
    }
    async fn read(
        &self,
        context: &CallContext,
        args: &PollOperationEventsArguments,
    ) -> Result<OperationEventsPage, OperationError> {
        let gateway = self.gateway.get().and_then(Weak::upgrade).ok_or_else(|| {
            OperationError::Unavailable("Host operation port is not composed".into())
        })?;
        let mut page = OperationEventsPage {
            events: vec![],
            after_sequence: args.after_sequence,
            next_after_sequence: args.after_sequence,
            has_more: false,
            limit_reason: None,
        };
        let mut bytes = 1024;
        while page.events.len() < args.limit {
            let count = (args.limit - page.events.len()).min(16);
            let batch = gateway
                .outbox(context, page.next_after_sequence, count)
                .await?;
            let end = batch.len() < count;
            for event in batch {
                let event_bytes = serde_json::to_vec(&event).map_err(contract)?.len() + 1;
                if bytes + event_bytes > OPERATION_EVENTS_PAGE_BYTES {
                    if page.events.is_empty() {
                        return Err(OperationError::BudgetExceeded(format!(
                            "Event {} for operation {} exceeds the {} UTF-8 byte event page bound; this cursor has not advanced. Read operation.get for the original result.",
                            event.sequence,
                            event.operation_id.as_str(),
                            OPERATION_EVENTS_PAGE_BYTES
                        )));
                    }
                    page.has_more = true;
                    page.limit_reason = Some("utf8_byte_limit".into());
                    return Ok(page);
                }
                bytes += event_bytes;
                page.next_after_sequence = event.sequence;
                page.events.push(event);
            }
            if end {
                return Ok(page);
            }
        }
        page.has_more = !gateway
            .outbox(context, page.next_after_sequence, 1)
            .await?
            .is_empty();
        if page.has_more {
            page.limit_reason = Some("item_limit".into());
        }
        Ok(page)
    }
}
#[async_trait::async_trait]
impl QueryHandler for EventsHandler {
    fn descriptor(&self) -> &CapabilityDescriptor {
        &self.descriptor
    }
    fn normalize_arguments(&self, arguments: &Value) -> Result<Value, OperationError> {
        let args: PollOperationEventsArguments =
            serde_json::from_value(arguments.clone()).map_err(invalid)?;
        if !(1..=1000).contains(&args.limit) || args.after_sequence > i64::MAX as u64 {
            return Err(invalid(
                "event limit must be 1..1000 and cursor must fit INT64",
            ));
        }
        serde_json::to_value(args).map_err(invalid)
    }
    async fn query(&self, _: &Value) -> Result<QuerySnapshot, OperationError> {
        Err(invalid("caller context is required"))
    }
    async fn query_for(
        &self,
        context: &CallContext,
        args: &Value,
    ) -> Result<QuerySnapshot, OperationError> {
        let args: PollOperationEventsArguments =
            serde_json::from_value(args.clone()).map_err(invalid)?;
        let page = self.read(context, &args).await?;
        let mut next_reads = vec![NextRead::query(
            EVENTS,
            if page.has_more {
                "Continue the visible durable event page"
            } else {
                "Observe later events after the last returned sequence"
            },
            json!({"after_sequence":page.next_after_sequence,"limit":args.limit}),
        )];
        for id in page
            .events
            .iter()
            .map(|event| &event.operation_id)
            .collect::<BTreeSet<_>>()
            .into_iter()
            .take(8)
        {
            next_reads.push(NextRead::query(
                "operation.get",
                "Read the original authoritative operation",
                json!({"operation_id":id}),
            ));
        }
        Ok(QuerySnapshot {
            target: TargetRef {
                kind: "operation_journal".into(),
                identity: self
                    .project
                    .clone()
                    .unwrap_or_else(|| "host-local-journal".into()),
            },
            source: "operation-journal/outbox".into(),
            observed_at_ms: SystemClock.now_ms()?,
            status: QueryStatus::Ready,
            completeness: if page.has_more {
                ObservationCompleteness::Partial
            } else {
                ObservationCompleteness::Complete
            },
            notices: vec![],
            next_reads,
            diagnostics: vec![],
            data: Some(serde_json::to_value(page).map_err(contract)?),
        })
    }
}
fn invalid(error: impl std::fmt::Display) -> OperationError {
    OperationError::InvalidInput(error.to_string())
}
fn contract(error: impl std::fmt::Display) -> OperationError {
    OperationError::Contract(error.to_string())
}
