use std::collections::BTreeMap;
use std::sync::{Mutex as StdMutex, MutexGuard};

use anyhow::{Context, Result, anyhow, ensure};
use rho_extension_runtime::{
    PLUGIN_SURFACE_EVENT_CONTRACT, PluginCommandResultV1, QueuedSurfaceEventV1, SurfaceDocumentV1,
    SurfaceEventAdmissionV1, SurfaceEventKindV1, SurfaceEventQueueV1, SurfaceEventV1,
    SurfacePluginRouteV1,
};
use rho_ui_contract::{
    PackageDigest, PluginId, SurfaceInstanceId, SurfaceInstanceRequestV1, SurfaceLifecycleStateV1,
    SurfaceOriginV1, Validate,
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tauri::{AppHandle, Emitter, State};
use uuid::Uuid;

use crate::workspace_plugins::{
    PluginRuntimeContext, WorkspaceSurfaceInvocationRoute, run_store_service,
    validate_surface_artifacts, validate_surface_command_result,
};
use crate::{AppState, display_error};

pub(crate) const PLUGIN_SURFACE_CHANGED_EVENT: &str = "rho://plugin-surface-changed";
const MAX_CACHED_SURFACE_DOCUMENTS: usize = 16;
const MAX_CACHED_SURFACE_PAYLOAD_BYTES: usize = 8 * 1024 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub(crate) struct PluginSurfaceDocumentRequest {
    pub target: SurfaceInstanceRequestV1,
    #[specta(type = Option<rho_ui_contract::UiIpcNumber>)]
    pub expected_layout_revision: Option<u64>,
    #[specta(type = Option<rho_ui_contract::UiIpcNumber>)]
    pub expected_page_revision: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(untagged)]
enum PluginSurfaceJsonValue {
    Null(()),
    Boolean(bool),
    Number(f64),
    String(String),
    Array(Vec<PluginSurfaceJsonValue>),
    Object(BTreeMap<String, PluginSurfaceJsonValue>),
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub(crate) struct PluginSurfaceEventRequest {
    pub target: SurfaceInstanceRequestV1,
    #[specta(type = rho_ui_contract::UiIpcNumber)]
    pub expected_document_revision: u64,
    #[specta(type = Option<rho_ui_contract::UiIpcNumber>)]
    pub expected_layout_revision: Option<u64>,
    #[specta(type = Option<rho_ui_contract::UiIpcNumber>)]
    pub expected_page_revision: Option<u64>,
    pub control_id: String,
    pub event_kind: SurfaceEventKindV1,
    #[specta(type = PluginSurfaceJsonValue)]
    pub value: Value,
}

#[derive(Debug, Clone, Serialize, specta::Type)]
pub(crate) struct PluginSurfaceDocumentView {
    pub project_id: rho_ui_contract::ProjectId,
    pub instance_id: SurfaceInstanceId,
    pub surface_id: rho_ui_contract::SurfaceId,
    #[specta(type = rho_ui_contract::UiIpcNumber)]
    pub surface_revision: u64,
    pub document: SurfaceDocumentV1,
    #[specta(type = PluginSurfaceJsonValue)]
    pub provenance: Value,
}

#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub(crate) enum PluginSurfaceEventStatus {
    Completed,
    Queued,
}

#[derive(Debug, Clone, Serialize, specta::Type)]
pub(crate) struct PluginSurfaceEventResult {
    pub event_id: String,
    pub status: PluginSurfaceEventStatus,
    pub document: Option<SurfaceDocumentV1>,
    pub command_result: Option<PluginCommandResultV1>,
    #[specta(type = Option<PluginSurfaceJsonValue>)]
    pub provenance: Option<Value>,
}

#[derive(Debug, Clone)]
struct CachedSurfaceDocument {
    route: SurfacePluginRouteV1,
    surface_revision: u64,
    project_revision: u64,
    layout_revision: Option<u64>,
    page_revision: Option<u64>,
    document: SurfaceDocumentV1,
    provenance: Value,
    encoded_bytes: usize,
    last_access: u64,
}

#[derive(Default)]
struct PluginSurfaceInner {
    documents: BTreeMap<SurfaceInstanceId, CachedSurfaceDocument>,
    queues: BTreeMap<String, SurfaceEventQueueV1>,
    access_clock: u64,
}

impl PluginSurfaceInner {
    fn next_access(&mut self) -> u64 {
        self.access_clock = self.access_clock.saturating_add(1);
        self.access_clock
    }

    fn cached_payload_bytes(&self) -> usize {
        self.documents
            .values()
            .map(|cached| cached.encoded_bytes)
            .sum()
    }

    fn reclaim_cached_payloads(&mut self, preserve: Option<&SurfaceInstanceId>) {
        while self.documents.len() > MAX_CACHED_SURFACE_DOCUMENTS
            || self.cached_payload_bytes() > MAX_CACHED_SURFACE_PAYLOAD_BYTES
        {
            let candidate = self
                .documents
                .iter()
                .filter(|(instance_id, _)| preserve != Some(*instance_id))
                .min_by_key(|(_, cached)| cached.last_access)
                .map(|(instance_id, _)| instance_id.clone());
            let Some(candidate) = candidate else { break };
            self.documents.remove(&candidate);
        }
    }
}

#[derive(Default)]
pub(crate) struct PluginSurfaceRuntimeState {
    inner: StdMutex<PluginSurfaceInner>,
}

impl PluginSurfaceRuntimeState {
    fn inner(&self) -> MutexGuard<'_, PluginSurfaceInner> {
        self.inner
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    pub(crate) fn retain_project(&self, project_id: &rho_ui_contract::ProjectId) {
        let mut inner = self.inner();
        inner
            .documents
            .retain(|_, cached| &cached.route.project_id == project_id);
        inner
            .queues
            .retain(|_, queue| &queue.route().project_id == project_id);
    }

    pub(crate) fn release_instance_payload(&self, instance_id: &SurfaceInstanceId) {
        let mut inner = self.inner();
        inner.documents.remove(instance_id);
        for queue in inner.queues.values_mut() {
            queue.cancel_instance(instance_id);
        }
        inner
            .queues
            .retain(|_, queue| queue.active().is_some() || queue.queued_len() > 0);
    }

    fn retain_exact_plugin_route(&self, route: &SurfacePluginRouteV1) {
        let mut inner = self.inner();
        inner.documents.retain(|_, cached| {
            cached.route.project_id != route.project_id
                || cached.route.plugin_id != route.plugin_id
                || cached.route == *route
        });
        inner.queues.retain(|_, queue| {
            queue.route().project_id != route.project_id
                || queue.route().plugin_id != route.plugin_id
                || queue.route() == route
        });
    }
}

fn validate_placement(
    expected_layout_revision: Option<u64>,
    expected_page_revision: Option<u64>,
) -> Result<()> {
    ensure!(
        expected_layout_revision.is_some() != expected_page_revision.is_some(),
        "workspace Surface request must target exactly one Studio or Vibe placement"
    );
    ensure!(
        expected_layout_revision != Some(0) && expected_page_revision != Some(0),
        "workspace Surface placement revision must be positive"
    );
    Ok(())
}

fn plugin_route(
    instance: &rho_ui_contract::SurfaceInstanceV1,
    route: &WorkspaceSurfaceInvocationRoute,
) -> Result<SurfacePluginRouteV1> {
    let SurfaceOriginV1::WorkspacePlugin {
        plugin_id,
        package_digest,
    } = &instance.origin
    else {
        return Err(anyhow!(
            "Surface instance is not owned by a workspace plugin"
        ));
    };
    ensure!(
        plugin_id.as_str() == route.plugin_id
            && package_digest.as_str() == route.package_digest
            && instance.activation_generation == route.activation_generation,
        "workspace Surface instance route is stale"
    );
    Ok(SurfacePluginRouteV1 {
        project_id: instance.project_id.clone(),
        plugin_id: PluginId::new(route.plugin_id.clone())?,
        package_digest: PackageDigest::new(route.package_digest.clone())?,
        activation_generation: route.activation_generation,
        host_instance_id: route.host_instance_id.clone(),
    })
}

fn route_key(route: &SurfacePluginRouteV1) -> String {
    format!(
        "{}\0{}\0{}\0{}\0{}",
        route.project_id,
        route.plugin_id,
        route.package_digest,
        route.activation_generation,
        route.host_instance_id
    )
}

fn render_input(instance: &rho_ui_contract::SurfaceInstanceV1) -> Value {
    let mut input = serde_json::Map::from_iter([
        ("operation".to_string(), json!("render")),
        ("project_id".to_string(), json!(instance.project_id)),
        ("instance_id".to_string(), json!(instance.instance_id)),
        ("surface_id".to_string(), json!(instance.surface_id)),
        (
            "surface_revision".to_string(),
            json!(instance.surface_revision),
        ),
        (
            "activation_generation".to_string(),
            json!(instance.activation_generation),
        ),
        ("view_state".to_string(), instance.view_state.clone()),
    ]);
    if let Some(mode_id) = &instance.mode_id {
        input.insert("mode_id".to_string(), json!(mode_id));
    }
    if let Some(binding) = &instance.resource_binding {
        input.insert("resource_binding".to_string(), json!(binding));
    }
    if let Some(binding) = &instance.runtime_binding {
        input.insert("runtime_binding".to_string(), json!(binding));
    }
    Value::Object(input)
}

fn event_input(event: &SurfaceEventV1) -> Value {
    let mut event = serde_json::to_value(event).expect("validated Surface event must serialize");
    if let Some(object) = event.as_object_mut() {
        object.retain(|_, value| !value.is_null());
    }
    json!({"operation": "event", "event": event})
}

fn declared_event_payload(event: &SurfaceEventV1) -> Value {
    json!({
        "control_id": event.control_id,
        "event_kind": event.event_kind,
        "value": event.value,
    })
}

fn completed_payload(outcome: &Value) -> Result<(&Value, Value)> {
    ensure!(
        outcome.get("status").and_then(Value::as_str) == Some("completed"),
        "workspace Surface returned a failed terminal result"
    );
    let result = outcome
        .get("result")
        .context("workspace Surface result is missing")?;
    let provenance = outcome.get("provenance").cloned().unwrap_or(Value::Null);
    Ok((result, provenance))
}

fn validate_cached_request(
    cached: &CachedSurfaceDocument,
    route: &SurfacePluginRouteV1,
    target: &SurfaceInstanceRequestV1,
    layout_revision: Option<u64>,
    page_revision: Option<u64>,
) -> Result<()> {
    ensure!(
        &cached.route == route
            && cached.project_revision == target.expected_project_revision
            && cached.surface_revision == target.expected_surface_revision
            && cached.layout_revision == layout_revision
            && cached.page_revision == page_revision,
        "workspace Surface document route is stale"
    );
    Ok(())
}

async fn current_context_and_instance(
    state: &AppState,
    target: &SurfaceInstanceRequestV1,
    expected_layout_revision: Option<u64>,
    expected_page_revision: Option<u64>,
) -> Result<(PluginRuntimeContext, rho_ui_contract::SurfaceInstanceV1)> {
    target.validate()?;
    let reconciled = crate::surface_runtime::reconcile_for_state(state).await?;
    let instance = state.surface_runtime.exact_instance(target)?;
    ensure!(
        instance.lifecycle_state == SurfaceLifecycleStateV1::Active,
        "workspace Surface instance is unavailable"
    );
    ensure!(
        reconciled.snapshot.project_revision == target.expected_project_revision,
        "workspace Surface project revision is stale"
    );
    if let Some(expected_layout_revision) = expected_layout_revision {
        let studio =
            crate::studio_runtime::reconcile_with_surface_snapshot(state, &reconciled.snapshot)?;
        ensure!(
            studio.snapshot.scene.layout_revision == expected_layout_revision,
            "workspace Surface Studio placement revision is stale"
        );
        let mut placed = std::collections::BTreeSet::new();
        rho_ui_contract::collect_scene_instance_ids(&studio.snapshot.scene, &mut placed);
        ensure!(
            placed.contains(instance.instance_id.as_str()),
            "workspace Surface instance is not placed in the active Studio Scene"
        );
    }
    if let Some(expected_page_revision) = expected_page_revision {
        let profile = state.ui_profile.snapshot()?;
        let page = profile
            .profile
            .active_page()
            .context("workspace Surface has no active Vibe Page")?;
        ensure!(
            page.page_revision == expected_page_revision,
            "workspace Surface Vibe placement revision is stale"
        );
        let placed = page
            .sections
            .iter()
            .flat_map(|section| &section.blocks)
            .any(|block| {
                matches!(
                    &block.content,
                    rho_ui_contract::VibeBlockContentV1::SurfaceRef { instance_id, live: true }
                        if instance_id == &instance.instance_id
                )
            });
        ensure!(
            placed,
            "workspace Surface instance is not live in the active Vibe Page"
        );
    }
    let context = crate::commands::plugins::runtime_context(state).await?;
    Ok((context, instance))
}

fn parse_event_result(
    result: Value,
) -> Result<(Option<SurfaceDocumentV1>, Option<PluginCommandResultV1>)> {
    if result.get("contract").and_then(Value::as_str)
        == Some(rho_extension_runtime::PLUGIN_SURFACE_DOCUMENT_CONTRACT)
    {
        return Ok((Some(SurfaceDocumentV1::parse(result)?), None));
    }
    Ok((None, Some(PluginCommandResultV1::parse(result)?)))
}

#[cfg_attr(test, specta::specta)]
#[tauri::command]
pub(crate) async fn plugin_surface_document(
    request: PluginSurfaceDocumentRequest,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<PluginSurfaceDocumentView, String> {
    let _project_transition = state.project_transition_gate.lock().await;
    validate_placement(
        request.expected_layout_revision,
        request.expected_page_revision,
    )
    .map_err(display_error)?;
    let (context, instance) = current_context_and_instance(
        &state,
        &request.target,
        request.expected_layout_revision,
        request.expected_page_revision,
    )
    .await
    .map_err(display_error)?;
    let route = state
        .plugin_permissions
        .surface_route(&context, instance.surface_id.as_str())
        .and_then(|route| plugin_route(&instance, &route))
        .map_err(display_error)?;

    state
        .plugin_surface_runtime
        .retain_exact_plugin_route(&route);

    let cached = {
        let mut inner = state.plugin_surface_runtime.inner();
        let next_access = inner.next_access();
        let cached = inner.documents.get(&instance.instance_id).cloned();
        match cached {
            Some(cached)
                if validate_cached_request(
                    &cached,
                    &route,
                    &request.target,
                    request.expected_layout_revision,
                    request.expected_page_revision,
                )
                .is_ok() =>
            {
                if let Some(entry) = inner.documents.get_mut(&instance.instance_id) {
                    entry.last_access = next_access;
                }
                Some(cached)
            }
            Some(_) => {
                inner.documents.remove(&instance.instance_id);
                None
            }
            None => None,
        }
    };
    if let Some(cached) = cached {
        return Ok(PluginSurfaceDocumentView {
            project_id: instance.project_id,
            instance_id: instance.instance_id,
            surface_id: instance.surface_id,
            surface_revision: instance.surface_revision,
            document: cached.document,
            provenance: cached.provenance,
        });
    }

    let registry = state.plugin_permissions.clone();
    let service_context = context.clone();
    let contribution_id = instance.surface_id.as_str().to_string();
    let input = render_input(&instance);
    let (document, provenance) = run_store_service(
        crate::application_state::store_executor(&state)
            .await
            .map_err(display_error)?,
        move |store| {
            let outcome = registry.invoke_surface_contribution(
                &service_context,
                &contribution_id,
                input,
                store,
            )?;
            let (result, provenance) = completed_payload(&outcome)?;
            let document = SurfaceDocumentV1::parse(result.clone())?;
            validate_surface_artifacts(store, &service_context, &document)?;
            Ok((document, provenance))
        },
    )
    .await
    .map_err(display_error)?;
    let encoded_bytes = serde_json::to_vec(&(&document, &provenance))
        .map_err(display_error)?
        .len();
    {
        let mut inner = state.plugin_surface_runtime.inner();
        let last_access = inner.next_access();
        inner.documents.insert(
            instance.instance_id.clone(),
            CachedSurfaceDocument {
                route,
                surface_revision: instance.surface_revision,
                project_revision: request.target.expected_project_revision,
                layout_revision: request.expected_layout_revision,
                page_revision: request.expected_page_revision,
                document: document.clone(),
                provenance: provenance.clone(),
                encoded_bytes,
                last_access,
            },
        );
        inner.reclaim_cached_payloads(Some(&instance.instance_id));
    }
    let _ = app.emit(PLUGIN_SURFACE_CHANGED_EVENT, &instance.instance_id);
    Ok(PluginSurfaceDocumentView {
        project_id: instance.project_id,
        instance_id: instance.instance_id,
        surface_id: instance.surface_id,
        surface_revision: instance.surface_revision,
        document,
        provenance,
    })
}

async fn execute_event(
    state: &AppState,
    context: &PluginRuntimeContext,
    queued: &QueuedSurfaceEventV1,
) -> Result<(
    Option<SurfaceDocumentV1>,
    Option<PluginCommandResultV1>,
    Value,
)> {
    let registry = state.plugin_permissions.clone();
    let context = context.clone();
    let contribution_id = queued.event.surface_id.as_str().to_string();
    let input = event_input(&queued.event);
    run_store_service(
        crate::application_state::store_executor(state).await?,
        move |store| {
            let outcome =
                registry.invoke_surface_contribution(&context, &contribution_id, input, store)?;
            let (result, provenance) = completed_payload(&outcome)?;
            let (document, command_result) = parse_event_result(result.clone())?;
            if let Some(document) = &document {
                validate_surface_artifacts(store, &context, document)?;
            }
            if let Some(command_result) = &command_result {
                validate_surface_command_result(store, &context, command_result)?;
            }
            Ok((document, command_result, provenance))
        },
    )
    .await
}

#[cfg_attr(test, specta::specta)]
#[tauri::command]
pub(crate) async fn plugin_surface_event(
    request: PluginSurfaceEventRequest,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<PluginSurfaceEventResult, String> {
    let project_transition = state.project_transition_gate.lock().await;
    validate_placement(
        request.expected_layout_revision,
        request.expected_page_revision,
    )
    .map_err(display_error)?;
    let (context, instance) = current_context_and_instance(
        &state,
        &request.target,
        request.expected_layout_revision,
        request.expected_page_revision,
    )
    .await
    .map_err(display_error)?;
    let invocation_route = state
        .plugin_permissions
        .surface_route(&context, instance.surface_id.as_str())
        .map_err(display_error)?;
    let route = plugin_route(&instance, &invocation_route).map_err(display_error)?;
    let cached = state
        .plugin_surface_runtime
        .inner()
        .documents
        .get(&instance.instance_id)
        .cloned()
        .context("workspace Surface document has not been loaded")
        .map_err(display_error)?;
    validate_cached_request(
        &cached,
        &route,
        &request.target,
        request.expected_layout_revision,
        request.expected_page_revision,
    )
    .map_err(display_error)?;

    let event_id = format!("surface-event:{}", Uuid::new_v4().simple());
    let event = SurfaceEventV1 {
        contract: PLUGIN_SURFACE_EVENT_CONTRACT.to_string(),
        project_id: instance.project_id.clone(),
        plugin_id: route.plugin_id.clone(),
        package_digest: route.package_digest.clone(),
        activation_generation: route.activation_generation,
        host_instance_id: route.host_instance_id.clone(),
        surface_id: instance.surface_id.clone(),
        instance_id: instance.instance_id.clone(),
        expected_project_revision: request.target.expected_project_revision,
        expected_surface_revision: request.target.expected_surface_revision,
        expected_document_revision: request.expected_document_revision,
        expected_resource_revision: instance
            .resource_binding
            .as_ref()
            .and_then(|binding| binding.resource_revision),
        expected_runtime_generation: instance
            .runtime_binding
            .as_ref()
            .map(|binding| binding.activation_generation),
        expected_page_revision: request.expected_page_revision,
        expected_layout_revision: request.expected_layout_revision,
        control_id: request.control_id,
        event_kind: request.event_kind,
        value: request.value,
    };
    cached
        .document
        .validate_event(&event)
        .map_err(display_error)?;
    let queued = QueuedSurfaceEventV1 {
        event_id: event_id.clone(),
        event,
    };
    state
        .plugin_permissions
        .validate_surface_event(
            &context,
            instance.surface_id.as_str(),
            &declared_event_payload(&queued.event),
        )
        .map_err(display_error)?;
    let key = route_key(&route);
    let admission = {
        let mut inner = state.plugin_surface_runtime.inner();
        inner
            .queues
            .entry(key.clone())
            .or_insert(SurfaceEventQueueV1::new(route).map_err(display_error)?)
            .submit(queued)
            .map_err(display_error)?
    };
    if matches!(admission, SurfaceEventAdmissionV1::Queued { .. }) {
        drop(project_transition);
        return Ok(PluginSurfaceEventResult {
            event_id,
            status: PluginSurfaceEventStatus::Queued,
            document: None,
            command_result: None,
            provenance: None,
        });
    }
    drop(project_transition);

    let mut first_result = None;
    loop {
        let active = {
            let inner = state.plugin_surface_runtime.inner();
            inner
                .queues
                .get(&key)
                .and_then(|queue| queue.active().cloned())
        };
        let Some(active) = active else { break };
        let result = execute_event(&state, &context, &active).await;
        if let Ok((document, command_result, provenance)) = &result {
            if let Some(document) = document {
                let encoded_bytes = serde_json::to_vec(&(document, provenance))
                    .map_err(display_error)?
                    .len();
                let mut inner = state.plugin_surface_runtime.inner();
                let last_access = inner.next_access();
                if let Some(cached) = inner.documents.get_mut(&active.event.instance_id)
                    && cached.route.matches(&active.event)
                    && cached.document.revision == active.event.expected_document_revision
                {
                    cached.document = document.clone();
                    cached.provenance = provenance.clone();
                    cached.encoded_bytes = encoded_bytes;
                    cached.last_access = last_access;
                }
                inner.reclaim_cached_payloads(Some(&active.event.instance_id));
            }
            if active.event_id == event_id {
                first_result = Some((document.clone(), command_result.clone(), provenance.clone()));
            }
        }
        {
            let mut inner = state.plugin_surface_runtime.inner();
            if let Some(queue) = inner.queues.get_mut(&key) {
                let _ = queue.finish_active(&active.event_id);
            }
        }
        let _ = app.emit(PLUGIN_SURFACE_CHANGED_EVENT, &active.event.instance_id);
        if active.event_id == event_id
            && let Err(error) = result
        {
            return Err(display_error(error));
        }
    }
    let (document, command_result, provenance) = first_result
        .context("workspace Surface event did not complete")
        .map_err(display_error)?;
    Ok(PluginSurfaceEventResult {
        event_id,
        status: PluginSurfaceEventStatus::Completed,
        document,
        command_result,
        provenance: Some(provenance),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cached_document(
        route: SurfacePluginRouteV1,
        access: u64,
        encoded_bytes: usize,
    ) -> CachedSurfaceDocument {
        CachedSurfaceDocument {
            route,
            surface_revision: 1,
            project_revision: 1,
            layout_revision: Some(1),
            page_revision: None,
            document: SurfaceDocumentV1::parse(json!({
                "contract": "rho.plugin_surface_document.v1",
                "revision": 1,
                "title": "cached",
                "blocks": []
            }))
            .unwrap(),
            provenance: Value::Null,
            encoded_bytes,
            last_access: access,
        }
    }

    fn queued_event(
        event_id: &str,
        instance_id: SurfaceInstanceId,
        route: &SurfacePluginRouteV1,
    ) -> QueuedSurfaceEventV1 {
        QueuedSurfaceEventV1 {
            event_id: event_id.to_string(),
            event: SurfaceEventV1 {
                contract: PLUGIN_SURFACE_EVENT_CONTRACT.to_string(),
                project_id: route.project_id.clone(),
                plugin_id: route.plugin_id.clone(),
                package_digest: route.package_digest.clone(),
                activation_generation: route.activation_generation,
                host_instance_id: route.host_instance_id.clone(),
                surface_id: rho_ui_contract::SurfaceId::new("ui.surface.analysis").unwrap(),
                instance_id,
                expected_project_revision: 1,
                expected_surface_revision: 1,
                expected_document_revision: 1,
                expected_resource_revision: None,
                expected_runtime_generation: None,
                expected_page_revision: None,
                expected_layout_revision: Some(1),
                control_id: "refresh".to_string(),
                event_kind: SurfaceEventKindV1::Activate,
                value: Value::Null,
            },
        }
    }

    fn test_route(
        project_id: &str,
        plugin_id: &str,
        digest_byte: char,
        generation: u64,
    ) -> SurfacePluginRouteV1 {
        SurfacePluginRouteV1 {
            project_id: rho_ui_contract::ProjectId::new(project_id).unwrap(),
            plugin_id: PluginId::new(plugin_id).unwrap(),
            package_digest: PackageDigest::new(digest_byte.to_string().repeat(64)).unwrap(),
            activation_generation: generation,
            host_instance_id: format!("host.{plugin_id}.{generation}"),
        }
    }

    #[test]
    fn placement_requires_one_exact_owner_revision() {
        assert!(validate_placement(Some(1), None).is_ok());
        assert!(validate_placement(None, Some(1)).is_ok());
        assert!(validate_placement(None, None).is_err());
        assert!(validate_placement(Some(1), Some(1)).is_err());
        assert!(validate_placement(Some(0), None).is_err());
    }

    #[test]
    fn exact_plugin_route_replaces_only_stale_state_for_that_project_plugin() {
        let state = PluginSurfaceRuntimeState::default();
        let target = test_route("project.a", "org.example.surface", 'a', 2);
        let stale = test_route("project.a", "org.example.surface", 'b', 1);
        let other_plugin = test_route("project.a", "org.example.other", 'c', 1);
        let other_project = test_route("project.b", "org.example.surface", 'd', 1);
        {
            let mut inner = state.inner();
            for route in [&target, &stale, &other_plugin, &other_project] {
                inner.queues.insert(
                    route_key(route),
                    SurfaceEventQueueV1::new(route.clone()).unwrap(),
                );
            }
        }

        state.retain_exact_plugin_route(&target);

        let inner = state.inner();
        assert_eq!(inner.queues.len(), 3);
        assert!(inner.queues.contains_key(&route_key(&target)));
        assert!(!inner.queues.contains_key(&route_key(&stale)));
        assert!(inner.queues.contains_key(&route_key(&other_plugin)));
        assert!(inner.queues.contains_key(&route_key(&other_project)));
    }

    #[test]
    fn cached_documents_reclaim_lru_by_entry_and_byte_budget() {
        let route = test_route("project.a", "org.example.surface", 'a', 2);
        let mut inner = PluginSurfaceInner::default();
        for index in 0..(MAX_CACHED_SURFACE_DOCUMENTS + 4) {
            let id = SurfaceInstanceId::new(format!("surface-instance:cache-{index}")).unwrap();
            inner
                .documents
                .insert(id, cached_document(route.clone(), index as u64 + 1, 64));
        }
        let preserved = SurfaceInstanceId::new(format!(
            "surface-instance:cache-{}",
            MAX_CACHED_SURFACE_DOCUMENTS + 3
        ))
        .unwrap();
        inner.reclaim_cached_payloads(Some(&preserved));
        assert_eq!(inner.documents.len(), MAX_CACHED_SURFACE_DOCUMENTS);
        assert!(
            !inner
                .documents
                .contains_key(&SurfaceInstanceId::new("surface-instance:cache-0").unwrap())
        );
        assert!(inner.documents.contains_key(&preserved));

        inner.documents.clear();
        for index in 0..3 {
            inner.documents.insert(
                SurfaceInstanceId::new(format!("surface-instance:bytes-{index}")).unwrap(),
                cached_document(
                    route.clone(),
                    index as u64 + 1,
                    MAX_CACHED_SURFACE_PAYLOAD_BYTES / 2,
                ),
            );
        }
        let preserved = SurfaceInstanceId::new("surface-instance:bytes-2").unwrap();
        inner.reclaim_cached_payloads(Some(&preserved));
        assert_eq!(inner.documents.len(), 2);
        assert!(inner.cached_payload_bytes() <= MAX_CACHED_SURFACE_PAYLOAD_BYTES);
        assert!(inner.documents.contains_key(&preserved));
    }

    #[test]
    fn releasing_one_instance_drops_only_its_derived_payload() {
        let state = PluginSurfaceRuntimeState::default();
        let route = test_route("project.a", "org.example.surface", 'a', 2);
        let key = route_key(&route);
        let released = SurfaceInstanceId::new("surface-instance:released").unwrap();
        let retained = SurfaceInstanceId::new("surface-instance:retained").unwrap();
        {
            let mut inner = state.inner();
            inner
                .documents
                .insert(released.clone(), cached_document(route.clone(), 1, 64));
            inner
                .documents
                .insert(retained.clone(), cached_document(route.clone(), 2, 64));
            let mut queue = SurfaceEventQueueV1::new(route).unwrap();
            queue
                .submit(queued_event(
                    "event:released",
                    released.clone(),
                    queue.route(),
                ))
                .unwrap();
            queue
                .submit(queued_event(
                    "event:retained",
                    retained.clone(),
                    queue.route(),
                ))
                .unwrap();
            inner.queues.insert(key.clone(), queue);
        }
        state.release_instance_payload(&released);
        let inner = state.inner();
        assert!(!inner.documents.contains_key(&released));
        assert!(inner.documents.contains_key(&retained));
        assert_eq!(
            inner.queues[&key]
                .active()
                .map(|event| &event.event.instance_id),
            Some(&retained)
        );
    }

    #[test]
    fn plugin_surface_ipc_serialization_matches_generated_contract() {
        let target = SurfaceInstanceRequestV1 {
            project_id: rho_ui_contract::ProjectId::new("project:fixture").unwrap(),
            instance_id: SurfaceInstanceId::new("surface-instance:fixture").unwrap(),
            activation_generation: 3,
            expected_project_revision: 5,
            expected_surface_revision: 7,
        };
        let document = SurfaceDocumentV1 {
            contract: rho_extension_runtime::PLUGIN_SURFACE_DOCUMENT_CONTRACT.to_string(),
            revision: 11,
            title: "Fixture Surface".to_string(),
            blocks: vec![rho_extension_runtime::SurfaceBlockV1::Column {
                blocks: vec![
                    rho_extension_runtime::SurfaceBlockV1::Notice {
                        tone: rho_extension_runtime::SurfaceNoticeToneV1::Info,
                        text: "Bounded fixture".to_string(),
                    },
                    rho_extension_runtime::SurfaceBlockV1::CommandButton {
                        control_id: "apply".to_string(),
                        label: "Apply".to_string(),
                        command_id: "analysis.apply".to_string(),
                        disabled: false,
                        busy: false,
                    },
                ],
            }],
        };
        let document_request = PluginSurfaceDocumentRequest {
            target: target.clone(),
            expected_layout_revision: Some(13),
            expected_page_revision: None,
        };
        let event_request = PluginSurfaceEventRequest {
            target,
            expected_document_revision: 11,
            expected_layout_revision: Some(13),
            expected_page_revision: None,
            control_id: "apply".to_string(),
            event_kind: SurfaceEventKindV1::Activate,
            value: json!({"nested": [true, null, 3.5]}),
        };
        let view = PluginSurfaceDocumentView {
            project_id: rho_ui_contract::ProjectId::new("project:fixture").unwrap(),
            instance_id: SurfaceInstanceId::new("surface-instance:fixture").unwrap(),
            surface_id: rho_ui_contract::SurfaceId::new("ui.surface.fixture").unwrap(),
            surface_revision: 7,
            document: document.clone(),
            provenance: json!({"origin": "trusted_surface"}),
        };
        let result = PluginSurfaceEventResult {
            event_id: "surface-event:fixture".to_string(),
            status: PluginSurfaceEventStatus::Completed,
            document: Some(document),
            command_result: Some(PluginCommandResultV1::Notification {
                message: "Applied".to_string(),
            }),
            provenance: Some(json!({"generation": 3})),
        };

        let document_request = serde_json::to_value(document_request).unwrap();
        let event_request = serde_json::to_value(event_request).unwrap();
        let view = serde_json::to_value(view).unwrap();
        let result = serde_json::to_value(result).unwrap();
        assert_eq!(document_request["expected_layout_revision"], 13);
        assert!(document_request["expected_page_revision"].is_null());
        assert_eq!(event_request["event_kind"], "activate");
        assert_eq!(event_request["value"]["nested"][0], true);
        assert_eq!(view["document"]["blocks"][0]["kind"], "column");
        assert_eq!(view["document"]["blocks"][0]["blocks"][0]["tone"], "info");
        assert_eq!(result["status"], "completed");
        assert_eq!(result["command_result"]["kind"], "notification");
        assert_eq!(result["provenance"]["generation"], 3);
    }

    #[test]
    #[ignore = "writes the requested generated TypeScript contract"]
    fn plugin_surface_typescript_export() {
        let output_path = std::env::var_os("RHO_PLUGIN_SURFACE_BINDINGS_PATH")
            .expect("RHO_PLUGIN_SURFACE_BINDINGS_PATH must name the generated file");
        tauri_specta::Builder::<tauri::Wry>::new()
            .commands(tauri_specta::collect_commands![
                super::plugin_surface_document,
                super::plugin_surface_event,
            ])
            .error_handling(tauri_specta::ErrorHandlingMode::Throw)
            .export(specta_typescript::Typescript::default(), output_path)
            .expect("Plugin Surface TypeScript export must succeed");
    }
}
