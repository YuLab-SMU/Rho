use agent_client_protocol::{Client, ConnectTo};
use tokio_util::compat::{TokioAsyncReadCompatExt, TokioAsyncWriteCompatExt};

pub(crate) fn acp_transport(
    stdin: tokio::process::ChildStdin,
    stdout: tokio::process::ChildStdout,
) -> impl ConnectTo<Client> {
    agent_client_protocol::ByteStreams::new(stdin.compat_write(), stdout.compat())
}
