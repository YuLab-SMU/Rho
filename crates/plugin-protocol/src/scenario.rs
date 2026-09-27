use crate::*;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};
use ts_rs::TS;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct ScenarioRevision {
    pub id: ScenarioRevisionId,
    pub parent: Option<ScenarioRevisionId>,
    pub scenario: ScenarioId,
    pub project: ProjectId,
    pub name: String,
    pub instances: BTreeMap<InstanceAlias, ScenarioInstance>,
    pub providers: Vec<ScenarioProvider>,
    pub layout: ScenarioLayout,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct ScenarioInstance {
    pub plugin: PluginId,
    pub revision: RevisionId,
    pub artifact: ArtifactId,
    pub configuration: Value,
    pub dependencies: BTreeMap<InstanceAlias, InstanceAlias>,
    /// Selected declarations remain configuration, not authority to activate.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    #[ts(as = "Option<_>", optional)]
    pub optional_capabilities: Vec<CapabilityKey>,
}

/// Save an immutable checkpoint and compare-and-swap this named scenario's head.
/// Project and principal are supplied by the Host, never by the request.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct SaveScenario {
    pub scenario: ScenarioId,
    pub expected_head: Option<ScenarioRevisionId>,
    pub name: String,
    pub instances: BTreeMap<InstanceAlias, ScenarioInstance>,
    pub providers: Vec<ScenarioProvider>,
    pub layout: ScenarioLayout,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct ScenarioRevisionArguments {
    pub revision: ScenarioRevisionId,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct ListScenarios {
    pub after: Option<ScenarioId>,
    #[schemars(range(min = 1, max = 100))]
    pub limit: u32,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct ScenarioSummary {
    pub scenario: ScenarioId,
    pub revision: ScenarioRevisionId,
    pub name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct ScenarioPage {
    #[schemars(length(max = 100))]
    pub scenarios: Vec<ScenarioSummary>,
    pub next: Option<ScenarioId>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct ScenarioProvider {
    pub capability: CapabilityKey,
    pub instance: InstanceAlias,
    pub target: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum ScenarioLayout {
    Empty,
    Split {
        id: NodeId,
        direction: SplitDirection,
        weights: Vec<f64>,
        children: Vec<ScenarioLayout>,
    },
    Tabs {
        id: NodeId,
        selected: Option<ViewInstanceId>,
        views: Vec<ScenarioView>,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "snake_case")]
pub enum SplitDirection {
    Horizontal,
    Vertical,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct ScenarioView {
    pub id: ViewInstanceId,
    pub instance: InstanceAlias,
    pub contribution: ContributionId,
    pub configuration: Value,
    pub state: Value,
    /// State is only opened under the exact revision that authored its schema.
    pub state_revision: RevisionId,
    pub resource: Option<ResourceReference>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct WindowScenario {
    pub window: WindowId,
    pub project: ProjectId,
    pub principal: PrincipalId,
    pub revision: ScenarioRevisionId,
    pub instances: BTreeMap<InstanceAlias, PluginInstanceId>,
}

impl ScenarioRevision {
    pub fn validate(&self) -> Result<(), ProtocolError> {
        bounded_text(&self.name, 128, "scenario name")?;
        require(
            self.instances.len() <= 256 && self.providers.len() <= 512,
            "scenario exceeds instance/provider limit",
        )?;
        for (alias, instance) in &self.instances {
            let mut grants = BTreeSet::new();
            require(instance.optional_capabilities.len() <= 512, "too many scenario optional capabilities")?;
            for capability in &instance.optional_capabilities {
                require(capability.version > 0 && grants.insert(capability), "invalid or duplicate scenario optional capability")?;
            }
            for target in instance.dependencies.values() {
                require(
                    target != alias && self.instances.contains_key(target),
                    "unresolved or self-referencing dependency",
                )?;
            }
        }
        fn visit<'a>(
            alias: &'a InstanceAlias,
            instances: &'a BTreeMap<InstanceAlias, ScenarioInstance>,
            active: &mut BTreeSet<&'a InstanceAlias>,
            done: &mut BTreeSet<&'a InstanceAlias>,
        ) -> Result<(), ProtocolError> {
            if done.contains(alias) {
                return Ok(());
            }
            require(active.insert(alias), "scenario dependency cycle")?;
            for target in instances[alias].dependencies.values() {
                visit(target, instances, active, done)?;
            }
            active.remove(alias);
            done.insert(alias);
            Ok(())
        }
        let mut done = BTreeSet::new();
        for alias in self.instances.keys() {
            visit(alias, &self.instances, &mut BTreeSet::new(), &mut done)?;
        }
        let mut providers = BTreeSet::new();
        for provider in &self.providers {
            require(
                provider.capability.version > 0 && providers.insert(&provider.capability),
                "ambiguous default provider",
            )?;
            require(
                self.instances.contains_key(&provider.instance),
                "provider instance is missing",
            )?;
            if let Some(target) = &provider.target {
                bounded_text(target, 1024, "provider target")?;
            }
        }
        fn layout(
            node: &ScenarioLayout,
            depth: usize,
            count: &mut usize,
            ids: &mut BTreeSet<String>,
            instances: &BTreeMap<InstanceAlias, ScenarioInstance>,
        ) -> Result<(), ProtocolError> {
            *count += 1;
            require(
                depth <= 32 && *count <= 1024,
                "layout exceeds depth or node limit",
            )?;
            match node {
                ScenarioLayout::Empty => (),
                ScenarioLayout::Split {
                    id,
                    weights,
                    children,
                    ..
                } => {
                    require(ids.insert(id.to_string()), "duplicate layout node identity")?;
                    require(
                        children.len() >= 2
                            && children.len() <= 32
                            && children.len() == weights.len()
                            && weights.iter().all(|w| w.is_finite() && *w > 0.0)
                            && weights.iter().sum::<f64>().is_finite(),
                        "invalid layout split",
                    )?;
                    for child in children {
                        layout(child, depth + 1, count, ids, instances)?;
                    }
                }
                ScenarioLayout::Tabs {
                    id,
                    selected,
                    views,
                } => {
                    require(
                        ids.insert(id.to_string()) && views.len() <= 256,
                        "duplicate group or excessive views",
                    )?;
                    if let Some(selected) = selected {
                        require(
                            views.iter().any(|v| &v.id == selected),
                            "selected view is missing",
                        )?;
                    }
                    for view in views {
                        *count += 1;
                        require(ids.insert(view.id.to_string()), "duplicate view identity")?;
                        let instance = instances
                            .get(&view.instance)
                            .ok_or_else(|| ProtocolError("view instance missing".into()))?;
                        require(
                            view.state_revision == instance.revision,
                            "view state belongs to another revision; explicitly open defaults",
                        )?;
                    }
                }
            }
            require(*count <= 1024, "layout exceeds node limit")
        }
        layout(&self.layout, 0, &mut 0, &mut BTreeSet::new(), &self.instances)
    }
}
