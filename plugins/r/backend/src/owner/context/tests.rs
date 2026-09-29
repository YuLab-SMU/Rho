use super::*;
use tokio::sync::mpsc;

pub(super) fn fixture() -> (
    tempfile::TempDir,
    Owner,
    PluginCall,
    mpsc::Receiver<crate::host_calls::HostRequest>,
) {
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path().canonicalize().unwrap();
    let provider: InstanceRef = decode(json!({"plugin":"org.rho.r","instance":"r-context","revision":format!("sha256:{}","a".repeat(64)),"artifact":format!("sha256:{}","b".repeat(64))})).unwrap();
    let (tx, rx) = mpsc::channel(32);
    let grants = [
        ("operation.get", "operation.read"),
        ("operation.list_recent", "operation.read"),
        ("resources.read", "resources.read"),
    ]
    .map(|(id, scope)| CapabilityRequirement {
        capability: environment_binding::key(id, 1),
        scopes: [scope.into()].into(),
    });
    let owner = Owner::new(
        json!({}),
        BackendEnvironment {
            project_root: root.to_str().unwrap().into(),
            data_root: root.to_str().unwrap().into(),
        },
        provider.clone(),
        ResourceClient::new(ResourceChannel {
            version: 1,
            socket: root.join("absent.sock").to_str().unwrap().into(),
            token: "a".repeat(64),
        })
        .unwrap(),
        HostCalls(tx),
        false,
        &grants,
    )
    .unwrap();
    let call = PluginCall {
        request: RequestId::new("context-query").unwrap(),
        binding: ProviderBinding {
            provider,
            capability: environment_binding::key(HELP_SEARCH, 1),
            project: ProjectId::new("project").unwrap(),
            target: None,
        },
        principal: PrincipalId::new("principal").unwrap(),
        scopes: ["workspace.read", "operation.read", "resources.read"]
            .map(String::from)
            .into(),
        arguments: json!({"window":"window","text":"","after":null,"limit":20}),
        operation_id: None,
        owner_context: Value::Null,
        preconditions: Value::Null,
    };
    (directory, owner, call, rx)
}
fn topic(topic: &str, text: &str) -> (ReadPackageHelpArguments, RInspection<Value>) {
    let files = (1..=4)
        .map(|n| PackageFileIdentity {
            path: format!("file-{n}"),
            digest: format!("digest-{n}"),
        })
        .collect::<Vec<_>>();
    let args = ReadPackageHelpArguments {
        expected_session: "native".into(),
        observation_id: "observed".into(),
        package: "base".into(),
        library_path: "/library".into(),
        topic: topic.into(),
        expected_index_files: files.clone(),
        expected_help_files: None,
        offset_utf8: 0,
        limit_bytes: 16384,
        format: HelpFormat::Text,
    };
    let page = PackageHelpPage {
        observation_id: args.observation_id.clone(),
        package: args.package.clone(),
        library_path: args.library_path.clone(),
        topic: topic.into(),
        found: true,
        text: text.into(),
        offset_utf8: 0,
        next_offset_utf8: None,
        total_bytes: text.len() as u64,
        complete: true,
        help_files: files,
        format: HelpFormat::Text,
        version: None,
    };
    let observation = RInspection {
        session_id: "native".into(),
        status: RInspectionStatus::Ready,
        source: "R".into(),
        observed_at_ms: 1,
        completeness: NativeCompleteness::Complete,
        data: Some(json!(page)),
        notices: vec![],
        diagnostic: None,
    };
    (args, observation)
}
fn request(call: &PluginCall) -> ContextSearch {
    decode(call.arguments.clone()).unwrap()
}

#[tokio::test]
async fn help_search_and_stale_preview_do_not_start_an_unstarted_owner() {
    let (_directory, owner, mut call, mut host) = fixture();
    let empty: ContextPage = decode(owner.query(&call).await.unwrap()).unwrap();
    assert!(empty.items.is_empty());
    let (args, observation) = topic("研究🙂", "Original topic");
    owner
        .help_context
        .lock()
        .unwrap()
        .observe(&json!(args), &observation);
    let page: ContextPage = decode(owner.query(&call).await.unwrap()).unwrap();
    assert_eq!(page.items[0].title, "base::研究🙂");
    call.binding.capability = environment_binding::key(HELP_PREVIEW, 1);
    call.arguments =
        json!({"reference":page.items[0].reference,"inclusion":{"kind":"text"},"max_bytes":16384});
    assert!(
        owner
            .query(&call)
            .await
            .unwrap_err()
            .contains("Create a session")
    );
    assert!(owner.runtime.lock().unwrap().is_none());
    assert!(owner.launch_attempt.lock().unwrap().is_none());
    assert!(host.try_recv().is_err());
}
#[test]
fn help_catalog_is_bounded_uses_exact_copy_and_scopes_its_pagination() {
    let (_directory, owner, call, _host) = fixture();
    let mut catalog = HelpCatalog::default();
    for n in 0..105 {
        let (args, observation) = topic(&format!("topic-{n}"), "text");
        catalog.observe(&json!(args), &observation);
    }
    assert_eq!(catalog.topics.len(), 100);
    assert_eq!(catalog.order.len(), 100);
    assert!(catalog.topics.values().all(|source| {
        !["topic-0", "topic-1", "topic-2", "topic-3", "topic-4"].contains(&source.topic.as_str())
    }));
    let mut search = request(&call);
    search.limit = 1;
    let first = catalog.search(&owner.instance, search.clone()).unwrap();
    search.after = first.next;
    let second = catalog.search(&owner.instance, search.clone()).unwrap();
    assert_ne!(first.items[0].reference, second.items[0].reference);
    search.text = "different".into();
    assert!(catalog.search(&owner.instance, search.clone()).is_err());
    search.text.clear();
    search.window = WindowId::new("other").unwrap();
    assert!(catalog.search(&owner.instance, search.clone()).is_err());
    search.window = WindowId::new("window").unwrap();
    let mut other = owner.instance.clone();
    other.instance = PluginInstanceId::new("other").unwrap();
    assert!(catalog.search(&other, search).is_err());
}
#[test]
fn inconsistent_unavailable_and_changed_help_observations_are_not_search_results() {
    let mut catalog = HelpCatalog::default();
    let (args, original) = topic("sum", "text");
    for change in ["session", "partial", "busy", "copy", "missing"] {
        let mut observation = original.clone();
        match change {
            "session" => observation.session_id = "other".into(),
            "partial" => observation.completeness = NativeCompleteness::Partial,
            "busy" => observation.status = RInspectionStatus::Busy,
            "copy" => observation.data.as_mut().unwrap()["library_path"] = json!("/other"),
            _ => observation.data.as_mut().unwrap()["found"] = json!(false),
        }
        catalog.observe(&json!(args), &observation);
    }
    assert!(catalog.topics.is_empty());
    catalog.observe(&json!(args), &original);
    assert_eq!(catalog.topics.len(), 1);
    let source = catalog.topics.values().next().unwrap();
    assert!(same_files(&source.index_files, &args.expected_index_files));
    assert!(source.arguments(65536).expected_help_files.is_some());
    assert_eq!(source.arguments(65536).limit_bytes, 32768);
    // Native completeness is partial for a valid paged Help read. Its identity
    // can be listed; a later preview must still qualify complete selected text.
    let mut partial = original.clone();
    partial.completeness = NativeCompleteness::Partial;
    let page = partial.data.as_mut().unwrap();
    page["complete"] = json!(false);
    page["total_bytes"] = json!(100);
    page["next_offset_utf8"] = json!(4);
    let mut paged = HelpCatalog::default();
    paged.observe(&json!(args), &partial);
    assert_eq!(paged.topics.len(), 1);
}
#[test]
fn help_preview_retains_original_identity_and_marks_incomplete_excerpts() {
    let (_directory, owner, call, _host) = fixture();
    let mut catalog = HelpCatalog::default();
    let text = "研究🙂\n".repeat(13);
    let (args, observation) = topic("sum", &text);
    catalog.observe(&json!(args), &observation);
    let source = catalog.topics.values().next().unwrap();
    let reference = source
        .item(&owner.instance, &request(&call).window)
        .unwrap()
        .reference;
    let request = PreviewContext {
        reference,
        inclusion: json!({"kind":"excerpt"}),
        max_bytes: 16384,
    };
    let page: PackageHelpPage = decode(observation.data.unwrap()).unwrap();
    let preview = help_preview(
        &owner.instance,
        request.clone(),
        source,
        HelpInclusion::Excerpt {},
        page.clone(),
    )
    .unwrap();
    assert_eq!(preview.text, "研究🙂\n".repeat(12));
    assert!(!preview.truncated);
    assert_eq!(preview.item.reference, request.reference);
    assert!(preview.data["annotation_source"]["source_id"].as_str().unwrap().starts_with("help:"));
    assert_eq!(preview.data["annotation_source"]["source_version"], format!("sha256:{:x}", Sha256::digest(serde_json::to_vec(&source.help_files).unwrap())));
    let mut reobserved = source.clone();
    reobserved.observation = "new-observation-same-content".into();
    let fresh_request = PreviewContext { reference: reobserved.item(&owner.instance, &request.reference.window).unwrap().reference, ..request.clone() };
    let mut fresh_page = page.clone();
    fresh_page.observation_id = reobserved.observation.clone();
    let fresh = help_preview(&owner.instance, fresh_request, &reobserved, HelpInclusion::Text {}, fresh_page).unwrap();
    assert_eq!(preview.data["annotation_source"], fresh.data["annotation_source"], "a new package observation is not a new content version");

    let mut partial = page.clone();
    partial.text = "研究".into();
    partial.complete = false;
    partial.next_offset_utf8 = Some(partial.text.len() as u64);
    assert!(
        help_preview(
            &owner.instance,
            request.clone(),
            source,
            HelpInclusion::Excerpt {},
            partial
        )
        .unwrap()
        .truncated
    );
    let mut changed = page;
    changed.help_files[0].digest = "different".into();
    assert!(
        help_preview(
            &owner.instance,
            request,
            source,
            HelpInclusion::Text {},
            changed
        )
        .is_err()
    );
}
#[tokio::test]
async fn context_scope_identity_and_inclusion_are_checked_before_native_reads() {
    let (_directory, owner, original, mut host) = fixture();
    for change in [
        "scope",
        "provider",
        "target",
        "precondition",
        "operation",
        "version",
    ] {
        let mut call = original.clone();
        match change {
            "scope" => {
                call.scopes.remove("workspace.read");
            }
            "provider" => call.binding.provider.instance = PluginInstanceId::new("other").unwrap(),
            "target" => call.binding.target = Some("foreign".into()),
            "precondition" => call.preconditions = json!({}),
            "operation" => call.operation_id = Some("write".into()),
            _ => call.binding.capability.version = 2,
        }
        assert!(owner.query(&call).await.is_err());
    }
    for kind in ["text", "excerpt"] {
        assert!(decode::<HelpInclusion>(json!({"kind":kind})).is_ok());
        assert!(decode::<HelpInclusion>(json!({"kind":kind,"run":true})).is_err());
    }
    assert!(host.try_recv().is_err());
    assert!(owner.runtime.lock().unwrap().is_none());
}
