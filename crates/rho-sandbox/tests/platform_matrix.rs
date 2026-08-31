use std::collections::BTreeMap;

use rho_sandbox::platform::*;

fn mechanisms(all: bool) -> BTreeMap<SandboxGuarantee, String> {
    let guarantees = if all {
        required_mutation_guarantees()
    } else {
        vec![
            SandboxGuarantee::ProcessTreeControl,
            SandboxGuarantee::HandleIsolation,
        ]
    };
    guarantees
        .into_iter()
        .map(|guarantee| (guarantee, format!("verified:{guarantee:?}")))
        .collect()
}

#[test]
fn platform_matrix_linux_verified_advertises_mutation_and_oci_from_evidence() {
    let profile = PlatformSandboxProfile::from_evidence(PlatformEvidence {
        platform: SandboxPlatformKind::Linux,
        mechanisms: mechanisms(true),
        oci_rootless_verified: true,
        installer_permissions_verified: true,
        source: "linux-ci-real-host-report-sha256".to_string(),
    });
    assert!(profile.external_mutation_enabled);
    assert!(profile.oci_enabled);
    assert!(
        profile
            .advertised_capabilities()
            .contains(&"controlled_external_mutation")
    );
    assert!(profile.advertised_capabilities().contains(&"oci_execution"));
}

#[test]
fn platform_matrix_macos_missing_resource_guarantees_stays_observer() {
    let profile = PlatformSandboxProfile::from_evidence(PlatformEvidence {
        platform: SandboxPlatformKind::MacOs,
        mechanisms: mechanisms(false),
        oci_rootless_verified: false,
        installer_permissions_verified: true,
        source: "macos-real-host-report-sha256".to_string(),
    });
    assert!(!profile.external_mutation_enabled);
    assert!(!profile.oci_enabled);
    assert_eq!(profile.advertised_capabilities(), vec!["external_observer"]);
    assert!(!profile.unsupported.is_empty());
}

#[test]
fn platform_matrix_windows_unimplemented_guarantees_fail_closed_not_best_effort() {
    let profile = PlatformSandboxProfile::from_evidence(PlatformEvidence {
        platform: SandboxPlatformKind::Windows,
        mechanisms: BTreeMap::from([(
            SandboxGuarantee::ProcessTreeControl,
            "Windows Job Object integration test".to_string(),
        )]),
        oci_rootless_verified: false,
        installer_permissions_verified: false,
        source: "windows-ci-compile-and-fail-closed-report".to_string(),
    });
    assert!(!profile.external_mutation_enabled);
    assert!(!profile.oci_enabled);
    assert_eq!(profile.advertised_capabilities(), vec!["external_observer"]);
    assert!(profile.reason.contains("disabled"));
}

#[test]
fn platform_matrix_installer_permission_evidence_is_mandatory_even_with_mechanisms() {
    let profile = PlatformSandboxProfile::from_evidence(PlatformEvidence {
        platform: SandboxPlatformKind::Linux,
        mechanisms: mechanisms(true),
        oci_rootless_verified: true,
        installer_permissions_verified: false,
        source: "linux-mechanisms-without-installer-evidence".to_string(),
    });
    assert!(!profile.external_mutation_enabled);
    assert!(!profile.oci_enabled);
}

#[test]
fn platform_matrix_detected_profile_advertisement_matches_effective_guarantees() {
    let profile = PlatformSandboxProfile::detect();
    assert_eq!(
        profile.external_mutation_enabled,
        profile.unsupported.is_empty()
    );
    assert_eq!(
        profile
            .advertised_capabilities()
            .contains(&"controlled_external_mutation"),
        profile.external_mutation_enabled
    );
    if profile.oci_enabled {
        assert!(profile.external_mutation_enabled);
    }
}
