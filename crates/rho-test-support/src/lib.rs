#![forbid(unsafe_code)]
//! Shared deterministic fixtures for clean-slate control-plane and recovery tests.

pub mod scenario;

pub use scenario::*;

use rho_protocol::{CorrelationId, OperationId, TraceId};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TestSupportBoundary {
    pub owns: &'static [&'static str],
    pub does_not_own: &'static [&'static str],
}

pub fn boundary() -> TestSupportBoundary {
    TestSupportBoundary {
        owns: &["deterministic_ids", "fake_clock", "scenario_fixtures"],
        does_not_own: &["production_authority", "runtime_dual_path", "old_adapter"],
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct DeterministicIds {
    pub operation_id: OperationId,
    pub correlation_id: CorrelationId,
    pub trace_id: TraceId,
}

impl DeterministicIds {
    pub fn fixture(seed: &str) -> Self {
        Self {
            operation_id: OperationId::new(format!("operation_{seed}")).unwrap(),
            correlation_id: CorrelationId::new(format!("correlation_{seed}")).unwrap(),
            trace_id: TraceId::new(format!("trace_{seed}")).unwrap(),
        }
    }
}
