use base64::{Engine, engine::general_purpose::STANDARD};
use rho_contract::*;
use rho_host::{NextHost, OperationError};
use rho_plugin_protocol::{
    ARCHIVE_CHUNK_BYTES, PluginArchive, PluginArchiveReference, PluginViewConnection,
};
use rho_plugins::{PluginRepository, content_digest, repository_path, snapshot_directory};
use serde_json::{Value, json};
use std::{fs, path::PathBuf};

struct Fixture {
    _temp: tempfile::TempDir,
    root: PathBuf,
    db: PathBuf,
    archive: PluginArchive,
    bytes: Vec<u8>,
}
impl Fixture {
    fn new() -> Self {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("project");
        fs::create_dir(&root).unwrap();
        let source = temp.path().join("package");
        fs::create_dir_all(source.join("dist")).unwrap();
        fs::write(
            source.join("index.html"),
            "<p>Independent package 科学</p>".repeat(4000),
        )
        .unwrap();
        fs::write(source.join("dist/index.html"), "<p>Independent package</p>").unwrap();
        fs::write(source.join("deps.lock"), "none").unwrap();
        fs::write(source.join("BUILD.md"), "Copy index.html into dist").unwrap();
        let requires=["plugins.archive_stage","plugins.archive_progress","plugins.archive_inspect","plugins.archive_read","plugins.archive_receipt","plugins.archive_import","plugins.archive_export"].map(|id|json!({"capability":{"id":id,"version":1},"scopes":[if matches!(id,"plugins.archive_stage"|"plugins.archive_import") {"plugins.write"} else {"plugins.read"}]}));
        fs::write(source.join("plugin.json"),serde_json::to_vec(&json!({"protocol_version":1,"id":"example.archive","name":"Independent archive","version":"1","description":"Public archive acceptance","license":"MIT","source":{"files":["index.html"],"lockfiles":["deps.lock"],"build_instructions":"BUILD.md","build":null},"dependencies":{},"requires":requires,"capabilities":[],"contexts":[],"backend":null,"views":[{"id":"archive","title":"Archive","entrypoint":"dist/index.html","state_schema":{"type":"object"},"configuration_schema":{"type":"object"},"resource_kinds":[]}],"configuration_schema":{"type":"object"},"default_configuration":{}})).unwrap()).unwrap();
        let archive = snapshot_directory(&source, None, "ui-web").unwrap();
        let bytes = serde_json::to_vec_pretty(&archive).unwrap();
        let db = temp.path().join("host.sqlite");
        Self {
            _temp: temp,
            root,
            db,
            archive,
            bytes,
        }
    }
    fn reference(&self, id: &str) -> Value {
        json!({"archive":id,"digest":content_digest(&self.bytes),"bytes":self.bytes.len()})
    }
    fn catalog(&self) -> rusqlite::Connection {
        rusqlite::Connection::open(repository_path(&self.db).join("catalog-v1.sqlite3")).unwrap()
    }
    fn holds(&self) -> u32 {
        self.catalog()
            .query_row("SELECT COUNT(*) FROM plugin_archive_holds", [], |r| {
                r.get(0)
            })
            .unwrap()
    }
    fn receipts(&self) -> u32 {
        self.catalog()
            .query_row("SELECT COUNT(*) FROM plugin_archive_receipts", [], |r| {
                r.get(0)
            })
            .unwrap()
    }
    async fn host(&self) -> NextHost {
        NextHost::open_plugin_workspace(&self.db, &self.root)
            .await
            .unwrap()
    }
}
fn invocation(id: &str, cap: &str, arguments: Value) -> Invocation {
    Invocation {
        client_request_id: id.into(),
        capability: CapabilityRef::new(cap, 1).unwrap(),
        arguments,
        preconditions: vec![],
    }
}
async fn query(
    host: &NextHost,
    c: &CallContext,
    cap: &str,
    arguments: Value,
) -> Result<Value, OperationError> {
    Ok(host
        .query_snapshot(
            c,
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
    c: &CallContext,
    cap: &str,
    arguments: Value,
) -> Result<Value, OperationError> {
    host.dispatch(
        c,
        HostRequest::Control(ControlRequest {
            capability: CapabilityRef::new(cap, 1).unwrap(),
            arguments,
        }),
    )
    .await
}
async fn stage(f: &Fixture, h: &NextHost, c: &CallContext, id: &str) -> Value {
    let r = f.reference(id);
    for (i, part) in f.bytes.chunks(ARCHIVE_CHUNK_BYTES).enumerate() {
        control(
            h,
            c,
            "plugins.archive_stage",
            json!({"reference":r,"offset":i*ARCHIVE_CHUNK_BYTES,"base64":STANDARD.encode(part)}),
        )
        .await
        .unwrap();
    }
    r
}
fn succeeded(record: OperationRecord) -> OperationRecord {
    assert_eq!(record.status, OperationStatus::Succeeded, "{record:?}");
    record
}
async fn run(h: &NextHost, c: &CallContext, id: &str, cap: &str, args: Value) -> OperationRecord {
    succeeded(h.invoke(c, invocation(id, cap, args)).await.unwrap())
}

#[tokio::test]
async fn empty_core_import_export_remove_reimport_share_scope_and_never_start_runtime() {
    let f = Fixture::new();
    let h = f.host().await;
    let c = NextHost::local_context();
    let r = stage(&f, &h, &c, "upload").await;
    let inspected = query(&h, &c, "plugins.archive_inspect", json!({"reference":r}))
        .await
        .unwrap();
    assert_eq!(inspected["revision"], json!(f.archive.revision.id));
    assert!(
        PluginRepository::observe(&repository_path(&f.db))
            .unwrap()
            .unwrap()
            .list()
            .unwrap()
            .is_empty()
    );
    let mut foreign = c.clone();
    foreign.caller.id = "other".into();
    assert!(
        query(
            &h,
            &foreign,
            "plugins.archive_inspect",
            json!({"reference":r})
        )
        .await
        .is_err()
    );
    let mut weak = c.clone();
    weak.scopes.remove("plugins.write");
    assert!(
        h.invoke(
            &weak,
            invocation("denied", "plugins.archive_import", json!({"reference":r}))
        )
        .await
        .is_err()
    );
    assert!(control(&h,&weak,"plugins.archive_stage",json!({"reference":r,"offset":0,"base64":STANDARD.encode(&f.bytes[..ARCHIVE_CHUNK_BYTES])})).await.is_err());
    assert!(
        control(
            &h,
            &c,
            "plugins.archive_stage",
            json!({"reference":r,"offset":0,"base64":"","path":"/arbitrary"})
        )
        .await
        .is_err()
    );
    let original = run(
        &h,
        &c,
        "import",
        "plugins.archive_import",
        json!({"reference":r}),
    )
    .await;
    assert_eq!(f.holds(), 0);
    assert_eq!(f.receipts(), 1);
    assert!(
        control(&h, &weak, "plugins.archive_discard", json!({"reference":r}))
            .await
            .is_err()
    );
    assert_eq!(
        control(&h, &c, "plugins.archive_discard", json!({"reference":r}))
            .await
            .unwrap()["discarded"],
        true
    );
    assert!(
        query(&h, &c, "plugins.archive_progress", json!({"reference":r}))
            .await
            .is_err()
    );
    let duplicate = run(
        &h,
        &c,
        "import",
        "plugins.archive_import",
        json!({"reference":r}),
    )
    .await;
    assert_eq!(
        duplicate.operation.operation_id,
        original.operation.operation_id
    );
    assert_eq!(f.receipts(), 1);
    let export = run(
        &h,
        &c,
        "export",
        "plugins.archive_export",
        json!({"revision":f.archive.revision.id,"artifacts":[f.archive.artifacts[0].id]}),
    )
    .await;
    let exported: PluginArchiveReference =
        serde_json::from_value(export.output.as_ref().unwrap()["reference"].clone()).unwrap();
    let mut read = vec![];
    let mut offset = 0;
    loop {
        let part = query(
            &h,
            &c,
            "plugins.archive_read",
            json!({"reference":exported,"offset":offset,"limit":65536}),
        )
        .await
        .unwrap();
        read.extend(STANDARD.decode(part["base64"].as_str().unwrap()).unwrap());
        let Some(next) = part["next"].as_u64() else {
            break;
        };
        offset = next;
    }
    assert_eq!(content_digest(&read), exported.digest);
    assert_eq!(
        serde_json::from_slice::<Value>(&read).unwrap(),
        serde_json::to_value(&f.archive).unwrap()
    );
    run(
        &h,
        &c,
        "remove",
        "plugins.remove",
        json!({"revision":f.archive.revision.id}),
    )
    .await;
    let replay = run(
        &h,
        &c,
        "export",
        "plugins.archive_export",
        json!({"revision":f.archive.revision.id,"artifacts":[f.archive.artifacts[0].id]}),
    )
    .await;
    assert_eq!(replay.output, export.output);
    assert!(
        PluginRepository::observe(&repository_path(&f.db))
            .unwrap()
            .unwrap()
            .list()
            .unwrap()
            .is_empty()
    );
    run(
        &h,
        &c,
        "reimport",
        "plugins.archive_import",
        json!({"reference":exported}),
    )
    .await;
    assert_eq!(
        query(
            &h,
            &c,
            "plugins.instances",
            json!({"after":null,"limit":20})
        )
        .await
        .unwrap()["instances"],
        json!([])
    );
    assert!(
        query(
            &h,
            &foreign,
            "plugins.archive_read",
            json!({"reference":exported,"offset":0,"limit":1})
        )
        .await
        .is_err()
    );
    assert!(
        query(
            &h,
            &foreign,
            "plugins.archive_receipt",
            json!({"operation_id":export.operation.operation_id})
        )
        .await
        .unwrap()
        .is_null()
    );
    let mut reader = c.clone();
    reader.scopes.remove("plugins.read");
    assert!(
        query(
            &h,
            &reader,
            "plugins.archive_read",
            json!({"reference":exported,"offset":0,"limit":1})
        )
        .await
        .is_err()
    );
    assert!(!f.root.join("runtime").exists());
    h.drain().await;
}

#[tokio::test]
async fn original_import_and_export_commit_recovery_preserve_captures_and_never_replay() {
    for exporting in [false, true] {
        let f = Fixture::new();
        let c = NextHost::local_context();
        let h = f.host().await;
        let r = stage(&f, &h, &c, "upload").await;
        if exporting {
            run(
                &h,
                &c,
                "seed",
                "plugins.archive_import",
                json!({"reference":r}),
            )
            .await;
        }
        let cap = if exporting {
            "plugins.archive_export"
        } else {
            "plugins.archive_import"
        };
        let args = if exporting {
            json!({"revision":f.archive.revision.id,"artifacts":[]})
        } else {
            json!({"reference":r})
        };
        let db = rusqlite::Connection::open(&f.db).unwrap();
        db.execute_batch("CREATE TRIGGER reject_archive_commit BEFORE UPDATE OF status ON operations WHEN NEW.status='succeeded' AND NEW.client_request_id='original' BEGIN SELECT RAISE(ABORT,'lost original commit'); END;").unwrap();
        let lost = h
            .invoke(&c, invocation("original", cap, args.clone()))
            .await
            .unwrap_err();
        let OperationError::CommitPending { operation_id, .. } = lost else {
            panic!("{lost}")
        };
        assert_eq!(f.holds(), 1);
        let receipt = query(
            &h,
            &c,
            "plugins.archive_receipt",
            json!({"operation_id":operation_id}),
        )
        .await
        .unwrap();
        assert_eq!(receipt["revision"], json!(f.archive.revision.id));
        assert!(
            control(
                &h,
                &c,
                "plugins.archive_discard",
                json!({"reference":receipt["reference"]})
            )
            .await
            .is_err()
        );
        let status = query(
            &h,
            &c,
            "operation.commit_status",
            json!({"operation_id":operation_id}),
        )
        .await
        .unwrap();
        assert_eq!(status["phase"], "durable");
        let reference: OperationCommitReference =
            serde_json::from_value(status["reference"].clone()).unwrap();
        assert!(
            PluginRepository::open(&repository_path(&f.db))
                .unwrap()
                .remove(&f.archive.revision.id)
                .is_err()
        );
        let repeated = h
            .invoke(&c, invocation("original", cap, args.clone()))
            .await
            .unwrap();
        assert_eq!(repeated.status, OperationStatus::Running);
        assert_eq!(repeated.operation.operation_id, operation_id);
        let before = f.receipts();
        db.execute_batch("DROP TRIGGER reject_archive_commit;")
            .unwrap();
        h.drain().await;
        drop(h);
        let h = f.host().await;
        assert_eq!(f.holds(), 1);
        assert_eq!(f.receipts(), before);
        let mut foreign = c.clone();
        foreign.caller.id = "foreign".into();
        assert!(
            h.reconcile_commit(
                &foreign,
                &ReconcileOperationCommit {
                    reference: reference.clone()
                }
            )
            .await
            .is_err()
        );
        let mut weak = c.clone();
        weak.scopes.remove(if exporting {
            "plugins.read"
        } else {
            "plugins.write"
        });
        assert!(
            h.reconcile_commit(
                &weak,
                &ReconcileOperationCommit {
                    reference: reference.clone()
                }
            )
            .await
            .is_err()
        );
        let recovered = succeeded(
            h.reconcile_commit(&c, &ReconcileOperationCommit { reference })
                .await
                .unwrap(),
        );
        assert_eq!(recovered.output, Some(receipt));
        assert_eq!(f.holds(), 0);
        assert_eq!(f.receipts(), before);
        let final_result = run(&h, &c, "original", cap, args).await;
        assert_eq!(final_result.output, recovered.output);
        assert_eq!(f.receipts(), before);
        run(
            &h,
            &c,
            "remove-settled",
            "plugins.remove",
            json!({"revision":f.archive.revision.id}),
        )
        .await;
        h.drain().await;
    }
}

#[tokio::test]
async fn lost_result_staging_retains_uncertainty_despite_catalog_receipt() {
    let f = Fixture::new();
    let c = NextHost::local_context();
    let h = f.host().await;
    let r = stage(&f, &h, &c, "upload").await;
    let db = rusqlite::Connection::open(&f.db).unwrap();
    db.execute_batch("CREATE TRIGGER reject_archive_staging BEFORE INSERT ON operation_commit_candidates WHEN (SELECT client_request_id FROM operations WHERE operation_id=NEW.operation_id)='uncertain' BEGIN SELECT RAISE(ABORT,'lost result staging'); END;").unwrap();
    let args = json!({"reference":r});
    let lost = h
        .invoke(
            &c,
            invocation("uncertain", "plugins.archive_import", args.clone()),
        )
        .await
        .unwrap_err();
    let OperationError::CommitPending { operation_id, .. } = lost else {
        panic!("{lost}")
    };
    assert_eq!(f.holds(), 1);
    assert_eq!(f.receipts(), 1);
    h.drain().await;
    drop(h);
    db.execute_batch("DROP TRIGGER reject_archive_staging;")
        .unwrap();
    let h = f.host().await;
    let original = h.get_operation(&c, &operation_id).await.unwrap().unwrap();
    assert_eq!(original.status, OperationStatus::Uncertain);
    let replay = h
        .invoke(&c, invocation("uncertain", "plugins.archive_import", args))
        .await
        .unwrap();
    assert_eq!(replay.status, OperationStatus::Uncertain);
    assert_eq!(replay.operation.operation_id, operation_id);
    let cleanup = h
        .invoke(
            &c,
            invocation(
                "do-not-release",
                "plugins.reconcile_references",
                json!({"operation_id":operation_id}),
            ),
        )
        .await
        .unwrap();
    assert_ne!(cleanup.status, OperationStatus::Succeeded);
    assert_eq!(f.holds(), 1);
    assert_eq!(f.receipts(), 1);
    assert!(
        PluginRepository::open(&repository_path(&f.db))
            .unwrap()
            .remove(&f.archive.revision.id)
            .is_err()
    );
    assert!(
        !query(
            &h,
            &c,
            "plugins.archive_receipt",
            json!({"operation_id":operation_id})
        )
        .await
        .unwrap()
        .is_null()
    );
    h.drain().await;
}

#[tokio::test]
async fn ordinary_view_uses_declared_archive_ports_and_native_principal() {
    let f = Fixture::new();
    let c = NextHost::local_context();
    let h = f.host().await;
    let r = stage(&f, &h, &c, "seed").await;
    run(
        &h,
        &c,
        "seed",
        "plugins.archive_import",
        json!({"reference":r}),
    )
    .await;
    let instance=run(&h,&c,"activate","plugins.activate",json!({"revision":f.archive.revision.id,"artifact":f.archive.artifacts[0].id,"target":"ui-web","alias":"archive","configuration":{}})).await.output.unwrap()["instance"]["identity"].clone();
    let view=run(&h,&c,"open","views.open",json!({"instance":instance,"contribution":"archive","window":"window","configuration":{},"state":{}})).await.output.unwrap()["view"].clone();
    let connection: PluginViewConnection = serde_json::from_value(
        query(&h, &c, "views.connection", json!({"view":view}))
            .await
            .unwrap(),
    )
    .unwrap();
    let message = |seq, body: Value| {
        serde_json::from_value(json!({"protocol_version":1,"connection":connection.connection,"view":view,"sequence":seq,"request":format!("message-{seq}"),"body":body})).unwrap()
    };
    let body = json!({"type":"invoke","capability":{"id":"plugins.archive_export","version":1},"arguments":{"revision":f.archive.revision.id,"artifacts":[]},"request_id":"export","preconditions":[]});
    let accepted: OperationRecord = serde_json::from_value(
        h.dispatch_plugin_view(&c, "window", &connection.call_token, message(1, body))
            .await
            .unwrap(),
    )
    .unwrap();
    let original = succeeded(
        tokio::time::timeout(std::time::Duration::from_secs(10), async {
            loop {
                let record = h
                    .get_operation(&c, &accepted.operation.operation_id)
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
    assert_eq!(original.operation.principal(), c.principal());
    assert_eq!(original.operation.caller.id, view.as_str().unwrap());
    let read = json!({"type":"query","capability":{"id":"plugins.archive_read","version":1},"arguments":{"reference":original.output.unwrap()["reference"],"offset":0,"limit":30}});
    assert!(matches!(
        h.dispatch_plugin_view(
            &c,
            "wrong-window",
            &connection.call_token,
            message(2, read.clone())
        )
        .await,
        Err(OperationError::NotFound(_))
    ));
    let page = h
        .dispatch_plugin_view(
            &c,
            "window",
            &connection.call_token,
            message(2, read.clone()),
        )
        .await
        .unwrap();
    assert_eq!(
        STANDARD
            .decode(page["data"]["base64"].as_str().unwrap())
            .unwrap()
            .len(),
        30
    );
    let mut weak = c.clone();
    weak.scopes.remove("plugins.read");
    assert!(matches!(
        h.dispatch_plugin_view(&weak, "window", &connection.call_token, message(3, read))
            .await,
        Err(OperationError::AccessDenied { .. })
    ));
    let undeclared = json!({"type":"query","capability":{"id":"plugins.inspect","version":1},"arguments":{"revision":f.archive.revision.id}});
    assert!(matches!(
        h.dispatch_plugin_view(&c, "window", &connection.call_token, message(4, undeclared))
            .await,
        Err(OperationError::InvalidInput(message)) if message == "capability is not granted to this view"
    ));
    h.drain().await;
}
