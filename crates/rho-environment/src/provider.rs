use rho_protocol::{
    AuthorityDigest, EnvironmentIdentityV1, EnvironmentVerificationProbeV1,
    MaterializedPackagePlanBodyV1, PackageActionV1, RuntimeRealizationV1, RuntimeRequirementV1,
};
use serde::{Deserialize, Serialize};
use thiserror::Error;

#[derive(Debug, Error, Clone, PartialEq, Eq)]
pub enum EnvironmentProviderError {
    #[error("Environment provider input is invalid: {0}")]
    InvalidInput(String),
    #[error("Environment provider observation is unavailable: {0}")]
    Unavailable(String),
    #[error("Environment provider response exceeds its bounded contract")]
    BoundExceeded,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct RuntimeCandidate {
    pub realization: RuntimeRealizationV1,
    pub observation_digest: AuthorityDigest,
    pub limitations: Vec<String>,
}

pub trait RuntimeProvider {
    fn provider_id(&self) -> &'static str;
    fn observe(
        &self,
        requirement: &RuntimeRequirementV1,
    ) -> Result<Vec<RuntimeCandidate>, EnvironmentProviderError>;
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct PackageResolution {
    pub environment: EnvironmentIdentityV1,
    pub actions: Vec<PackageActionV1>,
    pub artifact_digests: Vec<AuthorityDigest>,
    pub verification_probes: Vec<EnvironmentVerificationProbeV1>,
    pub provider_observation_digest: AuthorityDigest,
}

pub trait PackagePlanProvider {
    fn provider_id(&self) -> &'static str;
    fn resolve(
        &self,
        request: &MaterializedPackagePlanBodyV1,
    ) -> Result<PackageResolution, EnvironmentProviderError>;
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct EnvironmentVerification {
    pub probe: EnvironmentVerificationProbeV1,
    pub passed: bool,
    pub observation_digest: AuthorityDigest,
    pub limitations: Vec<String>,
}

pub trait EnvironmentVerifier {
    fn verifier_id(&self) -> &'static str;
    fn verify(
        &self,
        plan: &rho_protocol::MaterializedPackagePlanV1,
        observations: &[EnvironmentVerification],
    ) -> Result<AuthorityDigest, EnvironmentProviderError>;
}
