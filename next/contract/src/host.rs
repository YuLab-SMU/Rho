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
#[derive(ts_rs::TS)]
pub enum HostRequest {
    Invoke(Invocation),
    GetOperation { operation_id: OperationId },
    RequestCancellation { operation_id: OperationId },
    QuerySnapshot(QueryRequest),
    Subscribe { after_sequence: u64, limit: usize },
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
#[derive(ts_rs::TS)]
pub struct SessionFrame {
    pub id: String,
    pub request: HostRequest,
}

#[derive(Debug, Serialize, ts_rs::TS)]
pub struct SessionReply {
    pub id: Option<String>,
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub result: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub error: Option<String>,
}
