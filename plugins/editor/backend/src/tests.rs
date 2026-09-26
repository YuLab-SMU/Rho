use crate::context::{Job, Step};
use base64::{Engine, engine::general_purpose::STANDARD};
use rho_plugin_sdk::protocol::*;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
fn digest(bytes: &[u8]) -> ContentDigest {
    ContentDigest::new(format!("sha256:{:x}", Sha256::digest(bytes))).unwrap()
}
fn instance() -> PluginInstance {
    serde_json::from_value(json!({"identity":{"plugin":"org.rho.editor","instance":"editor-one","revision":format!("sha256:{}","a".repeat(64)),"artifact":format!("sha256:{}","b".repeat(64))},"project":"project","principal":"principal","alias":"editor","configuration":{},"state":"active","diagnostic":null})).unwrap()
}
fn call(id: &str, args: Value) -> PluginCall {
    let i = instance();
    PluginCall {
        request: RequestId::new("query").unwrap(),
        binding: ProviderBinding {
            capability: CapabilityKey {
                id: ContributionId::new(id).unwrap(),
                version: 1,
            },
            provider: i.identity,
            project: i.project,
            target: None,
        },
        principal: i.principal,
        scopes: ["documents.read".into()].into(),
        arguments: args,
        preconditions: Value::Null,
        owner_context: Value::Null,
        operation_id: None,
    }
}
fn observation(data: Value) -> Value {
    json!({"status":"ready","completeness":"complete","data":data})
}
fn read(step: Step, cap: &str) -> Value {
    match step {
        Step::Read {
            capability,
            arguments,
        } => {
            assert_eq!(capability, cap);
            arguments
        }
        _ => panic!("expected read"),
    }
}
fn complete(step: Step) -> (Value, ObservationCompleteness) {
    match step {
        Step::Complete { data, completeness } => (data, completeness),
        _ => panic!("expected complete"),
    }
}
fn capture(raw: &str, anchor: u32, head: u32) -> (DocumentDraft, Vec<u8>) {
    let document = json!({"raw":raw,"path":"研究.R","version":"document-version","anchor":anchor,"head":head,"readonly":null});
    let bytes = serde_json::to_vec(
        &json!({"schema":1,"document":document,"other_owner_fields":{"never_return":"secret"}}),
    )
    .unwrap();
    let draft = DocumentDraft {
        draft: DraftId::new("draft-a").unwrap(),
        project: instance().project,
        principal: instance().principal,
        window: WindowId::new("window").unwrap(),
        source: DraftSource {
            revision: instance().identity.revision,
            contribution: ContributionId::new("editor").unwrap(),
        },
        version: 2,
        content: DraftContent {
            digest: digest(&bytes),
            bytes: bytes.len() as u32,
            chunks: bytes
                .chunks(65536)
                .map(|chunk| DraftChunkReference {
                    digest: digest(chunk),
                    bytes: chunk.len() as u32,
                })
                .collect(),
        },
        metadata: json!({"encoding":"org.rho.editor.document.v1","path":"研究.R","name":"研究.R","document_version":"document-version","selection":{"anchor":anchor,"head":head},"read_only":false}),
        discarded: false,
    };
    (draft, bytes)
}
fn summary(draft: &DocumentDraft) -> DocumentDraftSummary {
    DocumentDraftSummary {
        draft: draft.draft.clone(),
        source: draft.source.clone(),
        version: draft.version,
        digest: draft.content.digest.clone(),
        bytes: draft.content.bytes,
        metadata: draft.metadata.clone(),
    }
}
fn preview_call(draft: &DocumentDraft, kind: &str, max_bytes: u32) -> PluginCall {
    call(
        "editor.context.preview",
        json!({"reference":{"provider":instance().identity,"contribution":"documents","window":draft.window,
    "selector":{"draft":draft.draft,"version":draft.version,"digest":draft.content.digest}},"inclusion":{"kind":kind},"max_bytes":max_bytes}),
    )
}
fn chunk(draft: &DocumentDraft, bytes: &[u8], offset: usize) -> Value {
    let end = (offset + 65536).min(bytes.len());
    observation(
        json!({"draft":draft.draft,"version":draft.version,"digest":draft.content.digest,"offset":offset,"base64":STANDARD.encode(&bytes[offset..end]),"next":if end<bytes.len(){Some(end)}else{None}}),
    )
}
fn preview(
    draft: &DocumentDraft,
    bytes: &[u8],
    kind: &str,
    max: u32,
) -> Result<Value, crate::context::Failure> {
    let (mut job, step) = Job::start(&instance(), &preview_call(draft, kind, max))?;
    read(step, "documents.inspect");
    let mut step = job.resume(observation(json!(draft)))?;
    loop {
        match step {
            Step::Read { arguments, .. } => {
                step = job.resume(chunk(
                    draft,
                    bytes,
                    arguments["offset"].as_u64().unwrap() as usize,
                ))?
            }
            Step::Complete { data, .. } => return Ok(data),
        }
    }
}
#[test]
fn search_filters_exact_revision_metadata_with_bounded_owner_cursor() {
    let (draft, _) = capture("unsaved", 0, 0);
    let args = json!({"window":"window","text":"研究","after":null,"limit":1});
    let (mut job, step) =
        Job::start(&instance(), &call("editor.context.search", args.clone())).unwrap();
    let read_args = read(step, "documents.list");
    assert_eq!(read_args["source"], json!(draft.source));
    assert_eq!(read_args["limit"], 1);
    let (page, status) = complete(
        job.resume(observation(
            json!({"drafts":[summary(&draft)],"next":draft.draft}),
        ))
        .unwrap(),
    );
    assert_eq!(status, ObservationCompleteness::Complete);
    assert_eq!(page["items"][0]["title"], "研究.R");
    assert!(!page.to_string().contains("unsaved"));
    let mut continued = args.clone();
    continued["after"] = page["next"].clone();
    let (_, step) = Job::start(
        &instance(),
        &call("editor.context.search", continued.clone()),
    )
    .unwrap();
    assert_eq!(read(step, "documents.list")["after"], "draft-a");
    continued["text"] = json!("different");
    assert!(Job::start(&instance(), &call("editor.context.search", continued)).is_err());
    let mut absent = args;
    absent["text"] = json!("absent");
    let (mut job, _) = Job::start(&instance(), &call("editor.context.search", absent)).unwrap();
    let (page, _) = complete(
        job.resume(observation(json!({"drafts":[summary(&draft)],"next":null})))
            .unwrap(),
    );
    assert_eq!(page["items"], json!([]));
}
#[test]
fn search_labels_bad_metadata_and_rejects_foreign_or_incomplete_observations() {
    let (mut draft, _) = capture("text", 0, 0);
    let request = call(
        "editor.context.search",
        json!({"window":"window","text":"","after":null,"limit":20}),
    );
    draft.metadata["encoding"] = json!("unknown");
    let (mut job, _) = Job::start(&instance(), &request).unwrap();
    let (page, status) = complete(
        job.resume(observation(json!({"drafts":[summary(&draft)],"next":null})))
            .unwrap(),
    );
    assert_eq!(status, ObservationCompleteness::Partial);
    assert_eq!(page["items"], json!([]));
    assert_eq!(page["notices"].as_array().unwrap().len(), 1);
    draft.source.revision = RevisionId::new(format!("sha256:{}", "c".repeat(64))).unwrap();
    let (mut job, _) = Job::start(&instance(), &request).unwrap();
    assert!(
        job.resume(observation(json!({"drafts":[summary(&draft)],"next":null})))
            .is_err()
    );
    let (mut job, _) = Job::start(&instance(), &request).unwrap();
    assert!(
        job.resume(json!({"status":"busy","completeness":"cached","data":{}}))
            .is_err()
    );
}
#[test]
fn preview_verifies_all_pages_and_captured_unicode_selection_without_leaking_other_payloads() {
    let raw = format!("甲\r\n🙂选{}", "later\n".repeat(20000));
    let (draft, bytes) = capture(&raw, 2, 5);
    let selected = preview(&draft, &bytes, "selection", 65536).unwrap();
    assert_eq!(selected["text"], "🙂选");
    assert_eq!(selected["truncated"], false);
    assert_eq!(selected["item"]["reference"]["selector"]["version"], 2);
    assert!(!selected.to_string().contains("secret"));
    let truncated = preview(&draft, &bytes, "document", 6).unwrap();
    assert_eq!(truncated["text"], "甲\n");
    assert_eq!(truncated["truncated"], true);
    let (draft, bytes) = capture("🙂", 1, 2);
    assert!(preview(&draft, &bytes, "selection", 20).is_err());
    assert_eq!(
        preview(&draft, &bytes, "document", 20).unwrap()["text"],
        "🙂"
    );
    let (draft, bytes) = capture("", 0, 0);
    assert_eq!(preview(&draft, &bytes, "selection", 1).unwrap()["text"], "");
}
#[test]
fn preview_refuses_changed_scope_version_discard_and_corrupt_or_incomplete_bytes() {
    let (draft, bytes) = capture("original", 0, 4);
    for field in ["provider", "contribution", "selector"] {
        let mut call = preview_call(&draft, "document", 20);
        match field {
            "provider" => call.arguments["reference"]["provider"]["instance"] = json!("another"),
            "contribution" => call.arguments["reference"]["contribution"] = json!("other"),
            _ => call.arguments["reference"]["selector"]["version"] = json!(0),
        };
        assert!(Job::start(&instance(), &call).is_err());
    }
    for change in [
        "version",
        "digest",
        "principal",
        "window",
        "source",
        "discarded",
    ] {
        let (mut job, _) = Job::start(&instance(), &preview_call(&draft, "document", 20)).unwrap();
        let mut observed = json!(draft);
        match change {
            "version" => observed["version"] = json!(3),
            "digest" => observed["content"]["digest"] = json!(digest(b"other")),
            "source" => observed["source"]["contribution"] = json!("other"),
            "discarded" => observed["discarded"] = json!(true),
            key => observed[key] = json!("other"),
        };
        assert!(job.resume(observation(observed)).is_err(), "{change}");
    }
    for change in ["version", "digest", "offset", "base64", "next"] {
        let (mut job, _) = Job::start(&instance(), &preview_call(&draft, "document", 20)).unwrap();
        job.resume(observation(json!(draft))).unwrap();
        let mut page = chunk(&draft, &bytes, 0);
        match change {
            "version" => page["data"]["version"] = json!(3),
            "digest" => page["data"]["digest"] = json!(digest(b"other")),
            "offset" => page["data"]["offset"] = json!(1),
            "base64" => {
                let mut corrupted = bytes.clone();
                corrupted[0] = b'!';
                page["data"]["base64"] = json!(STANDARD.encode(corrupted));
            }
            "next" => page["data"]["next"] = json!(0),
            _ => unreachable!(),
        };
        assert!(job.resume(page).is_err(), "{change}");
    }
    for path in ["../outside.R", "/absolute.R", ".GIT/config", "a//b.R"] {
        let mut invalid = draft.clone();
        invalid.metadata["path"] = json!(path);
        assert!(preview(&invalid, &bytes, "document", 20).is_err());
    }
    let mut named = draft.clone();
    named.metadata["name"] = json!("another.R");
    assert!(preview(&named, &bytes, "document", 20).is_err());
    let mut mismatch = draft.clone();
    mismatch.metadata["selection"]["anchor"] = json!(1);
    assert!(preview(&mismatch, &bytes, "selection", 20).is_err());
}
