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
    PluginRuntimeContext, WorkspaceSurfaceInvocationRoute, validate_surface_artifacts,
    validate_surface_command_result,
};
use crate::{AppState, display_error, read_store};

pub(crate) const PLUGIN_SURFACE_CHANGED_EVENT: &str = "rho://plugin-surface-changed";

#[derive(Debug, Clone, Deserialize)]
pub(crate) struct PluginSurfaceDocumentRequest {
    pub target: SurfaceInstanceRequestV1,
    pub expected_layout_revision: Option<u64>,
    pub expected_page_revision: Option<u64>,
}

#[derive(Debug, Clone, Deserialize)]
pub(crate) struct PluginSurfaceEventRequest {
    pub target: SurfaceInstanceRequestV1,
    pub expected_document_revision: u64,
    pub expected_layout_revision: Option<u64>,
    pub expected_page_revision: Option<u64>,
    pub control_id: String,
    pub event_kind: SurfaceEventKindV1,
    pub value: Value,
}

#[derive(Debug, Clone, Serialize)]
pub(crate) struct PluginSurfaceDocumentView {
    pub project_id: rho_ui_contract::ProjectId,
    pub instance_id: SurfaceInstanceId,
    pub surface_id: rho_ui_contract::SurfaceId,
    pub surface_revision: u64,
    pub document: SurfaceDocumentV1,
    pub provenance: Value,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum PluginSurfaceEventStatus {
    Completed,
    Queued,
}

#[derive(Debug, Clone, Serialize)]
pub(crate) struct PluginSurfaceEventResult {
    pub event_id: String,
    pub status: PluginSurfaceEventStatus,
    pub document: Option<SurfaceDocumentV1>,
    pub command_result: Option<PluginCommandResultV1>,
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
}

#[derive(Default)]
struct PluginSurfaceInner {
    documents: BTreeMap<SurfaceInstanceId, CachedSurfaceDocument>,
    queues: BTreeMap<String, SurfaceEventQueueV1>,
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

    if let Some(cached) = state
        .plugin_surface_runtime
        .inner()
        .documents
        .get(&instance.instance_id)
        .cloned()
    {
        if validate_cached_request(
            &cached,
            &route,
            &request.target,
            request.expected_layout_revision,
            request.expected_page_revision,
        )
        .is_ok()
        {
            return Ok(PluginSurfaceDocumentView {
                project_id: instance.project_id,
                instance_id: instance.instance_id,
                surface_id: instance.surface_id,
                surface_revision: instance.surface_revision,
                document: cached.document,
                provenance: cached.provenance,
            });
        }
        state
            .plugin_surface_runtime
            .inner()
            .documents
            .remove(&instance.instance_id);
    }

    let mut store = read_store(&state).map_err(display_error)?;
    let outcome = state
        .plugin_permissions
        .invoke_surface_contribution(
            &context,
            instance.surface_id.as_str(),
            render_input(&instance),
            &mut store,
        )
        .map_err(display_error)?;
    let (result, provenance) = completed_payload(&outcome).map_err(display_error)?;
    let document = SurfaceDocumentV1::parse(result.clone()).map_err(display_error)?;
    validate_surface_artifacts(&store, &context, &document).map_err(display_error)?;
    state.plugin_surface_runtime.inner().documents.insert(
        instance.instance_id.clone(),
        CachedSurfaceDocument {
            route,
            surface_revision: instance.surface_revision,
            project_revision: request.target.expected_project_revision,
            layout_revision: request.expected_layout_revision,
            page_revision: request.expected_page_revision,
            document: document.clone(),
            provenance: provenance.clone(),
        },
    );
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

fn execute_event(
    state: &AppState,
    context: &PluginRuntimeContext,
    queued: &QueuedSurfaceEventV1,
) -> Result<(
    Option<SurfaceDocumentV1>,
    Option<PluginCommandResultV1>,
    Value,
)> {
    let mut store = read_store(state)?;
    let outcome = state.plugin_permissions.invoke_surface_contribution(
        context,
        queued.event.surface_id.as_str(),
        event_input(&queued.event),
        &mut store,
    )?;
    let (result, provenance) = completed_payload(&outcome)?;
    let (document, command_result) = parse_event_result(result.clone())?;
    if let Some(document) = &document {
        validate_surface_artifacts(&store, context, document)?;
    }
    if let Some(command_result) = &command_result {
        validate_surface_command_result(&store, context, command_result)?;
    }
    Ok((document, command_result, provenance))
}

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
        let result = execute_event(&state, &context, &active);
        if let Ok((document, command_result, provenance)) = &result {
            if let Some(document) = document {
                let mut inner = state.plugin_surface_runtime.inner();
                if let Some(cached) = inner.documents.get_mut(&active.event.instance_id)
                    && cached.route.matches(&active.event)
                    && cached.document.revision == active.event.expected_document_revision
                {
                    cached.document = document.clone();
                    cached.provenance = provenance.clone();
                }
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
        if result.is_err() && active.event_id == event_id {
            return Err(display_error(result.unwrap_err()));
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
}
