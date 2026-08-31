use std::collections::BTreeSet;

use rho_execution::collect::*;
use rho_protocol::*;

fn expected(path: &str, required: bool) -> ExpectedOutput {
    ExpectedOutput {
        artifact_id: None,
        path_hint: path.to_string(),
        required,
    }
}

#[test]
fn collect_plan_validates_bounded_exact_or_single_glob_manifest() {
    let plan = OutputCollectionPlan {
        execution_id: ExecutionId::new("execution_collect_plan").unwrap(),
        expected_outputs: vec![
            expected("results/*.csv", true),
            expected("summary.json", false),
        ],
        staging_handle_id: "staging_handle_collect".to_string(),
    };
    plan.validate().unwrap();
    for bad in ["../escape", "/absolute", "a\\b", "**/*.csv", "dir/*"] {
        let bad_plan = OutputCollectionPlan {
            execution_id: ExecutionId::new("execution_collect_bad").unwrap(),
            expected_outputs: vec![expected(bad, true)],
            staging_handle_id: "staging".to_string(),
        };
        assert!(bad_plan.validate().is_err(), "pattern should fail: {bad}");
    }
}

#[test]
fn collect_product_truth_requires_process_success_and_all_required_cas_artifacts() {
    let execution_id = ExecutionId::new("execution_product_truth").unwrap();
    let required = ArtifactId::new("artifact_required").unwrap();
    let mut truth = ExecutionProductTruth::new(execution_id);
    assert_eq!(
        truth.collection_state,
        ProductCompletionState::ProcessRunning
    );
    assert!(!truth.product_succeeded());
    truth.observe_process_terminal(true);
    assert_eq!(
        truth.collection_state,
        ProductCompletionState::CollectionPending
    );
    assert!(!truth.product_succeeded());
    truth.observe_collection(BTreeSet::from([required.clone()]), BTreeSet::new(), true);
    assert_eq!(
        truth.collection_state,
        ProductCompletionState::CollectionFailed
    );
    truth.observe_collection(
        BTreeSet::from([required.clone()]),
        BTreeSet::from([required]),
        false,
    );
    assert_eq!(
        truth.collection_state,
        ProductCompletionState::ProductSucceeded
    );
    assert!(truth.product_succeeded());
}

#[test]
fn collect_partial_status_is_truthful_and_process_failure_never_becomes_product_success() {
    let required_a = ArtifactId::new("artifact_a").unwrap();
    let required_b = ArtifactId::new("artifact_b").unwrap();
    let mut partial =
        ExecutionProductTruth::new(ExecutionId::new("execution_product_partial").unwrap());
    partial.observe_process_terminal(true);
    partial.observe_collection(
        BTreeSet::from([required_a.clone(), required_b]),
        BTreeSet::from([required_a]),
        true,
    );
    assert_eq!(
        partial.collection_state,
        ProductCompletionState::CollectionPartial
    );
    assert!(!partial.product_succeeded());

    let mut failed =
        ExecutionProductTruth::new(ExecutionId::new("execution_product_process_failed").unwrap());
    failed.observe_process_terminal(false);
    failed.observe_collection(BTreeSet::new(), BTreeSet::new(), false);
    assert_eq!(
        failed.collection_state,
        ProductCompletionState::ProcessFailed
    );
    assert!(!failed.product_succeeded());
}

#[test]
fn collect_boundary_separates_process_terminal_from_artifact_product_truth() {
    let (_, does_not_own) = collect_boundary();
    assert!(does_not_own.contains(&"executor_artifact_path_claim"));
    assert!(does_not_own.contains(&"running_process_collection"));
    assert!(does_not_own.contains(&"process_exit_equals_product_success"));
}
