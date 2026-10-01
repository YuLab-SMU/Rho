#![forbid(unsafe_code)]
//! Version-bound notes, immutable evidence, CAS revisions and idempotent receipts.
//! Admission is a containing runtime responsibility; this owner never reads or writes sources.
mod annotations;
pub use annotations::*;
use rho_annotation_api::AnnotationWindowRef;
use serde::Serialize;
use serde_json::Value;
use sha2::{Digest, Sha256};
use thiserror::Error;

#[derive(Debug, Clone, Error, PartialEq, Eq)]
pub enum AnnotationError {
    #[error("invalid annotation request: {0}")]
    InvalidInput(String),
    #[error("annotation resource is not available to this principal")]
    NotFound,
    #[error("the annotation resource changed; input was not overwritten")]
    Conflict,
    #[error("this request ID was already used with different input")]
    RequestConflict,
    #[error("annotation budget exhausted: {0}")]
    Budget(String),
    #[error("annotation storage failed: {0}")]
    Storage(String),
}

/// Trusted containing runtime scope. Never deserialize this from request arguments.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AnnotationScope {
    pub project: String,
    pub principal: String,
}

/// Captured authority after the containing boundary checks its live caller and window.
/// A value of this type cannot perform dispatch, open a window or expand a source scope.
pub struct AnnotationActor {
    scope: AnnotationScope,
    window: AnnotationWindowRef,
}
impl AnnotationActor {
    pub fn admitted(scope: AnnotationScope, window: AnnotationWindowRef) -> Self {
        Self { scope, window }
    }
    pub fn scope(&self) -> &AnnotationScope {
        &self.scope
    }
    pub fn window(&self) -> &AnnotationWindowRef {
        &self.window
    }
}

pub fn sha256(bytes: impl AsRef<[u8]>) -> String {
    format!("sha256:{:x}", Sha256::digest(bytes.as_ref()))
}

/// Canonical JSON identity remains stable across map insertion order and feature sets.
pub fn annotation_digest(value: &impl Serialize) -> Result<String, AnnotationError> {
    fn canonical(value: Value) -> Value {
        match value {
            Value::Object(map) => Value::Object(
                map.into_iter()
                    .map(|(key, value)| (key, canonical(value)))
                    .collect::<std::collections::BTreeMap<_, _>>()
                    .into_iter()
                    .collect(),
            ),
            Value::Array(values) => Value::Array(values.into_iter().map(canonical).collect()),
            other => other,
        }
    }
    let value = serde_json::to_value(value).map_err(|e| AnnotationError::Storage(e.to_string()))?;
    let bytes = serde_json::to_vec(&canonical(value))
        .map_err(|e| AnnotationError::Storage(e.to_string()))?;
    Ok(format!("{:x}", Sha256::digest(bytes)))
}
