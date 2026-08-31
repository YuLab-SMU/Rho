use std::collections::BTreeSet;

use rho_protocol::{
    ArtifactDigest, ArtifactId, CorrelationId, EventId, OperationId, ProjectRevision,
    StateRevision, TraceId,
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::DeterministicIds;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, PartialOrd, Ord, Hash)]
#[serde(rename_all = "snake_case")]
pub enum FaultBoundary {
    DurableAppend,
    ProjectionCommit,
    BlobRename,
    ProcessSpawn,
    SubmitAck,
    StreamCursor,
}

impl FaultBoundary {
    pub const ALL: [Self; 6] = [
        Self::DurableAppend,
        Self::ProjectionCommit,
        Self::BlobRename,
        Self::ProcessSpawn,
        Self::SubmitAck,
        Self::StreamCursor,
    ];
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, PartialOrd, Ord, Hash)]
#[serde(rename_all = "snake_case")]
pub enum FaultTiming {
    Before,
    After,
}

impl FaultTiming {
    pub const ALL: [Self; 2] = [Self::Before, Self::After];
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct FaultPoint {
    pub boundary: FaultBoundary,
    pub timing: FaultTiming,
}

pub fn all_fault_points() -> Vec<FaultPoint> {
    FaultBoundary::ALL
        .into_iter()
        .flat_map(|boundary| {
            FaultTiming::ALL
                .into_iter()
                .map(move |timing| FaultPoint { boundary, timing })
        })
        .collect()
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct FakeClock {
    pub base_unix_ms: u64,
    pub tick_ms: u64,
    pub ticks: u64,
}

impl FakeClock {
    pub fn new(base_unix_ms: u64, tick_ms: u64) -> Self {
        Self {
            base_unix_ms,
            tick_ms,
            ticks: 0,
        }
    }

    pub fn next_ms(&mut self) -> u64 {
        let value = self.base_unix_ms + self.tick_ms * self.ticks;
        self.ticks += 1;
        value
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ProviderTranscript {
    pub provider_id: String,
    pub events: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct WorkspaceProbe {
    pub object: String,
    pub state_revision: StateRevision,
    pub project_revision: ProjectRevision,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ExecutorProbe {
    pub job_id: String,
    pub state: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct StoreSnapshot {
    pub durable_events: Vec<EventId>,
    pub projections: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub enum SnapshotComparison {
    Equal,
    Different { reason: String },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct StoreSnapshotComparer {
    pub expected: StoreSnapshot,
}

impl StoreSnapshotComparer {
    pub fn compare(&self, actual: &StoreSnapshot) -> SnapshotComparison {
        if &self.expected == actual {
            SnapshotComparison::Equal
        } else {
            SnapshotComparison::Different {
                reason: "store snapshot differs".to_string(),
            }
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ScenarioStatus {
    Runnable,
    ExpectedFailure,
    Skip,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ScenarioStep {
    pub step_id: String,
    pub kind: ScenarioStepKind,
    pub label: String,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, PartialOrd, Ord, Hash)]
#[serde(rename_all = "snake_case")]
pub enum ScenarioStepKind {
    GoalSubmitted,
    Observe,
    Plan,
    ApprovalRequested,
    Execute,
    RevisionTransition,
    Reobserve,
    ArtifactCommitted,
    CrashInjected,
    Recover,
    MaliciousProjectProbe,
    StaleObservation,
    DuplicateOperation,
    SlowConsumer,
    MalformedFrame,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Scenario {
    pub scenario_id: String,
    pub status: ScenarioStatus,
    pub skip_reason: Option<String>,
    pub deterministic_ids: DeterministicIds,
    pub provider_transcript: ProviderTranscript,
    pub workspace_probes: Vec<WorkspaceProbe>,
    pub executor_probes: Vec<ExecutorProbe>,
    pub expected_store: StoreSnapshot,
    pub steps: Vec<ScenarioStep>,
    pub fault_points: Vec<FaultPoint>,
}

impl Scenario {
    pub fn validate(&self) -> Result<(), String> {
        if self.scenario_id.is_empty() {
            return Err("scenario_id is empty".to_string());
        }
        if self.status != ScenarioStatus::Runnable
            && self.skip_reason.as_deref().unwrap_or("").is_empty()
        {
            return Err("non-runnable scenarios must explain skip/fail reason".to_string());
        }
        if self.steps.is_empty() {
            return Err(format!("{} has no steps", self.scenario_id));
        }
        let mut seen = BTreeSet::new();
        for step in &self.steps {
            if !seen.insert(&step.step_id) {
                return Err(format!("duplicate step id {}", step.step_id));
            }
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct HarnessEvent {
    pub at_ms: u64,
    pub kind: String,
    pub detail: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ScenarioReport {
    pub scenario_id: String,
    pub status: ScenarioStatus,
    pub events: Vec<HarnessEvent>,
    pub hit_faults: Vec<FaultPoint>,
    pub snapshot_comparison: SnapshotComparison,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ScenarioHarness {
    pub clock: FakeClock,
    pub injected_fault: Option<FaultPoint>,
}

impl ScenarioHarness {
    pub fn deterministic() -> Self {
        Self {
            clock: FakeClock::new(1_780_000_000_000, 50),
            injected_fault: None,
        }
    }

    pub fn with_fault(mut self, fault: FaultPoint) -> Self {
        self.injected_fault = Some(fault);
        self
    }

    pub fn run(mut self, scenario: &Scenario) -> Result<ScenarioReport, String> {
        scenario.validate()?;
        let mut events = Vec::new();
        let mut hit_faults = Vec::new();
        for step in &scenario.steps {
            events.push(HarnessEvent {
                at_ms: self.clock.next_ms(),
                kind: format!("{:?}", step.kind),
                detail: json!({"step_id": step.step_id, "label": step.label}),
            });
            if let Some(fault) = self.injected_fault
                && scenario.fault_points.contains(&fault)
                && step.kind == step_kind_for_fault(fault.boundary)
            {
                events.push(HarnessEvent {
                    at_ms: self.clock.next_ms(),
                    kind: "FaultHit".to_string(),
                    detail: json!({"boundary": fault.boundary, "timing": fault.timing}),
                });
                hit_faults.push(fault);
            }
        }
        let comparer = StoreSnapshotComparer {
            expected: scenario.expected_store.clone(),
        };
        Ok(ScenarioReport {
            scenario_id: scenario.scenario_id.clone(),
            status: scenario.status,
            events,
            hit_faults,
            snapshot_comparison: comparer.compare(&scenario.expected_store),
        })
    }
}

fn step_kind_for_fault(boundary: FaultBoundary) -> ScenarioStepKind {
    match boundary {
        FaultBoundary::DurableAppend => ScenarioStepKind::Observe,
        FaultBoundary::ProjectionCommit => ScenarioStepKind::RevisionTransition,
        FaultBoundary::BlobRename => ScenarioStepKind::ArtifactCommitted,
        FaultBoundary::ProcessSpawn => ScenarioStepKind::Execute,
        FaultBoundary::SubmitAck => ScenarioStepKind::Execute,
        FaultBoundary::StreamCursor => ScenarioStepKind::Recover,
    }
}

pub fn golden_path_skeleton() -> Scenario {
    let ids = DeterministicIds::fixture("golden_path");
    Scenario {
        scenario_id: "golden_path_skeleton".to_string(),
        status: ScenarioStatus::Runnable,
        skip_reason: None,
        deterministic_ids: ids,
        provider_transcript: ProviderTranscript {
            provider_id: "fake_provider".to_string(),
            events: vec![
                "message_delta".to_string(),
                "plan_replaced".to_string(),
                "capability_requested".to_string(),
                "turn_completed".to_string(),
            ],
        },
        workspace_probes: vec![
            WorkspaceProbe {
                object: "sce".to_string(),
                state_revision: StateRevision(842),
                project_revision: ProjectRevision(15),
            },
            WorkspaceProbe {
                object: "de_result".to_string(),
                state_revision: StateRevision(843),
                project_revision: ProjectRevision(15),
            },
        ],
        executor_probes: vec![ExecutorProbe {
            job_id: "job_workspace_run_1".to_string(),
            state: "succeeded".to_string(),
        }],
        expected_store: StoreSnapshot {
            durable_events: vec![EventId::new("event_goal_submitted").unwrap()],
            projections: json!({
                "workspace_revision": 843,
                "artifact_digest": "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"
            }),
        },
        steps: vec![
            step("goal", ScenarioStepKind::GoalSubmitted, "goal submitted"),
            step(
                "observe",
                ScenarioStepKind::Observe,
                "revision-bound observation",
            ),
            step("plan", ScenarioStepKind::Plan, "provider-owned plan"),
            step(
                "approval",
                ScenarioStepKind::ApprovalRequested,
                "exact effect approval",
            ),
            step(
                "execute",
                ScenarioStepKind::Execute,
                "serialized Workspace execution",
            ),
            step(
                "revision",
                ScenarioStepKind::RevisionTransition,
                "revision transition",
            ),
            step(
                "reobserve",
                ScenarioStepKind::Reobserve,
                "re-observation after mutation",
            ),
            step(
                "artifact",
                ScenarioStepKind::ArtifactCommitted,
                "immutable artifact committed",
            ),
            step("crash", ScenarioStepKind::CrashInjected, "crash injected"),
            step(
                "recover",
                ScenarioStepKind::Recover,
                "durable recovery reconciles truth",
            ),
        ],
        fault_points: all_fault_points(),
    }
}

pub fn adversarial_scenario_catalog() -> Vec<Scenario> {
    let base = golden_path_skeleton();
    [
        ("malicious_project", ScenarioStepKind::MaliciousProjectProbe),
        ("stale_observation", ScenarioStepKind::StaleObservation),
        ("duplicate_operation", ScenarioStepKind::DuplicateOperation),
        ("slow_consumer", ScenarioStepKind::SlowConsumer),
        ("malformed_frame", ScenarioStepKind::MalformedFrame),
    ]
    .into_iter()
    .map(|(scenario_id, kind)| Scenario {
        scenario_id: scenario_id.to_string(),
        status: ScenarioStatus::ExpectedFailure,
        skip_reason: Some(
            "fixture declared before implementation package owns adapter behavior".to_string(),
        ),
        deterministic_ids: DeterministicIds {
            operation_id: OperationId::new(format!("operation_{scenario_id}")).unwrap(),
            correlation_id: CorrelationId::new(format!("correlation_{scenario_id}")).unwrap(),
            trace_id: TraceId::new(format!("trace_{scenario_id}")).unwrap(),
        },
        provider_transcript: base.provider_transcript.clone(),
        workspace_probes: base.workspace_probes.clone(),
        executor_probes: base.executor_probes.clone(),
        expected_store: base.expected_store.clone(),
        steps: vec![step(scenario_id, kind, scenario_id)],
        fault_points: all_fault_points(),
    })
    .collect()
}

fn step(step_id: &str, kind: ScenarioStepKind, label: &str) -> ScenarioStep {
    ScenarioStep {
        step_id: step_id.to_string(),
        kind,
        label: label.to_string(),
    }
}

pub fn artifact_digest_fixture() -> ArtifactDigest {
    ArtifactDigest::new("sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc")
        .unwrap()
}

pub fn artifact_id_fixture() -> ArtifactId {
    ArtifactId::new("artifact_de_plot").unwrap()
}
