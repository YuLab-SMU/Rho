use crate::{PluginError, PluginRepository, ensure};
use rho_plugin_protocol::*;
use rusqlite::{Connection, OptionalExtension, params};

impl crate::PluginService {
    /// Views may cooperate with their own containing window. Trusted Host callers
    /// can address an explicit window; project/principal always come from Host.
    pub(crate) fn check_window_context(
        &self,
        context: &rho_contract::CallContext,
        window: &WindowId,
    ) -> Result<(), rho_operation::OperationError> {
        if context.caller.kind == rho_contract::CallerKind::Plugin
            && let Ok(view) = ViewInstanceId::new(&context.caller.id)
        {
            match self.view_record(context, &view) {
                Ok(record) if &record.window != window => {
                    return Err(crate::service::invalid("view belongs to another window"));
                }
                Ok(_) | Err(rho_operation::OperationError::NotFound(_)) => (),
                Err(error) => return Err(error),
            }
        }
        Ok(())
    }
}

fn observed(
    connection: &Connection,
    project: &ProjectId,
    principal: &PrincipalId,
    window: &WindowId,
) -> Result<PluginWindowLayout, PluginError> {
    let document: Option<String> = connection.query_row(
        "SELECT document FROM plugin_window_layouts WHERE project=? AND principal=? AND window=?",
        params![project.as_str(), principal.as_str(), window.as_str()], |row| row.get(0),
    ).optional()?;
    let layout = match document {
        Some(document) => serde_json::from_str::<PluginWindowLayout>(&document)?,
        None => PluginWindowLayout {
            window: window.clone(),
            project: project.clone(),
            principal: principal.clone(),
            version: 0,
            layout: PluginWindowNode::Empty,
        },
    };
    ensure(
        &layout.project == project && &layout.principal == principal && &layout.window == window,
        "window layout does not match its stored scope",
    )?;
    layout.layout.view_ids()?;
    Ok(layout)
}

impl PluginRepository {
    /// Absent windows are empty observations, not an implicit install, view open
    /// or database write. A retained layout does not attest to live connections.
    pub fn window_layout(
        &self,
        project: &ProjectId,
        principal: &PrincipalId,
        window: &WindowId,
    ) -> Result<PluginWindowLayout, PluginError> {
        observed(&self.connection, project, principal, window)
    }

    /// Save only presentation, with one window's native expected version. The
    /// transaction checks every view's original project/principal/window identity.
    /// A closed view may remain as a retained placeholder; saving never reopens it.
    pub fn update_window_layout(
        &mut self,
        project: &ProjectId,
        principal: &PrincipalId,
        args: UpdatePluginWindowLayout,
    ) -> Result<PluginWindowLayout, PluginError> {
        let ids = args.layout.view_ids()?;
        ensure(
            serde_json::to_vec(&args)?.len() <= MAX_CONTROL_BYTES / 4,
            "window layout exceeds 256 KiB",
        )?;
        let transaction = self
            .connection
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        let current = observed(&transaction, project, principal, &args.window)?;
        if current.version != args.expected_version {
            return Err(PluginError::Conflict);
        }
        for id in ids {
            let document: Option<String> = transaction
                .query_row(
                    "SELECT document FROM plugin_views WHERE id=? AND project=? AND principal=?",
                    params![id.as_str(), project.as_str(), principal.as_str()],
                    |row| row.get(0),
                )
                .optional()?;
            let view: PluginViewRecord = serde_json::from_str(&document.ok_or_else(|| {
                PluginError::Invalid("window view is unavailable in this scope".into())
            })?)?;
            ensure(
                view.view == id
                    && &view.project == project
                    && &view.principal == principal
                    && view.window == args.window,
                "window view is unavailable in this scope",
            )?;
        }
        let next = PluginWindowLayout {
            version: current
                .version
                .checked_add(1)
                .ok_or_else(|| PluginError::Invalid("window layout version exhausted".into()))?,
            layout: args.layout,
            ..current
        };
        transaction.execute(
            "INSERT INTO plugin_window_layouts(project,principal,window,document) VALUES(?,?,?,?)
             ON CONFLICT(project,principal,window) DO UPDATE SET document=excluded.document",
            params![
                project.as_str(),
                principal.as_str(),
                next.window.as_str(),
                serde_json::to_string(&next)?
            ],
        )?;
        transaction.commit()?;
        Ok(next)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    fn identity() -> (ProjectId, PrincipalId, WindowId) {
        (
            ProjectId::new("project").unwrap(),
            PrincipalId::new("principal").unwrap(),
            WindowId::new("window").unwrap(),
        )
    }
    fn view(
        repo: &PluginRepository,
        id: &str,
        project: &ProjectId,
        principal: &PrincipalId,
        window: &WindowId,
    ) -> ViewInstanceId {
        let record = PluginViewRecord {
            view: ViewInstanceId::new(id).unwrap(),
            instance: InstanceRef {
                instance: PluginInstanceId::new("instance").unwrap(),
                plugin: PluginId::new("example.plugin").unwrap(),
                revision: RevisionId::new(format!("sha256:{}", "a".repeat(64))).unwrap(),
                artifact: ArtifactId::new(format!("sha256:{}", "b".repeat(64))).unwrap(),
            },
            project: project.clone(),
            principal: principal.clone(),
            window: window.clone(),
            contribution: ContributionId::new("panel").unwrap(),
            configuration: json!({}),
            state: json!({"draft":"中文"}),
            state_version: 1,
            closed: true,
        };
        repo.connection
            .execute(
                "INSERT INTO plugin_views VALUES(?,?,?,?)",
                params![
                    id,
                    project.as_str(),
                    principal.as_str(),
                    serde_json::to_string(&record).unwrap()
                ],
            )
            .unwrap();
        record.view
    }
    fn update(
        window: &WindowId,
        version: u32,
        views: Vec<ViewInstanceId>,
    ) -> UpdatePluginWindowLayout {
        UpdatePluginWindowLayout {
            window: window.clone(),
            expected_version: version,
            layout: PluginWindowNode::Tabs {
                id: NodeId::new("group").unwrap(),
                selected: views.first().cloned(),
                views,
            },
        }
    }
    #[test]
    fn window_layouts_survive_reopen_without_restarting_views_or_changing_their_state() {
        let directory = tempfile::tempdir().unwrap();
        let (project, principal, window) = identity();
        let saved = {
            let mut repo = PluginRepository::open(directory.path()).unwrap();
            assert_eq!(
                repo.window_layout(&project, &principal, &window)
                    .unwrap()
                    .version,
                0
            );
            assert_eq!(
                repo.connection
                    .query_row("SELECT count(*) FROM plugin_window_layouts", [], |row| row
                        .get::<_, i64>(
                        0
                    ))
                    .unwrap(),
                0
            );
            let id = view(&repo, "view", &project, &principal, &window);
            repo.update_window_layout(&project, &principal, update(&window, 0, vec![id]))
                .unwrap()
        };
        let repo = PluginRepository::observe(directory.path())
            .unwrap()
            .unwrap();
        assert_eq!(
            repo.window_layout(&project, &principal, &window).unwrap(),
            saved
        );
        let record: String = repo
            .connection
            .query_row("SELECT document FROM plugin_views", [], |row| row.get(0))
            .unwrap();
        let record: PluginViewRecord = serde_json::from_str(&record).unwrap();
        assert!(record.closed);
        assert_eq!(record.state, json!({"draft":"中文"}));
        assert_eq!(record.state_version, 1);
    }
    #[test]
    fn window_layout_writes_refuse_foreign_views_and_conflicts_atomically() {
        let directory = tempfile::tempdir().unwrap();
        let mut repo = PluginRepository::open(directory.path()).unwrap();
        let (project, principal, window) = identity();
        let other = WindowId::new("other-window").unwrap();
        let own = view(&repo, "own", &project, &principal, &window);
        let foreign = view(&repo, "foreign", &project, &principal, &other);
        let saved = repo
            .update_window_layout(&project, &principal, update(&window, 0, vec![own.clone()]))
            .unwrap();
        assert!(
            repo.update_window_layout(&project, &principal, update(&window, 1, vec![own, foreign]))
                .is_err()
        );
        assert!(matches!(
            repo.update_window_layout(&project, &principal, update(&window, 0, vec![])),
            Err(PluginError::Conflict)
        ));
        assert_eq!(
            repo.window_layout(&project, &principal, &window).unwrap(),
            saved
        );
        assert_eq!(
            repo.window_layout(&project, &principal, &other)
                .unwrap()
                .version,
            0
        );
        let hidden = PrincipalId::new("different-principal").unwrap();
        assert_eq!(
            repo.window_layout(&project, &hidden, &window)
                .unwrap()
                .version,
            0
        );
        assert!(
            repo.update_window_layout(
                &project,
                &hidden,
                update(&window, 0, vec![ViewInstanceId::new("own").unwrap()])
            )
            .is_err()
        );
    }
}
