use rho_protocol::{CanonicalEventType, EventPriority, SemanticEventPayload};
use thiserror::Error;

#[derive(Debug, Error, Clone, PartialEq, Eq)]
pub enum SecurityEventError {
    #[error("security event code is invalid")]
    InvalidCode,
}

pub fn security_violation_payload(
    policy_id: &str,
    reason_code: &str,
) -> Result<SemanticEventPayload, SecurityEventError> {
    if !valid_code(policy_id) || !valid_code(reason_code) {
        return Err(SecurityEventError::InvalidCode);
    }
    Ok(SemanticEventPayload::SecurityViolation {
        policy_id: policy_id.to_string(),
        reason_code: reason_code.to_string(),
    })
}

pub fn security_violation_priority() -> EventPriority {
    CanonicalEventType::SecurityViolation.registry().priority
}

fn valid_code(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value.chars().all(|character| {
            character.is_ascii_lowercase() || character.is_ascii_digit() || character == '_'
        })
}
