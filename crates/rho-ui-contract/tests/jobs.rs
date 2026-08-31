use rho_ui_contract::*;

#[test]
fn jobs_fixture_validates_truthful_running_and_uncertain_states() {
    let fixture = jobs_fixture();
    fixture.validate().unwrap();
    assert_eq!(fixture.jobs[0].state, BackgroundJobStateV1::Running);
    assert_eq!(fixture.jobs[1].state, BackgroundJobStateV1::Uncertain);
    assert_eq!(
        fixture.jobs[1].cancel_state,
        JobCancelStateV1::ReconcileRequired
    );
    assert!(
        fixture.jobs[1]
            .safe_next_action
            .as_deref()
            .unwrap()
            .contains("do not replay")
    );
}

#[test]
fn jobs_artifact_is_openable_only_after_cas_commit() {
    let mut fixture = jobs_fixture();
    fixture.jobs[0].artifacts.push(JobArtifactV1 {
        artifact_id: "artifact_uncommitted".to_string(),
        digest: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
            .to_string(),
        media_type: "text/plain".to_string(),
        byte_size: 4,
    });
    assert!(fixture.validate().is_err());
    fixture.jobs[0].artifact_state = JobArtifactStateV1::Committed;
    fixture.validate().unwrap();
}

#[test]
fn jobs_cancelled_requires_confirmed_tree_or_reconcile_not_request_only() {
    let mut fixture = jobs_fixture();
    fixture.jobs[0].state = BackgroundJobStateV1::Cancelled;
    fixture.jobs[0].terminal_reason_code = Some("cancelled".to_string());
    fixture.jobs[0].cancel_state = JobCancelStateV1::Requested;
    assert!(fixture.validate().is_err());
    fixture.jobs[0].cancel_state = JobCancelStateV1::ProcessTreeConfirmed;
    fixture.validate().unwrap();
}
