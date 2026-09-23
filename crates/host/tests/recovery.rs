use std::io::{BufRead, BufReader, Write};
use std::process::{Child, Command, Stdio};

use rho_contract::{CapabilityRef, Operation, OperationId, OperationStatus, TargetRef};
use rho_host::NextHost;
use rho_operation::OperationJournal;
use rho_sqlite::SqliteOperationJournal;
use serde_json::json;

const CHILD_DB: &str = "RHO_TEST_CRASH_DB";

// Executed as a subprocess by the parent test; the parent terminates it after a real effect.
#[test]
fn crash_worker() {
    let Some(path) = std::env::var_os(CHILD_DB) else {
        return;
    };
    let runtime = tokio::runtime::Builder::new_current_thread()
        .build()
        .unwrap();
    let journal = SqliteOperationJournal::open(&path).unwrap();
    runtime.block_on(async {
        let operation = Operation { admission: None,
            principal: None,
            operation_id: OperationId::new("op_crashed").unwrap(),
            client_request_id: "interrupted".into(),
            caller: NextHost::local_context().caller,
            capability: CapabilityRef::new("workspace.run_r", 1).unwrap(),
            domain: "workspace".into(),
            target: TargetRef {
                kind: "workspace".into(),
                identity: "dead-session".into(),
            },
            normalized_arguments: json!({"code": "external effect"}),
            invocation_digest: "sha256:test".into(),
            idempotency_scope: None,
            preconditions: Vec::new(),
            potential_effects: Default::default(),
            correlation_id: "op_crashed".into(),
            causation_id: None,
            trace_parent: None,
            accepted_at_ms: 1,
        };
        journal.admit(&operation).await.unwrap();
        journal
            .mark_running(&operation.operation_id, 2)
            .await
            .unwrap();
    });
    let marker = std::path::Path::new(&path).with_extension("effect");
    std::fs::write(marker, b"effect happened exactly once").unwrap();
    println!("READY");
    std::io::stdout().flush().unwrap();
    loop {
        std::thread::park();
    }
}

struct ChildGuard(Child);
impl Drop for ChildGuard {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

#[tokio::test]
async fn crash_after_real_effect_preserves_uncertainty_and_readers_do_not_recover_live_process() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("next.sqlite");
    let mut child = ChildGuard(
        Command::new(std::env::current_exe().unwrap())
            .args(["--exact", "crash_worker", "--nocapture"])
            .env(CHILD_DB, &path)
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()
            .unwrap(),
    );
    let mut output = BufReader::new(child.0.stdout.take().unwrap());
    loop {
        let mut line = String::new();
        assert_ne!(
            output.read_line(&mut line).unwrap(),
            0,
            "crash worker exited before READY"
        );
        if line.trim() == "READY" {
            break;
        }
    }
    let context = NextHost::local_context();
    let id = OperationId::new("op_crashed").unwrap();
    {
        let reader = NextHost::open_read_only(&path).unwrap();
        assert_eq!(
            reader
                .get_operation(&context, &id)
                .await
                .unwrap()
                .unwrap()
                .status,
            OperationStatus::Running
        );
        assert!(NextHost::open_demo(&path).await.is_err());
        assert_eq!(
            reader
                .get_operation(&context, &id)
                .await
                .unwrap()
                .unwrap()
                .status,
            OperationStatus::Running
        );
    }
    child.0.kill().unwrap();
    child.0.wait().unwrap();

    let restarted = NextHost::open_demo(&path).await.unwrap();
    assert_eq!(restarted.recovered_on_open().len(), 1);
    let recovered = restarted
        .get_operation(&context, &id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(recovered.status, OperationStatus::Uncertain);
    assert!(recovered.recovery.is_some());
    assert_eq!(
        std::fs::read(path.with_extension("effect")).unwrap(),
        b"effect happened exactly once"
    );
    let events = restarted.events(&context, &id).await.unwrap();
    assert_eq!(
        events
            .iter()
            .filter(|event| event.kind == "operation.terminal")
            .count(),
        1
    );
    drop(restarted);
    let second_restart = NextHost::open_demo(&path).await.unwrap();
    assert!(second_restart.recovered_on_open().is_empty());
    assert_eq!(second_restart.events(&context, &id).await.unwrap(), events);
}
