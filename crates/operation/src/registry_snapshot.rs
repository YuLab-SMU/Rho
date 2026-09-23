use crate::{OperationError, OperationHandler, QueryHandler, schema};
use rho_contract::{CallContext, CapabilityDescriptor, CapabilityKind, CapabilityRef};
use serde_json::{Value, json};
use std::{collections::BTreeMap, sync::Arc};

#[derive(Clone, Default)]
pub struct RegistrySnapshot {
    pub(crate) handlers: BTreeMap<CapabilityRef, Arc<dyn OperationHandler>>,
    pub(crate) queries: BTreeMap<CapabilityRef, Arc<dyn QueryHandler>>,
    pub(crate) schemas: BTreeMap<CapabilityRef, Arc<schema::CapabilitySchemas>>,
    pub(crate) descriptors: BTreeMap<CapabilityRef, CapabilityDescriptor>,
}

impl RegistrySnapshot {
    pub fn new() -> Self {
        Self::default()
    }
    pub fn register_control(
        &mut self,
        descriptor: CapabilityDescriptor,
    ) -> Result<(), OperationError> {
        descriptor.validate()?;
        if descriptor.kind != CapabilityKind::Control {
            return Err(OperationError::Contract(
                "control metadata requires Control kind".into(),
            ));
        }
        let capability = descriptor.capability.clone();
        if self.schemas.contains_key(&capability) {
            return Err(OperationError::DuplicateCapability(
                capability.display_key(),
            ));
        }
        self.schemas.insert(
            capability.clone(),
            Arc::new(schema::CapabilitySchemas::new(&descriptor)?),
        );
        self.descriptors
            .insert(capability.clone(), descriptor.clone());
        Ok(())
    }

    pub fn register(&mut self, handler: Arc<dyn OperationHandler>) -> Result<(), OperationError> {
        handler.descriptor().validate()?;
        if handler.descriptor().kind != CapabilityKind::Operation {
            return Err(OperationError::Contract(
                "operation handler requires an Operation descriptor".into(),
            ));
        }
        let capability = handler.descriptor().capability.clone();
        if self.schemas.contains_key(&capability) {
            return Err(OperationError::DuplicateCapability(
                capability.display_key(),
            ));
        }
        let mut descriptor = handler.descriptor().clone();
        descriptor.recovery_schema =
            rho_contract::operation_recovery_schema(descriptor.recovery_schema);
        let schemas = schema::CapabilitySchemas::new(&descriptor)?;
        for example in &descriptor.documentation.examples {
            let normalized = handler
                .normalize_arguments(&example.arguments)
                .map_err(|e| {
                    OperationError::Contract(format!(
                        "{} example normalization failed: {e}",
                        capability.display_key()
                    ))
                })?;
            schemas.input(&normalized).map_err(|e| {
                OperationError::Contract(format!(
                    "{} normalized example violates its input schema: {e}",
                    capability.display_key()
                ))
            })?;
        }
        self.schemas.insert(capability.clone(), Arc::new(schemas));
        self.descriptors.insert(capability.clone(), descriptor);
        self.handlers.insert(capability, handler);
        Ok(())
    }

    pub fn register_query(&mut self, handler: Arc<dyn QueryHandler>) -> Result<(), OperationError> {
        let descriptor = handler.descriptor();
        descriptor.validate()?;
        if descriptor.kind != CapabilityKind::Query || !descriptor.potential_effects.is_empty() {
            return Err(OperationError::Contract(
                "query descriptors must be reads without declared effects".into(),
            ));
        }
        let capability = descriptor.capability.clone();
        if self.schemas.contains_key(&capability) {
            return Err(OperationError::DuplicateCapability(
                capability.display_key(),
            ));
        }
        let schemas = schema::CapabilitySchemas::new(handler.descriptor())?;
        for example in &descriptor.documentation.examples {
            let normalized = handler
                .normalize_arguments(&example.arguments)
                .map_err(|e| {
                    OperationError::Contract(format!(
                        "{} example normalization failed: {e}",
                        capability.display_key()
                    ))
                })?;
            schemas.input(&normalized).map_err(|e| {
                OperationError::Contract(format!(
                    "{} normalized example violates its input schema: {e}",
                    capability.display_key()
                ))
            })?;
        }
        self.schemas.insert(capability.clone(), Arc::new(schemas));
        self.descriptors
            .insert(capability.clone(), descriptor.clone());
        self.queries.insert(capability, handler);
        Ok(())
    }

    pub fn query_handler(
        &self,
        capability: &CapabilityRef,
    ) -> Result<Arc<dyn QueryHandler>, OperationError> {
        self.queries
            .get(capability)
            .cloned()
            .ok_or_else(|| OperationError::UnknownCapability(capability.display_key()))
    }

    pub fn handler(
        &self,
        capability: &CapabilityRef,
    ) -> Result<Arc<dyn OperationHandler>, OperationError> {
        self.handlers
            .get(capability)
            .cloned()
            .ok_or_else(|| OperationError::UnknownCapability(capability.display_key()))
    }

    pub fn descriptors(&self) -> Vec<CapabilityDescriptor> {
        self.descriptors.values().cloned().collect()
    }
    pub fn descriptor(&self, capability: &CapabilityRef) -> Option<&CapabilityDescriptor> {
        self.descriptors.get(capability)
    }
    pub fn validate_control_input(
        &self,
        context: &CallContext,
        capability: &CapabilityRef,
        arguments: &Value,
    ) -> Result<(), OperationError> {
        context.validate()?;
        let descriptor = self
            .descriptors
            .get(capability)
            .filter(|d| d.kind == CapabilityKind::Control)
            .ok_or_else(|| OperationError::UnknownCapability(capability.display_key()))?;
        let missing = descriptor
            .required_scopes
            .difference(&context.scopes)
            .cloned()
            .collect::<Vec<_>>();
        if !missing.is_empty() {
            return Err(OperationError::AccessDenied {
                capability: capability.display_key(),
                missing,
            });
        }
        self.schemas
            .get(capability)
            .expect("registered schema")
            .input(arguments)
    }
    pub fn validate_control_output(
        &self,
        capability: &CapabilityRef,
        output: &Value,
    ) -> Result<(), OperationError> {
        if !self
            .descriptors
            .get(capability)
            .is_some_and(|d| d.kind == CapabilityKind::Control)
        {
            return Err(OperationError::UnknownCapability(capability.display_key()));
        }
        self.schemas
            .get(capability)
            .expect("registered schema")
            .output(output)
    }

    pub fn validate_links(&mut self) -> Result<(), OperationError> {
        let kinds = self
            .descriptors
            .iter()
            .map(|(reference, d)| (reference.clone(), d.kind))
            .collect::<BTreeMap<_, _>>();
        for descriptor in self.descriptors.values_mut() {
            for related in &descriptor.documentation.related_capabilities {
                if !kinds.contains_key(related) {
                    return Err(OperationError::Contract(format!(
                        "{} links to unregistered {}",
                        descriptor.capability.display_key(),
                        related.display_key()
                    )));
                }
            }
            for condition in &mut descriptor.documentation.preconditions {
                if let Some(reference) = condition.read_from.as_ref() {
                    reference.validate()?;
                    match kinds.get(reference) {
                        Some(CapabilityKind::Query) => (),
                        Some(_) => {
                            return Err(OperationError::Contract(format!(
                                "precondition read_from must be read-only: {}",
                                reference.display_key()
                            )));
                        }
                        None => {
                            condition.requirement.push_str(&format!(" The reading source {} is unavailable in this Host configuration; discovery does not start that owner or a runtime.", reference.display_key()));
                            condition.read_from = None;
                        }
                    }
                }
            }
        }
        Ok(())
    }

    pub fn validate_query_result(
        &self,
        capability: &CapabilityRef,
        snapshot: &rho_contract::QuerySnapshot,
    ) -> Result<(), OperationError> {
        let schemas = self
            .schemas
            .get(capability)
            .ok_or_else(|| OperationError::UnknownCapability(capability.display_key()))?;
        if let Some(data) = &snapshot.data {
            schemas.output(data)?;
        } else if snapshot.status == rho_contract::QueryStatus::Ready {
            schemas.output(&Value::Null)?;
        }
        self.validate_reads(&snapshot.next_reads)?;
        for diagnostic in &snapshot.diagnostics {
            self.validate_reads(&diagnostic.next_reads)?;
        }
        Ok(())
    }
    pub(crate) fn validate_reads(
        &self,
        reads: &[rho_contract::NextRead],
    ) -> Result<(), OperationError> {
        for read in reads {
            let descriptor = self.descriptors.get(&read.capability).ok_or_else(|| {
                OperationError::Contract(format!(
                    "next read is not registered: {}",
                    read.capability.display_key()
                ))
            })?;
            if descriptor.kind != CapabilityKind::Query {
                return Err(OperationError::Contract(
                    "next_reads may only identify read-only queries".into(),
                ));
            }
            self.schemas
                .get(&read.capability)
                .expect("registered schema")
                .read(read)?;
        }
        Ok(())
    }
    fn filter_reads(&self, context: &CallContext, reads: &mut Vec<rho_contract::NextRead>) {
        reads.retain(|read| {
            self.descriptors
                .get(&read.capability)
                .is_none_or(|d| d.required_scopes.is_subset(&context.scopes))
        });
    }
    pub fn prepare_query_result(
        &self,
        context: &CallContext,
        capability: &CapabilityRef,
        snapshot: &mut rho_contract::QuerySnapshot,
    ) -> Result<(), OperationError> {
        if capability.id == "operation.get"
            && let Some(data) = snapshot.data.as_ref()
        {
            let mut result: rho_contract::OperationGetResult = serde_json::from_value(data.clone())
                .map_err(|e| OperationError::Contract(e.to_string()))?;
            if let Some(record) = &mut result.record {
                self.decorate_record(context, record)?;
            }
            if let Some(contract) = &mut result.output_contract {
                if result
                    .record
                    .as_ref()
                    .is_none_or(|record| record.operation.capability != contract.capability)
                {
                    return Err(OperationError::Contract(
                        "record query schema association does not match the original capability"
                            .into(),
                    ));
                }
                let visible = self.descriptors.get(&contract.capability).is_some_and(|d| {
                    d.kind == CapabilityKind::Operation
                        && d.required_scopes.is_subset(&context.scopes)
                });
                contract.describe = if visible {
                    self.read_link(
                        context,
                        "host.describe",
                        "Read the exact capability contract associated with this original result",
                        json!({"capability":contract.capability}),
                    )?
                } else {
                    None
                };
            }
            snapshot.data = Some(
                serde_json::to_value(result)
                    .map_err(|e| OperationError::Contract(e.to_string()))?,
            );
        }
        self.filter_reads(context, &mut snapshot.next_reads);
        for diagnostic in &mut snapshot.diagnostics {
            self.filter_reads(context, &mut diagnostic.next_reads);
        }
        self.validate_query_result(capability, snapshot)
    }
}
