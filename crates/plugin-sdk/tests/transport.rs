use rho_plugin_sdk::{protocol::*, *};
use tokio::io::{AsyncWriteExt, duplex};

fn identity() -> (PluginInstanceId, ConnectionId) {
    (
        PluginInstanceId::new("instance-1").unwrap(),
        ConnectionId::new("connection-1").unwrap(),
    )
}

#[tokio::test]
async fn frames_remain_separate_across_small_io_chunks_and_eof() {
    let (writer, reader) = duplex(7);
    let (id, epoch) = identity();
    let mut sender = RpcWriter::new(writer, id.clone(), epoch.clone());
    let task = tokio::spawn(async move {
        for n in 0..3 {
            sender
                .send(
                    RequestId::new(format!("request-{n}")).unwrap(),
                    RpcBody::Release,
                )
                .await
                .unwrap();
        }
    });
    let mut receiver = RpcReader::new(reader, id, epoch);
    for n in 0..3 {
        let frame = receiver.receive().await.unwrap().unwrap();
        assert_eq!(frame.sequence, n + 1);
        assert_eq!(frame.request.as_str(), format!("request-{n}"));
    }
    assert!(receiver.receive().await.unwrap().is_none());
    task.await.unwrap();
}

#[tokio::test]
async fn oversized_and_truncated_frames_fail_before_a_valid_message() {
    for data in [
        vec![0, 0, 0, 0],
        ((MAX_CONTROL_BYTES as u32) + 1).to_be_bytes().to_vec(),
        vec![0, 0],
        vec![0, 0, 0, 10, b'{'],
    ] {
        let mut input = data.as_slice();
        assert!(read_frame(&mut input).await.is_err());
    }
}

#[tokio::test]
async fn receive_rejects_wrong_identity_sequence_and_revoked_connection() {
    for fault in ["identity", "sequence", "revoked"] {
        let (mut raw, reader) = duplex(2048);
        let (id, epoch) = identity();
        let frame = RpcFrame {
            protocol_version: PLUGIN_PROTOCOL_VERSION,
            instance: if fault == "identity" {
                PluginInstanceId::new("spoof").unwrap()
            } else {
                id.clone()
            },
            connection: epoch.clone(),
            sequence: if fault == "sequence" { 2 } else { 1 },
            request: RequestId::new("request").unwrap(),
            body: RpcBody::Release,
        };
        let bytes = frame.encode().unwrap();
        raw.write_all(&(bytes.len() as u32).to_be_bytes())
            .await
            .unwrap();
        raw.write_all(&bytes).await.unwrap();
        let mut receiver = RpcReader::new(reader, id, epoch);
        if fault == "revoked" {
            receiver.revoke();
        }
        assert!(receiver.receive().await.is_err());
    }
}

#[tokio::test]
async fn broken_writer_is_fenced_instead_of_retrying_partial_messages() {
    let (writer, reader) = duplex(64);
    drop(reader);
    let (id, epoch) = identity();
    let mut sender = RpcWriter::new(writer, id, epoch);
    assert!(
        sender
            .send(RequestId::new("a").unwrap(), RpcBody::Release)
            .await
            .is_err()
    );
    let error = sender
        .send(RequestId::new("b").unwrap(), RpcBody::Release)
        .await
        .unwrap_err();
    assert!(error.to_string().contains("fenced"));
}

#[tokio::test]
async fn cancelling_a_partial_write_also_fences_the_channel() {
    let (writer, _reader) = duplex(1);
    let (id, epoch) = identity();
    let mut sender = RpcWriter::new(writer, id, epoch);
    tokio::select! {
        biased;
        _ = sender.send(RequestId::new("partial").unwrap(), RpcBody::Release) => panic!("one byte cannot hold a frame"),
        _ = std::future::ready(()) => (),
    }
    let error = sender
        .send(RequestId::new("retry").unwrap(), RpcBody::Release)
        .await
        .unwrap_err();
    assert!(error.to_string().contains("fenced"));
}

#[tokio::test]
async fn sdk_initialization_and_call_validation_keep_the_host_binding() {
    let (host_output, backend_input) = duplex(4096);
    let (backend_output, host_input) = duplex(4096);
    let (id, epoch) = identity();
    let instance: PluginInstance = serde_json::from_value(serde_json::json!({
        "identity":{"instance":id,"plugin":"external.rust",
            "revision":format!("sha256:{}", "a".repeat(64)),"artifact":format!("sha256:{}", "b".repeat(64))},
        "project":"project","principal":"principal","alias":"rust","configuration":{},
        "state":"preparing","diagnostic":null
    })).unwrap();
    let mut host_writer = RpcWriter::new(host_output, id.clone(), epoch.clone());
    let mut host_reader = RpcReader::new(host_input, id, epoch);
    let initialize = RequestId::new("initialize").unwrap();
    host_writer
        .send(
            initialize.clone(),
            RpcBody::Initialize {
                instance: instance.clone(),
                grants: vec![],
                environment: Some(BackendEnvironment { project_root: "/project".into(), data_root: "/instance".into() }),
                resource_channel: None,
            },
        )
        .await
        .unwrap();
    let mut backend = BackendConnection::accept(backend_input, backend_output)
        .await
        .unwrap();
    assert_eq!(backend.instance, instance);
    assert_eq!(backend.environment.as_ref().unwrap().project_root, "/project");
    backend.ready().await.unwrap();
    let ready = host_reader.receive().await.unwrap().unwrap();
    assert_eq!(ready.request, initialize);
    assert_eq!(
        ready.body,
        RpcBody::Ready {
            revision: instance.identity.revision.clone(),
            artifact: instance.identity.artifact.clone()
        }
    );
    let request = RequestId::new("read").unwrap();
    let call = PluginCall {
        owner_context: serde_json::Value::Null,
        request: request.clone(),
        binding: ProviderBinding {
            capability: CapabilityKey {
                id: ContributionId::new("external.read").unwrap(),
                version: 1,
            },
            provider: instance.identity,
            project: instance.project,
            target: Some("native-1".into()),
        },
        principal: instance.principal,
        scopes: Default::default(),
        arguments: serde_json::json!({}),
        preconditions: serde_json::json!({}),
        operation_id: None,
    };
    host_writer
        .send(request.clone(), RpcBody::Query(call.clone()))
        .await
        .unwrap();
    let frame = backend.reader.receive().await.unwrap().unwrap();
    backend.validate_call(&frame).unwrap();
    let mut spoof = call;
    spoof.principal = PrincipalId::new("different-principal").unwrap();
    host_writer
        .send(request, RpcBody::Query(spoof))
        .await
        .unwrap();
    let frame = backend.reader.receive().await.unwrap().unwrap();
    assert!(backend.validate_call(&frame).is_err());
}
