//! Immutable, caller-scoped scenario metadata. No runtime or window is touched.
use crate::{PluginError, PluginRepository, ensure, package::document_digest};
use rho_plugin_protocol::*;
use rusqlite::{Connection, OptionalExtension, params};
use serde_json::json;
use std::collections::BTreeSet;

const MAX_SCENARIO_BYTES: usize = MAX_CONTROL_BYTES / 4;

pub(crate) fn initialize(connection: &Connection) -> Result<(), PluginError> {
    connection.execute_batch(
        "CREATE TABLE IF NOT EXISTS plugin_scenario_revisions(
            project TEXT NOT NULL, principal TEXT NOT NULL, id TEXT NOT NULL,
            scenario TEXT NOT NULL, document TEXT NOT NULL,
            PRIMARY KEY(project,principal,id));
         CREATE TABLE IF NOT EXISTS plugin_scenario_heads(
            project TEXT NOT NULL, principal TEXT NOT NULL, scenario TEXT NOT NULL,
            revision TEXT NOT NULL, name TEXT NOT NULL,
            PRIMARY KEY(project,principal,scenario),
            FOREIGN KEY(project,principal,revision)
              REFERENCES plugin_scenario_revisions(project,principal,id));",
    )?;
    Ok(())
}

pub fn scenario_digest(revision: &ScenarioRevision) -> Result<ScenarioRevisionId, PluginError> {
    Ok(ScenarioRevisionId::new(document_digest(&json!({
        "type":"rho.scenario.revision.v1", "project":revision.project,
        "scenario":revision.scenario, "parent":revision.parent, "name":revision.name,
        "instances":revision.instances, "providers":revision.providers, "layout":revision.layout,
    }))?)?)
}

fn head(
    connection: &Connection,
    project: &ProjectId,
    principal: &PrincipalId,
    scenario: &ScenarioId,
) -> Result<Option<ScenarioRevisionId>, PluginError> {
    let value: Option<String> = connection.query_row(
        "SELECT revision FROM plugin_scenario_heads WHERE project=? AND principal=? AND scenario=?",
        params![project.as_str(), principal.as_str(), scenario.as_str()], |row| row.get(0),
    ).optional()?;
    value
        .map(ScenarioRevisionId::new)
        .transpose()
        .map_err(Into::into)
}

fn revision(
    connection: &Connection,
    project: &ProjectId,
    principal: &PrincipalId,
    id: &ScenarioRevisionId,
) -> Result<ScenarioRevision, PluginError> {
    let stored: Option<(String, String)> = connection.query_row(
        "SELECT scenario,document FROM plugin_scenario_revisions WHERE project=? AND principal=? AND id=?",
        params![project.as_str(), principal.as_str(), id.as_str()], |row| Ok((row.get(0)?, row.get(1)?)),
    ).optional()?;
    let (scenario, document) = stored.ok_or_else(|| PluginError::Missing(id.to_string()))?;
    ensure(
        document.len() <= MAX_SCENARIO_BYTES,
        "stored scenario exceeds 256 KiB",
    )?;
    let value: ScenarioRevision = serde_json::from_str(&document)?;
    ensure(
        &value.project == project
            && value.scenario.as_str() == scenario
            && &value.id == id
            && scenario_digest(&value)? == *id,
        "scenario revision changed its stored identity",
    )?;
    value.validate()?;
    Ok(value)
}

fn prepared(
    connection: &Connection,
    project: &ProjectId,
    principal: &PrincipalId,
    args: &SaveScenario,
) -> Result<ScenarioRevision, PluginError> {
    ensure(
        serde_json::to_vec(args)?.len() <= MAX_SCENARIO_BYTES,
        "scenario exceeds 256 KiB",
    )?;
    let current = head(connection, project, principal, &args.scenario)?;
    if current != args.expected_head {
        return Err(PluginError::Conflict);
    }
    if let Some(id) = &current {
        ensure(
            revision(connection, project, principal, id)?.scenario == args.scenario,
            "scenario head belongs to another history",
        )?;
    }
    let mut value = ScenarioRevision {
        id: ScenarioRevisionId::new(format!("sha256:{}", "0".repeat(64)))?,
        parent: current,
        scenario: args.scenario.clone(),
        project: project.clone(),
        name: args.name.clone(),
        instances: args.instances.clone(),
        providers: args.providers.clone(),
        layout: args.layout.clone(),
    };
    value.validate()?;
    value.id = scenario_digest(&value)?;
    ensure(
        serde_json::to_vec(&value)?.len() <= MAX_SCENARIO_BYTES,
        "scenario exceeds 256 KiB",
    )?;
    Ok(value)
}

impl PluginRepository {
    /// Bounded metadata only; no manifest availability, native readiness or grants
    /// are inferred. Missing exact packages remain representable for later repair.
    pub fn scenario_revision(
        &self,
        project: &ProjectId,
        principal: &PrincipalId,
        id: &ScenarioRevisionId,
    ) -> Result<ScenarioRevision, PluginError> {
        revision(&self.connection, project, principal, id)
    }

    pub fn scenarios(
        &self,
        project: &ProjectId,
        principal: &PrincipalId,
        args: &ListScenarios,
    ) -> Result<ScenarioPage, PluginError> {
        ensure(
            (1..=100).contains(&args.limit),
            "scenario page limit must be 1–100",
        )?;
        let mut statement = self.connection.prepare(
            "SELECT scenario,revision,name FROM plugin_scenario_heads
             WHERE project=? AND principal=? AND scenario>? ORDER BY scenario LIMIT ?",
        )?;
        let rows = statement.query_map(
            params![
                project.as_str(),
                principal.as_str(),
                args.after.as_ref().map_or("", ScenarioId::as_str),
                args.limit + 1
            ],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                ))
            },
        )?;
        let mut values = rows
            .map(|row| {
                let (scenario, revision, name) = row?;
                ensure(
                    !name.trim().is_empty()
                        && name.len() <= 128
                        && !name.chars().any(char::is_control),
                    "stored scenario name is invalid",
                )?;
                Ok(ScenarioSummary {
                    scenario: ScenarioId::new(scenario)?,
                    revision: ScenarioRevisionId::new(revision)?,
                    name,
                })
            })
            .collect::<Result<Vec<_>, PluginError>>()?;
        let more = values.len() > args.limit as usize;
        values.truncate(args.limit as usize);
        Ok(ScenarioPage {
            next: more.then(|| values.last().unwrap().scenario.clone()),
            scenarios: values,
        })
    }

    pub fn prepare_scenario(
        &self,
        project: &ProjectId,
        principal: &PrincipalId,
        args: &SaveScenario,
    ) -> Result<ScenarioRevision, PluginError> {
        prepared(&self.connection, project, principal, args)
    }

    /// Native compare-and-swap and every protecting reference commit together.
    /// Earlier checkpoints keep their package references even after the head moves.
    pub fn save_scenario(
        &mut self,
        project: &ProjectId,
        principal: &PrincipalId,
        args: &SaveScenario,
    ) -> Result<ScenarioRevision, PluginError> {
        let transaction = self
            .connection
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        let value = prepared(&transaction, project, principal, args)?;
        transaction.execute(
            "INSERT INTO plugin_scenario_revisions VALUES(?,?,?,?,?)",
            params![
                project.as_str(),
                principal.as_str(),
                value.id.as_str(),
                value.scenario.as_str(),
                serde_json::to_string(&value)?
            ],
        )?;
        transaction.execute("INSERT INTO plugin_scenario_heads VALUES(?,?,?,?,?)
            ON CONFLICT(project,principal,scenario) DO UPDATE SET revision=excluded.revision,name=excluded.name",
            params![project.as_str(),principal.as_str(),value.scenario.as_str(),value.id.as_str(),value.name])?;
        let owner =
            document_digest(&json!({"project":project,"principal":principal,"revision":value.id}))?;
        let mut references: BTreeSet<_> = value
            .instances
            .values()
            .map(|instance| instance.revision.clone())
            .collect();
        fn resources(node: &ScenarioLayout, references: &mut BTreeSet<RevisionId>) {
            match node {
                ScenarioLayout::Empty => (),
                ScenarioLayout::Split { children, .. } => children
                    .iter()
                    .for_each(|child| resources(child, references)),
                ScenarioLayout::Tabs { views, .. } => {
                    for view in views {
                        if let Some(resource) = &view.resource {
                            references.insert(resource.owner.revision.clone());
                        }
                    }
                }
            }
        }
        resources(&value.layout, &mut references);
        for revision in references {
            transaction.execute(
                "INSERT OR IGNORE INTO revision_refs VALUES('scenario',?,?)",
                params![owner, revision.as_str()],
            )?;
        }
        transaction.commit()?;
        Ok(value)
    }
}
