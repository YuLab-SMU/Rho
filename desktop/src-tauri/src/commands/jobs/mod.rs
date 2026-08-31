use rho_ui_contract::{JobsSnapshotV1, WorkbenchCommandResponseV1};

// Contract harness only. A fixture must never be exposed as a production
// Tauri command; register a Jobs adapter only when it reads authoritative state.
pub(crate) fn jobs_snapshot() -> JobsSnapshotV1 {
    rho_ui_contract::jobs_fixture()
}

pub(crate) fn jobs_cancel(job_id: String) -> WorkbenchCommandResponseV1 {
    if job_id.is_empty() || job_id.len() > 256 {
        return WorkbenchCommandResponseV1::Rejected {
            reason_code: "invalid_job_id".to_string(),
        };
    }
    WorkbenchCommandResponseV1::Accepted {
        operation_id: format!("operation_cancel_{job_id}"),
        accepted_at_revision: 0,
    }
}

#[cfg(test)]
mod tests {
    use rho_ui_contract::Validate;

    use super::*;

    #[test]
    fn jobs_contract_command_fixture_validates() {
        jobs_snapshot().validate().unwrap();
        assert!(matches!(
            jobs_cancel("job_local_running".to_string()),
            WorkbenchCommandResponseV1::Accepted { .. }
        ));
    }
}
