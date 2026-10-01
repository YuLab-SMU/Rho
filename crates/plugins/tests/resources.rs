use rho_plugin_protocol::*;
use rho_plugins::*;
use serde_json::json;
use std::io::Cursor;

fn call() -> PluginCall {
    PluginCall {
        request: RequestId::new("active-request").unwrap(),
        binding: ProviderBinding {
            capability: CapabilityKey {
                id: ContributionId::new("fixture.run").unwrap(),
                version: 1,
            },
            provider: InstanceRef {
                instance: PluginInstanceId::new("original-instance").unwrap(),
                plugin: PluginId::new("fixture.plugin").unwrap(),
                revision: RevisionId::new(format!("sha256:{}", "1".repeat(64))).unwrap(),
                artifact: ArtifactId::new(format!("sha256:{}", "2".repeat(64))).unwrap(),
            },
            project: ProjectId::new("project-a").unwrap(),
            target: None,
        },
        principal: PrincipalId::new("principal-a").unwrap(),
        scopes: Default::default(),
        arguments: json!({}),
        preconditions: json!({}),
        owner_context: json!({}),
        operation_id: Some("original-operation".into()),
    }
}
fn declaration(bytes: &[u8]) -> ResourceDeclaration {
    ResourceDeclaration {
        digest: content_digest(bytes),
        media_type: "text/html; charset=utf-8".into(),
        bytes: bytes.len() as u64,
    }
}

#[test]
fn retained_bytes_survive_restart_and_reads_are_bounded_and_principal_scoped() {
    let temp = tempfile::tempdir().unwrap();
    let call = call();
    let bytes: Vec<u8> = (0..180_003).map(|i| (i % 251) as u8).collect();
    let reference = {
        let store = PluginResources::open(temp.path()).unwrap();
        let reference = store
            .retain(&call, &declaration(&bytes), Cursor::new(&bytes))
            .unwrap();
        assert_eq!(
            reference,
            store
                .retain(&call, &declaration(&bytes), Cursor::new(&bytes))
                .unwrap()
        );
        reference
    };
    let store = PluginResources::open(temp.path()).unwrap();
    assert_eq!(
        store
            .inspect(&call.binding.project, &call.principal, &reference)
            .unwrap(),
        reference
    );
    for (offset, limit) in [(0, 1), (65530, 100), (99999, 262144), (180003, 1)] {
        let read = ResourceRead {
            reference: reference.clone(),
            offset,
            limit,
        };
        let actual = store
            .read(&call.binding.project, &call.principal, &read)
            .unwrap();
        assert_eq!(
            actual,
            bytes[offset as usize..bytes.len().min(offset as usize + limit as usize)]
        );
    }
    assert!(
        store
            .inspect(
                &ProjectId::new("other-project").unwrap(),
                &call.principal,
                &reference
            )
            .is_err()
    );
    assert!(
        store
            .inspect(
                &call.binding.project,
                &PrincipalId::new("other-principal").unwrap(),
                &reference
            )
            .is_err()
    );
    let mut forged = reference.clone();
    forged.owner.instance = PluginInstanceId::new("impostor").unwrap();
    assert!(
        store
            .inspect(&call.binding.project, &call.principal, &forged)
            .is_err()
    );
    forged = reference.clone();
    forged.digest = content_digest(b"different");
    assert!(
        store
            .inspect(&call.binding.project, &call.principal, &forged)
            .is_err()
    );
    forged = reference.clone();
    forged.media_type = "text/plain".into();
    assert!(
        store
            .inspect(&call.binding.project, &call.principal, &forged)
            .is_err()
    );
    forged = reference.clone();
    forged.bytes -= 1;
    assert!(
        store
            .inspect(&call.binding.project, &call.principal, &forged)
            .is_err()
    );
    for (offset, limit) in [(0, 0), (0, 262145), (180004, 1), (u64::MAX, 1)] {
        assert!(
            store
                .read(
                    &call.binding.project,
                    &call.principal,
                    &ResourceRead {
                        reference: reference.clone(),
                        offset,
                        limit
                    }
                )
                .is_err()
        );
    }
}

#[test]
fn incomplete_corrupt_and_over_quota_uploads_never_become_evidence() {
    let temp = tempfile::tempdir().unwrap();
    let store = PluginResources::open_with_limits(
        temp.path(),
        ResourceLimits {
            bytes: 20,
            instance_bytes: 8,
            total_bytes: 10,
            count: 2,
        },
    )
    .unwrap();
    let call = call();
    let bytes = b"sample";
    assert!(
        store
            .retain(&call, &declaration(bytes), Cursor::new(b"sam"))
            .is_err()
    );
    assert!(
        store
            .retain(&call, &declaration(bytes), Cursor::new(b"sample-extra"))
            .is_err()
    );
    assert!(
        store
            .retain(&call, &declaration(bytes), Cursor::new(b"differ"))
            .is_err()
    );
    let first = store
        .retain(&call, &declaration(bytes), Cursor::new(bytes))
        .unwrap();
    assert!(
        store
            .retain(&call, &declaration(b"next"), Cursor::new(b"next"))
            .is_err()
    );
    assert_eq!(
        store
            .retain(&call, &declaration(bytes), Cursor::new(bytes))
            .unwrap(),
        first
    );
    let mut other = call.clone();
    other.binding.provider.instance = PluginInstanceId::new("other-instance").unwrap();
    let second = store
        .retain(&other, &declaration(b"next"), Cursor::new(b"next"))
        .unwrap();
    assert_ne!(first.resource, second.resource);
    let page = store
        .list(
            &call.binding.project,
            &call.principal,
            &ResourceList {
                owner: None,
                after: None,
                limit: 1,
            },
        )
        .unwrap();
    assert_eq!(page.total, 2);
    assert_eq!(page.items.len(), 1);
    assert!(page.next.is_some());
    let next = store
        .list(
            &call.binding.project,
            &call.principal,
            &ResourceList {
                owner: None,
                after: page.next,
                limit: 1,
            },
        )
        .unwrap();
    assert_eq!(next.total, 2);
    assert_eq!(next.items.len(), 1);
    assert!(next.next.is_none());
    assert_ne!(next.items, page.items);
    let owner_page = store
        .list(
            &call.binding.project,
            &call.principal,
            &ResourceList {
                owner: Some(other.binding.provider.clone()),
                after: None,
                limit: 1,
            },
        )
        .unwrap();
    assert_eq!(owner_page.items, [second]);
    assert_eq!(owner_page.total, 1);
    let mut forged_owner = other.binding.provider.clone();
    forged_owner.plugin = PluginId::new("impostor").unwrap();
    assert_eq!(
        store
            .list(
                &call.binding.project,
                &call.principal,
                &ResourceList {
                    owner: Some(forged_owner),
                    after: None,
                    limit: 1
                }
            )
            .unwrap()
            .total,
        0
    );
    assert_eq!(
        store
            .list(
                &call.binding.project,
                &PrincipalId::new("stranger").unwrap(),
                &ResourceList {
                    owner: None,
                    after: None,
                    limit: 1
                }
            )
            .unwrap()
            .total,
        0
    );
    assert!(
        store
            .retain(&other, &declaration(b"x"), Cursor::new(b"x"))
            .is_err()
    );
    assert!(
        store
            .inspect(&call.binding.project, &call.principal, &first)
            .is_ok()
    );
    let db = rusqlite::Connection::open(temp.path().join("resources-v1.sqlite3")).unwrap();
    db.execute(
        "UPDATE resource_chunks SET bytes=? WHERE resource=?",
        rusqlite::params![b"broken", first.resource.as_str()],
    )
    .unwrap();
    assert!(
        store
            .inspect(&call.binding.project, &call.principal, &first)
            .is_err()
    );
    assert!(
        store
            .read(
                &call.binding.project,
                &call.principal,
                &ResourceRead {
                    reference: first.clone(),
                    offset: 0,
                    limit: 6
                }
            )
            .is_err()
    );
    assert!(
        store
            .retain(&call, &declaration(bytes), Cursor::new(bytes))
            .is_err(),
        "duplicate does not conceal retained corruption"
    );
}

#[test]
fn empty_resources_are_real_objects_and_mime_headers_reject_control_characters() {
    let temp = tempfile::tempdir().unwrap();
    let store = PluginResources::open(temp.path()).unwrap();
    let call = call();
    let reference = store
        .retain(&call, &declaration(b""), Cursor::new(b""))
        .unwrap();
    assert!(
        store
            .inspect(&call.binding.project, &call.principal, &reference)
            .is_ok()
    );
    for media_type in [
        "text/html\r\nSet-Cookie: no",
        "text",
        "text/",
        "text/html\0",
        " /plain",
    ] {
        let mut declaration = declaration(b"");
        declaration.media_type = media_type.into();
        assert!(store.retain(&call, &declaration, Cursor::new(b"")).is_err());
    }
}

#[test]
fn unsupported_resource_storage_is_refused_without_ddl_or_journal_changes() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("resources-v1.sqlite3");
    let connection = rusqlite::Connection::open(&path).unwrap();
    connection.execute_batch("CREATE TABLE resource_schema(version INTEGER); INSERT INTO resource_schema VALUES(99);").unwrap();
    drop(connection);
    let before = std::fs::read(&path).unwrap();
    assert!(PluginResources::open(temp.path()).is_err());
    assert_eq!(std::fs::read(&path).unwrap(), before);
    assert!(!temp.path().join("resources-v1.sqlite3-wal").exists());
}
