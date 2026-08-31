use rho_protocol::*;
use rho_store::*;

fn projection(
    provider_session_id: &str,
    logical_session_id: &str,
    external_id: &str,
    incarnation: u64,
) -> ProviderSessionProjection {
    ProviderSessionProjection {
        provider_session_id: ProviderSessionId::new(provider_session_id).unwrap(),
        logical_session_id: SessionId::new(logical_session_id).unwrap(),
        provider_id: ProviderId::new("provider_external_observer").unwrap(),
        protocol: "acp/1".to_string(),
        provider_version: "observer-1.2.3".to_string(),
        external_session_id: external_id.to_string(),
        capability_snapshot_digest:
            "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa".to_string(),
        supports_resume: true,
        lifecycle: ProviderSessionLifecycle::Active,
        continuity_mode: ProviderContinuityMode::ExactResume,
        process_incarnation: incarnation,
        source_event_id: format!("event_provider_session_{incarnation}"),
        closed_event_id: None,
    }
}

#[test]
fn provider_session_projection_persists_replaceable_associations_under_logical_identity() {
    let temp = tempfile::tempdir().unwrap();
    let db = temp.path().join("app/semantic.sqlite3");
    let (store, _) = SemanticStore::open_app_local(temp.path(), &db).unwrap();
    store
        .upsert_provider_session(&projection(
            "provider_session_one",
            "session_logical",
            "external_a",
            1,
        ))
        .unwrap();
    store
        .upsert_provider_session(&projection(
            "provider_session_two",
            "session_logical",
            "external_b",
            2,
        ))
        .unwrap();

    let sessions = store
        .list_provider_sessions(&SessionId::new("session_logical").unwrap())
        .unwrap();
    assert_eq!(sessions.len(), 2);
    assert!(
        sessions
            .iter()
            .all(|item| item.logical_session_id.as_str() == "session_logical")
    );
    assert_ne!(
        sessions[0].provider_session_id,
        sessions[1].provider_session_id
    );
}

#[test]
fn provider_session_close_is_scoped_idempotent_and_cannot_close_other_logical_session() {
    let temp = tempfile::tempdir().unwrap();
    let db = temp.path().join("app/semantic.sqlite3");
    let (store, _) = SemanticStore::open_app_local(temp.path(), &db).unwrap();
    let item = projection(
        "provider_session_close",
        "session_owner",
        "external_close",
        1,
    );
    store.upsert_provider_session(&item).unwrap();
    assert!(matches!(
        store.close_provider_session(
            &SessionId::new("session_other").unwrap(),
            &item.provider_session_id,
            "event_wrong_close"
        ),
        Err(ProviderSessionStoreError::WrongLogicalSession)
    ));
    assert_eq!(
        store
            .close_provider_session(
                &item.logical_session_id,
                &item.provider_session_id,
                "event_close"
            )
            .unwrap(),
        ProviderSessionCloseOutcome::Closed
    );
    assert_eq!(
        store
            .close_provider_session(
                &item.logical_session_id,
                &item.provider_session_id,
                "event_close_duplicate"
            )
            .unwrap(),
        ProviderSessionCloseOutcome::AlreadyClosed
    );
    let stored = store
        .provider_session(&item.provider_session_id)
        .unwrap()
        .unwrap();
    assert_eq!(stored.lifecycle, ProviderSessionLifecycle::Closed);
    assert_eq!(stored.closed_event_id.as_deref(), Some("event_close"));
}

#[test]
fn provider_session_external_id_is_not_domain_primary_key() {
    let temp = tempfile::tempdir().unwrap();
    let db = temp.path().join("app/semantic.sqlite3");
    let (store, _) = SemanticStore::open_app_local(temp.path(), &db).unwrap();
    let one = projection("provider_session_ext_one", "session_a", "same_external", 1);
    let two = projection("provider_session_ext_two", "session_b", "same_external", 1);
    store.upsert_provider_session(&one).unwrap();
    store.upsert_provider_session(&two).unwrap();
    assert!(
        store
            .provider_session(&one.provider_session_id)
            .unwrap()
            .is_some()
    );
    assert!(
        store
            .provider_session(&two.provider_session_id)
            .unwrap()
            .is_some()
    );
}
