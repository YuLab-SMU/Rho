//! Raw resource bytes use a separate connection, never the control/stdout pipe.
use crate::{SdkError, protocol::*};
use serde::{Serialize, de::DeserializeOwned};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};

pub async fn read_resource_header<R: AsyncRead + Unpin, T: DeserializeOwned>(
    input: &mut R,
) -> Result<T, SdkError> {
    let size = input.read_u32().await? as usize;
    if size == 0 || size > MAX_RESOURCE_HEADER_BYTES {
        return Err(SdkError::Invalid("resource header exceeds limit".into()));
    }
    let mut bytes = vec![0; size];
    input.read_exact(&mut bytes).await?;
    serde_json::from_slice(&bytes).map_err(|e| SdkError::Invalid(e.to_string()))
}
pub async fn write_resource_header<W: AsyncWrite + Unpin, T: Serialize>(
    output: &mut W,
    value: &T,
) -> Result<(), SdkError> {
    let bytes = serde_json::to_vec(value).map_err(|e| SdkError::Invalid(e.to_string()))?;
    if bytes.is_empty() || bytes.len() > MAX_RESOURCE_HEADER_BYTES {
        return Err(SdkError::Invalid("resource header exceeds limit".into()));
    }
    output.write_u32(bytes.len() as u32).await?;
    output.write_all(&bytes).await?;
    output.flush().await?;
    Ok(())
}

/// Native transport for the current macOS/Unix delivery target. Other languages
/// can implement the same framing without this SDK. The parent request must still
/// be active; await storage confirmation before returning its evidence reference.
#[cfg(unix)]
pub struct ResourceClient {
    channel: ResourceChannel,
}
#[cfg(unix)]
impl ResourceClient {
    pub fn new(channel: ResourceChannel) -> Result<Self, SdkError> {
        if channel.version != RESOURCE_CHANNEL_VERSION
            || channel.token.len() != 64
            || channel.socket.is_empty()
        {
            return Err(SdkError::Invalid("unsupported resource channel".into()));
        }
        Ok(Self { channel })
    }
    async fn connect(
        &self,
        parent: RequestId,
        transfer: ResourceTransfer,
    ) -> Result<tokio::net::UnixStream, SdkError> {
        let mut stream = tokio::net::UnixStream::connect(&self.channel.socket).await?;
        write_resource_header(
            &mut stream,
            &ResourceTransferRequest {
                version: RESOURCE_CHANNEL_VERSION,
                token: self.channel.token.clone(),
                parent_request: parent,
                transfer,
            },
        )
        .await?;
        Ok(stream)
    }
    pub async fn put<R: AsyncRead + Unpin>(
        &self,
        parent: RequestId,
        declaration: ResourceDeclaration,
        input: R,
    ) -> Result<ResourceReference, SdkError> {
        declaration.validate()?;
        let mut stream = self
            .connect(parent, ResourceTransfer::Put(declaration.clone()))
            .await?;
        let size = tokio::io::copy(&mut input.take(declaration.bytes + 1), &mut stream).await?;
        if size != declaration.bytes {
            return Err(SdkError::Invalid(
                "resource input differs from declared length".into(),
            ));
        }
        stream.shutdown().await?;
        match read_resource_header(&mut stream).await? {
            ResourceTransferResponse::Stored(reference)
                if reference.bytes == declaration.bytes
                    && reference.digest == declaration.digest
                    && reference.media_type == declaration.media_type =>
            {
                Ok(reference)
            }
            ResourceTransferResponse::Error { message } => Err(SdkError::Invalid(message)),
            _ => Err(SdkError::Invalid(
                "invalid resource storage acknowledgement".into(),
            )),
        }
    }
    pub async fn read(&self, parent: RequestId, read: ResourceRead) -> Result<Vec<u8>, SdkError> {
        read.validate()?;
        let mut stream = self
            .connect(parent, ResourceTransfer::Read(read.clone()))
            .await?;
        stream.shutdown().await?;
        let expected_bytes = (read.reference.bytes - read.offset).min(u64::from(read.limit)) as u32;
        let end = read.offset + u64::from(expected_bytes);
        match read_resource_header(&mut stream).await? {
            ResourceTransferResponse::Data {
                reference,
                offset,
                bytes,
                next,
            } if reference == read.reference
                && offset == read.offset
                && bytes == expected_bytes
                && next == (end < reference.bytes).then_some(end) =>
            {
                let mut data = vec![0; bytes as usize];
                stream.read_exact(&mut data).await?;
                if stream
                    .read_u8()
                    .await
                    .err()
                    .is_none_or(|e| e.kind() != std::io::ErrorKind::UnexpectedEof)
                {
                    return Err(SdkError::Invalid(
                        "resource response has trailing bytes or did not close cleanly".into(),
                    ));
                }
                Ok(data)
            }
            ResourceTransferResponse::Error { message } => Err(SdkError::Invalid(message)),
            _ => Err(SdkError::Invalid(
                "invalid resource read acknowledgement".into(),
            )),
        }
    }
}
