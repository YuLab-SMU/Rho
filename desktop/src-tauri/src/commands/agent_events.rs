//! Live Agent turn event forwarding: store-executor broadcast → Tauri events.
//!
//! The store remains the source of truth. The forwarder only projects durable
//! appends/finishes onto the `agent://turn-event` channel so the frontend can
//! render running turns live; subscribers reconcile through the existing
//! detail queries whenever they lag.

use tauri::{AppHandle, Emitter};
use tokio::sync::OnceCell;
use tokio::sync::broadcast::error::RecvError;

use crate::application_state::store_executor;
use crate::AppState;

static FORWARDER_STARTED: OnceCell<()> = OnceCell::const_new();

pub(crate) async fn ensure_agent_turn_event_forwarder(app: &AppHandle, state: &AppState) {
    let _ = FORWARDER_STARTED
        .get_or_try_init(|| async {
            let executor = store_executor(state).await?;
            let mut receiver = executor.agent_turn_events().subscribe();
            let handle = app.clone();
            tauri::async_runtime::spawn(async move {
                loop {
                    match receiver.recv().await {
                        Ok(frame) => {
                            let _ = handle.emit("agent://turn-event", frame);
                        }
                        Err(RecvError::Lagged(_)) => continue,
                        Err(RecvError::Closed) => break,
                    }
                }
            });
            Ok::<(), anyhow::Error>(())
        })
        .await;
}
