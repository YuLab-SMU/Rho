//! Real Files owner loaded from an independently assembled public package.
use rho_contract::*;
use rho_host::{NextHost, OperationError};
use rho_plugin_protocol::{InstanceRef, PluginArchive};
use rho_plugins::{PluginRepository, backend_target, repository_path, snapshot_directory};
use serde_json::{Value, json};
use std::{fs, path::Path, process::Command, sync::Arc};

fn invocation(id: &str, capability: &str, arguments: Value) -> Invocation {
    Invocation {
        client_request_id: id.into(),
        capability: CapabilityRef::new(capability, 1).unwrap(),
        arguments,
        preconditions: vec![],
    }
}
async fn run(host: &NextHost, id: &str, cap: &str, args: Value) -> OperationRecord {
    let record = host
        .invoke(&NextHost::local_context(), invocation(id, cap, args))
        .await
        .unwrap();
    assert_eq!(record.status, OperationStatus::Succeeded, "{record:?}");
    record
}
fn request(cap: &str, arguments: Value) -> QueryRequest {
    QueryRequest {
        capability: CapabilityRef::new(cap, 1).unwrap(),
        arguments,
    }
}
async fn query(host: &NextHost, cap: &str, args: Value) -> Value {
    let snapshot = host
        .query_snapshot(&NextHost::local_context(), request(cap, args))
        .await
        .unwrap();
    assert_eq!(snapshot.status, QueryStatus::Ready, "{snapshot:?}");
    snapshot.data.unwrap()
}
async fn binding(host: &NextHost, instance: &InstanceRef, cap: &str) -> Value {
    query(
        host,
        "plugins.resolve",
        json!({"instance":instance,"capability":{"id":cap,"version":1}}),
    )
    .await
}
async fn read(host: &NextHost, instance: &InstanceRef, cap: &str, args: Value) -> Value {
    query(
        host,
        cap,
        json!({"binding":binding(host,instance,cap).await,"arguments":args}),
    )
    .await
}
async fn activate(host: &NextHost, archive: &PluginArchive, alias: &str) -> InstanceRef {
    serde_json::from_value(run(host, alias, "plugins.activate", json!({"revision":archive.revision.id,"artifact":archive.artifacts[0].id,"target":backend_target(),"alias":alias,"configuration":{}})).await.output.unwrap()["instance"]["identity"].clone()).unwrap()
}
fn git(root: &Path, args: &[&str]) -> String {
    let result = Command::new("git")
        .args([
            "-c",
            "user.name=Rho test",
            "-c",
            "user.email=rho@example.invalid",
            "-c",
            "commit.gpgsign=false",
            "-c",
            "core.hooksPath=/dev/null",
        ])
        .args(args)
        .current_dir(root)
        .output()
        .unwrap();
    assert!(
        result.status.success(),
        "{}",
        String::from_utf8_lossy(&result.stderr)
    );
    String::from_utf8(result.stdout).unwrap().trim().into()
}
fn copy_tree(from: &Path, to: &Path) {
    fs::create_dir(to).unwrap();
    for entry in fs::read_dir(from).unwrap() {
        let entry = entry.unwrap();
        let target = to.join(entry.file_name());
        assert!(!entry.file_type().unwrap().is_symlink());
        if entry.file_type().unwrap().is_dir() {
            copy_tree(&entry.path(), &target);
        } else {
            fs::copy(entry.path(), target).unwrap();
        }
    }
}
fn patch(before: &str, after: &str) -> String {
    format!(
        "diff --git a/analysis.R b/analysis.R\n--- a/analysis.R\n+++ b/analysis.R\n@@ -1 +1 @@\n-{before}\n+{after}\n"
    )
}

#[tokio::test]
#[ignore = "requires RHO_FILES_PLUGIN_PACKAGE independently built outside the checkout"]
async fn independent_files_versions_preserve_native_boundaries_and_original_commits() {
    let source = std::path::PathBuf::from(
        std::env::var_os("RHO_FILES_PLUGIN_PACKAGE").expect("RHO_FILES_PLUGIN_PACKAGE"),
    );
    let temp = tempfile::tempdir().unwrap();
    let project = temp.path().join("project");
    fs::create_dir(&project).unwrap();
    let project = project.canonicalize().unwrap();
    git(&project, &["init", "--quiet"]);
    for (name, content) in [
        ("analysis.R", "x <- 1\n"),
        ("staged.R", "staged <- 0\n"),
        ("dirty.R", "dirty <- 0\n"),
    ] {
        fs::write(project.join(name), content).unwrap();
    }
    git(&project, &["add", "."]);
    git(&project, &["commit", "--quiet", "-m", "fixture"]);
    fs::write(project.join("staged.R"), "staged <- 10\n").unwrap();
    git(&project, &["add", "staged.R"]);
    fs::write(project.join("dirty.R"), "dirty <- 20\n").unwrap();
    fs::write(project.join("notes.txt"), "中文 α\r\nuntouched\n").unwrap();
    let head = git(&project, &["rev-parse", "HEAD"]);
    let index = fs::read(project.join(".git/index")).unwrap();
    // Place Host stores inside the project to test real exclusions, not a mock list.
    let db = project.join("records.sqlite");
    let first = snapshot_directory(&source, None, &backend_target()).unwrap();
    let second_source = temp.path().join("revision-two");
    copy_tree(&source, &second_source);
    let manifest_path = second_source.join("plugin.json");
    let mut manifest: Value = serde_json::from_slice(&fs::read(&manifest_path).unwrap()).unwrap();
    manifest["version"] = json!("0.1.1");
    fs::write(manifest_path, serde_json::to_vec(&manifest).unwrap()).unwrap();
    let second = snapshot_directory(
        &second_source,
        Some(first.revision.id.clone()),
        &backend_target(),
    )
    .unwrap();
    let mut repository = PluginRepository::open(&repository_path(&db)).unwrap();
    repository.import(&first).unwrap();
    repository.import(&second).unwrap();
    drop(repository);
    let host = Arc::new(NextHost::open_project(&db, &project).await.unwrap());
    let left = activate(&host, &first, "files-left").await;
    let right = activate(&host, &second, "files-right").await;
    assert_ne!(left.revision, right.revision);
    assert_ne!(left.instance, right.instance);
    let exercise_host = host.clone();
    let exercise_left = left.clone();
    let exercise_right = right.clone();
    let exercise_root = project.clone();
    let exercise_db = db.clone();
    let exercise = tokio::spawn(async move {
        let (host,left,right,project,db) = (exercise_host,exercise_left,exercise_right,exercise_root,exercise_db);
        let context = NextHost::local_context();
        let before_reads = host.outbox(&context,0,1000).await.unwrap();
        assert!(host.query_snapshot(&context,request("plugins.resolve",json!({"capability":{"id":"files.snapshot","version":1}}))).await.is_err(), "two providers cannot overwrite or silently select each other");
        let directory = read(&host,&left,"files.list_directory",json!({})).await;
        for entry in directory["entries"].as_array().unwrap() { assert!(!entry["name"].as_str().unwrap().starts_with("records.sqlite"), "{entry}"); }
        let read_binding = binding(&host,&left,"files.read_file").await;
        #[cfg(unix)] std::os::unix::fs::symlink(&db,project.join("database-alias")).unwrap();
        for path in ["records.sqlite", "records.sqlite-wal", "records.sqlite.host.lock", "database-alias", "../escape"] {
            assert!(host.query_snapshot(&context,request("files.read_file",json!({"binding":read_binding,"arguments":{"path":path}}))).await.is_err(), "protected path {path}");
        }
        let mut foreign = context.clone(); foreign.caller.id = "other-principal".into(); foreign.principal = None;
        assert!(host.query_snapshot(&foreign,request("files.read_file",json!({"binding":read_binding,"arguments":{"path":"analysis.R"}}))).await.is_err());
        let mut denied = context.clone(); denied.scopes.remove("project.read");
        assert!(host.query_snapshot(&denied,request("files.read_file",json!({"binding":read_binding,"arguments":{"path":"analysis.R"}}))).await.is_err());
        let text = read(&host,&left,"files.read_text",json!({"path":"notes.txt","limit_lines":1})).await;
        assert_eq!(text["fragments"][0]["text"],"中文 α\r\n");
        let files = read(&host,&left,"files.search_files",json!({"text":"analysis","show_hidden":false})).await;
        assert!(files.to_string().contains("analysis.R"));
        let search = read(&host,&left,"files.search_text",json!({"text":"中文","filename_contains":"notes.txt","limit_matches":10})).await;
        assert!(search.to_string().contains("中文"));
        let storage = read(&host,&left,"files.storage_status",json!({})).await;
        assert_eq!(storage["project"],json!(project)); assert!(storage["total_bytes"].as_u64().unwrap()>0);
        let snapshot = read(&host,&left,"files.snapshot",json!({"paths":["analysis.R"]})).await;
        assert_eq!(read(&host,&right,"files.snapshot",json!({"paths":["analysis.R"]})).await["files"],snapshot["files"]);
        assert_eq!(host.outbox(&context,0,1000).await.unwrap().len(),before_reads.len(),"reads do not create Operations");
        let bind = binding(&host,&left,"files.apply_patch").await;
        let original = invocation("files-original","files.apply_patch",json!({"binding":bind,"arguments":{"patch":patch("x <- 1","x <- 2")},"preconditions":[{"kind":"file.sha256","subject":"analysis.R","expected":snapshot["files"][0]["sha256"]},{"kind":"git.head","subject":"project","expected":snapshot["git"]["head"]}]}));
        let mut wrong = original.clone(); wrong.client_request_id = "wrong-target".into(); wrong.arguments["binding"]["target"] = json!("/other");
        let wrong = host.invoke(&context,wrong).await.unwrap_err();
        assert_eq!(wrong.diagnostic().code,DiagnosticCode::InvalidInput);
        assert!(wrong.to_string().contains("target differs"));
        let mut denied_write = context.clone(); denied_write.scopes.remove("project.write");
        assert!(host.invoke(&denied_write,original.clone()).await.is_err());
        let record = host.invoke(&context,original.clone()).await.unwrap();
        assert_eq!(record.status,OperationStatus::Succeeded,"{record:?}");
        assert_eq!(record.output.as_ref().unwrap()["changed_paths"],json!(["analysis.R"]));
        assert_eq!(record.output.as_ref().unwrap()["committed_to_git"],false);
        let changed = host.query_snapshot(&context,request("files.read_text",json!({"binding":binding(&host,&left,"files.read_text").await,"arguments":{"path":"analysis.R","expected_sha256":snapshot["files"][0]["sha256"]}}))).await.unwrap_err();
        assert_eq!(changed.diagnostic().code,DiagnosticCode::ContentChanged);
        let facts = host.facts_for_operation(&context,&record.operation.operation_id).await.unwrap();
        assert_eq!(facts.len(),1); assert_eq!(facts[0].value["owner"],json!(left));
        assert_eq!(facts[0].value["schema"],"rho.files.patch.v1");
        assert_eq!(facts[0].value["key"],json!(record.operation.operation_id));
        assert_eq!(host.invoke(&context,original.clone()).await.unwrap().operation.operation_id,record.operation.operation_id);
        let mut stale = original.clone(); stale.client_request_id = "stale-sha".into(); stale.arguments["arguments"]["patch"] = json!(patch("x <- 2","must not write"));
        let stale = host.invoke(&context,stale).await.unwrap();
        assert_eq!(stale.status,OperationStatus::Failed,"{stale:?}");
        assert_eq!(fs::read_to_string(project.join("analysis.R")).unwrap(),"x <- 2\n");
        // Fault the real journal only after the native change has happened. The
        // backend holds its original lane until that exact commit is recovered.
        let sql = rusqlite::Connection::open(&db).unwrap();
        sql.execute_batch("CREATE TRIGGER files_block_commit BEFORE UPDATE OF status ON operations WHEN NEW.status='succeeded' AND OLD.client_request_id='files-gated' BEGIN SELECT RAISE(ABORT,'files terminal write fault'); END;").unwrap();
        let gated = invocation("files-gated","files.apply_patch",json!({"binding":bind,"arguments":{"patch":patch("x <- 2","x <- 3")}}));
        let pending = match host.invoke(&context,gated.clone()).await.unwrap_err() {
            OperationError::CommitPending { operation_id, .. } => operation_id,
            error => panic!("Expected original commit fault: {error}"),
        };
        assert_eq!(fs::read_to_string(project.join("analysis.R")).unwrap(),"x <- 3\n");
        let busy = host.query_snapshot(&context,request("files.snapshot",json!({"binding":binding(&host,&left,"files.snapshot").await,"arguments":{}}))).await.unwrap_err();
        assert_eq!(busy.diagnostic().code,DiagnosticCode::Busy,"unsettled owner cannot emit a new observation");
        let status = query(&host,"operation.commit_status",json!({"operation_id":pending})).await;
        assert_eq!(status["phase"],"durable");
        sql.execute_batch("DROP TRIGGER files_block_commit;").unwrap();
        let recovered = host.reconcile_commit(&context,&ReconcileOperationCommit { reference: serde_json::from_value(status["reference"].clone()).unwrap() }).await.unwrap();
        assert_eq!(recovered.status,OperationStatus::Succeeded);
        assert_eq!(recovered.operation.operation_id,pending);
        assert_eq!(host.invoke(&context,gated).await.unwrap().operation.operation_id,pending);
        let current = read(&host,&right,"files.snapshot",json!({"paths":["analysis.R"]})).await;
        assert_ne!(current["files"][0]["sha256"],snapshot["files"][0]["sha256"]);
        let right_write = run(&host,"files-right-original","files.apply_patch",json!({"binding":binding(&host,&right,"files.apply_patch").await,"arguments":{"patch":patch("x <- 3","x <- 4")},"preconditions":[{"kind":"file.sha256","subject":"analysis.R","expected":current["files"][0]["sha256"]}]})).await;
        let right_facts = host.facts_for_operation(&context,&right_write.operation.operation_id).await.unwrap();
        assert_eq!(right_facts.len(),1);
        assert_eq!(right_facts[0].value["owner"],json!(right));
        assert_ne!(right_facts[0].key,facts[0].key);
        assert_eq!(git(&project,&["rev-parse","HEAD"]),head);
        assert_eq!(fs::read(project.join(".git/index")).unwrap(),index);
        assert_eq!(fs::read_to_string(project.join("dirty.R")).unwrap(),"dirty <- 20\n");
        assert_eq!(fs::read_to_string(project.join("staged.R")).unwrap(),"staged <- 10\n");
        assert_eq!(fs::read_to_string(project.join("notes.txt")).unwrap(),"中文 α\r\nuntouched\n");
        (original,record)
    }).await;
    // Ensure our own disposable processes are released even after an assertion.
    let mut cleanup = vec![];
    for (id, instance) in [
        ("release-files-left", &left),
        ("release-files-right", &right),
    ] {
        cleanup.push(
            host.invoke(
                &NextHost::local_context(),
                invocation(id, "plugins.release", json!({"instance":instance})),
            )
            .await,
        );
    }
    let (original, record) = exercise.unwrap();
    for result in cleanup {
        let result = result.unwrap();
        assert_eq!(result.status, OperationStatus::Succeeded, "{result:?}");
    }
    for (id, revision) in [
        ("remove-files-right", &second.revision.id),
        ("remove-files-left", &first.revision.id),
    ] {
        run(&host, id, "plugins.remove", json!({"revision":revision})).await;
    }
    host.drain().await;
    drop(host);
    let reopened = NextHost::open_project(&db, &project).await.unwrap();
    assert!(
        !reopened
            .capabilities()
            .iter()
            .any(|cap| cap.capability.id == "files.apply_patch")
    );
    let replay = reopened
        .invoke(&NextHost::local_context(), original)
        .await
        .unwrap();
    assert_eq!(replay.operation.operation_id, record.operation.operation_id);
    assert_eq!(replay.output, record.output);
    assert_eq!(
        fs::read_to_string(project.join("analysis.R")).unwrap(),
        "x <- 4\n",
        "historical replay cannot repeat the patch"
    );
    reopened.drain().await;
}
