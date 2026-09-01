use std::collections::BTreeMap;

use rho_protocol::{
    CapabilityId, CapabilityResultEnvelope, DataClass, DeclassificationAttestation,
    UntrustedCapabilityResult, apply_declassification,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use thiserror::Error;

use crate::{EgressDecisionKind, EgressPolicyMode, EgressPolicyRequest, evaluate_egress};

#[derive(Debug, Error, Clone, PartialEq, Eq)]
pub enum InformationFlowError {
    #[error("capability result is missing/unknown classification or provenance")]
    InvalidResult,
    #[error("read-set result {0} is missing")]
    MissingReadResult(String),
    #[error("derived result has no inputs")]
    EmptyReadSet,
    #[error("declassification failed")]
    Declassification,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ArtifactSensitivity {
    pub artifact_id: String,
    pub data_class: DataClass,
    pub input_result_ids: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct InformationFlowDecision {
    pub decision: EgressDecisionKind,
    pub reason_code: String,
    pub effective_data_class: DataClass,
    pub read_set: Vec<String>,
    pub destination_origin: String,
    pub provider_id: String,
    pub user_summary: String,
}

#[derive(Debug, Clone)]
pub struct InformationFlowEgressRequest {
    pub read_result_ids: Vec<String>,
    pub destination_origin: String,
    pub provider_id: String,
    pub policy: EgressPolicyRequest,
}

#[derive(Debug, Default)]
pub struct InformationFlowEngine {
    results: BTreeMap<String, CapabilityResultEnvelope>,
}

impl InformationFlowEngine {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn admit_result(
        &mut self,
        result: UntrustedCapabilityResult,
    ) -> Result<&CapabilityResultEnvelope, InformationFlowError> {
        let result = CapabilityResultEnvelope::try_from(result)
            .map_err(|_| InformationFlowError::InvalidResult)?;
        let id = result.result_id.clone();
        self.results.insert(id.clone(), result);
        Ok(self.results.get(&id).expect("inserted result"))
    }

    pub fn derive_result(
        &mut self,
        result_id: impl Into<String>,
        capability_id: CapabilityId,
        payload: Value,
        input_result_ids: &[String],
    ) -> Result<&CapabilityResultEnvelope, InformationFlowError> {
        if input_result_ids.is_empty() {
            return Err(InformationFlowError::EmptyReadSet);
        }
        let inputs = input_result_ids
            .iter()
            .map(|id| {
                self.results
                    .get(id)
                    .cloned()
                    .ok_or_else(|| InformationFlowError::MissingReadResult(id.clone()))
            })
            .collect::<Result<Vec<_>, _>>()?;
        let result = CapabilityResultEnvelope::derived(result_id, capability_id, payload, &inputs)
            .map_err(|_| InformationFlowError::InvalidResult)?;
        let id = result.result_id.clone();
        self.results.insert(id.clone(), result);
        Ok(self.results.get(&id).expect("inserted result"))
    }

    pub fn declassify(
        &mut self,
        source_result_id: &str,
        new_result_id: impl Into<String>,
        attestation: &DeclassificationAttestation,
    ) -> Result<&CapabilityResultEnvelope, InformationFlowError> {
        let source = self
            .results
            .get(source_result_id)
            .ok_or_else(|| InformationFlowError::MissingReadResult(source_result_id.to_string()))?;
        let mut declassified = apply_declassification(source, attestation)
            .map_err(|_| InformationFlowError::Declassification)?;
        declassified.result_id = new_result_id.into();
        let id = declassified.result_id.clone();
        self.results.insert(id.clone(), declassified);
        Ok(self.results.get(&id).expect("inserted result"))
    }

    pub fn artifact_sensitivity(
        &self,
        artifact_id: impl Into<String>,
        input_result_ids: &[String],
    ) -> Result<ArtifactSensitivity, InformationFlowError> {
        let data_class = self.effective_class(input_result_ids)?;
        Ok(ArtifactSensitivity {
            artifact_id: artifact_id.into(),
            data_class,
            input_result_ids: input_result_ids.to_vec(),
        })
    }

    pub fn evaluate_egress(
        &self,
        mut request: InformationFlowEgressRequest,
    ) -> Result<InformationFlowDecision, InformationFlowError> {
        let effective_data_class = self.effective_class(&request.read_result_ids)?;
        request.policy.data_class = effective_data_class;
        request.policy.destination_origin = request.destination_origin.clone();
        let decision = evaluate_egress(&request.policy);
        let read_count = request.read_result_ids.len();
        Ok(InformationFlowDecision {
            decision: decision.decision,
            reason_code: decision.reason_code,
            effective_data_class,
            read_set: request.read_result_ids,
            destination_origin: request.destination_origin,
            provider_id: request.provider_id,
            user_summary: format!(
                "{} data from {} source(s): {}",
                classification_label(effective_data_class),
                read_count,
                decision.user_summary
            ),
        })
    }

    pub fn telemetry_attributes(decision: &InformationFlowDecision) -> BTreeMap<String, String> {
        BTreeMap::from([
            (
                "data_class".to_string(),
                classification_label(decision.effective_data_class).to_string(),
            ),
            ("reason_code".to_string(), decision.reason_code.clone()),
            (
                "decision".to_string(),
                format!("{:?}", decision.decision).to_ascii_lowercase(),
            ),
        ])
    }

    pub fn result(&self, result_id: &str) -> Option<&CapabilityResultEnvelope> {
        self.results.get(result_id)
    }

    fn effective_class(&self, result_ids: &[String]) -> Result<DataClass, InformationFlowError> {
        let mut classes = result_ids.iter().map(|id| {
            self.results
                .get(id)
                .map(|result| result.data_class)
                .ok_or_else(|| InformationFlowError::MissingReadResult(id.clone()))
        });
        let first = classes.next().ok_or(InformationFlowError::EmptyReadSet)??;
        classes.try_fold(first, |combined, next| Ok(combined.join(next?)))
    }
}

fn classification_label(value: DataClass) -> &'static str {
    match value {
        DataClass::Public => "public",
        DataClass::ProjectInternal => "project_internal",
        DataClass::ProjectConfidential => "project_confidential",
        DataClass::RestrictedSecret => "restricted_secret",
    }
}

pub fn default_confidential_egress_policy() -> EgressPolicyMode {
    EgressPolicyMode::Deny
}

pub fn information_flow_boundary() -> (&'static [&'static str], &'static [&'static str]) {
    (
        &[
            "result_label",
            "source_provenance",
            "strict_combine",
            "egress_read_set",
            "declassification_evidence",
        ],
        &[
            "payload_based_declassification",
            "agent_label_override",
            "unknown_label_allow",
            "telemetry_payload",
            "ui_payload_explanation",
        ],
    )
}
