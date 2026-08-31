use rho_protocol::*;
use rho_workspace::{WorkspaceRevisionTracker, WorkspaceTerminalOutcome};

fn tracker() -> WorkspaceRevisionTracker {
    WorkspaceRevisionTracker::new(
        WorkspaceId::new("workspace_main").unwrap(),
        KernelInstanceId::new("kernel_a").unwrap(),
        StateRevision(4),
        ProjectRevision(9),
    )
}

#[test]
fn revision_pure_observation_keeps_before_equal_after() {
    let tracker = tracker();
    let observed = tracker
        .observe(&KernelInstanceId::new("kernel_a").unwrap())
        .unwrap();
    assert_eq!(observed.before, observed.after);
    assert_eq!(observed.after.state_revision, StateRevision(4));
}

#[test]
fn revision_old_kernel_observation_is_stale() {
    let tracker = tracker();
    let stale = tracker.observe(&KernelInstanceId::new("kernel_old").unwrap());
    assert!(matches!(
        stale,
        Err(RevisionError::StaleKernel { expected, actual })
            if expected.as_str() == "kernel_a" && actual.as_str() == "kernel_old"
    ));
}

#[test]
fn revision_failed_arbitrary_execution_advances_once() {
    let mut tracker = tracker();
    let outcome = tracker
        .record_terminal_execution("event_terminal_1", ExecutionTerminalOutcome::Failed, true)
        .unwrap();
    assert!(matches!(
        outcome,
        WorkspaceTerminalOutcome::Advanced(RevisionTransition { before, after })
            if before.state_revision == StateRevision(4) && after.state_revision == StateRevision(5)
    ));

    let duplicate = tracker
        .record_terminal_execution("event_terminal_1", ExecutionTerminalOutcome::Failed, true)
        .unwrap();
    assert!(matches!(
        duplicate,
        WorkspaceTerminalOutcome::Duplicate(stamp) if stamp.state_revision == StateRevision(5)
    ));
}

#[test]
fn revision_kernel_restart_marks_new_identity_and_advances_state() {
    let mut tracker = tracker();
    let transition = tracker.restart_kernel(KernelInstanceId::new("kernel_b").unwrap());
    assert_eq!(transition.before.kernel_instance_id.as_str(), "kernel_a");
    assert_eq!(transition.after.kernel_instance_id.as_str(), "kernel_b");
    assert_eq!(transition.after.state_revision, StateRevision(5));
}
