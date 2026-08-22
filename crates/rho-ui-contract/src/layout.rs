use std::collections::BTreeSet;

use serde::{Deserialize, Serialize};

use crate::{
    ContractError, LayoutNodeId, SceneId, SurfaceInstanceId, Validate, encoded_json_len,
    ensure_revision, next_revision, validate_label,
};

pub const MAX_SCENE_JSON_BYTES: usize = 1024 * 1024;
pub const MAX_LAYOUT_DEPTH: usize = 32;
pub const MAX_LAYOUT_NODES: usize = 256;
pub const MAX_SURFACE_PLACEMENTS: usize = 128;
pub const MAX_CONTAINER_CHILDREN: usize = 64;
pub const MAX_LAYOUT_LOGICAL_PIXELS: u32 = 100_000;
pub const MAX_LAYOUT_FRACTION_WEIGHT: u16 = 10_000;

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
    pub label: String,
    pub layout_revision: u64,
    pub root: LayoutNodeV1,
    pub focused_surface_instance_id: Option<SurfaceInstanceId>,
    pub utility_tray: Option<StackNodeV1>,
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
