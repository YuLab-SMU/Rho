use crate::{Invocation, OperationId, QueryRequest};
use serde::{Deserialize, Serialize};

/// The local session edge forwards these five ports to the Host.
#[derive(Debug, Deserialize)]
#[serde(
    tag = "method",
    content = "params",
    rename_all = "snake_case",
    deny_unknown_fields
)]
pub enum HostRequest {
    Invoke(Invocation),
    GetOperation { operation_id: OperationId },
    RequestCancellation { operation_id: OperationId },
    QuerySnapshot(QueryRequest),
    Subscribe { after_sequence: u64, limit: usize },
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SessionFrame {
    pub id: String,
    pub request: HostRequest,
}

#[derive(Debug, Serialize)]
pub struct SessionReply {
    pub id: Option<String>,
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}
