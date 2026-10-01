use super::super::tests::fixture;
use super::*;
fn source() -> Source {
    decode(json!({"session":"native","observation":"original","package":"研究","library":"/library/one","version":"1.2"})).unwrap()
}
fn page() -> PackageSnapshotData {
    decode(json!({"r_version":"4.5","r_home":"/R","platform":"macOS","library_paths":["/library/one"],"mode":"installed","filter":"","offset":0,"next_offset":null,"packages":[{"name":"研究","version":"1.2","title":"Purpose 中文","built":null,"library_path":"/library/one","library_index":1,"first_in_library_path":true,"loaded_version":null,"loaded_path":null,"loaded_from_library":false,"attached":false,"source":null}],"observation_id":"original","observed_at_ms":42,"package_name":"研究","total_matches":1,"scanned":1,"scan_complete":true,"notices":[]})).unwrap()
}
fn observed(page: &PackageSnapshotData) -> RInspection<Value> {
    decode(json!({"session_id":"native","status":"ready","source":"native","observed_at_ms":42,"completeness":"complete","data":page,"notices":[],"diagnostic":null})).unwrap()
}
fn arguments() -> Value {
    json!({"expected_session":"native","observation_id":"original","package_name":"研究","grouped":true,"mode":"installed","filter":"","offset":0,"limit":20})
}
#[test]
fn installed_copy_metadata_preserves_observation_provenance_and_unicode_bounds() {
    let (_dir, owner, _, _) = fixture();
    let source = source();
    let mut page = page();
    let reference = source
        .item(&owner.instance, &WindowId::new("window").unwrap())
        .unwrap()
        .reference;
    let request: PreviewContext =
        decode(json!({"reference":reference,"inclusion":{"kind":"metadata"},"max_bytes":16384}))
            .unwrap();
    let full = preview(
        &owner.instance,
        request.clone(),
        &source,
        &page,
        &page.packages[0],
    )
    .unwrap();
    assert!(full.text.contains("Purpose 中文"));
    assert!(full.text.contains("unknown"));
    assert!(full.text.contains("\"source\": null"));
    assert!(!full.truncated);
    let mut fresh_source = source.clone();
    fresh_source.observation = "fresh-observation".into();
    let mut fresh_page = page.clone();
    fresh_page.observation_id = fresh_source.observation.clone();
    fresh_page.observed_at_ms = 99;
    let mut fresh_request = request.clone();
    fresh_request.reference = fresh_source
        .item(&owner.instance, &request.reference.window)
        .unwrap()
        .reference;
    let fresh = preview(
        &owner.instance,
        fresh_request.clone(),
        &fresh_source,
        &fresh_page,
        &fresh_page.packages[0],
    )
    .unwrap();
    assert_eq!(
        fresh.data["annotation_source"], full.data["annotation_source"],
        "Observation IDs/clocks do not version installed-copy metadata"
    );
    fresh_page.packages[0].title = Some("Changed recorded purpose".into());
    let changed = preview(
        &owner.instance,
        fresh_request,
        &fresh_source,
        &fresh_page,
        &fresh_page.packages[0],
    )
    .unwrap();
    assert_eq!(
        changed.data["annotation_source"]["source_id"],
        full.data["annotation_source"]["source_id"]
    );
    assert_ne!(
        changed.data["annotation_source"]["source_version"],
        full.data["annotation_source"]["source_version"]
    );
    for field in ["version", "library", "name"] {
        let mut copy = page.packages[0].clone();
        match field {
            "version" => copy.version = "2".into(),
            "library" => copy.library_path = Some("/other".into()),
            _ => copy.name = "other".into(),
        };
        assert!(preview(&owner.instance, request.clone(), &source, &page, &copy).is_err());
    }
    page.packages[0].title = Some("中文🙂".repeat(10000));
    let short = preview(&owner.instance, request, &source, &page, &page.packages[0]).unwrap();
    assert!(short.truncated);
    assert!(short.text.len() <= 16384);
    assert!(!short.text.ends_with('\u{fffd}'));
    assert!(decode::<Inclusion>(json!({"kind":"metadata","install":true})).is_err());
}
#[test]
fn package_catalog_is_bounded_and_scoped_to_original_caller_and_observation() {
    let (_dir, owner, _, _) = fixture();
    let mut catalog = Catalog::default();
    let mut page = page();
    let mut args = arguments();
    for i in 0..102 {
        page.observation_id = format!("observation-{i}");
        args["observation_id"] = json!(page.observation_id);
        catalog.observe("principal", &args, &observed(&page));
    }
    assert_eq!(catalog.items.len(), 100);
    let request: ContextSearch =
        decode(json!({"window":"window","text":"研究","after":null,"limit":1})).unwrap();
    let first = catalog
        .search(&owner.instance, "principal", request.clone())
        .unwrap();
    assert_eq!(first.items.len(), 1);
    assert!(first.next.is_some());
    assert!(
        catalog
            .search(&owner.instance, "other", request.clone())
            .unwrap()
            .items
            .is_empty()
    );
    let mut next = request;
    next.after = first.next;
    assert!(
        catalog
            .search(&owner.instance, "other", next.clone())
            .is_err()
    );
    next.window = WindowId::new("other").unwrap();
    assert!(catalog.search(&owner.instance, "principal", next).is_err());
    let mut bad = observed(&page);
    bad.session_id = "replacement".into();
    let mut empty = Catalog::default();
    empty.observe("principal", &args, &bad);
    assert!(empty.items.is_empty());
    args["observation_id"] = Value::Null;
    empty.observe("principal", &args, &observed(&page));
    assert!(empty.items.is_empty());
}
#[tokio::test]
async fn original_package_preview_never_starts_runtime_or_refreshes_inventory() {
    let (_dir, owner, mut call, mut host) = fixture();
    call.binding.capability = environment_binding::key(SEARCH, 1);
    assert!(
        decode::<ContextPage>(owner.query(&call).await.unwrap())
            .unwrap()
            .items
            .is_empty()
    );
    call.binding.capability = environment_binding::key(PREVIEW, 1);
    call.arguments = json!({"reference":source().item(&owner.instance,&WindowId::new("window").unwrap()).unwrap().reference,"inclusion":{"kind":"metadata"},"max_bytes":16384});
    assert!(owner.query(&call).await.is_err());
    assert!(owner.runtime.lock().unwrap().is_none());
    assert!(host.try_recv().is_err());
}
