use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use jet_core::client::{Client, ListenFilter};
use jet_core::events::{EventData, from_message};
use jet_core::jupyter_protocol::{
    CommInfoReply, CommMsg, CommOpen, ExecuteRequest, InputReply, IsCompleteReplyStatus,
    IsCompleteRequest, JupyterMessage, JupyterMessageContent,
};
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

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct CodeCompleteness {
    pub status: IsCompleteReplyStatus,
    pub indent: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct OpenComm {
    pub comm_id: String,
    pub messages: Vec<Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct KernelOpenedComm {
    pub comm_id: String,
    pub target_name: String,
    pub data: Value,
}

pub struct ArkSession {
    client: Client,
    pub kernel_info: Value,
}

impl ArkSession {
    pub async fn launch(config: &ArkLaunchConfig) -> Result<Self> {
        let mut spec = KernelSpec::load(&config.kernelspec_path).with_context(|| {
            format!(
                "loading Ark kernelspec {}",
                config.kernelspec_path.display()
            )
        })?;
        spec.env_remove.extend(
            std::env::vars_os()
                .filter_map(|(name, _)| name.into_string().ok())
                .filter(|name| is_sensitive_environment_name(name)),
        );
        spec.env_remove.sort();
        spec.env_remove.dedup();
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

    pub async fn is_complete(&mut self, code: impl Into<String>) -> Result<CodeCompleteness> {
        let request: JupyterMessage = IsCompleteRequest { code: code.into() }.into();
        let request_id = request.header.msg_id.clone();
        let mut listener = self.client.listen(ListenFilter::default());
        let request_stream = self.client.request(request)?;
        drop(request_stream);

        let wait = async {
            loop {
                let frame = listener
                    .recv()
                    .await
                    .context("Ark completeness listener closed before reply")?;
                let parent_id = frame
                    .message
                    .parent_header
                    .as_ref()
                    .map(|header| header.msg_id.as_str());
                if parent_id != Some(request_id.as_str()) {
                    continue;
                }
                if let JupyterMessageContent::IsCompleteReply(reply) = frame.message.content {
                    return Ok(CodeCompleteness {
                        status: reply.status,
                        indent: reply.indent,
                    });
                }
            }
        };
        tokio::time::timeout(std::time::Duration::from_secs(5), wait)
            .await
            .context("timed out waiting for Ark code completeness")?
    }

    pub async fn open_comm(
        &mut self,
        target_name: impl Into<String>,
        data: Value,
        message_count: usize,
        timeout: std::time::Duration,
    ) -> Result<OpenComm> {
        static NEXT_COMM_ID: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);
        let comm_id = format!(
            "rho-{}-{}",
            std::process::id(),
            NEXT_COMM_ID.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
        );
        let data = data
            .as_object()
            .cloned()
            .context("comm_open data must be a JSON object")?;
        let mut listener = self.client.comm_listen(comm_id.clone());
        let request: JupyterMessage = CommOpen {
            comm_id: comm_id.clone().into(),
            target_name: target_name.into(),
            data,
            target_module: None,
        }
        .into();
        let request_stream = self.client.request(request)?;
        drop(request_stream);

        let wait = async {
            let mut messages = Vec::with_capacity(message_count);
            while messages.len() < message_count {
                let frame = listener
                    .recv()
                    .await
                    .context("Ark comm listener closed before expected messages")?;
                match frame.message.content {
                    JupyterMessageContent::CommMsg(message) => {
                        messages.push(Value::Object(message.data));
                    }
                    JupyterMessageContent::CommClose(_) => {
                        anyhow::bail!("Ark closed comm `{comm_id}` before it became ready")
                    }
                    _ => {}
                }
            }
            Ok(OpenComm {
                comm_id: comm_id.clone(),
                messages,
            })
        };
        tokio::time::timeout(timeout, wait)
            .await
            .with_context(|| format!("timed out waiting for Ark comm `{comm_id}`"))?
    }

    pub async fn comm_info(&mut self, target_name: Option<String>) -> Result<CommInfoReply> {
        let mut stream = self.client.comm_info(target_name)?;
        let wait = async {
            loop {
                let frame = stream
                    .recv()
                    .await
                    .context("Ark comm_info stream closed before reply")?;
                if let JupyterMessageContent::CommInfoReply(reply) = frame.message.content {
                    return Ok(reply);
                }
            }
        };
        tokio::time::timeout(std::time::Duration::from_secs(10), wait)
            .await
            .context("timed out waiting for Ark comm_info_reply")?
    }

    pub async fn execute_capture_comm_open(
        &mut self,
        code: impl Into<String>,
        target_name: &str,
    ) -> Result<KernelOpenedComm> {
        let mut listener = self.client.listen(ListenFilter::default());
        self.execute(code, |_| Ok(())).await?;
        let wait = async {
            loop {
                let frame = listener
                    .recv()
                    .await
                    .context("Ark listener closed before expected comm_open")?;
                if let JupyterMessageContent::CommOpen(open) = frame.message.content
                    && open.target_name == target_name
                {
                    return Ok(KernelOpenedComm {
                        comm_id: open.comm_id.0,
                        target_name: open.target_name,
                        data: Value::Object(open.data),
                    });
                }
            }
        };
        tokio::time::timeout(std::time::Duration::from_secs(10), wait)
            .await
            .with_context(|| format!("timed out waiting for Ark comm target `{target_name}`"))?
    }

    pub async fn comm_rpc(
        &mut self,
        comm_id: &str,
        method: &str,
        params: Value,
        timeout: std::time::Duration,
    ) -> Result<Value> {
        let params = params
            .as_object()
            .cloned()
            .context("comm RPC params must be a JSON object")?;
        let mut listener = self.client.comm_listen(comm_id.to_string());
        let mut data = serde_json::Map::new();
        data.insert("method".to_string(), Value::String(method.to_string()));
        data.insert("params".to_string(), Value::Object(params));
        let mut request: JupyterMessage = CommMsg {
            comm_id: comm_id.to_string().into(),
            data,
        }
        .into();
        let request_id = request.header.msg_id.clone();
        if let JupyterMessageContent::CommMsg(message) = &mut request.content {
            message
                .data
                .insert("id".to_string(), Value::String(request_id.clone()));
        }
        let request_stream = self.client.request(request)?;
        drop(request_stream);

        let wait = async {
            loop {
                let frame = listener
                    .recv()
                    .await
                    .context("Ark comm RPC listener closed before reply")?;
                let parent_matches = frame
                    .message
                    .parent_header
                    .as_ref()
                    .is_some_and(|header| header.msg_id == request_id);
                if let JupyterMessageContent::CommMsg(message) = frame.message.content {
                    let data = Value::Object(message.data);
                    if data["id"] == request_id || parent_matches {
                        return Ok(data);
                    }
                }
            }
        };
        tokio::time::timeout(timeout, wait)
            .await
            .with_context(|| format!("timed out waiting for comm RPC `{method}`"))?
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
        anyhow::ensure!(
            saw_reply && saw_idle,
            "Ark execution stream closed before execute_reply and idle"
        );
        Ok(())
    }

    pub async fn execute_capture_comm_message(
        &mut self,
        code: impl Into<String>,
        comm_id: &str,
        method: &str,
    ) -> Result<Value> {
        let mut listener = self.client.comm_listen(comm_id.to_string());
        self.execute(code, |_| Ok(())).await?;
        let wait = async {
            loop {
                let frame = listener
                    .recv()
                    .await
                    .context("Ark comm listener closed before expected message")?;
                if let JupyterMessageContent::CommMsg(message) = frame.message.content {
                    let data = Value::Object(message.data);
                    if data["method"] == method {
                        return Ok(data);
                    }
                }
            }
        };
        tokio::time::timeout(std::time::Duration::from_secs(10), wait)
            .await
            .with_context(|| format!("timed out waiting for comm method `{method}`"))?
    }

    pub async fn interrupt(&mut self) -> Result<()> {
        self.client.interrupt().await.context("interrupting Ark")
    }

    pub async fn shutdown(&mut self) -> Result<()> {
        tokio::time::timeout(std::time::Duration::from_secs(10), self.client.shutdown())
            .await
            .context("timed out shutting down Ark")?
            .context("shutting down Ark")
    }
}

pub fn load_kernelspec(path: impl AsRef<Path>) -> Result<KernelSpec> {
    KernelSpec::load(path.as_ref()).context("loading kernelspec")
}

fn is_sensitive_environment_name(name: &str) -> bool {
    let name = name.to_ascii_uppercase();
    name.ends_with("_API_KEY")
        || name.ends_with("_ACCESS_TOKEN")
        || name.ends_with("_AUTH_TOKEN")
        || matches!(
            name.as_str(),
            "GITHUB_TOKEN"
                | "GH_TOKEN"
                | "HF_TOKEN"
                | "AWS_SECRET_ACCESS_KEY"
                | "AZURE_CLIENT_SECRET"
                | "RHO_AGENT_TOKEN"
        )
}

#[cfg(test)]
mod tests {
    use super::is_sensitive_environment_name;

    #[test]
    fn identifies_model_credentials_for_workspace_redaction() {
        assert!(is_sensitive_environment_name("GEMINI_API_KEY"));
        assert!(is_sensitive_environment_name("GITHUB_TOKEN"));
        assert!(is_sensitive_environment_name("custom_access_token"));
        assert!(!is_sensitive_environment_name("R_LIBS"));
        assert!(!is_sensitive_environment_name("PATH"));
    }
}
