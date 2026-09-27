//! Scoped metadata for fresh development projects. Scientific results stay in
//! each project's ordinary Operation journal, never in this lifecycle table.
use crate::{PluginError, PluginRepository, ensure, plugin_project_id};
use rho_plugin_protocol::*;
use rusqlite::{Connection, OptionalExtension, params};
use std::collections::BTreeSet;

pub(crate) fn initialize(connection: &Connection) -> Result<(), PluginError> {
    connection.execute_batch("CREATE TABLE IF NOT EXISTS plugin_test_projects(id TEXT PRIMARY KEY, project TEXT NOT NULL, principal TEXT NOT NULL, version INTEGER NOT NULL, document TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS plugin_test_projects_scope ON plugin_test_projects(project,principal,id);")?;
    Ok(())
}

impl PluginRepository {
    /// Pure validation and deterministic dependency order. No instance or native
    /// directory is created, and optional declarations grant no new authority.
    pub fn validate_test_selection(
        &self,
        selection: &CreatePluginTestProject,
    ) -> Result<Vec<InstanceAlias>, PluginError> {
        selection.validate()?;
        for selected in selection.instances.values() {
            let revision = self.revision(&selected.revision)?;
            let artifact = self.artifact(&selected.artifact)?;
            let manifest = revision.manifest;
            ensure(
                manifest.id == selected.plugin && artifact.revision == selected.revision,
                "test selection has a different plugin, revision or artifact",
            )?;
            let target = if manifest.backend.is_some() {
                crate::backend_target()
            } else {
                "ui-web".into()
            };
            ensure(
                artifact.target == target,
                "test artifact cannot run on this Host",
            )?;
            manifest.activation_requirements(&selected.optional_capabilities)?;
            crate::runtime::validate_value(
                &manifest.configuration_schema,
                &selected.configuration,
                "configuration",
            )?;
            ensure(
                manifest
                    .dependencies
                    .keys()
                    .eq(selected.dependencies.keys()),
                "test dependency aliases differ from the manifest",
            )?;
            for (alias, dependency) in &manifest.dependencies {
                let chosen = &selection.instances[&selected.dependencies[alias]];
                ensure(
                    chosen.plugin == dependency.plugin && chosen.revision == dependency.revision,
                    "test dependency differs from its exact manifest pin",
                )?;
            }
        }
        let mut ordered = Vec::new();
        while ordered.len() < selection.instances.len() {
            let before = ordered.len();
            for (alias, selected) in &selection.instances {
                if !ordered.contains(alias)
                    && selected
                        .dependencies
                        .values()
                        .all(|dependency| ordered.contains(dependency))
                {
                    ordered.push(alias.clone());
                }
            }
            ensure(
                ordered.len() > before,
                "test dependency graph contains a cycle",
            )?;
        }
        Ok(ordered)
    }

    pub fn test_project_directory(&self, id: &TestProjectId) -> std::path::PathBuf {
        self.root()
            .join("test-projects-v1")
            .join(id.as_str())
            .join("project")
    }

    fn validate_test_record(&self, record: &PluginTestProject) -> Result<(), PluginError> {
        record.selection.validate()?;
        ensure(
            std::path::Path::new(&record.directory) == self.test_project_directory(&record.id),
            "test project directory differs from its managed identity",
        )?;
        ensure(
            record.project == plugin_project_id(&record.directory),
            "test project scope differs from its native directory",
        )?;
        ensure(
            record
                .diagnostic
                .as_ref()
                .is_none_or(|text| text.len() <= 8192),
            "test project diagnostic exceeds its budget",
        )?;
        ensure(
            record.version <= i64::MAX as u64,
            "test project version exceeds storage range",
        )?;
        ensure(
            serde_json::to_vec(record)?.len() <= MAX_CONTROL_BYTES / 2,
            "test project metadata exceeds 512 KiB",
        )?;
        for (alias, instance) in &record.instances {
            let selected = record
                .selection
                .instances
                .get(alias)
                .ok_or_else(|| PluginError::Invalid("test instance alias is absent".into()))?;
            ensure(
                instance.plugin == selected.plugin
                    && instance.revision == selected.revision
                    && instance.artifact == selected.artifact,
                "test instance differs from the original selection",
            )?;
            ensure(
                record.activation_operations.contains_key(alias),
                "test instance lacks its original activation Operation",
            )?;
        }
        ensure(
            record
                .activation_operations
                .keys()
                .all(|alias| record.selection.instances.contains_key(alias)),
            "test activation alias is absent",
        )?;
        if record.state == PluginTestProjectState::Ready {
            ensure(
                record.instances.len() == record.selection.instances.len(),
                "ready test project has incomplete instances",
            )?;
        }
        Ok(())
    }

    /// Called by the owning core handler before native project creation. Pins
    /// and the original identity enter the same transaction; no partial catalog.
    pub fn register_test_project(&mut self, record: &PluginTestProject) -> Result<(), PluginError> {
        self.validate_test_record(record)?;
        self.validate_test_selection(&record.selection)?;
        ensure(
            record.version == 0
                && record.state == PluginTestProjectState::Preparing
                && record.instances.is_empty()
                && record.activation_operations.is_empty()
                && record.diagnostic.is_none(),
            "new test project must be empty and preparing",
        )?;
        let revisions = record
            .selection
            .instances
            .values()
            .map(|selected| &selected.revision)
            .collect::<BTreeSet<_>>();
        let transaction = self
            .connection
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        for selected in record.selection.instances.values() {
            ensure(transaction.query_row("SELECT 1 FROM artifacts JOIN revisions ON artifacts.revision=revisions.id WHERE artifacts.id=? AND revisions.id=?",
                params![selected.artifact.as_str(),selected.revision.as_str()], |_|Ok(())).optional()?.is_some(), "test source was removed before admission")?;
        }
        transaction.execute(
            "INSERT INTO plugin_test_projects VALUES(?,?,?,?,?)",
            params![
                record.id.as_str(),
                record.source_project.as_str(),
                record.principal.as_str(),
                record.version,
                serde_json::to_string(record)?
            ],
        )?;
        for revision in revisions {
            transaction.execute(
                "INSERT INTO revision_refs VALUES('test_project',?,?)",
                params![record.id.as_str(), revision.as_str()],
            )?;
        }
        transaction.commit()?;
        Ok(())
    }

    pub fn recorded_test_project(
        &self,
        project: &ProjectId,
        principal: &PrincipalId,
        id: &TestProjectId,
    ) -> Result<PluginTestProject, PluginError> {
        let value: Option<String> = self.connection.query_row("SELECT document FROM plugin_test_projects WHERE id=? AND project=? AND principal=?", params![id.as_str(),project.as_str(),principal.as_str()], |row|row.get(0)).optional()?;
        let record: PluginTestProject =
            serde_json::from_str(&value.ok_or_else(|| PluginError::Missing(id.to_string()))?)?;
        ensure(
            &record.id == id && &record.source_project == project && &record.principal == principal,
            "test project metadata has a different identity",
        )?;
        self.validate_test_record(&record)?;
        Ok(record)
    }

    /// Native lifecycle CAS. Stopped is irreversible and releases source pins
    /// only together with the confirmed stopped record; evidence files remain.
    pub fn record_test_project(
        &mut self,
        expected_version: u64,
        record: &PluginTestProject,
    ) -> Result<(), PluginError> {
        self.validate_test_record(record)?;
        let transaction = self
            .connection
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        let original: Option<String> = transaction.query_row("SELECT document FROM plugin_test_projects WHERE id=? AND project=? AND principal=? AND version=?",
            params![record.id.as_str(),record.source_project.as_str(),record.principal.as_str(),expected_version], |row|row.get(0)).optional()?;
        let original: PluginTestProject =
            serde_json::from_str(&original.ok_or(PluginError::Conflict)?)?;
        ensure(
            record.version
                == expected_version
                    .checked_add(1)
                    .ok_or(PluginError::Conflict)?
                && record.source_operation_id == original.source_operation_id
                && record.project == original.project
                && record.directory == original.directory
                && record.selection == original.selection,
            "immutable test project identity changed",
        )?;
        ensure(
            original
                .instances
                .iter()
                .all(|(alias, instance)| record.instances.get(alias) == Some(instance))
                && original
                    .activation_operations
                    .iter()
                    .all(|(alias, operation)| {
                        record.activation_operations.get(alias) == Some(operation)
                    }),
            "test lifecycle cannot replace an original activation",
        )?;
        use PluginTestProjectState::*;
        ensure(
            matches!(
                (original.state, record.state),
                (Preparing, Preparing | Ready | Stopping | Failed)
                    | (Ready, Stopping | Failed)
                    | (Stopping, Stopping | Stopped | Failed)
                    | (Failed, Stopping | Failed)
            ),
            "invalid test project lifecycle transition",
        )?;
        let changed = transaction.execute(
            "UPDATE plugin_test_projects SET version=?,document=? WHERE id=? AND version=?",
            params![
                record.version,
                serde_json::to_string(record)?,
                record.id.as_str(),
                expected_version
            ],
        )?;
        ensure(changed == 1, "test project lifecycle was not persisted")?;
        if record.state == Stopped {
            transaction.execute(
                "DELETE FROM revision_refs WHERE owner_kind='test_project' AND owner=?",
                [record.id.as_str()],
            )?;
        }
        transaction.commit()?;
        Ok(())
    }

    pub fn recorded_test_projects(
        &self,
        project: &ProjectId,
        principal: &PrincipalId,
        arguments: &ListPluginTestProjects,
    ) -> Result<PluginTestProjectPage, PluginError> {
        ensure(
            (1..=100).contains(&arguments.limit),
            "test project page size must be 1–100",
        )?;
        let mut statement = self.connection.prepare("SELECT document FROM plugin_test_projects WHERE project=?1 AND principal=?2 AND (?3 IS NULL OR id>?3) ORDER BY id LIMIT ?4")?;
        let values = statement.query_map(
            params![
                project.as_str(),
                principal.as_str(),
                arguments.after.as_ref().map(TestProjectId::as_str),
                arguments.limit + 1
            ],
            |row| row.get::<_, String>(0),
        )?;
        let mut records = Vec::new();
        let mut bytes = 1024; // Reserve the page/cursor envelope in the public frame.
        let mut more = false;
        for value in values {
            let value = value?;
            if records.len() == arguments.limit as usize
                || (!records.is_empty() && bytes + value.len() + 64 > MAX_CONTROL_BYTES * 3 / 4)
            {
                more = true;
                break;
            }
            bytes += value.len() + 64;
            let record: PluginTestProject = serde_json::from_str(&value)?;
            ensure(
                &record.source_project == project && &record.principal == principal,
                "test page has a foreign scope",
            )?;
            self.validate_test_record(&record)?;
            records.push(PluginTestProjectObservation {
                project: record,
                observed_in_this_host: false,
            });
        }
        let next = more.then(|| records.last().unwrap().project.id.clone());
        Ok(PluginTestProjectPage {
            projects: records,
            next,
        })
    }
}
