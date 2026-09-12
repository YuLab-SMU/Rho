use rho_contract::*;
use rho_operation::{
    CapabilityRegistry, Clock, OperationError, QueryGateway, QueryHandler, SystemClock,
};
use schemars::schema_for;
use serde::de::DeserializeOwned;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeSet,
    sync::{Arc, OnceLock, Weak},
};

pub(crate) struct DiscoveryOwner {
    project: Option<String>,
    targets: Vec<TargetRef>,
    workspace: Option<Arc<dyn rho_workspace::WorkspaceRuntime>>,
    registry: OnceLock<Weak<CapabilityRegistry>>,
    instances: OnceLock<Weak<crate::instances::InstanceOwner>>,
}
impl DiscoveryOwner {
    pub(crate) fn new(
        project: Option<String>,
        targets: Vec<TargetRef>,
        workspace: Option<Arc<dyn rho_workspace::WorkspaceRuntime>>,
    ) -> Arc<Self> {
        Arc::new(Self {
            project,
            targets,
            workspace,
            registry: OnceLock::new(),
            instances: OnceLock::new(),
        })
    }
    pub(crate) fn bind(&self, registry: &Arc<CapabilityRegistry>) {
        self.registry
            .set(Arc::downgrade(registry))
            .expect("discovery binds once");
    }
    pub(crate) fn bind_instances(&self, instances: &Arc<crate::instances::InstanceOwner>) {
        let _ = self.instances.set(Arc::downgrade(instances));
    }
    fn registry(&self) -> Result<Arc<CapabilityRegistry>, OperationError> {
        self.registry
            .get()
            .and_then(Weak::upgrade)
            .ok_or_else(|| OperationError::Unavailable("Host registry is not composed".into()))
    }
    fn visible(&self, context: &CallContext) -> Result<Vec<CapabilityDescriptor>, OperationError> {
        let mut descriptors =
            crate::port_contracts::visible(self.registry()?.descriptors(), context);
        descriptors.sort_by(|a, b| a.capability.cmp(&b.capability));
        Ok(descriptors)
    }
    fn modules(
        &self,
        descriptors: &[CapabilityDescriptor],
        context: &CallContext,
    ) -> Vec<ModuleAvailability> {
        [
            ("session", "workspace.read", "No connected R runtime"),
            (
                "runtime",
                "workspace.read",
                "No runtime manager is composed",
            ),
            (
                "operations",
                "operation.read",
                "No project operation journal",
            ),
            ("console", "workspace.read", "No connected R runtime"),
            ("objects", "workspace.read", "No connected R runtime"),
            ("packages", "workspace.read", "No connected R runtime"),
            ("files", "project.read", "No project selected"),
            ("documents", "application.read", "No active Studio window"),
            ("outputs", "workspace.read", "No project output store"),
            ("plots", "workspace.read", "No project output store"),
            ("layout", "application.read", "No active Studio window"),
            ("application", "application.read", "No active Studio window"),
            (
                "environment",
                "environment.read",
                "Environment tools are not configured",
            ),
            (
                "processes",
                "process.run_local",
                "No local project process target",
            ),
            ("remote", "remote.execute", "SSH target is not configured"),
            ("slurm", "slurm.read", "Slurm target is not configured"),
            ("skills", "skill.read", "Skill sources are not configured"),
        ]
        .into_iter()
        .filter(|(module, scope, _)| {
            context.scopes.contains(*scope)
                || descriptors
                    .iter()
                    .any(|descriptor| belongs_to(&descriptor.capability.id, module))
        })
        .map(|(module, _, reason)| {
            let available = descriptors
                .iter()
                .any(|d| belongs_to(&d.capability.id, module));
            ModuleAvailability {
                module: module.into(),
                available,
                reasons: if available {
                    vec![]
                } else {
                    vec![reason.into()]
                },
                catalog: NextRead::query(
                    "host.catalog",
                    format!("Discover {module} capabilities"),
                    json!({"module":module,"limit":20}),
                ),
            }
        })
        .collect()
    }
    fn catalog(
        &self,
        context: &CallContext,
        args: HostCatalogArguments,
    ) -> Result<HostCatalog, OperationError> {
        let mut visible = self.visible(context)?;
        visible.retain(|d| {
            args.module
                .as_ref()
                .is_none_or(|module| belongs_to(&d.capability.id, module))
        });
        if let Some(keyword) = &args.keyword {
            let keyword = keyword.to_lowercase();
            visible.retain(|d| {
                format!(
                    "{} {} {}",
                    d.capability.id, d.documentation.summary, d.documentation.purpose
                )
                .to_lowercase()
                .contains(&keyword)
            });
        }
        let fingerprint = format!(
            "{:x}",
            Sha256::digest(
                serde_json::to_vec(&(
                    context.principal(),
                    &context.scopes,
                    &visible,
                    &args.module,
                    &args.keyword
                ))
                .map_err(invalid)?
            )
        );
        let offset = if let Some(cursor) = args.cursor {
            let (identity, offset) = cursor
                .split_once(':')
                .ok_or_else(|| invalid("invalid catalog cursor"))?;
            if identity != fingerprint {
                return Err(OperationError::ObservationExpired(
                    "catalog filters, visibility or registry changed".into(),
                ));
            }
            offset.parse::<usize>().map_err(invalid)?
        } else {
            0
        };
        if offset > visible.len() {
            return Err(invalid("catalog cursor exceeds entries"));
        }
        let mut result = HostCatalog {
            entries: vec![],
            total: visible.len() as u32,
            next_cursor: None,
            utf8_bytes: 0,
            limit_reason: None,
        };
        for descriptor in visible.iter().skip(offset).take(args.limit as usize) {
            result.entries.push(summary(descriptor));
            if serde_json::to_vec(&result).map_err(invalid)?.len() > CATALOG_BYTES - 2048 {
                result.entries.pop();
                result.limit_reason = Some("UTF-8 catalog page budget".into());
                break;
            }
        }
        if offset + result.entries.len() < visible.len() {
            result.next_cursor = Some(format!("{fingerprint}:{}", offset + result.entries.len()));
            result
                .limit_reason
                .get_or_insert_with(|| "entry page limit".into());
        }
        for _ in 0..4 {
            result.utf8_bytes = serde_json::to_vec(&result).map_err(invalid)?.len() as u32;
        }
        Ok(result)
    }
    fn describe(
        &self,
        context: &CallContext,
        args: HostDescribeArguments,
    ) -> Result<HostDescription, OperationError> {
        let visible = self.visible(context)?;
        match (args.capability, args.module) {
            (Some(capability), None) => {
                let descriptor = visible
                    .into_iter()
                    .find(|d| d.capability == capability)
                    .ok_or_else(|| {
                        OperationError::NotFound(
                            "capability is unavailable in the visible registry".into(),
                        )
                    })?;
                Ok(HostDescription::Capability {
                    descriptor: Box::new(descriptor),
                })
            }
            (None, Some(module)) => {
                let available = self
                    .modules(&visible, context)
                    .into_iter()
                    .find(|m| m.module == module)
                    .ok_or_else(|| OperationError::NotFound("module is not visible".into()))?;
                Ok(HostDescription::Module {
                    module: Box::new(available),
                    capabilities: visible
                        .iter()
                        .filter(|d| belongs_to(&d.capability.id, &module))
                        .map(summary)
                        .collect(),
                })
            }
            _ => Err(invalid(
                "describe requires exactly one of capability or module",
            )),
        }
    }
    async fn overview(&self, context: &CallContext) -> Result<HostOverview, OperationError> {
        let visible = self.visible(context)?;
        let mut observations = vec![];
        let gateway = QueryGateway::new(self.registry()?);
        for (id, mut args) in [
            ("workspace.runtime_status", json!({})),
            ("workspace.console_state", json!({})),
            ("operation.list_recent", json!({"limit":3})),
            ("application.windows", json!({"limit":3})),
            ("environment.observe", json!({"limit":1})),
        ] {
            if !visible.iter().any(|d| d.capability.id == id) {
                continue;
            }
            if id.starts_with("workspace.")
                && let Some(instances) = self.instances.get().and_then(Weak::upgrade)
            {
                let instance_id = instances
                    .list(&RuntimeInstancesArguments {
                        after_instance_id: None,
                        limit: 1,
                    })?
                    .default_workspace_instance_id
                    .unwrap_or_else(|| MAIN_WORKSPACE_INSTANCE.into());
                args["workspace_instance_id"] = json!(instance_id);
            }
            let snapshot = match gateway
                .query(
                    context,
                    QueryRequest {
                        capability: CapabilityRef::new(id, 1)?,
                        arguments: args,
                    },
                )
                .await
            {
                Ok(snapshot) => snapshot,
                Err(error) => {
                    let mut message = error.to_string();
                    let shortened = truncate(&mut message, 1024);
                    let mut notices = vec![message];
                    if shortened {
                        notices.push("Error detail exceeds overview budget; read this capability directly for its diagnostic.".into());
                    }
                    QuerySnapshot {
                        target: TargetRef {
                            kind: "host".into(),
                            identity: self
                                .project
                                .clone()
                                .unwrap_or_else(|| "project-unselected".into()),
                        },
                        source: format!("host/{id}/failed-read"),
                        observed_at_ms: SystemClock.now_ms()?,
                        status: QueryStatus::Unavailable,
                        completeness: ObservationCompleteness::Unknown,
                        data: None,
                        notices,
                        next_reads: vec![],
                        diagnostics: vec![],
                    }
                }
            };
            observations.push(match id {
                "workspace.runtime_status"=>OverviewObservation::Session(observed(snapshot)?),
                "workspace.console_state"=>{
                    let mut observation:Observed<ConsoleOverview>=Observed{source:snapshot.source,observed_at_ms:snapshot.observed_at_ms,status:snapshot.status,completeness:snapshot.completeness,data:None,notices:snapshot.notices};
                    if let Some(data)=snapshot.data {
                        let mut console:ConsoleState=serde_json::from_value(data).map_err(invalid)?;
                        if let Some(input)=console.input.as_mut()&& truncate(&mut input.prompt,1024){observation.completeness=ObservationCompleteness::Partial;observation.notices.push("Input prompt is shortened; read workspace.console_state for its complete bounded observation.".into());}
                        if let Some(pause)=console.pause.as_mut()&& truncate(&mut pause.reason,1024){observation.completeness=ObservationCompleteness::Partial;observation.notices.push("Pause reason is shortened; read workspace.console_state.".into());}
                        observation.data=Some(ConsoleOverview{session_id:console.session_id,current_operation:console.current.map(|c|c.operation_id),queued_count:console.pending.len() as u32,pause:console.pause,input:console.input});
                    }
                    OverviewObservation::Console(observation)
                },
                "application.windows"=>OverviewObservation::Application(observed(snapshot)?),
                "environment.observe"=>OverviewObservation::Environment(observed(snapshot)?),
                _=>OverviewObservation::Operations(observed(snapshot)?),
            });
        }
        let mut modules = self.modules(&visible, context);
        for observation in &observations {
            match observation {
                OverviewObservation::Session(session)
                    if session
                        .data
                        .as_ref()
                        .is_none_or(|runtime| runtime.state == "unavailable") =>
                {
                    for module in modules.iter_mut().filter(|module| {
                        matches!(
                            module.module.as_str(),
                            "session" | "console" | "objects" | "packages"
                        )
                    }) {
                        module.available = false;
                        module.reasons=vec!["Native R is unavailable; inspect the separately timed Session observation".into()];
                    }
                }
                OverviewObservation::Application(window) => {
                    let online = window
                        .data
                        .as_ref()
                        .is_some_and(|page| page.online_count > 0);
                    if !online {
                        for module in modules.iter_mut().filter(|module| {
                            matches!(
                                module.module.as_str(),
                                "application" | "documents" | "layout"
                            )
                        }) {
                            module.available = false;
                            module.reasons=vec!["No active Studio window; discover synchronized window history with application.windows".into()];
                        }
                    }
                }
                OverviewObservation::Environment(environment)
                    if environment.status != QueryStatus::Ready =>
                {
                    if let Some(module) = modules
                        .iter_mut()
                        .find(|module| module.module == "environment")
                    {
                        module.available = false;
                        module.reasons = environment.notices.clone();
                    }
                }
                _ => {}
            }
        }
        let mut targets = vec![];
        let mut observed_targets = self.targets.clone();
        if let Some(instances) = self.instances.get().and_then(Weak::upgrade) {
            observed_targets.extend(instances.targets());
        }
        for target in &observed_targets {
            if rho_skills::SkillCapabilityPort::target_is_current(self, context, target)
                .await
                .map_err(invalid)?
            {
                targets.push(target.clone());
            }
        }
        Ok(HostOverview {
            project_root: self.project.clone(),
            targets,
            modules,
            observations,
            atomic_snapshot: false,
        })
    }
}
#[async_trait::async_trait]
impl rho_skills::SkillCapabilityPort for DiscoveryOwner {
    async fn available_capabilities(
        &self,
        context: &CallContext,
        target: Option<&TargetRef>,
    ) -> Result<Vec<CapabilityRef>, String> {
        if let Some(target) = target
            && !self.target_is_current(context, target).await?
        {
            return Ok(vec![]);
        }
        self.visible(context)
            .map(|descriptors| descriptors.into_iter().map(|d| d.capability).collect())
            .map_err(|e| e.to_string())
    }
    async fn target_is_current(
        &self,
        context: &CallContext,
        target: &TargetRef,
    ) -> Result<bool, String> {
        context.validate().map_err(|e| e.to_string())?;
        let allowed = match target.kind.as_str() {
            "workspace" => {
                context.scopes.contains("workspace.read")
                    || context.scopes.contains("workspace.run_r")
            }
            "project" => {
                context.scopes.contains("project.read") || context.scopes.contains("project.write")
            }
            "environment" => {
                context.scopes.contains("environment.read")
                    || context.scopes.contains("environment.write")
            }
            "local_process" => context.scopes.contains("process.run_local"),
            "remote" => {
                context.scopes.contains("remote.execute") || context.scopes.contains("slurm.read")
            }
            _ => false,
        };
        if target.kind == "workspace"
            && let Some(instances) = self.instances.get().and_then(Weak::upgrade)
        {
            return Ok(allowed && instances.targets().contains(target));
        }
        let live = target.kind != "workspace"
            || self.workspace.as_ref().is_some_and(|runtime| {
                runtime.session_id() == target.identity
                    && runtime.runtime_status().state != "unavailable"
            });
        Ok(allowed && live && self.targets.contains(target))
    }
}
fn observed<T: DeserializeOwned>(snapshot: QuerySnapshot) -> Result<Observed<T>, OperationError> {
    Ok(Observed {
        source: snapshot.source,
        observed_at_ms: snapshot.observed_at_ms,
        status: snapshot.status,
        completeness: snapshot.completeness,
        data: snapshot
            .data
            .map(serde_json::from_value)
            .transpose()
            .map_err(invalid)?,
        notices: snapshot.notices,
    })
}
fn truncate(text: &mut String, bound: usize) -> bool {
    if text.len() <= bound {
        return false;
    }
    let mut end = bound;
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    text.truncate(end);
    true
}
pub(crate) fn module_for(id: &str) -> &str {
    match id {
        "workspace.runtime_status" | "workspace.snapshot" => "session",
        "workspace.packages" | "workspace.package_index" | "workspace.help" | "workspace.read_help" => "packages",
        "workspace.inspect_object"
        | "workspace.list_objects"
        | "workspace.observe_object"
        | "workspace.read_object" => "objects",
        "workspace.list_outputs"
        | "workspace.read_output"
        | "workspace.output_events"
        | "output.read_text"
        | "output.manifest" => "outputs",
        "output.view" => "plots",
        "application.read_document" => "documents",
        "process.run_remote" => "remote",
        _ => match id.split('.').next().unwrap_or("") {
            "host" => "host",
            "workspace" => "console",
            "project" => "files",
            "operation" => "operations",
            "process" => "processes",
            "skill" => "skills",
            module => module,
        },
    }
}
fn belongs_to(id: &str, module: &str) -> bool {
    module_for(id) == module
        || match module {
            "layout" => matches!(
                id,
                "application.control" | "application.context" | "application.windows"
            ),
            "documents" => matches!(
                id,
                "application.control" | "application.context" | "application.windows"
            ),
            "plots" => matches!(id, "workspace.list_outputs" | "application.control"),
            "skills" => matches!(id, "host.resolve_context" | "application.bind_method"),
            _ => false,
        }
}
fn summary(descriptor: &CapabilityDescriptor) -> CapabilitySummary {
    CapabilitySummary {
        capability: descriptor.capability.clone(),
        kind: descriptor.kind,
        module: module_for(&descriptor.capability.id).into(),
        summary: descriptor.documentation.summary.clone(),
        describe: NextRead::query(
            "host.describe",
            "Read parameters, results, preconditions and examples",
            json!({"capability":descriptor.capability}),
        ),
    }
}
pub(crate) struct DiscoveryHandler {
    owner: Arc<DiscoveryOwner>,
    descriptor: CapabilityDescriptor,
}
impl DiscoveryHandler {
    pub(crate) fn new(owner: Arc<DiscoveryOwner>, id: &str) -> Self {
        let (input_schema, output_schema) = match id {
            "host.catalog" => (
                schema_for!(HostCatalogArguments).to_value(),
                schema_for!(HostCatalog).to_value(),
            ),
            "host.describe" => (
                schema_for!(HostDescribeArguments).to_value(),
                schema_for!(HostDescription).to_value(),
            ),
            "host.overview" => (
                json!({"type":"object","properties":{},"additionalProperties":false}),
                schema_for!(HostOverview).to_value(),
            ),
            _ => unreachable!(),
        };
        Self {
            owner,
            descriptor: CapabilityDescriptor {
                kind: CapabilityKind::Query,
                capability: CapabilityRef::new(id, 1).unwrap(),
                domain: "host".into(),
                input_schema,
                output_schema,
                recovery_schema: json!({"type":"null"}),
                documentation: builtin_documentation(id),
                required_scopes: BTreeSet::new(),
                potential_effects: BTreeSet::new(),
                idempotency: IdempotencyClass::Pure,
                retry: RetryClass::Safe,
                cancellation: CancellationClass::Unsupported,
            },
        }
    }
}
#[async_trait::async_trait]
impl QueryHandler for DiscoveryHandler {
    fn descriptor(&self) -> &CapabilityDescriptor {
        &self.descriptor
    }
    fn normalize_arguments(&self, args: &Value) -> Result<Value, OperationError> {
        match self.descriptor.capability.id.as_str() {
            "host.catalog" => {
                let args: HostCatalogArguments =
                    serde_json::from_value(args.clone()).map_err(invalid)?;
                if !(1..=50).contains(&args.limit)
                    || args.keyword.as_ref().is_some_and(|v| v.len() > 1024)
                    || args.module.as_ref().is_some_and(|v| v.len() > 64)
                    || args.cursor.as_ref().is_some_and(|v| v.len() > 128)
                {
                    return Err(invalid("catalog bounds exceeded"));
                }
                serde_json::to_value(args).map_err(invalid)
            }
            "host.describe" => serde_json::to_value(
                serde_json::from_value::<HostDescribeArguments>(args.clone()).map_err(invalid)?,
            )
            .map_err(invalid),
            _ => {
                if args == &json!({}) {
                    Ok(args.clone())
                } else {
                    Err(invalid("overview accepts no arguments"))
                }
            }
        }
    }
    async fn query(&self, _: &Value) -> Result<QuerySnapshot, OperationError> {
        Err(invalid("caller context required"))
    }
    async fn query_for(
        &self,
        context: &CallContext,
        args: &Value,
    ) -> Result<QuerySnapshot, OperationError> {
        let id = self.descriptor.capability.id.as_str();
        let mut next_reads = vec![];
        let (data, bound) = match id {
            "host.catalog" => {
                let parsed: HostCatalogArguments =
                    serde_json::from_value(args.clone()).map_err(invalid)?;
                let page = self.owner.catalog(context, parsed.clone())?;
                if let Some(cursor) = &page.next_cursor {
                    next_reads.push(NextRead::query(
                        id,
                        "Continue the same permission-filtered catalog",
                        serde_json::to_value(HostCatalogArguments {
                            cursor: Some(cursor.clone()),
                            ..parsed
                        })
                        .map_err(invalid)?,
                    ));
                }
                (serde_json::to_value(page), CATALOG_BYTES)
            }
            "host.describe" => (
                serde_json::to_value(self.owner.describe(
                    context,
                    serde_json::from_value(args.clone()).map_err(invalid)?,
                )?),
                DESCRIPTION_BYTES,
            ),
            _ => {
                next_reads.push(NextRead::query(
                    "host.catalog",
                    "Find capabilities relevant to the current task",
                    json!({"limit":20}),
                ));
                (
                    serde_json::to_value(self.owner.overview(context).await?),
                    SUMMARY_BYTES,
                )
            }
        };
        let snapshot = QuerySnapshot {
            target: TargetRef {
                kind: "host".into(),
                identity: self
                    .owner
                    .project
                    .clone()
                    .unwrap_or_else(|| "project-unselected".into()),
            },
            source: "host/composed-owner-observations".into(),
            observed_at_ms: SystemClock.now_ms()?,
            status: QueryStatus::Ready,
            completeness: if id == "host.overview" {
                ObservationCompleteness::Partial
            } else {
                ObservationCompleteness::Complete
            },
            data: Some(data.map_err(invalid)?),
            notices: vec![],
            next_reads,
            diagnostics: vec![],
        };
        if serde_json::to_vec(&snapshot).map_err(invalid)?.len() > bound {
            return Err(OperationError::BudgetExceeded(format!(
                "{id} exceeds its {bound} UTF-8 byte reply bound; request a narrower module or capability"
            )));
        }
        Ok(snapshot)
    }
}
fn invalid(e: impl std::fmt::Display) -> OperationError {
    OperationError::InvalidInput(e.to_string())
}
