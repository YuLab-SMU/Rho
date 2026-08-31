use std::collections::BTreeSet;

use rho_test_support::*;

#[test]
fn golden_path_skeleton_runs_deterministically() {
    let scenario = golden_path_skeleton();
    let first = ScenarioHarness::deterministic().run(&scenario).unwrap();
    let second = ScenarioHarness::deterministic().run(&scenario).unwrap();

    assert_eq!(first, second);
    assert_eq!(first.status, ScenarioStatus::Runnable);
    assert_eq!(first.snapshot_comparison, SnapshotComparison::Equal);
    assert_eq!(first.events.first().unwrap().at_ms, 1_780_000_000_000);
    assert!(first.events.iter().any(|event| event.kind == "Recover"));
}

#[test]
fn golden_path_contains_required_journey_steps_in_order() {
    let scenario = golden_path_skeleton();
    let kinds = scenario
        .steps
        .iter()
        .map(|step| step.kind)
        .collect::<Vec<_>>();

    assert_eq!(
        kinds,
        vec![
            ScenarioStepKind::GoalSubmitted,
            ScenarioStepKind::Observe,
            ScenarioStepKind::Plan,
            ScenarioStepKind::ApprovalRequested,
            ScenarioStepKind::Execute,
            ScenarioStepKind::RevisionTransition,
            ScenarioStepKind::Reobserve,
            ScenarioStepKind::ArtifactCommitted,
            ScenarioStepKind::CrashInjected,
            ScenarioStepKind::Recover,
        ]
    );
}

#[test]
fn every_fault_hook_can_be_hit_before_and_after_the_boundary() {
    let scenario = golden_path_skeleton();
    let declared = scenario
        .fault_points
        .iter()
        .copied()
        .collect::<BTreeSet<_>>();
    let expected = all_fault_points().into_iter().collect::<BTreeSet<_>>();
    assert_eq!(declared, expected);

    for fault in expected {
        let report = ScenarioHarness::deterministic()
            .with_fault(fault)
            .run(&scenario)
            .unwrap();
        assert_eq!(
            report.hit_faults,
            vec![fault],
            "fault was not hit: {fault:?}"
        );
        assert!(report.events.iter().any(|event| event.kind == "FaultHit"));
    }
}

#[test]
fn adversarial_fixtures_have_truthful_expected_failure_reasons() {
    let catalog = adversarial_scenario_catalog();
    assert_eq!(catalog.len(), 5);
    for scenario in catalog {
        assert_eq!(scenario.status, ScenarioStatus::ExpectedFailure);
        assert!(scenario.skip_reason.as_deref().is_some_and(|reason| {
            reason.contains("before implementation package owns adapter behavior")
        }));
        scenario.validate().unwrap();
    }
}

#[test]
fn store_snapshot_comparer_is_machine_comparable() {
    let scenario = golden_path_skeleton();
    let comparer = StoreSnapshotComparer {
        expected: scenario.expected_store.clone(),
    };
    assert_eq!(
        comparer.compare(&scenario.expected_store),
        SnapshotComparison::Equal
    );

    let mut actual = scenario.expected_store.clone();
    actual.projections["workspace_revision"] = serde_json::json!(999);
    assert!(matches!(
        comparer.compare(&actual),
        SnapshotComparison::Different { .. }
    ));
}
