use rho_plugin_protocol::*;
use serde_json::json;

fn frame(sequence: u32) -> RpcFrame {
    RpcFrame {
        protocol_version: 1,
        connection: ConnectionId::new("connection-1").unwrap(),
        instance: PluginInstanceId::new("instance-1").unwrap(),
        sequence,
        request: RequestId::new("request-1").unwrap(),
        body: RpcBody::Released,
    }
}

#[test]
fn readiness_extensions_are_optional_bounded_and_do_not_change_manifest_contracts() {
    let mut ready = frame(1);
    ready.body = RpcBody::Ready {
        revision: RevisionId::new(format!("sha256:{}", "a".repeat(64))).unwrap(),
        artifact: ArtifactId::new(format!("sha256:{}", "b".repeat(64))).unwrap(),
        features: Default::default(),
    };
    let old = ready.encode().unwrap();
    assert!(!String::from_utf8_lossy(&old).contains("features"));
    assert_eq!(RpcFrame::decode(&old).unwrap(), ready);
    if let RpcBody::Ready { features, .. } = &mut ready.body {
        features.insert(PENDING_CANCELLATION_FEATURE.into());
        features.insert("another-owner.feature_v1".into());
    }
    assert_eq!(RpcFrame::decode(&ready.encode().unwrap()).unwrap(), ready);
    for invalid in [vec!["".to_owned()], vec!["x".repeat(65)], vec!["invalid value".into()],
        (0..17).map(|i| format!("feature-{i}")).collect()] {
        if let RpcBody::Ready { features, .. } = &mut ready.body {
            *features = invalid.into_iter().collect();
        }
        assert!(ready.encode().is_err());
    }
}

#[test]
fn instance_connection_and_sequence_are_checked_before_acceptance() {
    let mut guard = RpcSessionGuard::new(
        PluginInstanceId::new("instance-1").unwrap(),
        ConnectionId::new("connection-1").unwrap(),
    );
    let mut forged = frame(1);
    forged.instance = PluginInstanceId::new("other-instance").unwrap();
    assert!(guard.accept(&forged.encode().unwrap()).is_err());
    forged = frame(1);
    forged.connection = ConnectionId::new("old-connection").unwrap();
    assert!(guard.accept(&forged.encode().unwrap()).is_err());
    assert!(guard.accept(&frame(2).encode().unwrap()).is_err());
    assert_eq!(guard.accept(&frame(1).encode().unwrap()).unwrap(), frame(1));
    assert!(guard.accept(&frame(1).encode().unwrap()).is_err());
    assert!(guard.accept(&frame(2).encode().unwrap()).is_ok());
    guard.revoke();
    assert!(guard.accept(&frame(3).encode().unwrap()).is_err());
}

#[test]
fn oversized_unknown_and_unsupported_frames_are_rejected() {
    assert!(RpcFrame::decode(&vec![b' '; MAX_CONTROL_BYTES + 1]).is_err());
    let mut unknown = serde_json::to_value(frame(1)).unwrap();
    unknown["principal_override"] = json!("admin");
    assert!(RpcFrame::decode(&serde_json::to_vec(&unknown).unwrap()).is_err());
    let mut old = frame(1);
    old.protocol_version = 0;
    assert!(old.encode().is_err());
    assert!(frame(0).encode().is_err());
}

fn visual() -> VisualDocument {
    serde_json::from_value(json!({
        "format_version":1,"root":"root","nodes":{
            "root":{"kind":"container","children":["button"],"properties":{},"style_tokens":{},"bindings":{},"visible_when":null,"events":{},"component":null},
            "button":{"kind":"button","children":[],"properties":{"label":"运行"},"style_tokens":{},"bindings":{},"visible_when":null,"events":{"click":[{"kind":"invoke","capability":{"id":"example.execute","version":1},"arguments":{}}]},"component":null}
        },"data_sources":{},"components":{}
    })).unwrap()
}

#[test]
fn visual_round_trip_retains_unicode_identity_and_custom_source() {
    let mut original = visual();
    original
        .nodes
        .get_mut(&NodeId::new("button").unwrap())
        .unwrap()
        .kind = VisualNodeKind::Custom;
    original
        .nodes
        .get_mut(&NodeId::new("button").unwrap())
        .unwrap()
        .component = Some(ContributionId::new("custom.report").unwrap());
    original.components.insert(
        ContributionId::new("custom.report").unwrap(),
        CustomComponent {
            source: PackagePath::new("src/报告.tsx").unwrap(),
            export: "Report".into(),
            properties_schema: json!({}),
            input_schema: json!({}),
            output_schema: json!({}),
        },
    );
    original.validate().unwrap();
    let decoded: VisualDocument =
        serde_json::from_str(&serde_json::to_string_pretty(&original).unwrap()).unwrap();
    assert_eq!(decoded, original);
    assert_eq!(
        decoded.nodes[&NodeId::new("button").unwrap()].properties["label"],
        "运行"
    );
}

#[test]
fn rendering_cannot_bind_mutating_events_and_invalid_trees_are_rejected() {
    let mut document = visual();
    document.validate().unwrap();
    let node = document
        .nodes
        .get_mut(&NodeId::new("button").unwrap())
        .unwrap();
    node.events
        .insert("mount".into(), node.events["click"].clone());
    assert!(document.validate().is_err());
    let mut document = visual();
    document
        .nodes
        .get_mut(&NodeId::new("button").unwrap())
        .unwrap()
        .children
        .push(NodeId::new("root").unwrap());
    assert!(document.validate().is_err());
    let mut document = visual();
    document
        .nodes
        .get_mut(&NodeId::new("root").unwrap())
        .unwrap()
        .children
        .push(NodeId::new("button").unwrap());
    assert!(document.validate().is_err());
    let mut document = visual();
    document
        .nodes
        .get_mut(&NodeId::new("button").unwrap())
        .unwrap()
        .bindings
        .insert(
            "label".into(),
            DataBinding {
                source: ContributionId::new("unknown").unwrap(),
                path: vec![],
            },
        );
    assert!(document.validate().is_err());
}

fn scenario() -> ScenarioRevision {
    serde_json::from_value(json!({
        "id":format!("sha256:{}","1".repeat(64)),"parent":null,"scenario":"comparison","project":"project-1","name":"Comparison",
        "instances":{
            "original":{"plugin":"example.viewer","revision":format!("sha256:{}","a".repeat(64)),"artifact":format!("sha256:{}","b".repeat(64)),"configuration":{},"dependencies":{}},
            "modified":{"plugin":"example.viewer","revision":format!("sha256:{}","c".repeat(64)),"artifact":format!("sha256:{}","d".repeat(64)),"configuration":{},"dependencies":{}}
        },
        "providers":[{"capability":{"id":"example.read","version":1},"instance":"original","target":null}],
        "layout":{"kind":"empty"}
    })).unwrap()
}

#[test]
fn distinct_revisions_coexist_but_default_routing_is_unique() {
    let original = scenario();
    original.validate().unwrap();
    let mut ambiguous = original.clone();
    let mut second = ambiguous.providers[0].clone();
    second.instance = InstanceAlias::new("modified").unwrap();
    ambiguous.providers.push(second);
    assert!(ambiguous.validate().is_err());
    let mut cyclic = original.clone();
    cyclic
        .instances
        .get_mut(&InstanceAlias::new("original").unwrap())
        .unwrap()
        .dependencies
        .insert(
            InstanceAlias::new("dependency").unwrap(),
            InstanceAlias::new("modified").unwrap(),
        );
    cyclic
        .instances
        .get_mut(&InstanceAlias::new("modified").unwrap())
        .unwrap()
        .dependencies
        .insert(
            InstanceAlias::new("dependency").unwrap(),
            InstanceAlias::new("original").unwrap(),
        );
    assert!(cyclic.validate().is_err());
    let mut wrong_state = original;
    wrong_state.layout = ScenarioLayout::Tabs {
        id: NodeId::new("group").unwrap(),
        selected: None,
        views: vec![ScenarioView {
            id: ViewInstanceId::new("view-1").unwrap(),
            instance: InstanceAlias::new("original").unwrap(),
            contribution: ContributionId::new("report").unwrap(),
            configuration: json!({}),
            state: json!({}),
            state_revision: RevisionId::new(format!("sha256:{}", "c".repeat(64))).unwrap(),
            resource: None,
        }],
    };
    assert!(wrong_state.validate().is_err());
}

#[test]
fn scenario_bounds_include_empty_nodes_and_explicit_optional_selections() {
    let mut value = scenario();
    let instance = value.instances.values_mut().next().unwrap();
    let capability = CapabilityKey { id:ContributionId::new("example.read").unwrap(),version:1 };
    instance.optional_capabilities = vec![capability.clone(),capability];
    assert!(value.validate().is_err());
    value.instances.values_mut().next().unwrap().optional_capabilities.pop();
    value.validate().unwrap();
    value.layout = ScenarioLayout::Split { id:NodeId::new("root").unwrap(),direction:SplitDirection::Horizontal,
        weights:vec![1.0;32],children:(0..32).map(|i| ScenarioLayout::Split {
            id:NodeId::new(format!("group-{i}")).unwrap(),direction:SplitDirection::Vertical,
            weights:vec![1.0;32],children:vec![ScenarioLayout::Empty;32],
        }).collect() };
    assert!(value.validate().is_err());
    for field in ["project","principal","id"] {
        let mut input = json!({"scenario":"analysis","expected_head":null,"name":"Analysis","instances":{},"providers":[],"layout":{"kind":"empty"}});
        input[field] = json!("forged");
        assert!(serde_json::from_value::<SaveScenario>(input).is_err());
    }
}

#[test]
fn aggregate_layout_and_visual_source_limits_are_enforced() {
    let mut document = visual();
    for index in 0..257 {
        document.data_sources.insert(
            ContributionId::new(format!("source-{index}")).unwrap(),
            VisualDataSource {
                capability: CapabilityKey {
                    id: ContributionId::new("example.read").unwrap(),
                    version: 1,
                },
                arguments: json!({}),
                subscribe: false,
            },
        );
    }
    assert!(document.validate().is_err());
    let mut scene = scenario();
    let mut children = vec![];
    for group in 0..5 {
        let views = (0..205)
            .map(|index| ScenarioView {
                id: ViewInstanceId::new(format!("view-{group}-{index}")).unwrap(),
                instance: InstanceAlias::new("original").unwrap(),
                contribution: ContributionId::new("report").unwrap(),
                configuration: json!({}),
                state: json!({}),
                resource: None,
                state_revision: RevisionId::new(format!("sha256:{}", "a".repeat(64))).unwrap(),
            })
            .collect();
        children.push(ScenarioLayout::Tabs {
            id: NodeId::new(format!("group-{group}")).unwrap(),
            selected: None,
            views,
        });
    }
    scene.layout = ScenarioLayout::Split {
        id: NodeId::new("layout-root").unwrap(),
        direction: SplitDirection::Horizontal,
        weights: vec![1.0; 5],
        children,
    };
    assert!(scene.validate().is_err());
}

#[test]
fn control_diagnostics_redact_payloads_but_wire_retains_exact_answers() {
    let secret = "ephemeral-secret-Ω";
    let request: PluginViewRequest = serde_json::from_value(json!({"type":"control",
        "capability":{"id":"example.answer","version":2},"arguments":{"value":secret}}))
    .unwrap();
    assert!(!format!("{request:?}").contains(secret));
    assert_eq!(
        serde_json::to_value(&request).unwrap()["arguments"]["value"],
        secret
    );
    for body in [
        RpcBody::ControlResult {
            data: json!({"value":secret}),
        },
        RpcBody::Error {
            code: "bad".into(),
            message: secret.into(),
            recovery: Some(json!({"answer":secret})),
        },
    ] {
        let mut wire = frame(1);
        wire.body = body;
        assert!(!format!("{wire:?}").contains(secret));
        assert_eq!(RpcFrame::decode(&wire.encode().unwrap()).unwrap(), wire);
    }
}
