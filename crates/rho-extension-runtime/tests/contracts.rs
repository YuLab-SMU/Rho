use rho_extension_runtime::{
    ActivationGeneration, ActivationPlan, BindingResolution, CapabilityDeclaration, CapabilityId,
    CapabilityRequirement, DescriptorErrorReason, DiagnosticCode, DiagnosticSeverity,
    ExtensionError, IdentifierCharacterClass, IdentifierErrorReason, InvalidParentReason,
    InvalidScopePolicyReason, LimitKind, MAX_OPTIONAL_PER_PLUGIN, MAX_PLUGINS_PER_SCOPE,
    MAX_PROVIDES_PER_PLUGIN, MAX_REQUIRED_PER_PLUGIN, MAX_RESOLVED_EDGES, OperationId,
    PluginDescriptor, PluginId, PluginVersion, RequirementKind, ScopeId, ScopeIdentity,
    ScopeKindId, ScopeKindRule, ScopePolicy, resolve_activation_plan,
};

fn plugin_id(value: &str) -> PluginId {
    PluginId::new(value).unwrap()
}

fn capability_id(value: &str) -> CapabilityId {
    CapabilityId::new(value).unwrap()
}

fn scope_id(value: &str) -> ScopeId {
    ScopeId::new(value).unwrap()
}

fn generation(value: u64) -> ActivationGeneration {
    ActivationGeneration::new(value).unwrap()
}

fn scope(kind: ScopeKindId, id: &str, parent_id: Option<&str>) -> ScopeIdentity {
    ScopeIdentity::new(kind, scope_id(id), parent_id.map(scope_id), generation(1))
}

fn application_scope() -> ScopeIdentity {
    scope(ScopePolicy::application_kind(), "scope.application", None)
}

fn project_scope(parent: &ScopeIdentity) -> ScopeIdentity {
    scope(
        ScopePolicy::project_kind(),
        "scope.project",
        Some(parent.id.as_str()),
    )
}

fn descriptor(id: &str, kind: ScopeKindId) -> PluginDescriptor {
    PluginDescriptor::new(
        plugin_id(id),
        PluginVersion::parse("1.2.3").unwrap(),
        vec![kind],
    )
}

fn declaration(id: &str, major: u64) -> CapabilityDeclaration {
    CapabilityDeclaration::new(capability_id(id), major)
}

fn requirement(id: &str, major: u64) -> CapabilityRequirement {
    CapabilityRequirement::new(capability_id(id), major)
}

fn resolve_application(
    descriptors: Vec<PluginDescriptor>,
) -> Result<ActivationPlan, ExtensionError> {
    resolve_activation_plan(
        &ScopePolicy::phase_one(),
        application_scope(),
        None,
        descriptors,
    )
}

#[test]
fn identifier_boundaries_and_serde_are_validated() {
    let one = PluginId::new("a").unwrap();
    let max = PluginId::new("a".repeat(128)).unwrap();
    assert_eq!(one.as_str(), "a");
    assert_eq!(max.as_str().len(), 128);
    assert_eq!(serde_json::to_string(&one).unwrap(), "\"a\"");
    assert_eq!(serde_json::from_str::<PluginId>("\"a\"").unwrap(), one);

    assert!(matches!(
        PluginId::new(""),
        Err(ExtensionError::InvalidIdentifier {
            reason: IdentifierErrorReason::Empty,
            ..
        })
    ));
    assert!(matches!(
        PluginId::new("a".repeat(129)),
        Err(ExtensionError::InvalidIdentifier {
            reason: IdentifierErrorReason::TooLong {
                actual_bytes: 129,
                max_bytes: 128,
            },
            ..
        })
    ));

    for (value, expected) in [
        ("plugin/name", IdentifierCharacterClass::PathSeparator),
        ("plugin\\name", IdentifierCharacterClass::PathSeparator),
        ("plugin name", IdentifierCharacterClass::Whitespace),
        ("plugin\nname", IdentifierCharacterClass::Whitespace),
        ("Plugin", IdentifierCharacterClass::Uppercase),
        ("plugin:name", IdentifierCharacterClass::OtherAscii),
        ("café", IdentifierCharacterClass::NonAscii),
        ("cafe\u{301}", IdentifierCharacterClass::NonAscii),
    ] {
        assert!(matches!(
            PluginId::new(value),
            Err(ExtensionError::InvalidIdentifier {
                reason: IdentifierErrorReason::InvalidCharacter { class, .. },
                ..
            }) if class == expected
        ));
    }

    assert!(serde_json::from_str::<PluginId>("\"Plugin\"").is_err());
}

#[test]
fn every_identifier_newtype_uses_the_same_grammar() {
    assert!(CapabilityId::new("source.project.run-history").is_ok());
    assert!(OperationId::new("broker.list_runs").is_ok());
    assert!(ScopeKindId::new("future-child").is_ok());
    assert!(ScopeId::new("scope_1").is_ok());

    assert!(CapabilityId::new("source/project").is_err());
    assert!(OperationId::new("Broker.Call").is_err());
    assert!(ScopeKindId::new("工作区").is_err());
    assert!(ScopeId::new("scope 1").is_err());
}

#[test]
fn generation_and_plugin_version_are_typed() {
    assert!(matches!(
        ActivationGeneration::new(0),
        Err(ExtensionError::ZeroActivationGeneration)
    ));
    assert!(serde_json::from_str::<ActivationGeneration>("0").is_err());
    assert_eq!(generation(7).get(), 7);

    let version = PluginVersion::parse("1.2.3-alpha.1+build.5").unwrap();
    assert_eq!(version.as_semver().major, 1);
    assert_eq!(version.as_semver().minor, 2);
    assert_eq!(
        serde_json::to_string(&version).unwrap(),
        "\"1.2.3-alpha.1+build.5\""
    );
    assert!(matches!(
        PluginVersion::parse("1.2"),
        Err(ExtensionError::InvalidPluginVersion)
    ));
}

#[test]
fn phase_one_scope_policy_validates_all_parent_relationships() {
    let policy = ScopePolicy::phase_one();
    let application = application_scope();
    let project = project_scope(&application);
    let workspace = scope(
        ScopePolicy::workspace_kind(),
        "scope.workspace",
        Some(project.id.as_str()),
    );
    let agent = scope(
        ScopePolicy::agent_kind(),
        "scope.agent",
        Some(project.id.as_str()),
    );

    policy.validate_identity(&application, None).unwrap();
    policy
        .validate_identity(&project, Some(&application))
        .unwrap();
    policy
        .validate_identity(&workspace, Some(&project))
        .unwrap();
    policy.validate_identity(&agent, Some(&project)).unwrap();
}

#[test]
fn scope_policy_rejects_invalid_scope_and_parent_identity() {
    let policy = ScopePolicy::phase_one();
    let application = application_scope();
    let project = project_scope(&application);

    let unknown = scope(ScopeKindId::new("unknown").unwrap(), "scope.unknown", None);
    assert!(matches!(
        policy.validate_identity(&unknown, None),
        Err(ExtensionError::InvalidScope { .. })
    ));

    let missing = scope(ScopePolicy::project_kind(), "scope.project", None);
    assert!(matches!(
        policy.validate_identity(&missing, None),
        Err(ExtensionError::InvalidParent {
            reason: InvalidParentReason::MissingParent,
            ..
        })
    ));

    assert!(matches!(
        policy.validate_identity(&project, None),
        Err(ExtensionError::InvalidParent {
            reason: InvalidParentReason::ParentIdentityMissing,
            ..
        })
    ));

    let wrong_application = scope(
        ScopePolicy::application_kind(),
        "scope.other-application",
        None,
    );
    assert!(matches!(
        policy.validate_identity(&project, Some(&wrong_application)),
        Err(ExtensionError::InvalidParent {
            reason: InvalidParentReason::ParentIdMismatch,
            ..
        })
    ));

    let fake_parent = scope(
        ScopePolicy::workspace_kind(),
        "scope.application",
        Some(project.id.as_str()),
    );
    assert!(matches!(
        policy.validate_identity(&project, Some(&fake_parent)),
        Err(ExtensionError::InvalidParent {
            reason: InvalidParentReason::ParentKindMismatch,
            ..
        })
    ));

    let invalid_root = scope(
        ScopePolicy::application_kind(),
        "scope.root",
        Some(application.id.as_str()),
    );
    assert!(matches!(
        policy.validate_identity(&invalid_root, Some(&application)),
        Err(ExtensionError::InvalidParent {
            reason: InvalidParentReason::UnexpectedParent,
            ..
        })
    ));
}

#[test]
fn future_scope_kinds_are_host_rules_not_plugin_registrations() {
    let application = ScopePolicy::application_kind();
    let project = ScopePolicy::project_kind();
    let future = ScopeKindId::new("target-session").unwrap();
    let policy = ScopePolicy::from_host_rules(vec![
        ScopeKindRule::root(application.clone()),
        ScopeKindRule::child(project.clone(), application),
        ScopeKindRule::child(ScopePolicy::workspace_kind(), project.clone()),
        ScopeKindRule::child(ScopePolicy::agent_kind(), project.clone()),
        ScopeKindRule::child(future.clone(), project),
    ])
    .unwrap();

    let application_scope = application_scope();
    let project_scope = project_scope(&application_scope);
    let future_scope = scope(
        future,
        "scope.target-session",
        Some(project_scope.id.as_str()),
    );
    policy
        .validate_identity(&future_scope, Some(&project_scope))
        .unwrap();

    let descriptor_json = serde_json::to_value(descriptor(
        "plugin.no-scope-authority",
        ScopePolicy::application_kind(),
    ))
    .unwrap();
    assert!(descriptor_json.get("scope_rules").is_none());
}

#[test]
fn host_scope_policy_rejects_duplicate_missing_and_cyclic_rules() {
    let application = ScopePolicy::application_kind();
    assert!(matches!(
        ScopePolicy::from_host_rules(vec![
            ScopeKindRule::root(application.clone()),
            ScopeKindRule::root(application.clone()),
        ]),
        Err(ExtensionError::InvalidScopePolicy {
            reason: InvalidScopePolicyReason::DuplicateKind,
            ..
        })
    ));

    assert!(matches!(
        ScopePolicy::from_host_rules(vec![ScopeKindRule::child(
            ScopeKindId::new("child").unwrap(),
            ScopeKindId::new("missing").unwrap(),
        )]),
        Err(ExtensionError::InvalidScopePolicy {
            reason: InvalidScopePolicyReason::MissingParentKind,
            ..
        })
    ));

    assert!(matches!(
        ScopePolicy::from_host_rules(vec![
            ScopeKindRule::child(
                ScopeKindId::new("cycle.a").unwrap(),
                ScopeKindId::new("cycle.b").unwrap(),
            ),
            ScopeKindRule::child(
                ScopeKindId::new("cycle.b").unwrap(),
                ScopeKindId::new("cycle.a").unwrap(),
            ),
        ]),
        Err(ExtensionError::InvalidScopePolicy {
            reason: InvalidScopePolicyReason::ParentCycle,
            ..
        })
    ));
}

#[test]
fn descriptor_validation_rejects_empty_duplicate_and_wrong_scope_declarations() {
    let kind = ScopePolicy::application_kind();

    let empty = descriptor("plugin.empty", kind.clone());
    let mut empty = PluginDescriptor {
        allowed_scopes: vec![],
        ..empty
    };
    assert!(matches!(
        resolve_application(vec![empty.clone()]),
        Err(ExtensionError::InvalidDescriptor {
            reason: DescriptorErrorReason::NoAllowedScopes,
            ..
        })
    ));

    empty.allowed_scopes = vec![kind.clone(), kind.clone()];
    assert!(matches!(
        resolve_application(vec![empty]),
        Err(ExtensionError::InvalidDescriptor {
            reason: DescriptorErrorReason::DuplicateAllowedScope { .. },
            ..
        })
    ));

    let mut duplicate = descriptor("plugin.duplicate", kind.clone());
    duplicate.provides = vec![declaration("service.a", 1), declaration("service.a", 2)];
    assert!(matches!(
        resolve_application(vec![duplicate]),
        Err(ExtensionError::InvalidDescriptor {
            reason: DescriptorErrorReason::DuplicateProvidedCapability { .. },
            ..
        })
    ));

    let mut duplicate = descriptor("plugin.required", kind.clone());
    duplicate.requires = vec![requirement("service.a", 1), requirement("service.a", 2)];
    assert!(matches!(
        resolve_application(vec![duplicate]),
        Err(ExtensionError::InvalidDescriptor {
            reason: DescriptorErrorReason::DuplicateRequiredCapability { .. },
            ..
        })
    ));

    let mut duplicate = descriptor("plugin.optional", kind.clone());
    duplicate.optional = vec![requirement("service.a", 1), requirement("service.a", 2)];
    assert!(matches!(
        resolve_application(vec![duplicate]),
        Err(ExtensionError::InvalidDescriptor {
            reason: DescriptorErrorReason::DuplicateOptionalCapability { .. },
            ..
        })
    ));

    let mut overlap = descriptor("plugin.overlap", kind);
    overlap.requires = vec![requirement("service.a", 1)];
    overlap.optional = vec![requirement("service.a", 1)];
    assert!(matches!(
        resolve_application(vec![overlap]),
        Err(ExtensionError::InvalidDescriptor {
            reason: DescriptorErrorReason::RequiredAndOptionalCapability { .. },
            ..
        })
    ));

    let wrong_scope = descriptor("plugin.project-only", ScopePolicy::project_kind());
    assert!(matches!(
        resolve_application(vec![wrong_scope]),
        Err(ExtensionError::InvalidDescriptor {
            reason: DescriptorErrorReason::ScopeNotAllowed { .. },
            ..
        })
    ));
}

#[test]
fn empty_and_independent_inventory_have_stable_plans() {
    let empty = resolve_application(vec![]).unwrap();
    assert!(empty.activation_order().is_empty());
    assert!(empty.bindings().is_empty());

    let plan = resolve_application(vec![
        descriptor("plugin.z", ScopePolicy::application_kind()),
        descriptor("plugin.a", ScopePolicy::application_kind()),
    ])
    .unwrap();
    assert_eq!(
        plan.activation_order(),
        &[plugin_id("plugin.a"), plugin_id("plugin.z")]
    );
}

#[test]
fn required_dependencies_override_lexical_ties_and_kahn_order_is_stable() {
    let mut provider = descriptor("plugin.z-provider", ScopePolicy::application_kind());
    provider.provides = vec![declaration("service.data", 1)];
    let mut consumer = descriptor("plugin.a-consumer", ScopePolicy::application_kind());
    consumer.requires = vec![requirement("service.data", 1)];
    let independent = descriptor("plugin.b-independent", ScopePolicy::application_kind());

    let plan = resolve_application(vec![consumer, provider, independent]).unwrap();
    assert_eq!(
        plan.activation_order(),
        &[
            plugin_id("plugin.b-independent"),
            plugin_id("plugin.z-provider"),
            plugin_id("plugin.a-consumer"),
        ]
    );
}

#[test]
fn optional_dependencies_are_bound_or_explicitly_absent() {
    let mut consumer = descriptor("plugin.consumer", ScopePolicy::application_kind());
    consumer.optional = vec![requirement("service.optional", 1)];

    let absent = resolve_application(vec![consumer.clone()]).unwrap();
    let binding = &absent.bindings()[&plugin_id("plugin.consumer")][0];
    assert_eq!(binding.kind, RequirementKind::Optional);
    assert_eq!(binding.resolution, BindingResolution::AbsentOptional);
    assert_eq!(absent.diagnostics().len(), 1);
    assert_eq!(
        absent.diagnostics()[0].code,
        DiagnosticCode::OptionalCapabilityAbsent
    );
    assert_eq!(
        absent.diagnostics()[0].severity,
        DiagnosticSeverity::Warning
    );

    let mut provider = descriptor("plugin.provider", ScopePolicy::application_kind());
    provider.provides = vec![declaration("service.optional", 1)];
    let present = resolve_application(vec![consumer, provider]).unwrap();
    assert!(present.diagnostics().is_empty());
    assert!(matches!(
        present.bindings()[&plugin_id("plugin.consumer")][0].resolution,
        BindingResolution::Provider { .. }
    ));
}

#[test]
fn required_missing_and_present_incompatible_capabilities_fail_truthfully() {
    let mut consumer = descriptor("plugin.consumer", ScopePolicy::application_kind());
    consumer.requires = vec![requirement("service.required", 1)];
    assert!(matches!(
        resolve_application(vec![consumer.clone()]),
        Err(ExtensionError::MissingRequiredCapability {
            required_major: 1,
            ..
        })
    ));

    let mut provider = descriptor("plugin.provider", ScopePolicy::application_kind());
    provider.provides = vec![declaration("service.required", 2)];
    assert!(matches!(
        resolve_application(vec![consumer, provider]),
        Err(ExtensionError::IncompatibleCapabilityMajor {
            required_major: 1,
            provided_major: 2,
            ..
        })
    ));

    let mut optional = descriptor("plugin.optional", ScopePolicy::application_kind());
    optional.optional = vec![requirement("service.required", 1)];
    let mut provider = descriptor("plugin.provider", ScopePolicy::application_kind());
    provider.provides = vec![declaration("service.required", 2)];
    assert!(matches!(
        resolve_application(vec![optional, provider]),
        Err(ExtensionError::IncompatibleCapabilityMajor { .. })
    ));
}

#[test]
fn capability_compatibility_compares_contract_major_only() {
    let mut provider = descriptor("plugin.provider", ScopePolicy::application_kind());
    provider.version = PluginVersion::parse("9.8.7").unwrap();
    provider.provides = vec![declaration("service.zero", 0)];
    let mut consumer = descriptor("plugin.consumer", ScopePolicy::application_kind());
    consumer.version = PluginVersion::parse("0.1.0").unwrap();
    consumer.requires = vec![requirement("service.zero", 0)];

    resolve_application(vec![consumer, provider]).unwrap();
}

#[test]
fn duplicate_plugin_and_provider_errors_are_structured() {
    let one = descriptor("plugin.same", ScopePolicy::application_kind());
    let mut two = one.clone();
    two.version = PluginVersion::parse("2.0.0").unwrap();
    assert!(matches!(
        resolve_application(vec![two, one]),
        Err(ExtensionError::DuplicatePlugin { plugin_id: duplicate_id })
            if duplicate_id == plugin_id("plugin.same")
    ));

    let mut a = descriptor("plugin.a", ScopePolicy::application_kind());
    a.provides = vec![declaration("service.same", 1)];
    let mut z = descriptor("plugin.z", ScopePolicy::application_kind());
    z.provides = vec![declaration("service.same", 1)];
    let error = resolve_application(vec![z, a]).unwrap_err();
    match &error {
        ExtensionError::DuplicateProvider { providers, .. } => assert_eq!(
            providers
                .iter()
                .map(|provider| provider.plugin_id.clone())
                .collect::<Vec<_>>(),
            vec![plugin_id("plugin.a"), plugin_id("plugin.z")]
        ),
        other => panic!("unexpected error: {other:?}"),
    }
    assert_eq!(
        error.to_diagnostic().code,
        DiagnosticCode::DuplicateProvider
    );
}

#[test]
fn parent_provider_is_visible_but_cannot_be_shadowed() {
    let policy = ScopePolicy::phase_one();
    let application = application_scope();
    let mut app_provider = descriptor("plugin.app-provider", ScopePolicy::application_kind());
    app_provider.provides = vec![declaration("service.shared", 1)];
    let app_plan =
        resolve_activation_plan(&policy, application.clone(), None, vec![app_provider]).unwrap();

    let project = project_scope(&application);
    let mut consumer = descriptor("plugin.project-consumer", ScopePolicy::project_kind());
    consumer.requires = vec![requirement("service.shared", 1)];
    let project_plan =
        resolve_activation_plan(&policy, project.clone(), Some(&app_plan), vec![consumer]).unwrap();
    match &project_plan.bindings()[&plugin_id("plugin.project-consumer")][0].resolution {
        BindingResolution::Provider { provider } => assert_eq!(provider.scope, application),
        BindingResolution::AbsentOptional => panic!("required parent provider was absent"),
    }

    let mut shadow = descriptor("plugin.project-provider", ScopePolicy::project_kind());
    shadow.provides = vec![declaration("service.shared", 1)];
    let error =
        resolve_activation_plan(&policy, project, Some(&app_plan), vec![shadow]).unwrap_err();
    assert!(matches!(error, ExtensionError::DuplicateProvider { .. }));
}

fn cycle_plugin(id: &str, provides: &str, requires: &str) -> PluginDescriptor {
    let mut plugin = descriptor(id, ScopePolicy::application_kind());
    plugin.provides = vec![declaration(provides, 1)];
    plugin.requires = vec![requirement(requires, 1)];
    plugin
}

#[test]
fn self_and_multi_node_cycles_have_closed_canonical_paths() {
    let self_cycle = cycle_plugin("plugin.self", "service.self", "service.self");
    assert_eq!(
        resolve_application(vec![self_cycle]).unwrap_err(),
        ExtensionError::DependencyCycle {
            path: vec![plugin_id("plugin.self"), plugin_id("plugin.self")]
        }
    );

    let plugins = vec![
        cycle_plugin("plugin.a", "service.a", "service.c"),
        cycle_plugin("plugin.b", "service.b", "service.a"),
        cycle_plugin("plugin.c", "service.c", "service.b"),
    ];
    assert_eq!(
        resolve_application(plugins).unwrap_err(),
        ExtensionError::DependencyCycle {
            path: vec![
                plugin_id("plugin.a"),
                plugin_id("plugin.b"),
                plugin_id("plugin.c"),
                plugin_id("plugin.a"),
            ]
        }
    );
}

#[test]
fn lexicographically_smallest_cyclic_scc_is_selected() {
    let plugins = vec![
        cycle_plugin("plugin.z-a", "service.z-a", "service.z-b"),
        cycle_plugin("plugin.z-b", "service.z-b", "service.z-a"),
        cycle_plugin("plugin.a-a", "service.a-a", "service.a-c"),
        cycle_plugin("plugin.a-b", "service.a-b", "service.a-a"),
        cycle_plugin("plugin.a-c", "service.a-c", "service.a-b"),
    ];
    assert_eq!(
        resolve_application(plugins).unwrap_err(),
        ExtensionError::DependencyCycle {
            path: vec![
                plugin_id("plugin.a-a"),
                plugin_id("plugin.a-b"),
                plugin_id("plugin.a-c"),
                plugin_id("plugin.a-a"),
            ]
        }
    );
}

#[test]
fn descriptor_and_declaration_permutations_produce_identical_plan_bytes() {
    let mut provider = descriptor("plugin.provider", ScopePolicy::application_kind());
    provider.provides = vec![declaration("service.z", 1), declaration("service.a", 1)];
    let mut consumer = descriptor("plugin.consumer", ScopePolicy::application_kind());
    consumer.requires = vec![requirement("service.z", 1), requirement("service.a", 1)];
    consumer.optional = vec![
        requirement("service.missing-z", 1),
        requirement("service.missing-a", 1),
    ];

    let first = resolve_application(vec![provider.clone(), consumer.clone()]).unwrap();
    provider.provides.reverse();
    consumer.requires.reverse();
    consumer.optional.reverse();
    let second = resolve_application(vec![consumer, provider]).unwrap();

    assert_eq!(first, second);
    assert_eq!(
        serde_json::to_vec(&first).unwrap(),
        serde_json::to_vec(&second).unwrap()
    );
    assert_eq!(first.diagnostics(), second.diagnostics());
}

#[test]
fn descriptor_permutations_produce_identical_errors_and_diagnostics() {
    let mut a = descriptor("plugin.a", ScopePolicy::application_kind());
    a.provides = vec![declaration("service.same", 1)];
    let mut z = descriptor("plugin.z", ScopePolicy::application_kind());
    z.provides = vec![declaration("service.same", 1)];

    let first = resolve_application(vec![a.clone(), z.clone()]).unwrap_err();
    let second = resolve_application(vec![z, a]).unwrap_err();
    assert_eq!(first, second);
    assert_eq!(first.to_diagnostic(), second.to_diagnostic());
    assert_eq!(
        serde_json::to_vec(&first).unwrap(),
        serde_json::to_vec(&second).unwrap()
    );

    let a = cycle_plugin("plugin.a", "service.a", "service.c");
    let b = cycle_plugin("plugin.b", "service.b", "service.a");
    let c = cycle_plugin("plugin.c", "service.c", "service.b");
    let permutations = vec![
        vec![a.clone(), b.clone(), c.clone()],
        vec![a.clone(), c.clone(), b.clone()],
        vec![b.clone(), a.clone(), c.clone()],
        vec![b.clone(), c.clone(), a.clone()],
        vec![c.clone(), a.clone(), b.clone()],
        vec![c, b, a],
    ];
    let first = resolve_application(permutations[0].clone()).unwrap_err();
    for permutation in permutations {
        let error = resolve_application(permutation).unwrap_err();
        assert_eq!(first, error);
        assert_eq!(first.to_diagnostic(), error.to_diagnostic());
    }
}

#[test]
fn competing_resolution_errors_use_sorted_plugin_and_capability_order() {
    let mut z = descriptor("plugin.z", ScopePolicy::application_kind());
    z.requires = vec![requirement("service.a", 1)];
    let mut a = descriptor("plugin.a", ScopePolicy::application_kind());
    a.requires = vec![requirement("service.z", 1), requirement("service.a", 1)];

    assert_eq!(
        resolve_application(vec![z, a]).unwrap_err(),
        ExtensionError::MissingRequiredCapability {
            plugin_id: plugin_id("plugin.a"),
            capability_id: capability_id("service.a"),
            required_major: 1,
        }
    );

    let mut a = descriptor("plugin.provider-a", ScopePolicy::application_kind());
    a.provides = vec![declaration("service.z", 1), declaration("service.a", 1)];
    let mut z = descriptor("plugin.provider-z", ScopePolicy::application_kind());
    z.provides = vec![declaration("service.a", 1), declaration("service.z", 1)];
    assert!(matches!(
        resolve_application(vec![z, a]),
        Err(ExtensionError::DuplicateProvider {
            capability_id: duplicate_capability,
            ..
        }) if duplicate_capability == capability_id("service.a")
    ));
}

#[test]
fn provider_configuration_instances_do_not_enter_the_dependency_graph() {
    fn resolve_with_product_instances(instances: &[&str]) -> ActivationPlan {
        assert!(!instances.is_empty());
        let mut provider = descriptor("plugin.provider", ScopePolicy::application_kind());
        provider.provides = vec![declaration("service.configured", 1)];
        let mut consumer = descriptor("plugin.consumer", ScopePolicy::application_kind());
        consumer.requires = vec![requirement("service.configured", 1)];
        resolve_application(vec![provider, consumer]).unwrap()
    }

    let one = resolve_with_product_instances(&["instance.a"]);
    let many = resolve_with_product_instances(&["instance.a", "instance.b", "instance.c"]);
    assert_eq!(one, many);
    assert_eq!(one.activation_order().len(), 2);
}

#[test]
fn capability_descriptors_do_not_encode_permissions_or_broker_authority() {
    let mut provider = descriptor("plugin.provider", ScopePolicy::application_kind());
    provider.provides = vec![declaration("tool.workspace.snapshot", 1)];
    let json = serde_json::to_value(provider).unwrap();
    let object = json.as_object().unwrap();
    assert!(!object.contains_key("permissions"));
    assert!(!object.contains_key("broker"));
    assert!(!object.contains_key("operations"));

    let operation = OperationId::new("workspace.snapshot").unwrap();
    assert_eq!(operation.as_str(), "workspace.snapshot");
}

#[test]
fn plugin_and_declaration_count_boundaries_are_enforced() {
    let descriptors: Vec<_> = (0..MAX_PLUGINS_PER_SCOPE)
        .map(|index| {
            descriptor(
                &format!("plugin.{index:03}"),
                ScopePolicy::application_kind(),
            )
        })
        .collect();
    assert_eq!(
        resolve_application(descriptors.clone())
            .unwrap()
            .activation_order()
            .len(),
        MAX_PLUGINS_PER_SCOPE
    );
    let mut too_many = descriptors;
    too_many.push(descriptor(
        "plugin.overflow",
        ScopePolicy::application_kind(),
    ));
    assert!(matches!(
        resolve_application(too_many),
        Err(ExtensionError::LimitExceeded {
            limit: LimitKind::PluginsPerScope,
            actual,
            maximum,
            ..
        }) if actual == MAX_PLUGINS_PER_SCOPE + 1 && maximum == MAX_PLUGINS_PER_SCOPE
    ));

    let capabilities: Vec<_> = (0..MAX_PROVIDES_PER_PLUGIN)
        .map(|index| declaration(&format!("service.{index:02}"), 1))
        .collect();
    let mut provider = descriptor("plugin.provider", ScopePolicy::application_kind());
    provider.provides = capabilities.clone();
    resolve_application(vec![provider]).unwrap();
    let mut provider = descriptor("plugin.provider", ScopePolicy::application_kind());
    provider.provides = capabilities
        .into_iter()
        .chain([declaration("service.overflow", 1)])
        .collect();
    assert!(matches!(
        resolve_application(vec![provider]),
        Err(ExtensionError::LimitExceeded {
            limit: LimitKind::ProvidesPerPlugin,
            actual,
            maximum,
            ..
        }) if actual == MAX_PROVIDES_PER_PLUGIN + 1 && maximum == MAX_PROVIDES_PER_PLUGIN
    ));
}

#[test]
fn required_and_optional_count_boundaries_are_enforced() {
    let declarations: Vec<_> = (0..MAX_REQUIRED_PER_PLUGIN)
        .map(|index| declaration(&format!("service.{index:02}"), 1))
        .collect();
    let requirements: Vec<_> = (0..MAX_REQUIRED_PER_PLUGIN)
        .map(|index| requirement(&format!("service.{index:02}"), 1))
        .collect();
    let mut provider = descriptor("plugin.provider", ScopePolicy::application_kind());
    provider.provides = declarations;
    let mut consumer = descriptor("plugin.consumer", ScopePolicy::application_kind());
    consumer.requires = requirements.clone();
    resolve_application(vec![provider, consumer]).unwrap();

    let mut consumer = descriptor("plugin.consumer", ScopePolicy::application_kind());
    consumer.requires = requirements
        .into_iter()
        .chain([requirement("service.overflow", 1)])
        .collect();
    assert!(matches!(
        resolve_application(vec![consumer]),
        Err(ExtensionError::LimitExceeded {
            limit: LimitKind::RequiredPerPlugin,
            actual,
            maximum,
            ..
        }) if actual == MAX_REQUIRED_PER_PLUGIN + 1 && maximum == MAX_REQUIRED_PER_PLUGIN
    ));

    let optional: Vec<_> = (0..MAX_OPTIONAL_PER_PLUGIN)
        .map(|index| requirement(&format!("optional.{index:02}"), 1))
        .collect();
    let mut consumer = descriptor("plugin.consumer", ScopePolicy::application_kind());
    consumer.optional = optional.clone();
    assert_eq!(
        resolve_application(vec![consumer])
            .unwrap()
            .diagnostics()
            .len(),
        MAX_OPTIONAL_PER_PLUGIN
    );
    let mut consumer = descriptor("plugin.consumer", ScopePolicy::application_kind());
    consumer.optional = optional
        .into_iter()
        .chain([requirement("optional.overflow", 1)])
        .collect();
    assert!(matches!(
        resolve_application(vec![consumer]),
        Err(ExtensionError::LimitExceeded {
            limit: LimitKind::OptionalPerPlugin,
            actual,
            maximum,
            ..
        }) if actual == MAX_OPTIONAL_PER_PLUGIN + 1 && maximum == MAX_OPTIONAL_PER_PLUGIN
    ));
}

fn edge_budget_inventory(edge_count: usize) -> Vec<PluginDescriptor> {
    let capability_count = MAX_PROVIDES_PER_PLUGIN;
    let declarations: Vec<_> = (0..capability_count)
        .map(|index| declaration(&format!("edge.{index:02}"), 1))
        .collect();
    let requirements: Vec<_> = (0..capability_count)
        .map(|index| requirement(&format!("edge.{index:02}"), 1))
        .collect();

    let mut provider = descriptor("plugin.provider", ScopePolicy::application_kind());
    provider.provides = declarations;
    let mut descriptors = vec![provider];
    let full_consumers = edge_count / capability_count;
    let remainder = edge_count % capability_count;
    for index in 0..full_consumers {
        let mut consumer = descriptor(
            &format!("plugin.consumer.{index:03}"),
            ScopePolicy::application_kind(),
        );
        consumer.requires = requirements.clone();
        descriptors.push(consumer);
    }
    if remainder > 0 {
        let mut consumer = descriptor(
            &format!("plugin.consumer.{full_consumers:03}"),
            ScopePolicy::application_kind(),
        );
        consumer.requires = requirements[..remainder].to_vec();
        descriptors.push(consumer);
    }
    descriptors
}

#[test]
fn resolved_edge_budget_accepts_8192_and_rejects_8193() {
    let boundary = resolve_application(edge_budget_inventory(MAX_RESOLVED_EDGES)).unwrap();
    assert_eq!(boundary.activation_order().len(), 129);

    assert!(matches!(
        resolve_application(edge_budget_inventory(MAX_RESOLVED_EDGES + 1)),
        Err(ExtensionError::LimitExceeded {
            limit: LimitKind::ResolvedEdges,
            actual,
            maximum,
            ..
        }) if actual == MAX_RESOLVED_EDGES + 1 && maximum == MAX_RESOLVED_EDGES
    ));
}

#[test]
fn core_contracts_round_trip_and_plan_serialization_is_deterministic() {
    let mut consumer = descriptor("plugin.consumer", ScopePolicy::application_kind());
    consumer.optional = vec![requirement("service.optional", 1)];
    let plan = resolve_application(vec![consumer]).unwrap();
    let encoded = serde_json::to_string(&plan).unwrap();
    assert_eq!(encoded, serde_json::to_string(&plan).unwrap());

    let error = ExtensionError::MissingRequiredCapability {
        plugin_id: plugin_id("plugin.consumer"),
        capability_id: capability_id("service.required"),
        required_major: 1,
    };
    let encoded = serde_json::to_string(&error).unwrap();
    let decoded: ExtensionError = serde_json::from_str(&encoded).unwrap();
    assert_eq!(decoded, error);

    let diagnostic = error.to_diagnostic();
    let encoded = serde_json::to_string(&diagnostic).unwrap();
    assert_eq!(
        serde_json::from_str::<rho_extension_runtime::ExtensionDiagnostic>(&encoded).unwrap(),
        diagnostic
    );
}
