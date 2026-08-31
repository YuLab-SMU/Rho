use std::{
    collections::BTreeMap,
    fs,
    process::{Command, Stdio},
    time::Instant,
};

use rho_artifact_store::{ArtifactCommitRequest, ArtifactStore, ArtifactStoreConfig};
use rho_control_plane::{CapabilityRegistry, evaluate_policy, policy_context_fixture};
use rho_event_hub::{HotCursor, HotEventHub};
use rho_protocol::*;
use rho_sandbox::snapshot::{SnapshotLimits, build_project_snapshot};
use rho_store::SemanticStore;
use serde::Serialize;

#[derive(Debug, Serialize)]
struct Distribution {
    samples: usize,
    cold_ms: f64,
    p50_ms: f64,
    p95_ms: f64,
    p99_ms: f64,
    max_ms: f64,
}

#[derive(Debug, Serialize)]
struct ProbeReport {
    schema: &'static str,
    hardware: BTreeMap<String, String>,
    metrics: BTreeMap<String, Distribution>,
    soak: BTreeMap<String, u64>,
}

fn main() {
    let mut metrics = BTreeMap::new();
    metrics.insert("durable_append".to_string(), durable_append());
    metrics.insert("cas_commit_4k".to_string(), cas_commit());
    metrics.insert("projection_recovery".to_string(), projection_recovery());
    metrics.insert("first_visible_activity".to_string(), first_activity());
    metrics.insert("hot_reconnect_read".to_string(), hot_reconnect());
    metrics.insert("policy_approval_decision".to_string(), policy_decision());
    metrics.insert("sandbox_snapshot_startup".to_string(), sandbox_snapshot());
    metrics.insert("process_tree_cancel".to_string(), process_tree_cancel());
    metrics.insert("local_process_startup".to_string(), local_process_startup());
    let (storm, soak) = event_storm();
    metrics.insert("event_storm_publish".to_string(), storm);
    let report = ProbeReport {
        schema: "rho.performance.probe.v1",
        hardware: BTreeMap::from([
            ("os".to_string(), std::env::consts::OS.to_string()),
            ("arch".to_string(), std::env::consts::ARCH.to_string()),
            ("profile".to_string(), "desktop-local-release-like".to_string()),
        ]),
        metrics,
        soak,
    };
    println!("{}", serde_json::to_string_pretty(&report).unwrap());
}

fn durable_append() -> Distribution {
    let temp = tempfile::tempdir().unwrap();
    let db = temp.path().join("app/semantic.sqlite3");
    let (mut store, _) = SemanticStore::open_app_local(temp.path(), &db).unwrap();
    let mut seq = 0_u64;
    sample(300, || {
        let event = semantic_event(seq);
        let started = Instant::now();
        store.append_semantic_event(StreamSeq(seq), &event).unwrap();
        seq += 1;
        started.elapsed().as_secs_f64() * 1000.0
    })
}

fn cas_commit() -> Distribution {
    let temp = tempfile::tempdir().unwrap();
    let mut store = ArtifactStore::open(
        temp.path(),
        ArtifactStoreConfig {
            max_artifact_bytes: 1024 * 1024,
            max_total_bytes: 16 * 1024 * 1024,
        },
    )
    .unwrap();
    let mut index = 0_u64;
    sample(120, || {
        let mut bytes = vec![0_u8; 4096];
        bytes[..8].copy_from_slice(&index.to_be_bytes());
        let started = Instant::now();
        store
            .commit(ArtifactCommitRequest {
                bytes,
                media_type: Some("application/octet-stream".to_string()),
                execution_id: Some(ExecutionId::new(format!("execution_perf_{index}")).unwrap()),
                revision: revision(),
                inputs: Vec::new(),
                environment_digest: None,
            })
            .unwrap();
        index += 1;
        started.elapsed().as_secs_f64() * 1000.0
    })
}

fn projection_recovery() -> Distribution {
    let temp = tempfile::tempdir().unwrap();
    let db = temp.path().join("app/semantic.sqlite3");
    let (mut store, _) = SemanticStore::open_app_local(temp.path(), &db).unwrap();
    for seq in 0..500 {
        store
            .append_semantic_event(StreamSeq(seq), &semantic_event(seq))
            .unwrap();
    }
    sample(10, || {
        let started = Instant::now();
        store.rebuild_projection().unwrap();
        started.elapsed().as_secs_f64() * 1000.0
    })
}

fn first_activity() -> Distribution {
    sample(500, || {
        let mut hub = HotEventHub::new(64 * 1024, 1024 * 1024).unwrap();
        let started = Instant::now();
        hub.publish(
            SessionId::new("session_perf_first").unwrap(),
            hot_event("first", 0),
        )
        .unwrap();
        started.elapsed().as_secs_f64() * 1000.0
    })
}

fn hot_reconnect() -> Distribution {
    let mut hub = HotEventHub::new(64 * 1024, 1024 * 1024).unwrap();
    let session = SessionId::new("session_perf_reconnect").unwrap();
    for cursor in 0..200 {
        hub.publish(session.clone(), hot_event("reconnect", cursor))
            .unwrap();
    }
    sample(1000, || {
        let started = Instant::now();
        let _ = hub.read(&session, HotCursor(0), 64);
        started.elapsed().as_secs_f64() * 1000.0
    })
}

fn policy_decision() -> Distribution {
    let registry = CapabilityRegistry::canonical().unwrap();
    let context = policy_context_fixture(
        CapabilityId::new(RUN_R_CAPABILITY).unwrap(),
        OperationId::new("operation_perf_policy").unwrap(),
    );
    sample(2000, || {
        let started = Instant::now();
        let _ = evaluate_policy(&registry, &context);
        started.elapsed().as_secs_f64() * 1000.0
    })
}

fn sandbox_snapshot() -> Distribution {
    let project = tempfile::tempdir().unwrap();
    for index in 0..100 {
        fs::write(
            project.path().join(format!("file_{index}.txt")),
            vec![index as u8; 1024],
        )
        .unwrap();
    }
    sample(30, || {
        let started = Instant::now();
        build_project_snapshot(
            project.path(),
            ProjectRevision(1),
            SnapshotLimits::default(),
        )
        .unwrap();
        started.elapsed().as_secs_f64() * 1000.0
    })
}

fn local_process_startup() -> Distribution {
    sample(30, || {
        let started = Instant::now();
        let status = Command::new("/usr/bin/true")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .unwrap();
        assert!(status.success());
        started.elapsed().as_secs_f64() * 1000.0
    })
}

#[cfg(unix)]
fn process_tree_cancel() -> Distribution {
    use std::os::unix::process::CommandExt;
    sample(20, || {
        let mut command = Command::new("/bin/sleep");
        command
            .arg("30")
            .process_group(0)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        let mut child = command.spawn().unwrap();
        let started = Instant::now();
        let group = format!("-{}", child.id());
        let _ = Command::new("/bin/kill")
            .args(["-KILL", &group])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
        let _ = child.wait();
        started.elapsed().as_secs_f64() * 1000.0
    })
}

#[cfg(not(unix))]
fn process_tree_cancel() -> Distribution {
    sample(20, || 0.0)
}

fn event_storm() -> (Distribution, BTreeMap<String, u64>) {
    let mut hub = HotEventHub::new(32 * 1024, 512 * 1024).unwrap();
    let mut cursor = 0_u64;
    let distribution = sample(20_000, || {
        let session = SessionId::new(format!("session_perf_{}", cursor % 100)).unwrap();
        let started = Instant::now();
        hub.publish(session, hot_event(&format!("turn_{}", cursor % 100), cursor))
            .unwrap();
        cursor += 1;
        started.elapsed().as_secs_f64() * 1000.0
    });
    let hub_metrics = hub.metrics();
    (
        distribution,
        BTreeMap::from([
            ("sessions".to_string(), hub_metrics.sessions as u64),
            ("hot_total_bytes".to_string(), hub_metrics.total_bytes as u64),
            ("hot_global_quota".to_string(), 512 * 1024),
            ("events_published".to_string(), 20_000),
            (
                "coalesced_deltas".to_string(),
                hub_metrics.coalesced_deltas,
            ),
        ]),
    )
}

fn sample(count: usize, mut operation: impl FnMut() -> f64) -> Distribution {
    let mut samples = (0..count).map(|_| operation()).collect::<Vec<_>>();
    let cold_ms = samples.first().copied().unwrap_or(0.0);
    samples.sort_by(f64::total_cmp);
    Distribution {
        samples: samples.len(),
        cold_ms,
        p50_ms: percentile(&samples, 0.50),
        p95_ms: percentile(&samples, 0.95),
        p99_ms: percentile(&samples, 0.99),
        max_ms: *samples.last().unwrap_or(&0.0),
    }
}

fn percentile(values: &[f64], percentile: f64) -> f64 {
    if values.is_empty() {
        return 0.0;
    }
    let index = ((values.len() - 1) as f64 * percentile).ceil() as usize;
    values[index]
}

fn semantic_event(seq: u64) -> SemanticEvent {
    SemanticEvent::new(
        EventEnvelopeMetadata::new(
            EventId::new(format!("event_perf_{seq}")).unwrap(),
            StreamId::new("stream_perf").unwrap(),
            StreamSeq(seq),
            Actor {
                kind: ActorKind::System,
                id: "performance-probe".to_string(),
            },
            CorrelationId::new("correlation_perf").unwrap(),
            TraceId::new("trace_perf").unwrap(),
        ),
        SemanticEventPayload::RecoveryRecorded {
            object: format!("object_{seq}"),
            known_truth: "performance probe".to_string(),
        },
    )
    .unwrap()
}

fn hot_event(turn: &str, cursor: u64) -> HotEvent {
    HotEvent::new(
        EventEnvelopeMetadata::new(
            EventId::new(format!("event_hot_{turn}_{cursor}")).unwrap(),
            StreamId::new("stream_hot_perf").unwrap(),
            StreamSeq(cursor),
            Actor {
                kind: ActorKind::AgentProvider,
                id: "performance-provider".to_string(),
            },
            CorrelationId::new("correlation_hot_perf").unwrap(),
            TraceId::new("trace_hot_perf").unwrap(),
        ),
        HotEventPayload::MessageDelta {
            turn_id: TurnId::new(format!("turn_{turn}")).unwrap(),
            cursor,
            text: "x".repeat(32),
        },
    )
    .unwrap()
}

fn revision() -> RevisionStamp {
    RevisionStamp {
        workspace_id: WorkspaceId::new("workspace_perf").unwrap(),
        kernel_instance_id: KernelInstanceId::new("kernel_perf").unwrap(),
        state_revision: StateRevision(1),
        project_revision: ProjectRevision(1),
    }
}
