use super::*;
use tokio::sync::mpsc;

fn id(value: &str) -> OperationId {
    OperationId::new(value).unwrap()
}
fn fixture() -> (
    tempfile::TempDir,
    Owner,
    PluginCall,
    mpsc::Receiver<crate::host_calls::HostRequest>,
) {
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path().canonicalize().unwrap();
    let provider: InstanceRef = decode(json!({"plugin":"org.rho.r","instance":"r-current","revision":format!("sha256:{}","a".repeat(64)),"artifact":format!("sha256:{}","b".repeat(64))})).unwrap();
    let (tx, rx) = mpsc::channel(32);
    let grants = [
        ("operation.get", vec!["operation.read"]),
        ("operation.list_recent", vec!["operation.read"]),
        ("resources.read", vec!["resources.read"]),
        (
            "operation.project_coverage",
            vec!["operation.read", "project.references.read"],
        ),
    ]
    .into_iter()
    .map(|(name, scopes)| CapabilityRequirement {
        capability: key(name),
        scopes: scopes.into_iter().map(String::from).collect(),
    })
    .collect::<Vec<_>>();
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
        request: RequestId::new("query").unwrap(),
        binding: ProviderBinding {
            capability: key(LIST),
            provider,
            project: ProjectId::new("project").unwrap(),
            target: None,
        },
        principal: PrincipalId::new("principal").unwrap(),
        scopes: [
            "workspace.read",
            "workspace.run_r",
            "operation.read",
            "resources.read",
            "project.references.read",
        ]
        .into_iter()
        .map(String::from)
        .collect(),
        arguments: json!({"limit":10}),
        preconditions: Value::Null,
        owner_context: Value::Null,
        operation_id: None,
    };
    (directory, owner, call, rx)
}

fn reference(call: &PluginCall) -> RCheckpointReference {
    RCheckpointReference {
        project: call.binding.project.clone(),
        provider: call.binding.provider.clone(),
        operation_id: id("capture"),
        digest: ContentDigest::new(format!("sha256:{}", "c".repeat(64))).unwrap(),
        bytes: 1024,
    }
}

#[test]
fn pin_and_delete_follow_committed_preconditions_and_do_not_claim_disk_cleanup() {
    let (_directory, _owner, call, _rx) = fixture();
    let reference = reference(&call);
    let mut state = ControlState::default();
    let result = |operation: &str, pinned, deleted| RCheckpointControlResult {
        operation_id: id(operation),
        reference: reference.clone(),
        pinned,
        deleted,
    };
    apply_control(
        &mut state,
        &reference,
        &id("pin"),
        None,
        RecoveryControl::Pin { pinned: true },
        result("pin", true, false),
    )
    .unwrap();
    assert!(check_action(DELETE, &json!({"expected_control":"pin"}), &state).is_err());
    assert!(check_action(PIN, &json!({"expected_control":null}), &state).is_err());
    assert!(
        apply_control(
            &mut state.clone(),
            &reference,
            &id("delete"),
            Some(id("pin")),
            RecoveryControl::Delete,
            result("delete", false, true)
        )
        .is_err()
    );
    apply_control(
        &mut state,
        &reference,
        &id("unpin"),
        Some(id("pin")),
        RecoveryControl::Pin { pinned: false },
        result("unpin", false, false),
    )
    .unwrap();
    apply_control(
        &mut state,
        &reference,
        &id("delete"),
        Some(id("unpin")),
        RecoveryControl::Delete,
        result("delete", false, true),
    )
    .unwrap();
    assert!(check_action(RESTORE, &json!({}), &state).is_err());
    assert!(check_action(PURGE, &json!({"deletion_operation_id":"unpin"}), &state).is_err());
    check_action(PURGE, &json!({"deletion_operation_id":"delete"}), &state).unwrap();
    assert!(
        apply_control(
            &mut state,
            &reference,
            &id("after-delete"),
            Some(id("delete")),
            RecoveryControl::Pin { pinned: false },
            result("after-delete", false, true)
        )
        .is_err()
    );
    assert!(
        json!(result("delete", false, true))
            .get("payload_removed")
            .is_none()
    );
}

#[test]
fn mismatched_committed_results_never_establish_control_state() {
    let (_directory, _owner, call, _rx) = fixture();
    let reference = reference(&call);
    for field in ["operation", "reference", "pin", "delete", "precondition"] {
        let mut result = RCheckpointControlResult {
            operation_id: id("pin"),
            reference: reference.clone(),
            pinned: true,
            deleted: false,
        };
        let mut expected = None;
        match field {
            "operation" => result.operation_id = id("other"),
            "reference" => result.reference.operation_id = id("other-copy"),
            "pin" => result.pinned = false,
            "delete" => result.deleted = true,
            _ => expected = Some(id("uncommitted")),
        }
        assert!(
            apply_control(
                &mut ControlState::default(),
                &reference,
                &id("pin"),
                expected,
                RecoveryControl::Pin { pinned: true },
                result
            )
            .is_err(),
            "{field}"
        );
    }
}

#[test]
fn original_admission_and_current_scope_both_qualify_recovery_storage() {
    let (_directory, owner, call, _rx) = fixture();
    let mut binding = call.binding.clone();
    binding.capability = key(CAPTURE);
    binding.target = Some("original-native-session".into());
    let qualification = Qualification {
        session_target: binding.target.clone().unwrap(),
        arguments_digest: arguments_digest(
            &normalize(
                CAPTURE,
                json!({"expected_session":"original-native-session","max_seconds":10.0}),
            )
            .unwrap(),
        )
        .unwrap(),
        storage: owner.recovery_storage(&call),
        environment: None,
        source: None,
    };
    let record = json!({"operation":{"operation_id":"capture","capability":binding.capability,"idempotency_scope":owner.environment.project_root,
        "normalized_arguments":{"binding":binding,"arguments":{"expected_session":"original-native-session","max_seconds":10}},"admission":{"owner_context":{"binding":binding,"qualification":qualification}}}});
    owner.original_qualification(&call, &record).unwrap();
    for field in [
        "project",
        "principal",
        "provider",
        "root",
        "data",
        "target",
        "version",
        "arguments",
        "admission",
    ] {
        let mut changed = record.clone();
        let q = &mut changed["operation"]["admission"]["owner_context"]["qualification"];
        match field {
            "project" => q["storage"]["scope"]["project"] = json!("other-project"),
            "principal" => q["storage"]["scope"]["principal"] = json!("other-principal"),
            "provider" => q["storage"]["scope"]["provider"]["instance"] = json!("other-provider"),
            "root" => q["storage"]["scope"]["project_root"] = json!("/other-project"),
            "data" => q["storage"]["data_root"] = json!("/tmp/../elsewhere"),
            "target" => q["session_target"] = json!("other-session"),
            "arguments" => {
                changed["operation"]["normalized_arguments"]["arguments"]["max_seconds"] = json!(11)
            }
            "version" => {
                changed["operation"]["normalized_arguments"]["binding"]["capability"]["version"] =
                    json!(2)
            }
            _ => {
                changed["operation"]["admission"]["owner_context"]["binding"]["provider"]["instance"] =
                    json!("replacement")
            }
        }
        assert!(
            owner.original_qualification(&call, &changed).is_err(),
            "{field}"
        );
    }
    let mut foreign = call.clone();
    foreign.principal = PrincipalId::new("another-reader").unwrap();
    assert!(owner.original_qualification(&foreign, &record).is_err());
    assert!(owner.runtime.lock().unwrap().is_none());
}

#[tokio::test]
async fn bounded_journal_observations_do_not_start_r_or_infer_missing_pages() {
    for case in [
        "empty-continuation",
        "ascending",
        "cursor",
        "unavailable",
        "partial-empty",
        "valid",
    ] {
        let (_directory, owner, call, mut rx) = fixture();
        let task = tokio::spawn(async move {
            let request = rx.recv().await.unwrap();
            assert_eq!(request.capability, key("operation.list_recent"));
            assert!(request.request.is_none());
            let item = |cursor, operation| json!({"cursor":cursor,"operation_id":operation,"capability":{"id":"other.capability","version":1},"status":"succeeded"});
            let data = match case {
                "empty-continuation" => json!({"operations":[],"next_cursor":3}),
                "ascending" => json!({"operations":[item(2,"a"),item(3,"b")],"next_cursor":null}),
                "cursor" => json!({"operations":[item(3,"a")],"next_cursor":2}),
                "partial-empty" => json!({"operations":[],"next_cursor":null}),
                _ => json!({"operations":[item(3,"a")],"next_cursor":3}),
            };
            request.reply.send(Ok(json!({"status":if case=="unavailable" {"unavailable"} else {"ready"},"completeness":if case=="partial-empty" {"partial"} else {"complete"},"data":data}))).unwrap();
        });
        let result = owner.recovery_page(&call, None, 2).await;
        assert_eq!(
            result.is_ok(),
            matches!(case, "valid" | "partial-empty"),
            "{case}"
        );
        assert!(owner.runtime.lock().unwrap().is_none());
        assert!(!directory_has_archive(&_directory));
        task.await.unwrap();
    }
}
fn directory_has_archive(directory: &tempfile::TempDir) -> bool {
    directory.path().join("r-recovery-v1").exists()
}

#[tokio::test]
async fn missing_optional_grants_stop_reads_before_host_or_native_work() {
    let (_directory, mut owner, call, mut rx) = fixture();
    owner.recovery_grants = Grants::new(&[]);
    assert!(
        owner
            .query_recovery(&call)
            .await
            .unwrap_err()
            .contains("grant")
    );
    assert!(rx.try_recv().is_err());
    assert!(!directory_has_archive(&_directory));
    assert!(owner.runtime.lock().unwrap().is_none());
}

#[tokio::test]
async fn retained_manifests_require_complete_correlated_resource_bytes() {
    for case in [
        "valid",
        "unavailable",
        "identity",
        "offset",
        "length",
        "continuation",
        "digest",
    ] {
        let (_directory, owner, call, mut rx) = fixture();
        let bytes = b"{\"snapshot\":\"original\"}".to_vec();
        let reference = ResourceReference {
            owner: call.binding.provider.clone(),
            resource: ResourceId::new("manifest").unwrap(),
            digest: ContentDigest::new(format!("sha256:{:x}", Sha256::digest(&bytes))).unwrap(),
            media_type: "application/json".into(),
            bytes: bytes.len() as u64,
        };
        let selected = reference.clone();
        let original = bytes.clone();
        let server = tokio::spawn(async move {
            let request = rx.recv().await.unwrap();
            assert_eq!(request.capability, key("resources.read"));
            assert!(request.request.is_none());
            assert_eq!(request.arguments["reference"], json!(selected));
            assert_eq!(request.arguments["offset"], 0);
            let mut chunk = ResourceChunk {
                reference: selected,
                offset: 0,
                base64: base64::engine::general_purpose::STANDARD.encode(&original),
                next: None,
            };
            match case {
                "identity" => {
                    chunk.reference.owner.instance =
                        PluginInstanceId::new("another-instance").unwrap()
                }
                "offset" => chunk.offset = 1,
                "length" => {
                    chunk.base64 = base64::engine::general_purpose::STANDARD
                        .encode(&original[..original.len() - 1])
                }
                "continuation" => chunk.next = Some(original.len() as u64),
                "digest" => {
                    let mut changed = original;
                    changed[0] ^= 1;
                    chunk.base64 = base64::engine::general_purpose::STANDARD.encode(changed);
                }
                _ => (),
            }
            request.reply.send(Ok(json!({"status":if case=="unavailable" {"unavailable"} else {"ready"},"completeness":"complete","data":chunk}))).unwrap();
        });
        let result = owner.recovery_manifest_bytes(&call, &reference).await;
        if case == "valid" {
            assert_eq!(result.unwrap(), bytes);
        } else {
            assert!(result.is_err(), "{case}");
        }
        assert!(!directory_has_archive(&_directory));
        assert!(owner.runtime.lock().unwrap().is_none());
        server.await.unwrap();
    }
}
