use rho_protocol::{CanonicalEventType, EventPriority, EventValidationError, SemanticEvent};
use serde::Serialize;

pub fn event_type_key(value: CanonicalEventType) -> String {
    json_string(value)
}

pub fn priority_key(value: EventPriority) -> String {
    json_string(value)
}

pub fn semantic_event_json(event: &SemanticEvent) -> Result<String, EventValidationError> {
    serde_json::to_string(event)
        .map_err(|error| EventValidationError::PayloadDecode(error.to_string()))
}

pub fn payload_json(event: &SemanticEvent) -> Result<String, EventValidationError> {
    serde_json::to_string(&event.payload)
        .map_err(|error| EventValidationError::PayloadDecode(error.to_string()))
}

fn json_string<T: Serialize>(value: T) -> String {
    serde_json::to_value(value)
        .expect("canonical enum serializes")
        .as_str()
        .expect("canonical enum serializes to string")
        .to_string()
}
