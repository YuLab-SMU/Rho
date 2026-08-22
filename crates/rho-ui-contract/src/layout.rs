use std::collections::BTreeSet;

use serde::{Deserialize, Serialize};

use crate::{
    ContractError, LayoutNodeId, ProjectId, SceneId, SurfaceInstanceId, Validate, encoded_json_len,
    ensure_revision, next_revision, validate_label,
};

pub const MAX_SCENE_JSON_BYTES: usize = 1024 * 1024;
pub const MAX_LAYOUT_DEPTH: usize = 32;
pub const MAX_LAYOUT_NODES: usize = 256;
pub const MAX_SURFACE_PLACEMENTS: usize = 128;
pub const MAX_CONTAINER_CHILDREN: usize = 64;
pub const MAX_LAYOUT_LOGICAL_PIXELS: u32 = 100_000;
pub const MAX_LAYOUT_FRACTION_WEIGHT: u16 = 10_000;
pub const STUDIO_RUNTIME_SNAPSHOT_CONTRACT: &str = "rho.ui.studio-runtime.snapshot.v1";
pub const MAX_STUDIO_RUNTIME_SNAPSHOT_BYTES: usize = 2 * 1024 * 1024;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum LayoutAxisV1 {
    Horizontal,
    Vertical,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum LayoutBasisV1 {
    Auto,
    Intrinsic,
    Fixed {
        logical_pixels: u32,
    },
    Fraction {
        weight: u16,
    },
    Minmax {
        min_logical_pixels: u32,
        max_logical_pixels: u32,
        weight: u16,
    },
}

impl LayoutBasisV1 {
    fn validate_at(&self, path: &str) -> Result<(), ContractError> {
        match self {
            Self::Auto | Self::Intrinsic => Ok(()),
            Self::Fixed { logical_pixels } => {
                validate_pixels(*logical_pixels, &format!("{path}.logical_pixels"))
            }
            Self::Fraction { weight } => validate_weight(*weight, &format!("{path}.weight")),
            Self::Minmax {
                min_logical_pixels,
                max_logical_pixels,
                weight,
            } => {
                validate_pixels(*min_logical_pixels, &format!("{path}.min_logical_pixels"))?;
                validate_pixels(*max_logical_pixels, &format!("{path}.max_logical_pixels"))?;
                validate_weight(*weight, &format!("{path}.weight"))?;
                if min_logical_pixels > max_logical_pixels {
                    return Err(ContractError::InvalidValue {
                        path: path.to_string(),
                        reason: "minmax minimum exceeds maximum".to_string(),
                    });
                }
                Ok(())
            }
        }
    }
}

fn validate_pixels(value: u32, path: &str) -> Result<(), ContractError> {
    if value > MAX_LAYOUT_LOGICAL_PIXELS {
        return Err(ContractError::LimitExceeded {
            path: path.to_string(),
            limit: MAX_LAYOUT_LOGICAL_PIXELS as usize,
            actual: value as usize,
        });
    }
    Ok(())
}

fn validate_weight(value: u16, path: &str) -> Result<(), ContractError> {
    if value == 0 || value > MAX_LAYOUT_FRACTION_WEIGHT {
        return Err(ContractError::InvalidValue {
            path: path.to_string(),
            reason: format!("fraction weight must be 1..={MAX_LAYOUT_FRACTION_WEIGHT}"),
        });
    }
    Ok(())
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct LayoutChildV1 {
    pub child: LayoutNodeV1,
    pub basis: LayoutBasisV1,
    pub resizable: bool,
    pub collapse_priority: Option<u16>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct StackNodeV1 {
    pub node_id: LayoutNodeId,
    pub active_instance_id: SurfaceInstanceId,
    pub instances: Vec<SurfaceInstanceId>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum LayoutNodeV1 {
    Container {
        node_id: LayoutNodeId,
        axis: LayoutAxisV1,
        children: Vec<LayoutChildV1>,
    },
    Stack(StackNodeV1),
    Surface {
        node_id: LayoutNodeId,
        instance_id: SurfaceInstanceId,
    },
}

impl LayoutNodeV1 {
    pub fn node_id(&self) -> &LayoutNodeId {
        match self {
            Self::Container { node_id, .. } | Self::Surface { node_id, .. } => node_id,
            Self::Stack(stack) => &stack.node_id,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SceneStateV1 {
    pub scene_id: SceneId,
    pub project_id: ProjectId,
    pub label: String,
    pub layout_revision: u64,
    pub root: LayoutNodeV1,
    pub focused_surface_instance_id: Option<SurfaceInstanceId>,
    pub utility_tray: Option<StackNodeV1>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct StudioRuntimeSnapshotV1 {
    pub contract: String,
    pub contract_major: u16,
    pub snapshot_revision: u64,
    pub project_id: ProjectId,
    pub project_revision: u64,
    pub scene: SceneStateV1,
    pub unplaced_instance_ids: Vec<SurfaceInstanceId>,
    pub can_undo: bool,
    pub can_redo: bool,
}

impl Validate for StudioRuntimeSnapshotV1 {
    fn validate(&self) -> Result<(), ContractError> {
        if self.contract != STUDIO_RUNTIME_SNAPSHOT_CONTRACT
            || self.contract_major != crate::RSR_CONTRACT_MAJOR
        {
            return Err(ContractError::InvalidValue {
                path: "studio_runtime_snapshot.contract".to_string(),
                reason: "unsupported Studio Runtime snapshot contract".to_string(),
            });
        }
        if self.snapshot_revision == 0 {
            return Err(ContractError::InvalidValue {
                path: "studio_runtime_snapshot.snapshot_revision".to_string(),
                reason: "snapshot revision must be positive".to_string(),
            });
        }
        if self.scene.project_id != self.project_id {
            return Err(ContractError::InvalidValue {
                path: "studio_runtime_snapshot.scene.project_id".to_string(),
                reason: "Scene belongs to another project".to_string(),
            });
        }
        self.scene.validate()?;
        let mut placed = BTreeSet::new();
        collect_scene_instance_ids(&self.scene, &mut placed);
        let mut unplaced = BTreeSet::new();
        for instance_id in &self.unplaced_instance_ids {
            if placed.contains(instance_id.as_str()) {
                return Err(ContractError::Duplicate {
                    path: "studio_runtime_snapshot.unplaced_instance_ids".to_string(),
                    value: instance_id.to_string(),
                });
            }
            if !unplaced.insert(instance_id.as_str()) {
                return Err(ContractError::Duplicate {
                    path: "studio_runtime_snapshot.unplaced_instance_ids".to_string(),
                    value: instance_id.to_string(),
                });
            }
        }
        let encoded = encoded_json_len("studio_runtime_snapshot", self)?;
        if encoded > MAX_STUDIO_RUNTIME_SNAPSHOT_BYTES {
            return Err(ContractError::LimitExceeded {
                path: "studio_runtime_snapshot".to_string(),
                limit: MAX_STUDIO_RUNTIME_SNAPSHOT_BYTES,
                actual: encoded,
            });
        }
        Ok(())
    }
}

#[derive(Default)]
struct LayoutValidationState {
    node_ids: BTreeSet<String>,
    instance_ids: BTreeSet<String>,
    nodes: usize,
    placements: usize,
}

impl LayoutValidationState {
    fn add_node(&mut self, path: &str, node_id: &LayoutNodeId) -> Result<(), ContractError> {
        self.nodes += 1;
        if self.nodes > MAX_LAYOUT_NODES {
            return Err(ContractError::LimitExceeded {
                path: "scene.nodes".to_string(),
                limit: MAX_LAYOUT_NODES,
                actual: self.nodes,
            });
        }
        if !self.node_ids.insert(node_id.as_str().to_string()) {
            return Err(ContractError::Duplicate {
                path: format!("{path}.node_id"),
                value: node_id.to_string(),
            });
        }
        Ok(())
    }

    fn add_instance(
        &mut self,
        path: &str,
        instance_id: &SurfaceInstanceId,
    ) -> Result<(), ContractError> {
        self.placements += 1;
        if self.placements > MAX_SURFACE_PLACEMENTS {
            return Err(ContractError::LimitExceeded {
                path: "scene.surface_placements".to_string(),
                limit: MAX_SURFACE_PLACEMENTS,
                actual: self.placements,
            });
        }
        if !self.instance_ids.insert(instance_id.as_str().to_string()) {
            return Err(ContractError::Duplicate {
                path: path.to_string(),
                value: instance_id.to_string(),
            });
        }
        Ok(())
    }
}

fn validate_stack(
    stack: &StackNodeV1,
    path: &str,
    state: &mut LayoutValidationState,
) -> Result<(), ContractError> {
    state.add_node(path, &stack.node_id)?;
    if stack.instances.is_empty() {
        return Err(ContractError::InvalidValue {
            path: format!("{path}.instances"),
            reason: "a Stack requires at least one Surface instance".to_string(),
        });
    }
    if stack.instances.len() > MAX_SURFACE_PLACEMENTS {
        return Err(ContractError::LimitExceeded {
            path: format!("{path}.instances"),
            limit: MAX_SURFACE_PLACEMENTS,
            actual: stack.instances.len(),
        });
    }
    let mut local = BTreeSet::new();
    for (index, instance_id) in stack.instances.iter().enumerate() {
        if !local.insert(instance_id.as_str()) {
            return Err(ContractError::Duplicate {
                path: format!("{path}.instances"),
                value: instance_id.to_string(),
            });
        }
        state.add_instance(&format!("{path}.instances[{index}]"), instance_id)?;
    }
    if !local.contains(stack.active_instance_id.as_str()) {
        return Err(ContractError::MissingReference {
            path: format!("{path}.active_instance_id"),
            value: stack.active_instance_id.to_string(),
        });
    }
    Ok(())
}

fn validate_node(
    node: &LayoutNodeV1,
    path: &str,
    depth: usize,
    state: &mut LayoutValidationState,
) -> Result<(), ContractError> {
    if depth > MAX_LAYOUT_DEPTH {
        return Err(ContractError::LimitExceeded {
            path: "scene.layout_depth".to_string(),
            limit: MAX_LAYOUT_DEPTH,
            actual: depth,
        });
    }
    match node {
        LayoutNodeV1::Container {
            node_id, children, ..
        } => {
            state.add_node(path, node_id)?;
            if children.len() > MAX_CONTAINER_CHILDREN {
                return Err(ContractError::LimitExceeded {
                    path: format!("{path}.children"),
                    limit: MAX_CONTAINER_CHILDREN,
                    actual: children.len(),
                });
            }
            for (index, child) in children.iter().enumerate() {
                let child_path = format!("{path}.children[{index}]");
                child.basis.validate_at(&format!("{child_path}.basis"))?;
                validate_node(
                    &child.child,
                    &format!("{child_path}.child"),
                    depth + 1,
                    state,
                )?;
            }
            Ok(())
        }
        LayoutNodeV1::Stack(stack) => validate_stack(stack, path, state),
        LayoutNodeV1::Surface {
            node_id,
            instance_id,
        } => {
            state.add_node(path, node_id)?;
            state.add_instance(&format!("{path}.instance_id"), instance_id)
        }
    }
}

fn collect_node_instance_ids<'a>(node: &'a LayoutNodeV1, output: &mut BTreeSet<&'a str>) {
    match node {
        LayoutNodeV1::Container { children, .. } => {
            for child in children {
                collect_node_instance_ids(&child.child, output);
            }
        }
        LayoutNodeV1::Stack(stack) => {
            output.extend(stack.instances.iter().map(SurfaceInstanceId::as_str));
        }
        LayoutNodeV1::Surface { instance_id, .. } => {
            output.insert(instance_id.as_str());
        }
    }
}

pub fn collect_scene_instance_ids<'a>(scene: &'a SceneStateV1, output: &mut BTreeSet<&'a str>) {
    collect_node_instance_ids(&scene.root, output);
    if let Some(stack) = &scene.utility_tray {
        output.extend(stack.instances.iter().map(SurfaceInstanceId::as_str));
    }
}

impl Validate for SceneStateV1 {
    fn validate(&self) -> Result<(), ContractError> {
        validate_label(&self.label, "scene.label")?;
        let mut state = LayoutValidationState::default();
        validate_node(&self.root, "scene.root", 1, &mut state)?;
        if let Some(utility_tray) = &self.utility_tray {
            validate_stack(utility_tray, "scene.utility_tray", &mut state)?;
        }
        if let Some(focused) = &self.focused_surface_instance_id
            && !state.instance_ids.contains(focused.as_str())
        {
            return Err(ContractError::MissingReference {
                path: "scene.focused_surface_instance_id".to_string(),
                value: focused.to_string(),
            });
        }
        let encoded = encoded_json_len("scene", self)?;
        if encoded > MAX_SCENE_JSON_BYTES {
            return Err(ContractError::LimitExceeded {
                path: "scene.encoded_bytes".to_string(),
                limit: MAX_SCENE_JSON_BYTES,
                actual: encoded,
            });
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum SceneMutationV1 {
    ReplaceRoot {
        root: LayoutNodeV1,
    },
    SetFocus {
        instance_id: Option<SurfaceInstanceId>,
    },
    SetChildBasis {
        container_node_id: LayoutNodeId,
        child_index: usize,
        basis: LayoutBasisV1,
    },
    SetStackActive {
        stack_node_id: LayoutNodeId,
        instance_id: SurfaceInstanceId,
    },
}

fn find_node_mut<'a>(
    node: &'a mut LayoutNodeV1,
    target: &LayoutNodeId,
) -> Option<&'a mut LayoutNodeV1> {
    if node.node_id() == target {
        return Some(node);
    }
    if let LayoutNodeV1::Container { children, .. } = node {
        for child in children {
            if let Some(found) = find_node_mut(&mut child.child, target) {
                return Some(found);
            }
        }
    }
    None
}

pub fn apply_scene_mutation(
    scene: &SceneStateV1,
    expected_revision: u64,
    mutation: SceneMutationV1,
) -> Result<SceneStateV1, ContractError> {
    ensure_revision(
        "scene.layout_revision",
        expected_revision,
        scene.layout_revision,
    )?;
    let mut next = scene.clone();
    match mutation {
        SceneMutationV1::ReplaceRoot { root } => next.root = root,
        SceneMutationV1::SetFocus { instance_id } => {
            next.focused_surface_instance_id = instance_id;
        }
        SceneMutationV1::SetChildBasis {
            container_node_id,
            child_index,
            basis,
        } => {
            basis.validate_at("scene_mutation.basis")?;
            let node = find_node_mut(&mut next.root, &container_node_id).ok_or_else(|| {
                ContractError::MissingReference {
                    path: "scene_mutation.container_node_id".to_string(),
                    value: container_node_id.to_string(),
                }
            })?;
            let LayoutNodeV1::Container { children, .. } = node else {
                return Err(ContractError::InvalidValue {
                    path: "scene_mutation.container_node_id".to_string(),
                    reason: "target node is not a Container".to_string(),
                });
            };
            let child =
                children
                    .get_mut(child_index)
                    .ok_or_else(|| ContractError::MissingReference {
                        path: "scene_mutation.child_index".to_string(),
                        value: child_index.to_string(),
                    })?;
            child.basis = basis;
        }
        SceneMutationV1::SetStackActive {
            stack_node_id,
            instance_id,
        } => {
            if next
                .utility_tray
                .as_ref()
                .is_some_and(|stack| stack.node_id == stack_node_id)
            {
                next.utility_tray.as_mut().unwrap().active_instance_id = instance_id;
            } else {
                let node = find_node_mut(&mut next.root, &stack_node_id).ok_or_else(|| {
                    ContractError::MissingReference {
                        path: "scene_mutation.stack_node_id".to_string(),
                        value: stack_node_id.to_string(),
                    }
                })?;
                let LayoutNodeV1::Stack(stack) = node else {
                    return Err(ContractError::InvalidValue {
                        path: "scene_mutation.stack_node_id".to_string(),
                        reason: "target node is not a Stack".to_string(),
                    });
                };
                stack.active_instance_id = instance_id;
            }
        }
    }
    next.layout_revision = next_revision("scene.layout_revision", expected_revision)?;
    next.validate()?;
    Ok(next)
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum SceneEditV1 {
    InsertSurface {
        target_container_node_id: LayoutNodeId,
        child_index: usize,
        instance_id: SurfaceInstanceId,
        basis: LayoutBasisV1,
    },
    MoveSurface {
        instance_id: SurfaceInstanceId,
        target_container_node_id: LayoutNodeId,
        child_index: usize,
        basis: LayoutBasisV1,
    },
    StackSurface {
        instance_id: SurfaceInstanceId,
        target_instance_id: SurfaceInstanceId,
    },
    UnstackSurface {
        instance_id: SurfaceInstanceId,
        target_container_node_id: LayoutNodeId,
        child_index: usize,
        basis: LayoutBasisV1,
    },
    CloseSurfacePlacement {
        instance_id: SurfaceInstanceId,
    },
    ResizeBoundary {
        container_node_id: LayoutNodeId,
        before_child_index: usize,
        before_basis: LayoutBasisV1,
        after_basis: LayoutBasisV1,
    },
    SetChildBasis {
        container_node_id: LayoutNodeId,
        child_index: usize,
        basis: LayoutBasisV1,
    },
    SetCollapsePriority {
        container_node_id: LayoutNodeId,
        child_index: usize,
        collapse_priority: Option<u16>,
    },
    SetContainerAxis {
        container_node_id: LayoutNodeId,
        axis: LayoutAxisV1,
    },
    SetStackActive {
        stack_node_id: LayoutNodeId,
        instance_id: SurfaceInstanceId,
    },
    SetFocus {
        instance_id: Option<SurfaceInstanceId>,
    },
    Normalize,
    DistributeContainer {
        container_node_id: LayoutNodeId,
    },
    ReplaceRoot {
        root: LayoutNodeV1,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SceneEditRequestV1 {
    pub project_id: ProjectId,
    pub expected_project_revision: u64,
    pub expected_layout_revision: u64,
    pub edit: SceneEditV1,
}

impl Validate for SceneEditRequestV1 {
    fn validate(&self) -> Result<(), ContractError> {
        let encoded = encoded_json_len("scene_edit_request", self)?;
        if encoded > MAX_SCENE_JSON_BYTES {
            return Err(ContractError::LimitExceeded {
                path: "scene_edit_request".to_string(),
                limit: MAX_SCENE_JSON_BYTES,
                actual: encoded,
            });
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct StudioRevisionRequestV1 {
    pub project_id: ProjectId,
    pub expected_project_revision: u64,
    pub expected_layout_revision: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ExtractInstanceResult {
    NotFound,
    Updated,
    RemoveNode,
}

fn node_contains_instance(node: &LayoutNodeV1, target: &SurfaceInstanceId) -> bool {
    match node {
        LayoutNodeV1::Container { children, .. } => children
            .iter()
            .any(|child| node_contains_instance(&child.child, target)),
        LayoutNodeV1::Stack(stack) => stack.instances.contains(target),
        LayoutNodeV1::Surface { instance_id, .. } => instance_id == target,
    }
}

fn extract_instance(node: &mut LayoutNodeV1, target: &SurfaceInstanceId) -> ExtractInstanceResult {
    match node {
        LayoutNodeV1::Surface { instance_id, .. } => {
            if instance_id == target {
                ExtractInstanceResult::RemoveNode
            } else {
                ExtractInstanceResult::NotFound
            }
        }
        LayoutNodeV1::Stack(stack) => {
            let Some(index) = stack.instances.iter().position(|value| value == target) else {
                return ExtractInstanceResult::NotFound;
            };
            stack.instances.remove(index);
            if stack.instances.is_empty() {
                ExtractInstanceResult::RemoveNode
            } else {
                if stack.active_instance_id == *target {
                    stack.active_instance_id =
                        stack.instances[index.min(stack.instances.len() - 1)].clone();
                }
                ExtractInstanceResult::Updated
            }
        }
        LayoutNodeV1::Container { children, .. } => {
            for index in 0..children.len() {
                match extract_instance(&mut children[index].child, target) {
                    ExtractInstanceResult::NotFound => {}
                    ExtractInstanceResult::Updated => return ExtractInstanceResult::Updated,
                    ExtractInstanceResult::RemoveNode => {
                        children.remove(index);
                        return ExtractInstanceResult::Updated;
                    }
                }
            }
            ExtractInstanceResult::NotFound
        }
    }
}

fn empty_root(node_id: LayoutNodeId) -> LayoutNodeV1 {
    LayoutNodeV1::Container {
        node_id,
        axis: LayoutAxisV1::Horizontal,
        children: Vec::new(),
    }
}

fn extract_scene_instance(
    scene: &mut SceneStateV1,
    target: &SurfaceInstanceId,
    allocate_node_id: &mut impl FnMut() -> LayoutNodeId,
) -> Result<(), ContractError> {
    match extract_instance(&mut scene.root, target) {
        ExtractInstanceResult::Updated => return Ok(()),
        ExtractInstanceResult::RemoveNode => {
            scene.root = empty_root(allocate_node_id());
            return Ok(());
        }
        ExtractInstanceResult::NotFound => {}
    }
    if let Some(stack) = scene.utility_tray.as_mut()
        && let Some(index) = stack.instances.iter().position(|value| value == target)
    {
        stack.instances.remove(index);
        if stack.instances.is_empty() {
            scene.utility_tray = None;
        } else if stack.active_instance_id == *target {
            stack.active_instance_id =
                stack.instances[index.min(stack.instances.len() - 1)].clone();
        }
        return Ok(());
    }
    Err(ContractError::MissingReference {
        path: "scene_edit.instance_id".to_string(),
        value: target.to_string(),
    })
}

fn insert_surface(
    scene: &mut SceneStateV1,
    target_container_node_id: &LayoutNodeId,
    child_index: usize,
    instance_id: SurfaceInstanceId,
    basis: LayoutBasisV1,
    allocate_node_id: &mut impl FnMut() -> LayoutNodeId,
) -> Result<(), ContractError> {
    let node = find_node_mut(&mut scene.root, target_container_node_id).ok_or_else(|| {
        ContractError::MissingReference {
            path: "scene_edit.target_container_node_id".to_string(),
            value: target_container_node_id.to_string(),
        }
    })?;
    let LayoutNodeV1::Container { children, .. } = node else {
        return Err(ContractError::InvalidValue {
            path: "scene_edit.target_container_node_id".to_string(),
            reason: "target node is not a Container".to_string(),
        });
    };
    if child_index > children.len() {
        return Err(ContractError::MissingReference {
            path: "scene_edit.child_index".to_string(),
            value: child_index.to_string(),
        });
    }
    children.insert(
        child_index,
        LayoutChildV1 {
            child: LayoutNodeV1::Surface {
                node_id: allocate_node_id(),
                instance_id,
            },
            basis,
            resizable: true,
            collapse_priority: None,
        },
    );
    Ok(())
}

fn stack_surface(
    node: &mut LayoutNodeV1,
    instance_id: &SurfaceInstanceId,
    target_instance_id: &SurfaceInstanceId,
    allocate_node_id: &mut impl FnMut() -> LayoutNodeId,
) -> bool {
    match node {
        LayoutNodeV1::Container { children, .. } => children.iter_mut().any(|child| {
            stack_surface(
                &mut child.child,
                instance_id,
                target_instance_id,
                allocate_node_id,
            )
        }),
        LayoutNodeV1::Stack(stack) if stack.instances.contains(target_instance_id) => {
            stack.instances.push(instance_id.clone());
            stack.active_instance_id = instance_id.clone();
            true
        }
        LayoutNodeV1::Surface {
            instance_id: target,
            ..
        } if target == target_instance_id => {
            *node = LayoutNodeV1::Stack(StackNodeV1 {
                node_id: allocate_node_id(),
                active_instance_id: instance_id.clone(),
                instances: vec![target_instance_id.clone(), instance_id.clone()],
            });
            true
        }
        _ => false,
    }
}

fn normalize_node(node: &mut LayoutNodeV1, allocate_node_id: &mut impl FnMut() -> LayoutNodeId) {
    match node {
        LayoutNodeV1::Container { children, .. } => {
            for child in children.iter_mut() {
                normalize_node(&mut child.child, allocate_node_id);
            }
            children.retain(|child| {
                !matches!(
                    &child.child,
                    LayoutNodeV1::Container { children, .. } if children.is_empty()
                )
            });
        }
        LayoutNodeV1::Stack(stack) if stack.instances.len() == 1 => {
            *node = LayoutNodeV1::Surface {
                node_id: allocate_node_id(),
                instance_id: stack.instances[0].clone(),
            };
        }
        _ => {}
    }
}

fn prune_node_instances(node: &mut LayoutNodeV1, allowed: &BTreeSet<String>) -> bool {
    match node {
        LayoutNodeV1::Surface { instance_id, .. } => allowed.contains(instance_id.as_str()),
        LayoutNodeV1::Stack(stack) => {
            stack
                .instances
                .retain(|instance_id| allowed.contains(instance_id.as_str()));
            if stack.instances.is_empty() {
                return false;
            }
            if !stack.instances.contains(&stack.active_instance_id) {
                stack.active_instance_id = stack.instances[0].clone();
            }
            true
        }
        LayoutNodeV1::Container { children, .. } => {
            children.retain_mut(|child| prune_node_instances(&mut child.child, allowed));
            true
        }
    }
}

pub fn reconcile_scene_instances(
    scene: &SceneStateV1,
    allowed: &BTreeSet<String>,
    allocate_node_id: &mut impl FnMut() -> LayoutNodeId,
) -> Result<Option<SceneStateV1>, ContractError> {
    let mut next = scene.clone();
    let before = next.clone();
    if !prune_node_instances(&mut next.root, allowed) {
        next.root = empty_root(allocate_node_id());
    }
    if let Some(stack) = next.utility_tray.as_mut() {
        stack
            .instances
            .retain(|instance_id| allowed.contains(instance_id.as_str()));
        if stack.instances.is_empty() {
            next.utility_tray = None;
        } else if !stack.instances.contains(&stack.active_instance_id) {
            stack.active_instance_id = stack.instances[0].clone();
        }
    }
    if next
        .focused_surface_instance_id
        .as_ref()
        .is_some_and(|instance_id| !allowed.contains(instance_id.as_str()))
    {
        next.focused_surface_instance_id = None;
    }
    if next == before {
        return Ok(None);
    }
    next.layout_revision = next_revision("scene.layout_revision", scene.layout_revision)?;
    normalize_node(&mut next.root, allocate_node_id);
    next.validate()?;
    Ok(Some(next))
}

pub fn apply_scene_edit(
    scene: &SceneStateV1,
    expected_revision: u64,
    edit: SceneEditV1,
    allocate_node_id: &mut impl FnMut() -> LayoutNodeId,
) -> Result<SceneStateV1, ContractError> {
    ensure_revision(
        "scene.layout_revision",
        expected_revision,
        scene.layout_revision,
    )?;
    let mut next = scene.clone();
    match edit {
        SceneEditV1::InsertSurface {
            target_container_node_id,
            child_index,
            instance_id,
            basis,
        } => {
            basis.validate_at("scene_edit.basis")?;
            if node_contains_instance(&next.root, &instance_id)
                || next
                    .utility_tray
                    .as_ref()
                    .is_some_and(|stack| stack.instances.contains(&instance_id))
            {
                return Err(ContractError::Duplicate {
                    path: "scene_edit.instance_id".to_string(),
                    value: instance_id.to_string(),
                });
            }
            insert_surface(
                &mut next,
                &target_container_node_id,
                child_index,
                instance_id,
                basis,
                allocate_node_id,
            )?;
        }
        SceneEditV1::MoveSurface {
            instance_id,
            target_container_node_id,
            child_index,
            basis,
        } => {
            basis.validate_at("scene_edit.basis")?;
            extract_scene_instance(&mut next, &instance_id, allocate_node_id)?;
            insert_surface(
                &mut next,
                &target_container_node_id,
                child_index,
                instance_id,
                basis,
                allocate_node_id,
            )?;
        }
        SceneEditV1::StackSurface {
            instance_id,
            target_instance_id,
        } => {
            if instance_id == target_instance_id {
                return Err(ContractError::InvalidValue {
                    path: "scene_edit.target_instance_id".to_string(),
                    reason: "a Surface cannot stack onto itself".to_string(),
                });
            }
            extract_scene_instance(&mut next, &instance_id, allocate_node_id)?;
            let stacked = stack_surface(
                &mut next.root,
                &instance_id,
                &target_instance_id,
                allocate_node_id,
            ) || next.utility_tray.as_mut().is_some_and(|stack| {
                if stack.instances.contains(&target_instance_id) {
                    stack.instances.push(instance_id.clone());
                    stack.active_instance_id = instance_id.clone();
                    true
                } else {
                    false
                }
            });
            if !stacked {
                return Err(ContractError::MissingReference {
                    path: "scene_edit.target_instance_id".to_string(),
                    value: target_instance_id.to_string(),
                });
            }
        }
        SceneEditV1::UnstackSurface {
            instance_id,
            target_container_node_id,
            child_index,
            basis,
        } => {
            basis.validate_at("scene_edit.basis")?;
            let in_stack = find_instance_stack(&next, &instance_id).is_some();
            if !in_stack {
                return Err(ContractError::InvalidValue {
                    path: "scene_edit.instance_id".to_string(),
                    reason: "Surface is not in a Stack".to_string(),
                });
            }
            extract_scene_instance(&mut next, &instance_id, allocate_node_id)?;
            insert_surface(
                &mut next,
                &target_container_node_id,
                child_index,
                instance_id,
                basis,
                allocate_node_id,
            )?;
        }
        SceneEditV1::CloseSurfacePlacement { instance_id } => {
            extract_scene_instance(&mut next, &instance_id, allocate_node_id)?;
            if next.focused_surface_instance_id.as_ref() == Some(&instance_id) {
                next.focused_surface_instance_id = None;
            }
        }
        SceneEditV1::ResizeBoundary {
            container_node_id,
            before_child_index,
            before_basis,
            after_basis,
        } => {
            before_basis.validate_at("scene_edit.before_basis")?;
            after_basis.validate_at("scene_edit.after_basis")?;
            let node = find_node_mut(&mut next.root, &container_node_id).ok_or_else(|| {
                ContractError::MissingReference {
                    path: "scene_edit.container_node_id".to_string(),
                    value: container_node_id.to_string(),
                }
            })?;
            let LayoutNodeV1::Container { children, .. } = node else {
                return Err(ContractError::InvalidValue {
                    path: "scene_edit.container_node_id".to_string(),
                    reason: "target node is not a Container".to_string(),
                });
            };
            let Some(after_child_index) = before_child_index.checked_add(1) else {
                return Err(ContractError::InvalidValue {
                    path: "scene_edit.before_child_index".to_string(),
                    reason: "boundary index overflow".to_string(),
                });
            };
            if after_child_index >= children.len()
                || !children[before_child_index].resizable
                || !children[after_child_index].resizable
            {
                return Err(ContractError::InvalidValue {
                    path: "scene_edit.before_child_index".to_string(),
                    reason: "boundary must separate two resizable children".to_string(),
                });
            }
            children[before_child_index].basis = before_basis;
            children[after_child_index].basis = after_basis;
        }
        SceneEditV1::SetChildBasis {
            container_node_id,
            child_index,
            basis,
        } => {
            basis.validate_at("scene_edit.basis")?;
            let node = find_node_mut(&mut next.root, &container_node_id).ok_or_else(|| {
                ContractError::MissingReference {
                    path: "scene_edit.container_node_id".to_string(),
                    value: container_node_id.to_string(),
                }
            })?;
            let LayoutNodeV1::Container { children, .. } = node else {
                return Err(ContractError::InvalidValue {
                    path: "scene_edit.container_node_id".to_string(),
                    reason: "target node is not a Container".to_string(),
                });
            };
            let child =
                children
                    .get_mut(child_index)
                    .ok_or_else(|| ContractError::MissingReference {
                        path: "scene_edit.child_index".to_string(),
                        value: child_index.to_string(),
                    })?;
            child.basis = basis;
        }
        SceneEditV1::SetCollapsePriority {
            container_node_id,
            child_index,
            collapse_priority,
        } => {
            let node = find_node_mut(&mut next.root, &container_node_id).ok_or_else(|| {
                ContractError::MissingReference {
                    path: "scene_edit.container_node_id".to_string(),
                    value: container_node_id.to_string(),
                }
            })?;
            let LayoutNodeV1::Container { children, .. } = node else {
                return Err(ContractError::InvalidValue {
                    path: "scene_edit.container_node_id".to_string(),
                    reason: "target node is not a Container".to_string(),
                });
            };
            children
                .get_mut(child_index)
                .ok_or_else(|| ContractError::MissingReference {
                    path: "scene_edit.child_index".to_string(),
                    value: child_index.to_string(),
                })?
                .collapse_priority = collapse_priority;
        }
        SceneEditV1::SetContainerAxis {
            container_node_id,
            axis,
        } => {
            let node = find_node_mut(&mut next.root, &container_node_id).ok_or_else(|| {
                ContractError::MissingReference {
                    path: "scene_edit.container_node_id".to_string(),
                    value: container_node_id.to_string(),
                }
            })?;
            let LayoutNodeV1::Container {
                axis: current_axis, ..
            } = node
            else {
                return Err(ContractError::InvalidValue {
                    path: "scene_edit.container_node_id".to_string(),
                    reason: "target node is not a Container".to_string(),
                });
            };
            *current_axis = axis;
        }
        SceneEditV1::SetStackActive {
            stack_node_id,
            instance_id,
        } => {
            let basic = SceneMutationV1::SetStackActive {
                stack_node_id,
                instance_id,
            };
            let changed = apply_scene_mutation(&next, next.layout_revision, basic)?;
            next = changed;
            next.layout_revision = scene.layout_revision;
        }
        SceneEditV1::SetFocus { instance_id } => {
            next.focused_surface_instance_id = instance_id;
        }
        SceneEditV1::Normalize => {
            normalize_node(&mut next.root, allocate_node_id);
        }
        SceneEditV1::DistributeContainer { container_node_id } => {
            let node = find_node_mut(&mut next.root, &container_node_id).ok_or_else(|| {
                ContractError::MissingReference {
                    path: "scene_edit.container_node_id".to_string(),
                    value: container_node_id.to_string(),
                }
            })?;
            let LayoutNodeV1::Container { children, .. } = node else {
                return Err(ContractError::InvalidValue {
                    path: "scene_edit.container_node_id".to_string(),
                    reason: "target node is not a Container".to_string(),
                });
            };
            for child in children.iter_mut().filter(|child| child.resizable) {
                child.basis = LayoutBasisV1::Fraction { weight: 1 };
            }
        }
        SceneEditV1::ReplaceRoot { root } => next.root = root,
    }
    next.layout_revision = next_revision("scene.layout_revision", expected_revision)?;
    next.validate()?;
    Ok(next)
}

fn find_instance_stack<'a>(
    scene: &'a SceneStateV1,
    instance_id: &SurfaceInstanceId,
) -> Option<&'a StackNodeV1> {
    fn find<'a>(
        node: &'a LayoutNodeV1,
        instance_id: &SurfaceInstanceId,
    ) -> Option<&'a StackNodeV1> {
        match node {
            LayoutNodeV1::Container { children, .. } => children
                .iter()
                .find_map(|child| find(&child.child, instance_id)),
            LayoutNodeV1::Stack(stack) if stack.instances.contains(instance_id) => Some(stack),
            _ => None,
        }
    }
    find(&scene.root, instance_id).or_else(|| {
        scene
            .utility_tray
            .as_ref()
            .filter(|stack| stack.instances.contains(instance_id))
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn surface(node: &str, instance: &str) -> LayoutNodeV1 {
        LayoutNodeV1::Surface {
            node_id: LayoutNodeId::new(node).unwrap(),
            instance_id: SurfaceInstanceId::new(instance).unwrap(),
        }
    }

    fn asymmetric_scene() -> SceneStateV1 {
        SceneStateV1 {
            scene_id: SceneId::new("scene:asymmetric").unwrap(),
            project_id: ProjectId::new("project:fixture").unwrap(),
            label: "Asymmetric lab".to_string(),
            layout_revision: 7,
            root: LayoutNodeV1::Container {
                node_id: LayoutNodeId::new("node:root").unwrap(),
                axis: LayoutAxisV1::Horizontal,
                children: vec![
                    LayoutChildV1 {
                        child: surface("node:editor", "instance:editor"),
                        basis: LayoutBasisV1::Fraction { weight: 7 },
                        resizable: true,
                        collapse_priority: None,
                    },
                    LayoutChildV1 {
                        child: LayoutNodeV1::Container {
                            node_id: LayoutNodeId::new("node:side").unwrap(),
                            axis: LayoutAxisV1::Vertical,
                            children: vec![
                                LayoutChildV1 {
                                    child: surface("node:plot", "instance:plot"),
                                    basis: LayoutBasisV1::Minmax {
                                        min_logical_pixels: 180,
                                        max_logical_pixels: 1200,
                                        weight: 3,
                                    },
                                    resizable: true,
                                    collapse_priority: None,
                                },
                                LayoutChildV1 {
                                    child: surface("node:status", "instance:status"),
                                    basis: LayoutBasisV1::Intrinsic,
                                    resizable: false,
                                    collapse_priority: Some(1),
                                },
                            ],
                        },
                        basis: LayoutBasisV1::Fraction { weight: 3 },
                        resizable: true,
                        collapse_priority: None,
                    },
                ],
            },
            focused_surface_instance_id: Some(SurfaceInstanceId::new("instance:editor").unwrap()),
            utility_tray: None,
        }
    }

    fn allocator() -> impl FnMut() -> LayoutNodeId {
        let mut next = 0_u32;
        move || {
            next += 1;
            LayoutNodeId::new(format!("node:allocated-{next}")).unwrap()
        }
    }

    #[test]
    fn arbitrary_asymmetry_and_intrinsic_strips_are_valid() {
        asymmetric_scene().validate().unwrap();
        assert!(
            serde_json::from_str::<LayoutNodeV1>(r#"{"kind":"grid","node_id":"node:bad"}"#)
                .is_err()
        );
    }

    #[test]
    fn empty_studio_scene_is_a_valid_user_state() {
        SceneStateV1 {
            scene_id: SceneId::new("scene:empty").unwrap(),
            project_id: ProjectId::new("project:fixture").unwrap(),
            label: "Empty Studio".to_string(),
            layout_revision: 1,
            root: LayoutNodeV1::Container {
                node_id: LayoutNodeId::new("node:empty-root").unwrap(),
                axis: LayoutAxisV1::Horizontal,
                children: vec![],
            },
            focused_surface_instance_id: None,
            utility_tray: None,
        }
        .validate()
        .unwrap();
    }

    #[test]
    fn duplicate_live_placements_are_rejected() {
        let mut scene = asymmetric_scene();
        let LayoutNodeV1::Container { children, .. } = &mut scene.root else {
            panic!("fixture root")
        };
        children.push(LayoutChildV1 {
            child: surface("node:duplicate", "instance:editor"),
            basis: LayoutBasisV1::Auto,
            resizable: true,
            collapse_priority: None,
        });
        assert!(matches!(
            scene.validate(),
            Err(ContractError::Duplicate { .. })
        ));
    }

    #[test]
    fn stale_or_invalid_mutations_leave_the_input_unchanged() {
        let scene = asymmetric_scene();
        assert!(matches!(
            apply_scene_mutation(&scene, 6, SceneMutationV1::SetFocus { instance_id: None }),
            Err(ContractError::StaleRevision { .. })
        ));
        assert_eq!(scene.layout_revision, 7);
        assert!(
            apply_scene_mutation(
                &scene,
                7,
                SceneMutationV1::SetFocus {
                    instance_id: Some(SurfaceInstanceId::new("instance:missing").unwrap())
                }
            )
            .is_err()
        );
        assert_eq!(scene.layout_revision, 7);
    }

    #[test]
    fn surface_edits_compose_without_a_grid_shape_or_placement_coupling() {
        let scene = asymmetric_scene();
        let mut allocate = allocator();
        let inserted = apply_scene_edit(
            &scene,
            7,
            SceneEditV1::InsertSurface {
                target_container_node_id: LayoutNodeId::new("node:root").unwrap(),
                child_index: 1,
                instance_id: SurfaceInstanceId::new("instance:preview-2").unwrap(),
                basis: LayoutBasisV1::Fixed {
                    logical_pixels: 260,
                },
            },
            &mut allocate,
        )
        .unwrap();
        let stacked = apply_scene_edit(
            &inserted,
            inserted.layout_revision,
            SceneEditV1::StackSurface {
                instance_id: SurfaceInstanceId::new("instance:preview-2").unwrap(),
                target_instance_id: SurfaceInstanceId::new("instance:editor").unwrap(),
            },
            &mut allocate,
        )
        .unwrap();
        let stack = find_instance_stack(
            &stacked,
            &SurfaceInstanceId::new("instance:preview-2").unwrap(),
        )
        .unwrap();
        assert_eq!(stack.instances.len(), 2);
        assert_eq!(stack.active_instance_id.as_str(), "instance:preview-2");

        let unstacked = apply_scene_edit(
            &stacked,
            stacked.layout_revision,
            SceneEditV1::UnstackSurface {
                instance_id: SurfaceInstanceId::new("instance:preview-2").unwrap(),
                target_container_node_id: LayoutNodeId::new("node:side").unwrap(),
                child_index: 1,
                basis: LayoutBasisV1::Fraction { weight: 2 },
            },
            &mut allocate,
        )
        .unwrap();
        assert!(
            find_instance_stack(
                &unstacked,
                &SurfaceInstanceId::new("instance:preview-2").unwrap()
            )
            .is_none()
        );

        let moved = apply_scene_edit(
            &unstacked,
            unstacked.layout_revision,
            SceneEditV1::MoveSurface {
                instance_id: SurfaceInstanceId::new("instance:plot").unwrap(),
                target_container_node_id: LayoutNodeId::new("node:root").unwrap(),
                child_index: 0,
                basis: LayoutBasisV1::Minmax {
                    min_logical_pixels: 120,
                    max_logical_pixels: 900,
                    weight: 5,
                },
            },
            &mut allocate,
        )
        .unwrap();
        let mut ids = BTreeSet::new();
        collect_scene_instance_ids(&moved, &mut ids);
        assert_eq!(ids.len(), 4);
        assert!(ids.contains("instance:plot"));
        moved.validate().unwrap();
    }

    #[test]
    fn resize_is_atomic_and_non_resizable_boundaries_are_rejected() {
        let scene = asymmetric_scene();
        let mut allocate = allocator();
        let resized = apply_scene_edit(
            &scene,
            scene.layout_revision,
            SceneEditV1::ResizeBoundary {
                container_node_id: LayoutNodeId::new("node:root").unwrap(),
                before_child_index: 0,
                before_basis: LayoutBasisV1::Fixed {
                    logical_pixels: 720,
                },
                after_basis: LayoutBasisV1::Minmax {
                    min_logical_pixels: 240,
                    max_logical_pixels: 1400,
                    weight: 3,
                },
            },
            &mut allocate,
        )
        .unwrap();
        let LayoutNodeV1::Container { children, .. } = &resized.root else {
            panic!("fixture root")
        };
        assert_eq!(
            children[0].basis,
            LayoutBasisV1::Fixed {
                logical_pixels: 720
            }
        );
        assert!(matches!(children[1].basis, LayoutBasisV1::Minmax { .. }));

        let before = scene.clone();
        assert!(
            apply_scene_edit(
                &scene,
                scene.layout_revision,
                SceneEditV1::ResizeBoundary {
                    container_node_id: LayoutNodeId::new("node:side").unwrap(),
                    before_child_index: 0,
                    before_basis: LayoutBasisV1::Fraction { weight: 1 },
                    after_basis: LayoutBasisV1::Fraction { weight: 1 },
                },
                &mut allocate,
            )
            .is_err()
        );
        assert_eq!(scene, before);
    }

    #[test]
    fn reconciliation_prunes_unavailable_instances_and_normalizes_single_tabs() {
        let scene = asymmetric_scene();
        let mut allocate = allocator();
        let inserted = apply_scene_edit(
            &scene,
            scene.layout_revision,
            SceneEditV1::InsertSurface {
                target_container_node_id: LayoutNodeId::new("node:root").unwrap(),
                child_index: 1,
                instance_id: SurfaceInstanceId::new("instance:temporary").unwrap(),
                basis: LayoutBasisV1::Auto,
            },
            &mut allocate,
        )
        .unwrap();
        let stacked = apply_scene_edit(
            &inserted,
            inserted.layout_revision,
            SceneEditV1::StackSurface {
                instance_id: SurfaceInstanceId::new("instance:temporary").unwrap(),
                target_instance_id: SurfaceInstanceId::new("instance:editor").unwrap(),
            },
            &mut allocate,
        )
        .unwrap();
        let allowed = BTreeSet::from([
            "instance:editor".to_string(),
            "instance:plot".to_string(),
            "instance:status".to_string(),
        ]);
        let reconciled = reconcile_scene_instances(&stacked, &allowed, &mut allocate)
            .unwrap()
            .unwrap();
        assert!(
            find_instance_stack(
                &reconciled,
                &SurfaceInstanceId::new("instance:editor").unwrap()
            )
            .is_none()
        );
        let mut ids = BTreeSet::new();
        collect_scene_instance_ids(&reconciled, &mut ids);
        assert_eq!(
            ids,
            BTreeSet::from(["instance:editor", "instance:plot", "instance:status"])
        );
        assert!(reconciled.layout_revision > stacked.layout_revision);
    }

    #[test]
    fn layout_depth_accepts_the_boundary_and_rejects_one_more_level() {
        fn nested(depth: usize) -> LayoutNodeV1 {
            let mut node = surface("node:leaf", "instance:leaf");
            for index in 1..depth {
                node = LayoutNodeV1::Container {
                    node_id: LayoutNodeId::new(format!("node:depth-{index}")).unwrap(),
                    axis: LayoutAxisV1::Vertical,
                    children: vec![LayoutChildV1 {
                        child: node,
                        basis: LayoutBasisV1::Auto,
                        resizable: true,
                        collapse_priority: None,
                    }],
                };
            }
            node
        }
        let mut scene = asymmetric_scene();
        scene.root = nested(MAX_LAYOUT_DEPTH);
        scene.focused_surface_instance_id = Some(SurfaceInstanceId::new("instance:leaf").unwrap());
        scene.validate().unwrap();
        scene.root = nested(MAX_LAYOUT_DEPTH + 1);
        assert!(matches!(
            scene.validate(),
            Err(ContractError::LimitExceeded { path, .. }) if path == "scene.layout_depth"
        ));
    }

    #[test]
    fn placement_budget_accepts_boundary_and_rejects_one_more() {
        let make = |count: usize| SceneStateV1 {
            scene_id: SceneId::new("scene:stack").unwrap(),
            project_id: ProjectId::new("project:fixture").unwrap(),
            label: "Dense stack".to_string(),
            layout_revision: 1,
            root: LayoutNodeV1::Stack(StackNodeV1 {
                node_id: LayoutNodeId::new("node:stack").unwrap(),
                active_instance_id: SurfaceInstanceId::new("instance:0").unwrap(),
                instances: (0..count)
                    .map(|index| SurfaceInstanceId::new(format!("instance:{index}")).unwrap())
                    .collect(),
            }),
            focused_surface_instance_id: Some(SurfaceInstanceId::new("instance:0").unwrap()),
            utility_tray: None,
        };
        make(MAX_SURFACE_PLACEMENTS).validate().unwrap();
        assert!(make(MAX_SURFACE_PLACEMENTS + 1).validate().is_err());
    }

    #[test]
    fn node_budget_accepts_boundary_and_rejects_one_extra_wrapper() {
        let mut outer = Vec::new();
        let mut instance_index = 0;
        for branch in 0..64 {
            let mut children = vec![LayoutChildV1 {
                child: surface(
                    &format!("node:surface-{instance_index}"),
                    &format!("instance:{instance_index}"),
                ),
                basis: LayoutBasisV1::Auto,
                resizable: true,
                collapse_priority: None,
            }];
            instance_index += 1;
            if branch < 63 {
                children.push(LayoutChildV1 {
                    child: LayoutNodeV1::Container {
                        node_id: LayoutNodeId::new(format!("node:inner-{branch}")).unwrap(),
                        axis: LayoutAxisV1::Vertical,
                        children: vec![LayoutChildV1 {
                            child: surface(
                                &format!("node:surface-{instance_index}"),
                                &format!("instance:{instance_index}"),
                            ),
                            basis: LayoutBasisV1::Intrinsic,
                            resizable: false,
                            collapse_priority: None,
                        }],
                    },
                    basis: LayoutBasisV1::Auto,
                    resizable: true,
                    collapse_priority: None,
                });
                instance_index += 1;
            }
            outer.push(LayoutChildV1 {
                child: LayoutNodeV1::Container {
                    node_id: LayoutNodeId::new(format!("node:outer-{branch}")).unwrap(),
                    axis: LayoutAxisV1::Vertical,
                    children,
                },
                basis: LayoutBasisV1::Fraction { weight: 1 },
                resizable: true,
                collapse_priority: None,
            });
        }
        let LayoutNodeV1::Container {
            children: first_children,
            ..
        } = &mut outer[0].child
        else {
            panic!("fixture branch")
        };
        first_children.push(LayoutChildV1 {
            child: surface(
                &format!("node:surface-{instance_index}"),
                &format!("instance:{instance_index}"),
            ),
            basis: LayoutBasisV1::Auto,
            resizable: true,
            collapse_priority: None,
        });
        let mut scene = SceneStateV1 {
            scene_id: SceneId::new("scene:nodes").unwrap(),
            project_id: ProjectId::new("project:fixture").unwrap(),
            label: "Node boundary".to_string(),
            layout_revision: 1,
            root: LayoutNodeV1::Container {
                node_id: LayoutNodeId::new("node:node-budget-root").unwrap(),
                axis: LayoutAxisV1::Horizontal,
                children: outer,
            },
            focused_surface_instance_id: Some(SurfaceInstanceId::new("instance:0").unwrap()),
            utility_tray: None,
        };
        scene.validate().unwrap();

        let LayoutNodeV1::Container { children, .. } = &mut scene.root else {
            panic!("fixture root")
        };
        let LayoutNodeV1::Container {
            children: branch_children,
            ..
        } = &mut children[0].child
        else {
            panic!("fixture branch")
        };
        let previous = branch_children.remove(0);
        branch_children.insert(
            0,
            LayoutChildV1 {
                child: LayoutNodeV1::Container {
                    node_id: LayoutNodeId::new("node:one-too-many").unwrap(),
                    axis: LayoutAxisV1::Vertical,
                    children: vec![previous],
                },
                basis: LayoutBasisV1::Auto,
                resizable: true,
                collapse_priority: None,
            },
        );
        assert!(matches!(
            scene.validate(),
            Err(ContractError::LimitExceeded { path, .. }) if path == "scene.nodes"
        ));
    }
}
