#![forbid(unsafe_code)]
//! Application owns window identity, synchronized resources, command receipts and
//! execution associations. It never submits scientific work or reads native files.
mod execution;
mod store;
mod validation;
pub use execution::{ApplicationExecutionAdmission, ApplicationOperationLookup};
use rho_contract::*;
use sha2::{Digest, Sha256};
use std::sync::{Arc, Mutex, MutexGuard};
pub use store::*;
use thiserror::Error;
use validation::*;

pub const HEARTBEAT_INTERVAL_MS: u64 = 5_000;
pub const OFFLINE_AFTER_MS: u64 = 15_000;
pub const CLAIM_TIMEOUT_MS: u64 = 30_000;
pub const MAX_DOCUMENT_BYTES: usize = 512 * 1024;
pub const MAX_WINDOW_DOCUMENTS: usize = 64;
pub const MAX_WINDOW_TEXT_BYTES: usize = 16 * 1024 * 1024;
pub const MAX_WINDOWS: usize = 32;
pub const MAX_WINDOW_COMMANDS: usize = 4_096;

#[derive(Debug, Clone, Error, PartialEq, Eq)]
pub enum ApplicationError {
    #[error("invalid application request: {0}")]
    InvalidInput(String),
    #[error("application resource is not available to this principal")]
    NotFound,
    #[error("the Studio window is offline; only explicitly requested synced history is readable")]
    Offline,
    #[error("the window incarnation changed; discover the window again")]
    IncarnationChanged,
    #[error("the application resource changed; current local input was not overwritten")]
    Conflict,
    #[error("this request ID was already used with different input")]
    RequestConflict,
    #[error("the bridge credential does not match this window incarnation")]
    InvalidBridge,
    #[error("application budget exhausted: {0}")]
    Budget(String),
    #[error("application storage failed: {0}")]
    Storage(String),
}

pub struct ApplicationOwner {
    store: Arc<dyn ApplicationRepository>,
    project: String,
    host_incarnation: String,
    gate: Mutex<()>,
}

impl ApplicationOwner {
    pub fn new(project: String, store: Arc<dyn ApplicationRepository>) -> Self {
        Self {
            store,
            project,
            host_incarnation: fresh(),
            gate: Mutex::new(()),
        }
    }
    fn lock(&self) -> Result<MutexGuard<'_, ()>, ApplicationError> {
        self.gate
            .lock()
            .map_err(|_| ApplicationError::Storage("application owner lock poisoned".into()))
    }
    pub fn scope(&self, context: &CallContext) -> Result<ApplicationScope, ApplicationError> {
        context
            .validate()
            .map_err(|e| ApplicationError::InvalidInput(e.to_string()))?;
        Ok(ApplicationScope {
            project: self.project.clone(),
            principal: serde_json::to_string(context.principal()).map_err(storage)?,
        })
    }
    fn load_window(
        &self,
        scope: &ApplicationScope,
        reference: &ApplicationWindowRef,
    ) -> Result<StoredWindow, ApplicationError> {
        validate_window(reference)?;
        let window = self
            .store
            .window(scope, &reference.window_id)?
            .ok_or(ApplicationError::NotFound)?;
        if window.window.incarnation != reference.incarnation {
            return Err(ApplicationError::IncarnationChanged);
        }
        Ok(window)
    }
    fn online(&self, window: &StoredWindow, now: u64) -> bool {
        window.host_incarnation == self.host_incarnation
            && now < window.renewed_at_ms.saturating_add(OFFLINE_AFTER_MS)
    }
    fn require_online(&self, window: &StoredWindow, now: u64) -> Result<(), ApplicationError> {
        if self.online(window, now) {
            Ok(())
        } else {
            Err(ApplicationError::Offline)
        }
    }
    fn bridge_window(
        &self,
        context: &CallContext,
        session: &ApplicationBridgeSession,
        now: u64,
    ) -> Result<(ApplicationScope, StoredWindow), ApplicationError> {
        let scope = self.scope(context)?;
        let window = self.load_window(&scope, &session.window)?;
        if window.bridge_token != session.bridge_token
            || window.connection_id != context.connection_id
            || window.host_incarnation != self.host_incarnation
        {
            return Err(ApplicationError::InvalidBridge);
        }
        self.require_online(&window, now)?;
        Ok((scope, window))
    }
    fn commit(
        &self,
        scope: &ApplicationScope,
        window: &mut StoredWindow,
        changes: ApplicationStoreChanges,
    ) -> Result<(), ApplicationError> {
        let previous = window.revision.clone();
        window.revision = fresh();
        self.store.commit(scope, Some(&previous), window, &changes)
    }
    fn summary(
        &self,
        scope: &ApplicationScope,
        window: &StoredWindow,
        now: u64,
    ) -> Result<ApplicationWindowSummary, ApplicationError> {
        Ok(ApplicationWindowSummary {
            window: window.window.clone(),
            label: window.context.label.clone(),
            online: self.online(window, now),
            renewed_at_ms: window.renewed_at_ms,
            lease_expires_at_ms: window.renewed_at_ms.saturating_add(OFFLINE_AFTER_MS),
            synced_at_ms: window.synced_at_ms,
            context_version: window.context.version.clone(),
            document_count: self.store.documents(scope, &window.window.window_id)?.len(),
        })
    }
    pub fn windows(
        &self,
        context: &CallContext,
        args: ApplicationWindowsArguments,
        now: u64,
    ) -> Result<ApplicationWindows, ApplicationError> {
        let _lock = self.lock()?;
        let scope = self.scope(context)?;
        let limit = page_limit(args.limit)?;
        let windows = self.store.windows(&scope)?;
        let mut selected = windows
            .iter()
            .filter(|w| {
                args.after_window_id
                    .as_ref()
                    .is_none_or(|after| &w.window.window_id > after)
            })
            .take(limit + 1)
            .collect::<Vec<_>>();
        let more = selected.len() > limit;
        selected.truncate(limit);
        let next_after_window_id = if more {
            selected.last().map(|w| w.window.window_id.clone())
        } else {
            None
        };
        Ok(ApplicationWindows {
            windows: selected
                .into_iter()
                .map(|w| self.summary(&scope, w, now))
                .collect::<Result<_, _>>()?,
            next_after_window_id,
        })
    }
    pub fn context(
        &self,
        context: &CallContext,
        args: ApplicationContextArguments,
        now: u64,
    ) -> Result<ApplicationContext, ApplicationError> {
        let _lock = self.lock()?;
        let scope = self.scope(context)?;
        let window = self.load_window(&scope, &args.window)?;
        if !args.allow_offline {
            self.require_online(&window, now)?;
        }
        let documents = self.store.documents(&scope, &args.window.window_id)?;
        let current_document = documents
            .iter()
            .find(|d| Some(&d.document_id) == window.context.active_document_id.as_ref())
            .map(document_summary);
        let limit = page_limit(args.limit)?;
        let mut selected = documents
            .iter()
            .filter(|d| {
                args.after_document_id
                    .as_ref()
                    .is_none_or(|after| &d.document_id > after)
            })
            .take(limit + 1)
            .collect::<Vec<_>>();
        let more = selected.len() > limit;
        selected.truncate(limit);
        Ok(ApplicationContext {
            window: self.summary(&scope, &window, now)?,
            source: source(self.online(&window, now)),
            context: window.context,
            current_document,
            next_after_document_id: if more {
                selected.last().map(|d| d.document_id.clone())
            } else {
                None
            },
            documents: selected.into_iter().map(document_summary).collect(),
        })
    }
    pub fn read_document(
        &self,
        context: &CallContext,
        args: ApplicationReadDocumentArguments,
        now: u64,
    ) -> Result<ApplicationDocumentPage, ApplicationError> {
        let _lock = self.lock()?;
        let scope = self.scope(context)?;
        let window = self.load_window(&scope, &args.window)?;
        if !args.allow_offline {
            self.require_online(&window, now)?;
        }
        let document = self.find_document(&scope, &args.window.window_id, &args.document)?;
        let summary = document_summary(&document);
        let text = match args.content {
            ApplicationDocumentContent::Draft => &document.text,
            ApplicationDocumentContent::Base => document
                .base_text
                .as_ref()
                .ok_or(ApplicationError::NotFound)?,
        };
        let content_sha256 = sha256(text);
        if content_sha256 != args.expected_sha256 {
            return Err(ApplicationError::Conflict);
        }
        let limit = args.limit_bytes.unwrap_or(64 * 1024);
        if limit < 4 || limit > 64 * 1024 {
            return Err(invalid("document page limit must be 4..65536 UTF-8 bytes"));
        }
        if args.offset_utf8 > text.len() || !text.is_char_boundary(args.offset_utf8) {
            return Err(invalid("offset_utf8 is not a UTF-8 boundary"));
        }
        let mut end = args.offset_utf8.saturating_add(limit).min(text.len());
        while !text.is_char_boundary(end) {
            end -= 1;
        }
        Ok(ApplicationDocumentPage {
            window: args.window,
            document: summary,
            source: source(self.online(&window, now)),
            content: args.content,
            content_sha256,
            text: text[args.offset_utf8..end].into(),
            offset_utf8: args.offset_utf8,
            next_offset_utf8: (end < text.len()).then_some(end),
            synced_at_ms: window.synced_at_ms,
        })
    }
    pub fn control(
        &self,
        context: &CallContext,
        request: ApplicationCommandRequest,
        now: u64,
    ) -> Result<ApplicationCommandReceipt, ApplicationError> {
        let _lock = self.lock()?;
        let scope = self.scope(context)?;
        validate_id(&request.request_id)?;
        validate_window(&request.window)?;
        if let Some(stored) =
            self.store
                .command(&scope, &request.window.window_id, &request.request_id)?
        {
            if stored.request != request || stored.context.caller != context.caller {
                return Err(ApplicationError::RequestConflict);
            }
            return Ok(self.effective_receipt(stored.receipt, now));
        }
        let mut window = self.load_window(&scope, &request.window)?;
        self.require_online(&window, now)?;
        let documents = self.store.documents(&scope, &window.window.window_id)?;
        validate_action(&request.action, &window.context, &documents)?;
        if self.store.commands(&scope, &window.window.window_id)?.len() >= MAX_WINDOW_COMMANDS {
            return Err(ApplicationError::Budget(
                "4096 retained command receipts per window; use another explicit window identity"
                    .into(),
            ));
        }
        let capture = self.capture(&scope, &window, &request.action)?;
        let needs_save = matches!(
            request.action,
            ApplicationAction::Save { .. } | ApplicationAction::RunFile { .. }
        );
        let needs_run = matches!(
            request.action,
            ApplicationAction::RunSelection { .. } | ApplicationAction::RunFile { .. }
        );
        let step = |suffix| ApplicationStepReceipt {
            state: ApplicationStepState::NotSubmitted,
            client_request_id: format!("application/{}/{suffix}", fresh()),
            operation_id: None,
            error: None,
            verification: None,
        };
        let receipt = ApplicationCommandReceipt {
            window: request.window.clone(),
            request_id: request.request_id.clone(),
            actor: context.caller.clone(),
            state: ApplicationCommandState::Pending,
            created_at_ms: now,
            claim_expires_at_ms: now.saturating_add(CLAIM_TIMEOUT_MS),
            claimed_at_ms: None,
            completed_at_ms: None,
            context_version: None,
            capture: capture.as_ref().map(|c| c.summary.clone()),
            save: needs_save.then(|| step("save")),
            run: needs_run.then(|| step("run")),
            diagnostic: None,
        };
        let stored = StoredCommand {
            request,
            context: context.clone(),
            receipt: receipt.clone(),
            claim_id: None,
            claim_request_id: None,
            completion_digest: None,
            execution_ref: capture.as_ref().map(|_| fresh()),
            capture,
            save_invocation: None,
            run_invocation: None,
        };
        self.commit(
            &scope,
            &mut window,
            ApplicationStoreChanges {
                commands: vec![stored],
                ..Default::default()
            },
        )?;
        Ok(receipt)
    }
    pub fn command_status(
        &self,
        context: &CallContext,
        args: ApplicationCommandStatusArguments,
        now: u64,
    ) -> Result<ApplicationCommandReceipt, ApplicationError> {
        let _lock = self.lock()?;
        let scope = self.scope(context)?;
        let command = self
            .store
            .command(&scope, &args.window.window_id, &args.request_id)?
            .ok_or(ApplicationError::NotFound)?;
        if command.request.window != args.window {
            return Err(ApplicationError::IncarnationChanged);
        }
        Ok(self.effective_receipt(command.receipt, now))
    }
    fn effective_receipt(
        &self,
        mut receipt: ApplicationCommandReceipt,
        now: u64,
    ) -> ApplicationCommandReceipt {
        if receipt.state == ApplicationCommandState::Pending && now >= receipt.claim_expires_at_ms {
            receipt.state = ApplicationCommandState::Expired;
            receipt.diagnostic = Some("The command was never claimed within 30 seconds; it will not run when a window reopens.".into());
        }
        receipt
    }
    pub fn bridge(
        &self,
        context: &CallContext,
        request: ApplicationBridgeRequest,
        now: u64,
    ) -> Result<ApplicationBridgeReply, ApplicationError> {
        let _lock = self.lock()?;
        match request {
            ApplicationBridgeRequest::Register {
                window_id,
                incarnation,
                label,
                previous_session,
            } => self
                .register(
                    context,
                    window_id,
                    incarnation,
                    label,
                    previous_session,
                    now,
                )
                .map(ApplicationBridgeReply::Registered),
            ApplicationBridgeRequest::Renew { session } => {
                // A known incarnation may renew after a temporary absence, but never across a Host restart.
                let scope = self.scope(context)?;
                let mut window = self.load_window(&scope, &session.window)?;
                if window.bridge_token != session.bridge_token
                    || window.connection_id != context.connection_id
                    || window.host_incarnation != self.host_incarnation
                {
                    return Err(ApplicationError::InvalidBridge);
                }
                window.renewed_at_ms = now;
                self.commit(&scope, &mut window, ApplicationStoreChanges::default())?;
                self.summary(&scope, &window, now)
                    .map(ApplicationBridgeReply::Renewed)
            }
            ApplicationBridgeRequest::Sync {
                session,
                sync_id,
                changes,
            } => {
                let (scope, mut window) = self.bridge_window(context, &session, now)?;
                self.sync(&scope, &mut window, sync_id, changes, now)
                    .map(ApplicationBridgeReply::Synced)
            }
            ApplicationBridgeRequest::Claim {
                session,
                claim_request_id,
            } => {
                let (scope, mut window) = self.bridge_window(context, &session, now)?;
                self.claim(&scope, &mut window, claim_request_id, now)
                    .map(ApplicationBridgeReply::Claimed)
            }
            ApplicationBridgeRequest::Complete {
                session,
                completion,
            } => {
                let (scope, mut window) = self.bridge_window(context, &session, now)?;
                self.complete(&scope, &mut window, completion, now)
                    .map(ApplicationBridgeReply::Completed)
            }
        }
    }
    fn register(
        &self,
        context: &CallContext,
        window_id: String,
        incarnation: String,
        label: String,
        previous_session: Option<ApplicationBridgeSession>,
        now: u64,
    ) -> Result<ApplicationBridgeRegistration, ApplicationError> {
        let scope = self.scope(context)?;
        let reference = ApplicationWindowRef {
            window_id,
            incarnation,
        };
        validate_window(&reference)?;
        if label.len() > 256 {
            return Err(invalid("window label exceeds 256 UTF-8 bytes"));
        }
        let previous = self.store.window(&scope, &reference.window_id)?;
        if let Some(existing) = previous
            .as_ref()
            .filter(|w| w.window == reference && w.host_incarnation == self.host_incarnation)
        {
            if existing.connection_id != context.connection_id {
                return Err(ApplicationError::InvalidBridge);
            }
            return self.registration(&scope, existing);
        }
        let replaces_own = previous
            .as_ref()
            .zip(previous_session.as_ref())
            .is_some_and(|(w, s)| {
                s.window == w.window
                    && s.bridge_token == w.bridge_token
                    && w.connection_id == context.connection_id
            });
        if previous.as_ref().is_some_and(|w| self.online(w, now)) && !replaces_own {
            return Err(ApplicationError::Conflict);
        }
        if previous.is_none() && self.store.windows(&scope)?.len() >= MAX_WINDOWS {
            return Err(ApplicationError::Budget(
                "32 windows per principal and project".into(),
            ));
        }
        let mut state = previous
            .as_ref()
            .map(|w| w.context.clone())
            .unwrap_or_default();
        state.version = fresh();
        state.label = label;
        let window = StoredWindow {
            window: reference,
            revision: fresh(),
            host_incarnation: self.host_incarnation.clone(),
            bridge_token: fresh(),
            connection_id: context.connection_id.clone(),
            renewed_at_ms: now,
            synced_at_ms: previous.as_ref().and_then(|w| w.synced_at_ms),
            context: state,
            last_sync: None,
        };
        let commands = self.store.commands(&scope, &window.window.window_id)?.into_iter().filter_map(|mut command| {
            if command.receipt.state == ApplicationCommandState::Pending { command.receipt.state = ApplicationCommandState::Expired; command.receipt.diagnostic = Some("The window incarnation ended before the command was claimed.".into()); Some(command) }
            else if command.receipt.state == ApplicationCommandState::Claimed { command.receipt.state = ApplicationCommandState::Uncertain; command.receipt.diagnostic = Some("The previous window ended before a receipt was synchronized. Query the original resources and receipt; do not replay the command.".into()); Some(command) }
            else { None }
        }).collect();
        self.store.commit(
            &scope,
            previous.as_ref().map(|w| w.revision.as_str()),
            &window,
            &ApplicationStoreChanges {
                commands,
                ..Default::default()
            },
        )?;
        self.registration(&scope, &window)
    }
    fn registration(
        &self,
        scope: &ApplicationScope,
        window: &StoredWindow,
    ) -> Result<ApplicationBridgeRegistration, ApplicationError> {
        Ok(ApplicationBridgeRegistration {
            session: ApplicationBridgeSession {
                window: window.window.clone(),
                bridge_token: window.bridge_token.clone(),
            },
            context: window.context.clone(),
            documents: self
                .store
                .documents(scope, &window.window.window_id)?
                .iter()
                .map(document_summary)
                .collect(),
            heartbeat_interval_ms: HEARTBEAT_INTERVAL_MS,
            offline_after_ms: OFFLINE_AFTER_MS,
        })
    }
    fn prepare_changes(
        &self,
        scope: &ApplicationScope,
        window: &mut StoredWindow,
        changes: ApplicationChanges,
    ) -> Result<ApplicationStoreChanges, ApplicationError> {
        let mut documents = self.store.documents(scope, &window.window.window_id)?;
        let mut seen = std::collections::BTreeSet::new();
        let mut write = ApplicationStoreChanges::default();
        for update in changes.documents {
            validate_document(&update.document)?;
            if !seen.insert(update.document.document_id.clone()) {
                return Err(invalid("a document appears twice in one change set"));
            }
            let existing = documents
                .iter()
                .position(|d| d.document_id == update.document.document_id);
            if existing.map(|i| documents[i].version.as_str()) != update.expected_version.as_deref()
            {
                return Err(ApplicationError::Conflict);
            }
            if existing.map(|i| documents[i].selection.version.as_str())
                != update.expected_selection_version.as_deref()
            {
                return Err(ApplicationError::Conflict);
            }
            if let Some(i) = existing {
                let mut before = documents[i].clone();
                before.selection = update.document.selection.clone();
                if documents[i].version == update.document.version && before != update.document {
                    return Err(ApplicationError::Conflict);
                }
                if documents[i].selection.version == update.document.selection.version
                    && documents[i].selection != update.document.selection
                {
                    return Err(ApplicationError::Conflict);
                }
                documents[i] = update.document.clone();
            } else {
                documents.push(update.document.clone());
            }
            write.documents.push(update.document);
        }
        for removed in changes.removed_documents {
            if !seen.insert(removed.document_id.clone()) {
                return Err(invalid("a document appears twice in one change set"));
            }
            let index = documents
                .iter()
                .position(|d| d.document_id == removed.document_id)
                .ok_or(ApplicationError::Conflict)?;
            check_document_ref(&documents[index], &removed)?;
            documents.remove(index);
            write.removed_document_ids.push(removed.document_id);
        }
        if documents.len() > MAX_WINDOW_DOCUMENTS
            || documents
                .iter()
                .map(|d| d.text.len() + d.base_text.as_ref().map_or(0, String::len))
                .sum::<usize>()
                > MAX_WINDOW_TEXT_BYTES
        {
            return Err(ApplicationError::Budget(
                "64 documents and 16 MiB of draft/base text per window".into(),
            ));
        }
        if let Some(update) = changes.context {
            if window.context.version != update.expected_version {
                return Err(ApplicationError::Conflict);
            }
            validate_context(&update.context, &documents)?;
            if update.context.version == window.context.version && update.context != window.context
            {
                return Err(ApplicationError::Conflict);
            }
            window.context = update.context;
        } else {
            validate_context(&window.context, &documents)?;
        }
        Ok(write)
    }
    fn sync(
        &self,
        scope: &ApplicationScope,
        window: &mut StoredWindow,
        sync_id: String,
        changes: ApplicationChanges,
        now: u64,
    ) -> Result<ApplicationSyncReceipt, ApplicationError> {
        validate_id(&sync_id)?;
        let digest = encoded_digest(&changes)?;
        if let Some(previous) = &window.last_sync {
            if previous.receipt.sync_id == sync_id {
                return if previous.digest == digest {
                    Ok(previous.receipt.clone())
                } else {
                    Err(ApplicationError::RequestConflict)
                };
            }
        }
        let write = self.prepare_changes(scope, window, changes)?;
        let receipt = ApplicationSyncReceipt {
            sync_id,
            synced_at_ms: now,
            context_version: window.context.version.clone(),
            document_versions: write.documents.iter().map(document_ref).collect(),
        };
        window.synced_at_ms = Some(now);
        window.last_sync = Some(StoredSync {
            digest,
            receipt: receipt.clone(),
        });
        self.commit(scope, window, write)?;
        Ok(receipt)
    }
    fn claim(
        &self,
        scope: &ApplicationScope,
        window: &mut StoredWindow,
        claim_request_id: String,
        now: u64,
    ) -> Result<Option<ApplicationCommandGrant>, ApplicationError> {
        // The bridge retries only the original delivery identity after a lost
        // response. A second claim cannot acquire or apply that local command.
        validate_id(&claim_request_id)?;
        let commands = self.store.commands(scope, &window.window.window_id)?;
        if let Some(command) = commands.iter().find(|c| {
            c.request.window == window.window
                && c.claim_request_id.as_ref() == Some(&claim_request_id)
        }) {
            return Ok(Some(ApplicationCommandGrant {
                request: command.request.clone(),
                claim_id: command
                    .claim_id
                    .clone()
                    .ok_or_else(|| storage("claimed delivery has no claim identity"))?,
                capture: command.receipt.capture.clone(),
                execution_ref: command.execution_ref.clone(),
            }));
        }
        if commands.iter().any(|c| {
            c.request.window == window.window && c.receipt.state == ApplicationCommandState::Claimed
        }) {
            return Ok(None);
        }
        let mut candidates = commands
            .into_iter()
            .filter(|c| {
                c.request.window == window.window
                    && c.receipt.state == ApplicationCommandState::Pending
                    && now < c.receipt.claim_expires_at_ms
            })
            .collect::<Vec<_>>();
        candidates.sort_by_key(|c| (c.receipt.created_at_ms, c.request.request_id.clone()));
        let Some(mut command) = candidates.into_iter().next() else {
            return Ok(None);
        };
        let documents = self.store.documents(scope, &window.window.window_id)?;
        if let Err(error) = validate_action(&command.request.action, &window.context, &documents) {
            command.receipt.state = ApplicationCommandState::Failed;
            command.receipt.diagnostic = Some(error.to_string());
            self.commit(
                scope,
                window,
                ApplicationStoreChanges {
                    commands: vec![command],
                    ..Default::default()
                },
            )?;
            return Ok(None);
        }
        let claim_id = fresh();
        command.claim_id = Some(claim_id.clone());
        command.claim_request_id = Some(claim_request_id);
        command.receipt.state = ApplicationCommandState::Claimed;
        command.receipt.claimed_at_ms = Some(now);
        let grant = ApplicationCommandGrant {
            request: command.request.clone(),
            claim_id,
            capture: command.receipt.capture.clone(),
            execution_ref: command.execution_ref.clone(),
        };
        self.commit(
            scope,
            window,
            ApplicationStoreChanges {
                commands: vec![command],
                ..Default::default()
            },
        )?;
        Ok(Some(grant))
    }
    fn complete(
        &self,
        scope: &ApplicationScope,
        window: &mut StoredWindow,
        completion: ApplicationCommandCompletion,
        now: u64,
    ) -> Result<ApplicationCommandReceipt, ApplicationError> {
        let mut command = self
            .store
            .command(scope, &window.window.window_id, &completion.request_id)?
            .ok_or(ApplicationError::NotFound)?;
        if command.request.window != window.window
            || command.claim_id.as_ref() != Some(&completion.claim_id)
        {
            return Err(ApplicationError::InvalidBridge);
        }
        let digest = encoded_digest(&completion)?;
        if let Some(previous) = &command.completion_digest {
            return if previous == &digest {
                Ok(command.receipt)
            } else {
                Err(ApplicationError::RequestConflict)
            };
        }
        if command.receipt.state != ApplicationCommandState::Claimed {
            return Err(ApplicationError::Conflict);
        }
        if completion
            .diagnostic
            .as_ref()
            .is_some_and(|d| d.len() > 4096)
        {
            return Err(invalid("diagnostic exceeds 4096 UTF-8 bytes"));
        }
        let prior_window = window.clone();
        let original_documents = self.store.documents(scope, &window.window.window_id)?;
        let mut write = ApplicationStoreChanges::default();
        command.receipt.state = match completion.outcome {
            ApplicationLocalOutcome::Applied => {
                match self
                    .prepare_changes(scope, window, completion.changes)
                    .and_then(|changes| {
                        validate_applied_state(
                            &command.request.action,
                            &window.context,
                            &original_documents,
                            &changes,
                        )?;
                        Ok(changes)
                    }) {
                    Ok(changes) => {
                        write = changes;
                        if command.capture.is_some() {
                            ApplicationCommandState::AwaitingExecution
                        } else {
                            ApplicationCommandState::Applied
                        }
                    }
                    Err(error) => {
                        *window = prior_window;
                        command.receipt.diagnostic = Some(format!(
                            "The bridge reported a local action, but synchronized resources could not confirm it: {error}. Read current resources; do not replay the local action."
                        ));
                        if matches!(error, ApplicationError::InvalidInput(_)) {
                            ApplicationCommandState::Uncertain
                        } else {
                            ApplicationCommandState::LocallyAppliedUnsynced
                        }
                    }
                }
            }
            ApplicationLocalOutcome::Rejected => ApplicationCommandState::Failed,
            ApplicationLocalOutcome::LocallyAppliedUnsynced => {
                ApplicationCommandState::LocallyAppliedUnsynced
            }
        };
        if command.receipt.diagnostic.is_none() {
            command.receipt.diagnostic = completion.diagnostic;
        }
        command.receipt.completed_at_ms = Some(now);
        command.receipt.context_version = Some(window.context.version.clone());
        command.completion_digest = Some(digest);
        let receipt = command.receipt.clone();
        write.commands.push(command);
        window.synced_at_ms = Some(now);
        self.commit(scope, window, write)?;
        Ok(receipt)
    }
    fn find_document(
        &self,
        scope: &ApplicationScope,
        window_id: &str,
        reference: &ApplicationDocumentRef,
    ) -> Result<ApplicationDocument, ApplicationError> {
        let document = self
            .store
            .documents(scope, window_id)?
            .into_iter()
            .find(|d| d.document_id == reference.document_id)
            .ok_or(ApplicationError::NotFound)?;
        check_document_ref(&document, reference)?;
        Ok(document)
    }
    pub fn method_bindings(
        &self,
        context: &CallContext,
    ) -> Result<Vec<ApplicationMethodBinding>, ApplicationError> {
        let _lock = self.lock()?;
        self.store.method_bindings(&self.scope(context)?)
    }
    /// Host/Skill owner must first validate source enablement, explicit exclusions,
    /// resource digests and conditions. This port preserves the declared binding.
    pub fn write_method_binding(
        &self,
        context: &CallContext,
        expected_version: Option<&str>,
        binding: &ApplicationMethodBinding,
    ) -> Result<(), ApplicationError> {
        let _lock = self.lock()?;
        validate_id(&binding.binding_id)?;
        validate_id(&binding.version)?;
        validate_relative_directory(&binding.working_directory)?;
        if serde_json::to_vec(binding).map_err(storage)?.len() > 64 * 1024 {
            return Err(ApplicationError::Budget(
                "method binding exceeds 64 KiB".into(),
            ));
        }
        self.store
            .write_method_binding(&self.scope(context)?, expected_version, binding)
    }
    pub fn record_skill_read(
        &self,
        context: &CallContext,
        receipt: &ApplicationSkillReadReceipt,
    ) -> Result<(), ApplicationError> {
        let _lock = self.lock()?;
        validate_relative_directory(&receipt.working_directory)?;
        if serde_json::to_vec(receipt).map_err(storage)?.len() > 16 * 1024 {
            return Err(ApplicationError::Budget(
                "skill read receipt exceeds 16 KiB".into(),
            ));
        }
        self.store.record_skill_read(&self.scope(context)?, receipt)
    }
    pub fn skill_reads(
        &self,
        context: &CallContext,
        external_task_ref: Option<&str>,
    ) -> Result<Vec<ApplicationSkillReadReceipt>, ApplicationError> {
        let _lock = self.lock()?;
        self.store
            .skill_reads(&self.scope(context)?, external_task_ref)
    }
}

pub fn sha256(text: impl AsRef<[u8]>) -> String {
    format!("sha256:{:x}", Sha256::digest(text.as_ref()))
}
pub fn document_ref(document: &ApplicationDocument) -> ApplicationDocumentRef {
    ApplicationDocumentRef {
        document_id: document.document_id.clone(),
        document_version: document.version.clone(),
        selection_version: document.selection.version.clone(),
    }
}
pub fn document_summary(document: &ApplicationDocument) -> ApplicationDocumentSummary {
    ApplicationDocumentSummary {
        document: document_ref(document),
        path: document.path.clone(),
        sha256: sha256(&document.text),
        base_hash: document.base_hash.clone(),
        base_text_present: document.base_text.is_some(),
        utf8_bytes: document.text.len(),
        dirty: document.base_text.as_ref() != Some(&document.text),
        selection: document.selection.clone(),
        readonly_reason: document.readonly_reason.clone(),
    }
}
fn fresh() -> String {
    uuid::Uuid::new_v4().to_string()
}
fn source(online: bool) -> String {
    if online {
        "live_bridge"
    } else {
        "synced_history"
    }
    .into()
}
fn storage(error: impl std::fmt::Display) -> ApplicationError {
    ApplicationError::Storage(error.to_string())
}
fn invalid(message: impl Into<String>) -> ApplicationError {
    ApplicationError::InvalidInput(message.into())
}
fn encoded_digest(value: &impl serde::Serialize) -> Result<String, ApplicationError> {
    Ok(sha256(serde_json::to_vec(value).map_err(storage)?))
}
fn page_limit(value: Option<usize>) -> Result<usize, ApplicationError> {
    let limit = value.unwrap_or(20);
    if !(1..=50).contains(&limit) {
        return Err(invalid("page limit must be 1..50 entries"));
    }
    Ok(limit)
}

#[cfg(test)]
mod tests;
