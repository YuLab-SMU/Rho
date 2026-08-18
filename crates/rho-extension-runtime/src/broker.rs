use std::{future::Future, pin::Pin};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use thiserror::Error;

use crate::OperationId;

pub const DEFAULT_BROKER_PAYLOAD_BYTES: usize = 1024 * 1024;
pub const WORKSPACE_SNAPSHOT_RESPONSE_BYTES: usize = 2 * 1024 * 1024;
pub const PROJECT_FILE_VIEWER_HTML_BYTES: usize = 32 * 1024 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BrokerResponseClass {
    Generic,
    WorkspaceSnapshot,
    ProjectFileViewerHtml,
}

impl BrokerResponseClass {
    pub fn maximum_bytes(self) -> usize {
        match self {
            Self::Generic => DEFAULT_BROKER_PAYLOAD_BYTES,
            Self::WorkspaceSnapshot => WORKSPACE_SNAPSHOT_RESPONSE_BYTES,
            Self::ProjectFileViewerHtml => PROJECT_FILE_VIEWER_HTML_BYTES,
        }
    }
}

#[derive(Debug, Error, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "error", rename_all = "snake_case")]
pub enum BrokerPayloadError {
    #[error("broker payload serialization failed")]
    Serialization,
    #[error("broker payload is too large: {actual_bytes} > {maximum_bytes}")]
    TooLarge {
        actual_bytes: usize,
        maximum_bytes: usize,
    },
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct BoundedJson {
    value: Value,
    encoded_bytes: usize,
}

impl BoundedJson {
    pub fn new(value: Value, maximum_bytes: usize) -> Result<Self, BrokerPayloadError> {
        let encoded_bytes = serde_json::to_vec(&value)
            .map_err(|_| BrokerPayloadError::Serialization)?
            .len();
        if encoded_bytes > maximum_bytes {
            return Err(BrokerPayloadError::TooLarge {
                actual_bytes: encoded_bytes,
                maximum_bytes,
            });
        }
        Ok(Self {
            value,
            encoded_bytes,
        })
    }

    pub fn generic(value: Value) -> Result<Self, BrokerPayloadError> {
        Self::new(value, DEFAULT_BROKER_PAYLOAD_BYTES)
    }

    pub fn value(&self) -> &Value {
        &self.value
    }

    pub fn into_value(self) -> Value {
        self.value
    }

    pub fn encoded_bytes(&self) -> usize {
        self.encoded_bytes
    }
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct BrokerRequest {
    pub operation_id: OperationId,
    pub payload: BoundedJson,
    pub response_class: BrokerResponseClass,
}

impl BrokerRequest {
    pub fn new(
        operation_id: OperationId,
        payload: Value,
        response_class: BrokerResponseClass,
    ) -> Result<Self, BrokerPayloadError> {
        Ok(Self {
            operation_id,
            payload: BoundedJson::generic(payload)?,
            response_class,
        })
    }

    pub fn maximum_response_bytes(&self) -> usize {
        self.response_class.maximum_bytes()
    }
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct BrokerResponse {
    pub payload: BoundedJson,
}

impl BrokerResponse {
    pub fn new(value: Value, request: &BrokerRequest) -> Result<Self, BrokerPayloadError> {
        Ok(Self {
            payload: BoundedJson::new(value, request.maximum_response_bytes())?,
        })
    }
}

#[derive(Debug, Error, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "error", rename_all = "snake_case")]
pub enum BrokerError {
    #[error(transparent)]
    Payload(#[from] BrokerPayloadError),
    #[error("broker operation is unavailable: {operation_id}")]
    Unavailable { operation_id: OperationId },
    #[error("broker operation failed: {code}: {message}")]
    Rejected { code: String, message: String },
}

impl BrokerError {
    pub fn rejected(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self::Rejected {
            code: bounded_broker_text(code),
            message: bounded_broker_text(message),
        }
    }
}

fn bounded_broker_text(value: impl Into<String>) -> String {
    const MAX_BYTES: usize = 512;
    let value = value.into();
    if value.len() <= MAX_BYTES {
        return value;
    }
    let suffix = "…";
    let mut end = MAX_BYTES - suffix.len();
    while !value.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}{}", &value[..end], suffix)
}

pub trait BrokerFacade: Send + Sync {
    fn call<'a>(
        &'a self,
        request: BrokerRequest,
    ) -> Pin<Box<dyn Future<Output = Result<BrokerResponse, BrokerError>> + Send + 'a>>;
}

#[derive(Debug, Default)]
pub struct RejectingBrokerFacade;

impl BrokerFacade for RejectingBrokerFacade {
    fn call<'a>(
        &'a self,
        request: BrokerRequest,
    ) -> Pin<Box<dyn Future<Output = Result<BrokerResponse, BrokerError>> + Send + 'a>> {
        Box::pin(async move {
            Err(BrokerError::Unavailable {
                operation_id: request.operation_id,
            })
        })
    }
}
