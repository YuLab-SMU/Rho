use std::collections::BTreeSet;

use rho_protocol::{ArtifactId, ExecutionId, ExpectedOutput};
use serde::{Deserialize, Serialize};
use thiserror::Error;

pub const MAX_EXPECTED_OUTPUTS: usize = 256;
pub const MAX_EXPECTED_PATTERN_BYTES: usize = 4096;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct OutputCollectionPlan {
    pub execution_id: ExecutionId,
    pub expected_outputs: Vec<ExpectedOutput>,
    pub staging_handle_id: String,
}

#[derive(Debug, Error, Clone, PartialEq, Eq)]
pub enum CollectionPlanError {
    #[error("expected output manifest is empty or exceeds count bound")]
    OutputCount,
    #[error("expected output pattern is unsafe or unbounded")]
    UnsafePattern,
    #[error("expected output patterns collide")]
    DuplicatePattern,
    #[error("output staging handle is invalid")]
    InvalidStagingHandle,
}

impl OutputCollectionPlan {
    pub fn validate(&self) -> Result<(), CollectionPlanError> {
        if self.expected_outputs.is_empty() || self.expected_outputs.len() > MAX_EXPECTED_OUTPUTS {
            return Err(CollectionPlanError::OutputCount);
        }
        if self.staging_handle_id.is_empty() || self.staging_handle_id.len() > 256 {
            return Err(CollectionPlanError::InvalidStagingHandle);
        }
        let mut patterns = BTreeSet::new();
        for output in &self.expected_outputs {
            let pattern = &output.path_hint;
            if pattern.is_empty()
                || pattern.len() > MAX_EXPECTED_PATTERN_BYTES
                || pattern.starts_with('/')
                || pattern.contains("..")
                || pattern.contains('\\')
                || pattern.chars().any(char::is_control)
                || pattern.matches('*').count() > 1
                || (pattern.contains('*') && !pattern.contains("/*."))
            {
                return Err(CollectionPlanError::UnsafePattern);
            }
            if !patterns.insert(pattern.to_ascii_lowercase()) {
                return Err(CollectionPlanError::DuplicatePattern);
            }
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ProductCompletionState {
    ProcessRunning,
    ProcessFailed,
    CollectionPending,
    CollectionPartial,
    CollectionFailed,
    ProductSucceeded,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ExecutionProductTruth {
    pub execution_id: ExecutionId,
    pub process_succeeded: bool,
    pub collection_state: ProductCompletionState,
    pub required_artifact_ids: BTreeSet<ArtifactId>,
    pub committed_artifact_ids: BTreeSet<ArtifactId>,
    pub reason_code: String,
}

impl ExecutionProductTruth {
    pub fn new(execution_id: ExecutionId) -> Self {
        Self {
            execution_id,
            process_succeeded: false,
            collection_state: ProductCompletionState::ProcessRunning,
            required_artifact_ids: BTreeSet::new(),
            committed_artifact_ids: BTreeSet::new(),
            reason_code: "process_running".to_string(),
        }
    }

    pub fn observe_process_terminal(&mut self, succeeded: bool) {
        self.process_succeeded = succeeded;
        self.collection_state = if succeeded {
            ProductCompletionState::CollectionPending
        } else {
            ProductCompletionState::ProcessFailed
        };
        self.reason_code = if succeeded {
            "process_succeeded_collection_pending"
        } else {
            "process_failed"
        }
        .to_string();
    }

    pub fn observe_collection(
        &mut self,
        required: BTreeSet<ArtifactId>,
        committed: BTreeSet<ArtifactId>,
        failed: bool,
    ) {
        self.required_artifact_ids = required;
        self.committed_artifact_ids = committed;
        if !self.process_succeeded {
            self.collection_state = ProductCompletionState::ProcessFailed;
            return;
        }
        let complete = self
            .required_artifact_ids
            .is_subset(&self.committed_artifact_ids);
        self.collection_state = if complete && !failed {
            ProductCompletionState::ProductSucceeded
        } else if !self.committed_artifact_ids.is_empty() {
            ProductCompletionState::CollectionPartial
        } else {
            ProductCompletionState::CollectionFailed
        };
        self.reason_code = match self.collection_state {
            ProductCompletionState::ProductSucceeded => "required_artifacts_committed",
            ProductCompletionState::CollectionPartial => "partial_artifact_collection_reconcile",
            ProductCompletionState::CollectionFailed => "required_artifact_collection_failed",
            _ => "process_not_successful",
        }
        .to_string();
    }

    pub fn product_succeeded(&self) -> bool {
        self.collection_state == ProductCompletionState::ProductSucceeded
    }
}

pub fn collect_boundary() -> (&'static [&'static str], &'static [&'static str]) {
    (
        &[
            "expected_output_plan",
            "process_collection_split",
            "product_success_gate",
        ],
        &[
            "executor_artifact_path_claim",
            "running_process_collection",
            "process_exit_equals_product_success",
        ],
    )
}
