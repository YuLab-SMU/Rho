//! Generic Host bridge. Scientific interpretation remains in the exact backend;
//! admission, validation and the only result commit remain in rho-operation.
use crate::{PluginError, PluginRuntime, ProviderLease};
use async_trait::async_trait;
use rho_contract as host;
use rho_operation::{
    CapabilityRegistry, Clock, CommitPlan, ContributionBatch, DomainFactMutation, ExecutionLease,
    ControlHandler, HandlerError, OperationError, OperationHandler, QueryHandler, RegistrationRevision,
    SystemClock,
};
use rho_plugin_protocol::*;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::sync::{Arc, Mutex};

/// Supplied by the authoritative resource owner. Checking a reference must not
/// start a runtime, fetch an arbitrary URL, or trust the backend's digest claim.
#[async_trait]
pub trait PluginResourceVerifier: Send + Sync {
    async fn verify(
        &self,
        project: &ProjectId,
        principal: &PrincipalId,
        reference: &ResourceReference,
    ) -> Result<(), String>;
}
pub struct NoPluginResources;
#[async_trait]
impl PluginResourceVerifier for NoPluginResources {
    async fn verify(
        &self,
        _: &ProjectId,
        _: &PrincipalId,
        _: &ResourceReference,
    ) -> Result<(), String> {
        Err("No authoritative plugin resource owner is configured".into())
    }
}

/// Derive opaque protocol identities from the Host's normalized project and
/// authenticated principal. These inputs never come from plugin arguments.
pub fn plugin_project_id(normalized_project: &str) -> ProjectId {
    ProjectId::new(format!(
        "project-{:x}",
        Sha256::digest(normalized_project.as_bytes())
    ))
    .unwrap()
}
pub fn plugin_principal_id(principal: &host::CallerIdentity) -> PrincipalId {
    PrincipalId::new(format!(
        "principal-{:x}",
        Sha256::digest(serde_json::to_vec(principal).unwrap())
    ))
    .unwrap()
}

pub struct PluginCapabilityBridge {
    shared: Arc<BridgeContext>,
    registration: Mutex<Option<RegistrationRevision>>,
}
struct BridgeContext {
    runtime: Arc<PluginRuntime>,
    resources: Arc<dyn PluginResourceVerifier>,
    project: ProjectId,
    scope: String,
}
impl PluginCapabilityBridge {
    pub fn new(
        runtime: Arc<PluginRuntime>,
        normalized_project: String,
        resources: Arc<dyn PluginResourceVerifier>,
    ) -> Self {
        Self {
            shared: Arc::new(BridgeContext {
                runtime,
                resources,
                project: plugin_project_id(&normalized_project),
                scope: normalized_project,
            }),
            registration: Mutex::new(None),
        }
    }
    /// Publish a complete immutable registry snapshot. Existing invocations keep
    /// their already-bound handler. No process is started by this method.
    pub fn refresh(
        &self,
        registry: &CapabilityRegistry,
    ) -> Result<RegistrationRevision, OperationError> {
        self.refresh_including(registry, None)
    }
    pub fn publish(&self, registry: &CapabilityRegistry, instance: &InstanceRef) -> Result<RegistrationRevision, OperationError> {
        let revision = self.refresh_including(registry, Some(instance))?;
        if let Err(error) = self.shared.runtime.publish_instance(instance) {
            self.refresh(registry)?;
            return Err(unavailable(error));
        }
        Ok(revision)
    }
    fn refresh_including(&self, registry: &CapabilityRegistry, pending: Option<&InstanceRef>) -> Result<RegistrationRevision, OperationError> {
        let mut registration = self.registration.lock().unwrap();
        let mut batch = ContributionBatch { controls: vec![],
            operations: vec![],
            queries: vec![],
        };
        for cap in self.shared.runtime.contributions_including(&self.shared.project, pending) {
            let descriptor = descriptor(&cap, &self.shared.project)?;
            let handler = Arc::new(RoutingHandler {
                shared: self.shared.clone(),
                cap,
                descriptor,
            });
            if handler.cap.kind == CapabilityKind::Query {
                batch.queries.push(handler);
            } else if handler.cap.kind == CapabilityKind::Control {
                batch.controls.push(handler);
            } else {
                batch.operations.push(handler);
            }
        }
        let next = registry.replace_batch("plugins", registration.as_ref(), batch)?;
        *registration = Some(next.clone());
        Ok(next)
    }

    /// Recover a lost completion notification using the original journal only.
    /// Notify the original live owner before releasing its package reference.
    /// This never reexecutes or recommits a result.
    pub async fn reconcile_reference(
        &self,
        journal: &dyn rho_operation::OperationJournal,
        context: &host::CallContext,
        operation_id: &host::OperationId,
    ) -> Result<(), OperationError> {
        context.validate()?;
        let record = journal
            .get(operation_id)
            .await?
            .filter(|record| {
                record.operation.idempotency_scope.as_deref() == Some(self.shared.scope.as_str())
                    && record.operation.principal() == context.principal()
            })
            .ok_or_else(|| OperationError::NotFound(operation_id.as_str().into()))?;
        let admission = record.operation.admission.as_ref().ok_or_else(|| {
            OperationError::Contract("Operation has no captured plugin admission".into())
        })?;
        if !admission
            .descriptor
            .required_scopes
            .is_subset(&context.scopes)
        {
            return Err(OperationError::AccessDenied {
                capability: record.operation.capability.display_key(),
                missing: admission
                    .descriptor
                    .required_scopes
                    .difference(&context.scopes)
                    .cloned()
                    .collect(),
            });
        }
        if !record.status.is_terminal() {
            return Err(OperationError::LifecycleConflict(
                "Operation has no authoritative terminal result".into(),
            ));
        }
        let request: PluginRequest = serde_json::from_value(record.operation.normalized_arguments.clone())
            .map_err(|e| OperationError::Contract(e.to_string()))?;
        if request.binding.project != self.shared.project
            || admission.owner_context["binding"] != json!(request.binding)
        {
            return Err(OperationError::Contract(
                "Stored plugin admission does not match its original binding".into(),
            ));
        }
        self.shared
            .runtime
            .settle_operation(settlement(&record, request.binding)?)
            .await
            .map_err(unavailable)
    }
}

struct RoutingHandler {
    shared: Arc<BridgeContext>,
    cap: CapabilityContribution,
    descriptor: host::CapabilityDescriptor,
}
impl RoutingHandler {
    fn request(&self, value: &Value) -> Result<PluginRequest, OperationError> {
        let request: PluginRequest = serde_json::from_value(value.clone())
            .map_err(|e| OperationError::InvalidInput(e.to_string()))?;
        if request.binding.capability != self.cap.capability
            || request.binding.project != self.shared.project
        {
            return Err(OperationError::InvalidInput(
                "Provider binding does not match this capability and project".into(),
            ));
        }
        target(&request.binding)?.validate()?;
        Ok(request)
    }
    fn resolve(
        &self,
        context: &host::CallContext,
        request: &PluginRequest,
    ) -> Result<Arc<ProviderLease>, OperationError> {
        let lease = self
            .shared
            .runtime
            .resolve(
                &self.cap.capability,
                &self.shared.project,
                &plugin_principal_id(context.principal()),
                Some(&request.binding.provider),
            )
            .map_err(unavailable)?;
        Ok(Arc::new(lease))
    }
}

#[async_trait]
impl OperationHandler for RoutingHandler {
    fn descriptor(&self) -> &host::CapabilityDescriptor {
        &self.descriptor
    }
    fn normalize_arguments(&self, value: &Value) -> Result<Value, OperationError> {
        encode(self.request(value)?)
    }
    fn resolve_target(&self, value: &Value) -> Result<host::TargetRef, OperationError> {
        target(&self.request(value)?.binding)
    }
    async fn execute(&self, _: &host::Operation) -> Result<CommitPlan, HandlerError> {
        Err(HandlerError::before_effect(
            "Plugin provider was not bound before admission",
        ))
    }
    async fn bind(
        &self,
        context: &host::CallContext,
        value: &Value,
        outer: &[host::Precondition],
    ) -> Result<Option<Arc<dyn OperationHandler>>, OperationError> {
        if !outer.is_empty() {
            return Err(OperationError::InvalidInput(
                "Plugin native preconditions belong in PluginRequest.preconditions".into(),
            ));
        }
        let mut request = self.request(value)?;
        let lease = self.resolve(context, &request)?;
        let principal = plugin_principal_id(context.principal());
        let mut owner_context = Value::Null;
        if let Some(preflight) = &self.cap.preflight {
            let prepare = self
                .shared
                .runtime
                .resolve(
                    preflight,
                    &self.shared.project,
                    &principal,
                    Some(&request.binding.provider),
                )
                .map_err(unavailable)?;
            let args = encode(PluginPreflightRequest {
                capability: self.cap.capability.clone(),
                arguments: request.arguments.clone(),
                target: request.binding.target.clone(),
                preconditions: request.preconditions.clone(),
            })?;
            let response = prepare
                .call(PluginCall {
                    request: request_id(),
                    binding: prepare.binding(request.binding.target.clone()),
                    principal: principal.clone(),
                    scopes: context.scopes.clone(),
                    arguments: args,
                    preconditions: Value::Null,
                    owner_context: Value::Null,
                    operation_id: None,
                })
                .await
                .map_err(unavailable)?;
            let RpcBody::QueryResult {
                data,
                completeness: ObservationCompleteness::Complete,
                source,
            } = response
            else {
                return Err(OperationError::Unavailable(
                    "Owner preflight did not produce a complete qualification".into(),
                ));
            };
            if let Some(reference) = source {
                self.shared
                    .resources
                    .verify(&self.shared.project, &principal, &reference)
                    .await
                    .map_err(OperationError::Unavailable)?;
            }
            let prepared: PluginPreflightResult = serde_json::from_value(data)
                .map_err(|e| OperationError::Contract(e.to_string()))?;
            if request.binding.target.is_some() && request.binding.target != prepared.target {
                return Err(OperationError::TargetResolution(
                    "Owner preflight changed the selected native target".into(),
                ));
            }
            crate::runtime::validate_value(
                &self.cap.input_schema,
                &prepared.arguments,
                "prepared input",
            )
            .map_err(unavailable)?;
            request.arguments = prepared.arguments;
            request.binding.target = prepared.target;
            owner_context = prepared.owner_context;
        }
        target(&request.binding)?.validate()?;
        Ok(Some(Arc::new(BoundHandler {
            shared: self.shared.clone(),
            descriptor: self.descriptor.clone(),
            request,
            lease,
            principal,
            scopes: context.scopes.clone(),
            owner_context,
        })))
    }
}

struct BoundHandler {
    shared: Arc<BridgeContext>,
    descriptor: host::CapabilityDescriptor,
    request: PluginRequest,
    lease: Arc<ProviderLease>,
    principal: PrincipalId,
    scopes: std::collections::BTreeSet<String>,
    owner_context: Value,
}
struct PluginExecutionLease {
    shared: Arc<BridgeContext>,
    _provider: Arc<ProviderLease>,
    operation: String,
    binding: ProviderBinding,
}
#[async_trait]
impl ExecutionLease for PluginExecutionLease {
    async fn completed(&mut self, result: &Result<host::OperationRecord, OperationError>) {
        if let Ok(record) = result
            && record.operation.operation_id.as_str() == self.operation
            && let Ok(settlement) = settlement(record, self.binding.clone())
        {
            // Keep the provider lease through bounded confirmation. A lost reply
            // preserves the original reference for explicit reconciliation; it
            // cannot change an already committed scientific result.
            let _ = self.shared.runtime.settle_operation(settlement).await;
        }
    }
}
#[async_trait]
impl OperationHandler for BoundHandler {
    fn descriptor(&self) -> &host::CapabilityDescriptor {
        &self.descriptor
    }
    fn idempotency_scope(&self) -> Option<String> {
        Some(self.shared.scope.clone())
    }
    fn execution_context(&self) -> Value {
        json!({"binding":self.request.binding,"qualification":self.owner_context})
    }
    fn normalize_arguments(&self, _: &Value) -> Result<Value, OperationError> {
        encode(&self.request)
    }
    fn resolve_target(&self, _: &Value) -> Result<host::TargetRef, OperationError> {
        target(&self.request.binding)
    }
    fn admitted(&self, operation: &host::Operation) -> Result<(), HandlerError> {
        self.shared
            .runtime
            .hold_operation(
                &self.request.binding.provider,
                operation.operation_id.as_str(),
            )
            .map_err(|e| HandlerError::before_effect(e.to_string()))
    }
    async fn acquire_execution(
        &self,
        operation: &host::Operation,
        _: tokio::sync::watch::Receiver<bool>,
    ) -> Result<Box<dyn ExecutionLease>, HandlerError> {
        Ok(Box::new(PluginExecutionLease {
            shared: self.shared.clone(),
            _provider: self.lease.clone(),
            operation: operation.operation_id.as_str().to_owned(),
            binding: self.request.binding.clone(),
        }))
    }
    async fn execute(&self, operation: &host::Operation) -> Result<CommitPlan, HandlerError> {
        let (_sender, receiver) = tokio::sync::watch::channel(false);
        self.execute_controlled(operation, receiver).await
    }
    async fn execute_controlled(
        &self,
        operation: &host::Operation,
        mut cancellation: tokio::sync::watch::Receiver<bool>,
    ) -> Result<CommitPlan, HandlerError> {
        if *cancellation.borrow() {
            return Ok(CommitPlan::cancelled_before_start());
        }
        let call = PluginCall {
            request: request_id(),
            binding: self.request.binding.clone(),
            principal: self.principal.clone(),
            scopes: self.scopes.clone(),
            arguments: self.request.arguments.clone(),
            preconditions: self.request.preconditions.clone(),
            owner_context: self.owner_context.clone(),
            operation_id: Some(operation.operation_id.as_str().to_owned()),
        };
        let response = self.lease.call(call);
        tokio::pin!(response);
        let reply = tokio::select! {
            biased;
            result = &mut response => result,
            _ = rho_operation::wait_cancellation(&mut cancellation) => {
                // A request/ack is not terminal truth. Always await the original
                // invocation's owner result, including when cancellation fails.
                tokio::select! {
                    biased;
                    result = &mut response => result,
                    _ = self.lease.cancel(operation.operation_id.as_str()) => response.await,
                }
            }
        };
        let reply = match reply {
            Ok(reply) => reply,
            Err(PluginError::InvalidResponse { message, response }) => {
                return Err(self.boundary_error(operation, message, Some(*response)));
            }
            Err(error) => return Err(self.boundary_error(operation, error.to_string(), None)),
        };
        match reply {
            RpcBody::CommitPlan(plan) => {
                // A plan may mention the same immutable output more than once.
                // Verify identical references once; differing claims still undergo
                // their own authoritative check and cannot reuse that result.
                let mut verified = std::collections::BTreeSet::new();
                for reference in &plan.evidence {
                    if !verified.insert(serde_json::to_string(reference).expect("resource reference serializes")) { continue; }
                    if let Err(error) = self
                        .shared
                        .resources
                        .verify(&self.shared.project, &self.principal, reference)
                        .await
                    {
                        return Err(self.boundary_error(
                            operation,
                            error,
                            Some(RpcBody::CommitPlan(plan)),
                        ));
                    }
                }
                let verified_at_ms = SystemClock.now_ms().map_err(|error| {
                    self.boundary_error(
                        operation,
                        error.to_string(),
                        Some(RpcBody::CommitPlan(plan.clone())),
                    )
                })?;
                if plan.facts.iter().any(|fact| {
                    [&fact.schema, &fact.key]
                        .iter()
                        .any(|s| s.is_empty() || s.len() > 512 || s.trim() != s.as_str())
                }) {
                    return Err(self.boundary_error(
                        operation,
                        "Invalid native fact identity".into(),
                        Some(RpcBody::CommitPlan(plan)),
                    ));
                }
                let facts = plan.facts.into_iter().map(|fact| DomainFactMutation {domain:"plugin".into(), schema:"plugin.fact.v1".into(),
                    key:format!("{}:{:x}", self.request.binding.provider.instance, Sha256::digest(serde_json::to_vec(&(&fact.schema, &fact.key)).unwrap())),
                    value:json!({"owner":self.request.binding.provider,"schema":fact.schema,"key":fact.key,"value":fact.value})}).collect();
                Ok(CommitPlan {
                    outcome: match plan.outcome {
                        PluginOutcome::Succeeded => host::OperationOutcome::Succeeded,
                        PluginOutcome::Failed => host::OperationOutcome::Failed,
                        PluginOutcome::Uncertain => host::OperationOutcome::Uncertain,
                        PluginOutcome::Cancelled => host::OperationOutcome::Cancelled,
                    },
                    output: plan.output,
                    error: plan.error,
                    recovery: plan.recovery.map(owner_recovery),
                    facts,
                    effect_observations: if plan.evidence.is_empty() {
                        vec![]
                    } else {
                        vec![host::EffectObservation {
                            kind: "plugin.evidence".into(),
                            source: self.request.binding.provider.instance.to_string(),
                            detail: json!({"binding":self.request.binding,"references":plan.evidence}),
                            observed_at_ms: verified_at_ms,
                            completeness: host::ObservationCompleteness::Complete,
                        }]
                    },
                    events: vec![],
                    uncommitted_evidence: None,
                })
            }
            other => Err(self.boundary_error(
                operation,
                "Backend did not return a commit plan".into(),
                Some(other),
            )),
        }
    }
}
impl BoundHandler {
    fn boundary_error(
        &self,
        operation: &host::Operation,
        message: String,
        candidate: Option<RpcBody>,
    ) -> HandlerError {
        HandlerError::after_possible_effect(
            message.clone(),
            Some(json!({"kind":"plugin_boundary_failure",
            "binding":self.request.binding,"operation_id":operation.operation_id,"message":message,"candidate":candidate})),
        )
    }
}

#[async_trait]
impl ControlHandler for RoutingHandler {
    fn descriptor(&self) -> &host::CapabilityDescriptor { &self.descriptor }
    async fn control(&self, context: &host::CallContext, value: Value) -> Result<Value, OperationError> {
        let request = self.request(&value).map_err(|_| OperationError::InvalidInput("Control binding or arguments are invalid (redacted)".into()))?;
        let lease = self.resolve(context, &request)?;
        let reply = lease.call(PluginCall {
            request: request_id(), binding: request.binding,
            principal: plugin_principal_id(context.principal()), scopes: context.scopes.clone(),
            arguments: request.arguments, preconditions: request.preconditions,
            owner_context: Value::Null, operation_id: None,
        }).await.map_err(|_| OperationError::Unavailable("Control completion is unconfirmed; inspect the original native request (arguments redacted)".into()))?;
        match reply {
            RpcBody::ControlResult { data } => Ok(data),
            _ => Err(OperationError::Unavailable("The bound owner did not confirm control; inspect its current request (arguments redacted)".into())),
        }
    }
}

#[async_trait]
impl QueryHandler for RoutingHandler {
    fn descriptor(&self) -> &host::CapabilityDescriptor {
        &self.descriptor
    }
    fn normalize_arguments(&self, value: &Value) -> Result<Value, OperationError> {
        encode(self.request(value)?)
    }
    async fn query(&self, _: &Value) -> Result<host::QuerySnapshot, OperationError> {
        Err(OperationError::Unavailable(
            "Plugin queries require authenticated caller context".into(),
        ))
    }
    async fn query_for(
        &self,
        context: &host::CallContext,
        value: &Value,
    ) -> Result<host::QuerySnapshot, OperationError> {
        let request = self.request(value)?;
        let lease = self.resolve(context, &request)?;
        let principal = plugin_principal_id(context.principal());
        let reply = lease
            .call(PluginCall {
                request: request_id(),
                binding: request.binding.clone(),
                principal: principal.clone(),
                scopes: context.scopes.clone(),
                arguments: request.arguments,
                preconditions: request.preconditions,
                owner_context: Value::Null,
                operation_id: None,
            })
            .await
            .map_err(unavailable)?;
        let RpcBody::QueryResult {
            data,
            completeness,
            source,
        } = reply
        else {
            return Err(OperationError::Unavailable(
                "Backend query did not return an observation".into(),
            ));
        };
        if let Some(reference) = &source {
            self.shared
                .resources
                .verify(&self.shared.project, &principal, reference)
                .await
                .map_err(OperationError::Unavailable)?;
        }
        Ok(host::QuerySnapshot {
            target: target(&request.binding)?,
            source: serde_json::to_string(&json!({"binding":request.binding,"resource":source}))
                .unwrap(),
            observed_at_ms: SystemClock.now_ms()?,
            status: match completeness {
                ObservationCompleteness::Unavailable => host::QueryStatus::Unavailable,
                ObservationCompleteness::Cached => host::QueryStatus::Busy,
                _ => host::QueryStatus::Ready,
            },
            completeness: match completeness {
                ObservationCompleteness::Complete => host::ObservationCompleteness::Complete,
                ObservationCompleteness::Partial | ObservationCompleteness::Cached => {
                    host::ObservationCompleteness::Partial
                }
                ObservationCompleteness::Unavailable => host::ObservationCompleteness::Unknown,
            },
            data: Some(data),
            notices: if completeness == ObservationCompleteness::Cached {
                vec!["Cached observation from this provider".into()]
            } else {
                vec![]
            },
            next_reads: vec![],
            diagnostics: vec![],
        })
    }
}

fn descriptor(
    cap: &CapabilityContribution,
    project: &ProjectId,
) -> Result<host::CapabilityDescriptor, OperationError> {
    let mut input = schemars::schema_for!(PluginRequest).to_value();
    input["x-rho-plugin-contract"] =
        json!({"kind":cap.kind,"effects":cap.effects,"preflight":cap.preflight});
    input["$defs"]["ScientificArguments"] =
        host::rebase_local_schema(cap.input_schema.clone(), "/$defs/ScientificArguments");
    input["properties"]["arguments"] = json!({"$ref":"#/$defs/ScientificArguments"});
    let recovery = json!({"$defs":{"NativeRecovery":host::rebase_local_schema(cap.recovery_schema.clone(),"/$defs/NativeRecovery")},"anyOf":[
        {"type":"null"}, {"type":"object","required":["kind","data"],"additionalProperties":false,"properties":{
            "kind":{"const":"plugin_owner_recovery"},"data":{"$ref":"#/$defs/NativeRecovery"}}},
        {"type":"object","required":["kind","binding","operation_id","message","candidate"],"properties":{"kind":{"const":"plugin_boundary_failure"}}}]});
    let query = cap.kind == CapabilityKind::Query;
    let control = cap.kind == CapabilityKind::Control;
    let placeholder = json!({"capability":cap.capability,"project":project,"target":null,"provider":{
        "instance":"select-instance","plugin":"select.plugin","revision":format!("sha256:{}","0".repeat(64)),
        "artifact":format!("sha256:{}","0".repeat(64))}});
    let version = u16::try_from(cap.capability.version).map_err(|_| {
        OperationError::Contract("Capability version exceeds Host protocol range".into())
    })?;
    Ok(host::CapabilityDescriptor {capability:host::CapabilityRef::new(cap.capability.id.as_str(),version)?,
        kind:if query {host::CapabilityKind::Query}else if control {host::CapabilityKind::Control}else{host::CapabilityKind::Operation}, domain:"plugin".into(), input_schema:input,
        output_schema:cap.output_schema.clone(), recovery_schema:recovery, required_scopes:cap.required_scopes.clone(),
        potential_effects:if cap.effects.is_empty() {Default::default()} else {[host::EffectHint::PluginDefined].into()},
        idempotency:if query {host::IdempotencyClass::Pure}else{host::IdempotencyClass::CallerScoped},
        retry:if query {host::RetryClass::Safe}else{host::RetryClass::ReconcileFirst},
        cancellation:if cap.cancellation==CancellationSupport::Request {host::CancellationClass::Cooperative}else{host::CancellationClass::Unsupported},
        documentation:host::CapabilityDocumentation {summary:cap.title.clone(), purpose:cap.description.clone(), owner:"Bound plugin instance".into(),
            effects:format!("Declared plugin effects: {:?}",cap.effects), when_to_use:vec![cap.description.clone()],
            limitations:vec!["Select an exact provider from the current project and authenticated principal. Examples contain placeholder identities.".into()],
            retry_rule:if control {"Controls are ephemeral and are not journaled. Inspect the existing native request after lost acknowledgement; reuse its owner-defined reply identity only when the owner permits it.".into()} else {"Inspect the original operation before retrying. Reuse its client request ID to read the original result.".into()},
            cancellation_rule:"Cancellation is a request; the native owner's terminal result confirms its outcome.".into(),
            preconditions:vec![], examples:cap.examples.iter().map(|arguments| host::CapabilityExample {arguments:json!({"binding":placeholder,"arguments":arguments,"preconditions":null}),
                result_explanation:"Replace the provider placeholder with an observed binding; the result follows the declared output schema.".into()}).collect(),
            related_capabilities:vec![], related_skills:vec![], position_units:vec![]}})
}
fn target(binding: &ProviderBinding) -> Result<host::TargetRef, OperationError> {
    Ok(host::TargetRef {
        kind: "plugin".into(),
        identity: format!(
            "{}:{}",
            binding.provider.instance,
            binding.target.as_deref().unwrap_or("instance")
        ),
    })
}
fn encode(value: impl serde::Serialize) -> Result<Value, OperationError> {
    serde_json::to_value(value).map_err(|e| OperationError::Contract(e.to_string()))
}
fn request_id() -> RequestId {
    RequestId::new(format!("call-{}", uuid::Uuid::new_v4().simple())).unwrap()
}
fn unavailable(error: PluginError) -> OperationError {
    OperationError::Unavailable(error.to_string())
}
fn owner_recovery(data: Value) -> Value {
    json!({"kind":"plugin_owner_recovery","data":data})
}

fn settlement(record: &host::OperationRecord, binding: ProviderBinding) -> Result<OperationSettlement, OperationError> {
    let outcome = match record.status {
        host::OperationStatus::Succeeded => PluginOutcome::Succeeded,
        host::OperationStatus::Failed => PluginOutcome::Failed,
        host::OperationStatus::Uncertain => PluginOutcome::Uncertain,
        host::OperationStatus::Cancelled => PluginOutcome::Cancelled,
        _ => return Err(OperationError::LifecycleConflict("Operation has no authoritative terminal result".into())),
    };
    Ok(OperationSettlement { operation_id: record.operation.operation_id.clone(), binding, outcome })
}
