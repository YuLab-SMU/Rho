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
        if context.view_scope.as_ref().is_some_and(|scope| &scope.window != window) {
            return Err(crate::service::invalid("call is restricted to its original window"));
        }
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

pub(crate) fn observed(
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
        let transaction = self
            .connection
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        let next = store_layout(&transaction, project, principal, args)?;
        transaction.commit()?;
        Ok(next)
    }
}

/// The caller owns the transaction, so view creation and placement can commit once.
pub(crate) fn store_layout(
    connection: &Connection,
    project: &ProjectId,
    principal: &PrincipalId,
    args: UpdatePluginWindowLayout,
) -> Result<PluginWindowLayout, PluginError> {
    let ids = args.layout.view_ids()?;
    ensure(
        serde_json::to_vec(&args)?.len() <= MAX_CONTROL_BYTES / 4,
        "window layout exceeds 256 KiB",
    )?;
    let current = observed(connection, project, principal, &args.window)?;
    if current.version != args.expected_version {
        return Err(PluginError::Conflict);
    }
    for id in ids {
        let document: Option<String> = connection
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
    connection.execute(
        "INSERT INTO plugin_window_layouts(project,principal,window,document) VALUES(?,?,?,?)
             ON CONFLICT(project,principal,window) DO UPDATE SET document=excluded.document",
        params![
            project.as_str(),
            principal.as_str(),
            next.window.as_str(),
            serde_json::to_string(&next)?
        ],
    )?;
    Ok(next)
}

pub(crate) fn place_view(
    mut current: PluginWindowLayout,
    expected_version: u32,
    group: Option<&NodeId>,
    view: &ViewInstanceId,
) -> Result<UpdatePluginWindowLayout, PluginError> {
    if current.version != expected_version {
        return Err(PluginError::Conflict);
    }
    current.layout.view_ids()?;
    match (&mut current.layout, group) {
        (node @ PluginWindowNode::Empty, None) => {
            *node = PluginWindowNode::Tabs {
                id: NodeId::new(format!("layout-{}", uuid::Uuid::new_v4().simple()))?,
                selected: Some(view.clone()),
                views: vec![view.clone()],
            };
        }
        (layout, Some(group)) => {
            fn append(node: &mut PluginWindowNode, group: &NodeId, view: &ViewInstanceId) -> bool {
                match node {
                    PluginWindowNode::Tabs {
                        id,
                        selected,
                        views,
                    } if id == group => {
                        views.push(view.clone());
                        *selected = Some(view.clone());
                        true
                    }
                    PluginWindowNode::Split { children, .. } => {
                        children.iter_mut().any(|node| append(node, group, view))
                    }
                    _ => false,
                }
            }
            ensure(
                append(layout, group, view),
                "target window tab group is unavailable",
            )?;
        }
        _ => {
            return Err(PluginError::Invalid(
                "an existing window requires an explicit tab group".into(),
            ));
        }
    }
    current.layout.view_ids()?;
    let args = UpdatePluginWindowLayout {
        window: current.window,
        expected_version,
        layout: current.layout,
    };
    ensure(
        serde_json::to_vec(&args)?.len() <= MAX_CONTROL_BYTES / 4,
        "window layout exceeds 256 KiB",
    )?;
    Ok(args)
}

pub(crate) fn layout_error(fault: PluginError) -> rho_operation::OperationError {
    match fault {
        PluginError::Conflict => {
            rho_operation::OperationError::ContentChanged("window layout changed".into())
        }
        PluginError::Invalid(message) => crate::service::invalid(message),
        other => crate::service::error(other),
    }
}

/// Remove only the exact view while retaining destination groups and geometry.
/// The caller commits this together with the final acknowledged view state.
pub(crate) fn remove_view(mut current: PluginWindowLayout, view: &ViewInstanceId) -> Result<Option<UpdatePluginWindowLayout>, PluginError> {
    current.layout.view_ids()?;
    fn remove(node: &mut PluginWindowNode, view: &ViewInstanceId) -> bool {
        match node {
            PluginWindowNode::Tabs { views, selected, .. } => {
                let Some(index) = views.iter().position(|id| id == view) else { return false };
                views.remove(index);
                if selected.as_ref() == Some(view) {
                    *selected = views.get(index.min(views.len().saturating_sub(1))).cloned();
                }
                true
            }
            PluginWindowNode::Split { children, .. } => children.iter_mut().any(|node| remove(node, view)),
            PluginWindowNode::Empty => false,
        }
    }
    if !remove(&mut current.layout, view) { return Ok(None); }
    current.layout.view_ids()?;
    Ok(Some(UpdatePluginWindowLayout { window: current.window, expected_version: current.version, layout: current.layout }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    fn layout(node: PluginWindowNode) -> PluginWindowLayout {
        let (project, principal, window) = identity();
        PluginWindowLayout {
            window,
            project,
            principal,
            version: 7,
            layout: node,
        }
    }
    #[test]
    fn closure_preserves_groups_geometry_and_nearest_tab_selection() {
        let view = |id| ViewInstanceId::new(id).unwrap();
        for (selected, removed, expected) in [("b", "b", Some("c")), ("c", "c", Some("b")), ("a", "b", Some("a"))] {
            let original = layout(PluginWindowNode::Split {
                id: NodeId::new("split").unwrap(), direction: SplitDirection::Horizontal, weights: vec![2.0, 5.0],
                children: vec![PluginWindowNode::Empty, PluginWindowNode::Tabs { id: NodeId::new("main").unwrap(),
                    views: vec![view("a"), view("b"), view("c")], selected: Some(view(selected)) }],
            });
            assert!(remove_view(original.clone(), &view("unknown")).unwrap().is_none());
            let next = remove_view(original.clone(), &view(removed)).unwrap().unwrap();
            assert_eq!(next.expected_version, original.version);
            if let PluginWindowNode::Split { weights, children, .. } = next.layout {
                assert_eq!(weights, vec![2.0, 5.0]); assert_eq!(children[0], PluginWindowNode::Empty);
                assert_eq!(children[1], PluginWindowNode::Tabs { id: NodeId::new("main").unwrap(),
                    views: ["a", "b", "c"].into_iter().filter(|id| *id != removed).map(view).collect(), selected: expected.map(view) });
            } else { panic!("split geometry must remain intact"); }
        }
        let group = NodeId::new("empty-target").unwrap();
        let last = layout(PluginWindowNode::Tabs { id: group.clone(), selected: Some(view("last")), views: vec![view("last")] });
        assert_eq!(remove_view(last, &view("last")).unwrap().unwrap().layout,
            PluginWindowNode::Tabs { id: group, selected: None, views: vec![] });
    }
    #[test]
    fn navigation_requires_an_explicit_existing_group_after_the_first_open() {
        let view = ViewInstanceId::new("new-view").unwrap();
        let empty = layout(PluginWindowNode::Empty);
        let opened = place_view(empty.clone(), 7, None, &view).unwrap();
        assert!(
            matches!(opened.layout, PluginWindowNode::Tabs { selected: Some(ref id), .. } if id == &view)
        );
        let group = NodeId::new("missing").unwrap();
        assert!(place_view(empty.clone(), 7, Some(&group), &view).is_err());
        assert!(matches!(
            place_view(empty, 6, None, &view),
            Err(PluginError::Conflict)
        ));
        let existing = layout(PluginWindowNode::Tabs {
            id: group,
            selected: None,
            views: vec![],
        });
        assert!(place_view(existing, 7, None, &view).is_err());
    }
    #[test]
    fn navigation_selects_only_the_named_nested_group_and_preserves_other_geometry() {
        let group = NodeId::new("target").unwrap();
        let old = ViewInstanceId::new("old-view").unwrap();
        let next = ViewInstanceId::new("new-view").unwrap();
        let before = layout(PluginWindowNode::Split {
            id: NodeId::new("split").unwrap(),
            direction: SplitDirection::Vertical,
            weights: vec![2.0, 7.0],
            children: vec![
                PluginWindowNode::Empty,
                PluginWindowNode::Tabs {
                    id: group.clone(),
                    selected: None,
                    views: vec![old.clone()],
                },
            ],
        });
        let placed = place_view(before.clone(), 7, Some(&group), &next).unwrap();
        if let PluginWindowNode::Split {
            weights, children, ..
        } = placed.layout
        {
            assert_eq!(weights, vec![2.0, 7.0]);
            assert_eq!(children[0], PluginWindowNode::Empty);
            assert_eq!(
                children[1],
                PluginWindowNode::Tabs {
                    id: group.clone(),
                    selected: Some(next.clone()),
                    views: vec![old.clone(), next]
                }
            );
        } else {
            panic!("split must remain intact");
        }
        assert!(place_view(before.clone(), 7, Some(&group), &old).is_err());
        assert!(place_view(before, 7, Some(&NodeId::new("split").unwrap()), &old).is_err());
    }
    #[test]
    fn navigation_cannot_exceed_the_window_view_quota() {
        let group = NodeId::new("target").unwrap();
        let full = layout(PluginWindowNode::Tabs {
            id: group.clone(),
            selected: None,
            views: (0..256)
                .map(|n| ViewInstanceId::new(format!("view-{n}")).unwrap())
                .collect(),
        });
        assert!(
            place_view(
                full,
                7,
                Some(&group),
                &ViewInstanceId::new("overflow").unwrap()
            )
            .is_err()
        );
    }
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
            purpose: PluginInstancePurpose::Runtime,
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
            resource: None,
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
