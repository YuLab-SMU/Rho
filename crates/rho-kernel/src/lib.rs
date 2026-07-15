use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use jet_core::client::{Client, ListenFilter};
use jet_core::events::{EventData, from_message};
use jet_core::jupyter_protocol::{ExecuteRequest, InputReply, JupyterMessage};
use jet_core::kernel::KernelSpec;
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone)]
pub struct ArkLaunchConfig {
    pub kernelspec_path: PathBuf,
    pub connection_file: Option<PathBuf>,
    pub session_name: String,
}

impl ArkLaunchConfig {
    pub fn new(kernelspec_path: impl Into<PathBuf>) -> Self {
        Self {
            kernelspec_path: kernelspec_path.into(),
            connection_file: None,
            session_name: "rho".to_string(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum KernelEvent {
    Stream { name: String, text: String },
    DisplayData { data: Value },
    Error { traceback: String },
    Banner { text: String },
    Idle,
    Busy,
    InputRequest { prompt: String, password: bool },
    ExecuteInput { code: String },
    ExecuteReply,
    InterruptRequested,
    KernelExited,
    Other,
}

impl From<EventData> for KernelEvent {
    fn from(value: EventData) -> Self {
        match value {
            EventData::Stream { name, text } => Self::Stream { name, text },
            EventData::DisplayData { data } => Self::DisplayData { data },
            EventData::Error { traceback } => Self::Error { traceback },
            EventData::Banner { text } => Self::Banner { text },
            EventData::Idle { .. } => Self::Idle,
            EventData::Busy { .. } => Self::Busy,
            EventData::InputRequest {
                prompt, password, ..
            } => Self::InputRequest { prompt, password },
            EventData::ExecuteInput { code } => Self::ExecuteInput { code },
            EventData::ExecuteReply { .. } => Self::ExecuteReply,
            EventData::KernelExited => Self::KernelExited,
            EventData::IsComplete { .. } | EventData::Other => Self::Other,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct CorrelatedKernelEvent {
    pub parent_id: Option<String>,
    #[serde(flatten)]
    pub event: KernelEvent,
}

pub struct ArkSession {
    client: Client,
    pub kernel_info: Value,
}

impl ArkSession {
    pub async fn launch(config: &ArkLaunchConfig) -> Result<Self> {
        let spec = KernelSpec::load(&config.kernelspec_path).with_context(|| {
            format!(
                "loading Ark kernelspec {}",
                config.kernelspec_path.display()
            )
        })?;
        let (client, kernel_info, _boot_stream) = Client::spawn(
            &spec,
            config.connection_file.clone(),
            Some(&config.session_name),
            None,
        )
        .await
        .context("starting and handshaking with Ark")?;
        Ok(Self {
            client,
            kernel_info,
        })
    }

    pub fn child_pid(&self) -> Option<u32> {
        self.client.child_pid()
    }

    pub async fn execute<F>(&mut self, code: impl Into<String>, on_event: F) -> Result<()>
    where
        F: FnMut(CorrelatedKernelEvent) -> Result<()>,
    {
        self.execute_with_options(
            code,
            on_event,
            |prompt, _password| anyhow::bail!("unexpected stdin request: {prompt}"),
            None,
        )
        .await
    }

    pub async fn execute_with_options<F, I>(
        &mut self,
        code: impl Into<String>,
        mut on_event: F,
        mut on_input: I,
        interrupt_after: Option<std::time::Duration>,
    ) -> Result<()>
    where
        F: FnMut(CorrelatedKernelEvent) -> Result<()>,
        I: FnMut(&str, bool) -> Result<String>,
    {
        let request: JupyterMessage = ExecuteRequest {
            code: code.into(),
            silent: false,
            store_history: true,
            user_expressions: None,
            allow_stdin: true,
            stop_on_error: true,
        }
        .into();
        let mut listener = self.client.listen(ListenFilter::default());
        let request_stream = self.client.request(request)?;
        let request_id = request_stream.msg_id.clone();
        drop(request_stream);
        let interrupt = async {
            match interrupt_after {
                Some(delay) => tokio::time::sleep(delay).await,
                None => std::future::pending().await,
            }
        };
        tokio::pin!(interrupt);
        let mut interrupted = false;
        let mut saw_idle = false;
        let mut saw_reply = false;

        loop {
            tokio::select! {
                frame = listener.recv() => {
                    let Some(frame) = frame else { break };
                    let parent_id = frame
                        .message
                        .parent_header
                        .as_ref()
                        .map(|header| header.msg_id.clone());
                    if parent_id.as_deref() != Some(request_id.as_str()) {
                        continue;
                    }
                    let event = from_message(frame.channel, &frame.message);
                    if let EventData::InputRequest { prompt, password, .. } = &event.data {
                        let value = on_input(prompt, *password)?;
                        let reply: JupyterMessage = InputReply {
                            value,
                            status: Default::default(),
                            error: None,
                        }
                        .into();
                        self.client.reply_stdin(reply)?;
                    }
                    saw_idle |= matches!(&event.data, EventData::Idle { .. });
                    saw_reply |= matches!(&event.data, EventData::ExecuteReply { .. });
                    on_event(CorrelatedKernelEvent {
                        parent_id,
                        event: event.data.into(),
                    })?;
                    if saw_idle && saw_reply {
                        break;
                    }
                }
                _ = &mut interrupt, if !interrupted => {
                    on_event(CorrelatedKernelEvent {
                        parent_id: Some(request_id.clone()),
                        event: KernelEvent::InterruptRequested,
                    })?;
                    self.client
                        .interrupt()
                        .await
                        .context("interrupting timed execution")?;
                    interrupted = true;
                }
            }
        }
        Ok(())
    }

    pub async fn interrupt(&mut self) -> Result<()> {
        self.client.interrupt().await.context("interrupting Ark")
    }

    pub async fn shutdown(&mut self) -> Result<()> {
        self.client.shutdown().await.context("shutting down Ark")
    }
}

pub fn load_kernelspec(path: impl AsRef<Path>) -> Result<KernelSpec> {
    KernelSpec::load(path.as_ref()).context("loading kernelspec")
}
