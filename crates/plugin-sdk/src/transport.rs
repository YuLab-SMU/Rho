use crate::{SdkError, protocol::*};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};

/// Wire format: unsigned 32-bit big-endian JSON byte length, then exactly that
/// many UTF-8 bytes. Reject the length before allocating. An EOF between frames
/// is a disconnect; an EOF inside a frame is a malformed/truncated message.
/// This future must not be cancelled and then resumed on the same stream.
pub async fn read_frame<R: AsyncRead + Unpin>(input: &mut R) -> Result<Option<RpcFrame>, SdkError> {
    let mut length = [0_u8; 4];
    if input.read(&mut length[..1]).await? == 0 {
        return Ok(None);
    }
    input.read_exact(&mut length[1..]).await?;
    let length = u32::from_be_bytes(length) as usize;
    if length == 0 || length > MAX_CONTROL_BYTES {
        return Err(SdkError::Invalid(
            "control frame length is outside its limit".into(),
        ));
    }
    let mut bytes = vec![0; length];
    input.read_exact(&mut bytes).await?;
    Ok(Some(RpcFrame::decode(&bytes)?))
}

pub struct RpcReader<R> {
    input: R,
    guard: RpcSessionGuard,
}
impl<R: AsyncRead + Unpin> RpcReader<R> {
    pub fn new(input: R, instance: PluginInstanceId, connection: ConnectionId) -> Self {
        Self::with_guard(input, RpcSessionGuard::new(instance, connection))
    }
    pub(crate) fn with_guard(input: R, guard: RpcSessionGuard) -> Self {
        Self { input, guard }
    }
    /// Use one dedicated reader task. This preserves framing when the caller
    /// independently waits for process exit, cancellation, or request deadlines.
    pub async fn receive(&mut self) -> Result<Option<RpcFrame>, SdkError> {
        match read_frame(&mut self.input).await? {
            None => Ok(None),
            Some(frame) => Ok(Some(self.guard.accept(&frame.encode()?)?)),
        }
    }
    pub fn revoke(&mut self) {
        self.guard.revoke();
    }
}

pub struct RpcWriter<W> {
    output: W,
    instance: PluginInstanceId,
    connection: ConnectionId,
    sequence: u32,
    failed: bool,
}
impl<W: AsyncWrite + Unpin> RpcWriter<W> {
    pub fn new(output: W, instance: PluginInstanceId, connection: ConnectionId) -> Self {
        Self {
            output,
            instance,
            connection,
            sequence: 0,
            failed: false,
        }
    }
    /// Serialize sends through this writer. After any I/O failure the channel is
    /// unusable: retrying a partially written operation would risk replay.
    pub async fn send(&mut self, request: RequestId, body: RpcBody) -> Result<(), SdkError> {
        if self.failed {
            return Err(SdkError::Invalid("outbound channel is fenced".into()));
        }
        let sequence = self
            .sequence
            .checked_add(1)
            .ok_or_else(|| SdkError::Invalid("outbound sequence exhausted".into()))?;
        let bytes = RpcFrame {
            protocol_version: PLUGIN_PROTOCOL_VERSION,
            connection: self.connection.clone(),
            instance: self.instance.clone(),
            sequence,
            request,
            body,
        }
        .encode()?;
        // Fence before the first await, including cancellation of this future.
        self.failed = true;
        self.output
            .write_all(&(bytes.len() as u32).to_be_bytes())
            .await?;
        self.output.write_all(&bytes).await?;
        self.output.flush().await?;
        self.sequence = sequence;
        self.failed = false;
        Ok(())
    }
}
