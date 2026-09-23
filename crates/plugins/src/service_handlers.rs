use crate::{service::*, *};
use async_trait::async_trait;
use rho_contract as host;
use rho_operation::*;
use rho_plugin_protocol::*;
use schemars::{JsonSchema, schema_for};
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use serde_json::{Value, json};
use std::{collections::BTreeSet, sync::Arc};

fn decode<T: DeserializeOwned>(value: &Value) -> Result<T, OperationError> {
    serde_json::from_value(value.clone()).map_err(invalid)
}
fn normalize<T: DeserializeOwned + Serialize>(value: &Value) -> Result<Value, OperationError> {
    serde_json::to_value(decode::<T>(value)?).map_err(invalid)
}
fn key(id: &str) -> host::CapabilityRef {
    host::CapabilityRef::new(id, 1).unwrap()
}
fn item(value: InstalledPluginRevision) -> PluginCatalogItem {
    PluginCatalogItem {
        revision: value.revision,
        plugin: value.plugin,
        name: value.name,
        version: value.version,
        description: value.description,
        artifacts: value.artifacts,
        reference_count: value.references.len() as u64,
    }
}
#[derive(Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
struct Empty {}
#[derive(Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
struct Reconcile {
    operation_id: host::OperationId,
}

pub(crate) fn register(
    service: &Arc<PluginService>,
    registry: &mut CapabilityRegistry,
) -> Result<(), OperationError> {
    for id in [
        "plugins.repository",
        "plugins.list",
        "plugins.inspect",
        "plugins.instances",
        "plugins.instance",
        "plugins.resolve",
        "plugins.branch_head",
        "plugins.compare",
    ] {
        registry.register_query(Arc::new(Read {
            service: service.clone(),
            descriptor: descriptor(id),
            id,
        }))?;
    }
    for id in [
        "plugins.activate",
        "plugins.release",
        "plugins.remove",
        "plugins.branch",
        "plugins.advance_branch",
        "plugins.reconcile_references",
    ] {
        registry.register(Arc::new(Manage {
            service: service.clone(),
            descriptor: descriptor(id),
            id,
            bound: None,
        }))?;
    }
    Ok(())
}
fn descriptor(id: &str) -> host::CapabilityDescriptor {
    let (input, output, example, summary, operation, scope) = match id {
        "plugins.repository" => (
            schema_for!(Empty).to_value(),
            json!({"type":"object","required":["root","project","backend_target"],"properties":{"root":{"type":"string"},"project":{"type":"string"},"backend_target":{"type":"string"}},"additionalProperties":false}),
            json!({}),
            "Inspect this Host's package repository",
            false,
            PLUGINS_READ_SCOPE,
        ),
        "plugins.list" => (
            schema_for!(PluginCatalogArguments).to_value(),
            schema_for!(PluginCatalogPage).to_value(),
            json!({"after":null,"limit":20}),
            "List installed immutable plugin revisions",
            false,
            PLUGINS_READ_SCOPE,
        ),
        "plugins.inspect" => (
            schema_for!(PluginRevisionArguments).to_value(),
            schema_for!(PluginInspection).to_value(),
            json!({"revision":digest()}),
            "Inspect a plugin's manifest and build artifacts",
            false,
            PLUGINS_READ_SCOPE,
        ),
        "plugins.instances" => (
            schema_for!(PluginInstancesArguments).to_value(),
            schema_for!(PluginInstanceObservations).to_value(),
            json!({"after":null,"limit":20}),
            "Observe this principal's project plugin instances",
            false,
            PLUGINS_READ_SCOPE,
        ),
        "plugins.instance" => (
            schema_for!(PluginInstanceArguments).to_value(),
            schema_for!(PluginInstanceObservation).to_value(),
            json!({"instance":instance()}),
            "Inspect one exact plugin instance and bounded logs",
            false,
            PLUGINS_READ_SCOPE,
        ),
        "plugins.resolve" => (
            schema_for!(PluginResolveArguments).to_value(),
            schema_for!(ProviderBinding).to_value(),
            json!({"capability":{"id":"example.read","version":1},"instance":null,"target":null}),
            "Resolve an unambiguous active plugin provider",
            false,
            PLUGINS_READ_SCOPE,
        ),
        "plugins.branch_head" => (
            schema_for!(PluginBranchArguments).to_value(),
            json!({"type":"object","properties":{"revision":{"type":"string"}},"required":["revision"],"additionalProperties":false}),
            json!({"branch":"branch-example"}),
            "Read a development branch's exact head",
            false,
            PLUGINS_READ_SCOPE,
        ),
        "plugins.compare" => (
            schema_for!(ComparePluginRevisions).to_value(),
            schema_for!(RevisionDifference).to_value(),
            json!({"before":digest(),"after":digest()}),
            "Compare immutable source revisions",
            false,
            PLUGINS_READ_SCOPE,
        ),
        "plugins.activate" => (
            schema_for!(ActivatePlugin).to_value(),
            schema_for!(PluginInstanceObservation).to_value(),
            json!({"revision":digest(),"artifact":digest(),"target":backend_target(),"alias":"example","configuration":{}}),
            "Activate an exact installed backend artifact",
            true,
            PLUGINS_RUN_SCOPE,
        ),
        "plugins.release" => (
            schema_for!(PluginInstanceArguments).to_value(),
            schema_for!(PluginInstanceObservation).to_value(),
            json!({"instance":instance()}),
            "Drain and release one exact plugin instance",
            true,
            PLUGINS_RUN_SCOPE,
        ),
        "plugins.remove" => (
            schema_for!(PluginRevisionArguments).to_value(),
            json!({"type":"object","properties":{"removed":{"type":"string"}},"required":["removed"],"additionalProperties":false}),
            json!({"revision":digest()}),
            "Remove an unreferenced plugin revision",
            true,
            PLUGINS_WRITE_SCOPE,
        ),
        "plugins.branch" => (
            schema_for!(BranchPlugin).to_value(),
            json!({"type":"object","properties":{"branch":{"type":"string"}},"required":["branch"],"additionalProperties":false}),
            json!({"revision":digest(),"name":"Experiment"}),
            "Branch an immutable plugin revision",
            true,
            PLUGINS_WRITE_SCOPE,
        ),
        "plugins.advance_branch" => (
            schema_for!(AdvancePluginBranch).to_value(),
            json!({"type":"object","properties":{"revision":{"type":"string"}},"required":["revision"],"additionalProperties":false}),
            json!({"branch":"branch-example","expected":digest(),"next":digest()}),
            "Advance a plugin branch by compare-and-swap",
            true,
            PLUGINS_WRITE_SCOPE,
        ),
        "plugins.reconcile_references" => (
            schema_for!(Reconcile).to_value(),
            json!({"type":"object","properties":{"operation_id":{"type":"string"},"reconciled":{"const":true}},"required":["operation_id","reconciled"],"additionalProperties":false}),
            json!({"operation_id":"operation-example"}),
            "Release protections from an original terminal operation",
            true,
            PLUGINS_RUN_SCOPE,
        ),
        _ => unreachable!(),
    };
    host::CapabilityDescriptor {
        kind:if operation {host::CapabilityKind::Operation}else{host::CapabilityKind::Query},capability:key(id),domain:"plugins".into(),input_schema:input,output_schema:output,recovery_schema:json!({"type":["object","null"]}),
        required_scopes:BTreeSet::from([scope.into()]),potential_effects:match id {"plugins.activate"=>BTreeSet::from([host::EffectHint::MaySpawnProcess,host::EffectHint::MayMutateRuntime]),"plugins.release"=>BTreeSet::from([host::EffectHint::MayMutateRuntime]),_=>BTreeSet::new()},
        idempotency:if operation {host::IdempotencyClass::CallerScoped}else{host::IdempotencyClass::Pure},retry:if operation {host::RetryClass::ReconcileFirst}else{host::RetryClass::Safe},cancellation:host::CancellationClass::Unsupported,
        documentation:host::CapabilityDocumentation {
            summary:summary.into(),purpose:summary.into(),when_to_use:vec!["Manage or observe ordinary installed packages through the shared Host ports.".into()],
            limitations:vec!["Installed source does not activate itself. Revisions, artifacts, project and principal identities remain explicit; no package origin receives special privileges.".into(),"Historical instance state does not establish a live process. Release failure or draining does not confirm cleanup; inspect the exact original instance.".into(),"Native artifacts and build scripts are trusted local code; process isolation is not an OS filesystem/network sandbox.".into()],
            owner:"plugins".into(),effects:if operation {"Only the named package/lifecycle change. Scientific work and its journal remain with the existing Operation gateway.".into()}else{"Read-only bounded observation. Does not start a process, install, reconnect or recover work.".into()},
            retry_rule:if operation {"Retain client_request_id and inspect the original Operation after lost acknowledgement. Do not repeat activation to discover whether it started.".into()}else{"Repeat the same observation; follow explicit page cursors.".into()},
            cancellation_rule:"Disconnect does not undo lifecycle work or confirm process cleanup.".into(),preconditions:vec![],examples:vec![host::CapabilityExample{arguments:example,result_explanation:"Exact immutable identities and native lifecycle observations; no authority is inferred from package content.".into()}],
            related_capabilities:vec![key("plugins.list"),key("plugins.instances")],related_skills:vec![],position_units:vec!["Offsets and byte bounds are bytes, not tokens. Page item limits are 1–100.".into()],
        },
    }
}
fn digest() -> String {
    format!("sha256:{}", "0".repeat(64))
}
fn instance() -> Value {
    json!({"instance":"plugin-example","plugin":"example.plugin","revision":digest(),"artifact":digest()})
}
fn normalized(id: &str, value: &Value) -> Result<Value, OperationError> {
    match id {
        "plugins.repository" => normalize::<Empty>(value),
        "plugins.list" => normalize::<PluginCatalogArguments>(value),
        "plugins.inspect" | "plugins.remove" => normalize::<PluginRevisionArguments>(value),
        "plugins.instances" => normalize::<PluginInstancesArguments>(value),
        "plugins.instance" | "plugins.release" => normalize::<PluginInstanceArguments>(value),
        "plugins.resolve" => normalize::<PluginResolveArguments>(value),
        "plugins.branch_head" => normalize::<PluginBranchArguments>(value),
        "plugins.compare" => normalize::<ComparePluginRevisions>(value),
        "plugins.activate" => normalize::<ActivatePlugin>(value),
        "plugins.branch" => normalize::<BranchPlugin>(value),
        "plugins.advance_branch" => normalize::<AdvancePluginBranch>(value),
        "plugins.reconcile_references" => normalize::<Reconcile>(value),
        _ => unreachable!(),
    }
}
struct Read {
    service: Arc<PluginService>,
    descriptor: host::CapabilityDescriptor,
    id: &'static str,
}
#[async_trait]
impl QueryHandler for Read {
    fn descriptor(&self) -> &host::CapabilityDescriptor {
        &self.descriptor
    }
    fn normalize_arguments(&self, value: &Value) -> Result<Value, OperationError> {
        normalized(self.id, value)
    }
    async fn query(&self, _: &Value) -> Result<host::QuerySnapshot, OperationError> {
        Err(invalid("caller context required"))
    }
    async fn query_for(
        &self,
        context: &host::CallContext,
        value: &Value,
    ) -> Result<host::QuerySnapshot, OperationError> {
        let service = &self.service;
        let data = match self.id {
            "plugins.repository" => {
                json!({"root":service.repository.lock().unwrap().root(),"project":service.project,"backend_target":backend_target()})
            }
            "plugins.list" => {
                let args: PluginCatalogArguments = decode(value)?;
                let page = service
                    .repository
                    .lock()
                    .unwrap()
                    .list_page(args.after.as_ref(), args.limit as usize)
                    .map_err(error)?;
                json!(PluginCatalogPage {
                    items: page.revisions.into_iter().map(item).collect(),
                    next: page.next,
                    total: page.total
                })
            }
            "plugins.inspect" => {
                let args: PluginRevisionArguments = decode(value)?;
                let repo = service.repository.lock().unwrap();
                let summary = repo.inspect(&args.revision).map_err(error)?;
                let revision = repo.revision(&args.revision).map_err(error)?;
                let artifacts = summary
                    .artifacts
                    .iter()
                    .map(|id| {
                        repo.artifact(id).map(|a| PluginArtifactSummary {
                            id: a.id,
                            target: a.target,
                            file_count: a.files.len() as u64,
                        })
                    })
                    .collect::<Result<Vec<_>, _>>()
                    .map_err(error)?;
                json!(PluginInspection {
                    summary: item(summary),
                    manifest: revision.manifest,
                    parent: revision.parent,
                    source_file_count: revision.files.len() as u64,
                    artifacts
                })
            }
            "plugins.instances" => {
                let args: PluginInstancesArguments = decode(value)?;
                let principal = plugin_principal_id(context.principal());
                let page = service
                    .repository
                    .lock()
                    .unwrap()
                    .recorded_instances_scoped(
                        args.after.as_ref(),
                        args.limit as usize,
                        Some((&service.project, &principal)),
                    )
                    .map_err(error)?;
                let instances = page
                    .instances
                    .iter()
                    .map(|i| service.observe_instance(context, &i.identity, false))
                    .collect::<Result<Vec<_>, _>>()?;
                json!(PluginInstanceObservations {
                    instances,
                    next: page.next,
                    total: page.total
                })
            }
            "plugins.instance" => json!(service.observe_instance(
                context,
                &decode::<PluginInstanceArguments>(value)?.instance,
                true
            )?),
            "plugins.resolve" => {
                let args: PluginResolveArguments = decode(value)?;
                let lease = service
                    .runtime
                    .resolve(
                        &args.capability,
                        &service.project,
                        &plugin_principal_id(context.principal()),
                        args.instance.as_ref(),
                    )
                    .map_err(error)?;
                json!(lease.binding(args.target))
            }
            "plugins.branch_head" => {
                json!({"revision":service.repository.lock().unwrap().branch_head(&decode::<PluginBranchArguments>(value)?.branch).map_err(error)?})
            }
            "plugins.compare" => {
                let args: ComparePluginRevisions = decode(value)?;
                json!(
                    service
                        .repository
                        .lock()
                        .unwrap()
                        .compare(&args.before, &args.after)
                        .map_err(error)?
                )
            }
            _ => unreachable!(),
        };
        Ok(host::QuerySnapshot {
            target: host::TargetRef {
                kind: "plugin_repository".into(),
                identity: service.scope.clone(),
            },
            source: "plugins/repository-and-native-lifecycle".into(),
            observed_at_ms: SystemClock.now_ms()?,
            status: host::QueryStatus::Ready,
            completeness: host::ObservationCompleteness::Complete,
            notices: vec![],
            next_reads: vec![],
            diagnostics: vec![],
            data: Some(data),
        })
    }
}
struct Bound {
    context: host::CallContext,
    target: host::TargetRef,
    revision: Option<RevisionId>,
    grants: Vec<CapabilityRequirement>,
}
struct Manage {
    service: Arc<PluginService>,
    descriptor: host::CapabilityDescriptor,
    id: &'static str,
    bound: Option<Bound>,
}
#[async_trait]
impl OperationHandler for Manage {
    fn descriptor(&self) -> &host::CapabilityDescriptor {
        &self.descriptor
    }
    fn idempotency_scope(&self) -> Option<String> {
        Some(self.service.scope.clone())
    }
    fn normalize_arguments(&self, value: &Value) -> Result<Value, OperationError> {
        normalized(self.id, value)
    }
    fn resolve_target(&self, _: &Value) -> Result<host::TargetRef, OperationError> {
        Ok(self
            .bound
            .as_ref()
            .map(|b| b.target.clone())
            .unwrap_or(host::TargetRef {
                kind: "plugin_repository".into(),
                identity: self.service.scope.clone(),
            }))
    }
    fn execution_context(&self) -> Value {
        json!({"managed_revision":self.bound.as_ref().and_then(|b|b.revision.as_ref())})
    }
    async fn bind(
        &self,
        context: &host::CallContext,
        value: &Value,
        preconditions: &[host::Precondition],
    ) -> Result<Option<Arc<dyn OperationHandler>>, OperationError> {
        if !preconditions.is_empty() {
            return Err(invalid(
                "plugin lifecycle uses exact artifact/instance/branch arguments, not unrelated native preconditions",
            ));
        }
        let mut revision = None;
        let mut grants = vec![];
        let mut target = host::TargetRef {
            kind: "plugin_repository".into(),
            identity: self.service.scope.clone(),
        };
        match self.id {
            "plugins.activate" => {
                let args: ActivatePlugin = decode(value)?;
                if args.target != backend_target() {
                    return Err(invalid("artifact target does not match this local Host"));
                }
                let repo = self.service.repository.lock().unwrap();
                let stored = repo.revision(&args.revision).map_err(error)?;
                let artifact = repo.artifact(&args.artifact).map_err(error)?;
                if artifact.revision != args.revision || artifact.target != args.target {
                    return Err(invalid(
                        "artifact does not belong to the selected revision and target",
                    ));
                }
                crate::runtime::validate_value(
                    &stored.manifest.configuration_schema,
                    &args.configuration,
                    "configuration",
                )
                .map_err(error)?;
                let registry = self.service.registry()?;
                for grant in &stored.manifest.requires {
                    let capability = host::CapabilityRef::new(
                        grant.capability.id.as_str(),
                        grant.capability.version.try_into().map_err(invalid)?,
                    )?;
                    let descriptor = registry.descriptor(&capability).ok_or_else(|| {
                        OperationError::UnknownCapability(capability.display_key())
                    })?;
                    if descriptor.kind == host::CapabilityKind::Control
                        || !descriptor.required_scopes.is_subset(&grant.scopes)
                        || !grant.scopes.is_subset(&context.scopes)
                    {
                        return Err(OperationError::AccessDenied {capability:capability.display_key(),missing:vec!["declared grant must fit the existing caller authority and selected non-control contract".into()]});
                    }
                }
                revision = Some(args.revision);
                grants = stored.manifest.requires;
                target = host::TargetRef {
                    kind: "plugin_instance".into(),
                    identity: format!("plugin-{}", uuid::Uuid::new_v4().simple()),
                };
            }
            "plugins.release" => {
                let args: PluginInstanceArguments = decode(value)?;
                let observation = self
                    .service
                    .observe_instance(context, &args.instance, false)?;
                if !observation.observed_in_this_host
                    && observation.instance.state != InstanceState::Released
                {
                    return Err(error(
                        "instance belongs to an ended Host; cleanup is not established by its historical record",
                    ));
                }
                if observation.instance.state != InstanceState::Released {
                    revision = Some(args.instance.revision);
                }
                target = host::TargetRef {
                    kind: "plugin_instance".into(),
                    identity: args.instance.instance.to_string(),
                };
            }
            "plugins.branch" => {
                let args: BranchPlugin = decode(value)?;
                if args.name.trim().is_empty() || args.name.len() > 128 {
                    return Err(invalid("branch name must contain 1–128 UTF-8 bytes"));
                }
                self.service
                    .repository
                    .lock()
                    .unwrap()
                    .revision(&args.revision)
                    .map_err(error)?;
                revision = Some(args.revision);
            }
            "plugins.advance_branch" => {
                let args: AdvancePluginBranch = decode(value)?;
                if self
                    .service
                    .repository
                    .lock()
                    .unwrap()
                    .branch_head(&args.branch)
                    .map_err(error)?
                    != args.expected
                {
                    return Err(OperationError::ContentChanged("branch head changed".into()));
                }
                revision = Some(args.next);
            }
            "plugins.remove" => {
                self.service
                    .repository
                    .lock()
                    .unwrap()
                    .revision(&decode::<PluginRevisionArguments>(value)?.revision)
                    .map_err(error)?;
            }
            "plugins.reconcile_references" => {
                let args: Reconcile = decode(value)?;
                host::OperationId::new(args.operation_id.as_str())?;
            }
            _ => unreachable!(),
        }
        Ok(Some(Arc::new(Self {
            service: self.service.clone(),
            descriptor: self.descriptor.clone(),
            id: self.id,
            bound: Some(Bound {
                context: context.clone(),
                target,
                revision,
                grants,
            }),
        })))
    }
    fn admitted(&self, operation: &host::Operation) -> Result<(), HandlerError> {
        if let Some(revision) = self.bound.as_ref().and_then(|b| b.revision.as_ref()) {
            self.service
                .repository
                .lock()
                .unwrap()
                .retain("management", operation.operation_id.as_str(), revision)
                .map_err(|e| HandlerError::before_effect(e.to_string()))?;
        }
        Ok(())
    }
    async fn acquire_execution(
        &self,
        operation: &host::Operation,
        _: tokio::sync::watch::Receiver<bool>,
    ) -> Result<Box<dyn ExecutionLease>, HandlerError> {
        Ok(Box::new(ManagementLease {
            service: self.service.clone(),
            operation: operation.operation_id.clone(),
            revision: self.bound.as_ref().and_then(|b| b.revision.clone()),
        }))
    }
    async fn execute(&self, operation: &host::Operation) -> Result<CommitPlan, HandlerError> {
        self.run(operation).await.map(CommitPlan::succeeded).map_err(|error| {
            let recovery=json!({"kind":"plugin_lifecycle","target":operation.target,"detail":error.to_string(),"automatic_reexecution":false});
            HandlerError::after_possible_effect(error.to_string(),Some(recovery))
        })
    }
}
struct ManagementLease {
    service: Arc<PluginService>,
    operation: host::OperationId,
    revision: Option<RevisionId>,
}
impl ExecutionLease for ManagementLease {
    fn completed(&mut self, result: &Result<host::OperationRecord, OperationError>) {
        if result.as_ref().is_ok_and(|r| r.status.is_terminal())
            && let Some(revision) = &self.revision
        {
            let _ = self.service.repository.lock().unwrap().release_reference(
                "management",
                self.operation.as_str(),
                revision,
            );
        }
    }
}
impl Manage {
    async fn run(&self, operation: &host::Operation) -> Result<Value, OperationError> {
        let bound = self
            .bound
            .as_ref()
            .ok_or_else(|| invalid("unbound lifecycle command"))?;
        let value = &operation.normalized_arguments;
        let service = &self.service;
        match self.id {
            "plugins.activate" => {
                let args: ActivatePlugin = decode(value)?;
                let _guard = service.gate.lock().await;
                let principal = plugin_principal_id(bound.context.principal());
                service
                    .services
                    .principals
                    .lock()
                    .unwrap()
                    .insert(principal.clone(), bound.context.principal().clone());
                let result = service
                    .runtime
                    .activate_identified(
                        BackendActivation {
                            revision: args.revision,
                            artifact: args.artifact,
                            target: args.target,
                            project: service.project.clone(),
                            principal,
                            alias: args.alias,
                            configuration: args.configuration,
                            grants: bound.grants.clone(),
                        },
                        PluginInstanceId::new(&bound.target.identity).map_err(error)?,
                        false,
                    )
                    .await;
                let instance = result.map_err(error)?;
                if let Err(fault) = service
                    .bridge
                    .publish(service.registry()?.as_ref(), &instance.identity)
                {
                    let _ = service.runtime.release(&instance.identity).await;
                    service.refresh_locked()?;
                    return Err(fault);
                }
                service.published();
                Ok(json!(service.observe_instance(
                    &bound.context,
                    &instance.identity,
                    false
                )?))
            }
            "plugins.release" => {
                let args: PluginInstanceArguments = decode(value)?;
                let _guard = service.gate.lock().await;
                let observation =
                    service.observe_instance(&bound.context, &args.instance, false)?;
                if observation.instance.state == InstanceState::Released {
                    return Ok(json!(observation));
                }
                let result = service.runtime.release(&args.instance).await;
                service.refresh_locked()?;
                result.map_err(error)?;
                Ok(json!(service.observe_instance(
                    &bound.context,
                    &args.instance,
                    false
                )?))
            }
            "plugins.remove" => {
                let args: PluginRevisionArguments = decode(value)?;
                service
                    .repository
                    .lock()
                    .unwrap()
                    .remove(&args.revision)
                    .map_err(|fault| match fault {
                        PluginError::Referenced(refs) => error(format!(
                            "revision is protected by {} references",
                            refs.len()
                        )),
                        other => error(other),
                    })?;
                Ok(json!({"removed":args.revision}))
            }
            "plugins.branch" => {
                let args: BranchPlugin = decode(value)?;
                Ok(
                    json!({"branch":service.repository.lock().unwrap().create_branch(&args.revision,&args.name).map_err(error)?}),
                )
            }
            "plugins.advance_branch" => {
                let args: AdvancePluginBranch = decode(value)?;
                service
                    .repository
                    .lock()
                    .unwrap()
                    .advance_branch(&args.branch, &args.expected, &args.next)
                    .map_err(error)?;
                Ok(json!({"revision":args.next}))
            }
            "plugins.reconcile_references" => {
                let args: Reconcile = decode(value)?;
                let record = service
                    .journal
                    .get(&args.operation_id)
                    .await?
                    .ok_or_else(|| OperationError::NotFound(args.operation_id.as_str().into()))?;
                service.complete_record(&bound.context, &record).await?;
                Ok(json!({"operation_id":args.operation_id,"reconciled":true}))
            }
            _ => unreachable!(),
        }
    }
}
