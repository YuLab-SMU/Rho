//! A scenario selects prepared owners. It never starts, reconnects, releases or
//! retargets one. Ordinary management plugins prepare through the public ports.
use crate::{
    PluginError, PluginRepository, PluginService, ensure, plugin_principal_id,
    service::{error, invalid},
};
use rho_contract::CallContext;
use rho_operation::OperationError;
use rho_plugin_protocol::*;
use rusqlite::{OptionalExtension, params};
use std::collections::{BTreeMap, BTreeSet};

pub(crate) fn fault(value: PluginError) -> OperationError {
    match value {
        PluginError::Conflict => OperationError::ContentChanged("window layout changed".into()),
        PluginError::Missing(id) => OperationError::NotFound(id),
        PluginError::Invalid(message) => invalid(message),
        PluginError::Contract(message) => invalid(message),
        other => error(other),
    }
}

fn layout(
    node: &ScenarioLayout,
    mapped: &BTreeMap<ViewInstanceId, ViewInstanceId>,
    definitions: &mut Vec<ScenarioView>,
) -> Result<PluginWindowNode, OperationError> {
    Ok(match node {
        ScenarioLayout::Empty => PluginWindowNode::Empty,
        ScenarioLayout::Split {
            id,
            direction,
            weights,
            children,
        } => PluginWindowNode::Split {
            id: id.clone(),
            direction: *direction,
            weights: weights.clone(),
            children: children
                .iter()
                .map(|n| layout(n, mapped, definitions))
                .collect::<Result<_, _>>()?,
        },
        ScenarioLayout::Tabs {
            id,
            selected,
            views,
        } => {
            let map = |id: &ViewInstanceId| {
                mapped
                    .get(id)
                    .cloned()
                    .ok_or_else(|| invalid("scenario view has no prepared identity"))
            };
            definitions.extend(views.iter().cloned());
            PluginWindowNode::Tabs {
                id: id.clone(),
                selected: selected.as_ref().map(map).transpose()?,
                views: views
                    .iter()
                    .map(|view| map(&view.id))
                    .collect::<Result<_, _>>()?,
            }
        }
    })
}

impl PluginRepository {
    pub fn window_scenario(
        &self,
        project: &ProjectId,
        principal: &PrincipalId,
        window: &WindowId,
    ) -> Result<WindowScenarioSnapshot, PluginError> {
        // One SQLite read snapshot also protects against a second catalog handle.
        let snapshot = self.connection.unchecked_transaction()?;
        let layout = crate::window_layout::observed(&snapshot, project, principal, window)?;
        let document: Option<String> = snapshot.query_row(
            "SELECT document FROM plugin_window_scenarios WHERE project=? AND principal=? AND window=?",
            params![project.as_str(), principal.as_str(), window.as_str()], |row| row.get(0)).optional()?;
        let scenario = document
            .map(|document| -> Result<WindowScenario, PluginError> {
                ensure(
                    document.len() <= MAX_CONTROL_BYTES / 4,
                    "stored window scenario exceeds metadata budget",
                )?;
                let value: WindowScenario = serde_json::from_str(&document)?;
                ensure(
                    &value.project == project
                        && &value.principal == principal
                        && &value.window == window
                        && value.applied_layout_version <= layout.version,
                    "window scenario differs from stored scope",
                )?;
                self.scenario_revision(project, principal, &value.revision)?;
                Ok(value)
            })
            .transpose()?;
        snapshot.commit()?;
        Ok(WindowScenarioSnapshot { scenario, layout })
    }
}

impl PluginService {
    /// Bounded observation of all exact prepared identities. The returned plan
    /// is not a reservation or authority; apply repeats the complete validation.
    pub(crate) fn prepare_scenario_application(
        &self,
        context: &CallContext,
        args: &ApplyScenario,
    ) -> Result<WindowScenarioSnapshot, OperationError> {
        self.check_window_context(context, &args.window)?;
        if serde_json::to_vec(args).map_err(invalid)?.len() > MAX_CONTROL_BYTES / 4 {
            return Err(invalid("scenario application exceeds 256 KiB"));
        }
        let principal = plugin_principal_id(context.principal());
        let (definition, current) = {
            let repo = self.repository.lock().unwrap();
            (
                repo.scenario_revision(&self.project, &principal, &args.revision)
                    .map_err(fault)?,
                repo.window_layout(&self.project, &principal, &args.window)
                    .map_err(fault)?,
            )
        };
        if current.version != args.expected_layout_version {
            return Err(fault(PluginError::Conflict));
        }
        if !args.instances.keys().eq(definition.instances.keys()) {
            return Err(invalid(
                "prepared instance aliases differ from the scenario",
            ));
        }
        let mut seen = BTreeSet::new();
        for (alias, chosen) in &args.instances {
            if !seen.insert(&chosen.instance) {
                return Err(invalid("scenario aliases must use distinct instances"));
            }
            let requested = &definition.instances[alias];
            let live = self.observe_instance(context, chosen, false)?;
            if live.instance.purpose != PluginInstancePurpose::Runtime {
                return Err(invalid("fixture previews cannot be applied as scenario runtime instances"));
            }
            if !live.observed_in_this_host
                || live.instance.state != InstanceState::Active
                || chosen.plugin != requested.plugin
                || chosen.revision != requested.revision
                || chosen.artifact != requested.artifact
                || live.instance.configuration != requested.configuration
            {
                return Err(invalid(
                    "prepared instance does not match the scenario's exact revision, artifact, configuration and Ready state",
                ));
            }
            let manifest = {
                let repo = self.repository.lock().unwrap();
                let artifact = repo.artifact(&chosen.artifact).map_err(fault)?;
                let manifest = repo.revision(&chosen.revision).map_err(fault)?.manifest;
                let target = if manifest.backend.is_some() {
                    crate::backend_target()
                } else {
                    "ui-web".into()
                };
                if manifest.id != chosen.plugin
                    || artifact.revision != chosen.revision
                    || artifact.target != target
                {
                    return Err(invalid("scenario artifact is incompatible with this Host"));
                }
                manifest
            };
            let selected = manifest
                .activation_requirements(&requested.optional_capabilities)
                .map_err(invalid)?;
            let frozen = self.runtime.view_grants(chosen).map_err(fault)?;
            let grants = |items: &[CapabilityRequirement]| {
                items
                    .iter()
                    .map(|g| (g.capability.clone(), g.scopes.clone()))
                    .collect::<BTreeMap<_, _>>()
            };
            if grants(&selected) != grants(&frozen)
                || frozen.iter().any(|g| !g.scopes.is_subset(&context.scopes))
            {
                return Err(invalid(
                    "prepared instance grants differ from the scenario or exceed caller authority",
                ));
            }
            if !requested
                .dependencies
                .keys()
                .eq(manifest.dependencies.keys())
            {
                return Err(invalid(
                    "scenario dependency bindings differ from the exact manifest",
                ));
            }
            for (name, dependency) in &manifest.dependencies {
                let selected = &definition.instances[&requested.dependencies[name]];
                if selected.plugin != dependency.plugin || selected.revision != dependency.revision
                {
                    return Err(invalid(
                        "scenario dependency is bound to the wrong plugin revision",
                    ));
                }
            }
        }
        let mut definitions = Vec::new();
        let next_layout = layout(&definition.layout, &args.views, &mut definitions)?;
        next_layout.view_ids().map_err(invalid)?;
        if definitions.len() != args.views.len() {
            return Err(invalid("prepared views differ from scenario definitions"));
        }
        for view in definitions {
            let id = &args.views[&view.id];
            let record = self.view_record(context, id)?;
            if record.closed
                || &record.view != id
                || record.project != self.project
                || record.principal != principal
                || record.window != args.window
                || record.instance != args.instances[&view.instance]
                || record.contribution != view.contribution
                || record.configuration != view.configuration
                || record.resource != view.resource
            {
                return Err(invalid(
                    "prepared view differs from the exact scenario definition",
                ));
            }
            // Validate saved state separately; the reused view's current state is
            // deliberately retained, even if it differs from the checkpoint.
            self.prepare_view(
                context,
                &OpenPluginView {
                    instance: record.instance,
                    contribution: record.contribution,
                    window: record.window,
                    configuration: record.configuration,
                    state: view.state,
                    resource: view.resource,
                },
            )?;
            let views = self.views.lock().unwrap();
            if !views.get(id).is_some_and(|live| live.closing.is_none()) {
                return Err(invalid(
                    "scenario view is closing or unavailable in this Host",
                ));
            }
        }
        let mut providers = Vec::new();
        for provider in definition.providers {
            let lease = self
                .runtime
                .resolve(
                    &provider.capability,
                    &self.project,
                    &principal,
                    Some(&args.instances[&provider.instance]),
                )
                .map_err(fault)?;
            providers.push(lease.binding(provider.target));
        }
        let version = current
            .version
            .checked_add(1)
            .ok_or_else(|| invalid("window layout version exhausted"))?;
        let scenario = WindowScenario {
            window: args.window.clone(),
            project: self.project.clone(),
            principal,
            revision: args.revision.clone(),
            applied_layout_version: version,
            instances: args.instances.clone(),
            views: args.views.clone(),
            providers,
        };
        let result = WindowScenarioSnapshot {
            scenario: Some(scenario),
            layout: PluginWindowLayout {
                layout: next_layout,
                version,
                ..current
            },
        };
        if serde_json::to_vec(&result).map_err(invalid)?.len() > MAX_CONTROL_BYTES / 4 {
            return Err(invalid("applied window composition exceeds 256 KiB"));
        }
        Ok(result)
    }

    pub(crate) fn apply_scenario(
        &self,
        context: &CallContext,
        args: &ApplyScenario,
    ) -> Result<WindowScenarioSnapshot, OperationError> {
        let prepared = self.prepare_scenario_application(context, args)?;
        let principal = plugin_principal_id(context.principal());
        // Same order as view dispatch: view channels, runtime states, catalog.
        let views = self.views.lock().unwrap();
        self.runtime.with_ready_instances(&args.instances, &self.project, &principal, || {
            for id in args.views.values() {
                ensure(views.get(id).is_some_and(|v| v.closing.is_none()), "scenario view is closing or unavailable")?;
            }
            let mut repo = self.repository.lock().unwrap();
            let transaction = repo.connection.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
            let saved = crate::window_layout::store_layout(&transaction, &self.project, &principal, UpdatePluginWindowLayout {
                window: args.window.clone(), expected_version: args.expected_layout_version, layout: prepared.layout.layout.clone(),
            })?;
            ensure(saved == prepared.layout, "prepared layout differs from committed layout")?;
            transaction.execute("INSERT INTO plugin_window_scenarios(project,principal,window,document) VALUES(?,?,?,?)
                ON CONFLICT(project,principal,window) DO UPDATE SET document=excluded.document",
                params![self.project.as_str(), principal.as_str(), args.window.as_str(), serde_json::to_string(prepared.scenario.as_ref().unwrap())?])?;
            transaction.commit()?;
            Ok(prepared)
        }).map_err(fault)
    }

    pub(crate) fn resolve_window_provider(
        &self,
        context: &CallContext,
        args: &ResolveWindowProvider,
    ) -> Result<ProviderBinding, OperationError> {
        self.check_window_context(context, &args.window)?;
        let principal = plugin_principal_id(context.principal());
        let observed = self
            .repository
            .lock()
            .unwrap()
            .window_scenario(&self.project, &principal, &args.window)
            .map_err(fault)?;
        let provider = observed
            .scenario
            .and_then(|scene| {
                scene
                    .providers
                    .into_iter()
                    .find(|p| p.capability == args.capability)
            })
            .ok_or_else(|| {
                OperationError::NotFound(
                    "window has no selected provider for this capability".into(),
                )
            })?;
        // A lost provider remains the selected identity in observations. Never
        // search for another provider or activate one as a fallback.
        let lease = self
            .runtime
            .resolve(
                &provider.capability,
                &self.project,
                &principal,
                Some(&provider.provider),
            )
            .map_err(fault)?;
        Ok(lease.binding(provider.target))
    }
}
