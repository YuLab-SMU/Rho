#[cfg(unix)]
#[tokio::main(flavor = "current_thread")]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    use rho_plugin_sdk::{ResourceClient, accept_stdio, protocol::*};
    let mut backend = accept_stdio().await?;
    let resources = ResourceClient::new(
        backend
            .resource_channel
            .clone()
            .ok_or("Host has no resource channel")?,
    )?;
    backend.ready().await?;
    while let Some(frame) = backend.reader.receive().await? {
        let reply = match &frame.body {
            RpcBody::Query(call) => {
                backend.validate_call(&frame)?;
                let bytes = b"Hello from a plugin\n";
                let reference = resources.put(call.request.clone(), ResourceDeclaration {
                    // Exact SHA-256 of the example's constant bytes. Real owners
                    // calculate their digest while preparing a file or buffer.
                    digest: ContentDigest::new("sha256:86f48ba6e97ee8249ccf96eec3fddb640ac1bae4ddb9b14ead530e0a78e126c4")?,
                    media_type: "text/plain; charset=utf-8".into(), bytes: bytes.len() as u64,
                }, bytes.as_slice()).await?;
                RpcBody::QueryResult {
                    data: serde_json::to_value(&reference)?,
                    completeness: ObservationCompleteness::Complete,
                    source: Some(reference),
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
                message: "This example retains a text observation for each query".into(),
                recovery: None,
            },
        };
        backend.writer.send(frame.request, reply).await?;
    }
    Ok(())
}
#[cfg(not(unix))]
fn main() {
    eprintln!("The native resource example requires the supported Unix delivery target.");
}
