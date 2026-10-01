use rho_plugin_sdk::protocol::*;
use serde_json::Value;
use std::time::Duration;
use tokio::sync::{mpsc, oneshot};

pub struct ReadRequest {
    pub parent: RequestId,
    pub capability: CapabilityKey,
    pub arguments: Value,
    pub reply: oneshot::Sender<Result<Value, String>>,
}
#[derive(Clone)]
pub struct HostReads(pub mpsc::Sender<ReadRequest>);
impl HostReads {
    pub async fn query(
        &self,
        parent: RequestId,
        capability: &str,
        arguments: Value,
    ) -> Result<Value, String> {
        let (reply, receiver) = oneshot::channel();
        let exchange = async {
            self.0
                .send(ReadRequest {
                    parent,
                    capability: CapabilityKey {
                        id: ContributionId::new(capability).map_err(|e| e.to_string())?,
                        version: 1,
                    },
                    arguments,
                    reply,
                })
                .await
                .map_err(|_| "Host observation channel ended")?;
            receiver
                .await
                .map_err(|_| "Host observation ended before its correlated response")?
        };
        tokio::time::timeout(Duration::from_secs(30), exchange)
            .await
            .map_err(|_| "Host observation deadline expired")?
    }
}
