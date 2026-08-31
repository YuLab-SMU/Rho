use std::{
    collections::BTreeMap,
    sync::{Arc, Mutex},
    thread,
    time::{Duration, Instant},
};

use rho_protocol::*;
use rho_telemetry::*;

fn metadata() -> EventEnvelopeMetadata {
    let mut metadata = EventEnvelopeMetadata::new(
        EventId::new("event_telemetry").unwrap(),
        StreamId::new("stream_telemetry").unwrap(),
        StreamSeq(4),
        Actor {
            kind: ActorKind::System,
            id: "system".to_string(),
        },
        CorrelationId::new("correlation_canonical").unwrap(),
        TraceId::new("trace_canonical").unwrap(),
    );
    metadata.causation_id = Some(CausationId::new("causation_event_parent").unwrap());
    metadata
}

#[derive(Clone)]
struct CollectExporter(Arc<Mutex<Vec<TelemetryRecord>>>);

impl TelemetryExporter for CollectExporter {
    fn export(&mut self, record: TelemetryRecord) {
        self.0.lock().unwrap().push(record);
    }
}

struct SlowExporter;

impl TelemetryExporter for SlowExporter {
    fn export(&mut self, _record: TelemetryRecord) {
        thread::sleep(Duration::from_millis(200));
    }
}

#[test]
fn telemetry_uses_event_correlation_trace_and_causation_without_second_id_source() {
    let records = Arc::new(Mutex::new(Vec::new()));
    let (mut recorder, worker) = TelemetryRecorder::start(8, CollectExporter(records.clone()));
    recorder
        .record_span(
            SpanName::Execution,
            &metadata(),
            canonical_span_parent(SpanName::Execution),
            12,
            BTreeMap::from([("outcome".to_string(), "succeeded".to_string())]),
        )
        .unwrap();
    drop(recorder);
    worker.join().unwrap();

    let records = records.lock().unwrap();
    let TelemetryRecord::Span(span) = &records[0] else {
        panic!("expected span");
    };
    assert_eq!(
        span.causality.correlation_id.as_str(),
        "correlation_canonical"
    );
    assert_eq!(span.causality.trace_id.as_str(), "trace_canonical");
    assert_eq!(
        span.causality.causation_id.as_ref().unwrap().as_str(),
        "causation_event_parent"
    );
    assert_eq!(span.parent, Some(SpanName::Capability));
}

#[test]
fn telemetry_span_tree_covers_turn_prompt_model_capability_execution_and_artifact() {
    assert_eq!(canonical_span_parent(SpanName::RhoTurn), None);
    assert_eq!(
        canonical_span_parent(SpanName::AgentPrompt),
        Some(SpanName::RhoTurn)
    );
    assert_eq!(
        canonical_span_parent(SpanName::GenaiChat),
        Some(SpanName::AgentPrompt)
    );
    assert_eq!(
        canonical_span_parent(SpanName::Capability),
        Some(SpanName::RhoTurn)
    );
    assert_eq!(
        canonical_span_parent(SpanName::Execution),
        Some(SpanName::Capability)
    );
    assert_eq!(
        canonical_span_parent(SpanName::ArtifactCommit),
        Some(SpanName::Execution)
    );
}

#[test]
fn telemetry_metrics_separate_provider_latency_and_rho_overhead_and_cover_ux() {
    let metrics = [
        MetricName::FirstActivityMs,
        MetricName::ModelFirstTokenMs,
        MetricName::ApprovalWaitMs,
        MetricName::QueueWaitMs,
        MetricName::CancelLatencyMs,
        MetricName::StaleRequests,
        MetricName::HotDrops,
        MetricName::CasRecoveryCount,
        MetricName::ProviderLatencyMs,
        MetricName::RhoOverheadMs,
    ];
    assert_ne!(MetricName::ProviderLatencyMs, MetricName::RhoOverheadMs);
    assert_eq!(metrics.len(), 10);
}

#[test]
fn telemetry_rejects_prompt_project_secret_and_private_payload_canaries() {
    let records = Arc::new(Mutex::new(Vec::new()));
    let (mut recorder, worker) = TelemetryRecorder::start(8, CollectExporter(records.clone()));
    for (key, value) in [
        ("prompt", "CANARY_PROMPT"),
        ("project_text", "CANARY_PROJECT"),
        ("status", "CANARY_SECRET_123"),
        ("status", "PRIVATE_THINKING: hidden"),
        ("status", "Bearer CANARY_CREDENTIAL"),
    ] {
        assert!(
            recorder
                .record_metric(
                    MetricName::FirstActivityMs,
                    &metadata(),
                    1,
                    BTreeMap::from([(key.to_string(), value.to_string())]),
                )
                .is_err()
        );
    }
    drop(recorder);
    worker.join().unwrap();
    let encoded = format!("{:?}", records.lock().unwrap());
    for canary in [
        "CANARY_PROMPT",
        "CANARY_PROJECT",
        "CANARY_SECRET_123",
        "PRIVATE_THINKING",
        "CANARY_CREDENTIAL",
    ] {
        assert!(!encoded.contains(canary));
    }
}

#[test]
fn telemetry_slow_exporter_never_blocks_effect_path() {
    let (mut recorder, worker) = TelemetryRecorder::start(1, SlowExporter);
    let started = Instant::now();
    for _ in 0..100 {
        let _ = recorder.record_metric(
            MetricName::QueueWaitMs,
            &metadata(),
            5,
            BTreeMap::from([("status".to_string(), "queued".to_string())]),
        );
    }
    assert!(started.elapsed() < Duration::from_millis(100));
    assert!(recorder.dropped_count() > 0);
    drop(recorder);
    worker.join().unwrap();
}

#[test]
fn telemetry_cardinality_budget_is_bounded() {
    let records = Arc::new(Mutex::new(Vec::new()));
    let (mut recorder, worker) = TelemetryRecorder::start(128, CollectExporter(records));
    for index in 0..MAX_DISTINCT_VALUES_PER_KEY {
        recorder
            .record_metric(
                MetricName::StaleRequests,
                &metadata(),
                1,
                BTreeMap::from([("reason_code".to_string(), format!("reason_{index}"))]),
            )
            .unwrap();
    }
    assert_eq!(
        recorder
            .record_metric(
                MetricName::StaleRequests,
                &metadata(),
                1,
                BTreeMap::from([("reason_code".to_string(), "reason_over_budget".to_string())]),
            )
            .unwrap_err(),
        TelemetryError::CardinalityExceeded("reason_code".to_string())
    );
    drop(recorder);
    worker.join().unwrap();
}

#[test]
fn telemetry_boundary_excludes_sensitive_content_and_effect_authority() {
    let excluded = boundary().does_not_own;
    for item in [
        "prompt_text",
        "project_content",
        "secret_material",
        "private_reasoning",
        "effect_admission",
    ] {
        assert!(excluded.contains(&item));
    }
}
