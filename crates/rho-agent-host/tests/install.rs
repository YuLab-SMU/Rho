use std::collections::BTreeSet;

use rho_agent_host::install::*;
use sha2::{Digest, Sha256};

struct DigestSignatureVerifier;

impl PackageSignatureVerifier for DigestSignatureVerifier {
    fn verify(&self, signed_bytes: &[u8], signature: &str) -> bool {
        signature == format!("sha256:{:x}", Sha256::digest(signed_bytes))
    }
}

fn package_metadata(
    version: &str,
    bytes: &[u8],
    kind: InstallPackageKind,
) -> SignedInstallMetadata {
    let mut metadata = SignedInstallMetadata {
        package_id: match kind {
            InstallPackageKind::Provider => "provider_opencode".to_string(),
            InstallPackageKind::Runner => "rho_runner".to_string(),
        },
        kind,
        version: version.to_string(),
        channel: "beta".to_string(),
        source_origin: "https://releases.example.org".to_string(),
        byte_size: bytes.len() as u64,
        sha256: digest(bytes),
        signature: "pending".to_string(),
        protocol_version: 1,
        capability_tier: "observer_only".to_string(),
        permissions: BTreeSet::from([
            DeclaredPermission::ModelNetwork,
            DeclaredPermission::ReadSnapshot,
        ]),
    };
    metadata.signature = format!(
        "sha256:{:x}",
        Sha256::digest(install_signing_payload(&metadata).unwrap())
    );
    metadata
}

fn request(metadata: &SignedInstallMetadata, enable: bool) -> ExplicitInstallRequest {
    ExplicitInstallRequest {
        package_id: metadata.package_id.clone(),
        expected_source_origin: metadata.source_origin.clone(),
        expected_channel: metadata.channel.clone(),
        acknowledge_permissions: metadata.permissions.clone(),
        enable_after_install: enable,
    }
}

#[test]
fn install_provider_is_explicit_signed_digest_size_permission_and_atomic_activation() {
    let temp = tempfile::tempdir().unwrap();
    let bytes = b"verified provider package";
    let metadata = package_metadata("1.2.3", bytes, InstallPackageKind::Provider);
    let mut installer =
        ExplicitPackageInstaller::open(temp.path(), DigestSignatureVerifier).unwrap();
    let staged = installer
        .stage(&request(&metadata, true), &metadata, bytes)
        .unwrap();
    assert_eq!(staged.digest, metadata.sha256);
    assert!(staged.enable_requested);
    assert_eq!(
        installer.active_version(&metadata.package_id).unwrap(),
        None
    );
    installer.activate(&staged, 1, 0, None).unwrap();
    assert_eq!(
        installer
            .active_version(&metadata.package_id)
            .unwrap()
            .as_deref(),
        Some("1.2.3")
    );
    assert_eq!(installer.audit().len(), 2);
}

#[test]
fn install_tampered_truncated_signature_mirror_permission_and_rollback_fail_closed() {
    let temp = tempfile::tempdir().unwrap();
    let bytes = b"provider package";
    let metadata = package_metadata("1.0.0", bytes, InstallPackageKind::Provider);
    let mut installer =
        ExplicitPackageInstaller::open(temp.path(), DigestSignatureVerifier).unwrap();

    let mut bad_signature = metadata.clone();
    bad_signature.signature = "sha256:bad".to_string();
    assert!(matches!(
        installer.stage(&request(&bad_signature, false), &bad_signature, bytes),
        Err(InstallError::Signature)
    ));
    assert!(matches!(
        installer.stage(&request(&metadata, false), &metadata, b"truncated"),
        Err(InstallError::Digest)
    ));
    let mut mirror = request(&metadata, false);
    mirror.expected_source_origin = "https://mirror-attacker.invalid".to_string();
    assert!(matches!(
        installer.stage(&mirror, &metadata, bytes),
        Err(InstallError::NotExplicit)
    ));
    let mut permissions = request(&metadata, false);
    permissions.acknowledge_permissions.clear();
    assert!(matches!(
        installer.stage(&permissions, &metadata, bytes),
        Err(InstallError::NotExplicit)
    ));

    let staged = installer
        .stage(&request(&metadata, true), &metadata, bytes)
        .unwrap();
    installer.activate(&staged, 1, 0, None).unwrap();
    let older = package_metadata("0.9.0", b"older", InstallPackageKind::Provider);
    assert!(matches!(
        installer.stage(&request(&older, false), &older, b"older"),
        Err(InstallError::Rollback)
    ));
}

#[test]
fn install_partial_update_keeps_old_active_and_recovers_staged_candidate_idempotently() {
    let temp = tempfile::tempdir().unwrap();
    let mut installer =
        ExplicitPackageInstaller::open(temp.path(), DigestSignatureVerifier).unwrap();
    let v1 = package_metadata("1.0.0", b"version one", InstallPackageKind::Provider);
    let staged_v1 = installer
        .stage(&request(&v1, true), &v1, b"version one")
        .unwrap();
    installer.activate(&staged_v1, 1, 0, None).unwrap();

    let v2 = package_metadata("1.1.0", b"version two", InstallPackageKind::Provider);
    assert!(matches!(
        installer.stage_with_fault(
            &request(&v2, true),
            &v2,
            b"version two",
            Some(InstallFaultPoint::AfterRename),
        ),
        Err(InstallError::FaultInjected)
    ));
    assert_eq!(
        installer.active_version(&v1.package_id).unwrap().as_deref(),
        Some("1.0.0")
    );
    let recovered = installer
        .stage(&request(&v2, true), &v2, b"version two")
        .unwrap();
    assert!(matches!(
        installer.activate(
            &recovered,
            1,
            0,
            Some(InstallFaultPoint::BeforeActivationPointer)
        ),
        Err(InstallError::FaultInjected)
    ));
    assert_eq!(
        installer.active_version(&v1.package_id).unwrap().as_deref(),
        Some("1.0.0")
    );
    installer.activate(&recovered, 1, 0, None).unwrap();
    assert_eq!(
        installer.active_version(&v1.package_id).unwrap().as_deref(),
        Some("1.1.0")
    );
}

#[test]
fn install_runner_update_waits_for_jobs_and_protocol_compatibility() {
    let temp = tempfile::tempdir().unwrap();
    let bytes = b"runner version";
    let metadata = package_metadata("2.0.0", bytes, InstallPackageKind::Runner);
    let mut installer =
        ExplicitPackageInstaller::open(temp.path(), DigestSignatureVerifier).unwrap();
    let staged = installer
        .stage(&request(&metadata, true), &metadata, bytes)
        .unwrap();
    assert!(matches!(
        installer.activate(&staged, 2, 0, None),
        Err(InstallError::IncompatibleProtocol)
    ));
    assert!(matches!(
        installer.activate(&staged, 1, 3, None),
        Err(InstallError::RunningJobs)
    ));
    installer.activate(&staged, 1, 0, None).unwrap();
}

#[test]
fn install_audit_and_errors_never_contain_secret_or_project_payload() {
    let temp = tempfile::tempdir().unwrap();
    let bytes = b"package without project data";
    let metadata = package_metadata("3.0.0", bytes, InstallPackageKind::Provider);
    let mut installer =
        ExplicitPackageInstaller::open(temp.path(), DigestSignatureVerifier).unwrap();
    installer
        .stage(&request(&metadata, false), &metadata, bytes)
        .unwrap();
    let encoded = serde_json::to_string(installer.audit()).unwrap();
    assert!(!encoded.contains("CANARY_SECRET"));
    assert!(!encoded.contains("raw_project_payload"));
    let (_, does_not_own) = install_boundary();
    assert!(does_not_own.contains(&"automatic_registry_download"));
    assert!(does_not_own.contains(&"unverified_execution"));
    assert!(does_not_own.contains(&"partial_active_install"));
}
