//! Bounded, passive observation of operations requested through Rho.
//!
//! The monitor records facts already present at the execution boundary. It
//! neither scores intent nor participates in admission.

use std::sync::Arc;

use rho_protocol::{CapabilityId, DestinationClass, EffectClass, OperationId};
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct OperationObservation {
    pub operation_id: OperationId,
    pub capability_id: CapabilityId,
    pub effect_class: EffectClass,
    pub destinations: Vec<DestinationClass>,
    pub argument_bytes: usize,
}

#[derive(Clone)]
pub struct OperationMonitor {
    sink: Arc<dyn Fn(OperationObservation) + Send + Sync>,
}

impl OperationMonitor {
    pub fn new(sink: impl Fn(OperationObservation) + Send + Sync + 'static) -> Self {
        Self {
            sink: Arc::new(sink),
        }
    }

    pub fn observe(
        &self,
        operation_id: OperationId,
        capability_id: CapabilityId,
        effect_class: EffectClass,
        destinations: Vec<DestinationClass>,
        arguments: &Value,
    ) -> OperationObservation {
        let observation = OperationObservation {
            operation_id,
            capability_id,
            effect_class,
            destinations,
            argument_bytes: serde_json::to_vec(arguments).map_or(0, |bytes| bytes.len()),
        };
        (self.sink)(observation.clone());
        observation
    }
}

pub fn operation_monitor_boundary() -> (&'static [&'static str], &'static [&'static str]) {
    (
        &["bounded_operation_facts", "passive_observation"],
        &["admission", "intent_scoring", "permission_decision"],
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn monitor_records_bounded_facts_without_a_decision() {
        let monitor = OperationMonitor::new(|_observation| {});
        let observation = monitor.observe(
            OperationId::new("operation-test").unwrap(),
            CapabilityId::new("workspace.run_r").unwrap(),
            EffectClass::WorkspaceMutation,
            vec![DestinationClass::LocalWorkspace],
            &serde_json::json!({"code": "x <- 1"}),
        );
        assert_eq!(observation.effect_class, EffectClass::WorkspaceMutation);
        assert!(observation.argument_bytes > 0);
        let (_, does_not_own) = operation_monitor_boundary();
        assert!(does_not_own.contains(&"permission_decision"));
    }
}
