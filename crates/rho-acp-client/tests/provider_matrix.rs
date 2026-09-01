use serde_json::Value;

#[test]
fn provider_matrix_contains_only_external_executable_observations() {
    let matrix: Value =
        serde_json::from_slice(include_bytes!("providers/live-matrix.json")).unwrap();
    assert_eq!(matrix["schema"], "rho.provider-matrix.live.v1");
    let providers = matrix["providers"].as_array().unwrap();
    assert!(!providers.is_empty());
    for provider in providers {
        assert!(provider["provider_id"].as_str().is_some());
        assert!(provider["executable_name"].as_str().is_some());
        assert!(
            provider["executable_sha256"]
                .as_str()
                .is_some_and(|digest| digest.starts_with("sha256:"))
        );
        assert!(provider["protocol"].as_str().is_some());
        assert!(provider["support_tier"].as_str().is_some());
        assert!(provider.get("model_provider").is_none());
        assert!(provider.get("tool_harness").is_none());
    }
}
