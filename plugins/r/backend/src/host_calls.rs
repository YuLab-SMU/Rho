//! Explicit granted reverse calls. The Host owns delegated Operation identities
//! and commits; this channel neither journals nor retries scientific work.
use rho_plugin_sdk::protocol::*;
use serde_json::Value;
use std::time::Duration;
use tokio::sync::{mpsc, oneshot};

pub struct HostRequest {
    pub parent: RequestId,
    pub request: Option<RequestId>,
    pub capability: CapabilityKey,
    pub arguments: Value,
    pub reply: oneshot::Sender<Result<Value, String>>,
}
#[derive(Clone)]
pub struct HostCalls(pub mpsc::Sender<HostRequest>);
impl HostCalls {
    pub async fn call(
        &self,
        parent: RequestId,
        request: Option<RequestId>,
        capability: CapabilityKey,
        arguments: Value,
        deadline: Duration,
    ) -> Result<Value, String> {
        let (reply, receiver) = oneshot::channel();
        let exchange = async {
            self.0
                .send(HostRequest {
                    parent,
                    request,
                    capability,
                    arguments,
                    reply,
                })
                .await
                .map_err(|_| "Host delegation channel ended")?;
            receiver
                .await
                .map_err(|_| "Host delegation ended without its correlated response")?
        };
        tokio::time::timeout(deadline, exchange)
            .await
            .map_err(|_| "Host delegation is unconfirmed after its deadline")?
    }
}
