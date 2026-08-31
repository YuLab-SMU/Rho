use std::{cell::RefCell, collections::VecDeque, rc::Rc};

use rho_execution::ssh::*;
use rho_protocol::*;

#[derive(Default)]
struct ChannelState {
    sent: Vec<Vec<u8>>,
    responses: VecDeque<Result<Option<Vec<u8>>, SshTransportError>>,
    stderr: Vec<u8>,
    keepalives: usize,
}

struct FakeChannel {
    state: Rc<RefCell<ChannelState>>,
    host_key: String,
    runner_digest: String,
    version: u16,
}

impl SshRunnerChannel for FakeChannel {
    fn peer_host_key_sha256(&self) -> &str {
        &self.host_key
    }

    fn runner_sha256(&mut self, _runner_path: &str) -> Result<String, SshTransportError> {
        Ok(self.runner_digest.clone())
    }

    fn runner_protocol_version(&mut self) -> Result<u16, SshTransportError> {
        Ok(self.version)
    }

    fn send_frame(&mut self, bytes: &[u8]) -> Result<(), SshTransportError> {
        self.state.borrow_mut().sent.push(bytes.to_vec());
        Ok(())
    }

    fn receive_frame(&mut self) -> Result<Option<Vec<u8>>, SshTransportError> {
        self.state
            .borrow_mut()
            .responses
            .pop_front()
            .unwrap_or(Ok(None))
    }

    fn take_stderr(&mut self) -> Vec<u8> {
        std::mem::take(&mut self.state.borrow_mut().stderr)
    }

    fn keepalive(&mut self) -> Result<(), SshTransportError> {
        self.state.borrow_mut().keepalives += 1;
        Ok(())
    }
}

struct FakeConnector {
    state: Rc<RefCell<ChannelState>>,
    connects: Rc<RefCell<usize>>,
    host_key: String,
    runner_digest: String,
    version: u16,
    bootstraps: Rc<RefCell<Vec<SshBootstrapCommand>>>,
}

impl SshConnector for FakeConnector {
    type Channel = FakeChannel;

    fn connect(
        &mut self,
        _admission: &SshTargetAdmission,
        bootstrap: &SshBootstrapCommand,
    ) -> Result<Self::Channel, SshTransportError> {
        *self.connects.borrow_mut() += 1;
        self.bootstraps.borrow_mut().push(bootstrap.clone());
        Ok(FakeChannel {
            state: self.state.clone(),
            host_key: self.host_key.clone(),
            runner_digest: self.runner_digest.clone(),
            version: self.version,
        })
    }
}

fn digest(character: char) -> String {
    format!("sha256:{}", character.to_string().repeat(64))
}

fn admission() -> SshTargetAdmission {
    SshTargetAdmission {
        target_id: "target_yulab".to_string(),
        host: "login.example.org".to_string(),
        port: 22,
        user: "rho_runner".to_string(),
        expected_host_key_sha256: digest('a'),
        runner_path: "/opt/rho/bin/rho-runner".to_string(),
        runner_sha256: digest('b'),
        runner_protocol_version: 1,
        credential_ref: SecretRef::new(
            SecretId::new("secret_ssh").unwrap(),
            SecretPurpose::RemoteExecutionCredential,
            DestinationClass::RemoteExecutor,
        ),
    }
}

type Shared<T> = Rc<RefCell<T>>;
type ConnectorFixture = (
    FakeConnector,
    Shared<ChannelState>,
    Shared<usize>,
    Shared<Vec<SshBootstrapCommand>>,
);

fn connector(responses: VecDeque<Result<Option<Vec<u8>>, SshTransportError>>) -> ConnectorFixture {
    let state = Rc::new(RefCell::new(ChannelState {
        responses,
        ..ChannelState::default()
    }));
    let connects = Rc::new(RefCell::new(0));
    let bootstraps = Rc::new(RefCell::new(Vec::new()));
    (
        FakeConnector {
            state: state.clone(),
            connects: connects.clone(),
            host_key: digest('a'),
            runner_digest: digest('b'),
            version: 1,
            bootstraps: bootstraps.clone(),
        },
        state,
        connects,
        bootstraps,
    )
}

#[test]
fn ssh_fixed_bootstrap_contains_no_agent_script_secret_or_giant_spec() {
    let command = bootstrap_command(&admission(), "secret-lease-ssh-operation").unwrap();
    assert_eq!(command.executable, "ssh");
    assert!(
        command
            .argv
            .contains(&"/opt/rho/bin/rho-runner".to_string())
    );
    assert!(command.argv.contains(&"--stdio".to_string()));
    let encoded = serde_json::to_string(&command).unwrap();
    for forbidden in [
        "CANARY_SSH_PRIVATE_KEY",
        "ExecutionSpec",
        "agent script",
        "sh -c",
    ] {
        assert!(!encoded.contains(forbidden));
    }
    assert!(encoded.len() < 2048);
}

#[test]
fn ssh_validates_host_key_runner_digest_version_and_pools_channel() {
    let (connector, state, connects, bootstraps) = connector(
        [
            Ok(Some(b"response-one".to_vec())),
            Ok(Some(b"response-two".to_vec())),
        ]
        .into(),
    );
    let mut transport = SshRunnerTransport::new(connector);
    for frame in [b"request-one".as_slice(), b"request-two".as_slice()] {
        assert!(matches!(
            transport
                .request(&admission(), "secret-lease-ssh-operation", frame, None,)
                .unwrap(),
            SshTransportOutcome::Response(_)
        ));
    }
    assert_eq!(*connects.borrow(), 1);
    assert_eq!(transport.pool_size(), 1);
    assert_eq!(state.borrow().sent.len(), 2);
    assert_eq!(state.borrow().keepalives, 2);
    assert_eq!(bootstraps.borrow().len(), 1);
}

#[test]
fn ssh_host_key_runner_digest_and_version_mismatch_fail_closed_before_frame() {
    for (host_key, runner_digest, version, expected) in [
        (
            digest('x'),
            digest('b'),
            1,
            SshTransportError::HostKeyMismatch,
        ),
        (
            digest('a'),
            digest('x'),
            1,
            SshTransportError::RunnerDigestMismatch,
        ),
        (
            digest('a'),
            digest('b'),
            2,
            SshTransportError::RunnerVersionMismatch,
        ),
    ] {
        let (mut connector, state, _, _) = connector(VecDeque::new());
        connector.host_key = host_key;
        connector.runner_digest = runner_digest;
        connector.version = version;
        let mut transport = SshRunnerTransport::new(connector);
        assert_eq!(
            transport
                .request(&admission(), "secret-lease-ssh-operation", b"request", None,)
                .unwrap_err(),
            expected
        );
        assert!(state.borrow().sent.is_empty());
    }
}

#[test]
fn ssh_disconnect_eof_is_uncertain_then_reconnect_queries_runner_identity() {
    let (connector, state, connects, _) =
        connector([Ok(None), Ok(Some(b"reconciled-running".to_vec()))].into());
    let mut transport = SshRunnerTransport::new(connector);
    let execution_id = ExecutionId::new("execution_ssh_disconnect").unwrap();
    let disconnected = transport
        .request(
            &admission(),
            "secret-lease-ssh-operation",
            b"submit",
            Some(execution_id.clone()),
        )
        .unwrap();
    assert!(matches!(
        disconnected,
        SshTransportOutcome::Disconnected { state, reason_code, .. }
            if state == "uncertain" && reason_code.contains("not_job_terminal")
    ));
    let reconciled = transport
        .reconnect_reconcile(
            &admission(),
            "secret-lease-ssh-operation",
            b"authenticated-reconcile-by-operation-job-id",
            execution_id,
        )
        .unwrap();
    assert!(matches!(reconciled, SshTransportOutcome::Response(_)));
    assert_eq!(*connects.borrow(), 2);
    assert_eq!(state.borrow().sent.len(), 2);
}

#[test]
fn ssh_key_is_secret_ref_and_stderr_is_bounded_redacted_not_semantic() {
    let (connector, state, _, _) = connector([Ok(Some(b"ok".to_vec()))].into());
    state.borrow_mut().stderr = b"private key token=CANARY_SSH_SECRET".to_vec();
    let mut transport = SshRunnerTransport::new(connector);
    transport
        .request(&admission(), "secret-lease-ssh-operation", b"status", None)
        .unwrap();
    assert_eq!(transport.diagnostics().len(), 1);
    assert_eq!(transport.diagnostics()[0].detail, "SSH diagnostic redacted");
    assert!(
        !serde_json::to_string(&admission())
            .unwrap()
            .contains("CANARY_SSH_SECRET")
    );
}

#[test]
fn ssh_wrong_secret_purpose_invalid_target_and_oversized_frame_fail_before_connect() {
    let (connector, _, connects, _) = connector(VecDeque::new());
    let mut transport = SshRunnerTransport::new(connector);
    let mut wrong = admission();
    wrong.credential_ref.purpose = SecretPurpose::ProviderCredential;
    assert_eq!(
        transport
            .request(&wrong, "lease", b"request", None)
            .unwrap_err(),
        SshTransportError::CredentialRejected
    );
    let mut invalid = admission();
    invalid.host = "host;rm".to_string();
    assert_eq!(
        transport
            .request(&invalid, "lease", b"request", None)
            .unwrap_err(),
        SshTransportError::InvalidTarget
    );
    assert_eq!(
        transport
            .request(
                &admission(),
                "lease",
                &vec![0; MAX_SSH_FRAME_BYTES + 1],
                None,
            )
            .unwrap_err(),
        SshTransportError::FrameTooLarge
    );
    assert_eq!(*connects.borrow(), 0);
}

#[test]
fn ssh_boundary_is_transport_only_no_shell_spec_secret_or_eof_terminal() {
    let (_, does_not_own) = ssh_boundary();
    assert!(does_not_own.contains(&"job_shell_command"));
    assert!(does_not_own.contains(&"secret_argv"));
    assert!(does_not_own.contains(&"spec_in_command_line"));
    assert!(does_not_own.contains(&"transport_eof_terminal"));
    assert!(does_not_own.contains(&"general_child_environment"));
}
