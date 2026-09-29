use rho_application::{
    ApplicationError, ApplicationRepository, ApplicationScope, ApplicationStoreChanges,
    StoredCommand, StoredWindow,
};
use rho_contract::ApplicationState;
use rusqlite::{Connection, OptionalExtension, TransactionBehavior, params};
use std::{path::Path, sync::Mutex, time::Duration};

/// Local application state, never part of the scientific journal or outbox.
pub struct ApplicationStore(pub(crate) Mutex<Connection>, pub(crate) rho_agent_store::AgentStore, pub(crate) rho_annotation_store::AnnotationStore);

impl ApplicationStore {
    pub fn open(path: &Path) -> Result<Self, String> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(err)?;
        }
        let connection = Connection::open(path).map_err(err)?;
        connection
            .busy_timeout(Duration::from_secs(5))
            .map_err(err)?;
        connection
            .execute_batch(
                "PRAGMA synchronous = FULL;
            CREATE TABLE IF NOT EXISTS application_state (
                scope TEXT NOT NULL, key TEXT NOT NULL, version TEXT NOT NULL,
                value TEXT NOT NULL CHECK(json_valid(value)), PRIMARY KEY(scope,key));
            CREATE TABLE IF NOT EXISTS application_windows (
                project TEXT NOT NULL, principal TEXT NOT NULL, window_id TEXT NOT NULL,
                revision TEXT NOT NULL, value TEXT NOT NULL CHECK(json_valid(value)),
                PRIMARY KEY(project,principal,window_id));
            CREATE TABLE IF NOT EXISTS application_documents (
                project TEXT NOT NULL, principal TEXT NOT NULL, window_id TEXT NOT NULL,
                document_id TEXT NOT NULL, value TEXT NOT NULL CHECK(json_valid(value)),
                PRIMARY KEY(project,principal,window_id,document_id));
            CREATE TABLE IF NOT EXISTS application_commands (
                project TEXT NOT NULL, principal TEXT NOT NULL, window_id TEXT NOT NULL,
                request_id TEXT NOT NULL, value TEXT NOT NULL CHECK(json_valid(value)),
                PRIMARY KEY(project,principal,window_id,request_id));
            CREATE TABLE IF NOT EXISTS application_method_bindings (
                project TEXT NOT NULL, principal TEXT NOT NULL, binding_id TEXT NOT NULL,
                version TEXT NOT NULL, value TEXT NOT NULL CHECK(json_valid(value)),
                PRIMARY KEY(project,principal,binding_id));
            CREATE TABLE IF NOT EXISTS application_skill_reads (
                project TEXT NOT NULL, principal TEXT NOT NULL, receipt_key TEXT NOT NULL,
                external_task_ref TEXT, value TEXT NOT NULL CHECK(json_valid(value)),
                PRIMARY KEY(project,principal,receipt_key));",
            )
            .map_err(err)?;
        crate::runtime_instances::initialize(&connection)?;
        // The new Agent namespace never reads or imports the previous Application tables.
        let agents = rho_agent_store::AgentStore::open(&path.with_extension("agent-v1.sqlite"))?;
        // No migration or reads of the former core-owned annotation tables.
        let annotations = rho_annotation_store::AnnotationStore::open(&path.with_extension("annotations-v1.sqlite"))?;
        Ok(Self(Mutex::new(connection), agents, annotations))
    }

    pub fn read(&self, scope: &str, key: &str) -> Result<ApplicationState, String> {
        validate(scope, key)?;
        let connection = self.0.lock().map_err(err)?;
        let row: Option<(String, String)> = connection
            .query_row(
                "SELECT version,value FROM application_state WHERE scope=?1 AND key=?2",
                params![scope, key],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()
            .map_err(err)?;
        match row {
            Some((version, value)) => Ok(ApplicationState {
                key: key.into(),
                version: Some(version),
                value: serde_json::from_str(&value).map_err(err)?,
            }),
            None => Ok(ApplicationState {
                key: key.into(),
                version: None,
                value: serde_json::Value::Null,
            }),
        }
    }

    pub fn write(&self, scope: &str, state: &ApplicationState) -> Result<ApplicationState, String> {
        validate(scope, &state.key)?;
        let value = serde_json::to_string(&state.value).map_err(err)?;
        if value.len() > 2 * 1024 * 1024 {
            return Err("application state exceeds 2 MiB; draft was not saved".into());
        }
        let mut connection = self.0.lock().map_err(err)?;
        let tx = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(err)?;
        let previous: Option<String> = tx
            .query_row(
                "SELECT version FROM application_state WHERE scope=?1 AND key=?2",
                params![scope, state.key],
                |r| r.get(0),
            )
            .optional()
            .map_err(err)?;
        if previous != state.version {
            return Err(
                "application state changed in another window; local draft was not overwritten"
                    .into(),
            );
        }
        let version = uuid::Uuid::new_v4().to_string();
        tx.execute(
            "INSERT INTO application_state(scope,key,version,value) VALUES(?1,?2,?3,?4)
            ON CONFLICT(scope,key) DO UPDATE SET version=excluded.version,value=excluded.value",
            params![scope, state.key, version, value],
        )
        .map_err(err)?;
        tx.commit().map_err(err)?;
        Ok(ApplicationState {
            key: state.key.clone(),
            version: Some(version),
            value: state.value.clone(),
        })
    }
}

impl ApplicationRepository for ApplicationStore {
    fn windows(&self, scope: &ApplicationScope) -> Result<Vec<StoredWindow>, ApplicationError> {
        let connection = self.0.lock().map_err(app_err)?;
        let mut statement = connection.prepare("SELECT value FROM application_windows WHERE project=?1 AND principal=?2 ORDER BY window_id").map_err(app_err)?;
        let rows = statement
            .query_map(params![scope.project, scope.principal], |r| {
                r.get::<_, String>(0)
            })
            .map_err(app_err)?;
        rows.map(|r| serde_json::from_str(&r.map_err(app_err)?).map_err(app_err))
            .collect()
    }
    fn window(
        &self,
        scope: &ApplicationScope,
        window_id: &str,
    ) -> Result<Option<StoredWindow>, ApplicationError> {
        let connection = self.0.lock().map_err(app_err)?;
        let value = connection.query_row("SELECT value FROM application_windows WHERE project=?1 AND principal=?2 AND window_id=?3",
            params![scope.project, scope.principal, window_id], |r| r.get::<_, String>(0)).optional().map_err(app_err)?;
        value
            .map(|v| serde_json::from_str(&v).map_err(app_err))
            .transpose()
    }
    fn documents(
        &self,
        scope: &ApplicationScope,
        window_id: &str,
    ) -> Result<Vec<rho_contract::ApplicationDocument>, ApplicationError> {
        let connection = self.0.lock().map_err(app_err)?;
        let mut statement = connection.prepare("SELECT value FROM application_documents WHERE project=?1 AND principal=?2 AND window_id=?3 ORDER BY document_id").map_err(app_err)?;
        let rows = statement
            .query_map(params![scope.project, scope.principal, window_id], |r| {
                r.get::<_, String>(0)
            })
            .map_err(app_err)?;
        rows.map(|r| serde_json::from_str(&r.map_err(app_err)?).map_err(app_err))
            .collect()
    }
    fn command(
        &self,
        scope: &ApplicationScope,
        window_id: &str,
        request_id: &str,
    ) -> Result<Option<StoredCommand>, ApplicationError> {
        let connection = self.0.lock().map_err(app_err)?;
        let value = connection.query_row("SELECT value FROM application_commands WHERE project=?1 AND principal=?2 AND window_id=?3 AND request_id=?4",
            params![scope.project, scope.principal, window_id, request_id], |r| r.get::<_, String>(0)).optional().map_err(app_err)?;
        value
            .map(|v| serde_json::from_str(&v).map_err(app_err))
            .transpose()
    }
    fn commands(
        &self,
        scope: &ApplicationScope,
        window_id: &str,
    ) -> Result<Vec<StoredCommand>, ApplicationError> {
        let connection = self.0.lock().map_err(app_err)?;
        let mut statement = connection.prepare("SELECT value FROM application_commands WHERE project=?1 AND principal=?2 AND window_id=?3 ORDER BY request_id").map_err(app_err)?;
        let rows = statement
            .query_map(params![scope.project, scope.principal, window_id], |r| {
                r.get::<_, String>(0)
            })
            .map_err(app_err)?;
        rows.map(|r| serde_json::from_str(&r.map_err(app_err)?).map_err(app_err))
            .collect()
    }
    fn commit(
        &self,
        scope: &ApplicationScope,
        expected_revision: Option<&str>,
        window: &StoredWindow,
        changes: &ApplicationStoreChanges,
    ) -> Result<(), ApplicationError> {
        // Serialize before opening the transaction: neither a malformed draft nor
        // a failed receipt encoding can leave half of an application command.
        let window_json = serde_json::to_string(window).map_err(app_err)?;
        let documents = changes
            .documents
            .iter()
            .map(|d| Ok((&d.document_id, serde_json::to_string(d).map_err(app_err)?)))
            .collect::<Result<Vec<_>, ApplicationError>>()?;
        let commands = changes
            .commands
            .iter()
            .map(|c| {
                Ok((
                    &c.request.request_id,
                    serde_json::to_string(c).map_err(app_err)?,
                ))
            })
            .collect::<Result<Vec<_>, ApplicationError>>()?;
        let mut connection = self.0.lock().map_err(app_err)?;
        let tx = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(app_err)?;
        let previous: Option<String> = tx.query_row("SELECT revision FROM application_windows WHERE project=?1 AND principal=?2 AND window_id=?3",
            params![scope.project, scope.principal, window.window.window_id], |r| r.get(0)).optional().map_err(app_err)?;
        if previous.as_deref() != expected_revision {
            return Err(ApplicationError::Conflict);
        }
        tx.execute("INSERT INTO application_windows(project,principal,window_id,revision,value) VALUES(?1,?2,?3,?4,?5)
            ON CONFLICT(project,principal,window_id) DO UPDATE SET revision=excluded.revision,value=excluded.value",
            params![scope.project, scope.principal, window.window.window_id, window.revision, window_json]).map_err(app_err)?;
        for (id, value) in documents {
            tx.execute("INSERT INTO application_documents(project,principal,window_id,document_id,value) VALUES(?1,?2,?3,?4,?5)
                ON CONFLICT(project,principal,window_id,document_id) DO UPDATE SET value=excluded.value",
                params![scope.project, scope.principal, window.window.window_id, id, value]).map_err(app_err)?;
        }
        for id in &changes.removed_document_ids {
            tx.execute("DELETE FROM application_documents WHERE project=?1 AND principal=?2 AND window_id=?3 AND document_id=?4",
                params![scope.project, scope.principal, window.window.window_id, id]).map_err(app_err)?;
        }
        for (id, value) in commands {
            tx.execute("INSERT INTO application_commands(project,principal,window_id,request_id,value) VALUES(?1,?2,?3,?4,?5)
                ON CONFLICT(project,principal,window_id,request_id) DO UPDATE SET value=excluded.value",
                params![scope.project, scope.principal, window.window.window_id, id, value]).map_err(app_err)?;
        }
        tx.commit().map_err(app_err)
    }
    fn method_bindings(
        &self,
        scope: &ApplicationScope,
    ) -> Result<Vec<rho_contract::ApplicationMethodBinding>, ApplicationError> {
        let connection = self.0.lock().map_err(app_err)?;
        let mut statement = connection.prepare("SELECT value FROM application_method_bindings WHERE project=?1 AND principal=?2 ORDER BY binding_id").map_err(app_err)?;
        let rows = statement
            .query_map(params![scope.project, scope.principal], |r| {
                r.get::<_, String>(0)
            })
            .map_err(app_err)?;
        rows.map(|r| serde_json::from_str(&r.map_err(app_err)?).map_err(app_err))
            .collect()
    }
    fn write_method_binding(
        &self,
        scope: &ApplicationScope,
        expected_version: Option<&str>,
        binding: &rho_contract::ApplicationMethodBinding,
    ) -> Result<(), ApplicationError> {
        let value = serde_json::to_string(binding).map_err(app_err)?;
        let mut connection = self.0.lock().map_err(app_err)?;
        let tx = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(app_err)?;
        let previous: Option<String> = tx.query_row("SELECT version FROM application_method_bindings WHERE project=?1 AND principal=?2 AND binding_id=?3",
            params![scope.project, scope.principal, binding.binding_id], |r| r.get(0)).optional().map_err(app_err)?;
        if previous.as_deref() != expected_version {
            return Err(ApplicationError::Conflict);
        }
        tx.execute("INSERT INTO application_method_bindings(project,principal,binding_id,version,value) VALUES(?1,?2,?3,?4,?5)
            ON CONFLICT(project,principal,binding_id) DO UPDATE SET version=excluded.version,value=excluded.value",
            params![scope.project, scope.principal, binding.binding_id, binding.version, value]).map_err(app_err)?;
        tx.commit().map_err(app_err)
    }
    fn record_skill_read(
        &self,
        scope: &ApplicationScope,
        receipt: &rho_contract::ApplicationSkillReadReceipt,
    ) -> Result<(), ApplicationError> {
        // Re-reading exactly the same resource for the same task refreshes its
        // observation time. A changed digest remains a distinct recorded resource.
        let value = serde_json::to_string(receipt).map_err(app_err)?;
        let key = rho_application::sha256(
            serde_json::to_vec(&(
                &receipt.working_directory,
                &receipt.skill_ref,
                &receipt.source_ref,
                &receipt.resource_ref,
                &receipt.sha256,
                &receipt.external_task_ref,
            ))
            .map_err(app_err)?,
        );
        let mut connection = self.0.lock().map_err(app_err)?;
        let tx = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(app_err)?;
        let existing: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM application_skill_reads WHERE project=?1 AND principal=?2 AND receipt_key=?3)", params![scope.project, scope.principal, key], |r| r.get(0)).map_err(app_err)?;
        let count: usize = tx
            .query_row(
                "SELECT count(*) FROM application_skill_reads WHERE project=?1 AND principal=?2",
                params![scope.project, scope.principal],
                |r| r.get(0),
            )
            .map_err(app_err)?;
        if !existing && count >= 10_000 {
            return Err(ApplicationError::Budget(
                "10000 recorded Skill resources per principal/project".into(),
            ));
        }
        tx.execute("INSERT INTO application_skill_reads(project,principal,receipt_key,external_task_ref,value) VALUES(?1,?2,?3,?4,?5)
            ON CONFLICT(project,principal,receipt_key) DO UPDATE SET value=excluded.value", params![scope.project, scope.principal, key, receipt.external_task_ref, value]).map_err(app_err)?;
        tx.commit().map_err(app_err)
    }
    fn skill_reads(
        &self,
        scope: &ApplicationScope,
        task: Option<&str>,
    ) -> Result<Vec<rho_contract::ApplicationSkillReadReceipt>, ApplicationError> {
        let connection = self.0.lock().map_err(app_err)?;
        let mut statement = connection.prepare("SELECT value FROM application_skill_reads WHERE project=?1 AND principal=?2 AND (?3 IS NULL OR external_task_ref=?3) ORDER BY receipt_key").map_err(app_err)?;
        let rows = statement
            .query_map(params![scope.project, scope.principal, task], |r| {
                r.get::<_, String>(0)
            })
            .map_err(app_err)?;
        rows.map(|r| serde_json::from_str(&r.map_err(app_err)?).map_err(app_err))
            .collect()
    }
}
fn app_err(error: impl std::fmt::Display) -> ApplicationError {
    ApplicationError::Storage(error.to_string())
}

fn err(error: impl std::fmt::Display) -> String {
    error.to_string()
}
fn validate(scope: &str, key: &str) -> Result<(), String> {
    if scope.len() > 4096
        || key.is_empty()
        || key.len() > 160
        || !key
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b))
    {
        return Err("invalid application state key or scope".into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use rho_application::ApplicationOwner;
    use rho_contract::*;
    use std::sync::Arc;

    fn context() -> CallContext {
        CallContext {
            view_scope: None,
            caller: CallerIdentity {
                kind: CallerKind::Human,
                id: "local".into(),
            },
            principal: None,
            scopes: Default::default(),
            connection_id: "studio:one".into(),
            correlation_id: None,
            causation_id: None,
            trace_parent: None,
        }
    }
    fn register(owner: &ApplicationOwner, id: &str) -> ApplicationBridgeRegistration {
        let ApplicationBridgeReply::Registered(value) = owner
            .bridge(
                &context(),
                ApplicationBridgeRequest::Register {
                    window_id: id.into(),
                    incarnation: "life-1".into(),
                    label: id.into(),
                    previous_session: None,
                },
                1,
            )
            .unwrap()
        else {
            panic!()
        };
        value
    }
    #[test]
    fn drafts_survive_reopen_and_stale_windows_cannot_overwrite() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("studio.sqlite");
        let store = ApplicationStore::open(&path).unwrap();
        let initial = store.read("/project", "studio").unwrap();
        let first = store
            .write(
                "/project",
                &ApplicationState {
                    value: serde_json::json!({"text":"中文草稿"}),
                    ..initial.clone()
                },
            )
            .unwrap();
        assert!(store.write("/project", &initial).is_err());
        drop(store);
        let store = ApplicationStore::open(&path).unwrap();
        assert_eq!(store.read("/project", "studio").unwrap().value, first.value);
        assert!(store.read("/other", "studio").unwrap().version.is_none());
    }

    #[test]
    fn typed_window_documents_and_command_receipt_commit_or_roll_back_together() {
        let temporary = tempfile::tempdir().unwrap();
        let store =
            Arc::new(ApplicationStore::open(&temporary.path().join("application.sqlite")).unwrap());
        let owner = ApplicationOwner::new("/project".into(), store.clone());
        let registration = register(&owner, "window");
        let document = ApplicationDocument {
            document_id: "doc".into(),
            version: "v1".into(),
            path: None,
            text: "original".into(),
            base_text: None,
            base_hash: None,
            selection: ApplicationSelection {
                anchor: 0,
                head: 0,
                version: "s1".into(),
            },
            readonly_reason: None,
        };
        owner
            .bridge(
                &context(),
                ApplicationBridgeRequest::Sync {
                    session: registration.session.clone(),
                    sync_id: "sync1".into(),
                    changes: ApplicationChanges {
                        documents: vec![ApplicationDocumentUpdate {
                            expected_version: None,
                            expected_selection_version: None,
                            document: document.clone(),
                        }],
                        ..Default::default()
                    },
                },
                2,
            )
            .unwrap();
        let request = ApplicationCommandRequest { execution_target: None,
            window: registration.session.window.clone(),
            request_id: "edit".into(),
            action: ApplicationAction::EditDocument {
                document: rho_application::document_ref(&document),
                edits: vec![ApplicationTextEdit {
                    from: 0,
                    to: 8,
                    insert: "changed".into(),
                }],
            },
        };
        owner.control(&context(), request.clone(), 3).unwrap();
        let ApplicationBridgeReply::Claimed(Some(grant)) = owner
            .bridge(
                &context(),
                ApplicationBridgeRequest::Claim {
                    session: registration.session.clone(),
                    claim_request_id: "delivery".into(),
                },
                4,
            )
            .unwrap()
        else {
            panic!()
        };
        // Force the final receipt write to fail after the window and document SQL
        // statements ran. The transaction must roll all three back.
        store
            .0
            .lock()
            .unwrap()
            .execute_batch(
                "CREATE TRIGGER reject_completed_receipt BEFORE UPDATE ON application_commands
            WHEN json_extract(NEW.value,'$.receipt.state') = 'applied'
            BEGIN SELECT RAISE(ABORT,'injected receipt write failure'); END;",
            )
            .unwrap();
        let mut changed = document.clone();
        changed.version = "v2".into();
        changed.text = "changed".into();
        let completion = ApplicationCommandCompletion {
            request_id: request.request_id.clone(),
            claim_id: grant.claim_id,
            outcome: ApplicationLocalOutcome::Applied,
            changes: ApplicationChanges {
                documents: vec![ApplicationDocumentUpdate {
                    expected_version: Some("v1".into()),
                    expected_selection_version: Some("s1".into()),
                    document: changed.clone(),
                }],
                ..Default::default()
            },
            diagnostic: None,
        };
        assert!(matches!(
            owner.bridge(
                &context(),
                ApplicationBridgeRequest::Complete {
                    session: registration.session.clone(),
                    completion: completion.clone()
                },
                5
            ),
            Err(ApplicationError::Storage(_))
        ));
        let scope = owner.scope(&context()).unwrap();
        assert_eq!(store.documents(&scope, "window").unwrap(), vec![document]);
        assert_eq!(
            owner
                .command_status(
                    &context(),
                    ApplicationCommandStatusArguments {
                        window: registration.session.window.clone(),
                        request_id: request.request_id.clone()
                    },
                    5
                )
                .unwrap()
                .state,
            ApplicationCommandState::Claimed
        );
        store
            .0
            .lock()
            .unwrap()
            .execute_batch("DROP TRIGGER reject_completed_receipt")
            .unwrap();
        let ApplicationBridgeReply::Completed(receipt) = owner
            .bridge(
                &context(),
                ApplicationBridgeRequest::Complete {
                    session: registration.session,
                    completion,
                },
                6,
            )
            .unwrap()
        else {
            panic!()
        };
        assert_eq!(receipt.state, ApplicationCommandState::Applied);
        assert_eq!(store.documents(&scope, "window").unwrap(), vec![changed]);
    }
    #[test]
    fn method_reads_preserve_changed_digests_and_principal_task_scope() {
        let temporary = tempfile::tempdir().unwrap();
        let store =
            Arc::new(ApplicationStore::open(&temporary.path().join("application.sqlite")).unwrap());
        let owner = ApplicationOwner::new("/project".into(), store.clone());
        let mut receipt = ApplicationSkillReadReceipt {
            working_directory: ".".into(),
            skill_ref: "skill-1".into(),
            source_ref: "project-source".into(),
            resource_ref: "references/method.md".into(),
            sha256: rho_application::sha256("first"),
            external_task_ref: Some("external-task".into()),
            observed_at_ms: 1,
        };
        owner.record_skill_read(&context(), &receipt).unwrap();
        receipt.observed_at_ms = 2;
        owner.record_skill_read(&context(), &receipt).unwrap();
        assert_eq!(
            owner
                .skill_reads(&context(), Some("external-task"))
                .unwrap()
                .len(),
            1
        );
        receipt.sha256 = rho_application::sha256("changed");
        owner.record_skill_read(&context(), &receipt).unwrap();
        assert_eq!(
            owner
                .skill_reads(&context(), Some("external-task"))
                .unwrap()
                .len(),
            2
        );
        assert!(
            owner
                .skill_reads(&context(), Some("different-task"))
                .unwrap()
                .is_empty()
        );
        let mut other = context();
        other.caller.id = "another-principal".into();
        assert!(owner.skill_reads(&other, None).unwrap().is_empty());
        drop(owner);
        drop(store);
        let reopened = ApplicationOwner::new(
            "/project".into(),
            Arc::new(ApplicationStore::open(&temporary.path().join("application.sqlite")).unwrap()),
        );
        assert_eq!(reopened.skill_reads(&context(), None).unwrap().len(), 2);
    }
}
