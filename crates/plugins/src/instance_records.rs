use crate::{PluginError, PluginRepository, ensure};
use rho_plugin_protocol::*;
use rusqlite::{OptionalExtension, params};

impl PluginRepository {
    /// All recorded lifecycle states matter, including unavailable and released
    /// owners whose scientific recovery references are interpreted elsewhere.
    pub fn instance_project_coverage(&self, project: &ProjectId, principal: &PrincipalId) -> Result<ProjectReadCoverage, PluginError> {
        let hidden: bool = self.connection.query_row(
            "SELECT EXISTS(SELECT 1 FROM plugin_instances WHERE json_extract(document,'$.project')=?1 AND json_extract(document,'$.principal') IS NOT ?2)",
            params![project.as_str(),principal.as_str()], |row|row.get(0))?;
        Ok(ProjectReadCoverage { all_visible: !hidden })
    }
    /// Generic lifecycle metadata, not a second scientific execution database.
    /// Register and retain in the same transaction before starting native code.
    pub(crate) fn register_instance(
        &mut self,
        instance: &PluginInstance,
    ) -> Result<(), PluginError> {
        ensure(
            instance.state == InstanceState::Preparing,
            "new instance must be preparing",
        )?;
        ensure(
            self.revision(&instance.identity.revision)?.manifest.id == instance.identity.plugin,
            "instance plugin identity mismatch",
        )?;
        ensure(
            self.artifact(&instance.identity.artifact)?.revision == instance.identity.revision,
            "instance artifact identity mismatch",
        )?;
        let transaction = self
            .connection
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        ensure(transaction.query_row("SELECT 1 FROM artifacts JOIN revisions ON artifacts.revision=revisions.id WHERE artifacts.id=? AND revisions.id=?",
            params![instance.identity.artifact.as_str(), instance.identity.revision.as_str()], |_| Ok(())).optional()?.is_some(),
            "instance artifact was removed before activation")?;
        transaction.execute(
            "INSERT INTO plugin_instances VALUES(?,?)",
            params![
                instance.identity.instance.as_str(),
                serde_json::to_string(instance)?
            ],
        )?;
        transaction.execute(
            "INSERT INTO revision_refs VALUES('instance',?,?)",
            params![
                instance.identity.instance.as_str(),
                instance.identity.revision.as_str()
            ],
        )?;
        transaction.commit()?;
        Ok(())
    }

    pub(crate) fn record_instance(&mut self, instance: &PluginInstance) -> Result<(), PluginError> {
        let transaction = self
            .connection
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        let old: String = transaction.query_row(
            "SELECT document FROM plugin_instances WHERE id=?",
            [instance.identity.instance.as_str()],
            |r| r.get(0),
        )?;
        let old: PluginInstance = serde_json::from_str(&old)?;
        ensure(
            old.identity == instance.identity
                && old.project == instance.project
                && old.principal == instance.principal
                && old.alias == instance.alias
                && old.configuration == instance.configuration,
            "immutable instance identity changed",
        )?;
        ensure(
            old.state != InstanceState::Released || instance.state == InstanceState::Released,
            "released instance cannot be resurrected",
        )?;
        transaction.execute(
            "UPDATE plugin_instances SET document=? WHERE id=?",
            params![
                serde_json::to_string(instance)?,
                instance.identity.instance.as_str()
            ],
        )?;
        if instance.state == InstanceState::Released {
            transaction.execute(
                "DELETE FROM revision_refs WHERE owner_kind='instance' AND owner=? AND revision=?",
                params![
                    instance.identity.instance.as_str(),
                    instance.identity.revision.as_str()
                ],
            )?;
        }
        transaction.commit()?;
        Ok(())
    }

    /// Stored state is historical evidence, not proof a process is currently
    /// alive. Observing does not reconnect or recover a prior Host's instances.
    pub fn recorded_instances(
        &self,
        after: Option<&PluginInstanceId>,
        limit: usize,
    ) -> Result<PluginInstancePage, PluginError> {
        self.recorded_instances_scoped(after, limit, None)
    }

    pub fn recorded_instance(&self, identity: &InstanceRef, project: &ProjectId, principal: &PrincipalId) -> Result<PluginInstance, PluginError> {
        let value: Option<String> = self.connection.query_row("SELECT document FROM plugin_instances WHERE id=?", [identity.instance.as_str()], |r| r.get(0)).optional()?;
        let record: PluginInstance = serde_json::from_str(&value.ok_or_else(|| PluginError::Missing(identity.instance.to_string()))?)?;
        ensure(record.identity == *identity && &record.project == project && &record.principal == principal, "instance is unavailable in this scope")?;
        Ok(record)
    }

    pub fn recorded_instances_scoped(&self, after: Option<&PluginInstanceId>, limit: usize, scope: Option<(&ProjectId, &PrincipalId)>) -> Result<PluginInstancePage, PluginError> {
        ensure(
            (1..=100).contains(&limit),
            "instance page size must be 1–100",
        )?;
        let snapshot = self.connection.unchecked_transaction()?;
        // An earlier foundation catalog may have no lifecycle records yet.
        let present = self
            .connection
            .query_row(
                "SELECT 1 FROM sqlite_master WHERE type='table' AND name='plugin_instances'",
                [],
                |_| Ok(()),
            )
            .optional()?
            .is_some();
        if !present {
            return Ok(PluginInstancePage {
                instances: vec![],
                next: None,
                total: 0,
            });
        }
        let mut instances = self.connection.prepare("SELECT document FROM plugin_instances WHERE (?1 IS NULL OR id>?1) AND (?3 IS NULL OR json_extract(document,'$.project')=?3) AND (?4 IS NULL OR json_extract(document,'$.principal')=?4) ORDER BY id LIMIT ?2")?
            .query_map(params![after.map(PluginInstanceId::as_str), (limit + 1) as u64, scope.map(|s|s.0.as_str()),scope.map(|s|s.1.as_str())], |r| r.get::<_, String>(0))?
            .collect::<Result<Vec<_>, _>>()?.into_iter().map(|s| serde_json::from_str::<PluginInstance>(&s)).collect::<Result<Vec<_>, _>>()?;
        let more = instances.len() > limit;
        instances.truncate(limit);
        let next = more.then(|| instances.last().unwrap().identity.instance.clone());
        let total =
            self.connection
                .query_row("SELECT count(*) FROM plugin_instances WHERE (?1 IS NULL OR json_extract(document,'$.project')=?1) AND (?2 IS NULL OR json_extract(document,'$.principal')=?2)", params![scope.map(|s|s.0.as_str()),scope.map(|s|s.1.as_str())], |r| r.get(0))?;
        snapshot.commit()?;
        Ok(PluginInstancePage {
            instances,
            next,
            total,
        })
    }
}

#[cfg(test)]
mod coverage_tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn project_coverage_includes_historical_states_without_disclosing_them() {
        let directory = tempfile::tempdir().unwrap();
        let repository = PluginRepository::open(&directory.path().join("packages")).unwrap();
        let project = ProjectId::new("project").unwrap();
        let principal = PrincipalId::new("principal").unwrap();
        assert!(repository.instance_project_coverage(&project,&principal).unwrap().all_visible);
        for (id,owner_project,owner,state) in [
            ("another-project","another-project","foreign","active"),
            ("own-active","project","principal","active"),
            ("own-failed","project","principal","failed"),
            ("own-released","project","principal","released"),
        ] {
            repository.connection.execute("INSERT INTO plugin_instances VALUES(?,?)",params![id,json!({"project":owner_project,"principal":owner,"state":state}).to_string()]).unwrap();
        }
        assert!(repository.instance_project_coverage(&project,&principal).unwrap().all_visible);
        for state in ["preparing","active","draining","failed","released"] {
            repository.connection.execute("INSERT INTO plugin_instances VALUES(?,?)",params!["foreign",json!({"project":"project","principal":"foreign-principal","state":state,"configuration":{"private":"hidden"}}).to_string()]).unwrap();
            let before:u64=repository.connection.query_row("SELECT total_changes()",[],|row|row.get(0)).unwrap();
            let coverage=repository.instance_project_coverage(&project,&principal).unwrap();
            assert_eq!(serde_json::to_value(coverage).unwrap(),json!({"all_visible":false}));
            let after:u64=repository.connection.query_row("SELECT total_changes()",[],|row|row.get(0)).unwrap();
            assert_eq!(before,after,"Coverage must not initialize or recover instances");
            repository.connection.execute("DELETE FROM plugin_instances WHERE id='foreign'",[]).unwrap();
        }
        assert!(repository.instance_project_coverage(&project,&principal).unwrap().all_visible);
    }
}
