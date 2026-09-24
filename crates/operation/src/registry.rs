use crate::{ControlHandler, OperationError, OperationHandler, QueryHandler, RegistrySnapshot};
use rho_contract::{
    CallContext, CapabilityDescriptor, CapabilityRef, NextRead, OperationRecord, QuerySnapshot,
};
use serde_json::Value;
use std::{
    collections::{BTreeMap, BTreeSet},
    sync::{Arc, RwLock},
};

/// One owner publishes/replaces all its contributions in a single transaction.
/// No group can replace startup controls or another owner's capability.
pub struct ContributionBatch {
    pub controls: Vec<Arc<dyn ControlHandler>>,
    pub operations: Vec<Arc<dyn OperationHandler>>,
    pub queries: Vec<Arc<dyn QueryHandler>>,
}
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RegistrationRevision {
    pub owner: String,
    pub generation: u64,
}
#[derive(Default)]
struct RegistryState {
    current: Arc<RegistrySnapshot>,
    groups: BTreeMap<String, (u64, BTreeSet<CapabilityRef>)>,
    /// Capability versions keep the same contract after unload/reload. Display
    /// documentation may change; scientific schema/authority may not.
    contracts: BTreeMap<CapabilityRef, CapabilityDescriptor>,
}

#[derive(Default)]
pub struct CapabilityRegistry {
    state: RwLock<RegistryState>,
    publication: tokio::sync::watch::Sender<u64>,
}
impl CapabilityRegistry {
    pub fn new() -> Self {
        Self::default()
    }
    pub fn snapshot(&self) -> Arc<RegistrySnapshot> {
        self.state.read().unwrap().current.clone()
    }

    /// Metadata notifications only; this is not a scientific revision/precondition.
    pub fn subscribe_publications(&self) -> tokio::sync::watch::Receiver<u64> {
        self.publication.subscribe()
    }

    // Startup composition remains explicit. Dynamic packages use replace_batch.
    pub fn register(&mut self, handler: Arc<dyn OperationHandler>) -> Result<(), OperationError> {
        let state = self.state.get_mut().unwrap();
        let key = handler.descriptor().capability.clone();
        let next = Arc::make_mut(&mut state.current);
        next.register(handler)?;
        state
            .contracts
            .insert(key.clone(), next.descriptors[&key].clone());
        Ok(())
    }
    pub fn register_query(&mut self, handler: Arc<dyn QueryHandler>) -> Result<(), OperationError> {
        let state = self.state.get_mut().unwrap();
        let key = handler.descriptor().capability.clone();
        let next = Arc::make_mut(&mut state.current);
        next.register_query(handler)?;
        state
            .contracts
            .insert(key.clone(), next.descriptors[&key].clone());
        Ok(())
    }
    pub fn register_control(
        &mut self,
        descriptor: CapabilityDescriptor,
    ) -> Result<(), OperationError> {
        let state = self.state.get_mut().unwrap();
        let key = descriptor.capability.clone();
        let next = Arc::make_mut(&mut state.current);
        next.register_control(descriptor)?;
        state
            .contracts
            .insert(key.clone(), next.descriptors[&key].clone());
        Ok(())
    }
    pub fn validate_links(&mut self) -> Result<(), OperationError> {
        let state = self.state.get_mut().unwrap();
        let mut next = (*state.current).clone();
        next.validate_links()?;
        state.current = Arc::new(next);
        Ok(())
    }

    pub fn replace_batch(
        &self,
        owner: &str,
        expected: Option<&RegistrationRevision>,
        batch: ContributionBatch,
    ) -> Result<RegistrationRevision, OperationError> {
        if owner.is_empty()
            || owner.len() > 128
            || !owner
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || b"._-".contains(&c))
        {
            return Err(OperationError::Contract(
                "invalid contribution owner".into(),
            ));
        }
        if batch.operations.len() + batch.queries.len() + batch.controls.len() > 512 {
            return Err(OperationError::BudgetExceeded(
                "too many contributions in a registration".into(),
            ));
        }
        // Schema compilation and examples can be expensive; prepare privately
        // before taking the publication lock. Nothing is visible on failure.
        let mut prepared = RegistrySnapshot::default();
        for handler in batch.controls {
            prepared.register_control_handler(handler)?;
        }
        for handler in batch.operations {
            prepared.register(handler)?;
        }
        for handler in batch.queries {
            prepared.register_query(handler)?;
        }
        let mut state = self.state.write().unwrap();
        if !state.groups.contains_key(owner) && state.groups.len() >= 4096 {
            return Err(OperationError::BudgetExceeded(
                "contribution owner history quota reached".into(),
            ));
        }
        let old = state.groups.get(owner);
        let matches = match (expected, old) {
            (None, None) => true,
            (Some(expected), Some((generation, _))) => {
                expected.owner == owner && expected.generation == *generation
            }
            _ => false,
        };
        if !matches {
            return Err(OperationError::LifecycleConflict(
                "contribution registration changed; refresh its owner revision".into(),
            ));
        }
        let mut next = (*state.current).clone();
        if let Some((_, capabilities)) = old {
            for capability in capabilities {
                next.handlers.remove(capability);
                next.queries.remove(capability);
                next.controls.remove(capability);
                next.schemas.remove(capability);
                next.descriptors.remove(capability);
            }
        }
        for (capability, descriptor) in &prepared.descriptors {
            if next.descriptors.contains_key(capability) {
                return Err(OperationError::DuplicateCapability(
                    capability.display_key(),
                ));
            }
            if let Some(previous) = state.contracts.get(capability) {
                if !same_contract(previous, descriptor) {
                    return Err(OperationError::Contract(format!(
                        "{} must use a new capability version for a changed contract",
                        capability.display_key()
                    )));
                }
            }
        }
        let owned = prepared.descriptors.keys().cloned().collect();
        let generation = old.map_or(Ok(1), |(generation, _)| {
            generation.checked_add(1).ok_or_else(|| {
                OperationError::BudgetExceeded("registration generation exhausted".into())
            })
        })?;
        next.handlers.extend(prepared.handlers);
        next.queries.extend(prepared.queries);
        next.controls.extend(prepared.controls);
        next.schemas.extend(prepared.schemas);
        next.descriptors.extend(prepared.descriptors.clone());
        next.validate_links()?;
        if state.contracts.len()
            + prepared
                .descriptors
                .keys()
                .filter(|key| !state.contracts.contains_key(*key))
                .count()
            > 4096
        {
            return Err(OperationError::BudgetExceeded(
                "registered contract history quota reached".into(),
            ));
        }
        state.contracts.extend(prepared.descriptors);
        state.groups.insert(owner.into(), (generation, owned));
        state.current = Arc::new(next);
        self.publication.send_modify(|revision| *revision = revision.wrapping_add(1));
        Ok(RegistrationRevision {
            owner: owner.into(),
            generation,
        })
    }

    pub fn remove_batch(
        &self,
        expected: &RegistrationRevision,
    ) -> Result<RegistrationRevision, OperationError> {
        self.replace_batch(
            &expected.owner,
            Some(expected),
            ContributionBatch { controls: vec![],
                operations: vec![],
                queries: vec![],
            },
        )
    }
    pub fn handler(
        &self,
        capability: &CapabilityRef,
    ) -> Result<Arc<dyn OperationHandler>, OperationError> {
        self.snapshot().handler(capability)
    }
    pub fn query_handler(
        &self,
        capability: &CapabilityRef,
    ) -> Result<Arc<dyn QueryHandler>, OperationError> {
        self.snapshot().query_handler(capability)
    }
    pub fn descriptors(&self) -> Vec<CapabilityDescriptor> {
        self.snapshot().descriptors()
    }
    pub fn descriptor(&self, capability: &CapabilityRef) -> Option<CapabilityDescriptor> {
        self.snapshot().descriptor(capability).cloned()
    }
    pub fn validate_control_input(
        &self,
        context: &CallContext,
        capability: &CapabilityRef,
        arguments: &Value,
    ) -> Result<(), OperationError> {
        self.snapshot()
            .validate_control_input(context, capability, arguments)
    }
    pub fn validate_control_output(
        &self,
        capability: &CapabilityRef,
        output: &Value,
    ) -> Result<(), OperationError> {
        self.snapshot().validate_control_output(capability, output)
    }
    pub fn validate_query_result(
        &self,
        capability: &CapabilityRef,
        snapshot: &QuerySnapshot,
    ) -> Result<(), OperationError> {
        self.snapshot().validate_query_result(capability, snapshot)
    }
    pub fn prepare_query_result(
        &self,
        context: &CallContext,
        capability: &CapabilityRef,
        snapshot: &mut QuerySnapshot,
    ) -> Result<(), OperationError> {
        self.snapshot()
            .prepare_query_result(context, capability, snapshot)
    }
    pub(crate) fn public_record(
        &self,
        context: &CallContext,
        record: OperationRecord,
    ) -> OperationRecord {
        self.snapshot().public_record(context, record)
    }
    pub(crate) fn read_link(
        &self,
        context: &CallContext,
        id: &str,
        purpose: &str,
        arguments: Value,
    ) -> Result<Option<NextRead>, OperationError> {
        self.snapshot().read_link(context, id, purpose, arguments)
    }
}

pub(crate) fn same_contract(a: &CapabilityDescriptor, b: &CapabilityDescriptor) -> bool {
    a.kind == b.kind
        && a.capability == b.capability
        && a.domain == b.domain
        && a.input_schema == b.input_schema
        && a.output_schema == b.output_schema
        && a.recovery_schema == b.recovery_schema
        && a.required_scopes == b.required_scopes
        && a.potential_effects == b.potential_effects
        && a.idempotency == b.idempotency
        && a.retry == b.retry
        && a.cancellation == b.cancellation
}
