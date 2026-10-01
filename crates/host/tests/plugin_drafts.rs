use base64::{Engine, engine::general_purpose::STANDARD};
use rho_contract::*;
use rho_host::{NextHost, OperationError};
use rho_plugin_protocol::{PluginArchive, PluginViewConnection, PluginViewMessage};
use rho_plugins::{PluginRepository, content_digest, repository_path, snapshot_directory};
use serde_json::{Value, json};
use std::{fs, path::Path};

fn package(path: &Path) -> PluginArchive {
    fs::create_dir_all(path.join("dist")).unwrap();
    for (name, contents) in [
        ("index.html", "<!doctype html><p>Draft fixture</p>"),
        ("dist/index.html", "<!doctype html><p>Draft fixture</p>"),
        ("deps.lock", "No dependencies"),
        ("BUILD.md", "Copy index.html to dist/index.html"),
    ] {
        fs::write(path.join(name), contents).unwrap();
    }
    let requirements = ["documents.list", "documents.inspect", "documents.read", "documents.stage", "documents.save", "documents.discard"].map(|id| json!({"capability":{"id":id,"version":1},"scopes":[if matches!(id,"documents.list"|"documents.inspect"|"documents.read") {"documents.read"}else{"documents.write"}]}));
    fs::write(path.join("plugin.json"), serde_json::to_vec(&json!({
        "protocol_version":1,"id":"example.drafts","name":"Draft fixture","version":"1","description":"Independent generic draft view","license":"MIT",
        "source":{"files":["index.html"],"lockfiles":["deps.lock"],"build_instructions":"BUILD.md","build":null},
        "dependencies":{},"requires":requirements,"capabilities":[],"contexts":[],"backend":null,
        "views":[{"id":"document","title":"Document","entrypoint":"dist/index.html","state_schema":{"type":"object"},"configuration_schema":{"type":"object"},"resource_kinds":[]}],
        "configuration_schema":{"type":"object"},"default_configuration":{}
    })).unwrap()).unwrap();
    snapshot_directory(path, None, "ui-web").unwrap()
}
struct Fixture {
    temp: tempfile::TempDir,
    root: std::path::PathBuf,
    db: std::path::PathBuf,
    archive: PluginArchive,
}
impl Fixture {
    fn new() -> Self {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("project");
        fs::create_dir(&root).unwrap();
        let db = temp.path().join("state.sqlite");
        let archive = package(&temp.path().join("package"));
        PluginRepository::open(&repository_path(&db))
            .unwrap()
            .import(&archive)
            .unwrap();
        Self {
            temp,
            root,
            db,
            archive,
        }
    }
    fn catalog(&self) -> rusqlite::Connection {
        rusqlite::Connection::open(repository_path(&self.db).join("catalog-v1.sqlite3")).unwrap()
    }
    fn pin_count(&self) -> u32 {
        self.catalog()
            .query_row("SELECT COUNT(*) FROM draft_upload_operations", [], |row| {
                row.get(0)
            })
            .unwrap()
    }
    fn save(&self, upload: &str, version: Option<u32>, content: Value) -> Value {
        json!({"window":"window-a","draft":"draft-a","upload":upload,"source":{"revision":self.archive.revision.id,"contribution":"document"},"expected_version":version,"content":content,"metadata":{"name":"研究.R","encoding":"opaque-test"}})
    }
    fn discard(&self, version: u32) -> Value {
        json!({"window":"window-a","draft":"draft-a","source":{"revision":self.archive.revision.id,"contribution":"document"},"expected_version":version})
    }
}
fn invoke(id: &str, cap: &str, arguments: Value) -> Invocation {
    Invocation {
        client_request_id: id.into(),
        capability: CapabilityRef::new(cap, 1).unwrap(),
        arguments,
        preconditions: vec![],
    }
}
async fn query(
    host: &NextHost,
    context: &CallContext,
    cap: &str,
    arguments: Value,
) -> Result<Value, OperationError> {
    Ok(host
        .query_snapshot(
            context,
            QueryRequest {
                capability: CapabilityRef::new(cap, 1).unwrap(),
                arguments,
            },
        )
        .await?
        .data
        .unwrap())
}
async fn control(
    host: &NextHost,
    context: &CallContext,
    cap: &str,
    arguments: Value,
) -> Result<Value, OperationError> {
    host.dispatch(
        context,
        HostRequest::Control(ControlRequest {
            capability: CapabilityRef::new(cap, 1).unwrap(),
            arguments,
        }),
    )
    .await
}
fn stage_args(upload: &str, bytes: &[u8]) -> Value {
    json!({"window":"window-a","draft":"draft-a","upload":upload,"digest":content_digest(bytes),"base64":STANDARD.encode(bytes)})
}
async fn stage(host: &NextHost, context: &CallContext, upload: &str, bytes: &[u8]) -> Value {
    let mut chunks = vec![];
    for chunk in bytes.chunks(65536) {
        chunks.push(
            control(host, context, "documents.stage", stage_args(upload, chunk))
                .await
                .unwrap(),
        );
    }
    json!({"digest":content_digest(bytes),"bytes":bytes.len(),"chunks":chunks})
}
fn succeeded(record: OperationRecord) -> OperationRecord {
    assert_eq!(record.status, OperationStatus::Succeeded, "{record:?}");
    record
}

#[tokio::test]
async fn draft_listing_uses_public_scopes_and_never_publishes_or_recovers_content() {
    let fixture = Fixture::new();
    let host = NextHost::open_plugin_workspace(&fixture.db, &fixture.root)
        .await
        .unwrap();
    let context = NextHost::local_context();
    let args = json!({"window":"window-a","source":null,"after":null,"limit":1});
    let empty = json!({"drafts":[],"next":null});
    assert_eq!(
        query(&host, &context, "documents.list", args.clone())
            .await
            .unwrap(),
        empty
    );
    let content = stage(&host, &context, "capture", b"retained document").await;
    assert_eq!(
        query(&host, &context, "documents.list", args.clone())
            .await
            .unwrap(),
        empty
    );
    succeeded(
        host.invoke(
            &context,
            invoke(
                "save",
                "documents.save",
                fixture.save("capture", None, content.clone()),
            ),
        )
        .await
        .unwrap(),
    );
    let page = query(&host, &context, "documents.list", args.clone())
        .await
        .unwrap();
    assert_eq!(
        page["drafts"],
        json!([{"draft":"draft-a","source":{"revision":fixture.archive.revision.id,"contribution":"document"},"version":1,"digest":content["digest"],"bytes":content["bytes"],"metadata":{"name":"研究.R","encoding":"opaque-test"}}])
    );
    assert_eq!(page["next"], Value::Null);
    let mut weak = context.clone();
    weak.scopes.remove("documents.read");
    assert!(
        query(&host, &weak, "documents.list", args.clone())
            .await
            .is_err()
    );
    let mut foreign = context.clone();
    foreign.caller.id = "another-user".into();
    assert_eq!(
        query(&host, &foreign, "documents.list", args.clone())
            .await
            .unwrap(),
        empty
    );
    for field in ["principal", "project"] {
        let mut spoofed = args.clone();
        spoofed[field] = json!("local");
        assert!(
            query(&host, &context, "documents.list", spoofed)
                .await
                .is_err()
        );
    }
    let mut another = args.clone();
    another["window"] = json!("window-b");
    assert_eq!(
        query(&host, &context, "documents.list", another)
            .await
            .unwrap(),
        empty
    );
    for limit in [0, 21, 65536] {
        let mut invalid = args.clone();
        invalid["limit"] = json!(limit);
        assert!(
            query(&host, &context, "documents.list", invalid)
                .await
                .is_err()
        );
    }
    let journal = rusqlite::Connection::open(&fixture.db).unwrap();
    assert_eq!(
        journal
            .query_row("SELECT COUNT(*) FROM operations", [], |row| row
                .get::<_, u32>(0))
            .unwrap(),
        1
    );
    succeeded(
        host.invoke(
            &context,
            invoke("discard", "documents.discard", fixture.discard(1)),
        )
        .await
        .unwrap(),
    );
    assert_eq!(
        query(&host, &context, "documents.list", args)
            .await
            .unwrap(),
        empty
    );
    assert_eq!(
        query(
            &host,
            &context,
            "documents.inspect",
            json!({"window":"window-a","draft":"draft-a"})
        )
        .await
        .unwrap()["discarded"],
        true
    );
    host.drain().await;
}

#[tokio::test]
async fn draft_ports_keep_bytes_scoped_and_versioned_without_implicit_runtime_or_replay() {
    let fixture = Fixture::new();
    let host = NextHost::open_plugin_workspace(&fixture.db, &fixture.root)
        .await
        .unwrap();
    let context = NextHost::local_context();
    let address = json!({"window":"window-a","draft":"draft-a"});
    assert!(
        query(&host, &context, "documents.inspect", address.clone())
            .await
            .unwrap()
            .is_null()
    );
    let mut denied = context.clone();
    denied.scopes.remove("documents.read");
    assert!(
        query(&host, &denied, "documents.inspect", address.clone())
            .await
            .is_err()
    );
    let mut denied = context.clone();
    denied.scopes.remove("documents.write");
    assert!(
        control(
            &host,
            &denied,
            "documents.stage",
            stage_args("capture-a", b"private")
        )
        .await
        .is_err()
    );
    let bad = control(&host,&context,"documents.stage",json!({"window":"window-a","draft":"draft-a","upload":"capture-a","digest":content_digest(b"private"),"base64":"private-unencoded-secret"})).await.unwrap_err();
    assert!(!bad.to_string().contains("private-unencoded-secret"));
    let bytes = format!("\u{feff}{}", "研究 α🙂\r\n".repeat(100_000)).into_bytes();
    let content = stage(&host, &context, "capture-a", &bytes).await;
    assert!(
        query(&host, &context, "documents.inspect", address.clone())
            .await
            .unwrap()
            .is_null()
    );
    let journal = rusqlite::Connection::open(&fixture.db).unwrap();
    assert_eq!(
        journal
            .query_row("SELECT COUNT(*) FROM operations", [], |row| row
                .get::<_, u32>(0))
            .unwrap(),
        0,
        "queries and staging do not create operations"
    );
    let args = fixture.save("capture-a", None, content);
    assert!(
        host.invoke(&denied, invoke("denied", "documents.save", args.clone()))
            .await
            .is_err()
    );
    let original = succeeded(
        host.invoke(&context, invoke("first", "documents.save", args.clone()))
            .await
            .unwrap(),
    );
    assert_eq!(fixture.pin_count(), 0);
    let draft = original.output.clone().unwrap();
    assert_eq!(draft["version"], 1);
    assert_eq!(draft["content"]["digest"], json!(content_digest(&bytes)));
    let mut foreign = context.clone();
    foreign.caller.id = "foreign-user".into();
    assert!(
        query(&host, &foreign, "documents.inspect", address.clone())
            .await
            .unwrap()
            .is_null()
    );
    assert!(
        query(
            &host,
            &context,
            "documents.inspect",
            json!({"window":"window-b","draft":"draft-a"})
        )
        .await
        .unwrap()
        .is_null()
    );
    assert!(
        query(
            &host,
            &context,
            "documents.inspect",
            json!({"window":"window-a","draft":"draft-a","principal":"spoof"})
        )
        .await
        .is_err()
    );
    let mut output = vec![];
    let mut offset = 0;
    loop {
        let page=query(&host,&context,"documents.read",json!({"window":"window-a","draft":"draft-a","expected_version":1,"offset":offset,"limit":32769})).await.unwrap();
        assert_eq!(page["digest"], draft["content"]["digest"]);
        output.extend(STANDARD.decode(page["base64"].as_str().unwrap()).unwrap());
        let Some(next) = page["next"].as_u64() else {
            break;
        };
        offset = next;
    }
    assert_eq!(output, bytes);
    assert!(query(&host,&context,"documents.read",json!({"window":"window-a","draft":"draft-a","expected_version":1,"offset":0,"limit":65537})).await.is_err());
    let next = stage(&host, &context, "capture-b", b"later edit").await;
    let updated = succeeded(
        host.invoke(
            &context,
            invoke(
                "second",
                "documents.save",
                fixture.save("capture-b", Some(1), next),
            ),
        )
        .await
        .unwrap(),
    );
    assert_eq!(updated.output.unwrap()["version"], 2);
    let replay = host
        .invoke(&context, invoke("first", "documents.save", args.clone()))
        .await
        .unwrap();
    assert_eq!(
        replay.operation.operation_id,
        original.operation.operation_id
    );
    assert_eq!(replay.output, original.output);
    assert_eq!(
        query(&host, &context, "documents.inspect", address.clone())
            .await
            .unwrap()["version"],
        2
    );
    assert!(
        host.invoke(
            &context,
            invoke("new-stale-request", "documents.save", args.clone())
        )
        .await
        .is_err()
    );
    assert!(
        query(
            &host,
            &context,
            "documents.read",
            json!({"window":"window-a","draft":"draft-a","expected_version":1,"offset":0,"limit":5})
        )
        .await
        .is_err()
    );
    assert!(
        PluginRepository::open(&repository_path(&fixture.db))
            .unwrap()
            .remove(&fixture.archive.revision.id)
            .is_err()
    );
    host.drain().await;
    drop(host);
    let host = NextHost::open_plugin_workspace(&fixture.db, &fixture.root)
        .await
        .unwrap();
    assert_eq!(
        query(&host, &context, "documents.inspect", address.clone())
            .await
            .unwrap()["version"],
        2
    );
    // Same store, different normalized project: draft reads stay hidden.
    let other_root = fixture.temp.path().join("other-project");
    fs::create_dir(&other_root).unwrap();
    let other_host =
        NextHost::open_plugin_workspace(&fixture.temp.path().join("other.sqlite"), &other_root)
            .await
            .unwrap();
    assert!(
        query(&other_host, &context, "documents.inspect", address.clone())
            .await
            .unwrap()
            .is_null()
    );
    other_host.drain().await;
    drop(other_host);
    assert!(
        host.invoke(
            &context,
            invoke("stale-discard", "documents.discard", fixture.discard(1))
        )
        .await
        .is_err()
    );
    let discarded = succeeded(
        host.invoke(
            &context,
            invoke("discard", "documents.discard", fixture.discard(2)),
        )
        .await
        .unwrap(),
    );
    assert_eq!(discarded.output.as_ref().unwrap()["discarded"], true);
    assert_eq!(discarded.output.as_ref().unwrap()["version"], 3);
    assert_eq!(
        fixture
            .catalog()
            .query_row("SELECT COUNT(*) FROM draft_chunks", [], |row| row
                .get::<_, u32>(0))
            .unwrap(),
        0
    );
    PluginRepository::open(&repository_path(&fixture.db))
        .unwrap()
        .remove(&fixture.archive.revision.id)
        .unwrap();
    let replay = host
        .invoke(&context, invoke("first", "documents.save", args))
        .await
        .unwrap();
    assert_eq!(
        replay.output, original.output,
        "historical result survives removal, without executing another save"
    );
    assert_eq!(
        query(&host, &context, "documents.inspect", address)
            .await
            .unwrap()["discarded"],
        true
    );
    host.drain().await;
}

#[tokio::test]
async fn original_commit_recovery_preserves_captured_bytes_across_successor_edits_and_host_restart()
{
    let fixture = Fixture::new();
    let context = NextHost::local_context();
    let host = NextHost::open_plugin_workspace(&fixture.db, &fixture.root)
        .await
        .unwrap();
    let journal = rusqlite::Connection::open(&fixture.db).unwrap();
    journal.execute_batch("CREATE TRIGGER reject_draft_commit BEFORE UPDATE OF status ON operations WHEN NEW.status='succeeded' AND NEW.client_request_id='original' BEGIN SELECT RAISE(ABORT,'lost original journal commit'); END;").unwrap();
    let captured = stage(&host, &context, "capture-a", b"original captured bytes").await;
    let args = fixture.save("capture-a", None, captured.clone());
    let pending = host
        .invoke(&context, invoke("original", "documents.save", args.clone()))
        .await
        .unwrap_err();
    let OperationError::CommitPending { operation_id, .. } = pending else {
        panic!("{pending}")
    };
    assert_eq!(fixture.pin_count(), 1);
    let status = query(
        &host,
        &context,
        "operation.commit_status",
        json!({"operation_id":operation_id}),
    )
    .await
    .unwrap();
    assert_eq!(status["phase"], "durable");
    let reference: OperationCommitReference =
        serde_json::from_value(status["reference"].clone()).unwrap();
    let successor = stage(&host, &context, "capture-b", b"successor edit").await;
    succeeded(
        host.invoke(
            &context,
            invoke(
                "successor",
                "documents.save",
                fixture.save("capture-b", Some(1), successor),
            ),
        )
        .await
        .unwrap(),
    );
    assert_eq!(fixture.pin_count(), 1);
    assert_eq!(
        fixture
            .catalog()
            .query_row("SELECT COUNT(*) FROM draft_chunks", [], |row| row
                .get::<_, u32>(0))
            .unwrap(),
        2,
        "accepted original bytes survive successor content"
    );
    let rejected = host
        .invoke(
            &context,
            invoke("discard-pending", "documents.discard", fixture.discard(2)),
        )
        .await
        .unwrap();
    assert_eq!(rejected.status, OperationStatus::Failed);
    assert_eq!(fixture.pin_count(), 1);
    let replay = host
        .invoke(&context, invoke("original", "documents.save", args.clone()))
        .await
        .unwrap();
    assert_eq!(replay.operation.operation_id, operation_id);
    assert_eq!(replay.status, OperationStatus::Running);
    for (id, denied) in [
        ("foreign", {
            let mut c = context.clone();
            c.caller.id = "other".into();
            c
        }),
        ("no-write", {
            let mut c = context.clone();
            c.scopes.remove("documents.write");
            c
        }),
    ] {
        assert!(
            host.reconcile_commit(
                &denied,
                &ReconcileOperationCommit {
                    reference: reference.clone()
                }
            )
            .await
            .is_err(),
            "{id}"
        );
        let result = host
            .invoke(
                &denied,
                invoke(
                    id,
                    "plugins.reconcile_references",
                    json!({"operation_id":operation_id}),
                ),
            )
            .await
            .unwrap();
        assert_ne!(result.status, OperationStatus::Succeeded);
        assert_eq!(fixture.pin_count(), 1);
    }
    journal
        .execute_batch("DROP TRIGGER reject_draft_commit;")
        .unwrap();
    host.drain().await;
    drop(host);
    let host = NextHost::open_plugin_workspace(&fixture.db, &fixture.root)
        .await
        .unwrap();
    assert_eq!(
        fixture.pin_count(),
        1,
        "opening does not silently release or replay captured work"
    );
    assert_eq!(
        query(
            &host,
            &context,
            "documents.inspect",
            json!({"window":"window-a","draft":"draft-a"})
        )
        .await
        .unwrap()["version"],
        2
    );
    let recovered = succeeded(
        host.reconcile_commit(&context, &ReconcileOperationCommit { reference })
            .await
            .unwrap(),
    );
    assert_eq!(recovered.operation.operation_id, operation_id);
    assert_eq!(recovered.output.as_ref().unwrap()["content"], captured);
    assert_eq!(recovered.output.as_ref().unwrap()["version"], 1);
    assert_eq!(fixture.pin_count(), 0);
    assert_eq!(
        fixture
            .catalog()
            .query_row("SELECT COUNT(*) FROM draft_chunks", [], |row| row
                .get::<_, u32>(0))
            .unwrap(),
        1
    );
    let replay = host
        .invoke(&context, invoke("original", "documents.save", args))
        .await
        .unwrap();
    assert_eq!(replay.output, recovered.output);
    assert_eq!(
        query(
            &host,
            &context,
            "documents.inspect",
            json!({"window":"window-a","draft":"draft-a"})
        )
        .await
        .unwrap()["version"],
        2
    );
    succeeded(
        host.invoke(
            &context,
            invoke("discard-settled", "documents.discard", fixture.discard(2)),
        )
        .await
        .unwrap(),
    );
    host.drain().await;
}

#[tokio::test]
async fn uncertain_original_and_failed_cleanup_retain_capture_until_real_settlement() {
    let fixture = Fixture::new();
    let context = NextHost::local_context();
    let host = NextHost::open_plugin_workspace(&fixture.db, &fixture.root)
        .await
        .unwrap();
    let catalog = fixture.catalog();
    catalog.execute_batch("CREATE TRIGGER reject_unpin BEFORE DELETE ON draft_upload_operations BEGIN SELECT RAISE(ABORT,'lost cleanup'); END;").unwrap();
    let content = stage(&host, &context, "capture-a", b"settled but pinned").await;
    let original = succeeded(
        host.invoke(
            &context,
            invoke(
                "settled",
                "documents.save",
                fixture.save("capture-a", None, content),
            ),
        )
        .await
        .unwrap(),
    );
    assert_eq!(fixture.pin_count(), 1);
    catalog.execute_batch("DROP TRIGGER reject_unpin;").unwrap();
    succeeded(
        host.invoke(
            &context,
            invoke(
                "unpin",
                "plugins.reconcile_references",
                json!({"operation_id":original.operation.operation_id}),
            ),
        )
        .await
        .unwrap(),
    );
    assert_eq!(fixture.pin_count(), 0);
    let journal = rusqlite::Connection::open(&fixture.db).unwrap();
    journal.execute_batch("CREATE TRIGGER reject_staging BEFORE INSERT ON operation_commit_candidates WHEN (SELECT client_request_id FROM operations WHERE operation_id=NEW.operation_id)='uncertain' BEGIN SELECT RAISE(ABORT,'lost result staging'); END;").unwrap();
    let next = stage(&host, &context, "capture-b", b"uncertain original capture").await;
    let pending = host
        .invoke(
            &context,
            invoke(
                "uncertain",
                "documents.save",
                fixture.save("capture-b", Some(1), next),
            ),
        )
        .await
        .unwrap_err();
    let OperationError::CommitPending { operation_id, .. } = pending else {
        panic!("{pending}")
    };
    assert_eq!(
        query(
            &host,
            &context,
            "operation.commit_status",
            json!({"operation_id":operation_id})
        )
        .await
        .unwrap()["phase"],
        "volatile"
    );
    assert_eq!(fixture.pin_count(), 1);
    host.drain().await;
    drop(host);
    journal
        .execute_batch("DROP TRIGGER reject_staging;")
        .unwrap();
    let host = NextHost::open_plugin_workspace(&fixture.db, &fixture.root)
        .await
        .unwrap();
    let original = host
        .get_operation(&context, &operation_id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(original.status, OperationStatus::Uncertain);
    let attempt = host
        .invoke(
            &context,
            invoke(
                "do-not-unpin",
                "plugins.reconcile_references",
                json!({"operation_id":operation_id}),
            ),
        )
        .await
        .unwrap();
    assert_ne!(attempt.status, OperationStatus::Succeeded);
    assert_eq!(
        fixture.pin_count(),
        1,
        "uncertain terminal status is not native settlement"
    );
    assert_eq!(
        query(
            &host,
            &context,
            "documents.inspect",
            json!({"window":"window-a","draft":"draft-a"})
        )
        .await
        .unwrap()["version"],
        2
    );
    let rejected = host
        .invoke(
            &context,
            invoke("do-not-discard", "documents.discard", fixture.discard(2)),
        )
        .await
        .unwrap();
    assert_eq!(rejected.status, OperationStatus::Failed);
    host.drain().await;
}

#[tokio::test]
async fn declared_view_draft_calls_use_exact_parent_scope_and_original_window() {
    let fixture = Fixture::new();
    let context = NextHost::local_context();
    let host = NextHost::open_plugin_workspace(&fixture.db, &fixture.root)
        .await
        .unwrap();
    let activated=succeeded(host.invoke(&context,invoke("activate","plugins.activate",json!({"revision":fixture.archive.revision.id,"artifact":fixture.archive.artifacts[0].id,"target":"ui-web","alias":"view","configuration":{}}))).await.unwrap());
    let instance = activated.output.unwrap()["instance"]["identity"].clone();
    let opened=succeeded(host.invoke(&context,invoke("open","views.open",json!({"instance":instance,"contribution":"document","window":"window-a","configuration":{},"state":{}}))).await.unwrap());
    let view = opened.output.unwrap()["view"].clone();
    let connection: PluginViewConnection = serde_json::from_value(
        query(&host, &context, "views.connection", json!({"view":view}))
            .await
            .unwrap(),
    )
    .unwrap();
    let message = |seq, kind: &str, cap: &str, args: Value| -> PluginViewMessage {
        let mut body = json!({"type":kind,"capability":{"id":cap,"version":1},"arguments":args});
        if kind == "invoke" {
            body["request_id"] = json!(format!("draft-{seq}"));
            body["preconditions"] = json!([]);
        }
        serde_json::from_value(json!({"protocol_version":1,"connection":connection.connection,"view":view,"sequence":seq,"request":format!("message-{seq}"),"body":body})).unwrap()
    };
    let denied = host
        .dispatch_plugin_view(
            &context,
            "window-a",
            &connection.call_token,
            message(
                1,
                "query",
                "documents.inspect",
                json!({"window":"window-b","draft":"draft-a"}),
            ),
        )
        .await;
    assert!(denied.is_err());
    let mut wrong_window = stage_args("capture-view", b"view draft");
    wrong_window["window"] = json!("window-b");
    assert!(
        host.dispatch_plugin_view(
            &context,
            "window-a",
            &connection.call_token,
            message(2, "control", "documents.stage", wrong_window)
        )
        .await
        .is_err()
    );
    let mut weak = context.clone();
    weak.scopes.remove("documents.write");
    assert!(
        host.dispatch_plugin_view(
            &weak,
            "window-a",
            &connection.call_token,
            message(
                3,
                "control",
                "documents.stage",
                stage_args("capture-view", b"view draft")
            )
        )
        .await
        .is_err()
    );
    let chunk = host
        .dispatch_plugin_view(
            &context,
            "window-a",
            &connection.call_token,
            message(
                4,
                "control",
                "documents.stage",
                stage_args("capture-view", b"view draft"),
            ),
        )
        .await
        .unwrap();
    let args = fixture.save(
        "capture-view",
        None,
        json!({"digest":content_digest(b"view draft"),"bytes":10,"chunks":[chunk]}),
    );
    let mut other = args.clone();
    other["window"] = json!("window-b");
    assert!(
        host.dispatch_plugin_view(
            &context,
            "window-a",
            &connection.call_token,
            message(5, "invoke", "documents.save", other)
        )
        .await
        .is_err()
    );
    let result = host
        .dispatch_plugin_view(
            &context,
            "window-a",
            &connection.call_token,
            message(6, "invoke", "documents.save", args),
        )
        .await
        .unwrap();
    let accepted: OperationRecord = serde_json::from_value(result).unwrap();
    let original = succeeded(
        tokio::time::timeout(std::time::Duration::from_secs(10), async {
            loop {
                let record = host
                    .get_operation(&context, &accepted.operation.operation_id)
                    .await
                    .unwrap()
                    .unwrap();
                if record.status.is_terminal() {
                    break record;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap(),
    );
    assert_eq!(original.operation.caller.id, view.as_str().unwrap());
    assert_eq!(original.operation.principal(), context.principal());
    assert_eq!(
        query(
            &host,
            &context,
            "documents.inspect",
            json!({"window":"window-a","draft":"draft-a"})
        )
        .await
        .unwrap(),
        original.output.unwrap()
    );
    let list_args = json!({"window":"window-a","source":null,"after":null,"limit":20});
    let listed = host
        .dispatch_plugin_view(
            &context,
            "window-a",
            &connection.call_token,
            message(7, "query", "documents.list", list_args.clone()),
        )
        .await
        .unwrap();
    assert_eq!(listed["data"]["drafts"][0]["draft"], "draft-a");
    let mut another = list_args.clone();
    another["window"] = json!("window-b");
    assert!(
        host.dispatch_plugin_view(
            &context,
            "window-a",
            &connection.call_token,
            message(8, "query", "documents.list", another)
        )
        .await
        .is_err()
    );
    let mut weak = context.clone();
    weak.scopes.remove("documents.read");
    assert!(
        host.dispatch_plugin_view(
            &weak,
            "window-a",
            &connection.call_token,
            message(9, "query", "documents.list", list_args)
        )
        .await
        .is_err()
    );
    host.drain().await;
}

struct DraftChannel {
    connection: PluginViewConnection,
    sequence: u32,
}
async fn renderer_fixture(fixture: &Fixture, context: &CallContext) -> (NextHost, DraftChannel) {
    let host = NextHost::open_plugin_workspace(&fixture.db, &fixture.root)
        .await
        .unwrap();
    let instance = succeeded(host.invoke(context, invoke("activate", "plugins.activate", json!({
        "revision":fixture.archive.revision.id,"artifact":fixture.archive.artifacts[0].id,
        "target":"ui-web","alias":"document","configuration":{}
    }))).await.unwrap()).output.unwrap()["instance"]["identity"].clone();
    let view = succeeded(host.invoke(context, invoke("open", "views.open", json!({
        "instance":instance,"contribution":"document","window":"window-a","configuration":{},"state":{"text":"retained 中文"}
    }))).await.unwrap()).output.unwrap()["view"].clone();
    let connection = serde_json::from_value(
        query(&host, context, "views.connection", json!({"view":view}))
            .await
            .unwrap(),
    )
    .unwrap();
    (
        host,
        DraftChannel {
            connection,
            sequence: 0,
        },
    )
}
fn renderer_release(channel: &DraftChannel, renderer: &str) -> Value {
    json!({"view":channel.connection.view.view,"connection":channel.connection.connection,
        "window":channel.connection.view.window,"call_token":channel.connection.call_token,"renderer":renderer})
}
async fn renderer_close(
    host: &NextHost,
    context: &CallContext,
    channel: &mut DraftChannel,
    id: &str,
) -> OperationRecord {
    let close: OperationRecord = serde_json::from_value(
        host.dispatch(
            context,
            HostRequest::Invoke(InvokeRequest {
                invocation: invoke(
                    id,
                    "views.close",
                    json!({"view":channel.connection.view.view}),
                ),
                return_after_acceptance: Some(true),
            }),
        )
        .await
        .unwrap(),
    )
    .unwrap();
    tokio::time::timeout(std::time::Duration::from_secs(5), async {
        loop {
            let state = channel
                .send(
                    host,
                    context,
                    json!({"type":"observe_lifecycle","renderer":"current"}),
                )
                .await
                .unwrap();
            if state["close"]["phase"] == "requested" {
                break;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    close
}
async fn renderer_settled(
    host: &NextHost,
    context: &CallContext,
    operation: &OperationId,
) -> OperationRecord {
    tokio::time::timeout(std::time::Duration::from_secs(5), async {
        loop {
            let record = host
                .get_operation(context, operation)
                .await
                .unwrap()
                .unwrap();
            if record.status.is_terminal() {
                break record;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap()
}

#[tokio::test(flavor = "current_thread")]
async fn renderer_release_is_scoped_idempotent_and_does_not_attest_to_state() {
    let fixture = Fixture::new();
    let context = NextHost::local_context();
    let (host, mut channel) = renderer_fixture(&fixture, &context).await;
    for renderer in ["ended", "current"] {
        channel
            .send(
                &host,
                &context,
                json!({"type":"register_close_handler","renderer":renderer}),
            )
            .await
            .unwrap();
    }
    let args = renderer_release(&channel, "ended");
    for field in ["view", "connection", "window", "call_token"] {
        let mut forged = args.clone();
        forged[field] = json!("wrong");
        assert!(
            control(&host, &context, "views.release_renderer", forged)
                .await
                .is_err(),
            "{field}"
        );
    }
    let mut weak = context.clone();
    weak.scopes.remove("plugins.run");
    assert!(
        control(&host, &weak, "views.release_renderer", args.clone())
            .await
            .is_err()
    );
    let mut other = context.clone();
    other.caller.id = "another-user".into();
    assert!(
        control(&host, &other, "views.release_renderer", args.clone())
            .await
            .is_err()
    );
    let mut plugin = context.clone();
    plugin.caller.kind = CallerKind::Plugin;
    assert!(
        control(&host, &plugin, "views.release_renderer", args.clone())
            .await
            .is_err()
    );
    let mut window = context.clone();
    window.view_scope = Some(ViewCallScope {
        window: rho_plugin_protocol::WindowId::new("another").unwrap(),
        origin: None,
        draft_source: None,
    });
    assert!(
        control(&host, &window, "views.release_renderer", args.clone())
            .await
            .is_err()
    );
    let foreign_fixture = Fixture::new();
    let (foreign, _) = renderer_fixture(&foreign_fixture, &context).await;
    assert!(
        control(&foreign, &context, "views.release_renderer", args.clone())
            .await
            .is_err()
    );
    foreign.drain().await;
    let before = query(
        &host,
        &context,
        "views.connection",
        json!({"view":channel.connection.view.view}),
    )
    .await
    .unwrap();
    assert_eq!(
        control(&host, &context, "views.release_renderer", args.clone())
            .await
            .unwrap()["released"],
        true
    );
    assert_eq!(
        control(&host, &context, "views.release_renderer", args)
            .await
            .unwrap()["released"],
        false
    );
    assert_eq!(
        query(
            &host,
            &context,
            "views.connection",
            json!({"view":channel.connection.view.view})
        )
        .await
        .unwrap(),
        before
    );
    assert!(
        channel
            .send(
                &host,
                &context,
                json!({"type":"observe_lifecycle","renderer":"ended"})
            )
            .await
            .is_err()
    );
    let close = renderer_close(&host, &context, &mut channel, "normal-close").await;
    channel.send(&host, &context, json!({"type":"prepare_close","renderer":"current","operation":close.operation.operation_id,"state_version":0})).await.unwrap();
    let closed = succeeded(renderer_settled(&host, &context, &close.operation.operation_id).await);
    assert_eq!(
        closed.output.unwrap()["state"],
        json!({"text":"retained 中文"})
    );
    host.drain().await;
}

#[tokio::test(flavor = "current_thread")]
async fn renderer_release_during_close_refuses_prepared_and_unprepared_documents() {
    for prepared in [false, true] {
        let fixture = Fixture::new();
        let context = NextHost::local_context();
        let (host, mut channel) = renderer_fixture(&fixture, &context).await;
        for renderer in ["ending", "current"] {
            channel
                .send(
                    &host,
                    &context,
                    json!({"type":"register_close_handler","renderer":renderer}),
                )
                .await
                .unwrap();
        }
        let close = renderer_close(&host, &context, &mut channel, "interrupted-close").await;
        channel.send(&host, &context, json!({"type":"prepare_close","renderer":if prepared {"ending"} else {"current"},"operation":close.operation.operation_id,"state_version":0})).await.unwrap();
        control(
            &host,
            &context,
            "views.release_renderer",
            renderer_release(&channel, "ending"),
        )
        .await
        .unwrap();
        let refused = renderer_settled(&host, &context, &close.operation.operation_id).await;
        assert_eq!(refused.status, OperationStatus::Failed, "{refused:?}");
        assert!(format!("{:?}", refused.error).contains("document ended"));
        let retained = query(
            &host,
            &context,
            "views.inspect",
            json!({"view":channel.connection.view.view}),
        )
        .await
        .unwrap();
        assert_eq!(retained["closed"], false);
        assert_eq!(retained["state_version"], 0);
        let retry = renderer_close(&host, &context, &mut channel, "explicit-retry").await;
        channel.send(&host, &context, json!({"type":"prepare_close","renderer":"current","operation":retry.operation.operation_id,"state_version":0})).await.unwrap();
        succeeded(renderer_settled(&host, &context, &retry.operation.operation_id).await);
        host.drain().await;
    }
}

#[tokio::test]
async fn renderer_release_of_last_document_requires_explicit_saved_state_recovery() {
    let fixture = Fixture::new();
    let context = NextHost::local_context();
    let (host, mut channel) = renderer_fixture(&fixture, &context).await;
    channel
        .send(
            &host,
            &context,
            json!({"type":"register_close_handler","renderer":"ended"}),
        )
        .await
        .unwrap();
    control(
        &host,
        &context,
        "views.release_renderer",
        renderer_release(&channel, "ended"),
    )
    .await
    .unwrap();
    let view = channel.connection.view.view;
    let close = host
        .invoke(
            &context,
            invoke("ordinary-close", "views.close", json!({"view":view})),
        )
        .await;
    assert!(
        close
            .unwrap_err()
            .to_string()
            .contains("no view close handler")
    );
    let retained = query(&host, &context, "views.inspect", json!({"view":view}))
        .await
        .unwrap();
    assert_eq!(retained["closed"], false);
    assert_eq!(retained["state_version"], 0);
    let recovery = succeeded(
        host.invoke(
            &context,
            invoke(
                "explicit-recovery",
                "views.close",
                json!({"view":view,"mode":{"kind":"retain_acknowledged","expected_version":0}}),
            ),
        )
        .await
        .unwrap(),
    );
    assert_eq!(recovery.output.unwrap()["state"], retained["state"]);
    host.drain().await;
}
impl DraftChannel {
    async fn send(
        &mut self,
        host: &NextHost,
        context: &CallContext,
        body: Value,
    ) -> Result<Value, OperationError> {
        self.sequence += 1;
        let message = serde_json::from_value(json!({"protocol_version":1,"connection":self.connection.connection,
            "view":self.connection.view.view,"sequence":self.sequence,"request":format!("flush-{}",self.sequence),"body":body})).unwrap();
        host.dispatch_plugin_view(
            context,
            self.connection.view.window.as_str(),
            &self.connection.call_token,
            message,
        )
        .await
    }
    async fn operation(
        &mut self,
        host: &NextHost,
        context: &CallContext,
        operation: &OperationId,
    ) -> OperationRecord {
        tokio::time::timeout(std::time::Duration::from_secs(5), async {
            loop {
                let record: OperationRecord = serde_json::from_value(
                    self.send(
                        host,
                        context,
                        json!({"type":"get_operation","operation_id":operation}),
                    )
                    .await
                    .unwrap(),
                )
                .unwrap();
                if record.status.is_terminal() {
                    break record;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap()
    }
}

#[tokio::test(flavor = "current_thread")]
async fn close_flush_uses_only_declared_own_draft_ports_while_draining_and_fences_sealed_state() {
    let fixture = Fixture::new();
    let context = NextHost::local_context();
    let foreign_path = fixture.temp.path().join("another-encoding");
    package(&foreign_path);
    fs::write(
        foreign_path.join("index.html"),
        "<!doctype html><p>Another exact encoding revision</p>",
    )
    .unwrap();
    fs::copy(
        foreign_path.join("index.html"),
        foreign_path.join("dist/index.html"),
    )
    .unwrap();
    let foreign = snapshot_directory(&foreign_path, None, "ui-web").unwrap();
    PluginRepository::open(&repository_path(&fixture.db))
        .unwrap()
        .import(&foreign)
        .unwrap();
    let host = NextHost::open_plugin_workspace(&fixture.db, &fixture.root)
        .await
        .unwrap();
    let empty = json!({"digest":content_digest(b""),"bytes":0,"chunks":[]});
    succeeded(
        host.invoke(
            &context,
            invoke(
                "acknowledged",
                "documents.save",
                fixture.save("acknowledged", None, empty.clone()),
            ),
        )
        .await
        .unwrap(),
    );
    let mut foreign_args = fixture.save("foreign", None, empty);
    foreign_args["draft"] = json!("foreign-draft");
    foreign_args["source"]["revision"] = json!(foreign.revision.id);
    succeeded(
        host.invoke(
            &context,
            invoke("foreign", "documents.save", foreign_args.clone()),
        )
        .await
        .unwrap(),
    );
    let instance=succeeded(host.invoke(&context,invoke("activate","plugins.activate",json!({"revision":fixture.archive.revision.id,"artifact":fixture.archive.artifacts[0].id,"target":"ui-web","alias":"document","configuration":{}}))).await.unwrap()).output.unwrap()["instance"]["identity"].clone();
    let view=succeeded(host.invoke(&context,invoke("open","views.open",json!({"instance":instance,"contribution":"document","window":"window-a","configuration":{},"state":{}}))).await.unwrap()).output.unwrap()["view"].clone();
    let connection = serde_json::from_value(
        query(&host, &context, "views.connection", json!({"view":view}))
            .await
            .unwrap(),
    )
    .unwrap();
    let mut channel = DraftChannel {
        connection,
        sequence: 0,
    };
    let observed=channel.send(&host,&context,json!({"type":"query","capability":{"id":"documents.inspect","version":1},"arguments":{"window":"window-a","draft":"foreign-draft"}})).await.unwrap();
    assert_eq!(
        observed["data"]["source"]["revision"],
        json!(foreign.revision.id),
        "normal active declared authority can inspect another encoding"
    );
    let listing = json!({"type":"query","capability":{"id":"documents.list","version":1},"arguments":{"window":"window-a","source":null,"after":null,"limit":20}});
    assert_eq!(
        channel
            .send(&host, &context, listing.clone())
            .await
            .unwrap()["data"]["drafts"]
            .as_array()
            .unwrap()
            .len(),
        2
    );
    channel
        .send(
            &host,
            &context,
            json!({"type":"register_close_handler","renderer":"first"}),
        )
        .await
        .unwrap();
    let first_close: OperationRecord = serde_json::from_value(
        host.dispatch(
            &context,
            HostRequest::Invoke(InvokeRequest {
                invocation: invoke("close-for-listing", "views.close", json!({"view":view})),
                return_after_acceptance: Some(true),
            }),
        )
        .await
        .unwrap(),
    )
    .unwrap();
    tokio::time::timeout(std::time::Duration::from_secs(5), async {
        loop {
            let lifecycle = channel
                .send(
                    &host,
                    &context,
                    json!({"type":"observe_lifecycle","renderer":"first"}),
                )
                .await
                .unwrap();
            if lifecycle["close"]["phase"] == "requested" {
                break;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    let own = channel
        .send(&host, &context, listing.clone())
        .await
        .unwrap();
    assert_eq!(
        own["data"]["drafts"].as_array().unwrap().len(),
        1,
        "closing views cannot enumerate another encoding"
    );
    assert_eq!(own["data"]["drafts"][0]["draft"], "draft-a");
    let mut foreign_listing = listing;
    foreign_listing["arguments"]["source"] = foreign_args["source"].clone();
    assert!(
        channel
            .send(&host, &context, foreign_listing)
            .await
            .is_err()
    );
    channel.send(&host, &context, json!({"type":"refuse_close","renderer":"first","operation":first_close.operation.operation_id,"reason":"Keep this fixture open for the draining check"})).await.unwrap();
    let refused = tokio::time::timeout(std::time::Duration::from_secs(5), async {
        loop {
            let record = host
                .get_operation(&context, &first_close.operation.operation_id)
                .await
                .unwrap()
                .unwrap();
            if record.status.is_terminal() {
                break record;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    assert_eq!(refused.status, OperationStatus::Failed);
    let release = host
        .invoke(
            &context,
            invoke("release", "plugins.release", json!({"instance":instance})),
        )
        .await
        .unwrap();
    assert_ne!(
        release.status,
        OperationStatus::Succeeded,
        "open views prevent completed release"
    );
    assert_eq!(
        query(
            &host,
            &context,
            "plugins.instance",
            json!({"instance":instance})
        )
        .await
        .unwrap()["instance"]["state"],
        "draining"
    );
    assert!(channel.send(&host,&context,json!({"type":"query","capability":{"id":"documents.inspect","version":1},"arguments":{"window":"window-a","draft":"foreign-draft"}})).await.is_err(),"draining-view persistence is limited to its original encoding");
    assert!(channel.send(&host,&context,json!({"type":"query","capability":{"id":"documents.list","version":1},"arguments":{"window":"window-a","source":null,"after":null,"limit":20}})).await.is_err(),"draft listing cannot extend inactive-instance persistence grants");
    assert!(channel.send(&host,&context,json!({"type":"invoke","capability":{"id":"documents.discard","version":1},"arguments":fixture.discard(1),"request_id":"no-discard","preconditions":[]})).await.is_err(),"release does not reopen general action authority");
    for renderer in ["first", "second"] {
        channel
            .send(
                &host,
                &context,
                json!({"type":"register_close_handler","renderer":renderer}),
            )
            .await
            .unwrap();
    }
    let close: OperationRecord = serde_json::from_value(
        host.dispatch(
            &context,
            HostRequest::Invoke(InvokeRequest {
                invocation: invoke("close", "views.close", json!({"view":view})),
                return_after_acceptance: Some(true),
            }),
        )
        .await
        .unwrap(),
    )
    .unwrap();
    let requested = tokio::time::timeout(std::time::Duration::from_secs(5), async {
        loop {
            let state = channel
                .send(
                    &host,
                    &context,
                    json!({"type":"observe_lifecycle","renderer":"first"}),
                )
                .await
                .unwrap();
            if state["close"]["phase"] == "requested" {
                break state;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    assert_eq!(
        requested["close"]["operation"],
        json!(close.operation.operation_id)
    );
    let stage_message = |args: Value| json!({"type":"control","capability":{"id":"documents.stage","version":1},"arguments":args});
    let mut weak = context.clone();
    weak.scopes.remove("documents.write");
    assert!(
        channel
            .send(
                &host,
                &weak,
                stage_message(stage_args("flush", b"captured"))
            )
            .await
            .is_err(),
        "a flush cannot expand its parent's authority"
    );
    let mut bad_stage = stage_args("flush", b"captured");
    bad_stage["draft"] = json!("foreign-draft");
    assert!(
        channel
            .send(&host, &context, stage_message(bad_stage))
            .await
            .is_err()
    );
    foreign_args["draft"] = json!("another-draft");
    assert!(channel.send(&host,&context,json!({"type":"invoke","capability":{"id":"documents.save","version":1},"arguments":foreign_args,"request_id":"foreign-save","preconditions":[]})).await.is_err());
    let bytes = "关闭前的草稿 α🙂\r\n".repeat(20_000).into_bytes();
    assert!(bytes.len() > 256 * 1024);
    let mut chunks = vec![];
    for part in bytes.chunks(65536) {
        chunks.push(
            channel
                .send(&host, &context, stage_message(stage_args("flush", part)))
                .await
                .unwrap(),
        );
    }
    let args = fixture.save(
        "flush",
        Some(1),
        json!({"digest":content_digest(&bytes),"bytes":bytes.len(),"chunks":chunks}),
    );
    let saved:OperationRecord=serde_json::from_value(channel.send(&host,&context,json!({"type":"invoke","capability":{"id":"documents.save","version":1},"arguments":args,"request_id":"original-flush","preconditions":[]})).await.unwrap()).unwrap();
    let saved = succeeded(
        channel
            .operation(&host, &context, &saved.operation.operation_id)
            .await,
    );
    assert_eq!(saved.output.as_ref().unwrap()["version"], 2);
    let acknowledged=channel.send(&host,&context,json!({"type":"set_state","expected_version":0,"state":{"draft":"draft-a","version":2}})).await.unwrap();
    assert_eq!(acknowledged["status"], "succeeded");
    channel.send(&host,&context,json!({"type":"prepare_close","renderer":"first","operation":close.operation.operation_id,"state_version":1})).await.unwrap();
    assert!(
        !host
            .get_operation(&context, &close.operation.operation_id)
            .await
            .unwrap()
            .unwrap()
            .status
            .is_terminal(),
        "one document cannot attest for another renderer"
    );
    let current=channel.send(&host,&context,json!({"type":"query","capability":{"id":"documents.inspect","version":1},"arguments":{"window":"window-a","draft":"draft-a"}})).await.unwrap();
    assert_eq!(current["data"], saved.output.unwrap());
    channel.send(&host,&context,json!({"type":"prepare_close","renderer":"second","operation":close.operation.operation_id,"state_version":1})).await.unwrap();
    // This current-thread test has not yielded to native closure since sealing.
    // Even a correctly granted self-persistence write must now be refused.
    let sealed = channel
        .send(
            &host,
            &context,
            stage_message(stage_args("after-seal", b"late")),
        )
        .await
        .unwrap_err();
    assert!(sealed.to_string().contains("sealed"), "{sealed}");
    let closed = tokio::time::timeout(std::time::Duration::from_secs(5), async {
        loop {
            let record = host
                .get_operation(&context, &close.operation.operation_id)
                .await
                .unwrap()
                .unwrap();
            if record.status.is_terminal() {
                break succeeded(record);
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    assert_eq!(
        closed.output.as_ref().unwrap()["state"],
        json!({"draft":"draft-a","version":2})
    );
    assert!(
        channel
            .send(
                &host,
                &context,
                stage_message(stage_args("closed", b"late"))
            )
            .await
            .is_err()
    );
    assert_eq!(
        query(
            &host,
            &context,
            "documents.inspect",
            json!({"window":"window-a","draft":"draft-a"})
        )
        .await
        .unwrap()["content"]["digest"],
        json!(content_digest(&bytes))
    );
    assert_eq!(fixture.pin_count(), 0);
    succeeded(
        host.invoke(
            &context,
            invoke(
                "finish-release",
                "plugins.release",
                json!({"instance":instance}),
            ),
        )
        .await
        .unwrap(),
    );
    assert_eq!(
        host.get_operation(&context, &release.operation.operation_id)
            .await
            .unwrap()
            .unwrap()
            .status,
        release.status,
        "finishing after confirmed view closure does not rewrite the original refused release"
    );
    host.drain().await;
}
