use crate::{service::*, *};
use rho_contract as host;
use rho_operation::OperationError;
use rho_plugin_protocol::*;
use rusqlite::{OptionalExtension, params};
use serde_json::Value;
use std::collections::BTreeSet;

const MAX_OPEN_VIEWS: usize = 256;
const MAX_VIEW_STATE: usize = 256 * 1024;
pub(crate) struct LiveView {
    pub(crate) connection: PluginViewConnection,
    pub(crate) context: host::CallContext,
    sequence: u32,
    pub(crate) renderers: BTreeSet<RequestId>,
    pub(crate) closing: Option<crate::view_close::CloseAttempt>,
    pub(crate) fixtures: Vec<PluginPreviewQuery>,
}
pub struct PluginViewAsset {
    pub bytes: Vec<u8>,
    pub media_type: &'static str,
}
fn token() -> String {
    format!(
        "{}{}",
        uuid::Uuid::new_v4().simple(),
        uuid::Uuid::new_v4().simple()
    )
}
fn owner(record: &PluginViewRecord) -> String {
    format!("{}:{}", record.instance.instance, record.view)
}
fn bounded_state(value: &Value) -> Result<(), OperationError> {
    if serde_json::to_vec(value).map_err(invalid)?.len() > MAX_VIEW_STATE {
        return Err(invalid("view state exceeds 256 KiB"));
    }
    Ok(())
}
impl PluginService {
    pub(crate) fn close_live_views(&self) {
        let records = self
            .views
            .lock()
            .unwrap()
            .values()
            .map(|live| (live.context.clone(), live.connection.view.view.clone()))
            .collect::<Vec<_>>();
        for (context, id) in records {
            let result = self.view_record(&context, &id).and_then(|record|
                self.close_view_at_version(&context, &id, record.state_version, false));
            if let Err(error) = result {
                eprintln!("plugin view shutdown: {error}");
            }
        }
    }
    pub(crate) fn prepare_view(
        &self,
        context: &host::CallContext,
        args: &OpenPluginView,
    ) -> Result<ViewContribution, OperationError> {
        self.check_window_context(context, &args.window)?;
        let observed = self.observe_instance(context, &args.instance, false)?;
        if !observed.observed_in_this_host || observed.instance.state != InstanceState::Active {
            return Err(invalid("view requires an active instance in this Host"));
        }
        let grants = self.runtime.view_grants(&args.instance).map_err(error)?;
        let repo = self.repository.lock().unwrap();
        let manifest = repo
            .revision(&args.instance.revision)
            .map_err(error)?
            .manifest;
        let contribution = manifest
            .views
            .into_iter()
            .find(|v| v.id == args.contribution)
            .ok_or_else(|| invalid("view is not contributed by this exact revision"))?;
        if let Some(resource) = &args.resource {
            if !contribution.resource_kinds.contains(&resource.media_type) {
                return Err(invalid("view does not declare this resource kind"));
            }
            // Metadata qualification is bounded. Reading bytes still requires a
            // separately granted resources port and verifies those bytes there.
            self.resources.qualify_reference(&self.project,
                &plugin_principal_id(context.principal()), resource).map_err(error)?;
        }
        bounded_state(&args.state)?;
        if serde_json::to_vec(args).map_err(invalid)?.len() > MAX_CONTROL_BYTES / 2 {
            return Err(invalid(
                "view configuration and state exceed the bootstrap quota",
            ));
        }
        crate::runtime::validate_value(&contribution.state_schema, &args.state, "view state")
            .map_err(error)?;
        crate::runtime::validate_value(
            &contribution.configuration_schema,
            &args.configuration,
            "view configuration",
        )
        .map_err(error)?;
        for grant in &grants {
            if !grant.scopes.is_subset(&context.scopes) {
                return Err(invalid("view grants exceed the caller's authority"));
            }
        }
        Ok(contribution)
    }
    pub(crate) fn prepare_window_view(
        &self,
        context: &host::CallContext,
        id: &ViewInstanceId,
        args: &OpenPluginWindowView,
    ) -> Result<(), OperationError> {
        self.prepare_view(context, &args.view)?;
        let current = self
            .repository
            .lock()
            .unwrap()
            .window_layout(
                &self.project,
                &plugin_principal_id(context.principal()),
                &args.view.window,
            )
            .map_err(crate::window_layout::layout_error)?;
        crate::window_layout::place_view(
            current,
            args.expected_layout_version,
            args.group.as_ref(),
            id,
        )
        .map_err(crate::window_layout::layout_error)?;
        if self.views.lock().unwrap().len() >= MAX_OPEN_VIEWS {
            return Err(invalid("open view quota reached"));
        }
        Ok(())
    }
    pub(crate) fn open_view(
        &self,
        context: &host::CallContext,
        id: ViewInstanceId,
        args: OpenPluginView,
    ) -> Result<PluginViewRecord, OperationError> {
        self.create_view(context, id, args, None)
            .map(|(view, _)| view)
    }
    pub(crate) fn open_window_view(
        &self,
        context: &host::CallContext,
        id: ViewInstanceId,
        args: OpenPluginWindowView,
    ) -> Result<OpenedPluginWindowView, OperationError> {
        let (view, layout) = self.create_view(
            context,
            id,
            args.view,
            Some((args.expected_layout_version, args.group)),
        )?;
        Ok(OpenedPluginWindowView {
            view,
            layout: layout.expect("window placement requested"),
        })
    }
    fn create_view(
        &self,
        context: &host::CallContext,
        id: ViewInstanceId,
        args: OpenPluginView,
        placement: Option<(u32, Option<NodeId>)>,
    ) -> Result<(PluginViewRecord, Option<PluginWindowLayout>), OperationError> {
        let contribution = self.prepare_view(context, &args)?;
        let grants = self.runtime.view_grants(&args.instance).map_err(error)?;
        let purpose = self.observe_instance(context, &args.instance, false)?.instance.purpose;
        let fixtures = self.runtime.view_fixtures(&args.instance).map_err(error)?;
        let mut views = self.views.lock().unwrap();
        if views.len() >= MAX_OPEN_VIEWS {
            return Err(invalid("open view quota reached"));
        }
        let mut repo = self.repository.lock().unwrap();
        let record = PluginViewRecord {
            purpose,
            view: id,
            instance: args.instance,
            project: self.project.clone(),
            principal: plugin_principal_id(context.principal()),
            contribution: args.contribution,
            window: args.window,
            configuration: args.configuration,
            state: args.state,
            resource: args.resource,
            state_version: 0,
            closed: false,
        };
        // Prepare all fallible connection material before committing. No public
        // result or durable document includes these private credentials.
        let mut delegated = context.clone();
        delegated.principal = Some(context.principal().clone());
        delegated.caller = host::CallerIdentity {
            kind: host::CallerKind::Plugin,
            id: record.view.to_string(),
        };
        delegated.scopes = grants
            .iter()
            .flat_map(|g| g.scopes.iter().cloned())
            .collect();
        let connection = PluginViewConnection {
            view: record.clone(),
            connection: ConnectionId::new(format!("view-{}", uuid::Uuid::new_v4().simple()))
                .map_err(error)?,
            next_sequence: 1,
            asset_token: token(),
            call_token: token(),
            entrypoint: contribution.entrypoint,
            grants,
        };
        delegated.connection_id = connection.connection.to_string();
        let transaction = repo
            .connection
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
            .map_err(error)?;
        let layout_args = placement
            .map(|(version, group)| {
                let current = crate::window_layout::observed(
                    &transaction,
                    &record.project,
                    &record.principal,
                    &record.window,
                )?;
                crate::window_layout::place_view(current, version, group.as_ref(), &record.view)
            })
            .transpose()
            .map_err(crate::window_layout::layout_error)?;
        transaction
            .execute(
                "INSERT INTO plugin_views VALUES(?,?,?,?)",
                params![
                    record.view.as_str(),
                    record.project.as_str(),
                    record.principal.as_str(),
                    serde_json::to_string(&record).map_err(invalid)?
                ],
            )
            .map_err(error)?;
        transaction
            .execute(
                "INSERT INTO revision_refs VALUES('view',?,?)",
                params![owner(&record), record.instance.revision.as_str()],
            )
            .map_err(error)?;
        let layout = layout_args
            .map(|args| {
                crate::window_layout::store_layout(
                    &transaction,
                    &record.project,
                    &record.principal,
                    args,
                )
            })
            .transpose()
            .map_err(crate::window_layout::layout_error)?;
        transaction.commit().map_err(error)?;
        views.insert(
            record.view.clone(),
            LiveView {
                connection,
                context: delegated,
                sequence: 0,
                renderers: BTreeSet::new(),
                closing: None,
                fixtures,
            },
        );
        Ok((record, layout))
    }
    pub fn view_record(
        &self,
        context: &host::CallContext,
        id: &ViewInstanceId,
    ) -> Result<PluginViewRecord, OperationError> {
        let repo = self.repository.lock().unwrap();
        let document = repo
            .connection
            .query_row(
                "SELECT document FROM plugin_views WHERE id=? AND project=? AND principal=?",
                params![
                    id.as_str(),
                    self.project.as_str(),
                    plugin_principal_id(context.principal()).as_str()
                ],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(invalid)?;
        serde_json::from_str(&document.ok_or_else(|| OperationError::NotFound(id.to_string()))?)
            .map_err(invalid)
    }
    pub(crate) fn update_view(
        &self,
        context: &host::CallContext,
        args: UpdatePluginView,
    ) -> Result<PluginViewRecord, OperationError> {
        bounded_state(&args.state)?;
        let mut record = self.view_record(context, &args.view)?;
        if record.closed || record.state_version != args.expected_version {
            return Err(OperationError::ContentChanged(
                "view state changed or closed".into(),
            ));
        }
        let mut views = self.views.lock().unwrap();
        if views.get(&args.view).is_some_and(|live| live.closing.as_ref().is_some_and(|close| close.sealed(live.renderers.len()))) {
            return Err(OperationError::ContentChanged("view state is sealed for closure".into()));
        }
        let mut repo = self.repository.lock().unwrap();
        let manifest = repo
            .revision(&record.instance.revision)
            .map_err(error)?
            .manifest;
        let contribution = manifest
            .views
            .iter()
            .find(|v| v.id == record.contribution)
            .ok_or_else(|| invalid("missing view contribution"))?;
        crate::runtime::validate_value(&contribution.state_schema, &args.state, "view state")
            .map_err(error)?;
        let before = serde_json::to_string(&record).map_err(invalid)?;
        record.state = args.state;
        record.state_version = record
            .state_version
            .checked_add(1)
            .ok_or_else(|| invalid("view state version exhausted"))?;
        let transaction = repo.connection.transaction().map_err(invalid)?;
        if transaction
            .execute(
                "UPDATE plugin_views SET document=? WHERE id=? AND document=?",
                params![
                    serde_json::to_string(&record).map_err(invalid)?,
                    record.view.as_str(),
                    before
                ],
            )
            .map_err(invalid)?
            != 1
        {
            return Err(OperationError::ContentChanged("view state changed".into()));
        }
        transaction.commit().map_err(invalid)?;
        if let Some(live) = views.get_mut(&record.view) {
            live.connection.view = record.clone();
        }
        Ok(record)
    }
    pub(crate) fn close_view_at_version(
        &self,
        context: &host::CallContext,
        id: &ViewInstanceId,
        expected_version: u32,
        remove_from_window: bool,
    ) -> Result<PluginViewRecord, OperationError> {
        let mut record = self.view_record(context, id)?;
        if record.closed { return Ok(record); }
        if record.state_version != expected_version {
            return Err(OperationError::ContentChanged("view state changed before closure".into()));
        }
        let mut views = self.views.lock().unwrap();
        let mut repo = self.repository.lock().unwrap();
        let before = serde_json::to_string(&record).map_err(invalid)?;
        record.closed = true;
        let transaction = repo.connection.transaction().map_err(error)?;
        if transaction
            .execute(
                "UPDATE plugin_views SET document=? WHERE id=? AND document=?",
                params![
                    serde_json::to_string(&record).map_err(invalid)?,
                    id.as_str(),
                    before
                ],
            )
            .map_err(error)?
            != 1
        {
            return Err(OperationError::ContentChanged("view state changed".into()));
        }
        transaction
            .execute(
                "DELETE FROM revision_refs WHERE owner_kind='view' AND owner=? AND revision=?",
                params![owner(&record), record.instance.revision.as_str()],
            )
            .map_err(error)?;
        if remove_from_window {
            let current = crate::window_layout::observed(&transaction, &record.project, &record.principal, &record.window)
                .map_err(crate::window_layout::layout_error)?;
            if let Some(args) = crate::window_layout::remove_view(current, &record.view)
                .map_err(crate::window_layout::layout_error)? {
                crate::window_layout::store_layout(&transaction, &record.project, &record.principal, args)
                    .map_err(crate::window_layout::layout_error)?;
            }
        }
        transaction.commit().map_err(error)?;
        views.remove(id);
        self.view_sequences
            .send_modify(|version| *version = version.wrapping_add(1));
        Ok(record)
    }
    /// Read existing connection material; never mount, restart or recover a view.
    pub fn view_connection(
        &self,
        context: &host::CallContext,
        id: &ViewInstanceId,
    ) -> Result<PluginViewConnection, OperationError> {
        // Even a declared query grant cannot transfer the shell's private call
        // credential into plugin code. Plugins inspect the public view record.
        if context.caller.kind == host::CallerKind::Plugin {
            return Err(OperationError::AccessDenied {
                capability: "views.connection@1".into(),
                missing: vec!["private view connections are retained by the containing Host shell".into()],
            });
        }
        self.view_record(context, id)?;
        self.views
            .lock()
            .unwrap()
            .get(id)
            .map(|v| {
                let mut connection = v.connection.clone();
                connection.next_sequence = v.sequence.saturating_add(1);
                connection
            })
            .ok_or_else(|| {
                OperationError::Unavailable("view connection is not present in this Host".into())
            })
    }
    /// Token authority is narrowed again by the caller in the containing shell.
    pub async fn view_context(
        &self,
        parent: &host::CallContext,
        connection: &str,
        token: &str,
        window: &str,
        view: &ViewInstanceId,
        sequence: u32,
        capability: Option<&host::CapabilityRef>,
    ) -> Result<host::CallContext, OperationError> {
        let mut changed = self.view_sequences.subscribe();
        tokio::time::timeout(std::time::Duration::from_secs(10), async {
            loop {
                match self.try_view_context(
                    parent, connection, token, window, view, sequence, capability,
                ) {
                    Ok(None) => {
                        changed.changed().await.map_err(invalid)?;
                    }
                    result => {
                        self.view_sequences
                            .send_modify(|version| *version = version.wrapping_add(1));
                        return result.map(|context| context.expect("ready view context"));
                    }
                }
            }
        })
        .await
        .map_err(|_| invalid("preceding view message did not arrive; reconnect this view"))?
    }
    fn try_view_context(
        &self,
        parent: &host::CallContext,
        connection: &str,
        token: &str,
        window: &str,
        view: &ViewInstanceId,
        sequence: u32,
        capability: Option<&host::CapabilityRef>,
    ) -> Result<Option<host::CallContext>, OperationError> {
        let mut views = self.views.lock().unwrap();
        let live = views
            .values_mut()
            .find(|v| {
                v.connection.connection.as_str() == connection
                    && v.connection.call_token == token
                    && v.connection.view.window.as_str() == window
                    && &v.connection.view.view == view
                    && v.context.principal() == parent.principal()
            })
            .ok_or_else(|| OperationError::NotFound("view connection".into()))?;
        if sequence == 0 || sequence <= live.sequence {
            return Err(invalid("stale view message"));
        }
        if sequence - live.sequence > 128 {
            return Err(invalid("view message exceeds ordering quota"));
        }
        if sequence != live.sequence + 1 {
            return Ok(None);
        }
        live.sequence = sequence;
        let mut context = live.context.clone();
        let active = self.runtime.observe().iter().any(|observation| {
            observation.instance.identity == live.connection.view.instance
                && observation.instance.state == InstanceState::Active
        });
        let mut scope = host::ViewCallScope {
            window: live.connection.view.window.clone(),
            draft_source: (live.closing.is_some() || !active).then(|| DraftSource {
                revision: live.connection.view.instance.revision.clone(),
                contribution: live.connection.view.contribution.clone(),
            }),
        };
        // Both the original opener and the current authenticated parent may
        // restrict this call; neither a new view nor a reverse call widens them.
        for inherited in [context.view_scope.as_ref(), parent.view_scope.as_ref()]
            .into_iter().flatten()
        {
            if inherited.window != scope.window {
                return Err(invalid("call is restricted to its original window"));
            }
            if let Some(source) = &inherited.draft_source {
                if scope.draft_source.as_ref().is_some_and(|current| current != source) {
                    return Err(invalid("call is restricted to its original draft source"));
                }
                scope.draft_source = Some(source.clone());
            }
        }
        context.view_scope = Some(scope);
        if let Some(cap) = capability {
            if !active && !crate::draft_service::view_persistence_capability(&cap.id, cap.version) {
                return Err(invalid("view instance is no longer accepting calls"));
            }
            if live.connection.view.purpose == PluginInstancePurpose::FixturePreview {
                if !parent.scopes.contains(PLUGINS_RUN_SCOPE) {
                    return Err(OperationError::AccessDenied { capability: "fixture_preview".into(), missing: vec![PLUGINS_RUN_SCOPE.into()] });
                }
                // This channel carries fixture data only. No declared capability
                // becomes an actual Host grant, even if the parent has authority.
                context.scopes.clear();
            } else {
                let grant = live
                    .connection
                    .grants
                    .iter()
                    .find(|g| {
                        g.capability.id.as_str() == cap.id
                            && g.capability.version == u32::from(cap.version)
                    })
                    .ok_or_else(|| invalid("capability is not granted to this view"))?;
                context.scopes = grant.scopes.clone();
            }
        }
        context.scopes = context
            .scopes
            .intersection(&parent.scopes)
            .cloned()
            .collect::<BTreeSet<_>>();
        Ok(Some(context))
    }
    pub fn view_asset(
        &self,
        connection: &str,
        token: &str,
        path: &str,
    ) -> Result<PluginViewAsset, OperationError> {
        let path = PackagePath::new(path).map_err(error)?;
        if !path.is_artifact() {
            return Err(invalid("view assets must be immutable artifact files"));
        }
        let views = self.views.lock().unwrap();
        let live = views
            .values()
            .find(|v| {
                v.connection.connection.as_str() == connection && v.connection.asset_token == token
            })
            .ok_or_else(|| OperationError::NotFound("view assets".into()))?;
        let repo = self.repository.lock().unwrap();
        let artifact = repo
            .artifact(&live.connection.view.instance.artifact)
            .map_err(error)?;
        let file = artifact
            .files
            .get(&path)
            .ok_or_else(|| OperationError::NotFound(path.to_string()))?;
        if file.bytes > 16 * 1024 * 1024 {
            return Err(invalid("view asset exceeds 16 MiB; use a resource read"));
        }
        let bytes = repo.blob(&file.digest).map_err(error)?;
        let media_type = match path.as_str().rsplit('.').next() {
            Some("html") => "text/html; charset=utf-8",
            Some("js" | "mjs") => "text/javascript; charset=utf-8",
            Some("css") => "text/css; charset=utf-8",
            Some("json") => "application/json",
            Some("svg") => "image/svg+xml",
            Some("png") => "image/png",
            Some("jpg" | "jpeg") => "image/jpeg",
            Some("woff2") => "font/woff2",
            Some("wasm") => "application/wasm",
            _ => "application/octet-stream",
        };
        Ok(PluginViewAsset { bytes, media_type })
    }
}
