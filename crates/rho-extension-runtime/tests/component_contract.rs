use rho_extension_runtime::{
    AdmittedComponentPlugin, HostProtocolErrorCode, MAX_WASM_COMPONENT_BYTES,
};

fn component(wat: &str) -> Vec<u8> {
    wat::parse_str(wat).expect("component fixture must compile")
}

#[test]
fn admits_a_well_formed_zero_import_component_deterministically() {
    let bytes = component("(component)");
    let first = AdmittedComponentPlugin::from_bytes(&bytes).unwrap();
    let second = AdmittedComponentPlugin::from_bytes(&bytes).unwrap();

    assert_eq!(first.digest(), second.digest());
}

#[test]
fn rejects_malformed_and_core_wasm_binaries() {
    let malformed = AdmittedComponentPlugin::from_bytes(b"not wasm").unwrap_err();
    assert_eq!(malformed.code, HostProtocolErrorCode::InvalidModule);

    let core = wat::parse_str("(module)").unwrap();
    let core_error = AdmittedComponentPlugin::from_bytes(&core).unwrap_err();
    assert_eq!(core_error.code, HostProtocolErrorCode::InvalidModule);
}

#[test]
fn rejects_every_component_level_import_before_execution() {
    let bytes = component(r#"(component (import "danger" (func)))"#);
    let error = AdmittedComponentPlugin::from_bytes(&bytes).unwrap_err();

    assert_eq!(error.code, HostProtocolErrorCode::ForbiddenImport);
}

#[test]
fn rejects_oversized_input_before_compilation() {
    let bytes = vec![0; MAX_WASM_COMPONENT_BYTES + 1];
    let error = AdmittedComponentPlugin::from_bytes(&bytes).unwrap_err();

    assert_eq!(error.code, HostProtocolErrorCode::ModuleTooLarge);
}
