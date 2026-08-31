use std::collections::VecDeque;

use rho_agent_host::session::*;
use rho_protocol::*;

#[derive(Default)]
struct FakeSessionAdapter {
    create_ids: VecDeque<String>,
    resume: Option<Result<String, ProviderSessionAdapterError>>,
    closed: Vec<String>,
}

impl ProviderSessionAdapter for FakeSessionAdapter {
    fn create_session(
        &mut self,
        _request: ProviderSessionCreateRequest,
    ) -> Result<String, ProviderSessionAdapterError> {
        self.create_ids
            .pop_front()
            .ok_or(ProviderSessionAdapterError::Failed)
    }

    fn resume_session(
        &mut self,
        _request: ProviderSessionResumeRequest,
    ) -> Result<String, ProviderSessionAdapterError> {
        self.resume
            .take()
            .unwrap_or(Err(ProviderSessionAdapterError::Unsupported))
    }

    fn close_session(
        &mut self,
        external_session_id: &str,
    ) -> Result<(), ProviderSessionAdapterError> {
        self.closed.push(external_session_id.to_string());
        Ok(())
    }
}

fn attach(
    manager: &mut LogicalSessionManager,
    session_id: &SessionId,
    provider: &str,
    supports_resume: bool,
    incarnation: u64,
    adapter: &mut FakeSessionAdapter,
) -> ProviderSessionAssociation {
    manager
        .attach_provider(
            ProviderAttachmentRequest {
                logical_session_id: session_id.clone(),
                provider_id: ProviderId::new(provider).unwrap(),
                protocol: "acp/1".to_string(),
                provider_version: "observer-1".to_string(),
                capability_snapshot_digest:
                    "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
                        .to_string(),
                capability_ids: vec![CapabilityId::new("workspace.inspect").unwrap()],
                supports_resume,
                process_incarnation: incarnation,
                context_digest: "sha256:bounded-context".to_string(),
            },
            adapter,
        )
        .unwrap()
}

#[test]
fn session_provider_switch_preserves_logical_turn_job_and_artifact_ids() {
    let logical_id = SessionId::new("session_durable").unwrap();
    let mut manager = LogicalSessionManager::new();
    manager.create_logical(logical_id.clone());
    manager
        .record_durable_truth(&logical_id, "turn_1", "job_1", "artifact_1")
        .unwrap();
    let mut first = FakeSessionAdapter {
        create_ids: ["external_first".to_string()].into(),
        ..FakeSessionAdapter::default()
    };
    let first_association = attach(
        &mut manager,
        &logical_id,
        "provider_first",
        true,
        1,
        &mut first,
    );
    let mut second = FakeSessionAdapter {
        create_ids: ["external_second".to_string()].into(),
        ..FakeSessionAdapter::default()
    };
    let second_association = attach(
        &mut manager,
        &logical_id,
        "provider_external",
        false,
        1,
        &mut second,
    );
    let logical = manager.logical(&logical_id).unwrap();
    assert_eq!(logical.session_id, logical_id);
    assert!(logical.durable_turn_ids.contains("turn_1"));
    assert!(logical.durable_job_ids.contains("job_1"));
    assert!(logical.durable_artifact_ids.contains("artifact_1"));
    assert_ne!(
        first_association.provider_session_id,
        second_association.provider_session_id
    );
    assert_eq!(manager.list_provider_sessions(&logical_id).len(), 2);
}

#[test]
fn session_restart_exact_resume_or_explicit_fallback_continuity() {
    let logical_id = SessionId::new("session_resume").unwrap();
    let mut manager = LogicalSessionManager::new();
    manager.create_logical(logical_id.clone());
    let mut initial = FakeSessionAdapter {
        create_ids: ["external_initial".to_string()].into(),
        ..FakeSessionAdapter::default()
    };
    let association = attach(
        &mut manager,
        &logical_id,
        "provider_resume",
        true,
        1,
        &mut initial,
    );

    let mut resume = FakeSessionAdapter {
        resume: Some(Ok("external_resumed".to_string())),
        ..FakeSessionAdapter::default()
    };
    let resumed = manager
        .recover_after_process_restart(
            &logical_id,
            &association.provider_session_id,
            2,
            "sha256:context",
            &mut resume,
        )
        .unwrap();
    assert_eq!(resumed.continuity, SessionContinuity::ExactResume);

    let mut lost = FakeSessionAdapter {
        create_ids: ["external_rehydrated".to_string()].into(),
        resume: Some(Err(ProviderSessionAdapterError::Lost)),
        ..FakeSessionAdapter::default()
    };
    let fallback = manager
        .recover_after_process_restart(
            &logical_id,
            &resumed.provider_session_id,
            3,
            "sha256:bounded-context",
            &mut lost,
        )
        .unwrap();
    assert_eq!(
        fallback.continuity,
        SessionContinuity::NewProviderSessionRehydrated
    );
}

#[test]
fn session_provider_without_resume_creates_new_context_and_marks_reset() {
    let logical_id = SessionId::new("session_no_resume").unwrap();
    let mut manager = LogicalSessionManager::new();
    manager.create_logical(logical_id.clone());
    let mut initial = FakeSessionAdapter {
        create_ids: ["external_initial".to_string()].into(),
        ..FakeSessionAdapter::default()
    };
    let association = attach(
        &mut manager,
        &logical_id,
        "provider_no_resume",
        false,
        1,
        &mut initial,
    );
    let mut restarted = FakeSessionAdapter {
        create_ids: ["external_reset".to_string()].into(),
        ..FakeSessionAdapter::default()
    };
    let recovered = manager
        .recover_after_process_restart(
            &logical_id,
            &association.provider_session_id,
            2,
            "sha256:bounded-context",
            &mut restarted,
        )
        .unwrap();
    assert_eq!(recovered.continuity, SessionContinuity::ModelContextReset);
}

#[test]
fn session_stale_provider_id_and_process_reincarnation_fail_closed() {
    let logical_id = SessionId::new("session_stale").unwrap();
    let mut manager = LogicalSessionManager::new();
    manager.create_logical(logical_id.clone());
    let mut adapter = FakeSessionAdapter {
        create_ids: ["external_stale".to_string()].into(),
        ..FakeSessionAdapter::default()
    };
    let association = attach(
        &mut manager,
        &logical_id,
        "provider_stale",
        true,
        4,
        &mut adapter,
    );
    assert_eq!(
        manager
            .recover_after_process_restart(
                &logical_id,
                &association.provider_session_id,
                4,
                "sha256:context",
                &mut adapter,
            )
            .unwrap_err(),
        SessionManagerError::StaleProviderSession
    );
    assert!(matches!(
        manager.recover_after_process_restart(
            &logical_id,
            &ProviderSessionId::new("provider_session_missing").unwrap(),
            5,
            "sha256:context",
            &mut adapter,
        ),
        Err(SessionManagerError::UnknownProviderSession(_))
    ));
}

#[test]
fn session_close_is_idempotent_and_never_closes_other_logical_session() {
    let one = SessionId::new("session_close_one").unwrap();
    let two = SessionId::new("session_close_two").unwrap();
    let mut manager = LogicalSessionManager::new();
    manager.create_logical(one.clone());
    manager.create_logical(two.clone());
    let mut adapter = FakeSessionAdapter {
        create_ids: ["external_close".to_string()].into(),
        ..FakeSessionAdapter::default()
    };
    let association = attach(&mut manager, &one, "provider_close", true, 1, &mut adapter);
    assert_eq!(
        manager
            .close_provider(&two, &association.provider_session_id, &mut adapter)
            .unwrap_err(),
        SessionManagerError::WrongLogicalSession
    );
    assert_eq!(
        manager
            .close_provider(&one, &association.provider_session_id, &mut adapter)
            .unwrap(),
        CloseSessionOutcome::Closed
    );
    assert_eq!(
        manager
            .close_provider(&one, &association.provider_session_id, &mut adapter)
            .unwrap(),
        CloseSessionOutcome::AlreadyClosed
    );
    assert_eq!(adapter.closed, vec!["external_close"]);
}

#[test]
fn session_external_id_never_appears_as_domain_primary_identity() {
    let source = include_str!("../src/session/mod.rs");
    let (_, does_not_own) = session_boundary();
    assert!(does_not_own.contains(&"external_id_as_primary_key"));
    assert!(!source.contains("pub fn logical_by_external"));
}
