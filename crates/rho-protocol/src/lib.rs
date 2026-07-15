use std::io::{Read, Write};

use chrono::Utc;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use thiserror::Error;
use uuid::Uuid;

pub const PROTOCOL_VERSION: u16 = 1;
pub const MAX_FRAME_BYTES: usize = 8 * 1024 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct WorkspaceIdentity {
    pub workspace_id: String,
    pub kernel_instance_id: String,
    pub execution_seq: u64,
    pub state_revision: u64,
    pub project_revision: u64,
}

impl WorkspaceIdentity {
    pub fn new(workspace_id: impl Into<String>) -> Self {
        Self {
            workspace_id: workspace_id.into(),
            kernel_instance_id: format!("kernel_{}", Uuid::new_v4()),
            execution_seq: 0,
            state_revision: 0,
            project_revision: 0,
        }
    }

    pub fn apply(&mut self, class: OperationClass) {
        self.execution_seq += 1;
        match class {
            OperationClass::Probe => {}
            OperationClass::StateCapable => self.state_revision += 1,
            OperationClass::ProjectMutation => self.project_revision += 1,
            OperationClass::StateAndProjectMutation => {
                self.state_revision += 1;
                self.project_revision += 1;
            }
        }
    }

    pub fn restart_kernel(&mut self) {
        self.kernel_instance_id = format!("kernel_{}", Uuid::new_v4());
        self.execution_seq += 1;
        self.state_revision += 1;
    }

    pub fn check(&self, expected: &ExpectedWorkspace) -> Result<(), StaleWorkspace> {
        if let Some(value) = expected.kernel_instance_id.as_deref()
            && value != self.kernel_instance_id
        {
            return Err(StaleWorkspace::Kernel {
                expected: value.to_string(),
                actual: self.kernel_instance_id.clone(),
            });
        }
        if let Some(value) = expected.state_revision
            && value != self.state_revision
        {
            return Err(StaleWorkspace::State {
                expected: value,
                actual: self.state_revision,
            });
        }
        if let Some(value) = expected.project_revision
            && value != self.project_revision
        {
            return Err(StaleWorkspace::Project {
                expected: value,
                actual: self.project_revision,
            });
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum OperationClass {
    Probe,
    StateCapable,
    ProjectMutation,
    StateAndProjectMutation,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct ExpectedWorkspace {
    pub kernel_instance_id: Option<String>,
    pub state_revision: Option<u64>,
    pub project_revision: Option<u64>,
}

#[derive(Debug, Error, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum StaleWorkspace {
    #[error("kernel instance changed: expected {expected}, actual {actual}")]
    Kernel { expected: String, actual: String },
    #[error("workspace state changed: expected {expected}, actual {actual}")]
    State { expected: u64, actual: u64 },
    #[error("project changed: expected {expected}, actual {actual}")]
    Project { expected: u64, actual: u64 },
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum MessageKind {
    Request,
    Response,
    Event,
    Cancel,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Envelope {
    pub protocol_version: u16,
    pub id: String,
    pub kind: MessageKind,
    pub timestamp: String,
    pub payload: Value,
}

impl Envelope {
    pub fn new(kind: MessageKind, payload: Value) -> Self {
        Self {
            protocol_version: PROTOCOL_VERSION,
            id: Uuid::new_v4().to_string(),
            kind,
            timestamp: Utc::now().to_rfc3339(),
            payload,
        }
    }
}

#[derive(Debug, Error)]
pub enum FrameError {
    #[error("I/O error: {0}")]
    Io(#[from] std::io::Error),
    #[error("frame is too large: {0} bytes")]
    TooLarge(usize),
    #[error("frame JSON is invalid: {0}")]
    Json(#[from] serde_json::Error),
    #[error("unsupported protocol version: {0}")]
    ProtocolVersion(u16),
}

pub fn write_frame(mut writer: impl Write, envelope: &Envelope) -> Result<(), FrameError> {
    let bytes = serde_json::to_vec(envelope)?;
    if bytes.len() > MAX_FRAME_BYTES {
        return Err(FrameError::TooLarge(bytes.len()));
    }
    writer.write_all(&(bytes.len() as u32).to_be_bytes())?;
    writer.write_all(&bytes)?;
    writer.flush()?;
    Ok(())
}

pub fn read_frame(mut reader: impl Read) -> Result<Envelope, FrameError> {
    let mut length = [0_u8; 4];
    reader.read_exact(&mut length)?;
    let length = u32::from_be_bytes(length) as usize;
    if length > MAX_FRAME_BYTES {
        return Err(FrameError::TooLarge(length));
    }
    let mut bytes = vec![0; length];
    reader.read_exact(&mut bytes)?;
    let envelope: Envelope = serde_json::from_slice(&bytes)?;
    if envelope.protocol_version != PROTOCOL_VERSION {
        return Err(FrameError::ProtocolVersion(envelope.protocol_version));
    }
    Ok(envelope)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn revisions_are_independent() {
        let mut identity = WorkspaceIdentity::new("ws_test");
        identity.apply(OperationClass::Probe);
        assert_eq!(identity.execution_seq, 1);
        assert_eq!(identity.state_revision, 0);
        assert_eq!(identity.project_revision, 0);

        identity.apply(OperationClass::StateCapable);
        assert_eq!(identity.execution_seq, 2);
        assert_eq!(identity.state_revision, 1);
        assert_eq!(identity.project_revision, 0);

        identity.apply(OperationClass::ProjectMutation);
        assert_eq!(identity.execution_seq, 3);
        assert_eq!(identity.state_revision, 1);
        assert_eq!(identity.project_revision, 1);
    }

    #[test]
    fn kernel_restart_invalidates_references() {
        let mut identity = WorkspaceIdentity::new("ws_test");
        let old = identity.kernel_instance_id.clone();
        identity.restart_kernel();
        let expected = ExpectedWorkspace {
            kernel_instance_id: Some(old),
            ..Default::default()
        };
        assert!(matches!(
            identity.check(&expected),
            Err(StaleWorkspace::Kernel { .. })
        ));
    }

    #[test]
    fn frame_round_trip() {
        let message = Envelope::new(MessageKind::Event, json!({"text": "hello"}));
        let mut bytes = Vec::new();
        write_frame(&mut bytes, &message).unwrap();
        let decoded = read_frame(bytes.as_slice()).unwrap();
        assert_eq!(decoded, message);
    }

    #[test]
    fn rejects_oversized_frame_before_allocation() {
        let bytes = ((MAX_FRAME_BYTES as u32) + 1).to_be_bytes();
        assert!(matches!(
            read_frame(bytes.as_slice()),
            Err(FrameError::TooLarge(_))
        ));
    }
}
