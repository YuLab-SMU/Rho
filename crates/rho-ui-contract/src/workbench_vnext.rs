use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::{
    ContractError, RSR_CONTRACT_MAJOR, Validate, encoded_json_len, validate_json_value,
    validate_label, validate_opaque_text, validate_text, validate_unique,
};

pub const WORKBENCH_VNEXT_CONTRACT: &str = "rho.ui.workbench.vnext.v1";
pub const MAX_WORKBENCH_VNEXT_BYTES: usize = 2 * 1024 * 1024;
pub const MAX_COMMAND_ARGUMENT_BYTES: usize = 64 * 1024;
pub const MAX_GOAL_BYTES: usize = 16 * 1024;
pub const MAX_DURABLE_ACTIVITIES: usize = 512;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum ApprovalDecisionV1 {
    Approve,
    Deny,
    Cancel,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum DurableActivityStateV1 {
    Accepted,
    Committed,
    Running,
    WaitingApproval,
    Failed,
    Cancelled,
    Uncertain,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, specta::Type)]
pub struct WorkbenchHotCursorV1 {
    #[specta(type = crate::UiIpcNumber)]
    pub cursor: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, specta::Type)]
pub struct WorkbenchGapV1 {
    pub requested_after: WorkbenchHotCursorV1,
    pub oldest_available: WorkbenchHotCursorV1,
    pub latest: WorkbenchHotCursorV1,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, specta::Type)]
#[serde(tag = "command", rename_all = "snake_case")]
pub enum WorkbenchCommandV1 {
    SubmitGoal {
        goal_id: String,
        text: String,
        #[specta(type = crate::UiIpcNumber)]
        expected_snapshot_revision: u64,
    },
    ApprovalDecision {
        approval_id: String,
        decision: ApprovalDecisionV1,
        exact_effect_hash: String,
    },
    Cancel {
        activity_id: String,
    },
    ConfigureProvider {
        provider_config_id: String,
        provider_label: String,
        data_egress: String,
        read_only_external_observer: bool,
    },
    OpenArtifact {
        artifact_id: String,
        digest: String,
    },
    QueryJob {
        job_id: String,
        cursor: Option<WorkbenchHotCursorV1>,
    },
}

impl Validate for WorkbenchCommandV1 {
    fn validate(&self) -> Result<(), ContractError> {
        match self {
            Self::SubmitGoal { goal_id, text, .. } => {
                validate_opaque_text(goal_id, "command.goal_id")?;
                validate_text(text, "command.text", MAX_GOAL_BYTES, false, true)
            }
            Self::ApprovalDecision {
                approval_id,
                exact_effect_hash,
                ..
            } => {
                validate_opaque_text(approval_id, "command.approval_id")?;
                validate_opaque_text(exact_effect_hash, "command.exact_effect_hash")
            }
            Self::Cancel { activity_id } => {
                validate_opaque_text(activity_id, "command.activity_id")
            }
            Self::ConfigureProvider {
                provider_config_id,
                provider_label,
                data_egress,
                ..
            } => {
                validate_opaque_text(provider_config_id, "command.provider_config_id")?;
                validate_label(provider_label, "command.provider_label")?;
                if !matches!(
                    data_egress.as_str(),
                    "deny"
                        | "configured_provider_only"
                        | "allowlisted_destinations"
                        | "ask_for_unrestricted_destination"
                ) {
                    return Err(ContractError::InvalidValue {
                        path: "command.data_egress".to_string(),
                        reason: "unsupported data egress posture".to_string(),
                    });
                }
                Ok(())
            }
            Self::OpenArtifact {
                artifact_id,
                digest,
            } => {
                validate_opaque_text(artifact_id, "command.artifact_id")?;
                if !digest.starts_with("sha256:") {
                    return Err(ContractError::InvalidValue {
                        path: "command.digest".to_string(),
                        reason: "artifact open requires content digest".to_string(),
                    });
                }
                validate_opaque_text(digest, "command.digest")
            }
            Self::QueryJob { job_id, .. } => validate_opaque_text(job_id, "command.job_id"),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, specta::Type)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum WorkbenchCommandResponseV1 {
    Accepted {
        operation_id: String,
        #[specta(type = crate::UiIpcNumber)]
        accepted_at_revision: u64,
    },
    Committed {
        operation_id: String,
        event_id: String,
        #[specta(type = crate::UiIpcNumber)]
        snapshot_revision: u64,
    },
    Uncertain {
        operation_id: String,
        reason_code: String,
        reconcile_after_cursor: WorkbenchHotCursorV1,
    },
    Rejected {
        reason_code: String,
    },
}

impl Validate for WorkbenchCommandResponseV1 {
    fn validate(&self) -> Result<(), ContractError> {
        match self {
            Self::Accepted { operation_id, .. }
            | Self::Committed { operation_id, .. }
            | Self::Uncertain { operation_id, .. } => {
                validate_opaque_text(operation_id, "response.operation_id")?
            }
            Self::Rejected { .. } => {}
        }
        let encoded = serde_json::to_value(self).map_err(|error| ContractError::Serialization {
            path: "response".to_string(),
            reason: error.to_string(),
        })?;
        if encoded.get("ok").is_some() {
            return Err(ContractError::InvalidValue {
                path: "response.ok".to_string(),
                reason: "Workbench vNext responses must distinguish accepted/committed/uncertain/rejected".to_string(),
            });
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, specta::Type)]
pub struct DurableActivityProjectionV1 {
    pub activity_id: String,
    pub state: DurableActivityStateV1,
    pub label: String,
    pub event_id: Option<String>,
    #[specta(type = crate::UiIpcNumber)]
    pub snapshot_revision: u64,
}

impl Validate for DurableActivityProjectionV1 {
    fn validate(&self) -> Result<(), ContractError> {
        validate_opaque_text(&self.activity_id, "activity.activity_id")?;
        validate_label(&self.label, "activity.label")?;
        if let Some(event_id) = &self.event_id {
            validate_opaque_text(event_id, "activity.event_id")?;
        }
        if self.state == DurableActivityStateV1::Committed && self.event_id.is_none() {
            return Err(ContractError::InvalidValue {
                path: "activity.event_id".to_string(),
                reason: "committed activity requires durable event id".to_string(),
            });
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, specta::Type)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum WorkbenchLiveEventPayloadV1 {
    ActivityChanged {
        activity_id: String,
        state: DurableActivityStateV1,
    },
    Progress {
        key: String,
        label: String,
        #[specta(type = crate::UiIpcNumber)]
        value: u64,
    },
    Gap {
        gap: WorkbenchGapV1,
    },
    SnapshotInvalidated {
        #[specta(type = crate::UiIpcNumber)]
        snapshot_revision: u64,
    },
}

impl Validate for WorkbenchLiveEventPayloadV1 {
    fn validate(&self) -> Result<(), ContractError> {
        match self {
            Self::ActivityChanged { activity_id, .. } => {
                validate_opaque_text(activity_id, "live.activity_id")
            }
            Self::Progress { key, label, .. } => {
                validate_opaque_text(key, "live.progress.key")?;
                validate_label(label, "live.progress.label")
            }
            Self::Gap { .. } | Self::SnapshotInvalidated { .. } => Ok(()),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, specta::Type)]
pub struct WorkbenchLiveEventV1 {
    pub cursor: WorkbenchHotCursorV1,
    pub payload: WorkbenchLiveEventPayloadV1,
}

impl Validate for WorkbenchLiveEventV1 {
    fn validate(&self) -> Result<(), ContractError> {
        self.payload.validate()
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, specta::Type)]
pub struct WorkbenchSnapshotV1 {
    pub contract: String,
    #[specta(type = crate::UiIpcNumber)]
    pub contract_major: u16,
    #[specta(type = crate::UiIpcNumber)]
    pub snapshot_revision: u64,
    pub durable_activities: Vec<DurableActivityProjectionV1>,
    pub available_commands: Vec<String>,
    pub hot_cursor: WorkbenchHotCursorV1,
    pub provider_label: String,
    pub recovery_generation: String,
}

impl Validate for WorkbenchSnapshotV1 {
    fn validate(&self) -> Result<(), ContractError> {
        if self.contract != WORKBENCH_VNEXT_CONTRACT || self.contract_major != RSR_CONTRACT_MAJOR {
            return Err(ContractError::InvalidValue {
                path: "snapshot.contract".to_string(),
                reason: "unsupported Workbench vNext contract".to_string(),
            });
        }
        if self.durable_activities.len() > MAX_DURABLE_ACTIVITIES {
            return Err(ContractError::LimitExceeded {
                path: "snapshot.durable_activities".to_string(),
                limit: MAX_DURABLE_ACTIVITIES,
                actual: self.durable_activities.len(),
            });
        }
        validate_unique(
            "snapshot.durable_activities",
            self.durable_activities
                .iter()
                .map(|activity| activity.activity_id.as_str()),
        )?;
        for activity in &self.durable_activities {
            activity.validate()?;
        }
        validate_unique(
            "snapshot.available_commands",
            self.available_commands.iter().map(String::as_str),
        )?;
        for command in &self.available_commands {
            validate_opaque_text(command, "snapshot.command")?;
        }
        validate_label(&self.provider_label, "snapshot.provider_label")?;
        validate_opaque_text(&self.recovery_generation, "snapshot.recovery_generation")?;
        reject_forbidden_contract_terms("snapshot", self)?;
        let encoded = encoded_json_len("snapshot", self)?;
        if encoded > MAX_WORKBENCH_VNEXT_BYTES {
            return Err(ContractError::LimitExceeded {
                path: "snapshot".to_string(),
                limit: MAX_WORKBENCH_VNEXT_BYTES,
                actual: encoded,
            });
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, specta::Type)]
pub struct WorkbenchReconnectResponseV1 {
    pub snapshot: WorkbenchSnapshotV1,
    pub hot_cursor: WorkbenchHotCursorV1,
    pub gap: Option<WorkbenchGapV1>,
    pub replayed_token_history: bool,
}

impl Validate for WorkbenchReconnectResponseV1 {
    fn validate(&self) -> Result<(), ContractError> {
        self.snapshot.validate()?;
        if self.replayed_token_history {
            return Err(ContractError::InvalidValue {
                path: "reconnect.replayed_token_history".to_string(),
                reason: "reconnect returns durable snapshot plus cursor, not token history"
                    .to_string(),
            });
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, specta::Type)]
pub struct WorkbenchCommandEnvelopeV1 {
    pub contract: String,
    #[specta(type = crate::UiIpcNumber)]
    pub contract_major: u16,
    pub command: WorkbenchCommandV1,
    #[specta(type = crate::UiIpcUnknown)]
    pub bounded_arguments: Value,
}

impl Validate for WorkbenchCommandEnvelopeV1 {
    fn validate(&self) -> Result<(), ContractError> {
        if self.contract != WORKBENCH_VNEXT_CONTRACT || self.contract_major != RSR_CONTRACT_MAJOR {
            return Err(ContractError::InvalidValue {
                path: "command.contract".to_string(),
                reason: "unsupported Workbench vNext command contract".to_string(),
            });
        }
        self.command.validate()?;
        validate_json_value(
            "command.bounded_arguments",
            &self.bounded_arguments,
            MAX_COMMAND_ARGUMENT_BYTES,
        )?;
        reject_forbidden_contract_terms("command", self)
    }
}

pub fn decode_workbench_snapshot_value(value: Value) -> Result<WorkbenchSnapshotV1, ContractError> {
    let snapshot: WorkbenchSnapshotV1 =
        serde_json::from_value(value).map_err(|error| ContractError::Serialization {
            path: "snapshot".to_string(),
            reason: error.to_string(),
        })?;
    snapshot.validate()?;
    Ok(snapshot)
}

pub fn workbench_vnext_fixture() -> WorkbenchReconnectResponseV1 {
    WorkbenchReconnectResponseV1 {
        snapshot: WorkbenchSnapshotV1 {
            contract: WORKBENCH_VNEXT_CONTRACT.to_string(),
            contract_major: RSR_CONTRACT_MAJOR,
            snapshot_revision: 44,
            durable_activities: vec![
                DurableActivityProjectionV1 {
                    activity_id: "activity_goal".to_string(),
                    state: DurableActivityStateV1::Committed,
                    label: "Goal committed".to_string(),
                    event_id: Some("event_goal_submitted".to_string()),
                    snapshot_revision: 43,
                },
                DurableActivityProjectionV1 {
                    activity_id: "activity_run".to_string(),
                    state: DurableActivityStateV1::Uncertain,
                    label: "Execution needs reconciliation".to_string(),
                    event_id: None,
                    snapshot_revision: 44,
                },
            ],
            available_commands: vec![
                "submit_goal".to_string(),
                "approval_decision".to_string(),
                "cancel".to_string(),
                "configure_provider".to_string(),
                "open_artifact".to_string(),
                "query_job".to_string(),
            ],
            hot_cursor: WorkbenchHotCursorV1 { cursor: 91 },
            provider_label: "Configured provider".to_string(),
            recovery_generation: "recovery_gen_1".to_string(),
        },
        hot_cursor: WorkbenchHotCursorV1 { cursor: 91 },
        gap: None,
        replayed_token_history: false,
    }
}

pub fn workbench_command_fixtures() -> Vec<WorkbenchCommandEnvelopeV1> {
    vec![
        WorkbenchCommandEnvelopeV1 {
            contract: WORKBENCH_VNEXT_CONTRACT.to_string(),
            contract_major: RSR_CONTRACT_MAJOR,
            command: WorkbenchCommandV1::SubmitGoal {
                goal_id: "goal_next".to_string(),
                text: "Find sample-controlled cluster markers".to_string(),
                expected_snapshot_revision: 44,
            },
            bounded_arguments: json!({"goal_id": "goal_next"}),
        },
        WorkbenchCommandEnvelopeV1 {
            contract: WORKBENCH_VNEXT_CONTRACT.to_string(),
            contract_major: RSR_CONTRACT_MAJOR,
            command: WorkbenchCommandV1::ApprovalDecision {
                approval_id: "approval_run_r".to_string(),
                decision: ApprovalDecisionV1::Approve,
                exact_effect_hash:
                    "sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"
                        .to_string(),
            },
            bounded_arguments: json!({"approval_id": "approval_run_r"}),
        },
        WorkbenchCommandEnvelopeV1 {
            contract: WORKBENCH_VNEXT_CONTRACT.to_string(),
            contract_major: RSR_CONTRACT_MAJOR,
            command: WorkbenchCommandV1::Cancel {
                activity_id: "activity_run".to_string(),
            },
            bounded_arguments: json!({}),
        },
        WorkbenchCommandEnvelopeV1 {
            contract: WORKBENCH_VNEXT_CONTRACT.to_string(),
            contract_major: RSR_CONTRACT_MAJOR,
            command: WorkbenchCommandV1::ConfigureProvider {
                provider_config_id: "provider_config_main".to_string(),
                provider_label: "Configured provider".to_string(),
                data_egress: "configured_provider_only".to_string(),
                read_only_external_observer: false,
            },
            bounded_arguments: json!({"provider_config_id": "provider_config_main"}),
        },
        WorkbenchCommandEnvelopeV1 {
            contract: WORKBENCH_VNEXT_CONTRACT.to_string(),
            contract_major: RSR_CONTRACT_MAJOR,
            command: WorkbenchCommandV1::OpenArtifact {
                artifact_id: "artifact_plot".to_string(),
                digest: "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"
                    .to_string(),
            },
            bounded_arguments: json!({"artifact_id": "artifact_plot"}),
        },
        WorkbenchCommandEnvelopeV1 {
            contract: WORKBENCH_VNEXT_CONTRACT.to_string(),
            contract_major: RSR_CONTRACT_MAJOR,
            command: WorkbenchCommandV1::QueryJob {
                job_id: "job_run".to_string(),
                cursor: Some(WorkbenchHotCursorV1 { cursor: 91 }),
            },
            bounded_arguments: json!({"job_id": "job_run"}),
        },
    ]
}

fn reject_forbidden_contract_terms<T: Serialize>(
    path: &str,
    value: &T,
) -> Result<(), ContractError> {
    let serialized =
        serde_json::to_string(value).map_err(|error| ContractError::Serialization {
            path: path.to_string(),
            reason: error.to_string(),
        })?;
    for forbidden in [
        "acp",
        "provider_method",
        "provider_specific_enum",
        "private_thinking",
        "chain_of_thought",
        "raw_project_payload",
        "plaintext_secret",
    ] {
        if serialized.to_ascii_lowercase().contains(forbidden) {
            return Err(ContractError::InvalidValue {
                path: path.to_string(),
                reason: format!("forbidden Workbench contract term: {forbidden}"),
            });
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn workbench_vnext_reconnect_fixture_validates() {
        workbench_vnext_fixture().validate().unwrap();
    }

    #[test]
    fn workbench_vnext_command_fixtures_cover_required_commands() {
        let fixtures = workbench_command_fixtures();
        assert_eq!(fixtures.len(), 6);
        for fixture in fixtures {
            fixture.validate().unwrap();
        }
    }

    #[test]
    fn workbench_vnext_reconnect_rejects_token_history_replay() {
        let mut fixture = workbench_vnext_fixture();
        fixture.replayed_token_history = true;
        assert!(matches!(
            fixture.validate(),
            Err(ContractError::InvalidValue { path, .. })
                if path == "reconnect.replayed_token_history"
        ));
    }

    #[test]
    fn workbench_vnext_response_does_not_collapse_truth_into_ok_bool() {
        for response in [
            WorkbenchCommandResponseV1::Accepted {
                operation_id: "operation_accepted".to_string(),
                accepted_at_revision: 44,
            },
            WorkbenchCommandResponseV1::Committed {
                operation_id: "operation_committed".to_string(),
                event_id: "event_committed".to_string(),
                snapshot_revision: 45,
            },
            WorkbenchCommandResponseV1::Uncertain {
                operation_id: "operation_uncertain".to_string(),
                reason_code: "ack_without_commit".to_string(),
                reconcile_after_cursor: WorkbenchHotCursorV1 { cursor: 92 },
            },
            WorkbenchCommandResponseV1::Rejected {
                reason_code: "stale_revision".to_string(),
            },
        ] {
            response.validate().unwrap();
            assert!(serde_json::to_value(response).unwrap().get("ok").is_none());
        }
    }

    #[test]
    fn workbench_vnext_unknown_version_fails() {
        let mut value = serde_json::to_value(workbench_vnext_fixture().snapshot).unwrap();
        value["contract_major"] = json!(99);
        assert!(decode_workbench_snapshot_value(value).is_err());
    }
}
