//! Explicit synthetic diagnostics. No Host tool port or project context is available.
use crate::RigComponentEngine;
use futures::StreamExt;
use rho_application::{ComponentModelKey, validate_component_model};
use rho_contract::{ComponentModelConnection, ComponentModelProtocol, ComponentModelTestKind};
use rig::{
    agent::MultiTurnStreamItem,
    message::{ImageMediaType, Message, UserContent},
    prelude::*,
    providers::{anthropic, openai},
    streaming::StreamedAssistantContent,
    tool::{DynamicTool, ToolExecutionError, ToolOutput},
};
use serde_json::json;
use std::{
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    },
    time::Duration,
};
use tokio_util::sync::CancellationToken;

pub(super) async fn test(
    engine: &RigComponentEngine,
    model: ComponentModelConnection,
    key: ComponentModelKey,
    kind: ComponentModelTestKind,
    cancellation: CancellationToken,
) -> Result<(), String> {
    validate_component_model(&model).map_err(|_| "Invalid diagnostic model configuration")?;
    if cancellation.is_cancelled() {
        return Err("Model test interrupted".into());
    }
    let work = async {
        let client = engine.http_client()?;
        let builder = match model.protocol {
            ComponentModelProtocol::Anthropic => anthropic::Client::builder()
                .api_key(key.expose())
                .base_url(&model.base_url)
                .http_client(client)
                .build()
                .map_err(|_| "Model configuration failed")?
                .agent(&model.model),
            ComponentModelProtocol::OpenaiCompletions => openai::Client::builder()
                .api_key(key.expose())
                .base_url(&model.base_url)
                .http_client(client)
                .build()
                .map_err(|_| "Model configuration failed")?
                .completions_api()
                .agent(&model.model),
        };
        let calls = Arc::new(AtomicUsize::new(0));
        let (agent, prompt, expected, expected_calls) = match kind {
            ComponentModelTestKind::Connection => {
                let marker = format!("rho-check-{}", uuid::Uuid::new_v4());
                let value = marker.clone();
                let count = calls.clone();
                let tool = DynamicTool::new(
                    "component_verify",
                    "Read the synthetic verification marker",
                    json!({"type":"object","properties":{},"additionalProperties":false}),
                    move |_, arguments| {
                        let marker = value.clone();
                        let count = count.clone();
                        Box::pin(async move {
                            if arguments != json!({}) || count.fetch_add(1, Ordering::SeqCst) != 0 {
                                return Err(ToolExecutionError::refused(
                                    "Diagnostic tool may run exactly once",
                                ));
                            }
                            Ok(ToolOutput::json(json!({"marker":marker})))
                        })
                    },
                );
                (
                    builder.dynamic_tool(tool).max_tokens(2048).build(),
                    Message::user(
                        "Call component_verify once. Reply with only the returned marker, without formatting or other text.",
                    ),
                    marker,
                    1,
                )
            }
            ComponentModelTestKind::Images => {
                let variants = [
                    (
                        "red",
                        "iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAEklEQVR4nGP4z8CAFWEXHbQSACj/P8Fu7N9hAAAAAElFTkSuQmCC",
                    ),
                    (
                        "green",
                        "iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAEElEQVR4nGNg+M+AHQ0tCQDpMD/B9YBzjgAAAABJRU5ErkJggg==",
                    ),
                    (
                        "blue",
                        "iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAEElEQVR4nGNgYPiPAw0pCQCpcD/BFMrqcwAAAABJRU5ErkJggg==",
                    ),
                ];
                let (color, bytes) = variants[(uuid::Uuid::new_v4().as_bytes()[0] % 3) as usize];
                (
                    builder.max_tokens(2048).build(),
                    Message::User {
                        content: vec![
                            UserContent::text(
                                "Inspect the attached synthetic image. Reply with only the dominant color as one lowercase English word.",
                            ),
                            UserContent::image_base64(bytes, Some(ImageMediaType::PNG), None),
                        ],
                    },
                    color.into(),
                    0,
                )
            }
        };
        let mut stream = agent
            .runner(prompt)
            .max_turns(if expected_calls == 0 { 1 } else { 2 })
            .tool_concurrency(1)
            .record_content_telemetry(false)
            .without_memory()
            .stream()
            .await;
        let mut answer = String::new();
        let mut complete = false;
        while let Some(event) = stream.next().await {
            match event.map_err(|_| "Model protocol test failed")? {
                MultiTurnStreamItem::StreamAssistantItem(StreamedAssistantContent::Text(text)) => {
                    answer.push_str(&text.text);
                    if answer.len() > 8192 {
                        return Err("Diagnostic response budget exceeded".into());
                    }
                }
                MultiTurnStreamItem::FinalResponse(_) => complete = true,
                _ => {}
            }
        }
        if !complete || answer.trim() != expected || calls.load(Ordering::SeqCst) != expected_calls
        {
            return Err("Synthetic model assertion did not match".into());
        }
        Ok(())
    };
    tokio::select! {biased;_=cancellation.cancelled()=>Err("Model test interrupted".into()),result=tokio::time::timeout(Duration::from_secs(120),work)=>result.map_err(|_|"Model test deadline exceeded")?}
}
