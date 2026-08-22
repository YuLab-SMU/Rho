//! Bounded, fair admission for workspace-plugin Surface events.
//!
//! A plugin host may execute only one guest contribution call at a time. This
//! queue prevents one repeated Surface instance from monopolising that lane
//! while keeping every queued event bound to the exact plugin route that was
//! live when the event was admitted.

use std::collections::{BTreeMap, VecDeque};

use rho_ui_contract::{PackageDigest, PluginId, ProjectId, SurfaceInstanceId};
use serde::{Deserialize, Serialize};
use thiserror::Error;

use crate::{SurfaceDocumentError, SurfaceEventV1};

pub const MAX_SURFACE_EVENTS_PER_PLUGIN: usize = 64;
pub const MAX_SURFACE_EVENTS_PER_INSTANCE: usize = 8;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SurfacePluginRouteV1 {
    pub project_id: ProjectId,
    pub plugin_id: PluginId,
    pub package_digest: PackageDigest,
    pub activation_generation: u64,
    pub host_instance_id: String,
}

impl SurfacePluginRouteV1 {
    pub fn matches(&self, event: &SurfaceEventV1) -> bool {
        self.project_id == event.project_id
            && self.plugin_id == event.plugin_id
            && self.package_digest == event.package_digest
            && self.activation_generation == event.activation_generation
            && self.host_instance_id == event.host_instance_id
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct QueuedSurfaceEventV1 {
    pub event_id: String,
    pub event: SurfaceEventV1,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SurfaceEventAdmissionV1 {
    Started,
    Queued { position: usize },
}

#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum SurfaceEventQueueError {
    #[error("surface event is invalid")]
    Invalid,
    #[error("surface event belongs to a stale plugin route")]
    StaleRoute,
    #[error("surface event id is already active or queued")]
    Duplicate,
    #[error("surface event queue is full")]
    PluginQueueFull,
    #[error("surface instance event queue is full")]
    InstanceQueueFull,
    #[error("the completed event is not the active event")]
    NotActive,
}

#[derive(Debug)]
pub struct SurfaceEventQueueV1 {
    route: SurfacePluginRouteV1,
    active: Option<QueuedSurfaceEventV1>,
    pending: BTreeMap<SurfaceInstanceId, VecDeque<QueuedSurfaceEventV1>>,
    rotation: VecDeque<SurfaceInstanceId>,
    queued: usize,
    last_served: Option<SurfaceInstanceId>,
}

impl SurfaceEventQueueV1 {
    pub fn new(route: SurfacePluginRouteV1) -> Result<Self, SurfaceEventQueueError> {
        if route.activation_generation == 0
            || route.host_instance_id.is_empty()
            || route.host_instance_id.len() > 128
        {
            return Err(SurfaceEventQueueError::Invalid);
        }
        Ok(Self {
            route,
            active: None,
            pending: BTreeMap::new(),
            rotation: VecDeque::new(),
            queued: 0,
            last_served: None,
        })
    }

    pub fn route(&self) -> &SurfacePluginRouteV1 {
        &self.route
    }

    pub fn active(&self) -> Option<&QueuedSurfaceEventV1> {
        self.active.as_ref()
    }

    pub fn queued_len(&self) -> usize {
        self.queued
    }

    pub fn submit(
        &mut self,
        queued_event: QueuedSurfaceEventV1,
    ) -> Result<SurfaceEventAdmissionV1, SurfaceEventQueueError> {
        validate_event_id(&queued_event.event_id)?;
        queued_event.event.validate().map_err(map_document_error)?;
        if !self.route.matches(&queued_event.event) {
            return Err(SurfaceEventQueueError::StaleRoute);
        }
        if self.contains_event_id(&queued_event.event_id) {
            return Err(SurfaceEventQueueError::Duplicate);
        }
        if self.active.is_none() {
            self.last_served = Some(queued_event.event.instance_id.clone());
            self.active = Some(queued_event);
            return Ok(SurfaceEventAdmissionV1::Started);
        }
        if self.queued >= MAX_SURFACE_EVENTS_PER_PLUGIN {
            return Err(SurfaceEventQueueError::PluginQueueFull);
        }

        let instance_id = queued_event.event.instance_id.clone();
        let queue = self.pending.entry(instance_id.clone()).or_default();
        if queue.len() >= MAX_SURFACE_EVENTS_PER_INSTANCE {
            return Err(SurfaceEventQueueError::InstanceQueueFull);
        }
        if queue.is_empty() {
            self.rotation.push_back(instance_id);
        }
        queue.push_back(queued_event);
        self.queued += 1;
        Ok(SurfaceEventAdmissionV1::Queued {
            position: self.queued,
        })
    }

    pub fn finish_active(
        &mut self,
        event_id: &str,
    ) -> Result<Option<&QueuedSurfaceEventV1>, SurfaceEventQueueError> {
        if self.active.as_ref().map(|event| event.event_id.as_str()) != Some(event_id) {
            return Err(SurfaceEventQueueError::NotActive);
        }
        if let Some(active) = self.active.take() {
            self.last_served = Some(active.event.instance_id);
        }
        self.advance();
        Ok(self.active.as_ref())
    }

    pub fn cancel_event(
        &mut self,
        event_id: &str,
    ) -> Result<Option<&QueuedSurfaceEventV1>, SurfaceEventQueueError> {
        if self.active.as_ref().map(|event| event.event_id.as_str()) == Some(event_id) {
            if let Some(active) = self.active.take() {
                self.last_served = Some(active.event.instance_id);
            }
            self.advance();
            return Ok(self.active.as_ref());
        }

        for queue in self.pending.values_mut() {
            if let Some(index) = queue.iter().position(|event| event.event_id == event_id) {
                queue.remove(index);
                self.queued -= 1;
                self.remove_empty_instances();
                return Ok(self.active.as_ref());
            }
        }
        Err(SurfaceEventQueueError::NotActive)
    }

    pub fn cancel_instance(&mut self, instance_id: &SurfaceInstanceId) {
        if self
            .active
            .as_ref()
            .is_some_and(|event| &event.event.instance_id == instance_id)
        {
            self.active = None;
            self.last_served = Some(instance_id.clone());
        }
        if let Some(queue) = self.pending.remove(instance_id) {
            self.queued -= queue.len();
        }
        self.rotation.retain(|candidate| candidate != instance_id);
        if self.active.is_none() {
            self.advance();
        }
    }

    pub fn revoke(&mut self) {
        self.active = None;
        self.pending.clear();
        self.rotation.clear();
        self.queued = 0;
        self.last_served = None;
    }

    fn contains_event_id(&self, event_id: &str) -> bool {
        self.active
            .as_ref()
            .is_some_and(|event| event.event_id == event_id)
            || self
                .pending
                .values()
                .any(|queue| queue.iter().any(|event| event.event_id == event_id))
    }

    fn advance(&mut self) {
        if self.active.is_some() || self.queued == 0 {
            return;
        }
        let candidates = self.rotation.len();
        for attempt in 0..candidates {
            let Some(instance_id) = self.rotation.pop_front() else {
                break;
            };
            let is_last_served = self.last_served.as_ref() == Some(&instance_id);
            if is_last_served && candidates > 1 && attempt + 1 < candidates {
                self.rotation.push_back(instance_id);
                continue;
            }
            let Some(queue) = self.pending.get_mut(&instance_id) else {
                continue;
            };
            let Some(next) = queue.pop_front() else {
                self.pending.remove(&instance_id);
                continue;
            };
            self.queued -= 1;
            if queue.is_empty() {
                self.pending.remove(&instance_id);
            } else {
                self.rotation.push_back(instance_id);
            }
            self.active = Some(next);
            return;
        }

        // Only the previously served instance remains.
        if let Some(instance_id) = self.rotation.pop_front()
            && let Some(queue) = self.pending.get_mut(&instance_id)
            && let Some(next) = queue.pop_front()
        {
            self.queued -= 1;
            if queue.is_empty() {
                self.pending.remove(&instance_id);
            } else {
                self.rotation.push_back(instance_id);
            }
            self.active = Some(next);
        }
    }

    fn remove_empty_instances(&mut self) {
        self.pending.retain(|_, queue| !queue.is_empty());
        self.rotation
            .retain(|instance_id| self.pending.contains_key(instance_id));
    }
}

fn validate_event_id(event_id: &str) -> Result<(), SurfaceEventQueueError> {
    if event_id.is_empty()
        || event_id.len() > 128
        || !event_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b':' | b'_' | b'-'))
    {
        return Err(SurfaceEventQueueError::Invalid);
    }
    Ok(())
}

fn map_document_error(error: SurfaceDocumentError) -> SurfaceEventQueueError {
    match error {
        SurfaceDocumentError::StaleIdentity => SurfaceEventQueueError::StaleRoute,
        _ => SurfaceEventQueueError::Invalid,
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;
    use crate::{PLUGIN_SURFACE_EVENT_CONTRACT, SurfaceEventKindV1};

    fn route() -> SurfacePluginRouteV1 {
        SurfacePluginRouteV1 {
            project_id: ProjectId::new("project.fixture").unwrap(),
            plugin_id: PluginId::new("org.example.surface").unwrap(),
            package_digest: PackageDigest::new(format!("sha256:{}", "a".repeat(64))).unwrap(),
            activation_generation: 3,
            host_instance_id: "host.fixture".to_string(),
        }
    }

    fn event(event_id: &str, instance_id: &str) -> QueuedSurfaceEventV1 {
        let route = route();
        QueuedSurfaceEventV1 {
            event_id: event_id.to_string(),
            event: SurfaceEventV1 {
                contract: PLUGIN_SURFACE_EVENT_CONTRACT.to_string(),
                project_id: route.project_id,
                plugin_id: route.plugin_id,
                package_digest: route.package_digest,
                activation_generation: route.activation_generation,
                host_instance_id: route.host_instance_id,
                surface_id: rho_ui_contract::SurfaceId::new("ui.surface.analysis").unwrap(),
                instance_id: SurfaceInstanceId::new(instance_id).unwrap(),
                expected_project_revision: 1,
                expected_surface_revision: 1,
                expected_document_revision: 1,
                expected_resource_revision: None,
                expected_runtime_generation: None,
                expected_page_revision: None,
                expected_layout_revision: None,
                control_id: "run".to_string(),
                event_kind: SurfaceEventKindV1::Activate,
                value: json!(null),
            },
        }
    }

    #[test]
    fn admits_one_active_call_and_round_robins_repeated_instances() {
        let mut queue = SurfaceEventQueueV1::new(route()).unwrap();
        assert_eq!(
            queue.submit(event("a1", "instance.a")).unwrap(),
            SurfaceEventAdmissionV1::Started
        );
        queue.submit(event("a2", "instance.a")).unwrap();
        queue.submit(event("a3", "instance.a")).unwrap();
        queue.submit(event("b1", "instance.b")).unwrap();
        queue.submit(event("b2", "instance.b")).unwrap();

        assert_eq!(queue.finish_active("a1").unwrap().unwrap().event_id, "b1");
        assert_eq!(queue.finish_active("b1").unwrap().unwrap().event_id, "a2");
        assert_eq!(queue.finish_active("a2").unwrap().unwrap().event_id, "b2");
        assert_eq!(queue.finish_active("b2").unwrap().unwrap().event_id, "a3");
        assert!(queue.finish_active("a3").unwrap().is_none());
    }

    #[test]
    fn bounds_instance_floods_and_rejects_stale_or_duplicate_events() {
        let mut queue = SurfaceEventQueueV1::new(route()).unwrap();
        queue.submit(event("active", "instance.a")).unwrap();
        for index in 0..MAX_SURFACE_EVENTS_PER_INSTANCE {
            queue
                .submit(event(&format!("queued-{index}"), "instance.a"))
                .unwrap();
        }
        assert_eq!(
            queue.submit(event("overflow", "instance.a")),
            Err(SurfaceEventQueueError::InstanceQueueFull)
        );
        assert_eq!(
            queue.submit(event("queued-0", "instance.b")),
            Err(SurfaceEventQueueError::Duplicate)
        );

        let mut stale = event("stale", "instance.b");
        stale.event.activation_generation += 1;
        assert_eq!(queue.submit(stale), Err(SurfaceEventQueueError::StaleRoute));
    }

    #[test]
    fn bounds_a_full_many_instance_plugin_flood() {
        let mut queue = SurfaceEventQueueV1::new(route()).unwrap();
        queue.submit(event("active", "instance.active")).unwrap();
        for instance in 0..(MAX_SURFACE_EVENTS_PER_PLUGIN / MAX_SURFACE_EVENTS_PER_INSTANCE) {
            for offset in 0..MAX_SURFACE_EVENTS_PER_INSTANCE {
                queue
                    .submit(event(
                        &format!("queued-{instance}-{offset}"),
                        &format!("instance.{instance}"),
                    ))
                    .unwrap();
            }
        }
        assert_eq!(queue.queued_len(), MAX_SURFACE_EVENTS_PER_PLUGIN);
        assert_eq!(
            queue.submit(event("overflow-plugin", "instance.overflow")),
            Err(SurfaceEventQueueError::PluginQueueFull)
        );
        for index in 0..8 {
            let active = queue.active().unwrap().event_id.clone();
            queue.finish_active(&active).unwrap();
            assert_eq!(
                queue.active().unwrap().event.instance_id.as_str(),
                format!("instance.{index}")
            );
        }
    }

    #[test]
    fn cancellation_and_revoke_recover_the_single_guest_lane() {
        let mut queue = SurfaceEventQueueV1::new(route()).unwrap();
        queue.submit(event("a1", "instance.a")).unwrap();
        queue.submit(event("b1", "instance.b")).unwrap();
        queue.submit(event("c1", "instance.c")).unwrap();

        queue.cancel_instance(&SurfaceInstanceId::new("instance.a").unwrap());
        assert_eq!(queue.active().unwrap().event_id, "b1");
        queue.cancel_event("c1").unwrap();
        assert_eq!(queue.queued_len(), 0);
        queue.revoke();
        assert!(queue.active().is_none());
        assert_eq!(queue.queued_len(), 0);
        assert_eq!(
            queue.submit(event("fresh", "instance.a")).unwrap(),
            SurfaceEventAdmissionV1::Started
        );
    }
}
