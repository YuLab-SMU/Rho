//! Dedicated application seam for project-scoped plugin permission facts.
//!
//! This lane is intentionally separate from Agent approvals and scientific
//! environment requests. It normalizes one explicit project identity and
//! delegates only P2-2 permission persistence operations; it performs no
//! privileged filesystem, network, Workspace R, Wasm, UI, or handle action.

use crate::{
    PluginPermissionDecisionDraft, PluginPermissionEvent, PluginPermissionGrant,
    PluginPermissionMutationOutcome, PluginPermissionRequest, PluginPermissionRequestDraft, Store,
    StoreError, query::required_project_root,
};

pub struct PluginPermissionQueryService<'a> {
    store: &'a Store,
}

impl<'a> PluginPermissionQueryService<'a> {
    pub fn new(store: &'a Store) -> Self {
        Self { store }
    }

    pub fn get_request(
        &self,
        project_root: &str,
        request_id: &str,
    ) -> Result<Option<PluginPermissionRequest>, StoreError> {
        let project_root = required_project_root(project_root)?;
        self.store
            .get_plugin_permission_request(&project_root, request_id)
    }

    pub fn list_requests(
        &self,
        project_root: &str,
        limit: Option<usize>,
        status: Option<&str>,
    ) -> Result<Vec<PluginPermissionRequest>, StoreError> {
        let project_root = required_project_root(project_root)?;
        self.store
            .list_plugin_permission_requests(&project_root, limit, status)
    }

    pub fn list_grants(
        &self,
        project_root: &str,
        limit: Option<usize>,
        status: Option<&str>,
    ) -> Result<Vec<PluginPermissionGrant>, StoreError> {
        let project_root = required_project_root(project_root)?;
        self.store
            .list_plugin_permission_grants(&project_root, limit, status)
    }

    pub fn list_events(
        &self,
        project_root: &str,
        limit: Option<usize>,
    ) -> Result<Vec<PluginPermissionEvent>, StoreError> {
        let project_root = required_project_root(project_root)?;
        self.store
            .list_plugin_permission_events(&project_root, limit)
    }
}

pub struct PluginPermissionMutationService<'a> {
    store: &'a mut Store,
}

impl<'a> PluginPermissionMutationService<'a> {
    pub fn new(store: &'a mut Store) -> Self {
        Self { store }
    }

    pub fn create_request(
        &mut self,
        project_root: &str,
        draft: &PluginPermissionRequestDraft,
    ) -> Result<PluginPermissionRequest, StoreError> {
        let project_root = required_project_root(project_root)?;
        let draft_root = required_project_root(&draft.project_root)?;
        if project_root != draft_root {
            return Err(StoreError::Validation(
                "plugin permission request project does not match the service project".to_string(),
            ));
        }
        let mut draft = draft.clone();
        draft.project_root = project_root;
        self.store.create_plugin_permission_request(&draft)
    }

    pub fn create_requests(
        &mut self,
        project_root: &str,
        drafts: &[PluginPermissionRequestDraft],
    ) -> Result<Vec<PluginPermissionRequest>, StoreError> {
        let project_root = required_project_root(project_root)?;
        let mut normalized = Vec::with_capacity(drafts.len());
        for draft in drafts {
            let draft_root = required_project_root(&draft.project_root)?;
            if project_root != draft_root {
                return Err(StoreError::Validation(
                    "plugin permission request project does not match the service project"
                        .to_string(),
                ));
            }
            let mut draft = draft.clone();
            draft.project_root = project_root.clone();
            normalized.push(draft);
        }
        self.store.create_plugin_permission_requests(&normalized)
    }

    pub fn resolve_request(
        &mut self,
        project_root: &str,
        draft: &PluginPermissionDecisionDraft,
    ) -> Result<PluginPermissionMutationOutcome, StoreError> {
        let project_root = required_project_root(project_root)?;
        let draft_root = required_project_root(&draft.project_root)?;
        if project_root != draft_root {
            return Err(StoreError::Validation(
                "plugin permission decision project does not match the service project".to_string(),
            ));
        }
        let mut draft = draft.clone();
        draft.project_root = project_root;
        self.store.resolve_plugin_permission_request(&draft)
    }

    pub fn cancel_request(
        &mut self,
        project_root: &str,
        request_id: &str,
        expected_project_revision: i64,
        reason_code: &str,
    ) -> Result<PluginPermissionMutationOutcome, StoreError> {
        let project_root = required_project_root(project_root)?;
        self.store.cancel_plugin_permission_request(
            &project_root,
            request_id,
            expected_project_revision,
            reason_code,
        )
    }

    pub fn revoke_grant(
        &mut self,
        project_root: &str,
        grant_id: &str,
        reason_code: &str,
    ) -> Result<PluginPermissionMutationOutcome, StoreError> {
        let project_root = required_project_root(project_root)?;
        self.store
            .revoke_plugin_permission_grant(&project_root, grant_id, reason_code)
    }

    pub fn consume_grant(
        &mut self,
        project_root: &str,
        grant_id: &str,
    ) -> Result<PluginPermissionMutationOutcome, StoreError> {
        let project_root = required_project_root(project_root)?;
        self.store
            .consume_plugin_permission_grant(&project_root, grant_id)
    }

    pub fn recover_pending(
        &mut self,
        project_root: &str,
        reason_code: &str,
    ) -> Result<usize, StoreError> {
        let project_root = required_project_root(project_root)?;
        self.store
            .recover_pending_plugin_permission_requests(&project_root, reason_code)
    }

    pub fn recover_transient_grants(
        &mut self,
        project_root: &str,
        reason_code: &str,
    ) -> Result<usize, StoreError> {
        let project_root = required_project_root(project_root)?;
        self.store
            .recover_transient_plugin_permission_grants(&project_root, reason_code)
    }

    pub fn expire_grants(&mut self, project_root: &str) -> Result<usize, StoreError> {
        let project_root = required_project_root(project_root)?;
        self.store.expire_plugin_permission_grants(&project_root)
    }
}
