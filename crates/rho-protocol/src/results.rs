use serde::{Deserialize, Serialize};
use serde_json::Value;
use thiserror::Error;

use crate::{
    ArtifactDigest, ArtifactId, CapabilityId, DataClass, EventId, EventPriority, RevisionStamp,
    data_classification::{ClassificationError, ClassifiedSource, combine_classifications},
};

pub const DECLASSIFICATION_CAPABILITY_ID: &str = "information.declassify.reviewed";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ResultSourceProvenance {
    Observation {
        event_id: EventId,
        revision: RevisionStamp,
    },
    Artifact {
        artifact_id: ArtifactId,
        digest: ArtifactDigest,
    },
    CapabilityResult {
        result_id: String,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct UntrustedCapabilityResult {
    pub result_id: String,
    pub capability_id: CapabilityId,
    pub payload: Value,
    pub data_class: Option<DataClass>,
    pub provenance: Vec<ResultSourceProvenance>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct CapabilityResultEnvelope {
    pub result_id: String,
    pub capability_id: CapabilityId,
    pub payload: Value,
    pub data_class: DataClass,
    pub provenance: Vec<ResultSourceProvenance>,
    pub source_classifications: Vec<ClassifiedSource>,
}

impl TryFrom<UntrustedCapabilityResult> for CapabilityResultEnvelope {
    type Error = ResultEnvelopeError;

    fn try_from(value: UntrustedCapabilityResult) -> Result<Self, Self::Error> {
        let data_class = value
            .data_class
            .ok_or(ResultEnvelopeError::MissingClassification)?;
        if value.result_id.is_empty() || value.provenance.is_empty() {
            return Err(ResultEnvelopeError::MissingProvenance);
        }
        Ok(Self {
            source_classifications: vec![ClassifiedSource {
                source_id: value.result_id.clone(),
                data_class,
            }],
            result_id: value.result_id,
            capability_id: value.capability_id,
            payload: value.payload,
            data_class,
            provenance: value.provenance,
        })
    }
}

impl CapabilityResultEnvelope {
    pub fn derived(
        result_id: impl Into<String>,
        capability_id: CapabilityId,
        payload: Value,
        inputs: &[CapabilityResultEnvelope],
    ) -> Result<Self, ResultEnvelopeError> {
        if inputs.is_empty() {
            return Err(ResultEnvelopeError::MissingProvenance);
        }
        let source_classifications = inputs
            .iter()
            .flat_map(|input| input.source_classifications.clone())
            .collect::<Vec<_>>();
        let data_class = combine_classifications(&source_classifications)?;
        let provenance = inputs
            .iter()
            .map(|input| ResultSourceProvenance::CapabilityResult {
                result_id: input.result_id.clone(),
            })
            .collect();
        Ok(Self {
            result_id: result_id.into(),
            capability_id,
            payload,
            data_class,
            provenance,
            source_classifications,
        })
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct DeclassificationAttestation {
    pub attestation_id: String,
    pub capability_id: CapabilityId,
    pub from: DataClass,
    pub to: DataClass,
    pub priority: EventPriority,
    pub policy_id: String,
    pub reason_code: String,
}

#[derive(Debug, Error, Clone, PartialEq, Eq)]
pub enum ResultEnvelopeError {
    #[error("capability result classification is missing")]
    MissingClassification,
    #[error("capability result provenance is missing")]
    MissingProvenance,
    #[error("classification combine failed: {0}")]
    Classification(#[from] ClassificationError),
    #[error("declassification requires an explicit reviewed P0/P1 attestation")]
    InvalidDeclassification,
}

pub fn apply_declassification(
    result: &CapabilityResultEnvelope,
    attestation: &DeclassificationAttestation,
) -> Result<CapabilityResultEnvelope, ResultEnvelopeError> {
    if attestation.capability_id.as_str() != DECLASSIFICATION_CAPABILITY_ID
        || attestation.from != result.data_class
        || attestation.to >= attestation.from
        || !matches!(attestation.priority, EventPriority::P0 | EventPriority::P1)
        || attestation.attestation_id.is_empty()
        || attestation.policy_id.is_empty()
    {
        return Err(ResultEnvelopeError::InvalidDeclassification);
    }
    let mut result = result.clone();
    result.data_class = attestation.to;
    result.source_classifications = vec![ClassifiedSource {
        source_id: attestation.attestation_id.clone(),
        data_class: attestation.to,
    }];
    Ok(result)
}
