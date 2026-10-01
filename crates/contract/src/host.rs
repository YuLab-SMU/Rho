use crate::{InvokeRequest, OperationId, QueryRequest};
pub use rho_plugin_protocol::TestProjectId;
use serde::{Deserialize, Serialize};

/// Ephemeral owner control. Arguments may contain secrets and never become an
/// Operation, receipt, event or diagnostic payload.
#[derive(Deserialize, ts_rs::TS)]
#[serde(deny_unknown_fields)]
pub struct ControlRequest {
    pub capability: crate::CapabilityRef,
    pub arguments: serde_json::Value,
}
impl std::fmt::Debug for ControlRequest {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ControlRequest")
            .field("capability", &self.capability)
            .field("arguments", &"[redacted]")
            .finish()
    }
}

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
    Control(ControlRequest),
    Invoke(InvokeRequest),
    GetOperation {
        operation_id: OperationId,
    },
    RequestCancellation {
        operation_id: OperationId,
        #[serde(default)]
        #[ts(optional)]
        only_if_pending: Option<bool>,
    },
    ReconcileCommit(crate::ReconcileOperationCommit),
    QuerySnapshot(QueryRequest),
    Subscribe {
        after_sequence: u64,
        limit: usize,
    },
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
#[derive(ts_rs::TS)]
pub struct SessionFrame {
    pub id: String,
    /// Select an existing test Host owned by the parent project. Omission selects
    /// the parent; an unavailable explicit selection never falls back to it.
    #[serde(default)]
    #[ts(optional)]
    pub test_project: Option<TestProjectId>,
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
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub diagnostic: Option<crate::Diagnostic>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn removed_fixed_methods_cannot_enter_the_shared_port() {
        for method in [
            "respond_input",
            "application_control",
            "application_bridge",
            "application_execute",
            "bind_method",
        ] {
            let error = serde_json::from_value::<HostRequest>(serde_json::json!({
                "method": method, "params": {}
            }))
            .unwrap_err();
            assert!(
                error.to_string().contains("unknown variant"),
                "{method}: {error}"
            );
        }
        let request = serde_json::from_value::<HostRequest>(serde_json::json!({
            "method": "control", "params": {
                "capability": {"id":"custom.respond_input", "version":1}, "arguments":{}
            }
        }))
        .unwrap();
        assert!(matches!(request, HostRequest::Control(_)));
    }
}
