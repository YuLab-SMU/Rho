use rho_plugin_sdk::{accept_stdio, protocol::*};

#[tokio::main(flavor = "current_thread")]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut backend = accept_stdio().await?;
    backend.ready().await?;
    while let Some(frame) = backend.reader.receive().await? {
        let reply = match &frame.body {
            RpcBody::Query(call) => {
                backend.validate_call(&frame)?;
                RpcBody::QueryResult {
                    data: call.arguments.clone(),
                    completeness: ObservationCompleteness::Complete,
                    source: None,
                }
            }
            RpcBody::Release => {
                backend
                    .writer
                    .send(frame.request, RpcBody::Released)
                    .await?;
                return Ok(());
            }
            _ => RpcBody::Error {
                code: "unsupported".into(),
                message: "This example only provides an echo query".into(),
                recovery: None,
            },
        };
        backend.writer.send(frame.request, reply).await?;
    }
    Ok(())
}
