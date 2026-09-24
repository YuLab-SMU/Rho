//! A window's presentation references live view identities, independently of a
//! scenario's reusable view definitions. Reading it never recreates those views.
use crate::*;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;
use ts_rs::TS;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum PluginWindowNode {
    Empty,
    Split {
        id: NodeId,
        direction: SplitDirection,
        weights: Vec<f64>,
        children: Vec<PluginWindowNode>,
    },
    Tabs {
        id: NodeId,
        selected: Option<ViewInstanceId>,
        views: Vec<ViewInstanceId>,
    },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct PluginWindowLayout {
    pub window: WindowId,
    pub project: ProjectId,
    pub principal: PrincipalId,
    /// Changes only when this window's presentation is explicitly saved.
    pub version: u32,
    pub layout: PluginWindowNode,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct PluginWindowArguments {
    pub window: WindowId,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct UpdatePluginWindowLayout {
    pub window: WindowId,
    pub expected_version: u32,
    pub layout: PluginWindowNode,
}

impl PluginWindowNode {
    /// Return a bounded, duplicate-free set for scoped owner validation.
    pub fn view_ids(&self) -> Result<BTreeSet<ViewInstanceId>, ProtocolError> {
        fn visit(
            node: &PluginWindowNode,
            depth: usize,
            count: &mut usize,
            nodes: &mut BTreeSet<String>,
            views: &mut BTreeSet<ViewInstanceId>,
        ) -> Result<(), ProtocolError> {
            *count += 1;
            require(
                depth <= 32 && *count <= 1024,
                "window layout exceeds its node/depth limit",
            )?;
            match node {
                PluginWindowNode::Empty => (),
                PluginWindowNode::Split {
                    id,
                    direction: _,
                    weights,
                    children,
                } => {
                    require(nodes.insert(id.to_string()), "duplicate window layout node")?;
                    require(
                        children.len() >= 2
                            && children.len() <= 32
                            && children.len() == weights.len()
                            && weights
                                .iter()
                                .all(|weight| weight.is_finite() && *weight > 0.0)
                            && weights.iter().sum::<f64>().is_finite(),
                        "invalid window layout split",
                    )?;
                    for child in children {
                        visit(child, depth + 1, count, nodes, views)?;
                    }
                }
                PluginWindowNode::Tabs {
                    id,
                    selected,
                    views: tabs,
                } => {
                    require(nodes.insert(id.to_string()), "duplicate window layout node")?;
                    require(tabs.len() <= 256, "too many views in a window group")?;
                    require(
                        selected.as_ref().is_none_or(|value| tabs.contains(value)),
                        "selected window view is missing",
                    )?;
                    for view in tabs {
                        require(
                            nodes.insert(view.to_string())
                                && views.insert(view.clone())
                                && views.len() <= 256,
                            "duplicate or excessive window views",
                        )?;
                    }
                }
            }
            Ok(())
        }
        let mut views = BTreeSet::new();
        visit(self, 0, &mut 0, &mut BTreeSet::new(), &mut views)?;
        Ok(views)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn tabs(id: &str, view: &str) -> PluginWindowNode {
        PluginWindowNode::Tabs {
            id: NodeId::new(id).unwrap(),
            selected: Some(ViewInstanceId::new(view).unwrap()),
            views: vec![ViewInstanceId::new(view).unwrap()],
        }
    }
    #[test]
    fn window_layout_rejects_duplicates_missing_selection_and_invalid_weights() {
        let mut layout = PluginWindowNode::Split {
            id: NodeId::new("root").unwrap(),
            direction: SplitDirection::Horizontal,
            weights: vec![1.0, 2.0],
            children: vec![tabs("left", "one"), tabs("right", "two")],
        };
        assert_eq!(layout.view_ids().unwrap().len(), 2);
        if let PluginWindowNode::Split { weights, .. } = &mut layout {
            weights[1] = f64::MAX;
            weights[0] = f64::MAX;
        }
        assert!(layout.view_ids().is_err());
        if let PluginWindowNode::Split {
            weights, children, ..
        } = &mut layout
        {
            *weights = vec![1.0, 1.0];
            children[1] = tabs("right", "one");
        }
        assert!(layout.view_ids().is_err());
        let mut missing = tabs("group", "one");
        if let PluginWindowNode::Tabs { views, .. } = &mut missing {
            views.clear();
        }
        assert!(missing.view_ids().is_err());
    }
    #[test]
    fn empty_nodes_also_count_towards_window_layout_bounds() {
        let node = PluginWindowNode::Split {
            id: NodeId::new("deep").unwrap(),
            direction: SplitDirection::Vertical,
            weights: vec![1.0; 32],
            children: vec![PluginWindowNode::Empty; 32],
        };
        let layout = PluginWindowNode::Split {
            id: NodeId::new("root").unwrap(),
            direction: SplitDirection::Vertical,
            weights: vec![1.0; 32],
            children: (0..32)
                .map(|n| {
                    let mut child = node.clone();
                    if let PluginWindowNode::Split { id, .. } = &mut child {
                        *id = NodeId::new(format!("child-{n}")).unwrap();
                    }
                    child
                })
                .collect(),
        };
        assert!(
            layout
                .view_ids()
                .unwrap_err()
                .to_string()
                .contains("node/depth")
        );
    }
}
