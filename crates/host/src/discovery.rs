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
    registry: OnceLock<Weak<CapabilityRegistry>>,
}
impl DiscoveryOwner {
    pub(crate) fn new(project: Option<String>, targets: Vec<TargetRef>) -> Arc<Self> {
        Arc::new(Self {
            project,
            targets,
            registry: OnceLock::new(),
        })
    }
    pub(crate) fn bind(&self, registry: &Arc<CapabilityRegistry>) {
        self.registry
            .set(Arc::downgrade(registry))
            .expect("discovery binds once");
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
    fn core_contract(
        &self,
        args: rho_plugin_protocol::HostCapabilityArguments,
    ) -> Result<rho_plugin_protocol::HostCapabilityContract, OperationError> {
        use rho_plugin_protocol as public;
        let key = CapabilityRef::new(
            args.capability.id.as_str(),
            args.capability.version.try_into().map_err(invalid)?,
        )?;
        let descriptor = self.registry()?.host_descriptor(&key).ok_or_else(|| {
            OperationError::NotFound("capability is not a registered native Host port".into())
        })?;
        let project = self.project.as_deref().ok_or_else(|| {
            OperationError::Unavailable("Host contract observation requires a project".into())
        })?;
        Ok(public::HostCapabilityContract {
            project: rho_plugins::plugin_project_id(project),
            capability: args.capability,
            kind: match descriptor.kind {
                CapabilityKind::Query => public::CapabilityKind::Query,
                CapabilityKind::Operation => public::CapabilityKind::Operation,
                CapabilityKind::Control => public::CapabilityKind::Control,
            },
            description: descriptor.documentation.purpose,
            input_schema: descriptor.input_schema,
            required_scopes: descriptor.required_scopes,
        })
    }
    fn modules(&self, descriptors: &[CapabilityDescriptor]) -> Vec<ModuleAvailability> {
        descriptors
            .iter()
            .map(|d| d.domain.as_str())
            .collect::<BTreeSet<_>>()
            .into_iter()
            .map(|module| ModuleAvailability {
                module: module.into(),
                available: true,
                reasons: vec![],
                catalog: NextRead::query(
                    "host.catalog",
                    format!("Discover {module} capabilities"),
                    json!({"module":module,"limit":20}),
                ),
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
                .is_none_or(|module| d.domain == *module)
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
                    .modules(&visible)
                    .into_iter()
                    .find(|m| m.module == module)
                    .ok_or_else(|| OperationError::NotFound("module is not visible".into()))?;
                Ok(HostDescription::Module {
                    module: Box::new(available),
                    capabilities: visible
                        .iter()
                        .filter(|d| d.domain == module)
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
        for (id, args) in [("operation.list_recent", json!({"limit":3}))] {
            if !visible.iter().any(|d| d.capability.id == id) {
                continue;
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
            observations.push(OverviewObservation::Operations(observed(snapshot)?));
        }
        let modules = self.modules(&visible);
        let targets = self
            .targets
            .iter()
            .filter(|target| {
                target.kind == "project"
                    && (context.scopes.contains("plugins.read")
                        || context.scopes.contains("operation.read"))
            })
            .cloned()
            .collect();
        Ok(HostOverview {
            project_root: self.project.clone(),
            targets,
            modules,
            observations,
            atomic_snapshot: false,
        })
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
fn summary(descriptor: &CapabilityDescriptor) -> CapabilitySummary {
    CapabilitySummary {
        capability: descriptor.capability.clone(),
        kind: descriptor.kind,
        module: descriptor.domain.clone(),
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
            "host.core_contract" => (
                schema_for!(rho_plugin_protocol::HostCapabilityArguments).to_value(),
                schema_for!(rho_plugin_protocol::HostCapabilityContract).to_value(),
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
                required_scopes: if id == "host.core_contract" {
                    ["plugins.read".into()].into()
                } else {
                    BTreeSet::new()
                },
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
            "host.core_contract" => serde_json::to_value(
                serde_json::from_value::<rho_plugin_protocol::HostCapabilityArguments>(
                    args.clone(),
                )
                .map_err(invalid)?,
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
            "host.core_contract" => (
                serde_json::to_value(
                    self.owner
                        .core_contract(serde_json::from_value(args.clone()).map_err(invalid)?)?,
                ),
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn discovery_uses_visible_registered_domains_without_a_fixed_module_list() {
        let owner = DiscoveryOwner::new(None, vec![]);
        let mut registry = CapabilityRegistry::new();
        for (id, domain, scope) in [
            ("arbitrary.observe", "custom-domain", "custom.read"),
            ("another.observe", "custom-domain", "custom.read"),
            ("hidden.observe", "private-domain", "private.read"),
        ] {
            let mut handler = DiscoveryHandler::new(owner.clone(), "host.overview");
            handler.descriptor.capability = CapabilityRef::new(id, 1).unwrap();
            handler.descriptor.domain = domain.into();
            handler.descriptor.required_scopes = [scope.into()].into();
            registry.register_query(Arc::new(handler)).unwrap();
        }
        let registry = Arc::new(registry);
        owner.bind(&registry);
        let mut context = crate::NextHost::local_context();
        context.scopes = ["custom.read".into()].into();
        let modules = owner.modules(&owner.visible(&context).unwrap());
        assert_eq!(modules.len(), 1);
        assert_eq!(modules[0].module, "custom-domain");
        let catalog = owner
            .catalog(
                &context,
                HostCatalogArguments {
                    module: Some("custom-domain".into()),
                    keyword: None,
                    cursor: None,
                    limit: 1,
                },
            )
            .unwrap();
        assert_eq!(catalog.entries.len(), 1);
        assert_eq!(catalog.entries[0].module, "custom-domain");
        let cursor = catalog.next_cursor.unwrap();
        let description = owner
            .describe(
                &context,
                HostDescribeArguments {
                    capability: None,
                    module: Some("custom-domain".into()),
                },
            )
            .unwrap();
        let HostDescription::Module { capabilities, .. } = description else {
            panic!("module expected")
        };
        assert_eq!(capabilities.len(), 2);
        assert!(
            owner
                .describe(
                    &context,
                    HostDescribeArguments {
                        capability: None,
                        module: Some("private-domain".into()),
                    }
                )
                .is_err()
        );
        context.scopes.clear();
        assert!(owner.modules(&owner.visible(&context).unwrap()).is_empty());
        assert!(matches!(
            owner.catalog(
                &context,
                HostCatalogArguments {
                    module: Some("custom-domain".into()),
                    keyword: None,
                    cursor: Some(cursor),
                    limit: 1,
                }
            ),
            Err(OperationError::ObservationExpired(_))
        ));
    }
}
