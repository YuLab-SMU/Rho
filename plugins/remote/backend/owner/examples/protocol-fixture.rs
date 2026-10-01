//! Local-only native acceptance driver. No private Host or operation journal.
use rho_plugin_protocol::OperationId;
use rho_remote_owner::{RemoteOwnerError, SshRemoteOwner};
use serde_json::{Value, json};
use std::io::{BufRead, Write};

#[tokio::main(flavor = "current_thread")]
async fn main() {
    for line in std::io::stdin().lock().lines() {
        let value: Value = serde_json::from_str(&line.unwrap()).unwrap();
        let owner = SshRemoteOwner::new(
            std::path::Path::new(value["root"].as_str().unwrap()),
            serde_json::from_value(value["target"].clone()).unwrap(),
        )
        .unwrap();
        let operation = OperationId::new(value["operation_id"].as_str().unwrap()).unwrap();
        let response: Result<Value, RemoteOwnerError> = match value["method"].as_str().unwrap() {
            "inspect" => Ok(json!({"target":owner.target(),"scope":owner.scope()})),
            "execute" => owner
                .execute(
                    &operation,
                    &serde_json::from_value(value["arguments"].clone()).unwrap(),
                    tokio::sync::watch::channel(value["cancelled"].as_bool().unwrap_or(false)).1,
                )
                .await
                .map(|v| json!(v)),
            "submit" => owner
                .submit(
                    &operation,
                    &serde_json::from_value(value["arguments"].clone()).unwrap(),
                )
                .await
                .map(|v| json!(v)),
            "find" => owner
                .find(&operation)
                .await
                .map(|v| json!(v))
                .map_err(RemoteOwnerError::before_effect),
            "cancel" => owner
                .request_cancel(
                    &operation,
                    &serde_json::from_value(value["observed"].clone()).unwrap(),
                )
                .await
                .map(|v| json!(v)),
            _ => panic!("unknown fixture method"),
        };
        println!(
            "{}",
            match response {
                Ok(data) => json!({"ok":true,"data":data}),
                Err(error) =>
                    json!({"ok":false,"message":error.message,"possible_effect":error.possible_effect,"recovery":error.recovery}),
            }
        );
        std::io::stdout().flush().unwrap();
    }
}
