use rho_ui_contract::*;
use serde_json::json;

#[test]
fn provider_capability_fixtures_validate_and_external_is_read_only() {
    let first = first_party_provider_capabilities_fixture();
    first.validate().unwrap();
    let external = external_observer_capabilities_fixture();
    external.validate().unwrap();
    assert!(external.read_only);
    assert!(!external.features.contains(&ProviderFeatureV1::Plan));
    assert!(!external.features.contains(&ProviderFeatureV1::Resume));
    assert!(!external.features.contains(&ProviderFeatureV1::Config));
    assert!(external.config_options.is_empty());
}

#[test]
fn provider_config_stale_snapshot_and_unknown_option_fail_closed() {
    let capabilities = first_party_provider_capabilities_fixture();
    let stale = ProviderConfigUpdateV1 {
        expected_capability_snapshot_id: "stale_snapshot".to_string(),
        values: json!({"model":"fast"}),
    };
    assert!(stale.validate_against(&capabilities).is_err());
    let unknown = ProviderConfigUpdateV1 {
        expected_capability_snapshot_id: capabilities.capability_snapshot_id.clone(),
        values: json!({"provider_private_option":"value"}),
    };
    assert!(unknown.validate_against(&capabilities).is_err());
    let valid = ProviderConfigUpdateV1 {
        expected_capability_snapshot_id: capabilities.capability_snapshot_id.clone(),
        values: json!({"model":"fast"}),
    };
    valid.validate_against(&capabilities).unwrap();
}

#[test]
fn provider_switch_does_not_change_permission_or_egress_posture() {
    let first = first_party_provider_capabilities_fixture();
    let external = external_observer_capabilities_fixture();
    assert_eq!(first.permission_posture, external.permission_posture);
    assert_eq!(first.data_egress, external.data_egress);
}
