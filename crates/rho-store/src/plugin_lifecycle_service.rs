//! Project-scoped application seam for durable workspace-plugin lifecycle facts.

use crate::{
    PluginLifecycleMutationOutcome, Store, StoreError, WorkspacePluginCrashOutcome,
    WorkspacePluginDiscoveredDraft, WorkspacePluginGenerationAllocation,
    WorkspacePluginLifecycleEvent, WorkspacePluginPackageTombstone, WorkspacePluginState,
    WorkspacePluginTombstoneDraft, WorkspacePluginTransition, WorkspacePluginTransitionAdvance,
    WorkspacePluginTransitionDraft, WorkspacePluginTransitionRequestResult,
    query::required_project_root,
};

pub struct PluginLifecycleQueryService<'a> {
    store: &'a Store,
}

impl<'a> PluginLifecycleQueryService<'a> {
    pub fn new(store: &'a Store) -> Self {
        Self { store }
    }

    pub fn get_state(
        &self,
        project_root: &str,
        plugin_id: &str,
    ) -> Result<Option<WorkspacePluginState>, StoreError> {
        self.store
            .get_workspace_plugin_state(&required_project_root(project_root)?, plugin_id)
    }

    pub fn list_states(
        &self,
        project_root: &str,
        limit: Option<usize>,
    ) -> Result<Vec<WorkspacePluginState>, StoreError> {
        self.store
            .list_workspace_plugin_states(&required_project_root(project_root)?, limit)
    }

    pub fn get_transition(
        &self,
        project_root: &str,
        transition_id: &str,
    ) -> Result<Option<WorkspacePluginTransition>, StoreError> {
        self.store
            .get_workspace_plugin_transition(&required_project_root(project_root)?, transition_id)
    }

    pub fn list_nonterminal_transitions(
        &self,
        project_root: &str,
        limit: Option<usize>,
    ) -> Result<Vec<WorkspacePluginTransition>, StoreError> {
        self.store.list_nonterminal_workspace_plugin_transitions(
            &required_project_root(project_root)?,
            limit,
        )
    }

    pub fn list_events(
        &self,
        project_root: &str,
        limit: Option<usize>,
    ) -> Result<Vec<WorkspacePluginLifecycleEvent>, StoreError> {
        self.store
            .list_workspace_plugin_lifecycle_events(&required_project_root(project_root)?, limit)
    }

    pub fn get_tombstone(
        &self,
        project_root: &str,
        tombstone_id: &str,
    ) -> Result<Option<WorkspacePluginPackageTombstone>, StoreError> {
        self.store
            .get_workspace_plugin_tombstone(&required_project_root(project_root)?, tombstone_id)
    }
}

pub struct PluginLifecycleMutationService<'a> {
    store: &'a mut Store,
}

impl<'a> PluginLifecycleMutationService<'a> {
    pub fn new(store: &'a mut Store) -> Self {
        Self { store }
    }

    pub fn discover(
        &mut self,
        project_root: &str,
        draft: &WorkspacePluginDiscoveredDraft,
    ) -> Result<(PluginLifecycleMutationOutcome, WorkspacePluginState), StoreError> {
        let project_root = required_project_root(project_root)?;
        let draft_root = required_project_root(&draft.project_root)?;
        if project_root != draft_root {
            return Err(StoreError::Validation(
                "workspace plugin discovery project does not match service project".to_string(),
            ));
        }
        let mut draft = draft.clone();
        draft.project_root = project_root;
        self.store.upsert_discovered_workspace_plugin(&draft)
    }

    pub fn request_transition(
        &mut self,
        project_root: &str,
        draft: &WorkspacePluginTransitionDraft,
    ) -> Result<WorkspacePluginTransitionRequestResult, StoreError> {
        let project_root = required_project_root(project_root)?;
        let draft_root = required_project_root(&draft.project_root)?;
        if project_root != draft_root {
            return Err(StoreError::Validation(
                "workspace plugin transition project does not match service project".to_string(),
            ));
        }
        let mut draft = draft.clone();
        draft.project_root = project_root;
        self.store.request_workspace_plugin_transition(&draft)
    }

    pub fn advance_transition(
        &mut self,
        project_root: &str,
        draft: &WorkspacePluginTransitionAdvance,
    ) -> Result<PluginLifecycleMutationOutcome, StoreError> {
        let project_root = required_project_root(project_root)?;
        let draft_root = required_project_root(&draft.project_root)?;
        if project_root != draft_root {
            return Err(StoreError::Validation(
                "workspace plugin transition advance project does not match service project"
                    .to_string(),
            ));
        }
        let mut draft = draft.clone();
        draft.project_root = project_root;
        self.store.advance_workspace_plugin_transition(&draft)
    }

    pub fn allocate_generation(
        &mut self,
        project_root: &str,
        plugin_id: &str,
        transition_id: &str,
        expected_last_generation: i64,
    ) -> Result<WorkspacePluginGenerationAllocation, StoreError> {
        self.store.allocate_workspace_plugin_generation(
            &required_project_root(project_root)?,
            plugin_id,
            transition_id,
            expected_last_generation,
        )
    }

    pub fn record_tombstone(
        &mut self,
        project_root: &str,
        draft: &WorkspacePluginTombstoneDraft,
    ) -> Result<
        (
            PluginLifecycleMutationOutcome,
            WorkspacePluginPackageTombstone,
        ),
        StoreError,
    > {
        let project_root = required_project_root(project_root)?;
        let draft_root = required_project_root(&draft.project_root)?;
        if project_root != draft_root {
            return Err(StoreError::Validation(
                "workspace plugin tombstone project does not match service project".to_string(),
            ));
        }
        let mut draft = draft.clone();
        draft.project_root = project_root;
        self.store.record_workspace_plugin_tombstone(&draft)
    }

    pub fn record_crash(
        &mut self,
        project_root: &str,
        plugin_id: &str,
        package_digest: &str,
        host_session_id: &str,
        reason_code: &str,
    ) -> Result<WorkspacePluginCrashOutcome, StoreError> {
        self.store.record_workspace_plugin_crash(
            &required_project_root(project_root)?,
            plugin_id,
            package_digest,
            host_session_id,
            reason_code,
        )
    }
}
