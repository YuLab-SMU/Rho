use super::*;
use base64::Engine;
use tokio::sync::mpsc;

fn fixture() -> (tempfile::TempDir, PluginCall, EnvironmentLibrary) {
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path().canonicalize().unwrap();
    std::fs::create_dir_all(root.join("R/bin")).unwrap();
    std::fs::write(root.join("R/bin/Rscript"), "not executable").unwrap();
    let provider:InstanceRef=serde_json::from_value(json!({"plugin":"org.rho.environment","instance":"environment-current","revision":format!("sha256:{}","a".repeat(64)),"artifact":format!("sha256:{}","b".repeat(64))})).unwrap();
    let binding = ProviderBinding {
        capability: key("environment.library", 2),
        provider: provider.clone(),
        project: ProjectId::new("project").unwrap(),
        target: Some("environment-target".into()),
    };
    let mut source = binding.clone();
    source.capability = key("environment.realize", 2);
    source.provider.instance = PluginInstanceId::new("previous-environment").unwrap();
    let library = EnvironmentLibrary {
        binding: binding.clone(),
        source: source.clone(),
        realization: OperationId::new("original-realization").unwrap(),
        report: ResourceReference {
            owner: source.provider,
            resource: ResourceId::new("realization-report").unwrap(),
            digest: ContentDigest::new(format!("sha256:{}", "c".repeat(64))).unwrap(),
            media_type: "application/json".into(),
            bytes: 1024,
        },
        project_root: root.to_str().unwrap().into(),
        storage_root: root.join("materials").to_str().unwrap().into(),
        rscript: root.join("R/bin/Rscript").to_str().unwrap().into(),
        library_path: root.join("materials/library").to_str().unwrap().into(),
        library_digest: ContentDigest::new(format!("sha256:{}", "d".repeat(64))).unwrap(),
        r_version: "4.5".into(),
        platform: "fixture".into(),
    };
    let mut r = binding;
    r.capability = key("r.create_session", 2);
    r.provider.instance = PluginInstanceId::new("r-instance").unwrap();
    r.provider.plugin = PluginId::new("org.rho.r").unwrap();
    r.target = Some("unstarted:r-instance".into());
    let call = PluginCall {
        request: RequestId::new("original-session-call").unwrap(),
        binding: r,
        principal: PrincipalId::new("principal").unwrap(),
        scopes: SCOPES.iter().map(|s| (*s).into()).collect(),
        arguments: json!(CreateRSession {
            environment: REnvironmentSelection {
                binding: library.binding.clone(),
                realization: library.realization.clone()
            }
        }),
        preconditions: Value::Null,
        operation_id: Some("original-session".into()),
        owner_context: json!(Qualification {
            session_target: "unstarted:r-instance".into(),
            environment: library.clone()
        }),
    };
    (directory, call, library)
}
#[test]
fn source_and_configuration_cannot_expand_the_selected_environment_authority() {
    let (_directory, call, library) = fixture();
    let home = Path::new(&library.rscript)
        .parent()
        .unwrap()
        .parent()
        .unwrap();
    assert!(arguments(&call, call.arguments.clone(), false).is_err());
    assert!(
        qualify(
            &call,
            "unstarted:r-instance",
            true,
            &library.project_root,
            home
        )
        .is_ok()
    );
    for field in [
        "project",
        "provider",
        "realization",
        "rscript",
        "target",
        "scope",
    ] {
        let mut changed = call.clone();
        match field {
            "project" => {
                changed.owner_context["environment"]["project_root"] = json!("/another-project")
            }
            "provider" => {
                changed.owner_context["environment"]["binding"]["provider"]["instance"] =
                    json!("substituted-provider")
            }
            "realization" => {
                changed.owner_context["environment"]["realization"] = json!("another-realization")
            }
            "rscript" => {
                changed.owner_context["environment"]["rscript"] = json!("/another/Rscript")
            }
            "target" => changed.owner_context["session_target"] = json!("another-session"),
            _ => {
                changed.scopes.remove("environment.write");
            }
        }
        assert!(
            qualify(
                &changed,
                "unstarted:r-instance",
                true,
                &library.project_root,
                home
            )
            .is_err(),
            "{field}"
        );
    }
}
#[tokio::test]
async fn delegated_verification_is_original_scoped_and_never_retried_after_uncertainty() {
    for fault in [
        "none",
        "lost",
        "uncertain",
        "failed",
        "parent",
        "digest",
        "changed",
    ] {
        let (_directory, call, library) = fixture();
        let home = Path::new(&library.rscript)
            .parent()
            .unwrap()
            .parent()
            .unwrap();
        let (sender, mut incoming) = mpsc::channel(32);
        let host = HostCalls(sender);
        let bytes = serde_json::to_vec(
            &json!({"verified":true,"library_digest_matches":true,"probes":[],"errors":[]}),
        )
        .unwrap();
        let report = ResourceReference {
            owner: library.binding.provider.clone(),
            resource: ResourceId::new("verification-report").unwrap(),
            digest: ContentDigest::new(format!("sha256:{:x}", Sha256::digest(&bytes))).unwrap(),
            media_type: "application/json".into(),
            bytes: bytes.len() as u64,
        };
        let respond = async {
            let request = incoming.recv().await.unwrap();
            assert_eq!(request.parent, call.request);
            assert_eq!(request.capability, key("environment.verify", 2));
            assert!(
                request
                    .request
                    .as_ref()
                    .unwrap()
                    .as_str()
                    .starts_with("r-environment-verify-")
            );
            assert_eq!(
                request.arguments["arguments"]["realization_operation_id"],
                library.realization.as_str()
            );
            assert_eq!(
                request.arguments["binding"]["provider"],
                json!(library.binding.provider)
            );
            if fault == "lost" {
                request
                    .reply
                    .send(Err("injected lost acknowledgement".into()))
                    .unwrap();
                return;
            }
            let mut record = json!({"status":if matches!(fault,"failed"|"uncertain"){fault}else{"succeeded"},"operation":{
                "operation_id":"original-verification","causation_id":call.operation_id,"idempotency_scope":library.project_root,"capability":request.capability,
                "normalized_arguments":request.arguments,"admission":{"owner_context":{"binding":request.arguments["binding"]}}},
                "output":EnvironmentResult {operation:OperationId::new("original-verification").unwrap(),kind:EnvironmentReportKind::Verification,report:report.clone(),verified:Some(true)}});
            if fault == "parent" {
                record["operation"]["causation_id"] = json!("another-parent");
            }
            request.reply.send(Ok(record)).unwrap();
            if matches!(fault, "uncertain" | "failed" | "parent") {
                return;
            }
            let request = incoming.recv().await.unwrap();
            assert_eq!(request.capability, key("resources.read", 1));
            assert_eq!(request.arguments["reference"], json!(report));
            let mut data = bytes.clone();
            if fault == "digest" {
                data[0] = b'!';
            }
            request.reply.send(Ok(json!({"status":"ready","completeness":"complete","data":{"reference":report,"offset":0,"next":null,"base64":base64::engine::general_purpose::STANDARD.encode(data)}}))).unwrap();
            if fault == "digest" {
                return;
            }
            let request = incoming.recv().await.unwrap();
            assert_eq!(request.capability, key("environment.library", 2));
            let mut selected = library.clone();
            if fault == "changed" {
                selected.r_version = "another-version".into();
            }
            request
                .reply
                .send(Ok(
                    json!({"status":"ready","completeness":"complete","data":selected}),
                ))
                .unwrap();
        };
        let (result, ()) = tokio::join!(
            verify(
                &host,
                &call,
                &library,
                &library.project_root,
                home,
                Duration::from_secs(30)
            ),
            respond
        );
        if fault == "none" {
            let bound = result.unwrap();
            assert_eq!(bound.verification.as_str(), "original-verification");
            assert_eq!(
                bound.source.provider.instance.as_str(),
                "previous-environment"
            );
        } else {
            let error = result.unwrap_err();
            assert_eq!(error.effect_may_have_occurred, fault != "failed", "{fault}");
            assert_eq!(error.recovery.unwrap()["automatic_reexecution"], false);
        }
        assert!(
            incoming.try_recv().is_err(),
            "No implicit re-verification or replay after {fault}"
        );
    }
}
