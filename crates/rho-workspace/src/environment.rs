use std::collections::BTreeSet;

use rho_protocol::{
    EnvironmentIncidentV1, EnvironmentOperationOutcomeV1, EnvironmentOperationReceiptV1,
    KernelInstanceId, WorkspaceEnvironmentBindingV1,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use thiserror::Error;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum WorkspaceEnvironmentPhase {
    Unbound,
    Active,
    RestartRequired,
    ObservationRequired,
    BlockedByIncident,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct WorkspaceEnvironmentProbeObservation {
    pub probe_id: String,
    pub kind: String,
    pub passed: bool,
    pub detail: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct WorkspaceEnvironmentObservation {
    pub kernel_instance_id: KernelInstanceId,
    pub binding: WorkspaceEnvironmentBindingV1,
    pub probes: Vec<WorkspaceEnvironmentProbeObservation>,
    pub incidents: Vec<EnvironmentIncidentV1>,
    pub observed_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct WorkspaceEnvironmentStatus {
    pub phase: WorkspaceEnvironmentPhase,
    pub active_binding: Option<WorkspaceEnvironmentBindingV1>,
    pub pending_binding: Option<WorkspaceEnvironmentBindingV1>,
    pub restart_required: bool,
    pub reobserve_required: bool,
    pub incidents: Vec<EnvironmentIncidentV1>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub enum WorkspaceEnvironmentReobservation {
    Activated {
        binding: WorkspaceEnvironmentBindingV1,
    },
    Blocked {
        incidents: Vec<EnvironmentIncidentV1>,
    },
}

#[derive(Debug, Error, Clone, PartialEq, Eq)]
pub enum WorkspaceEnvironmentError {
    #[error("Environment binding requires a successful verified receipt")]
    UnverifiedReceipt,
    #[error("Environment binding does not match the receipt's exact revisions or digest")]
    ReceiptBindingMismatch,
    #[error("another Environment binding is already pending")]
    PendingBinding,
    #[error("Workspace restart is required before another execution")]
    RestartRequired,
    #[error("Workspace Environment re-observation is required before another execution")]
    ObservationRequired,
    #[error("Workspace execution names a stale or missing Environment binding")]
    ExecutionBindingMismatch,
    #[error("Workspace Environment restart requires a new kernel identity")]
    ReusedKernelIdentity,
    #[error("Workspace has no Environment restart pending")]
    NoRestartPending,
    #[error("Workspace has no Environment observation pending")]
    NoObservationPending,
    #[error("Environment observation came from a stale kernel")]
    StaleObservationKernel,
    #[error("Environment observation does not match the pending binding")]
    ObservationBindingMismatch,
    #[error("Environment observation is invalid: {0}")]
    InvalidObservation(String),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorkspaceEnvironmentGate {
    phase: WorkspaceEnvironmentPhase,
    active_binding: Option<WorkspaceEnvironmentBindingV1>,
    pending_binding: Option<WorkspaceEnvironmentBindingV1>,
    incidents: Vec<EnvironmentIncidentV1>,
}

impl WorkspaceEnvironmentGate {
    pub fn new(active_binding: Option<WorkspaceEnvironmentBindingV1>) -> Self {
        Self {
            phase: if active_binding.is_some() {
                WorkspaceEnvironmentPhase::Active
            } else {
                WorkspaceEnvironmentPhase::Unbound
            },
            active_binding,
            pending_binding: None,
            incidents: Vec::new(),
        }
    }

    pub fn stage_verified_binding(
        &mut self,
        binding: WorkspaceEnvironmentBindingV1,
        receipt: &EnvironmentOperationReceiptV1,
    ) -> Result<WorkspaceEnvironmentStatus, WorkspaceEnvironmentError> {
        receipt
            .validate()
            .map_err(|_| WorkspaceEnvironmentError::UnverifiedReceipt)?;
        if receipt.outcome != EnvironmentOperationOutcomeV1::Succeeded {
            return Err(WorkspaceEnvironmentError::UnverifiedReceipt);
        }
        let receipt_digest = serde_json::to_vec(receipt)
            .map(|bytes| format!("sha256:{:x}", Sha256::digest(bytes)))
            .map_err(|_| WorkspaceEnvironmentError::ReceiptBindingMismatch)?;
        if binding.desired_revision
            != *receipt
                .desired_after
                .as_ref()
                .ok_or(WorkspaceEnvironmentError::ReceiptBindingMismatch)?
            || binding.realization_revision
                != *receipt
                    .realization_after
                    .as_ref()
                    .ok_or(WorkspaceEnvironmentError::ReceiptBindingMismatch)?
            || binding.receipt_digest.as_str() != receipt_digest
        {
            return Err(WorkspaceEnvironmentError::ReceiptBindingMismatch);
        }
        if self.active_binding.as_ref() == Some(&binding) && self.pending_binding.is_none() {
            return Ok(self.status());
        }
        if let Some(pending) = self.pending_binding.as_ref() {
            if pending == &binding {
                return Ok(self.status());
            }
            return Err(WorkspaceEnvironmentError::PendingBinding);
        }
        self.pending_binding = Some(binding);
        self.incidents.clear();
        self.phase = if receipt.restart_required {
            WorkspaceEnvironmentPhase::RestartRequired
        } else {
            WorkspaceEnvironmentPhase::ObservationRequired
        };
        Ok(self.status())
    }

    pub fn admit_execution(
        &self,
        expected: Option<&WorkspaceEnvironmentBindingV1>,
    ) -> Result<(), WorkspaceEnvironmentError> {
        match self.phase {
            WorkspaceEnvironmentPhase::RestartRequired => {
                Err(WorkspaceEnvironmentError::RestartRequired)
            }
            WorkspaceEnvironmentPhase::ObservationRequired
            | WorkspaceEnvironmentPhase::BlockedByIncident => {
                Err(WorkspaceEnvironmentError::ObservationRequired)
            }
            WorkspaceEnvironmentPhase::Unbound | WorkspaceEnvironmentPhase::Active => {
                if self.active_binding.as_ref() == expected {
                    Ok(())
                } else {
                    Err(WorkspaceEnvironmentError::ExecutionBindingMismatch)
                }
            }
        }
    }

    pub fn record_restart(
        &mut self,
        old_kernel: &KernelInstanceId,
        new_kernel: &KernelInstanceId,
    ) -> Result<(), WorkspaceEnvironmentError> {
        if self.phase != WorkspaceEnvironmentPhase::RestartRequired {
            return Err(WorkspaceEnvironmentError::NoRestartPending);
        }
        if old_kernel == new_kernel {
            return Err(WorkspaceEnvironmentError::ReusedKernelIdentity);
        }
        self.phase = WorkspaceEnvironmentPhase::ObservationRequired;
        Ok(())
    }

    pub fn reobserve(
        &mut self,
        current_kernel: &KernelInstanceId,
        observation: WorkspaceEnvironmentObservation,
    ) -> Result<WorkspaceEnvironmentReobservation, WorkspaceEnvironmentError> {
        if !matches!(
            self.phase,
            WorkspaceEnvironmentPhase::ObservationRequired
                | WorkspaceEnvironmentPhase::BlockedByIncident
        ) {
            return Err(WorkspaceEnvironmentError::NoObservationPending);
        }
        if &observation.kernel_instance_id != current_kernel {
            return Err(WorkspaceEnvironmentError::StaleObservationKernel);
        }
        let pending = self
            .pending_binding
            .as_ref()
            .ok_or(WorkspaceEnvironmentError::NoObservationPending)?;
        if &observation.binding != pending {
            return Err(WorkspaceEnvironmentError::ObservationBindingMismatch);
        }
        validate_observation(pending, &observation)?;
        if observation.probes.iter().any(|probe| !probe.passed) || !observation.incidents.is_empty()
        {
            self.incidents = observation.incidents;
            self.phase = WorkspaceEnvironmentPhase::BlockedByIncident;
            return Ok(WorkspaceEnvironmentReobservation::Blocked {
                incidents: self.incidents.clone(),
            });
        }
        let binding = self
            .pending_binding
            .take()
            .ok_or(WorkspaceEnvironmentError::NoObservationPending)?;
        self.active_binding = Some(binding.clone());
        self.incidents.clear();
        self.phase = WorkspaceEnvironmentPhase::Active;
        Ok(WorkspaceEnvironmentReobservation::Activated { binding })
    }

    pub fn status(&self) -> WorkspaceEnvironmentStatus {
        WorkspaceEnvironmentStatus {
            phase: self.phase,
            active_binding: self.active_binding.clone(),
            pending_binding: self.pending_binding.clone(),
            restart_required: self.phase == WorkspaceEnvironmentPhase::RestartRequired,
            reobserve_required: matches!(
                self.phase,
                WorkspaceEnvironmentPhase::ObservationRequired
                    | WorkspaceEnvironmentPhase::BlockedByIncident
            ),
            incidents: self.incidents.clone(),
        }
    }
}

fn validate_observation(
    pending: &WorkspaceEnvironmentBindingV1,
    observation: &WorkspaceEnvironmentObservation,
) -> Result<(), WorkspaceEnvironmentError> {
    if observation.observed_at.is_empty()
        || observation.observed_at.trim() != observation.observed_at
        || observation.observed_at.chars().any(char::is_control)
        || observation.probes.is_empty()
    {
        return Err(WorkspaceEnvironmentError::InvalidObservation(
            "timestamp and at least one probe are required".to_string(),
        ));
    }
    let mut probe_ids = BTreeSet::new();
    for probe in &observation.probes {
        if probe.probe_id.is_empty()
            || probe.kind.is_empty()
            || probe.detail.is_empty()
            || !probe_ids.insert(probe.probe_id.as_str())
        {
            return Err(WorkspaceEnvironmentError::InvalidObservation(
                "probe identities and details must be non-empty and unique".to_string(),
            ));
        }
    }
    let mut incident_ids = BTreeSet::new();
    for incident in &observation.incidents {
        if incident.environment_id != pending.environment_id
            || !incident_ids.insert(incident.incident_id.as_str())
        {
            return Err(WorkspaceEnvironmentError::InvalidObservation(
                "incident identity is duplicated or names another Environment".to_string(),
            ));
        }
    }
    if observation.probes.iter().any(|probe| !probe.passed) && observation.incidents.is_empty() {
        return Err(WorkspaceEnvironmentError::InvalidObservation(
            "failed probes require a structured PackageIncident".to_string(),
        ));
    }
    Ok(())
}
