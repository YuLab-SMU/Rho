use std::net::SocketAddr;

use rho_protocol::{Envelope, MAX_FRAME_BYTES, MessageKind, PROTOCOL_VERSION};
use serde_json::json;
use thiserror::Error;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

#[derive(Debug, Error)]
pub enum AgentTransportError {
    #[error("I/O error: {0}")]
    Io(#[from] std::io::Error),
    #[error("invalid JSON frame: {0}")]
    Json(#[from] serde_json::Error),
    #[error("frame is too large: {0} bytes")]
    TooLarge(usize),
    #[error("unsupported protocol version: {0}")]
    ProtocolVersion(u16),
    #[error("agent connection did not originate from loopback: {0}")]
    NonLoopback(SocketAddr),
    #[error("bootstrap token has already been consumed")]
    TokenConsumed,
    #[error("first Agent R frame is not a valid authentication request")]
    InvalidAuthentication,
}

pub struct AgentAuthenticator {
    listener: TcpListener,
    token: Option<String>,
}

pub struct AuthenticatedAgent {
    pub stream: TcpStream,
    pub peer: SocketAddr,
}

impl AgentAuthenticator {
    pub async fn bind() -> Result<Self, AgentTransportError> {
        let listener = TcpListener::bind(("127.0.0.1", 0)).await?;
        let random: [u8; 32] = rand::random();
        let token = Some(hex_encode(&random));
        Ok(Self { listener, token })
    }

    pub fn local_addr(&self) -> Result<SocketAddr, AgentTransportError> {
        Ok(self.listener.local_addr()?)
    }

    pub fn bootstrap_token(&self) -> Result<&str, AgentTransportError> {
        self.token
            .as_deref()
            .ok_or(AgentTransportError::TokenConsumed)
    }

    pub async fn authenticate_next(&mut self) -> Result<AuthenticatedAgent, AgentTransportError> {
        let (mut stream, peer) = self.listener.accept().await?;
        if !peer.ip().is_loopback() {
            return Err(AgentTransportError::NonLoopback(peer));
        }
        let expected = self
            .token
            .as_deref()
            .ok_or(AgentTransportError::TokenConsumed)?;
        let envelope = read_async_frame(&mut stream).await?;
        let received = envelope
            .payload
            .get("token")
            .and_then(|value| value.as_str());
        let valid = envelope.kind == MessageKind::Request
            && envelope
                .payload
                .get("type")
                .and_then(|value| value.as_str())
                == Some("authenticate")
            && received
                .is_some_and(|value| constant_time_eq(expected.as_bytes(), value.as_bytes()));
        if !valid {
            return Err(AgentTransportError::InvalidAuthentication);
        }

        self.token.take();
        let response = Envelope::new(
            MessageKind::Response,
            json!({"type": "authenticated", "request_id": envelope.id}),
        );
        write_async_frame(&mut stream, &response).await?;
        Ok(AuthenticatedAgent { stream, peer })
    }
}

pub async fn write_async_frame(
    writer: &mut (impl AsyncWrite + Unpin),
    envelope: &Envelope,
) -> Result<(), AgentTransportError> {
    let bytes = serde_json::to_vec(envelope)?;
    if bytes.len() > MAX_FRAME_BYTES {
        return Err(AgentTransportError::TooLarge(bytes.len()));
    }
    writer
        .write_all(&(bytes.len() as u32).to_be_bytes())
        .await?;
    writer.write_all(&bytes).await?;
    writer.flush().await?;
    Ok(())
}

pub async fn read_async_frame(
    reader: &mut (impl AsyncRead + Unpin),
) -> Result<Envelope, AgentTransportError> {
    let mut length = [0_u8; 4];
    reader.read_exact(&mut length).await?;
    let length = u32::from_be_bytes(length) as usize;
    if length > MAX_FRAME_BYTES {
        return Err(AgentTransportError::TooLarge(length));
    }
    let mut bytes = vec![0; length];
    reader.read_exact(&mut bytes).await?;
    let envelope: Envelope = serde_json::from_slice(&bytes)?;
    if envelope.protocol_version != PROTOCOL_VERSION {
        return Err(AgentTransportError::ProtocolVersion(
            envelope.protocol_version,
        ));
    }
    Ok(envelope)
}

fn constant_time_eq(left: &[u8], right: &[u8]) -> bool {
    if left.len() != right.len() {
        return false;
    }
    left.iter()
        .zip(right)
        .fold(0_u8, |difference, (left, right)| {
            difference | (left ^ right)
        })
        == 0
}

fn hex_encode(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut output = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        output.push(HEX[(byte >> 4) as usize] as char);
        output.push(HEX[(byte & 0x0f) as usize] as char);
    }
    output
}

#[cfg(test)]
mod tests {
    use super::*;

    fn auth_frame(token: &str) -> Envelope {
        Envelope::new(
            MessageKind::Request,
            json!({"type": "authenticate", "token": token}),
        )
    }

    #[tokio::test]
    async fn accepts_one_token_and_rejects_replay() {
        let mut authenticator = AgentAuthenticator::bind().await.unwrap();
        let address = authenticator.local_addr().unwrap();
        let token = authenticator.bootstrap_token().unwrap().to_string();

        let first = tokio::spawn(async move {
            let mut stream = TcpStream::connect(address).await.unwrap();
            write_async_frame(&mut stream, &auth_frame(&token))
                .await
                .unwrap();
            read_async_frame(&mut stream).await.unwrap()
        });
        let authenticated = authenticator.authenticate_next().await.unwrap();
        assert!(authenticated.peer.ip().is_loopback());
        let response = first.await.unwrap();
        assert_eq!(response.payload["type"], "authenticated");

        let address = authenticator.local_addr().unwrap();
        let replay = tokio::spawn(async move { TcpStream::connect(address).await.unwrap() });
        let _replay_stream = replay.await.unwrap();
        assert!(matches!(
            authenticator.authenticate_next().await,
            Err(AgentTransportError::TokenConsumed)
        ));
    }

    #[tokio::test]
    async fn rejects_bad_token_without_consuming_real_token() {
        let mut authenticator = AgentAuthenticator::bind().await.unwrap();
        let address = authenticator.local_addr().unwrap();
        let bad_client = tokio::spawn(async move {
            let mut stream = TcpStream::connect(address).await.unwrap();
            write_async_frame(&mut stream, &auth_frame("wrong"))
                .await
                .unwrap();
        });
        assert!(matches!(
            authenticator.authenticate_next().await,
            Err(AgentTransportError::InvalidAuthentication)
        ));
        bad_client.await.unwrap();
        assert_eq!(authenticator.bootstrap_token().unwrap().len(), 64);
    }
}
