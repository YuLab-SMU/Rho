use crate::*;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};
use ts_rs::TS;

/// Both the canvas and declaration editor modify this model. Custom source is
/// referenced by path; it is never reconstructed from a rendered component.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct VisualDocument {
    pub format_version: u32,
    pub root: NodeId,
    pub nodes: BTreeMap<NodeId, VisualNode>,
    pub data_sources: BTreeMap<ContributionId, VisualDataSource>,
    pub components: BTreeMap<ContributionId, CustomComponent>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "snake_case")]
pub enum VisualNodeKind {
    Container,
    Split,
    Tabs,
    Text,
    Button,
    Form,
    List,
    Table,
    Media,
    Custom,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct VisualNode {
    pub kind: VisualNodeKind,
    pub children: Vec<NodeId>,
    pub properties: BTreeMap<String, Value>,
    pub style_tokens: BTreeMap<String, String>,
    pub bindings: BTreeMap<String, DataBinding>,
    pub visible_when: Option<VisualCondition>,
    pub events: BTreeMap<String, Vec<VisualAction>>,
    pub component: Option<ContributionId>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct VisualDataSource {
    pub capability: CapabilityKey,
    pub arguments: Value,
    pub subscribe: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct DataBinding {
    pub source: ContributionId,
    /// Property path, interpreted without eval or executable expressions.
    pub path: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum VisualCondition {
    Exists { binding: DataBinding },
    Equals { binding: DataBinding, value: Value },
    Not { condition: Box<VisualCondition> },
    All { conditions: Vec<VisualCondition> },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum VisualAction {
    Invoke {
        capability: CapabilityKey,
        arguments: Value,
    },
    OpenView {
        contribution: ContributionId,
        resource: Option<DataBinding>,
    },
    SetState {
        key: String,
        value: Value,
    },
    Refresh {
        source: ContributionId,
    },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct CustomComponent {
    pub source: PackagePath,
    pub export: String,
    pub properties_schema: Value,
    pub input_schema: Value,
    pub output_schema: Value,
}

impl VisualDocument {
    pub fn validate(&self) -> Result<(), ProtocolError> {
        require(
            self.format_version == 1,
            "unsupported visual document format",
        )?;
        require(
            !self.nodes.is_empty() && self.nodes.len() <= MAX_VISUAL_NODES,
            "invalid visual node count",
        )?;
        require(
            self.data_sources.len() <= 256 && self.components.len() <= 128,
            "visual document exceeds source/component limit",
        )?;
        let mut visited = BTreeSet::new();
        self.visit(&self.root, 0, &mut visited)?;
        require(
            visited.len() == self.nodes.len(),
            "visual document contains unreachable nodes",
        )?;
        for component in self.components.values() {
            require(
                !component.source.is_artifact(),
                "custom component must reference source",
            )?;
            bounded_text(&component.export, 128, "component export")?;
            for schema in [
                &component.properties_schema,
                &component.input_schema,
                &component.output_schema,
            ] {
                schema_shape(schema)?;
            }
        }
        for source in self.data_sources.values() {
            require(
                source.capability.version > 0,
                "invalid data-source capability",
            )?;
        }
        Ok(())
    }
    fn visit<'a>(
        &'a self,
        id: &'a NodeId,
        depth: usize,
        visited: &mut BTreeSet<&'a NodeId>,
    ) -> Result<(), ProtocolError> {
        require(depth <= 64, "visual tree depth exceeds limit")?;
        require(
            visited.insert(id),
            "visual node has multiple parents or a cycle",
        )?;
        let node = self
            .nodes
            .get(id)
            .ok_or_else(|| ProtocolError("child node does not exist".into()))?;
        if node.kind == VisualNodeKind::Custom {
            require(
                node.component
                    .as_ref()
                    .is_some_and(|c| self.components.contains_key(c)),
                "custom component is missing",
            )?;
        } else {
            require(
                node.component.is_none(),
                "only custom nodes reference components",
            )?;
        }
        for binding in node.bindings.values() {
            self.binding(binding)?;
        }
        if let Some(condition) = &node.visible_when {
            self.condition(condition, 0)?;
        }
        for (event, actions) in &node.events {
            require(
                matches!(event.as_str(), "click" | "submit" | "change" | "select"),
                "actions require an explicit user event; render/mount is not an event",
            )?;
            require(actions.len() <= 32, "too many event actions")?;
            for action in actions {
                match action {
                    VisualAction::Invoke { capability, .. } => {
                        require(capability.version > 0, "invalid action capability")?
                    }
                    VisualAction::Refresh { source } => require(
                        self.data_sources.contains_key(source),
                        "unknown data source",
                    )?,
                    VisualAction::OpenView {
                        resource: Some(binding),
                        ..
                    } => self.binding(binding)?,
                    VisualAction::SetState { key, .. } => bounded_text(key, 128, "state key")?,
                    _ => (),
                }
            }
        }
        for child in &node.children {
            self.visit(child, depth + 1, visited)?;
        }
        Ok(())
    }
    fn binding(&self, binding: &DataBinding) -> Result<(), ProtocolError> {
        require(
            self.data_sources.contains_key(&binding.source),
            "binding source is missing",
        )?;
        require(
            binding.path.len() <= 32
                && binding.path.iter().all(|part| {
                    part.len() <= 256
                        && !matches!(part.as_str(), "__proto__" | "prototype" | "constructor")
                }),
            "invalid data binding path",
        )
    }
    fn condition(&self, condition: &VisualCondition, depth: usize) -> Result<(), ProtocolError> {
        require(depth <= 32, "condition exceeds depth limit")?;
        match condition {
            VisualCondition::Exists { binding } | VisualCondition::Equals { binding, .. } => {
                self.binding(binding)
            }
            VisualCondition::Not { condition } => self.condition(condition, depth + 1),
            VisualCondition::All { conditions } => {
                require(conditions.len() <= 32, "too many conditions")?;
                for child in conditions {
                    self.condition(child, depth + 1)?;
                }
                Ok(())
            }
        }
    }
}
