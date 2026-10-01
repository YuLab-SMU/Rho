use crate::{PluginError, PluginResources, ensure};
use rho_plugin_protocol::*;
use rho_plugin_sdk::{read_resource_header, write_resource_header};
use std::{
    collections::BTreeMap,
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::{
    io::{AsyncReadExt, AsyncSeekExt, AsyncWriteExt},
    net::{UnixListener, UnixStream},
    task::{JoinHandle, JoinSet},
};

#[derive(Default)]
struct State {
    calls: BTreeMap<RequestId, PluginCall>,
    transfers: usize,
    closed: bool,
}
#[derive(Clone, Default)]
pub(crate) struct ResourceSession(Arc<Mutex<State>>);
impl ResourceSession {
    pub fn insert(&self, call: &PluginCall) {
        self.0
            .lock()
            .unwrap()
            .calls
            .insert(call.request.clone(), call.clone());
    }
    pub fn remove(&self, request: &RequestId) {
        self.0.lock().unwrap().calls.remove(request);
    }
    pub fn close_if_idle(&self) -> bool {
        let mut state = self.0.lock().unwrap();
        if !state.calls.is_empty() || state.transfers > 0 {
            return false;
        }
        state.closed = true;
        true
    }
    fn admit(
        &self,
        request: &RequestId,
        permit: tokio::sync::OwnedSemaphorePermit,
    ) -> Result<TransferLease, PluginError> {
        let mut state = self.0.lock().unwrap();
        ensure(!state.closed, "resource channel has been revoked")?;
        let call = state.calls.get(request).cloned().ok_or_else(|| {
            PluginError::Unavailable("resource transfer has no active parent request".into())
        })?;
        state.transfers += 1;
        Ok(TransferLease {
            session: self.clone(),
            call,
            _permit: permit,
        })
    }
}
struct TransferLease {
    _permit: tokio::sync::OwnedSemaphorePermit,
    session: ResourceSession,
    call: PluginCall,
}
impl Drop for TransferLease {
    fn drop(&mut self) {
        self.session.0.lock().unwrap().transfers -= 1;
    }
}

pub(crate) struct DataChannel {
    pub endpoint: ResourceChannel,
    pub session: ResourceSession,
    task: JoinHandle<()>,
    _directory: tempfile::TempDir,
}
impl Drop for DataChannel {
    fn drop(&mut self) {
        self.session.0.lock().unwrap().closed = true;
        self.task.abort();
    }
}
impl DataChannel {
    pub fn start(resources: Arc<PluginResources>) -> Result<Self, PluginError> {
        // Keep the path below macOS's sockaddr_un limit; the private directory and
        // unpredictable credential belong only to this process incarnation.
        let directory = tempfile::Builder::new()
            .prefix("rho-data-")
            .tempdir_in("/tmp")?;
        let path = directory.path().join("data.sock");
        let listener = UnixListener::bind(&path)?;
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600))?;
        let endpoint = ResourceChannel {
            version: RESOURCE_CHANNEL_VERSION,
            socket: path.to_string_lossy().into(),
            token: format!(
                "{}{}",
                uuid::Uuid::new_v4().simple(),
                uuid::Uuid::new_v4().simple()
            ),
        };
        let token = endpoint.token.clone();
        let session = ResourceSession::default();
        let active = session.clone();
        let task = tokio::spawn(async move {
            let mut tasks = JoinSet::new();
            loop {
                tokio::select! {
                    accepted = listener.accept() => {
                        let Ok((mut stream, _)) = accepted else { break };
                        let Ok(permit) = resources.transfers.clone().try_acquire_owned() else { continue };
                        let resources = resources.clone(); let token = token.clone(); let active = active.clone();
                        tasks.spawn(async move {
                            let result = tokio::time::timeout(Duration::from_secs(120), transfer(&mut stream, resources, active, &token, permit)).await;
                            let error = match result { Ok(Ok(())) => None, Ok(Err(e)) => Some(e.to_string()), Err(_) => Some("resource transfer timed out; unconfirmed bytes are not evidence".into()) };
                            if let Some(message) = error {
                                let _ = tokio::time::timeout(Duration::from_secs(2), write_resource_header(&mut stream, &ResourceTransferResponse::Error { message })).await;
                            }
                        });
                    },
                    _ = tasks.join_next(), if !tasks.is_empty() => {},
                }
            }
            // JoinSet aborts unfinished socket transfers when this endpoint dies.
        });
        Ok(Self {
            endpoint,
            session,
            task,
            _directory: directory,
        })
    }
}
async fn transfer(
    stream: &mut UnixStream,
    resources: Arc<PluginResources>,
    session: ResourceSession,
    token: &str,
    permit: tokio::sync::OwnedSemaphorePermit,
) -> Result<(), PluginError> {
    let request: ResourceTransferRequest = read_resource_header(stream).await?;
    ensure(
        request.version == RESOURCE_CHANNEL_VERSION && request.token == token,
        "invalid resource transport identity",
    )?;
    let lease = session.admit(&request.parent_request, permit)?;
    match request.transfer {
        ResourceTransfer::Put(declaration) => {
            resources.declaration(&declaration)?;
            // Anonymous staging is automatically removed on EOF, rejection, task
            // cancellation or process failure. Only a complete atomic retain is visible.
            let mut file = tokio::fs::File::from_std(tempfile::tempfile()?);
            let size =
                tokio::io::copy(&mut (&mut *stream).take(declaration.bytes + 1), &mut file).await?;
            ensure(
                size == declaration.bytes,
                "resource transfer differs from declared length",
            )?;
            file.flush().await?;
            file.rewind().await?;
            let file = file.into_std().await;
            let (_lease, retained) = tokio::task::spawn_blocking(move || {
                // Keep the native-call lease through the atomic storage step even
                // if the socket task loses its acknowledgement or is aborted.
                let retained = resources.retain(&lease.call, &declaration, file);
                (lease, retained)
            })
            .await
            .map_err(|e| PluginError::Unavailable(e.to_string()))?;
            let reference = retained?;
            write_resource_header(stream, &ResourceTransferResponse::Stored(reference)).await?;
        }
        ResourceTransfer::Read(read) => {
            read.validate()?;
            ensure(
                read.reference.owner == lease.call.binding.provider,
                "native resource channel can read only its own instance; use a granted Host query for other owners",
            )?;
            let mut extra = [0];
            ensure(
                stream.read(&mut extra).await? == 0,
                "resource read has trailing bytes",
            )?;
            let request = read.clone();
            let (_lease, retained) = tokio::task::spawn_blocking(move || {
                let retained =
                    resources.read(&lease.call.binding.project, &lease.call.principal, &request);
                (lease, retained)
            })
            .await
            .map_err(|e| PluginError::Unavailable(e.to_string()))?;
            let bytes = retained?;
            let end = read.offset + bytes.len() as u64;
            write_resource_header(
                stream,
                &ResourceTransferResponse::Data {
                    reference: read.reference.clone(),
                    offset: read.offset,
                    bytes: bytes.len() as u32,
                    next: (end < read.reference.bytes).then_some(end),
                },
            )
            .await?;
            stream.write_all(&bytes).await?;
        }
    }
    stream.shutdown().await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::content_digest;
    use rho_plugin_sdk::ResourceClient;
    use serde_json::json;

    fn call() -> PluginCall {
        serde_json::from_value(json!({"request":"active-request","binding":{"capability":{"id":"test.read","version":1},
            "provider":{"instance":"instance-one","plugin":"test.plugin","revision":format!("sha256:{}","1".repeat(64)),"artifact":format!("sha256:{}","2".repeat(64))},
            "project":"project-one","target":null},"principal":"principal-one","scopes":[],"arguments":{},"preconditions":{},"owner_context":{},"operation_id":null})).unwrap()
    }
    fn declaration(bytes: &[u8]) -> ResourceDeclaration {
        ResourceDeclaration {
            digest: content_digest(bytes),
            bytes: bytes.len() as u64,
            media_type: "application/octet-stream".into(),
        }
    }

    #[tokio::test]
    async fn complete_upload_is_discoverable_when_the_client_never_reads_its_acknowledgement() {
        let temp = tempfile::tempdir().unwrap();
        let store = Arc::new(PluginResources::open(temp.path()).unwrap());
        let channel = DataChannel::start(store.clone()).unwrap();
        let call = call();
        channel.session.insert(&call);
        let mut stream = UnixStream::connect(&channel.endpoint.socket).await.unwrap();
        write_resource_header(
            &mut stream,
            &ResourceTransferRequest {
                version: RESOURCE_CHANNEL_VERSION,
                token: channel.endpoint.token.clone(),
                parent_request: call.request.clone(),
                transfer: ResourceTransfer::Put(declaration(b"recover me")),
            },
        )
        .await
        .unwrap();
        stream.write_all(b"recover me").await.unwrap();
        stream.shutdown().await.unwrap();
        let list = ResourceList {
            owner: Some(call.binding.provider.clone()),
            after: None,
            limit: 1,
        };
        let reference = tokio::time::timeout(Duration::from_secs(3), async {
            loop {
                let page = store
                    .list(&call.binding.project, &call.principal, &list)
                    .unwrap();
                if let Some(reference) = page.items.into_iter().next() {
                    break reference;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        drop(stream); // No resource acknowledgement was ever consumed.
        drop(channel);
        assert_eq!(
            store
                .inspect(&call.binding.project, &call.principal, &reference)
                .unwrap(),
            reference
        );
        assert_eq!(
            store
                .read(
                    &call.binding.project,
                    &call.principal,
                    &ResourceRead {
                        reference,
                        offset: 0,
                        limit: 100
                    }
                )
                .unwrap(),
            b"recover me"
        );
    }

    #[tokio::test]
    async fn resource_channel_transfers_large_bytes_and_fences_closed_or_missing_parents() {
        let temp = tempfile::tempdir().unwrap();
        let store = Arc::new(PluginResources::open(temp.path()).unwrap());
        let channel = DataChannel::start(store.clone()).unwrap();
        let call = call();
        channel.session.insert(&call);
        let client = ResourceClient::new(channel.endpoint.clone()).unwrap();
        let bytes: Vec<u8> = (0..2_100_001).map(|i| (i % 251) as u8).collect();
        let reference = client
            .put(call.request.clone(), declaration(&bytes), bytes.as_slice())
            .await
            .unwrap();
        assert_eq!(reference.owner, call.binding.provider);
        let read = ResourceRead {
            reference: reference.clone(),
            offset: 65000,
            limit: 262144,
        };
        assert_eq!(
            client.read(call.request.clone(), read).await.unwrap(),
            bytes[65000..65000 + 262144]
        );
        assert_eq!(
            store
                .inspect(&call.binding.project, &call.principal, &reference)
                .unwrap(),
            reference
        );
        channel.session.remove(&call.request);
        assert!(
            client
                .put(call.request.clone(), declaration(b"x"), &b"x"[..])
                .await
                .is_err()
        );
        assert!(channel.session.close_if_idle());
        channel.session.insert(&call); // Even a reused request identity cannot reopen a revoked incarnation.
        assert!(
            client
                .put(call.request.clone(), declaration(b"x"), &b"x"[..])
                .await
                .is_err()
        );
        let path = channel.endpoint.socket.clone();
        drop(channel);
        assert!(UnixStream::connect(path).await.is_err());
        assert!(
            store
                .inspect(&call.binding.project, &call.principal, &reference)
                .is_ok()
        );
    }

    #[tokio::test]
    async fn resource_channel_rejects_forged_tokens_headers_digests_and_cross_owner_reads() {
        let temp = tempfile::tempdir().unwrap();
        let store = Arc::new(PluginResources::open(temp.path()).unwrap());
        let channel = DataChannel::start(store.clone()).unwrap();
        let call = call();
        channel.session.insert(&call);
        let mut fake = channel.endpoint.clone();
        fake.token = "f".repeat(64);
        let fake = ResourceClient::new(fake).unwrap();
        assert!(
            fake.put(call.request.clone(), declaration(b""), &b""[..])
                .await
                .is_err()
        );
        let mut stream = UnixStream::connect(&channel.endpoint.socket).await.unwrap();
        stream
            .write_u32(MAX_RESOURCE_HEADER_BYTES as u32 + 1)
            .await
            .unwrap();
        stream.shutdown().await.unwrap();
        assert!(matches!(
            read_resource_header(&mut stream).await.unwrap(),
            ResourceTransferResponse::Error { .. }
        ));
        let client = ResourceClient::new(channel.endpoint.clone()).unwrap();
        assert!(
            client
                .put(call.request.clone(), declaration(b"yes"), &b"bad"[..])
                .await
                .is_err()
        );
        let reference = client
            .put(call.request.clone(), declaration(b"yes"), &b"yes"[..])
            .await
            .unwrap();
        let mut other = call.clone();
        other.binding.provider.instance = PluginInstanceId::new("other-instance").unwrap();
        let foreign = store
            .retain(&other, &declaration(b"yes"), std::io::Cursor::new(b"yes"))
            .unwrap();
        assert!(
            client
                .read(
                    call.request.clone(),
                    ResourceRead {
                        reference: foreign,
                        offset: 0,
                        limit: 3
                    }
                )
                .await
                .is_err()
        );
        assert_eq!(
            client
                .read(
                    call.request.clone(),
                    ResourceRead {
                        reference,
                        offset: 0,
                        limit: 3
                    }
                )
                .await
                .unwrap(),
            b"yes"
        );
    }

    #[tokio::test]
    async fn incomplete_upload_retains_its_transfer_lease_until_failure_and_does_not_seal() {
        let temp = tempfile::tempdir().unwrap();
        let store = Arc::new(
            PluginResources::open_with_limits(
                temp.path(),
                crate::ResourceLimits {
                    bytes: 10,
                    instance_bytes: 6,
                    total_bytes: 6,
                    count: 1,
                },
            )
            .unwrap(),
        );
        let channel = DataChannel::start(store).unwrap();
        let call = call();
        channel.session.insert(&call);
        let mut stream = UnixStream::connect(&channel.endpoint.socket).await.unwrap();
        write_resource_header(
            &mut stream,
            &ResourceTransferRequest {
                version: 1,
                token: channel.endpoint.token.clone(),
                parent_request: call.request.clone(),
                transfer: ResourceTransfer::Put(declaration(b"sample")),
            },
        )
        .await
        .unwrap();
        tokio::time::timeout(Duration::from_secs(3), async {
            while channel.session.0.lock().unwrap().transfers == 0 {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        channel.session.remove(&call.request);
        assert!(!channel.session.close_if_idle());
        stream.write_all(b"sam").await.unwrap();
        stream.shutdown().await.unwrap();
        assert!(matches!(
            read_resource_header(&mut stream).await.unwrap(),
            ResourceTransferResponse::Error { .. }
        ));
        channel.session.insert(&call);
        let client = ResourceClient::new(channel.endpoint.clone()).unwrap();
        assert!(
            client
                .put(call.request.clone(), declaration(b"sample"), &b"sample"[..])
                .await
                .is_ok(),
            "partial upload did not consume retained quota"
        );
        channel.session.remove(&call.request);
        assert!(channel.session.close_if_idle());
    }
}
