//! Forward durable Agent turn projections onto the Tauri event bus.
//!
//! The store remains authoritative. Live frames make the common path fast;
//! the existing invalidation event forces canonical refetch when the bounded
//! broadcast receiver reports lag.

use serde_json::json;
use tauri::{AppHandle, Emitter};
use tokio::sync::OnceCell;
use tokio::sync::broadcast::error::RecvError;

use crate::AppState;
use crate::application_state::store_executor;

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
                        Err(RecvError::Lagged(skipped)) => {
                            let _ = handle.emit(
                                "rho://agent-turn-updated",
                                json!({
                                    "reason": "agent_turn_event_lagged",
                                    "skipped": skipped,
                                }),
                            );
                        }
                        Err(RecvError::Closed) => break,
                    }
                }
            });
            Ok::<(), anyhow::Error>(())
        })
        .await;
}
