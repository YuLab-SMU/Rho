//! Read-only inspection through the ordinary R package and original Host ports.
use super::*;

async fn ready(host: &NextHost, owner: &InstanceRef, capability: &str, arguments: Value) -> Value {
    let session = arguments["expected_session"].clone();
    let observed = native_query(host, owner, capability, arguments).await;
    assert_eq!(observed["session_id"], session, "{observed}");
    assert_eq!(observed["status"], "ready", "{observed}");
    assert!(observed["diagnostic"].is_null(), "{observed}");
    observed["data"].clone()
}

pub async fn unstarted(host: &NextHost, owner: &InstanceRef) {
    for (capability, arguments) in [
        ("r.list_objects", json!({"expected_session":"absent"})),
        (
            "r.observe_object",
            json!({"expected_session":"absent","name":"x"}),
        ),
        (
            "r.inspect_object",
            json!({"expected_session":"absent","name":"x"}),
        ),
        ("r.packages", json!({"expected_session":"absent"})),
    ] {
        assert!(host.query_snapshot(&NextHost::local_context(), QueryRequest {
            capability: CapabilityRef::new(capability, 1).unwrap(),
            arguments: json!({"binding":binding(host,owner,capability).await,"arguments":arguments}),
        }).await.is_err());
    }
    assert_eq!(
        native_query(host, owner, "r.session", json!({})).await["state"],
        "unstarted"
    );
}

pub async fn busy(host: &NextHost, owner: &InstanceRef, session: &Value) {
    for capability in ["r.list_objects", "r.packages"] {
        let observed =
            native_query(host, owner, capability, json!({"expected_session":session})).await;
        assert_eq!(observed["session_id"], *session);
        assert_eq!(observed["status"], "busy", "{observed}");
        assert_eq!(observed["completeness"], "unknown");
        assert!(observed["data"].is_null());
    }
}

pub async fn exercise(
    host: &Arc<NextHost>,
    owner: &InstanceRef,
    session: &Value,
    other: &InstanceRef,
    other_session: &Value,
) {
    let execute = binding(host, owner, "r.execute").await;
    run(host, "inspection-fixtures", "r.execute", json!({"binding":execute,"arguments":{"expected_session":session,"code":r#"
invisible(loadNamespace('tools'))
inspection_environment <- list(search = search(), loaded = loadedNamespaces(), libraries = .libPaths())
inspection_forced <- 0L
inspection_table <- data.frame(x = 1:3, label = c('中文', 'αβ', 'z'))
delayedAssign('inspection_lazy', { inspection_forced <<- inspection_forced + 1L; 42L }, assign.env = .GlobalEnv)
makeActiveBinding('inspection_active', function() { inspection_forced <<- inspection_forced + 1L; 123L }, .GlobalEnv)
"#}})).await;
    queue::wait(host, owner, session, |state| {
        state["awaiting_commit"] == json!([])
    })
    .await;
    let before =
        query(host, "operation.list_recent", json!({"limit":100})).await["operations"].clone();
    let directory = ready(
        host,
        owner,
        "r.list_objects",
        json!({"expected_session":session,"name_contains":"inspection_","limit":2}),
    )
    .await;
    assert_eq!(directory["entries"].as_array().unwrap().len(), 2);
    let continued = ready(
        host,
        owner,
        "r.list_objects",
        json!({"expected_session":session,"name_contains":"inspection_","limit":2,
        "directory_ref":directory["directory_ref"],"offset":directory["next_offset"]}),
    )
    .await;
    assert_eq!(continued["directory_ref"], directory["directory_ref"]);
    assert_ne!(
        continued["entries"][0]["name"],
        directory["entries"][0]["name"]
    );
    for name in ["inspection_lazy", "inspection_active"] {
        let preview = ready(
            host,
            owner,
            "r.inspect_object",
            json!({"expected_session":session,"name":name,"max_items":20}),
        )
        .await;
        assert!(preview["preview"].is_null(), "{preview}");
    }
    let object = ready(
        host,
        owner,
        "r.observe_object",
        json!({"expected_session":session,"name":"inspection_table"}),
    )
    .await;
    let arguments = json!({"expected_session":session,"object_ref":object["object_ref"],"kind":"table","limit":2,"column_limit":2});
    let table = ready(host, owner, "r.read_object", arguments.clone()).await;
    assert_eq!(table["columns"][1]["values"][0]["text"], "中文");
    let mut next_arguments = arguments.clone();
    next_arguments["start"] = table["next_start"].clone();
    let table_next = ready(host, owner, "r.read_object", next_arguments).await;
    assert_eq!(table_next["object_ref"], object["object_ref"]);
    assert_eq!(table_next["columns"][1]["values"][0]["text"], "z");
    let foreign = native_query(host, other, "r.read_object", json!({"expected_session":other_session,"object_ref":object["object_ref"],"kind":"structure"})).await;
    assert_eq!(foreign["status"], "unavailable");
    assert_eq!(foreign["diagnostic"]["code"], "observation_expired");
    assert!(host.query_snapshot(&NextHost::local_context(), QueryRequest {
        capability: CapabilityRef::new("r.list_objects", 1).unwrap(),
        arguments: json!({"binding":binding(host,owner,"r.list_objects").await,"arguments":{"expected_session":other_session}}),
    }).await.is_err());

    let packages = ready(
        host,
        owner,
        "r.packages",
        json!({"expected_session":session,"filter":"parallel","grouped":true}),
    )
    .await;
    assert!(
        packages["groups"]
            .as_array()
            .unwrap()
            .iter()
            .any(|group| group["name"] == "parallel")
    );
    let copies = ready(host, owner, "r.packages", json!({"expected_session":session,"observation_id":packages["observation_id"],"package_name":"parallel"})).await;
    assert_eq!(copies["observation_id"], packages["observation_id"]);
    assert_eq!(copies["counts"], packages["counts"]);
    let copy = &copies["packages"][0];
    let index = ready(
        host,
        owner,
        "r.package_index",
        json!({"expected_session":session,"observation_id":packages["observation_id"],
        "package":"parallel","library_path":copy["library_path"],"limit":2}),
    )
    .await;
    assert_eq!(index["observation_id"], packages["observation_id"]);
    let help_args = json!({"expected_session":session,"observation_id":packages["observation_id"],"package":"parallel",
        "library_path":copy["library_path"],"topic":"mclapply","expected_index_files":index["files"],"limit_bytes":256});
    let help = ready(host, owner, "r.read_help", help_args.clone()).await;
    assert_eq!(help["found"], true);
    assert!(!help["text"].as_str().unwrap().is_empty());
    let mut continuation = help_args.clone();
    continuation["offset_utf8"] = help["next_offset_utf8"].clone();
    continuation["expected_help_files"] = help["help_files"].clone();
    let help_next = ready(host, owner, "r.read_help", continuation).await;
    assert_eq!(help_next["help_files"], help["help_files"]);
    assert_eq!(help_next["offset_utf8"], help["next_offset_utf8"]);
    let mut changed = help_args;
    changed["expected_index_files"][0]["digest"] = json!("changed-file-identity");
    let rejected = native_query(host, owner, "r.read_help", changed).await;
    assert_eq!(rejected["status"], "unavailable");
    assert_eq!(rejected["diagnostic"]["code"], "content_changed");
    assert_eq!(
        query(host, "operation.list_recent", json!({"limit":100})).await["operations"],
        before,
        "Inspection must not manufacture execution records"
    );
    run(
        host,
        "inspection-readonly-verification",
        "r.execute",
        json!({"binding":execute,"arguments":{"expected_session":session,"code":r#"
stopifnot(inspection_forced == 0L,
          identical(inspection_environment$search, search()),
          identical(inspection_environment$loaded, loadedNamespaces()),
          identical(inspection_environment$libraries, .libPaths()))
"#}}),
    )
    .await;
    queue::wait(host, owner, session, |state| {
        state["awaiting_commit"] == json!([])
    })
    .await;
    let expired = native_query(host, owner, "r.read_object", arguments).await;
    assert_eq!(expired["status"], "unavailable");
    assert_eq!(expired["diagnostic"]["code"], "observation_expired");
}
