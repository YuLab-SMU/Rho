//! Public, language-neutral transport helpers. No scientific owner or Host internals.
#![forbid(unsafe_code)]

mod transport;
pub use rho_plugin_protocol as protocol;
pub use transport::*;

use protocol::*;
use tokio::io::{AsyncRead, AsyncWrite};

#[derive(Debug, thiserror::Error)]
pub enum SdkError {
    #[error("plugin transport: {0}")]
    Io(#[from] std::io::Error),
    #[error(transparent)]
    Protocol(#[from] ProtocolError),
    #[error("plugin protocol: {0}")]
    Invalid(String),
}

/// A backend owns this connection. Split it to read cancellation and reverse-call
/// replies while an operation is running. Only stdout carries frames; use stderr
/// for diagnostics. Losing this channel never confirms cancellation.
pub struct BackendConnection<R, W> {
    pub instance: PluginInstance,
    pub grants: Vec<CapabilityRequirement>,
    pub reader: RpcReader<R>,
    pub writer: RpcWriter<W>,
    initialization_request: RequestId,
}

impl<R: AsyncRead + Unpin, W: AsyncWrite + Unpin> BackendConnection<R, W> {
    /// Receives initialization, but does not announce Ready. Initialize owner
    /// resources first; call ready only after all initialization has succeeded.
    pub async fn accept(mut input: R, output: W) -> Result<Self, SdkError> {
        let frame = read_frame(&mut input)
            .await?
            .ok_or_else(|| SdkError::Invalid("Host disconnected before initialization".into()))?;
        let RpcBody::Initialize { instance, grants } = &frame.body else {
            return Err(SdkError::Invalid(
                "first frame must initialize the backend".into(),
            ));
        };
        if frame.sequence != 1
            || frame.instance != instance.identity.instance
            || instance.state != InstanceState::Preparing
        {
            return Err(SdkError::Invalid(
                "invalid initialization identity or state".into(),
            ));
        }
        let mut guard = RpcSessionGuard::new(frame.instance.clone(), frame.connection.clone());
        guard.accept(&frame.encode()?)?;
        Ok(Self {
            instance: instance.clone(),
            grants: grants.clone(),
            reader: RpcReader::with_guard(input, guard),
            writer: RpcWriter::new(output, frame.instance, frame.connection),
            initialization_request: frame.request,
        })
    }

    pub async fn ready(&mut self) -> Result<(), SdkError> {
        self.writer
            .send(
                self.initialization_request.clone(),
                RpcBody::Ready {
                    revision: self.instance.identity.revision.clone(),
                    artifact: self.instance.identity.artifact.clone(),
                },
            )
            .await
    }

    /// Defense in depth for backend implementations. Host validates contribution
    /// schemas/scopes before dispatch; owners still check native preconditions.
    pub fn validate_call(&self, frame: &RpcFrame) -> Result<(), SdkError> {
        let (call, operation) = match &frame.body {
            RpcBody::Query(call) => (call, false),
            RpcBody::Invoke(call) => (call, true),
            _ => return Err(SdkError::Invalid("expected a query or invocation".into())),
        };
        if call.request != frame.request
            || call.binding.provider != self.instance.identity
            || call.binding.project != self.instance.project
            || call.principal != self.instance.principal
            || operation != call.operation_id.is_some()
        {
            return Err(SdkError::Invalid(
                "call differs from its admitted instance or owner".into(),
            ));
        }
        Ok(())
    }
}

pub async fn accept_stdio()
-> Result<BackendConnection<tokio::io::Stdin, tokio::io::Stdout>, SdkError> {
    BackendConnection::accept(tokio::io::stdin(), tokio::io::stdout()).await
}
