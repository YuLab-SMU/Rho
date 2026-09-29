//! Real scientific owner checks; model/picker fixtures cannot establish these.
use super::*;

pub async fn help(host: &NextHost, owner: &InstanceRef, session: &Value, native: &Value) {
    let page = native_query(
        host,
        owner,
        "r.context.help.search",
        json!({"window":"context-window","text":"parallel::mclapply","limit":20}),
    )
    .await;
    let items = page["items"].as_array().unwrap();
    assert_eq!(items.len(), 1, "{page}");
    let reference = &items[0]["reference"];
    assert_eq!(reference["selector"]["session"], *session);
    assert_eq!(reference["selector"]["help_files"], native["help_files"]);
    let args = json!({"reference":reference,"inclusion":{"kind":"excerpt"},"max_bytes":16384});
    let preview = native_query(host, owner, "r.context.help.preview", args.clone()).await;
    assert_eq!(preview["item"]["reference"], *reference);
    assert_eq!(preview["truncated"], false);
    assert!(!preview["text"].as_str().unwrap().is_empty());
    assert!(preview["text"].as_str().unwrap().lines().count() <= 12);
    assert_eq!(preview["resources"], json!([]));
    let mut changed = args;
    changed["reference"]["selector"]["help_files"][0]["digest"] = json!("substituted-file");
    assert!(host.query_snapshot(&NextHost::local_context(), QueryRequest {
        capability: CapabilityRef::new("r.context.help.preview", 1).unwrap(),
        arguments: json!({"binding":binding(host,owner,"r.context.help.preview").await,"arguments":changed}),
    }).await.is_err());
    assert_eq!(
        native_query(host, owner, "r.session", json!({})).await["session_id"],
        *session
    );
}
pub async fn viewer(host: &NextHost, owner: &InstanceRef, html: &Value, operation: &OperationId) {
    let before =
        query(host, "operation.list_recent", json!({"limit":100})).await["operations"].clone();
    let page = native_query(
        host,
        owner,
        "r.context.viewer.search",
        json!({"window":"context-window","text":operation.as_str(),"limit":20}),
    )
    .await;
    let items = page["items"].as_array().unwrap();
    assert_eq!(items.len(), 1, "{page}");
    let reference = &items[0]["reference"];
    assert_eq!(reference["selector"]["reference"], *html);
    let args = json!({"reference":reference,"inclusion":{"kind":"text"},"max_bytes":16384});
    let preview = native_query(host, owner, "r.context.viewer.preview", args.clone()).await;
    assert_eq!(preview["item"]["reference"], *reference);
    assert_eq!(preview["truncated"], false);
    assert!(
        preview["text"]
            .as_str()
            .unwrap()
            .contains("retained public viewer")
    );
    assert_eq!(preview["resources"], json!([]));
    let mut changed = args;
    changed["reference"]["selector"]["reference"]["digest"] =
        json!(format!("sha256:{}", "f".repeat(64)));
    assert!(host.query_snapshot(&NextHost::local_context(), QueryRequest {
        capability: CapabilityRef::new("r.context.viewer.preview", 1).unwrap(),
        arguments: json!({"binding":binding(host,owner,"r.context.viewer.preview").await,"arguments":changed}),
    }).await.is_err());
    assert_eq!(
        query(host, "operation.list_recent", json!({"limit":100})).await["operations"],
        before
    );
}
