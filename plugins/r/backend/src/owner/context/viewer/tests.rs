use super::super::tests::fixture;
use super::*;

#[test]
fn viewer_inclusion_refuses_unknown_fields() {
    for kind in ["text", "metadata"] {
        assert!(decode::<Inclusion>(json!({"kind":kind})).is_ok());
        assert!(decode::<Inclusion>(json!({"kind":kind,"run":true})).is_err());
    }
}

fn record(owner: &InstanceRef, id: &str, count: u64) -> Value {
    json!({"operation":{"operation_id":id,"capability":{"id":"r.execute","version":2},"normalized_arguments":{"binding":{"provider":owner}}},
        "status":"failed","output":{"operation_id":id,"session_id":"original-native-session","outputs":(1..=count).map(|sequence| {
            let digest=format!("sha256:{}","c".repeat(64));
            json!({"native":{"operation_id":id,"sequence":sequence,"mime_type":"text/html","byte_size":100,"sha256":digest,"display_id":null},
                "reference":{"owner":owner,"resource":format!("html-{id}-{sequence}"),"digest":digest,"media_type":"text/html","bytes":100}})
        }).collect::<Vec<_>>()}})
}
fn operation(id: &str) -> OperationId {
    OperationId::new(id).unwrap()
}
fn row(id: &str, cursor: u64) -> Value {
    json!({"operation_id":id,"cursor":cursor,"capability":{"id":"r.execute","version":2},"status":"failed"})
}
fn reply(data: Value) -> Value {
    json!({"status":"ready","completeness":"complete","data":data})
}

#[test]
fn viewer_sources_require_original_terminal_records_and_matching_media_identities() {
    let (_directory, owner, _call, _host) = fixture();
    let original = record(&owner.instance, "original", 2);
    assert_eq!(
        outputs(&owner.instance, &operation("original"), &original)
            .unwrap()
            .0
            .len(),
        2
    );
    for change in [
        "owner",
        "operation",
        "digest",
        "size",
        "sequence",
        "mime",
        "session",
    ] {
        let mut changed = original.clone();
        match change {
            "owner" => {
                changed["output"]["outputs"][0]["reference"]["owner"]["instance"] = json!("foreign")
            }
            "operation" => {
                changed["output"]["outputs"][0]["native"]["operation_id"] = json!("another")
            }
            "digest" => changed["output"]["outputs"][0]["native"]["sha256"] = json!("changed"),
            "size" => changed["output"]["outputs"][0]["native"]["byte_size"] = json!(5),
            "sequence" => changed["output"]["outputs"][1]["native"]["sequence"] = json!(1),
            "mime" => changed["output"]["outputs"][0]["native"]["mime_type"] = json!("image/png"),
            _ => changed["output"]["session_id"] = Value::Null,
        }
        assert!(
            outputs(&owner.instance, &operation("original"), &changed).is_err(),
            "{change}"
        );
    }
    for status in ["running", "accepted"] {
        let mut live = original.clone();
        live["status"] = json!(status);
        assert!(
            outputs(&owner.instance, &operation("original"), &live)
                .unwrap()
                .0
                .is_empty()
        );
    }
    let mut foreign = original.clone();
    foreign["operation"]["normalized_arguments"]["binding"]["provider"]["instance"] =
        json!("foreign");
    assert!(
        outputs(&owner.instance, &operation("original"), &foreign)
            .unwrap()
            .0
            .is_empty()
    );
    let mut cancelled = original;
    cancelled["status"] = json!("cancelled");
    cancelled["output"] = json!({"operation_id":"original","started":false});
    assert!(
        outputs(&owner.instance, &operation("original"), &cancelled)
            .unwrap()
            .0
            .is_empty()
    );
}

#[tokio::test]
async fn viewer_search_pages_within_one_operation_without_skipping_its_outputs() {
    let (_directory, owner, mut call, mut host) = fixture();
    call.binding.capability = environment_binding::key(SEARCH, 1);
    call.arguments["limit"] = json!(2);
    let original = record(&owner.instance, "original", 3);
    let (result, ()) = tokio::join!(owner.query(&call), async {
        let read = host.recv().await.unwrap();
        assert_eq!(read.capability.id.as_str(), "operation.list_recent");
        assert_eq!(read.arguments, json!({"limit":5,"before_cursor":null}));
        read.reply
            .send(Ok(reply(
                json!({"operations":[row("original",10)],"next_cursor":null}),
            )))
            .unwrap();
        let read = host.recv().await.unwrap();
        assert_eq!(read.arguments, json!({"operation_id":"original"}));
        read.reply
            .send(Ok(reply(json!({"record":original}))))
            .unwrap();
    });
    let first: ContextPage = decode(result.unwrap()).unwrap();
    assert_eq!(first.items.len(), 2);
    call.arguments["after"] = first.next.unwrap();
    assert_eq!(call.arguments["after"]["before"], 11);
    let (result, ()) = tokio::join!(owner.query(&call), async {
        let read = host.recv().await.unwrap();
        assert_eq!(read.arguments["before_cursor"], 11);
        read.reply
            .send(Ok(reply(
                json!({"operations":[row("original",10)],"next_cursor":null}),
            )))
            .unwrap();
        let read = host.recv().await.unwrap();
        read.reply
            .send(Ok(reply(json!({"record":original}))))
            .unwrap();
    });
    let second: ContextPage = decode(result.unwrap()).unwrap();
    assert_eq!(second.items.len(), 1);
    assert_eq!(second.items[0].reference.selector["sequence"], 3);
    assert!(second.next.is_none());
    assert!(owner.runtime.lock().unwrap().is_none());
}
#[tokio::test]
async fn viewer_metadata_revalidates_original_record_after_reopen_without_r_or_resource_reads() {
    let (_directory, owner, mut call, mut host) = fixture();
    let original = record(&owner.instance, "original", 1);
    let source = outputs(&owner.instance, &operation("original"), &original)
        .unwrap()
        .0
        .remove(0);
    let reference = source
        .item(&owner.instance, &WindowId::new("window").unwrap(), "failed")
        .unwrap()
        .reference;
    call.binding.capability = environment_binding::key(PREVIEW, 1);
    call.arguments =
        json!({"reference":reference,"inclusion":{"kind":"metadata"},"max_bytes":16384});
    let (result, ()) = tokio::join!(owner.query(&call), async {
        let read = host.recv().await.unwrap();
        assert_eq!(read.capability.id.as_str(), "operation.get");
        read.reply
            .send(Ok(reply(json!({"record":original}))))
            .unwrap();
    });
    let preview: ContextPreview = decode(result.unwrap()).unwrap();
    assert_eq!(preview.item.reference, reference);
    assert!(!preview.truncated);
    assert!(preview.resources.is_empty());
    assert!(preview.text.contains("failed"));
    assert!(preview.text.contains("not included"));
    assert_eq!(
        preview.data["annotation_source"]["source_id"],
        format!("output:{}:{}", source.operation, source.sequence)
    );
    assert_eq!(
        preview.data["annotation_source"]["source_version"],
        source.reference.digest.as_str()
    );

    assert!(owner.runtime.lock().unwrap().is_none());
    assert!(owner.launch_attempt.lock().unwrap().is_none());
    assert!(host.try_recv().is_err());
    call.arguments["reference"]["selector"]["session"] = json!("replacement");
    let (result, ()) = tokio::join!(owner.query(&call), async {
        let read = host.recv().await.unwrap();
        read.reply
            .send(Ok(reply(json!({"record":original}))))
            .unwrap();
    });
    assert!(result.unwrap_err().contains("original committed output"));
}
#[tokio::test]
async fn viewer_refuses_missing_authority_and_foreign_cursors_before_host_reads() {
    let (_directory, mut owner, mut call, mut host) = fixture();
    call.binding.capability = environment_binding::key(SEARCH, 1);
    owner.context_grants.list = false;
    assert!(owner.query(&call).await.is_err());
    owner.context_grants.list = true;
    call.scopes.remove("operation.read");
    assert!(owner.query(&call).await.is_err());
    call.scopes.insert("operation.read".into());
    call.arguments["after"] = json!(Cursor {
        owner: owner.instance.clone(),
        window: WindowId::new("other").unwrap(),
        text: "".into(),
        before: Some(10),
        within: None,
        contribution: "viewer".into(),
    });
    assert!(owner.query(&call).await.is_err());
    assert!(host.try_recv().is_err());
}
#[test]
fn viewer_html_is_inert_utf8_with_explicit_byte_truncation() {
    let html = "<h1>研究🙂</h1>";
    for end in 0..html.len() {
        let prefix = utf8_prefix(&html.as_bytes()[..end], false).unwrap();
        assert!(html.starts_with(&prefix));
        assert!(prefix.len() <= end);
    }
    assert_eq!(utf8_prefix(html.as_bytes(), true).unwrap(), html);
    assert!(utf8_prefix(&[0xff], false).is_err());
    assert!(utf8_prefix(&[0xe7], true).is_err());
    let (text, clipped) = bounded_text("🙂🙂", 5);
    assert_eq!(text, "🙂");
    assert!(clipped);
}

#[tokio::test]
async fn viewer_text_uses_the_original_scoped_resource_channel_and_checks_full_digest() {
    use rho_plugin_sdk::{read_resource_header, write_resource_header};
    use tokio::{io::AsyncWriteExt, net::UnixListener};
    for corrupt in [false, true] {
        let (directory, owner, mut call, mut host) = fixture();
        let listener =
            UnixListener::bind(directory.path().canonicalize().unwrap().join("absent.sock"))
                .unwrap();
        let html = "<h1>研究🙂</h1>".as_bytes();
        let digest = format!("sha256:{:x}", Sha256::digest(html));
        let mut original = record(&owner.instance, "original", 1);
        original["output"]["outputs"][0]["native"]["byte_size"] = json!(html.len());
        original["output"]["outputs"][0]["native"]["sha256"] = json!(digest);
        original["output"]["outputs"][0]["reference"]["bytes"] = json!(html.len());
        original["output"]["outputs"][0]["reference"]["digest"] = json!(digest);
        let source = outputs(&owner.instance, &operation("original"), &original)
            .unwrap()
            .0
            .remove(0);
        let reference = source
            .item(&owner.instance, &WindowId::new("window").unwrap(), "failed")
            .unwrap()
            .reference;
        call.binding.capability = environment_binding::key(PREVIEW, 1);
        call.arguments =
            json!({"reference":reference,"inclusion":{"kind":"text"},"max_bytes":16384});
        let query = owner.query(&call);
        let peer = async {
            let get = host.recv().await.unwrap();
            assert_eq!(get.capability.id.as_str(), "operation.get");
            get.reply
                .send(Ok(reply(json!({"record":original}))))
                .unwrap();
            let (mut stream, _) = listener.accept().await.unwrap();
            let request: ResourceTransferRequest = read_resource_header(&mut stream).await.unwrap();
            assert_eq!(request.parent_request, call.request);
            let ResourceTransfer::Read(read) = request.transfer else {
                panic!("Only an original resource read is allowed");
            };
            assert_eq!(read.reference, source.reference);
            assert_eq!(read.offset, 0);
            assert_eq!(read.limit, 16384);
            write_resource_header(
                &mut stream,
                &ResourceTransferResponse::Data {
                    reference: read.reference,
                    offset: 0,
                    bytes: html.len() as u32,
                    next: None,
                },
            )
            .await
            .unwrap();
            let mut bytes = html.to_vec();
            if corrupt {
                bytes[0] = b'X';
            }
            stream.write_all(&bytes).await.unwrap();
            stream.shutdown().await.unwrap();
        };
        let (result, ()) =
            tokio::time::timeout(Duration::from_secs(3), async { tokio::join!(query, peer) })
                .await
                .unwrap();
        if corrupt {
            assert!(result.unwrap_err().contains("digest changed"));
        } else {
            let preview: ContextPreview = decode(result.unwrap()).unwrap();
            assert_eq!(preview.text.as_bytes(), html);
            assert!(!preview.truncated);
        }
        assert!(owner.runtime.lock().unwrap().is_none());
    }
}

fn plot_record(owner: &InstanceRef, mime: &str, count: u64) -> Value {
    let mut value = record(owner, "original", count);
    for output in value["output"]["outputs"].as_array_mut().unwrap() {
        output["native"]["mime_type"] = json!(mime);
        output["reference"]["media_type"] = json!(mime);
    }
    value
}
#[tokio::test]
async fn plots_preview_pair_checks_originals_and_never_starts_r() {
    let mut image_identity = None;
    for kind in ["images", "metadata"] {
        let (_directory, owner, mut call, mut host) = fixture();
        let original = plot_record(&owner.instance, "image/png", 2);
        let sources = outputs_for(
            &owner.instance,
            &operation("original"),
            &original,
            plots::TYPES,
        )
        .unwrap()
        .0;
        let reference = plots::item(&owner.instance, &WindowId::new("window").unwrap(), &sources)
            .unwrap()
            .reference;
        call.binding.capability = environment_binding::key(PLOT_PREVIEW, 1);
        call.arguments = json!({"reference":reference,"inclusion":{"kind":kind},"max_bytes":16384});
        let (result, ()) = tokio::join!(owner.query(&call), async {
            for _ in 0..2 {
                let read = host.recv().await.unwrap();
                assert_eq!(read.capability.id.as_str(), "operation.get");
                read.reply
                    .send(Ok(reply(json!({"record":original}))))
                    .unwrap();
            }
        });
        let preview: ContextPreview = decode(result.unwrap()).unwrap();
        assert_eq!(
            preview.resources.len(),
            if kind == "images" { 2 } else { 0 }
        );
        assert_eq!(preview.data["artifacts"][0]["operation"], "original");
        let identity = preview.data["annotation_source"].clone();
        assert!(identity["source_id"].as_str().unwrap().starts_with("plots:sha256:"));
        if let Some(original) = &image_identity {
            assert_eq!(&identity, original, "Metadata and images refer to the same ordered original plots");
        } else { image_identity = Some(identity); }
        assert_eq!(preview.data["artifacts"][0]["resource"], json!(sources[0].reference));
        assert_eq!(preview.item.reference, reference);
        assert!(preview.text.contains("Producing run: original"));
        assert!(preview.text.contains("failed"));
        assert!(!preview.truncated);
        assert!(owner.runtime.lock().unwrap().is_none());
        assert!(owner.launch_attempt.lock().unwrap().is_none());
        assert!(host.try_recv().is_err());
    }
}
#[tokio::test]
async fn plots_reject_changed_source_duplicate_missing_resource_grant_and_svg_images() {
    for fault in [
        "session",
        "digest",
        "owner",
        "duplicate",
        "scope",
        "grant",
        "svg",
    ] {
        let (_directory, mut owner, mut call, mut host) = fixture();
        let original = plot_record(
            &owner.instance,
            if fault == "svg" {
                "image/svg+xml"
            } else {
                "image/png"
            },
            1,
        );
        let mut sources = outputs_for(
            &owner.instance,
            &operation("original"),
            &original,
            plots::TYPES,
        )
        .unwrap()
        .0;
        match fault {
            "session" => sources[0].session = "replacement".into(),
            "digest" => {
                sources[0].reference.digest =
                    decode(json!(format!("sha256:{}", "d".repeat(64)))).unwrap()
            }
            "owner" => sources[0].reference.owner.instance = decode(json!("foreign")).unwrap(),
            "duplicate" => sources.push(sources[0].clone()),
            "scope" => {
                call.scopes.remove("resources.read");
            }
            "grant" => owner.context_grants.resources = false,
            _ => {}
        }
        let reference = plots::item(&owner.instance, &WindowId::new("window").unwrap(), &sources)
            .unwrap()
            .reference;
        call.binding.capability = environment_binding::key(PLOT_PREVIEW, 1);
        call.arguments =
            json!({"reference":reference,"inclusion":{"kind":"images"},"max_bytes":16384});
        let (result, ()) = tokio::join!(owner.query(&call), async {
            let read = host.recv().await.unwrap();
            read.reply
                .send(Ok(reply(json!({"record":original}))))
                .unwrap();
        });
        assert!(result.is_err(), "{fault}");
        assert!(owner.runtime.lock().unwrap().is_none());
        assert!(host.try_recv().is_err());
    }
}
#[tokio::test]
async fn plots_search_pages_originals_and_refuses_viewer_cursor() {
    let (_directory, owner, mut call, mut host) = fixture();
    call.binding.capability = environment_binding::key(PLOT_SEARCH, 1);
    call.arguments["limit"] = json!(1);
    let original = plot_record(&owner.instance, "image/png", 2);
    let (result, ()) = tokio::join!(owner.query(&call), async {
        host.recv()
            .await
            .unwrap()
            .reply
            .send(Ok(reply(
                json!({"operations":[row("original",10)],"next_cursor":null}),
            )))
            .unwrap();
        host.recv()
            .await
            .unwrap()
            .reply
            .send(Ok(reply(json!({"record":original}))))
            .unwrap();
    });
    let page: ContextPage = decode(result.unwrap()).unwrap();
    assert_eq!(page.items.len(), 1);
    assert_eq!(page.items[0].reference.contribution.as_str(), "plots");
    call.arguments["after"] = page.next.unwrap();
    assert_eq!(call.arguments["after"]["contribution"], "plots");
    call.arguments["after"]["contribution"] = json!("viewer");
    assert!(owner.query(&call).await.is_err());
    assert!(host.try_recv().is_err());
}
