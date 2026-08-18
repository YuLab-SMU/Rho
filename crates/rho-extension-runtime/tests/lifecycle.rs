use std::{
    future::{Future, pending},
    pin::Pin,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicUsize, Ordering},
    },
    time::Duration,
};

use rho_extension_runtime::{
    ActivationError, ActivationGeneration, BoundedJson, BrokerRequest, BrokerResponse,
    BrokerResponseClass, CandidateBuildError, CapabilityDeclaration, CapabilityId,
    CapabilityRequirement, CollectingDiagnosticSink, DiagnosticCode, DiagnosticSeverity,
    DiagnosticSink, Disposable, DisposeError, DisposeOutcome, EffectStatus, ExtensionDiagnostic,
    ExtensionHost, InternalExtensionRuntimeMode, InternalPlugin, LifecycleDeadlines,
    NoopDiagnosticSink, PROJECT_FILE_VIEWER_HTML_BYTES, PluginContext, PluginDescriptor, PluginId,
    PluginVersion, RegistryError, RejectingBrokerFacade, RoutingError, ScopeId, ScopeIdentity,
    ScopeLifecycleState, ScopePolicy, ScopeSlot, TaskAdmissionError,
    WORKSPACE_SNAPSHOT_RESPONSE_BYTES, build_scope_candidate,
};
use serde_json::{Value, json};
use tokio_util::task::TaskTracker;

#[derive(Clone)]
enum DisposeBehavior {
    Success,
    Fail,
    Hang,
    Delay(Duration),
    Panic,
}

struct TestDisposable {
    label: String,
    behavior: DisposeBehavior,
    log: Arc<Mutex<Vec<String>>>,
    calls: Arc<AtomicUsize>,
}

impl Disposable for TestDisposable {
    fn dispose<'a>(
        &'a mut self,
    ) -> Pin<Box<dyn Future<Output = Result<(), DisposeError>> + Send + 'a>> {
        Box::pin(async move {
            self.calls.fetch_add(1, Ordering::SeqCst);
            self.log.lock().unwrap().push(self.label.clone());
            match self.behavior {
                DisposeBehavior::Success => Ok(()),
                DisposeBehavior::Fail => Err(DisposeError::new(
                    "injected_cleanup_failure",
                    format!("{} failed", self.label),
                )),
                DisposeBehavior::Hang => pending().await,
                DisposeBehavior::Delay(duration) => {
                    tokio::time::sleep(duration).await;
                    Ok(())
                }
                DisposeBehavior::Panic => panic!("injected disposer panic"),
            }
        })
    }
}

#[derive(Clone)]
struct PlannedEffect {
    label: String,
    behavior: DisposeBehavior,
    calls: Arc<AtomicUsize>,
}

#[derive(Clone)]
enum PlannedTask {
    None,
    NonCooperative,
}

struct TestPlugin {
    descriptor: PluginDescriptor,
    effects: Vec<PlannedEffect>,
    marker: Option<CapabilityId>,
    task: PlannedTask,
    fail: Option<ActivationError>,
    log: Arc<Mutex<Vec<String>>>,
}

impl InternalPlugin for TestPlugin {
    fn descriptor(&self) -> &PluginDescriptor {
        &self.descriptor
    }

    fn activate<'a>(
        &'a self,
        context: PluginContext<'a>,
    ) -> Pin<Box<dyn Future<Output = Result<(), ActivationError>> + Send + 'a>> {
        Box::pin(async move {
            for effect in &self.effects {
                context.effects.push(Box::new(TestDisposable {
                    label: effect.label.clone(),
                    behavior: effect.behavior.clone(),
                    log: Arc::clone(&self.log),
                    calls: Arc::clone(&effect.calls),
                }));
            }
            if let Some(marker) = self.marker.clone() {
                context
                    .effects
                    .register_marker(context.registry, marker)
                    .map_err(registry_activation_error)?;
            }
            match &self.task {
                PlannedTask::None => {}
                PlannedTask::NonCooperative => {
                    context
                        .tasks
                        .spawn(async move { pending::<()>().await })
                        .map_err(|error| {
                            ActivationError::new("task_admission", error.to_string())
                        })?;
                }
            }
            if let Some(error) = self.fail.clone() {
                return Err(error);
            }
            Ok(())
        })
    }
}

struct SpoofingDiagnosticPlugin {
    descriptor: PluginDescriptor,
}

struct CancellingPlugin {
    descriptor: PluginDescriptor,
}

struct PanickingActivationPlugin {
    descriptor: PluginDescriptor,
    log: Arc<Mutex<Vec<String>>>,
    calls: Arc<AtomicUsize>,
}

impl InternalPlugin for PanickingActivationPlugin {
    fn descriptor(&self) -> &PluginDescriptor {
        &self.descriptor
    }

    fn activate<'a>(
        &'a self,
        context: PluginContext<'a>,
    ) -> Pin<Box<dyn Future<Output = Result<(), ActivationError>> + Send + 'a>> {
        context.effects.push(Box::new(TestDisposable {
            label: "panic.rollback".to_string(),
            behavior: DisposeBehavior::Success,
            log: Arc::clone(&self.log),
            calls: Arc::clone(&self.calls),
        }));
        Box::pin(async move { panic!("injected activation panic") })
    }
}

impl InternalPlugin for CancellingPlugin {
    fn descriptor(&self) -> &PluginDescriptor {
        &self.descriptor
    }

    fn activate<'a>(
        &'a self,
        context: PluginContext<'a>,
    ) -> Pin<Box<dyn Future<Output = Result<(), ActivationError>> + Send + 'a>> {
        Box::pin(async move {
            context.cancellation.cancel();
            Ok(())
        })
    }
}

impl InternalPlugin for SpoofingDiagnosticPlugin {
    fn descriptor(&self) -> &PluginDescriptor {
        &self.descriptor
    }

    fn activate<'a>(
        &'a self,
        context: PluginContext<'a>,
    ) -> Pin<Box<dyn Future<Output = Result<(), ActivationError>> + Send + 'a>> {
        Box::pin(async move {
            context.diagnostics.emit(ExtensionDiagnostic {
                code: DiagnosticCode::ActivationStarted,
                severity: DiagnosticSeverity::Warning,
                plugin_id: Some(plugin_id("plugin.spoofed")),
                capability_id: None,
                scope_kind: Some(ScopePolicy::application_kind()),
                scope_id: Some(ScopeId::new("spoofed.scope").unwrap()),
                activation_generation: Some(ActivationGeneration::new(999).unwrap()),
                effect_order: None,
                related_plugins: vec![plugin_id("plugin.spoofed"); 300],
                cycle_path: vec![plugin_id("plugin.spoofed"); 300],
                message: "x".repeat(2_000),
            });
            Ok(())
        })
    }
}

fn registry_activation_error(error: RegistryError) -> ActivationError {
    ActivationError::new("registry_rejected", error.to_string())
}

fn plugin_id(value: &str) -> PluginId {
    PluginId::new(value).unwrap()
}

fn capability_id(value: &str) -> CapabilityId {
    CapabilityId::new(value).unwrap()
}

fn descriptor(id: &str, scope_kind: rho_extension_runtime::ScopeKindId) -> PluginDescriptor {
    PluginDescriptor::new(
        plugin_id(id),
        PluginVersion::parse("1.0.0").unwrap(),
        vec![scope_kind],
    )
}

fn project_identity(id: &str, generation: u64) -> ScopeIdentity {
    ScopeIdentity::new(
        ScopePolicy::project_kind(),
        ScopeId::new(id).unwrap(),
        Some(ScopeId::new("application").unwrap()),
        ActivationGeneration::new(generation).unwrap(),
    )
}

fn workspace_identity(parent: &ScopeIdentity, id: &str, generation: u64) -> ScopeIdentity {
    ScopeIdentity::new(
        ScopePolicy::workspace_kind(),
        ScopeId::new(id).unwrap(),
        Some(parent.id.clone()),
        ActivationGeneration::new(generation).unwrap(),
    )
}

fn deadlines() -> LifecycleDeadlines {
    LifecycleDeadlines {
        quiesce: Duration::from_millis(100),
        effect: Duration::from_millis(50),
        scope: Duration::from_millis(500),
    }
}

fn diagnostics() -> (Arc<CollectingDiagnosticSink>, Arc<dyn DiagnosticSink>) {
    let collecting = Arc::new(CollectingDiagnosticSink::default());
    let sink: Arc<dyn DiagnosticSink> = collecting.clone();
    (collecting, sink)
}

fn host(sink: Arc<dyn DiagnosticSink>, lifecycle_deadlines: LifecycleDeadlines) -> ExtensionHost {
    ExtensionHost::new_empty(
        InternalExtensionRuntimeMode::Candidate,
        sink,
        lifecycle_deadlines,
    )
    .unwrap()
}

async fn build_project(
    host: &ExtensionHost,
    id: &str,
    plugins: Vec<Arc<dyn InternalPlugin>>,
    sink: Arc<dyn DiagnosticSink>,
    lifecycle_deadlines: LifecycleDeadlines,
) -> Result<Arc<rho_extension_runtime::ScopeSnapshot>, CandidateBuildError> {
    let application = host.scopes().application();
    let identity = host
        .scopes()
        .next_identity(
            ScopePolicy::project_kind(),
            ScopeId::new(id).unwrap(),
            Some(application.as_ref()),
        )
        .unwrap();
    build_scope_candidate(
        identity,
        Some(application.plan()),
        plugins,
        Arc::new(RejectingBrokerFacade),
        sink,
        lifecycle_deadlines,
    )
    .await
}

#[test]
fn invalid_runtime_mode_falls_back_to_legacy_with_one_typed_diagnostic() {
    let (collecting, sink) = diagnostics();
    let invalid = "x".repeat(2_000);
    assert_eq!(
        InternalExtensionRuntimeMode::parse(Some(&invalid), sink.as_ref()),
        InternalExtensionRuntimeMode::Legacy
    );
    let diagnostics = collecting.diagnostics();
    assert_eq!(diagnostics.len(), 1);
    assert_eq!(diagnostics[0].code, DiagnosticCode::InvalidRuntimeMode);
    assert!(!diagnostics[0].message.contains(&invalid));
    assert!(diagnostics[0].message.len() <= 512);

    assert_eq!(
        InternalExtensionRuntimeMode::parse(None, sink.as_ref()),
        InternalExtensionRuntimeMode::Legacy
    );
    assert_eq!(
        InternalExtensionRuntimeMode::parse(Some("candidate"), sink.as_ref()),
        InternalExtensionRuntimeMode::Candidate
    );
    assert_eq!(collecting.diagnostics().len(), 1);
}

#[tokio::test]
async fn plugin_diagnostics_are_rebound_and_bounded_by_the_host() {
    let (collecting, sink) = diagnostics();
    let host = host(Arc::clone(&sink), deadlines());
    let plugin: Arc<dyn InternalPlugin> = Arc::new(SpoofingDiagnosticPlugin {
        descriptor: descriptor("plugin.real", ScopePolicy::project_kind()),
    });
    let candidate = build_project(&host, "project.a", vec![plugin], sink, deadlines())
        .await
        .unwrap();
    let diagnostic = collecting
        .diagnostics()
        .into_iter()
        .find(|item| {
            item.severity == DiagnosticSeverity::Warning
                && item.code == DiagnosticCode::ActivationStarted
        })
        .unwrap();
    assert_eq!(diagnostic.plugin_id, Some(plugin_id("plugin.real")));
    assert_eq!(diagnostic.scope_id, Some(candidate.identity().id.clone()));
    assert_eq!(
        diagnostic.activation_generation,
        Some(candidate.identity().generation)
    );
    assert!(diagnostic.message.len() <= 512);
    assert_eq!(diagnostic.related_plugins.len(), 256);
    assert_eq!(diagnostic.cycle_path.len(), 257);
}

#[tokio::test]
async fn plugin_cancellation_token_cannot_cancel_the_whole_scope() {
    let (_, sink) = diagnostics();
    let host = host(Arc::clone(&sink), deadlines());
    let plugin: Arc<dyn InternalPlugin> = Arc::new(CancellingPlugin {
        descriptor: descriptor("plugin.cancel-self", ScopePolicy::project_kind()),
    });
    let candidate = build_project(&host, "project.a", vec![plugin], sink, deadlines())
        .await
        .unwrap();
    assert!(!candidate.cancellation().is_cancelled());
}

#[test]
fn broker_payload_classes_enforce_exact_byte_boundaries() {
    let exact_generic =
        Value::String("x".repeat(rho_extension_runtime::DEFAULT_BROKER_PAYLOAD_BYTES - 2));
    assert_eq!(
        BoundedJson::generic(exact_generic).unwrap().encoded_bytes(),
        rho_extension_runtime::DEFAULT_BROKER_PAYLOAD_BYTES
    );
    let over_generic =
        Value::String("x".repeat(rho_extension_runtime::DEFAULT_BROKER_PAYLOAD_BYTES - 1));
    assert!(BoundedJson::generic(over_generic).is_err());

    let request = BrokerRequest::new(
        rho_extension_runtime::OperationId::new("workspace.snapshot").unwrap(),
        json!({}),
        BrokerResponseClass::WorkspaceSnapshot,
    )
    .unwrap();
    let exact_workspace = Value::String("x".repeat(WORKSPACE_SNAPSHOT_RESPONSE_BYTES - 2));
    assert_eq!(
        BrokerResponse::new(exact_workspace, &request)
            .unwrap()
            .payload
            .encoded_bytes(),
        WORKSPACE_SNAPSHOT_RESPONSE_BYTES
    );
    let over_workspace = Value::String("x".repeat(WORKSPACE_SNAPSHOT_RESPONSE_BYTES - 1));
    assert!(BrokerResponse::new(over_workspace, &request).is_err());
    assert_eq!(
        BrokerResponseClass::ProjectFileViewerHtml.maximum_bytes(),
        PROJECT_FILE_VIEWER_HTML_BYTES
    );
}

#[tokio::test]
async fn activation_and_dependency_disposal_are_reverse_ordered() {
    let log = Arc::new(Mutex::new(Vec::new()));
    let calls = Arc::new(AtomicUsize::new(0));
    let mut provider_descriptor = descriptor("plugin.provider", ScopePolicy::project_kind());
    provider_descriptor.provides = vec![CapabilityDeclaration::new(
        capability_id("service.shared"),
        1,
    )];
    let provider = Arc::new(TestPlugin {
        descriptor: provider_descriptor,
        effects: vec![PlannedEffect {
            label: "provider.0".to_string(),
            behavior: DisposeBehavior::Success,
            calls: Arc::clone(&calls),
        }],
        marker: None,
        task: PlannedTask::None,
        fail: None,
        log: Arc::clone(&log),
    });
    let mut consumer_descriptor = descriptor("plugin.consumer", ScopePolicy::project_kind());
    consumer_descriptor.requires = vec![CapabilityRequirement::new(
        capability_id("service.shared"),
        1,
    )];
    let consumer = Arc::new(TestPlugin {
        descriptor: consumer_descriptor,
        effects: vec![
            PlannedEffect {
                label: "consumer.0".to_string(),
                behavior: DisposeBehavior::Success,
                calls: Arc::clone(&calls),
            },
            PlannedEffect {
                label: "consumer.1".to_string(),
                behavior: DisposeBehavior::Success,
                calls: Arc::clone(&calls),
            },
        ],
        marker: None,
        task: PlannedTask::None,
        fail: None,
        log: Arc::clone(&log),
    });
    let (_, sink) = diagnostics();
    let host = host(Arc::clone(&sink), deadlines());
    let plugins: Vec<Arc<dyn InternalPlugin>> = vec![consumer, provider];
    let candidate = build_project(&host, "project.a", plugins, sink, deadlines())
        .await
        .unwrap();
    let slot = ScopeSlot::empty(Arc::new(NoopDiagnosticSink));
    slot.publish(None, Arc::clone(&candidate), deadlines())
        .await
        .unwrap();
    assert!(candidate.registry().is_routable());

    let replacement = host
        .build_empty_project_candidate(ScopeId::new("project.b").unwrap())
        .await
        .unwrap();
    slot.publish(Some(candidate), replacement, deadlines())
        .await
        .unwrap();
    assert_eq!(
        *log.lock().unwrap(),
        vec!["consumer.1", "consumer.0", "provider.0"]
    );
    assert_eq!(calls.load(Ordering::SeqCst), 3);
}

#[tokio::test]
async fn activation_failure_rolls_back_current_and_prior_plugins() {
    let log = Arc::new(Mutex::new(Vec::new()));
    let calls = Arc::new(AtomicUsize::new(0));
    let provider = Arc::new(TestPlugin {
        descriptor: descriptor("plugin.a", ScopePolicy::project_kind()),
        effects: vec![PlannedEffect {
            label: "a.0".to_string(),
            behavior: DisposeBehavior::Success,
            calls: Arc::clone(&calls),
        }],
        marker: None,
        task: PlannedTask::None,
        fail: None,
        log: Arc::clone(&log),
    });
    let failing = Arc::new(TestPlugin {
        descriptor: descriptor("plugin.b", ScopePolicy::project_kind()),
        effects: vec![
            PlannedEffect {
                label: "b.0".to_string(),
                behavior: DisposeBehavior::Success,
                calls: Arc::clone(&calls),
            },
            PlannedEffect {
                label: "b.1".to_string(),
                behavior: DisposeBehavior::Success,
                calls: Arc::clone(&calls),
            },
        ],
        marker: None,
        task: PlannedTask::None,
        fail: Some(ActivationError::new("injected", "fail after effects")),
        log: Arc::clone(&log),
    });
    let (_, sink) = diagnostics();
    let host = host(Arc::clone(&sink), deadlines());
    let plugins: Vec<Arc<dyn InternalPlugin>> = vec![provider, failing];
    let error = build_project(&host, "project.a", plugins, sink, deadlines())
        .await
        .unwrap_err();
    match error {
        CandidateBuildError::Activation { rollback, .. } => {
            assert_eq!(rollback.outcome, DisposeOutcome::Disposed)
        }
        other => panic!("unexpected error: {other:?}"),
    }
    assert_eq!(*log.lock().unwrap(), vec!["b.1", "b.0", "a.0"]);
    assert_eq!(calls.load(Ordering::SeqCst), 3);
}

#[tokio::test]
async fn activation_failure_before_effects_has_empty_truthful_rollback() {
    let plugin = Arc::new(TestPlugin {
        descriptor: descriptor("plugin.fail", ScopePolicy::project_kind()),
        effects: Vec::new(),
        marker: None,
        task: PlannedTask::None,
        fail: Some(ActivationError::new("injected", "fail immediately")),
        log: Arc::new(Mutex::new(Vec::new())),
    });
    let (_, sink) = diagnostics();
    let host = host(Arc::clone(&sink), deadlines());
    let plugins: Vec<Arc<dyn InternalPlugin>> = vec![plugin];
    let error = build_project(&host, "project.a", plugins, sink, deadlines())
        .await
        .unwrap_err();
    match error {
        CandidateBuildError::Activation { rollback, .. } => {
            assert_eq!(rollback.outcome, DisposeOutcome::Disposed);
            assert_eq!(rollback.plugin_reports.len(), 1);
            assert!(rollback.plugin_reports[0].1.records.is_empty());
        }
        other => panic!("unexpected error: {other:?}"),
    }
}

#[tokio::test]
async fn activation_panic_is_contained_and_recorded_effects_roll_back() {
    let log = Arc::new(Mutex::new(Vec::new()));
    let calls = Arc::new(AtomicUsize::new(0));
    let plugin: Arc<dyn InternalPlugin> = Arc::new(PanickingActivationPlugin {
        descriptor: descriptor("plugin.panic", ScopePolicy::project_kind()),
        log: Arc::clone(&log),
        calls: Arc::clone(&calls),
    });
    let (_, sink) = diagnostics();
    let host = host(Arc::clone(&sink), deadlines());
    let error = build_project(&host, "project.a", vec![plugin], sink, deadlines())
        .await
        .unwrap_err();
    match error {
        CandidateBuildError::Activation {
            error, rollback, ..
        } => {
            assert_eq!(error.code(), "activation_panicked");
            assert_eq!(rollback.outcome, DisposeOutcome::Disposed);
        }
        other => panic!("unexpected error: {other:?}"),
    }
    assert_eq!(*log.lock().unwrap(), vec!["panic.rollback"]);
    assert_eq!(calls.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn disposer_panic_is_contained_and_remaining_cleanup_continues() {
    let log = Arc::new(Mutex::new(Vec::new()));
    let calls = Arc::new(AtomicUsize::new(0));
    let plugin: Arc<dyn InternalPlugin> = Arc::new(TestPlugin {
        descriptor: descriptor("plugin.dispose-panic", ScopePolicy::project_kind()),
        effects: vec![
            PlannedEffect {
                label: "success".to_string(),
                behavior: DisposeBehavior::Success,
                calls: Arc::clone(&calls),
            },
            PlannedEffect {
                label: "panic".to_string(),
                behavior: DisposeBehavior::Panic,
                calls: Arc::clone(&calls),
            },
        ],
        marker: None,
        task: PlannedTask::None,
        fail: None,
        log: Arc::clone(&log),
    });
    let (_, sink) = diagnostics();
    let host = host(Arc::clone(&sink), deadlines());
    let candidate = build_project(&host, "project.a", vec![plugin], sink, deadlines())
        .await
        .unwrap();
    ScopeSlot::from_active(candidate.clone(), Arc::new(NoopDiagnosticSink)).unwrap();
    let report = candidate.quiesce_and_dispose(deadlines()).await;
    assert_eq!(report.outcome, DisposeOutcome::Failed);
    assert_eq!(*log.lock().unwrap(), vec!["panic", "success"]);
    assert_eq!(calls.load(Ordering::SeqCst), 2);
    assert_eq!(
        report.plugin_reports[0].1.records[1]
            .cleanup_error
            .as_ref()
            .unwrap()
            .code(),
        "effect_dispose_panicked"
    );
}

#[tokio::test]
async fn dispose_is_concurrently_idempotent() {
    let calls = Arc::new(AtomicUsize::new(0));
    let plugin = Arc::new(TestPlugin {
        descriptor: descriptor("plugin.one", ScopePolicy::project_kind()),
        effects: vec![PlannedEffect {
            label: "one".to_string(),
            behavior: DisposeBehavior::Success,
            calls: Arc::clone(&calls),
        }],
        marker: None,
        task: PlannedTask::None,
        fail: None,
        log: Arc::new(Mutex::new(Vec::new())),
    });
    let (_, sink) = diagnostics();
    let host = host(Arc::clone(&sink), deadlines());
    let plugins: Vec<Arc<dyn InternalPlugin>> = vec![plugin];
    let candidate = build_project(&host, "project.a", plugins, sink, deadlines())
        .await
        .unwrap();
    let slot = ScopeSlot::from_active(candidate.clone(), Arc::new(NoopDiagnosticSink)).unwrap();
    assert!(slot.current().is_some());
    let (first, second) = tokio::join!(
        candidate.quiesce_and_dispose(deadlines()),
        candidate.quiesce_and_dispose(deadlines())
    );
    assert_eq!(first, second);
    assert_eq!(calls.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn cleanup_failure_and_timeout_continue_remaining_effects() {
    let log = Arc::new(Mutex::new(Vec::new()));
    let calls = Arc::new(AtomicUsize::new(0));
    let plugin = Arc::new(TestPlugin {
        descriptor: descriptor("plugin.cleanup", ScopePolicy::project_kind()),
        effects: vec![
            PlannedEffect {
                label: "success.first".to_string(),
                behavior: DisposeBehavior::Success,
                calls: Arc::clone(&calls),
            },
            PlannedEffect {
                label: "failure".to_string(),
                behavior: DisposeBehavior::Fail,
                calls: Arc::clone(&calls),
            },
            PlannedEffect {
                label: "timeout".to_string(),
                behavior: DisposeBehavior::Hang,
                calls: Arc::clone(&calls),
            },
        ],
        marker: None,
        task: PlannedTask::None,
        fail: None,
        log: Arc::clone(&log),
    });
    let (_, sink) = diagnostics();
    let short = LifecycleDeadlines {
        quiesce: Duration::from_millis(20),
        effect: Duration::from_millis(10),
        scope: Duration::from_millis(100),
    };
    let host = host(Arc::clone(&sink), short);
    let plugins: Vec<Arc<dyn InternalPlugin>> = vec![plugin];
    let candidate = build_project(&host, "project.a", plugins, sink, short)
        .await
        .unwrap();
    ScopeSlot::from_active(candidate.clone(), Arc::new(NoopDiagnosticSink)).unwrap();
    let report = candidate.quiesce_and_dispose(short).await;
    assert_eq!(report.outcome, DisposeOutcome::Failed);
    assert_eq!(
        *log.lock().unwrap(),
        vec!["timeout", "failure", "success.first"]
    );
    assert_eq!(calls.load(Ordering::SeqCst), 3);
    let records = &report.plugin_reports[0].1.records;
    assert_eq!(records[0].status, EffectStatus::Disposed);
    assert_eq!(records[1].status, EffectStatus::Failed);
    assert_eq!(records[2].status, EffectStatus::Failed);
    assert!(candidate.registry().lease().is_err());
}

#[tokio::test]
async fn total_scope_deadline_marks_unstarted_effects_as_leaked() {
    let log = Arc::new(Mutex::new(Vec::new()));
    let first_calls = Arc::new(AtomicUsize::new(0));
    let second_calls = Arc::new(AtomicUsize::new(0));
    let third_calls = Arc::new(AtomicUsize::new(0));
    let plugin = Arc::new(TestPlugin {
        descriptor: descriptor("plugin.total-timeout", ScopePolicy::project_kind()),
        effects: vec![
            PlannedEffect {
                label: "unstarted".to_string(),
                behavior: DisposeBehavior::Success,
                calls: Arc::clone(&first_calls),
            },
            PlannedEffect {
                label: "second".to_string(),
                behavior: DisposeBehavior::Delay(Duration::from_millis(25)),
                calls: Arc::clone(&second_calls),
            },
            PlannedEffect {
                label: "third".to_string(),
                behavior: DisposeBehavior::Delay(Duration::from_millis(25)),
                calls: Arc::clone(&third_calls),
            },
        ],
        marker: None,
        task: PlannedTask::None,
        fail: None,
        log: Arc::clone(&log),
    });
    let short = LifecycleDeadlines {
        quiesce: Duration::from_millis(5),
        effect: Duration::from_millis(100),
        scope: Duration::from_millis(35),
    };
    let (_, sink) = diagnostics();
    let host = host(Arc::clone(&sink), short);
    let plugins: Vec<Arc<dyn InternalPlugin>> = vec![plugin];
    let candidate = build_project(&host, "project.a", plugins, sink, short)
        .await
        .unwrap();
    ScopeSlot::from_active(candidate.clone(), Arc::new(NoopDiagnosticSink)).unwrap();
    let report = candidate.quiesce_and_dispose(short).await;
    assert_eq!(report.outcome, DisposeOutcome::Failed);
    assert_eq!(third_calls.load(Ordering::SeqCst), 1);
    assert_eq!(second_calls.load(Ordering::SeqCst), 1);
    assert_eq!(first_calls.load(Ordering::SeqCst), 0);
    assert_eq!(
        report.plugin_reports[0].1.records[0].status,
        EffectStatus::Failed
    );
}

#[tokio::test]
async fn quiesce_rejects_routes_and_tasks_before_cancellation_then_drains() {
    let (_, sink) = diagnostics();
    let host = host(Arc::clone(&sink), deadlines());
    let candidate = host
        .build_empty_project_candidate(ScopeId::new("project.a").unwrap())
        .await
        .unwrap();
    let slot = ScopeSlot::empty(Arc::clone(&sink));
    slot.publish(None, candidate.clone(), deadlines())
        .await
        .unwrap();
    let lease = candidate.registry().lease().unwrap();
    let token = candidate.cancellation();
    let registry = candidate.registry().clone();
    let routing_closed_on_cancel = Arc::new(AtomicBool::new(false));
    let observed = Arc::clone(&routing_closed_on_cancel);
    candidate
        .tasks()
        .spawn(async move {
            token.cancelled().await;
            observed.store(
                matches!(registry.lease(), Err(RoutingError::Closed)),
                Ordering::SeqCst,
            );
        })
        .unwrap();

    let disposing = candidate.clone();
    let handle = tokio::spawn(async move { disposing.quiesce_and_dispose(deadlines()).await });
    tokio::time::sleep(Duration::from_millis(10)).await;
    assert!(!handle.is_finished());
    assert!(matches!(
        candidate.tasks().spawn(async {}),
        Err(TaskAdmissionError::Closed)
    ));
    drop(lease);
    let report = handle.await.unwrap();
    assert_eq!(report.outcome, DisposeOutcome::Disposed);
    assert!(routing_closed_on_cancel.load(Ordering::SeqCst));
}

#[tokio::test]
async fn publication_closes_old_routing_before_waiting_for_existing_leases() {
    let (_, sink) = diagnostics();
    let host = host(Arc::clone(&sink), deadlines());
    let slot = Arc::new(ScopeSlot::empty(Arc::clone(&sink)));
    let first = host
        .build_empty_project_candidate(ScopeId::new("project.a").unwrap())
        .await
        .unwrap();
    slot.publish(None, first.clone(), deadlines())
        .await
        .unwrap();
    let existing_lease = first.registry().lease().unwrap();
    let replacement = host
        .build_empty_project_candidate(ScopeId::new("project.b").unwrap())
        .await
        .unwrap();
    let publishing_slot = Arc::clone(&slot);
    let publishing_first = first.clone();
    let publishing = tokio::spawn(async move {
        publishing_slot
            .publish(Some(publishing_first), replacement, deadlines())
            .await
    });
    tokio::time::sleep(Duration::from_millis(10)).await;
    assert!(!publishing.is_finished());
    assert!(matches!(
        first.registry().lease(),
        Err(RoutingError::Closed)
    ));
    drop(existing_lease);
    publishing.await.unwrap().unwrap();
}

#[tokio::test]
async fn non_cooperative_task_times_out_and_scope_stays_non_routable() {
    let short = LifecycleDeadlines {
        quiesce: Duration::from_millis(10),
        effect: Duration::from_millis(10),
        scope: Duration::from_millis(50),
    };
    let (_, sink) = diagnostics();
    let host = host(Arc::clone(&sink), short);
    let candidate = host
        .build_empty_project_candidate(ScopeId::new("project.a").unwrap())
        .await
        .unwrap();
    let slot = ScopeSlot::empty(Arc::clone(&sink));
    slot.publish(None, candidate.clone(), short).await.unwrap();
    let task = candidate
        .tasks()
        .spawn(async { pending::<()>().await })
        .unwrap();
    let report = candidate.quiesce_and_dispose(short).await;
    assert_eq!(report.outcome, DisposeOutcome::Failed);
    assert!(report.quiesce_timed_out);
    assert_eq!(report.remaining_tasks, 1);
    assert_eq!(candidate.state(), ScopeLifecycleState::Failed);
    assert!(!candidate.registry().is_routable());
    task.abort();
}

#[tokio::test]
async fn rho_task_admission_closes_the_gap_left_by_raw_task_tracker() {
    let raw = TaskTracker::new();
    raw.close();
    assert_eq!(raw.spawn(async { 7 }).await.unwrap(), 7);

    let (_, sink) = diagnostics();
    let host = host(Arc::clone(&sink), deadlines());
    let candidate = host
        .build_empty_project_candidate(ScopeId::new("project.a").unwrap())
        .await
        .unwrap();
    ScopeSlot::from_active(candidate.clone(), sink).unwrap();
    candidate.quiesce_and_dispose(deadlines()).await;
    assert!(matches!(
        candidate.tasks().spawn(async { 7 }),
        Err(TaskAdmissionError::Closed)
    ));
}

#[tokio::test]
async fn child_scope_disposes_before_parent_scope() {
    let log = Arc::new(Mutex::new(Vec::new()));
    let calls = Arc::new(AtomicUsize::new(0));
    let parent_plugin = Arc::new(TestPlugin {
        descriptor: descriptor("plugin.parent", ScopePolicy::project_kind()),
        effects: vec![PlannedEffect {
            label: "parent".to_string(),
            behavior: DisposeBehavior::Success,
            calls: Arc::clone(&calls),
        }],
        marker: None,
        task: PlannedTask::None,
        fail: None,
        log: Arc::clone(&log),
    });
    let child_plugin = Arc::new(TestPlugin {
        descriptor: descriptor("plugin.child", ScopePolicy::workspace_kind()),
        effects: vec![PlannedEffect {
            label: "child".to_string(),
            behavior: DisposeBehavior::Success,
            calls: Arc::clone(&calls),
        }],
        marker: None,
        task: PlannedTask::None,
        fail: None,
        log: Arc::clone(&log),
    });
    let (_, sink) = diagnostics();
    let host = host(Arc::clone(&sink), deadlines());
    let parent_plugins: Vec<Arc<dyn InternalPlugin>> = vec![parent_plugin];
    let parent = build_project(
        &host,
        "project.a",
        parent_plugins,
        Arc::clone(&sink),
        deadlines(),
    )
    .await
    .unwrap();
    ScopeSlot::from_active(parent.clone(), Arc::clone(&sink)).unwrap();

    let child_identity = workspace_identity(parent.identity(), "workspace.a", 50);
    let child_plugins: Vec<Arc<dyn InternalPlugin>> = vec![child_plugin];
    let child = build_scope_candidate(
        child_identity,
        Some(parent.plan()),
        child_plugins,
        Arc::new(RejectingBrokerFacade),
        Arc::clone(&sink),
        deadlines(),
    )
    .await
    .unwrap();
    ScopeSlot::from_active(child.clone(), sink).unwrap();
    parent.attach_child(child).unwrap();

    let report = parent.quiesce_and_dispose(deadlines()).await;
    assert_eq!(report.outcome, DisposeOutcome::Disposed);
    assert_eq!(*log.lock().unwrap(), vec!["child", "parent"]);
}

#[tokio::test]
async fn child_task_timeout_is_reported_with_exact_remaining_count() {
    let short = LifecycleDeadlines {
        quiesce: Duration::from_millis(10),
        effect: Duration::from_millis(10),
        scope: Duration::from_millis(100),
    };
    let (_, sink) = diagnostics();
    let host = host(Arc::clone(&sink), short);
    let parent = host
        .build_empty_project_candidate(ScopeId::new("project.a").unwrap())
        .await
        .unwrap();
    ScopeSlot::from_active(parent.clone(), Arc::clone(&sink)).unwrap();

    let child_plugin: Arc<dyn InternalPlugin> = Arc::new(TestPlugin {
        descriptor: descriptor("plugin.child-task", ScopePolicy::workspace_kind()),
        effects: Vec::new(),
        marker: None,
        task: PlannedTask::NonCooperative,
        fail: None,
        log: Arc::new(Mutex::new(Vec::new())),
    });
    let child = build_scope_candidate(
        workspace_identity(parent.identity(), "workspace.a", 50),
        Some(parent.plan()),
        vec![child_plugin],
        Arc::new(RejectingBrokerFacade),
        Arc::clone(&sink),
        short,
    )
    .await
    .unwrap();
    ScopeSlot::from_active(child.clone(), sink).unwrap();
    parent.attach_child(child).unwrap();

    let report = parent.quiesce_and_dispose(short).await;
    assert_eq!(report.outcome, DisposeOutcome::Failed);
    assert_eq!(report.child_reports.len(), 1);
    assert_eq!(report.child_reports[0].remaining_tasks, 1);
    assert!(report.child_reports[0].quiesce_timed_out);
}

#[tokio::test]
async fn stale_expected_old_cannot_overwrite_newer_winner_and_rolls_back_loser() {
    let (collecting, sink) = diagnostics();
    let host = host(Arc::clone(&sink), deadlines());
    let slot = ScopeSlot::empty(Arc::clone(&sink));
    let first = host
        .build_empty_project_candidate(ScopeId::new("project.a").unwrap())
        .await
        .unwrap();
    slot.publish(None, first.clone(), deadlines())
        .await
        .unwrap();
    let stale_expected = first.clone();

    let winner = host
        .build_empty_project_candidate(ScopeId::new("project.b").unwrap())
        .await
        .unwrap();
    slot.publish(Some(first), winner.clone(), deadlines())
        .await
        .unwrap();

    let loser = host
        .build_empty_project_candidate(ScopeId::new("project.c").unwrap())
        .await
        .unwrap();
    let error = slot
        .publish(Some(stale_expected), loser.clone(), deadlines())
        .await
        .unwrap_err();
    assert_eq!(error.reason, "expected_old_mismatch");
    assert_eq!(loser.state(), ScopeLifecycleState::Disposed);
    assert!(Arc::ptr_eq(&slot.current().unwrap(), &winner));
    assert!(winner.registry().is_routable());
    assert!(
        collecting
            .diagnostics()
            .iter()
            .any(|item| item.code == DiagnosticCode::CandidateCasRejected)
    );
}

#[tokio::test]
async fn cas_uses_arc_pointer_identity_not_equal_scope_values() {
    let (_, sink) = diagnostics();
    let host = host(Arc::clone(&sink), deadlines());
    let application = host.scopes().application();
    let identity = project_identity("project.same", 77);
    let current = build_scope_candidate(
        identity.clone(),
        Some(application.plan()),
        Vec::new(),
        Arc::new(RejectingBrokerFacade),
        Arc::clone(&sink),
        deadlines(),
    )
    .await
    .unwrap();
    let equal_but_distinct = build_scope_candidate(
        identity,
        Some(application.plan()),
        Vec::new(),
        Arc::new(RejectingBrokerFacade),
        Arc::clone(&sink),
        deadlines(),
    )
    .await
    .unwrap();
    assert_eq!(current.identity(), equal_but_distinct.identity());
    assert!(!Arc::ptr_eq(&current, &equal_but_distinct));
    let slot = ScopeSlot::from_active(current.clone(), Arc::clone(&sink)).unwrap();
    let candidate = host
        .build_empty_project_candidate(ScopeId::new("project.candidate").unwrap())
        .await
        .unwrap();
    let error = slot
        .publish(
            Some(equal_but_distinct.clone()),
            candidate.clone(),
            deadlines(),
        )
        .await
        .unwrap_err();
    assert_eq!(error.reason, "expected_old_mismatch");
    assert!(Arc::ptr_eq(&slot.current().unwrap(), &current));
    assert_eq!(candidate.state(), ScopeLifecycleState::Disposed);
    equal_but_distinct.quiesce_and_dispose(deadlines()).await;
}

#[tokio::test]
async fn project_a_b_a_reuses_scope_id_but_never_generation() {
    let (_, sink) = diagnostics();
    let host = host(sink, deadlines());
    let first_a = host
        .build_empty_project_candidate(ScopeId::new("project.a").unwrap())
        .await
        .unwrap();
    host.publish_project_candidate(None, first_a.clone())
        .await
        .unwrap();
    let b = host
        .build_empty_project_candidate(ScopeId::new("project.b").unwrap())
        .await
        .unwrap();
    host.publish_project_candidate(Some(first_a.clone()), b.clone())
        .await
        .unwrap();
    let second_a = host
        .build_empty_project_candidate(ScopeId::new("project.a").unwrap())
        .await
        .unwrap();
    host.publish_project_candidate(Some(b.clone()), second_a.clone())
        .await
        .unwrap();

    assert_eq!(first_a.identity().id, second_a.identity().id);
    assert_ne!(
        first_a.identity().generation,
        second_a.identity().generation
    );
    assert_eq!(first_a.state(), ScopeLifecycleState::Disposed);
    assert_eq!(b.state(), ScopeLifecycleState::Disposed);
    assert_eq!(second_a.state(), ScopeLifecycleState::Active);
    assert!(Arc::ptr_eq(&host.scopes().project().unwrap(), &second_a));
    assert!(
        host.scopes()
            .validate_project_current(first_a.identity())
            .is_err()
    );
    host.scopes()
        .validate_project_current(second_a.identity())
        .unwrap();
}

#[tokio::test]
async fn identical_registry_markers_are_isolated_between_project_candidates() {
    let marker = capability_id("source.shared");
    let plugin_for = |id: &str, log: Arc<Mutex<Vec<String>>>| -> Arc<dyn InternalPlugin> {
        Arc::new(TestPlugin {
            descriptor: descriptor(id, ScopePolicy::project_kind()),
            effects: Vec::new(),
            marker: Some(marker.clone()),
            task: PlannedTask::None,
            fail: None,
            log,
        })
    };
    let (_, sink) = diagnostics();
    let host = host(Arc::clone(&sink), deadlines());
    let a = build_project(
        &host,
        "project.a",
        vec![plugin_for(
            "plugin.marker",
            Arc::new(Mutex::new(Vec::new())),
        )],
        Arc::clone(&sink),
        deadlines(),
    )
    .await
    .unwrap();
    let b = build_project(
        &host,
        "project.b",
        vec![plugin_for(
            "plugin.marker",
            Arc::new(Mutex::new(Vec::new())),
        )],
        Arc::clone(&sink),
        deadlines(),
    )
    .await
    .unwrap();
    assert_ne!(
        a.registry().marker_owner(&marker).unwrap().scope.id,
        b.registry().marker_owner(&marker).unwrap().scope.id
    );
    let slot = ScopeSlot::empty(sink);
    slot.publish(None, a.clone(), deadlines()).await.unwrap();
    slot.publish(Some(a), b.clone(), deadlines()).await.unwrap();
    assert!(b.registry().is_routable());
}

#[tokio::test]
async fn duplicate_registry_marker_rejects_activation_and_rolls_back() {
    let marker = capability_id("source.duplicate");
    let log = Arc::new(Mutex::new(Vec::new()));
    let plugin = |id: &str| -> Arc<dyn InternalPlugin> {
        Arc::new(TestPlugin {
            descriptor: descriptor(id, ScopePolicy::project_kind()),
            effects: Vec::new(),
            marker: Some(marker.clone()),
            task: PlannedTask::None,
            fail: None,
            log: Arc::clone(&log),
        })
    };
    let (_, sink) = diagnostics();
    let host = host(Arc::clone(&sink), deadlines());
    let error = build_project(
        &host,
        "project.a",
        vec![plugin("plugin.a"), plugin("plugin.b")],
        sink,
        deadlines(),
    )
    .await
    .unwrap_err();
    match error {
        CandidateBuildError::Activation {
            error, rollback, ..
        } => {
            assert_eq!(error.code(), "registry_rejected");
            assert_eq!(rollback.outcome, DisposeOutcome::Disposed);
        }
        other => panic!("unexpected error: {other:?}"),
    }
}

#[tokio::test]
async fn application_shutdown_cascades_project_before_application() {
    let (collecting, sink) = diagnostics();
    let host = host(sink, deadlines());
    let project = host
        .build_empty_project_candidate(ScopeId::new("project.a").unwrap())
        .await
        .unwrap();
    host.publish_project_candidate(None, project).await.unwrap();
    let report = host.shutdown().await;
    assert_eq!(report.outcome, DisposeOutcome::Disposed);
    let disposed: Vec<_> = collecting
        .diagnostics()
        .into_iter()
        .filter(|item| item.code == DiagnosticCode::ScopeDisposed)
        .filter_map(|item| item.scope_id)
        .collect();
    assert_eq!(
        disposed,
        vec![
            ScopeId::new("project.a").unwrap(),
            ScopeId::new("application").unwrap(),
        ]
    );
}

#[tokio::test]
async fn activation_failure_cancels_tasks_and_reports_noncooperative_leak() {
    let short = LifecycleDeadlines {
        quiesce: Duration::from_millis(10),
        effect: Duration::from_millis(10),
        scope: Duration::from_millis(50),
    };
    let plugin = Arc::new(TestPlugin {
        descriptor: descriptor("plugin.task-fail", ScopePolicy::project_kind()),
        effects: Vec::new(),
        marker: None,
        task: PlannedTask::NonCooperative,
        fail: Some(ActivationError::new("injected", "fail after task")),
        log: Arc::new(Mutex::new(Vec::new())),
    });
    let (collecting, sink) = diagnostics();
    let host = host(Arc::clone(&sink), short);
    let plugins: Vec<Arc<dyn InternalPlugin>> = vec![plugin];
    let error = build_project(&host, "project.a", plugins, sink, short)
        .await
        .unwrap_err();
    match error {
        CandidateBuildError::Activation { rollback, .. } => {
            assert_eq!(rollback.outcome, DisposeOutcome::Failed);
            assert!(rollback.quiesce_timed_out);
        }
        other => panic!("unexpected error: {other:?}"),
    }
    assert!(
        collecting
            .diagnostics()
            .iter()
            .any(|item| item.code == DiagnosticCode::ActivationRollbackFailed)
    );
}

#[test]
fn helper_project_identity_is_valid_for_phase_one_policy() {
    let application = ScopeIdentity::new(
        ScopePolicy::application_kind(),
        ScopeId::new("application").unwrap(),
        None,
        ActivationGeneration::new(1).unwrap(),
    );
    ScopePolicy::phase_one()
        .validate_identity(&project_identity("project.a", 2), Some(&application))
        .unwrap();
}
