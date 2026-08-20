use std::collections::{BTreeMap, BTreeSet};

use petgraph::{Directed, Graph, algo::kosaraju_scc, visit::EdgeRef};

use crate::{
    ActivationPlan, BindingResolution, CapabilityId, ExtensionDiagnostic, ExtensionError,
    LimitKind, MAX_PLUGINS_PER_SCOPE, MAX_RESOLVED_EDGES, PluginDescriptor, PluginId,
    ProviderIdentity, RequirementBinding, RequirementKind, ScopeIdentity, ScopePolicy,
};

/// Resolve one scope without performing activation or any side effect.
pub fn resolve_activation_plan(
    policy: &ScopePolicy,
    scope: ScopeIdentity,
    parent_plan: Option<&ActivationPlan>,
    mut descriptors: Vec<PluginDescriptor>,
) -> Result<ActivationPlan, ExtensionError> {
    policy.validate_identity(&scope, parent_plan.map(ActivationPlan::scope))?;

    if descriptors.len() > MAX_PLUGINS_PER_SCOPE {
        return Err(ExtensionError::LimitExceeded {
            limit: LimitKind::PluginsPerScope,
            plugin_id: None,
            actual: descriptors.len(),
            maximum: MAX_PLUGINS_PER_SCOPE,
        });
    }

    for descriptor in &mut descriptors {
        descriptor.normalize();
    }
    descriptors.sort();

    if let Some(duplicate) = descriptors
        .windows(2)
        .find(|window| window[0].id == window[1].id)
    {
        return Err(ExtensionError::DuplicatePlugin {
            plugin_id: duplicate[0].id.clone(),
        });
    }

    for descriptor in &descriptors {
        descriptor.validate_for_scope(&scope.kind)?;
    }

    let mut effective_providers = parent_plan
        .map(|plan| plan.effective_providers().clone())
        .unwrap_or_default();
    let mut current_providers: BTreeMap<CapabilityId, Vec<ProviderIdentity>> = BTreeMap::new();

    for descriptor in &descriptors {
        for declaration in &descriptor.provides {
            current_providers
                .entry(declaration.capability_id.clone())
                .or_default()
                .push(ProviderIdentity {
                    plugin_id: descriptor.id.clone(),
                    scope: scope.clone(),
                    contract_major: declaration.contract_major,
                });
        }
    }

    for (capability_id, providers) in &mut current_providers {
        providers.sort();
        if providers.len() > 1 {
            return Err(ExtensionError::DuplicateProvider {
                capability_id: capability_id.clone(),
                providers: providers.clone(),
            });
        }
        if let Some(parent_provider) = effective_providers.get(capability_id) {
            let mut duplicate = vec![parent_provider.clone(), providers[0].clone()];
            duplicate.sort();
            return Err(ExtensionError::DuplicateProvider {
                capability_id: capability_id.clone(),
                providers: duplicate,
            });
        }
    }

    for (capability_id, providers) in current_providers {
        effective_providers.insert(capability_id, providers[0].clone());
    }

    let mut graph: Graph<PluginId, CapabilityId, Directed> = Graph::new();
    let mut node_by_plugin = BTreeMap::new();
    for descriptor in &descriptors {
        let node = graph.add_node(descriptor.id.clone());
        node_by_plugin.insert(descriptor.id.clone(), node);
    }

    let mut edge_count = 0_usize;
    let mut bindings = BTreeMap::new();
    let mut diagnostics = Vec::new();

    for descriptor in &descriptors {
        let mut requirements: Vec<_> = descriptor
            .requires
            .iter()
            .cloned()
            .map(|requirement| (requirement, RequirementKind::Required))
            .chain(
                descriptor
                    .optional
                    .iter()
                    .cloned()
                    .map(|requirement| (requirement, RequirementKind::Optional)),
            )
            .collect();
        requirements.sort_by(|left, right| {
            left.0
                .capability_id
                .cmp(&right.0.capability_id)
                .then_with(|| left.1.cmp(&right.1))
        });

        let mut plugin_bindings = Vec::with_capacity(requirements.len());
        for (requirement, kind) in requirements {
            let Some(provider) = effective_providers.get(&requirement.capability_id) else {
                if kind == RequirementKind::Required {
                    return Err(ExtensionError::MissingRequiredCapability {
                        plugin_id: descriptor.id.clone(),
                        capability_id: requirement.capability_id.clone(),
                        required_major: requirement.contract_major.get(),
                    });
                }

                diagnostics.push(ExtensionDiagnostic::optional_absent(
                    descriptor.id.clone(),
                    requirement.capability_id.clone(),
                    scope.id.clone(),
                ));
                plugin_bindings.push(RequirementBinding {
                    requirement,
                    kind,
                    resolution: BindingResolution::AbsentOptional,
                });
                continue;
            };

            if provider.contract_major != requirement.contract_major {
                return Err(ExtensionError::IncompatibleCapabilityMajor {
                    plugin_id: descriptor.id.clone(),
                    capability_id: requirement.capability_id.clone(),
                    required_major: requirement.contract_major.get(),
                    provided_major: provider.contract_major.get(),
                    provider_plugin_id: provider.plugin_id.clone(),
                });
            }

            edge_count += 1;
            if edge_count > MAX_RESOLVED_EDGES {
                return Err(ExtensionError::LimitExceeded {
                    limit: LimitKind::ResolvedEdges,
                    plugin_id: Some(descriptor.id.clone()),
                    actual: edge_count,
                    maximum: MAX_RESOLVED_EDGES,
                });
            }

            if provider.scope == scope {
                let provider_node = node_by_plugin[&provider.plugin_id];
                let consumer_node = node_by_plugin[&descriptor.id];
                graph.add_edge(
                    provider_node,
                    consumer_node,
                    requirement.capability_id.clone(),
                );
            }

            plugin_bindings.push(RequirementBinding {
                requirement,
                kind,
                resolution: BindingResolution::Provider {
                    provider: provider.clone(),
                },
            });
        }
        bindings.insert(descriptor.id.clone(), plugin_bindings);
    }

    if let Some(path) = canonical_cycle(&graph) {
        return Err(ExtensionError::DependencyCycle { path });
    }

    let activation_order = stable_kahn_order(&graph);
    debug_assert_eq!(activation_order.len(), descriptors.len());

    Ok(ActivationPlan::new(
        scope,
        activation_order,
        bindings,
        effective_providers,
        diagnostics,
    ))
}

fn stable_adjacency(
    graph: &Graph<PluginId, CapabilityId, Directed>,
) -> BTreeMap<PluginId, BTreeSet<PluginId>> {
    let mut adjacency: BTreeMap<PluginId, BTreeSet<PluginId>> = graph
        .node_weights()
        .cloned()
        .map(|plugin_id| (plugin_id, BTreeSet::new()))
        .collect();
    for edge in graph.edge_references() {
        let source = graph[edge.source()].clone();
        let target = graph[edge.target()].clone();
        adjacency.entry(source).or_default().insert(target);
    }
    adjacency
}

fn stable_kahn_order(graph: &Graph<PluginId, CapabilityId, Directed>) -> Vec<PluginId> {
    let adjacency = stable_adjacency(graph);
    let mut in_degree: BTreeMap<PluginId, usize> = adjacency
        .keys()
        .cloned()
        .map(|plugin_id| (plugin_id, 0))
        .collect();
    for targets in adjacency.values() {
        for target in targets {
            *in_degree
                .get_mut(target)
                .expect("every graph target must be a graph node") += 1;
        }
    }

    let mut ready: BTreeSet<_> = in_degree
        .iter()
        .filter(|(_, degree)| **degree == 0)
        .map(|(plugin_id, _)| plugin_id.clone())
        .collect();
    let mut order = Vec::with_capacity(in_degree.len());

    while let Some(plugin_id) = ready.pop_first() {
        order.push(plugin_id.clone());
        for dependent in &adjacency[&plugin_id] {
            let degree = in_degree
                .get_mut(dependent)
                .expect("every dependent must have an in-degree");
            *degree -= 1;
            if *degree == 0 {
                ready.insert(dependent.clone());
            }
        }
    }

    order
}

fn canonical_cycle(graph: &Graph<PluginId, CapabilityId, Directed>) -> Option<Vec<PluginId>> {
    let mut cyclic_components: Vec<Vec<PluginId>> = kosaraju_scc(graph)
        .into_iter()
        .filter_map(|component| {
            let cyclic = component.len() > 1
                || component
                    .first()
                    .is_some_and(|node| graph.find_edge(*node, *node).is_some());
            cyclic.then(|| {
                let mut plugins: Vec<_> = component
                    .into_iter()
                    .map(|node| graph[node].clone())
                    .collect();
                plugins.sort();
                plugins
            })
        })
        .collect();
    cyclic_components.sort();
    let component = cyclic_components.first()?;
    let start = component.first()?.clone();
    let allowed: BTreeSet<_> = component.iter().cloned().collect();
    let adjacency = stable_adjacency(graph);
    let mut path = vec![start.clone()];
    let mut on_path = BTreeSet::from([start.clone()]);
    find_closed_path(
        &start,
        &start,
        &allowed,
        &adjacency,
        &mut path,
        &mut on_path,
    )
}

fn find_closed_path(
    start: &PluginId,
    current: &PluginId,
    allowed: &BTreeSet<PluginId>,
    adjacency: &BTreeMap<PluginId, BTreeSet<PluginId>>,
    path: &mut Vec<PluginId>,
    on_path: &mut BTreeSet<PluginId>,
) -> Option<Vec<PluginId>> {
    for next in &adjacency[current] {
        if !allowed.contains(next) {
            continue;
        }
        if next == start {
            let mut closed = path.clone();
            closed.push(start.clone());
            return Some(closed);
        }
        if on_path.insert(next.clone()) {
            path.push(next.clone());
            if let Some(closed) = find_closed_path(start, next, allowed, adjacency, path, on_path) {
                return Some(closed);
            }
            path.pop();
            on_path.remove(next);
        }
    }
    None
}
