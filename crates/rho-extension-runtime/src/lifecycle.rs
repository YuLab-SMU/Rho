use std::{
    any::Any,
    collections::BTreeMap,
    fmt,
    future::Future,
    panic::AssertUnwindSafe,
    pin::Pin,
    sync::{
        Arc, Mutex as StdMutex, Weak,
        atomic::{AtomicBool, AtomicU8, AtomicU64, AtomicUsize, Ordering},
    },
    task::{Context as TaskContext, Poll},
    time::Duration,
};

use arc_swap::ArcSwapOption;
use serde::{Deserialize, Serialize};
use thiserror::Error;
use tokio::{
    sync::{Mutex, Notify},
    task::JoinHandle,
    time::{Instant, timeout},
};
use tokio_util::{sync::CancellationToken, task::TaskTracker};

use crate::{
    ActivationGeneration, ActivationPlan, BrokerFacade, CapabilityId, DiagnosticCode,
    DiagnosticSeverity, ExtensionDiagnostic, ExtensionError, PluginDescriptor, PluginId,
    RejectingBrokerFacade, ScopeId, ScopeIdentity, ScopeKindId, ScopePolicy,
    resolve_activation_plan,
};

const MAX_RUNTIME_MESSAGE_BYTES: usize = 512;

struct CatchUnwindFuture<F> {
    future: F,
}

impl<F> CatchUnwindFuture<F> {
    fn new(future: F) -> Self {
        Self { future }
    }
}

impl<F> Future for CatchUnwindFuture<F>
where
    F: Future + Unpin,
{
    type Output = Result<F::Output, Box<dyn Any + Send>>;

    fn poll(mut self: Pin<&mut Self>, context: &mut TaskContext<'_>) -> Poll<Self::Output> {
        match std::panic::catch_unwind(AssertUnwindSafe(|| {
            Pin::new(&mut self.future).poll(context)
        })) {
            Ok(Poll::Ready(output)) => Poll::Ready(Ok(output)),
            Ok(Poll::Pending) => Poll::Pending,
            Err(payload) => Poll::Ready(Err(payload)),
        }
    }
}

fn bounded_message(value: impl Into<String>) -> String {
    let value = value.into();
    if value.len() <= MAX_RUNTIME_MESSAGE_BYTES {
        return value;
    }
    let suffix = "…";
    let mut end = MAX_RUNTIME_MESSAGE_BYTES - suffix.len();
    while !value.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}{}", &value[..end], suffix)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum InternalExtensionRuntimeMode {
    Legacy,
    Candidate,
}

impl InternalExtensionRuntimeMode {
    pub fn parse(value: Option<&str>, diagnostics: &dyn DiagnosticSink) -> Self {
        match value {
            None | Some("legacy") => Self::Legacy,
            Some("candidate") => Self::Candidate,
            Some(value) => {
                diagnostics.emit(ExtensionDiagnostic {
                    code: DiagnosticCode::InvalidRuntimeMode,
                    severity: DiagnosticSeverity::Warning,
                    plugin_id: None,
                    capability_id: None,
                    scope_kind: None,
                    scope_id: None,
                    activation_generation: None,
                    effect_order: None,
                    related_plugins: Vec::new(),
                    cycle_path: Vec::new(),
                    message: bounded_message(format!(
                        "invalid RHO_INTERNAL_EXTENSION_RUNTIME value; using legacy ({} bytes)",
                        value.len()
                    )),
                });
                Self::Legacy
            }
        }
    }
}

pub trait DiagnosticSink: Send + Sync {
    fn emit(&self, diagnostic: ExtensionDiagnostic);
}

#[derive(Debug, Default)]
pub struct NoopDiagnosticSink;

impl DiagnosticSink for NoopDiagnosticSink {
    fn emit(&self, _diagnostic: ExtensionDiagnostic) {}
}

#[derive(Debug, Default)]
pub struct CollectingDiagnosticSink {
    diagnostics: StdMutex<Vec<ExtensionDiagnostic>>,
}

impl CollectingDiagnosticSink {
    pub fn diagnostics(&self) -> Vec<ExtensionDiagnostic> {
        self.diagnostics.lock().unwrap().clone()
    }
}

impl DiagnosticSink for CollectingDiagnosticSink {
    fn emit(&self, diagnostic: ExtensionDiagnostic) {
        self.diagnostics.lock().unwrap().push(diagnostic);
    }
}

struct ScopedDiagnosticSink<'a> {
    inner: &'a dyn DiagnosticSink,
    instance: &'a PluginInstanceIdentity,
}

impl DiagnosticSink for ScopedDiagnosticSink<'_> {
    fn emit(&self, mut diagnostic: ExtensionDiagnostic) {
        diagnostic.plugin_id = Some(self.instance.plugin_id.clone());
        diagnostic.scope_kind = Some(self.instance.scope.kind.clone());
        diagnostic.scope_id = Some(self.instance.scope.id.clone());
        diagnostic.activation_generation = Some(self.instance.scope.generation);
        diagnostic.message = bounded_message(diagnostic.message);
        diagnostic.related_plugins.truncate(256);
        diagnostic.cycle_path.truncate(257);
        self.inner.emit(diagnostic);
    }
}

impl<F> DiagnosticSink for F
where
    F: Fn(ExtensionDiagnostic) + Send + Sync,
{
    fn emit(&self, diagnostic: ExtensionDiagnostic) {
        self(diagnostic);
    }
}

fn lifecycle_diagnostic(
    code: DiagnosticCode,
    severity: DiagnosticSeverity,
    scope: Option<&ScopeIdentity>,
    plugin_id: Option<PluginId>,
    effect_order: Option<u64>,
    message: impl Into<String>,
) -> ExtensionDiagnostic {
    ExtensionDiagnostic {
        code,
        severity,
        plugin_id,
        capability_id: None,
        scope_kind: scope.map(|value| value.kind.clone()),
        scope_id: scope.map(|value| value.id.clone()),
        activation_generation: scope.map(|value| value.generation),
        effect_order,
        related_plugins: Vec::new(),
        cycle_path: Vec::new(),
        message: bounded_message(message),
    }
}

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
pub struct PluginInstanceIdentity {
    pub plugin_id: PluginId,
    pub scope: ScopeIdentity,
}

#[derive(Debug, Error, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[error("plugin activation failed: {code}")]
pub struct ActivationError {
    code: String,
    message: String,
}

impl ActivationError {
    pub fn new(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            code: bounded_message(code),
            message: bounded_message(message),
        }
    }

    pub fn code(&self) -> &str {
        &self.code
    }

    pub fn message(&self) -> &str {
        &self.message
    }
}

#[derive(Debug, Error, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[error("effect disposal failed: {code}")]
pub struct DisposeError {
    code: String,
    message: String,
}

impl DisposeError {
    pub fn new(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            code: bounded_message(code),
            message: bounded_message(message),
        }
    }

    pub fn code(&self) -> &str {
        &self.code
    }

    pub fn message(&self) -> &str {
        &self.message
    }
}

pub trait Disposable: Send {
    fn dispose<'a>(
        &'a mut self,
    ) -> Pin<Box<dyn Future<Output = Result<(), DisposeError>> + Send + 'a>>;
}

pub trait InternalPlugin: Send + Sync {
    fn descriptor(&self) -> &PluginDescriptor;

    fn activate<'a>(
        &'a self,
        context: PluginContext<'a>,
    ) -> Pin<Box<dyn Future<Output = Result<(), ActivationError>> + Send + 'a>>;
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct LifecycleDeadlines {
    pub quiesce: Duration,
    pub effect: Duration,
    pub scope: Duration,
}

impl Default for LifecycleDeadlines {
    fn default() -> Self {
        Self {
            quiesce: Duration::from_secs(5),
            effect: Duration::from_secs(2),
            scope: Duration::from_secs(10),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EffectStatus {
    Registered,
    Disposing,
    Disposed,
    Failed,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct EffectRecord {
    pub instance: PluginInstanceIdentity,
    pub creation_order: u64,
    pub status: EffectStatus,
    pub cleanup_error: Option<DisposeError>,
}

struct PendingEffect {
    record: EffectRecord,
    disposer: Box<dyn Disposable>,
}

pub struct EffectSink {
    instance: PluginInstanceIdentity,
    effects: Vec<PendingEffect>,
}

impl EffectSink {
    fn new(instance: PluginInstanceIdentity) -> Self {
        Self {
            instance,
            effects: Vec::new(),
        }
    }

    pub fn push(&mut self, disposer: Box<dyn Disposable>) -> u64 {
        let creation_order = self.effects.len() as u64;
        self.effects.push(PendingEffect {
            record: EffectRecord {
                instance: self.instance.clone(),
                creation_order,
                status: EffectStatus::Registered,
                cleanup_error: None,
            },
            disposer,
        });
        creation_order
    }

    pub fn register_marker(
        &mut self,
        registry: &RegistryHub,
        capability_id: CapabilityId,
    ) -> Result<u64, RegistryError> {
        let registration = registry.register_marker(self.instance.clone(), capability_id)?;
        Ok(self.push(Box::new(registration)))
    }

    fn into_stack(self, diagnostics: Arc<dyn DiagnosticSink>) -> Arc<EffectStack> {
        Arc::new(EffectStack {
            inner: Mutex::new(EffectStackInner {
                effects: self.effects,
                report: None,
            }),
            diagnostics,
        })
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DisposeOutcome {
    Disposed,
    Failed,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct EffectDisposeReport {
    pub outcome: DisposeOutcome,
    pub records: Vec<EffectRecord>,
}

struct EffectStackInner {
    effects: Vec<PendingEffect>,
    report: Option<EffectDisposeReport>,
}

struct EffectStack {
    inner: Mutex<EffectStackInner>,
    diagnostics: Arc<dyn DiagnosticSink>,
}

impl EffectStack {
    async fn dispose(
        &self,
        per_effect_deadline: Duration,
        total_deadline: Duration,
    ) -> EffectDisposeReport {
        let mut inner = self.inner.lock().await;
        if let Some(report) = inner.report.clone() {
            return report;
        }

        let started = Instant::now();
        for effect in inner.effects.iter_mut().rev() {
            effect.record.status = EffectStatus::Disposing;
            let elapsed = started.elapsed();
            let Some(remaining) = total_deadline.checked_sub(elapsed) else {
                effect.record.status = EffectStatus::Failed;
                effect.record.cleanup_error = Some(DisposeError::new(
                    "scope_dispose_timeout",
                    "scope disposal deadline expired before this effect could run",
                ));
                continue;
            };
            let deadline = per_effect_deadline.min(remaining);
            let result = timeout(deadline, CatchUnwindFuture::new(effect.disposer.dispose())).await;
            match result {
                Ok(Ok(Ok(()))) => {
                    effect.record.status = EffectStatus::Disposed;
                }
                Ok(Ok(Err(error))) => {
                    effect.record.status = EffectStatus::Failed;
                    effect.record.cleanup_error = Some(error.clone());
                    self.diagnostics.emit(lifecycle_diagnostic(
                        DiagnosticCode::EffectDisposeFailed,
                        DiagnosticSeverity::Error,
                        Some(&effect.record.instance.scope),
                        Some(effect.record.instance.plugin_id.clone()),
                        Some(effect.record.creation_order),
                        format!("effect cleanup failed: {}", error.code()),
                    ));
                }
                Ok(Err(_)) => {
                    let error = DisposeError::new(
                        "effect_dispose_panicked",
                        "effect cleanup panicked at the host boundary",
                    );
                    effect.record.status = EffectStatus::Failed;
                    effect.record.cleanup_error = Some(error.clone());
                    self.diagnostics.emit(lifecycle_diagnostic(
                        DiagnosticCode::EffectDisposeFailed,
                        DiagnosticSeverity::Error,
                        Some(&effect.record.instance.scope),
                        Some(effect.record.instance.plugin_id.clone()),
                        Some(effect.record.creation_order),
                        error.message().to_string(),
                    ));
                }
                Err(_) => {
                    let error = DisposeError::new(
                        "effect_dispose_timeout",
                        "effect cleanup exceeded its deadline",
                    );
                    effect.record.status = EffectStatus::Failed;
                    effect.record.cleanup_error = Some(error.clone());
                    self.diagnostics.emit(lifecycle_diagnostic(
                        DiagnosticCode::EffectDisposeFailed,
                        DiagnosticSeverity::Error,
                        Some(&effect.record.instance.scope),
                        Some(effect.record.instance.plugin_id.clone()),
                        Some(effect.record.creation_order),
                        error.message().to_string(),
                    ));
                }
            }
        }

        let records: Vec<_> = inner
            .effects
            .iter()
            .map(|effect| effect.record.clone())
            .collect();
        let outcome = if records
            .iter()
            .all(|record| record.status == EffectStatus::Disposed)
        {
            DisposeOutcome::Disposed
        } else {
            DisposeOutcome::Failed
        };
        let report = EffectDisposeReport { outcome, records };
        inner.report = Some(report.clone());
        report
    }
}

#[derive(Debug, Error, Clone, PartialEq, Eq)]
pub enum RegistryError {
    #[error("registry marker already exists: {capability_id}")]
    DuplicateMarker { capability_id: CapabilityId },
}

#[derive(Debug, Error, Clone, PartialEq, Eq)]
pub enum RoutingError {
    #[error("scope routing is closed")]
    Closed,
}

struct RegistryInner {
    scope: ScopeIdentity,
    routing: AtomicBool,
    leases: AtomicUsize,
    idle: Notify,
    markers: StdMutex<BTreeMap<CapabilityId, PluginInstanceIdentity>>,
}

#[derive(Clone)]
pub struct RegistryHub {
    inner: Arc<RegistryInner>,
}

impl RegistryHub {
    fn candidate(scope: ScopeIdentity) -> Self {
        Self {
            inner: Arc::new(RegistryInner {
                scope,
                routing: AtomicBool::new(false),
                leases: AtomicUsize::new(0),
                idle: Notify::new(),
                markers: StdMutex::new(BTreeMap::new()),
            }),
        }
    }

    pub fn scope(&self) -> &ScopeIdentity {
        &self.inner.scope
    }

    pub fn is_routable(&self) -> bool {
        self.inner.routing.load(Ordering::Acquire)
    }

    fn open_routing(&self) {
        self.inner.routing.store(true, Ordering::Release);
    }

    fn close_routing(&self) {
        self.inner.routing.store(false, Ordering::Release);
        self.inner.idle.notify_waiters();
    }

    pub fn lease(&self) -> Result<RegistryLease, RoutingError> {
        if !self.inner.routing.load(Ordering::Acquire) {
            return Err(RoutingError::Closed);
        }
        self.inner.leases.fetch_add(1, Ordering::AcqRel);
        if !self.inner.routing.load(Ordering::Acquire) {
            if self.inner.leases.fetch_sub(1, Ordering::AcqRel) == 1 {
                self.inner.idle.notify_waiters();
            }
            return Err(RoutingError::Closed);
        }
        Ok(RegistryLease {
            inner: Arc::clone(&self.inner),
        })
    }

    pub fn marker_owner(&self, capability_id: &CapabilityId) -> Option<PluginInstanceIdentity> {
        self.inner
            .markers
            .lock()
            .unwrap()
            .get(capability_id)
            .cloned()
    }

    pub fn active_leases(&self) -> usize {
        self.inner.leases.load(Ordering::Acquire)
    }

    fn register_marker(
        &self,
        instance: PluginInstanceIdentity,
        capability_id: CapabilityId,
    ) -> Result<RegistryRegistration, RegistryError> {
        let mut markers = self.inner.markers.lock().unwrap();
        if markers.contains_key(&capability_id) {
            return Err(RegistryError::DuplicateMarker { capability_id });
        }
        markers.insert(capability_id.clone(), instance.clone());
        Ok(RegistryRegistration {
            registry: Arc::downgrade(&self.inner),
            capability_id,
            instance,
            disposed: false,
        })
    }

    async fn wait_for_idle(&self) {
        loop {
            if self.inner.leases.load(Ordering::Acquire) == 0 {
                return;
            }
            let notified = self.inner.idle.notified();
            if self.inner.leases.load(Ordering::Acquire) == 0 {
                return;
            }
            notified.await;
        }
    }
}

pub struct RegistryLease {
    inner: Arc<RegistryInner>,
}

impl RegistryLease {
    pub fn scope(&self) -> &ScopeIdentity {
        &self.inner.scope
    }
}

impl Drop for RegistryLease {
    fn drop(&mut self) {
        if self.inner.leases.fetch_sub(1, Ordering::AcqRel) == 1 {
            self.inner.idle.notify_waiters();
        }
    }
}

struct RegistryRegistration {
    registry: Weak<RegistryInner>,
    capability_id: CapabilityId,
    instance: PluginInstanceIdentity,
    disposed: bool,
}

impl Disposable for RegistryRegistration {
    fn dispose<'a>(
        &'a mut self,
    ) -> Pin<Box<dyn Future<Output = Result<(), DisposeError>> + Send + 'a>> {
        Box::pin(async move {
            if self.disposed {
                return Ok(());
            }
            if let Some(registry) = self.registry.upgrade() {
                let mut markers = registry.markers.lock().unwrap();
                if markers.get(&self.capability_id) == Some(&self.instance) {
                    markers.remove(&self.capability_id);
                }
            }
            self.disposed = true;
            Ok(())
        })
    }
}

#[derive(Debug, Error, Clone, Copy, PartialEq, Eq)]
pub enum TaskAdmissionError {
    #[error("scope task admission is closed")]
    Closed,
}

struct TaskAdmission {
    accepting: bool,
}

#[derive(Clone)]
pub struct ScopedTaskTracker {
    tracker: TaskTracker,
    admission: Arc<StdMutex<TaskAdmission>>,
}

impl ScopedTaskTracker {
    fn new() -> Self {
        Self {
            tracker: TaskTracker::new(),
            admission: Arc::new(StdMutex::new(TaskAdmission { accepting: true })),
        }
    }

    pub fn spawn<F>(&self, future: F) -> Result<JoinHandle<F::Output>, TaskAdmissionError>
    where
        F: Future + Send + 'static,
        F::Output: Send + 'static,
    {
        let admission = self.admission.lock().unwrap();
        if !admission.accepting {
            return Err(TaskAdmissionError::Closed);
        }
        Ok(self.tracker.spawn(future))
    }

    pub fn is_accepting(&self) -> bool {
        self.admission.lock().unwrap().accepting
    }

    pub fn len(&self) -> usize {
        self.tracker.len()
    }

    pub fn is_empty(&self) -> bool {
        self.tracker.is_empty()
    }

    fn close(&self) {
        let mut admission = self.admission.lock().unwrap();
        admission.accepting = false;
        self.tracker.close();
    }

    async fn wait(&self) {
        self.tracker.wait().await;
    }
}

pub struct PluginContext<'a> {
    pub registry: &'a RegistryHub,
    pub broker: &'a dyn BrokerFacade,
    pub effects: &'a mut EffectSink,
    pub diagnostics: &'a dyn DiagnosticSink,
    pub cancellation: CancellationToken,
    pub tasks: ScopedTaskTracker,
}

struct ActivatedPlugin {
    instance: PluginInstanceIdentity,
    effects: Arc<EffectStack>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ScopeLifecycleState {
    Ready,
    Active,
    Quiescing,
    Disposing,
    Disposed,
    Failed,
}

impl ScopeLifecycleState {
    fn as_u8(self) -> u8 {
        self as u8
    }

    fn from_u8(value: u8) -> Self {
        match value {
            0 => Self::Ready,
            1 => Self::Active,
            2 => Self::Quiescing,
            3 => Self::Disposing,
            4 => Self::Disposed,
            _ => Self::Failed,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ScopeDisposeReport {
    pub scope: ScopeIdentity,
    pub outcome: DisposeOutcome,
    pub quiesce_timed_out: bool,
    pub remaining_tasks: usize,
    pub remaining_leases: usize,
    pub child_reports: Vec<ScopeDisposeReport>,
    pub plugin_reports: Vec<(PluginInstanceIdentity, EffectDisposeReport)>,
}

pub struct ScopeSnapshot {
    identity: ScopeIdentity,
    plan: ActivationPlan,
    registry: RegistryHub,
    cancellation: CancellationToken,
    tasks: ScopedTaskTracker,
    plugins: Vec<ActivatedPlugin>,
    children: StdMutex<Vec<Arc<ScopeSnapshot>>>,
    state: AtomicU8,
    dispose_gate: Mutex<()>,
    dispose_report: StdMutex<Option<ScopeDisposeReport>>,
    diagnostics: Arc<dyn DiagnosticSink>,
}

impl fmt::Debug for ScopeSnapshot {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ScopeSnapshot")
            .field("identity", &self.identity)
            .field("state", &self.state())
            .finish_non_exhaustive()
    }
}

impl ScopeSnapshot {
    fn new_ready(
        identity: ScopeIdentity,
        plan: ActivationPlan,
        registry: RegistryHub,
        cancellation: CancellationToken,
        tasks: ScopedTaskTracker,
        plugins: Vec<ActivatedPlugin>,
        diagnostics: Arc<dyn DiagnosticSink>,
    ) -> Self {
        Self {
            identity,
            plan,
            registry,
            cancellation,
            tasks,
            plugins,
            children: StdMutex::new(Vec::new()),
            state: AtomicU8::new(ScopeLifecycleState::Ready.as_u8()),
            dispose_gate: Mutex::new(()),
            dispose_report: StdMutex::new(None),
            diagnostics,
        }
    }

    pub fn identity(&self) -> &ScopeIdentity {
        &self.identity
    }

    pub fn plan(&self) -> &ActivationPlan {
        &self.plan
    }

    pub fn registry(&self) -> &RegistryHub {
        &self.registry
    }

    pub fn cancellation(&self) -> CancellationToken {
        self.cancellation.clone()
    }

    pub fn tasks(&self) -> ScopedTaskTracker {
        self.tasks.clone()
    }

    pub fn state(&self) -> ScopeLifecycleState {
        ScopeLifecycleState::from_u8(self.state.load(Ordering::Acquire))
    }

    fn mark_active(&self) -> Result<(), ScopeStateError> {
        self.state
            .compare_exchange(
                ScopeLifecycleState::Ready.as_u8(),
                ScopeLifecycleState::Active.as_u8(),
                Ordering::AcqRel,
                Ordering::Acquire,
            )
            .map_err(|actual| ScopeStateError::InvalidTransition {
                expected: ScopeLifecycleState::Ready,
                actual: ScopeLifecycleState::from_u8(actual),
            })?;
        self.registry.open_routing();
        Ok(())
    }

    pub fn attach_child(&self, child: Arc<ScopeSnapshot>) -> Result<(), ScopeStateError> {
        let state = self.state();
        if !matches!(
            state,
            ScopeLifecycleState::Ready | ScopeLifecycleState::Active
        ) {
            return Err(ScopeStateError::InvalidTransition {
                expected: ScopeLifecycleState::Active,
                actual: state,
            });
        }
        if child.identity.parent_id.as_ref() != Some(&self.identity.id) {
            return Err(ScopeStateError::InvalidChildParent);
        }
        self.children.lock().unwrap().push(child);
        Ok(())
    }

    fn replace_child(&self, expected: Option<&Arc<ScopeSnapshot>>, candidate: Arc<ScopeSnapshot>) {
        let mut children = self.children.lock().unwrap();
        if let Some(expected) = expected
            && let Some(index) = children.iter().position(|item| Arc::ptr_eq(item, expected))
        {
            children.remove(index);
        }
        children.push(candidate);
    }

    fn begin_quiesce(&self) {
        loop {
            let actual = self.state.load(Ordering::Acquire);
            let state = ScopeLifecycleState::from_u8(actual);
            if !matches!(
                state,
                ScopeLifecycleState::Ready | ScopeLifecycleState::Active
            ) {
                break;
            }
            if self
                .state
                .compare_exchange(
                    actual,
                    ScopeLifecycleState::Quiescing.as_u8(),
                    Ordering::AcqRel,
                    Ordering::Acquire,
                )
                .is_ok()
            {
                self.diagnostics.emit(lifecycle_diagnostic(
                    DiagnosticCode::QuiesceStarted,
                    DiagnosticSeverity::Info,
                    Some(&self.identity),
                    None,
                    None,
                    "scope quiesce started",
                ));
                break;
            }
        }
        self.registry.close_routing();
        self.tasks.close();
        self.cancellation.cancel();
    }

    pub fn quiesce_and_dispose(
        &self,
        deadlines: LifecycleDeadlines,
    ) -> Pin<Box<dyn Future<Output = ScopeDisposeReport> + Send + '_>> {
        Box::pin(async move {
            let _gate = self.dispose_gate.lock().await;
            if let Some(report) = self.dispose_report.lock().unwrap().clone() {
                return report;
            }

            self.begin_quiesce();

            let started = Instant::now();
            let quiesce_limit = deadlines.quiesce.min(deadlines.scope);
            let quiesce_result = timeout(quiesce_limit, async {
                tokio::join!(self.registry.wait_for_idle(), self.tasks.wait());
            })
            .await;
            let quiesce_timed_out = quiesce_result.is_err();
            if quiesce_timed_out {
                self.diagnostics.emit(lifecycle_diagnostic(
                    DiagnosticCode::QuiesceTimeout,
                    DiagnosticSeverity::Error,
                    Some(&self.identity),
                    None,
                    None,
                    "scope tasks or leases did not drain before the quiesce deadline",
                ));
            }

            self.state
                .store(ScopeLifecycleState::Disposing.as_u8(), Ordering::Release);

            let children = self.children.lock().unwrap().clone();
            let mut child_reports = Vec::with_capacity(children.len());
            let mut child_timeout = false;
            for child in children.iter().rev() {
                let Some(remaining) = deadlines.scope.checked_sub(started.elapsed()) else {
                    child_timeout = true;
                    child_reports.push(timed_out_scope_report(child));
                    continue;
                };
                let child_deadlines = LifecycleDeadlines {
                    scope: remaining,
                    ..deadlines
                };
                match timeout(remaining, child.quiesce_and_dispose(child_deadlines)).await {
                    Ok(report) => child_reports.push(report),
                    Err(_) => {
                        child_timeout = true;
                        child_reports.push(timed_out_scope_report(child));
                    }
                }
            }

            let mut plugin_reports = Vec::with_capacity(self.plugins.len());
            for plugin in self.plugins.iter().rev() {
                let remaining = deadlines
                    .scope
                    .checked_sub(started.elapsed())
                    .unwrap_or(Duration::ZERO);
                let report = plugin.effects.dispose(deadlines.effect, remaining).await;
                plugin_reports.push((plugin.instance.clone(), report));
            }

            let failed = quiesce_timed_out
                || child_timeout
                || child_reports
                    .iter()
                    .any(|report| report.outcome == DisposeOutcome::Failed)
                || plugin_reports
                    .iter()
                    .any(|(_, report)| report.outcome == DisposeOutcome::Failed);
            let outcome = if failed {
                DisposeOutcome::Failed
            } else {
                DisposeOutcome::Disposed
            };
            self.state.store(
                if failed {
                    ScopeLifecycleState::Failed.as_u8()
                } else {
                    ScopeLifecycleState::Disposed.as_u8()
                },
                Ordering::Release,
            );
            self.diagnostics.emit(lifecycle_diagnostic(
                if failed {
                    DiagnosticCode::ScopeDisposeFailed
                } else {
                    DiagnosticCode::ScopeDisposed
                },
                if failed {
                    DiagnosticSeverity::Error
                } else {
                    DiagnosticSeverity::Info
                },
                Some(&self.identity),
                None,
                None,
                if failed {
                    "scope disposal completed with leaked resources"
                } else {
                    "scope disposed"
                },
            ));
            let report = ScopeDisposeReport {
                scope: self.identity.clone(),
                outcome,
                quiesce_timed_out: quiesce_timed_out || child_timeout,
                remaining_tasks: self.tasks.len(),
                remaining_leases: self.registry.active_leases(),
                child_reports,
                plugin_reports,
            };
            *self.dispose_report.lock().unwrap() = Some(report.clone());
            report
        })
    }
}

fn timed_out_scope_report(scope: &ScopeSnapshot) -> ScopeDisposeReport {
    ScopeDisposeReport {
        scope: scope.identity.clone(),
        outcome: DisposeOutcome::Failed,
        quiesce_timed_out: true,
        remaining_tasks: scope.tasks.len(),
        remaining_leases: scope.registry.active_leases(),
        child_reports: Vec::new(),
        plugin_reports: Vec::new(),
    }
}

#[derive(Debug, Error, Clone, PartialEq, Eq)]
pub enum ScopeStateError {
    #[error("invalid scope lifecycle transition: expected {expected:?}, actual {actual:?}")]
    InvalidTransition {
        expected: ScopeLifecycleState,
        actual: ScopeLifecycleState,
    },
    #[error("child scope parent does not match")]
    InvalidChildParent,
}

#[derive(Debug, Error, Clone, PartialEq, Eq)]
pub enum CandidateBuildError {
    #[error("scope dependency resolution failed: {0}")]
    Resolution(Box<ExtensionError>),
    #[error("plugin {plugin_id} activation failed: {error}")]
    Activation {
        plugin_id: PluginId,
        error: ActivationError,
        rollback: Box<ScopeDisposeReport>,
    },
}

pub async fn build_scope_candidate(
    identity: ScopeIdentity,
    parent_plan: Option<&ActivationPlan>,
    plugins: Vec<Arc<dyn InternalPlugin>>,
    broker: Arc<dyn BrokerFacade>,
    diagnostics: Arc<dyn DiagnosticSink>,
    deadlines: LifecycleDeadlines,
) -> Result<Arc<ScopeSnapshot>, CandidateBuildError> {
    let descriptors: Vec<_> = plugins
        .iter()
        .map(|plugin| plugin.descriptor().clone())
        .collect();
    let plan = resolve_activation_plan(
        &ScopePolicy::phase_one(),
        identity.clone(),
        parent_plan,
        descriptors,
    )
    .map_err(|error| CandidateBuildError::Resolution(Box::new(error)))?;
    let plugins_by_id: BTreeMap<_, _> = plugins
        .into_iter()
        .map(|plugin| (plugin.descriptor().id.clone(), plugin))
        .collect();
    let registry = RegistryHub::candidate(identity.clone());
    let cancellation = CancellationToken::new();
    let tasks = ScopedTaskTracker::new();
    let mut activated = Vec::new();
    let activation_order = plan.activation_order().to_vec();

    for plugin_id in &activation_order {
        let plugin = plugins_by_id
            .get(plugin_id)
            .expect("resolved plugin must remain in the static inventory");
        let instance = PluginInstanceIdentity {
            plugin_id: plugin_id.clone(),
            scope: identity.clone(),
        };
        diagnostics.emit(lifecycle_diagnostic(
            DiagnosticCode::ActivationStarted,
            DiagnosticSeverity::Info,
            Some(&identity),
            Some(plugin_id.clone()),
            None,
            "plugin activation started",
        ));
        let mut effects = EffectSink::new(instance.clone());
        let plugin_diagnostics = ScopedDiagnosticSink {
            inner: diagnostics.as_ref(),
            instance: &instance,
        };
        let result = CatchUnwindFuture::new(plugin.activate(PluginContext {
            registry: &registry,
            broker: broker.as_ref(),
            effects: &mut effects,
            diagnostics: &plugin_diagnostics,
            cancellation: cancellation.child_token(),
            tasks: tasks.clone(),
        }))
        .await;
        let result = match result {
            Ok(result) => result,
            Err(_) => Err(ActivationError::new(
                "activation_panicked",
                "plugin activation panicked at the host boundary",
            )),
        };
        let effect_stack = effects.into_stack(Arc::clone(&diagnostics));
        activated.push(ActivatedPlugin {
            instance: instance.clone(),
            effects: effect_stack,
        });

        match result {
            Ok(()) => diagnostics.emit(lifecycle_diagnostic(
                DiagnosticCode::ActivationSucceeded,
                DiagnosticSeverity::Info,
                Some(&identity),
                Some(plugin_id.clone()),
                None,
                "plugin activation succeeded",
            )),
            Err(error) => {
                diagnostics.emit(lifecycle_diagnostic(
                    DiagnosticCode::ActivationFailed,
                    DiagnosticSeverity::Error,
                    Some(&identity),
                    Some(plugin_id.clone()),
                    None,
                    format!("plugin activation failed: {}", error.code()),
                ));
                let snapshot = ScopeSnapshot::new_ready(
                    identity,
                    plan,
                    registry,
                    cancellation,
                    tasks,
                    activated,
                    diagnostics,
                );
                let rollback = snapshot.quiesce_and_dispose(deadlines).await;
                if rollback.outcome == DisposeOutcome::Failed {
                    snapshot.diagnostics.emit(lifecycle_diagnostic(
                        DiagnosticCode::ActivationRollbackFailed,
                        DiagnosticSeverity::Error,
                        Some(snapshot.identity()),
                        Some(plugin_id.clone()),
                        None,
                        "activation rollback completed with leaked resources",
                    ));
                }
                return Err(CandidateBuildError::Activation {
                    plugin_id: plugin_id.clone(),
                    error,
                    rollback: Box::new(rollback),
                });
            }
        }
    }

    Ok(Arc::new(ScopeSnapshot::new_ready(
        identity,
        plan,
        registry,
        cancellation,
        tasks,
        activated,
        diagnostics,
    )))
}

pub struct ScopeSlot {
    current: ArcSwapOption<ScopeSnapshot>,
    diagnostics: Arc<dyn DiagnosticSink>,
}

impl ScopeSlot {
    pub fn empty(diagnostics: Arc<dyn DiagnosticSink>) -> Self {
        Self {
            current: ArcSwapOption::from(None),
            diagnostics,
        }
    }

    pub fn from_active(
        snapshot: Arc<ScopeSnapshot>,
        diagnostics: Arc<dyn DiagnosticSink>,
    ) -> Result<Self, ScopeStateError> {
        snapshot.mark_active()?;
        Ok(Self {
            current: ArcSwapOption::from(Some(snapshot)),
            diagnostics,
        })
    }

    pub fn current(&self) -> Option<Arc<ScopeSnapshot>> {
        self.current.load_full()
    }

    pub fn validate_current(
        &self,
        completed_scope: &ScopeIdentity,
    ) -> Result<(), StaleGenerationError> {
        let actual = self.current();
        if actual
            .as_ref()
            .is_some_and(|snapshot| snapshot.identity() == completed_scope)
        {
            return Ok(());
        }
        Err(StaleGenerationError {
            context: Box::new(StaleGenerationContext {
                completed: completed_scope.clone(),
                actual: actual.map(|snapshot| snapshot.identity.clone()),
            }),
        })
    }

    pub async fn publish(
        &self,
        expected: Option<Arc<ScopeSnapshot>>,
        candidate: Arc<ScopeSnapshot>,
        deadlines: LifecycleDeadlines,
    ) -> Result<PublishReport, CandidatePublishError> {
        self.publish_with(expected, candidate, deadlines, |_, _| {})
            .await
    }

    async fn publish_with<F>(
        &self,
        expected: Option<Arc<ScopeSnapshot>>,
        candidate: Arc<ScopeSnapshot>,
        deadlines: LifecycleDeadlines,
        on_published: F,
    ) -> Result<PublishReport, CandidatePublishError>
    where
        F: FnOnce(Option<&Arc<ScopeSnapshot>>, &Arc<ScopeSnapshot>),
    {
        let publication_gate = candidate.dispose_gate.lock().await;
        if candidate.state() != ScopeLifecycleState::Ready {
            let actual = candidate.state();
            drop(publication_gate);
            let rejected_dispose = candidate.quiesce_and_dispose(deadlines).await;
            return Err(CandidatePublishError {
                expected: expected.map(|value| value.identity.clone()),
                actual: self.current().map(|value| value.identity.clone()),
                rejected: candidate.identity.clone(),
                rejected_dispose,
                reason: ScopeStateError::InvalidTransition {
                    expected: ScopeLifecycleState::Ready,
                    actual,
                }
                .to_string(),
            });
        }

        if let Err(error) = candidate.mark_active() {
            drop(publication_gate);
            let rejected_dispose = candidate.quiesce_and_dispose(deadlines).await;
            return Err(CandidatePublishError {
                expected: expected.map(|value| value.identity.clone()),
                actual: self.current().map(|value| value.identity.clone()),
                rejected: candidate.identity.clone(),
                rejected_dispose,
                reason: error.to_string(),
            });
        }

        let previous = match expected.as_ref() {
            Some(expected) => self
                .current
                .compare_and_swap(expected, Some(Arc::clone(&candidate))),
            None => self
                .current
                .compare_and_swap(&None::<Arc<ScopeSnapshot>>, Some(Arc::clone(&candidate))),
        };
        let previous_value = (*previous).clone();
        let did_swap = option_arc_ptr_eq(&previous_value, &expected);
        if !did_swap {
            self.diagnostics.emit(lifecycle_diagnostic(
                DiagnosticCode::CandidateCasRejected,
                DiagnosticSeverity::Warning,
                Some(candidate.identity()),
                None,
                None,
                "candidate publication lost the expected-old CAS race",
            ));
            drop(publication_gate);
            let rejected_dispose = candidate.quiesce_and_dispose(deadlines).await;
            return Err(CandidatePublishError {
                expected: expected.map(|value| value.identity.clone()),
                actual: previous_value.map(|value| value.identity.clone()),
                rejected: candidate.identity.clone(),
                rejected_dispose,
                reason: "expected_old_mismatch".to_string(),
            });
        }
        self.diagnostics.emit(lifecycle_diagnostic(
            DiagnosticCode::CandidatePublished,
            DiagnosticSeverity::Info,
            Some(candidate.identity()),
            None,
            None,
            "candidate scope published",
        ));
        if let Some(previous) = previous_value.as_ref() {
            previous.begin_quiesce();
        }
        on_published(previous_value.as_ref(), &candidate);
        drop(publication_gate);
        let previous_dispose = match previous_value.as_ref() {
            Some(previous) => Some(previous.quiesce_and_dispose(deadlines).await),
            None => None,
        };
        Ok(PublishReport {
            published: candidate.identity.clone(),
            previous: previous_value.map(|value| value.identity.clone()),
            previous_dispose,
        })
    }
}

fn option_arc_ptr_eq<T>(left: &Option<Arc<T>>, right: &Option<Arc<T>>) -> bool {
    match (left, right) {
        (Some(left), Some(right)) => Arc::ptr_eq(left, right),
        (None, None) => true,
        _ => false,
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PublishReport {
    pub published: ScopeIdentity,
    pub previous: Option<ScopeIdentity>,
    pub previous_dispose: Option<ScopeDisposeReport>,
}

#[derive(Debug, Error, Clone, PartialEq, Eq)]
#[error("candidate publication failed: {reason}")]
pub struct CandidatePublishError {
    pub expected: Option<ScopeIdentity>,
    pub actual: Option<ScopeIdentity>,
    pub rejected: ScopeIdentity,
    pub rejected_dispose: ScopeDisposeReport,
    pub reason: String,
}

#[derive(Debug, Error, Clone, PartialEq, Eq)]
#[error("scope completion belongs to a stale activation generation")]
pub struct StaleGenerationError {
    pub context: Box<StaleGenerationContext>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StaleGenerationContext {
    pub completed: ScopeIdentity,
    pub actual: Option<ScopeIdentity>,
}

pub struct ScopeManager {
    policy: ScopePolicy,
    next_generation: AtomicU64,
    application: Arc<ScopeSlot>,
    project: Arc<ScopeSlot>,
    diagnostics: Arc<dyn DiagnosticSink>,
    deadlines: LifecycleDeadlines,
}

impl ScopeManager {
    fn new(
        application: Arc<ScopeSnapshot>,
        diagnostics: Arc<dyn DiagnosticSink>,
        deadlines: LifecycleDeadlines,
    ) -> Result<Self, ScopeStateError> {
        Ok(Self {
            policy: ScopePolicy::phase_one(),
            next_generation: AtomicU64::new(2),
            application: Arc::new(ScopeSlot::from_active(
                application,
                Arc::clone(&diagnostics),
            )?),
            project: Arc::new(ScopeSlot::empty(Arc::clone(&diagnostics))),
            diagnostics,
            deadlines,
        })
    }

    pub fn application(&self) -> Arc<ScopeSnapshot> {
        self.application
            .current()
            .expect("application scope remains present until host shutdown")
    }

    pub fn project(&self) -> Option<Arc<ScopeSnapshot>> {
        self.project.current()
    }

    pub fn validate_project_current(
        &self,
        completed_scope: &ScopeIdentity,
    ) -> Result<(), StaleGenerationError> {
        self.project.validate_current(completed_scope)
    }

    pub fn next_identity(
        &self,
        kind: ScopeKindId,
        id: ScopeId,
        parent: Option<&ScopeSnapshot>,
    ) -> Result<ScopeIdentity, ExtensionError> {
        let generation = self
            .next_generation
            .fetch_update(Ordering::AcqRel, Ordering::Acquire, |value| {
                value.checked_add(1)
            })
            .map_err(|_| ExtensionError::ActivationGenerationExhausted)?;
        let generation = ActivationGeneration::new(generation)?;
        let identity = ScopeIdentity::new(
            kind,
            id,
            parent.map(|value| value.identity.id.clone()),
            generation,
        );
        self.policy
            .validate_identity(&identity, parent.map(|value| value.identity()))?;
        Ok(identity)
    }

    pub async fn publish_project(
        &self,
        expected: Option<Arc<ScopeSnapshot>>,
        candidate: Arc<ScopeSnapshot>,
    ) -> Result<PublishReport, CandidatePublishError> {
        let application = self.application();
        self.project
            .publish_with(
                expected,
                candidate,
                self.deadlines,
                move |previous, candidate| {
                    application.replace_child(previous, Arc::clone(candidate));
                },
            )
            .await
    }

    pub async fn shutdown(&self) -> ScopeDisposeReport {
        let application = self.application();
        application.quiesce_and_dispose(self.deadlines).await
    }

    pub fn diagnostics(&self) -> Arc<dyn DiagnosticSink> {
        Arc::clone(&self.diagnostics)
    }
}

#[derive(Debug, Error)]
pub enum ExtensionHostError {
    #[error("application graph could not be constructed: {0}")]
    ApplicationGraph(Box<ExtensionError>),
    #[error(transparent)]
    ApplicationState(#[from] ScopeStateError),
}

pub struct ExtensionHost {
    mode: InternalExtensionRuntimeMode,
    scopes: ScopeManager,
    diagnostics: Arc<dyn DiagnosticSink>,
    deadlines: LifecycleDeadlines,
}

impl ExtensionHost {
    pub fn new_empty(
        mode: InternalExtensionRuntimeMode,
        diagnostics: Arc<dyn DiagnosticSink>,
        deadlines: LifecycleDeadlines,
    ) -> Result<Self, ExtensionHostError> {
        let identity = ScopeIdentity::new(
            ScopePolicy::application_kind(),
            ScopeId::new("application").expect("built-in scope ID must be valid"),
            None,
            ActivationGeneration::new(1).expect("built-in generation must be non-zero"),
        );
        let plan = resolve_activation_plan(
            &ScopePolicy::phase_one(),
            identity.clone(),
            None,
            Vec::new(),
        )
        .map_err(|error| ExtensionHostError::ApplicationGraph(Box::new(error)))?;
        let application = Arc::new(ScopeSnapshot::new_ready(
            identity.clone(),
            plan,
            RegistryHub::candidate(identity),
            CancellationToken::new(),
            ScopedTaskTracker::new(),
            Vec::new(),
            Arc::clone(&diagnostics),
        ));
        let scopes = ScopeManager::new(application, Arc::clone(&diagnostics), deadlines)?;
        Ok(Self {
            mode,
            scopes,
            diagnostics,
            deadlines,
        })
    }

    pub fn mode(&self) -> InternalExtensionRuntimeMode {
        self.mode
    }

    pub fn scopes(&self) -> &ScopeManager {
        &self.scopes
    }

    pub async fn build_empty_project_candidate(
        &self,
        scope_id: ScopeId,
    ) -> Result<Arc<ScopeSnapshot>, CandidateBuildError> {
        self.build_project_candidate(scope_id, Vec::new(), Arc::new(RejectingBrokerFacade))
            .await
    }

    pub async fn build_project_candidate(
        &self,
        scope_id: ScopeId,
        plugins: Vec<Arc<dyn InternalPlugin>>,
        broker: Arc<dyn BrokerFacade>,
    ) -> Result<Arc<ScopeSnapshot>, CandidateBuildError> {
        let application = self.scopes.application();
        let identity = self
            .scopes
            .next_identity(
                ScopePolicy::project_kind(),
                scope_id,
                Some(application.as_ref()),
            )
            .map_err(|error| CandidateBuildError::Resolution(Box::new(error)))?;
        build_scope_candidate(
            identity,
            Some(application.plan()),
            plugins,
            broker,
            Arc::clone(&self.diagnostics),
            self.deadlines,
        )
        .await
    }

    pub async fn rollback_candidate(&self, candidate: &Arc<ScopeSnapshot>) -> ScopeDisposeReport {
        candidate.quiesce_and_dispose(self.deadlines).await
    }

    pub async fn publish_project_candidate(
        &self,
        expected: Option<Arc<ScopeSnapshot>>,
        candidate: Arc<ScopeSnapshot>,
    ) -> Result<PublishReport, CandidatePublishError> {
        self.scopes.publish_project(expected, candidate).await
    }

    pub async fn shutdown(&self) -> ScopeDisposeReport {
        self.scopes.shutdown().await
    }
}
