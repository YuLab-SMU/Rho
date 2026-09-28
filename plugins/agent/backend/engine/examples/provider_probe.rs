//! Explicit P0 diagnostic: synthetic tool + image through a configured endpoint.
//! No project, Host, native R, private CLI configuration or scientific operation.
use futures::StreamExt;
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
    time::{Duration, Instant},
};

const RED_PNG: &str = "iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAEklEQVR4nGP4z8CAFWEXHbQSACj/P8Fu7N9hAAAAAElFTkSuQmCC";

#[tokio::main(flavor = "current_thread")]
async fn main() {
    if let Err(error) = probe().await {
        // Error categories are deliberately independent of provider response text.
        eprintln!(
            "{}",
            json!({"phase":"rig-provider-probe","passed":false,"error":error})
        );
        std::process::exit(1);
    }
}

async fn probe() -> Result<(), &'static str> {
    let endpoint = std::env::var("RHO_COMPONENT_MODEL_BASE_URL").map_err(|_| "missing base URL")?;
    let model = std::env::var("RHO_COMPONENT_MODEL_ID").map_err(|_| "missing model ID")?;
    // The caller selects a reference. The diagnostic never discovers other clients' secrets.
    let key_ref = std::env::var("RHO_COMPONENT_MODEL_KEY_ENV")
        .map_err(|_| "missing credential environment reference")?;
    let key = std::env::var(&key_ref).map_err(|_| "credential reference is unavailable")?;
    let uri: axum::http::Uri = endpoint.parse().map_err(|_| "invalid endpoint")?;
    let host = uri.host().ok_or("missing endpoint host")?;
    let loopback = host == "localhost"
        || host
            .trim_matches(['[', ']'])
            .parse::<std::net::IpAddr>()
            .is_ok_and(|ip| ip.is_loopback());
    if uri.authority().is_some_and(|a| a.as_str().contains('@'))
        || uri.query().is_some()
        || !(uri.scheme_str() == Some("https") || (uri.scheme_str() == Some("http") && loopback))
    {
        return Err(
            "endpoint requires HTTPS or explicit loopback HTTP, without embedded credentials",
        );
    }
    let calls = Arc::new(AtomicUsize::new(0));
    let executed = calls.clone();
    let tool = DynamicTool::new(
        "observe_fixture",
        "Read the synthetic verification marker",
        json!({
            "type":"object","properties":{},"additionalProperties":false
        }),
        move |_, args| {
            let executed = executed.clone();
            Box::pin(async move {
                if args != json!({}) {
                    return Err(ToolExecutionError::refused("expected empty arguments"));
                }
                executed.fetch_add(1, Ordering::SeqCst);
                Ok(ToolOutput::json(
                    json!({"marker":"rho-probe-17","status":"ready"}),
                ))
            })
        },
    );
    let protocol = std::env::var("RHO_COMPONENT_MODEL_PROTOCOL")
        .unwrap_or_else(|_| "openai_completions".into());
    let builder = match protocol.as_str() {
        "anthropic" => anthropic::Client::builder()
            .api_key(key)
            .base_url(&endpoint)
            .build()
            .map_err(|_| "provider client configuration failed")?
            .agent(&model),
        "openai_completions" => openai::Client::builder()
            .api_key(key)
            .base_url(&endpoint)
            .build()
            .map_err(|_| "provider client configuration failed")?
            .completions_api()
            .agent(&model),
        _ => return Err("unsupported protocol"),
    };
    let agent = builder.dynamic_tool(tool).max_tokens(2048).build();
    let prompt = Message::User {
        content: vec![
            UserContent::text(
                "Call observe_fixture exactly once. Then inspect the attached synthetic image. Reply with the tool's marker, a space, and the dominant color in lowercase English. No other text.",
            ),
            UserContent::image_base64(RED_PNG, Some(ImageMediaType::PNG), None),
        ],
    };
    let start = Instant::now();
    let outcome = tokio::time::timeout(Duration::from_secs(120), async {
        let mut stream = agent
            .runner(prompt)
            .max_turns(3)
            .tool_concurrency(1)
            .record_content_telemetry(false)
            .without_memory()
            .stream()
            .await;
        let mut text = String::new();
        let mut completed = false;
        let mut model_calls = 0;
        let mut first_text_ms = None;
        while let Some(event) = stream.next().await {
            match event.map_err(|_| "provider protocol or tool failure")? {
                MultiTurnStreamItem::StreamAssistantItem(StreamedAssistantContent::Text(delta)) => {
                    first_text_ms.get_or_insert(start.elapsed().as_millis());
                    text.push_str(&delta.text);
                    if text.len() > 8192 {
                        return Err("response byte budget exceeded");
                    }
                }
                MultiTurnStreamItem::CompletionCall(_) => model_calls += 1,
                MultiTurnStreamItem::FinalResponse(_) => completed = true,
                _ => {}
            }
        }
        if !completed || calls.load(Ordering::SeqCst) != 1 || text.trim() != "rho-probe-17 red" {
            return Err("synthetic tool and visual assertions failed");
        }
        Ok((model_calls, first_text_ms))
    })
    .await
    .map_err(|_| "provider deadline exceeded")??;
    println!(
        "{}",
        json!({"phase":"rig-provider-probe","passed":true,"rig":"0.42.0",
        "protocol":protocol,"transport":if loopback {"loopback"} else {"remote_https"}, "model_calls":outcome.0,
        "tool_calls":1,"synthetic_image_verified":true,"first_text_ms":outcome.1,"elapsed_ms":start.elapsed().as_millis()})
    );
    Ok(())
}
