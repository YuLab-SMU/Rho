use rho_host::NextHost;
use rho_operation::OperationError;
use std::sync::Arc;
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

#[tokio::test]
async fn a_project_has_one_host_even_when_database_paths_differ() {
    let temporary = tempfile::tempdir().unwrap();
    let project = temporary.path().join("project");
    std::fs::create_dir(&project).unwrap();
    let first = NextHost::open_project(temporary.path().join("first.sqlite"), &project)
        .await
        .unwrap();
    let second_database = temporary.path().join("second.sqlite");
    let second = NextHost::open_project(&second_database, &project).await;
    assert!(matches!(second, Err(OperationError::ProjectBusy(_))));
    let ark = rho_host::ArkConfig {
        executable: temporary.path().join("must-not-launch-ark"),
        r_home: temporary.path().join("must-not-use-r"),
        project_root: project.clone(),
        data_root: temporary.path().join("must-not-create-runtime"),
        execution_timeout: Duration::from_secs(10),
        library_path: None,
        checkpoint_helper_path: None,
    };
    assert!(matches!(
        NextHost::open_ark(&second_database, ark).await,
        Err(OperationError::ProjectBusy(_))
    ));
    let environment = rho_host::REnvironmentConfig {
        rscript: temporary.path().join("must-not-launch-rscript"),
        project_root: project.clone(),
        data_root: temporary.path().join("must-not-create-environment"),
        timeout: Duration::from_secs(10),
    };
    assert!(matches!(
        NextHost::open_environment(&second_database, environment).await,
        Err(OperationError::ProjectBusy(_))
    ));
    assert!(!temporary.path().join("must-not-create-runtime").exists());
    assert!(
        !temporary
            .path()
            .join("must-not-create-environment")
            .exists()
    );
    assert!(
        !second_database.exists(),
        "ownership refusal must precede journal creation"
    );
    drop(first);
    let replacement = NextHost::open_project(&second_database, &project)
        .await
        .unwrap();
    replacement.drain().await;
}

#[cfg(unix)]
#[tokio::test]
async fn canonical_aliases_share_the_lease_and_linked_metadata_is_rejected() {
    let temporary = tempfile::tempdir().unwrap();
    let root = temporary.path().join("project");
    std::fs::create_dir(&root).unwrap();
    let alias = temporary.path().join("alias");
    std::os::unix::fs::symlink(&root, &alias).unwrap();
    let host = NextHost::open_project(temporary.path().join("first.sqlite"), &root)
        .await
        .unwrap();
    assert!(matches!(
        NextHost::open_project(temporary.path().join("second.sqlite"), &alias).await,
        Err(OperationError::ProjectBusy(_))
    ));
    drop(host);
    let other = temporary.path().join("other");
    std::fs::create_dir(&other).unwrap();
    let target = temporary.path().join("metadata");
    std::fs::create_dir(&target).unwrap();
    std::os::unix::fs::symlink(&target, other.join(".rho")).unwrap();
    let database = temporary.path().join("rejected.sqlite");
    assert!(NextHost::open_project(&database, &other).await.is_err());
    assert!(!database.exists());
    assert!(std::fs::read_dir(&target).unwrap().next().is_none());
}

#[tokio::test]
async fn existing_lock_path_data_is_not_overwritten_and_project_patch_cannot_remove_lease() {
    use rho_contract::{CapabilityRef, Invocation, OperationStatus};
    use serde_json::json;
    let temporary = tempfile::tempdir().unwrap();
    let root = temporary.path().join("project");
    std::fs::create_dir(&root).unwrap();
    std::fs::create_dir(root.join(".rho")).unwrap();
    let lock = root.join(".rho/next-host.lock");
    std::fs::write(&lock, b"existing user material").unwrap();
    let database = temporary.path().join("next.sqlite");
    assert!(NextHost::open_project(&database, &root).await.is_err());
    assert!(!database.exists());
    assert_eq!(std::fs::read(&lock).unwrap(), b"existing user material");
    // Only the test fixture replaces its own file, before any Host owns it.
    std::fs::write(&lock, b"").unwrap();
    let host = NextHost::open_project(&database, &root).await.unwrap();
    let patch = "diff --git a/.rho/next-host.lock b/.rho/next-host.lock\ndeleted file mode 100644\nindex e69de29..0000000\n";
    let result = host
        .invoke(
            &NextHost::local_context(),
            Invocation {
                client_request_id: "remove-lease".into(),
                capability: CapabilityRef::new("project.apply_patch", 1).unwrap(),
                arguments: json!({"patch":patch}),
                preconditions: vec![],
            },
        )
        .await
        .unwrap();
    assert_eq!(result.status, OperationStatus::Failed, "{result:?}");
    assert!(lock.exists());
    assert!(result.error.unwrap().contains("host-owned"));
    let reader = NextHost::open_read_only(&database).unwrap();
    assert_eq!(
        reader
            .get_operation(&NextHost::local_context(), &result.operation.operation_id)
            .await
            .unwrap()
            .unwrap()
            .status,
        OperationStatus::Failed
    );
}

#[test]
fn ownership_holder() {
    let Some(project) = std::env::var_os("RHO_TEST_OWNERSHIP_PROJECT") else {
        return;
    };
    let database = std::env::var_os("RHO_TEST_OWNERSHIP_DATABASE").unwrap();
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    let _host = runtime
        .block_on(NextHost::open_project(database, project))
        .unwrap();
    println!("READY");
    use std::io::Write;
    std::io::stdout().flush().unwrap();
    loop {
        std::thread::park();
    }
}

#[tokio::test]
async fn a_crashed_host_releases_the_native_lock_without_deleting_a_stale_file() {
    let temporary = tempfile::tempdir().unwrap();
    let root = temporary.path().join("project");
    std::fs::create_dir(&root).unwrap();
    let mut child = tokio::process::Command::new(std::env::current_exe().unwrap())
        .args(["--exact", "ownership_holder", "--nocapture"])
        .env("RHO_TEST_OWNERSHIP_PROJECT", &root)
        .env(
            "RHO_TEST_OWNERSHIP_DATABASE",
            temporary.path().join("first.sqlite"),
        )
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::inherit())
        .kill_on_drop(true)
        .spawn()
        .unwrap();
    let mut output = BufReader::new(child.stdout.take().unwrap()).lines();
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let line = output
                .next_line()
                .await
                .unwrap()
                .expect("holder exited before READY");
            if line == "READY" {
                break;
            }
        }
    })
    .await
    .unwrap();
    let second = temporary.path().join("second.sqlite");
    assert!(matches!(
        NextHost::open_project(&second, &root).await,
        Err(OperationError::ProjectBusy(_))
    ));
    child.kill().await.unwrap();
    let lock = root.join(".rho/next-host.lock");
    assert!(lock.exists());
    let replacement = NextHost::open_project(second, &root).await.unwrap();
    assert_eq!(std::fs::metadata(&lock).unwrap().len(), 0);
    replacement.drain().await;
}

#[test]
fn native_process_fixture() {
    let Some(address) =
        std::env::args().find_map(|arg| arg.strip_prefix("rho-lease@").map(str::to_owned))
    else {
        return;
    };
    use std::io::{Read, Write};
    let mut socket = std::net::TcpStream::connect(address).unwrap();
    writeln!(socket, "{}", std::env::var("RHO_OPERATION_ID").unwrap()).unwrap();
    socket.read_exact(&mut [0]).unwrap();
    std::process::exit(0);
}

#[tokio::test]
async fn accepted_work_keeps_project_ownership_after_waiter_and_host_are_dropped() {
    use rho_contract::{CapabilityRef, Invocation, OperationId, OperationStatus};
    use serde_json::json;
    let temporary = tempfile::tempdir().unwrap();
    let root = temporary.path().join("project");
    std::fs::create_dir(&root).unwrap();
    let database = temporary.path().join("first.sqlite");
    let host = Arc::new(NextHost::open_project(&database, &root).await.unwrap());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let owned = host.clone();
    let address = listener.local_addr().unwrap();
    let waiter = tokio::spawn(async move {
        owned.invoke(&NextHost::local_context(), Invocation {
        client_request_id: "retained-lease".into(), capability: CapabilityRef::new("process.run_local", 1).unwrap(),
        arguments: json!({"program":std::env::current_exe().unwrap(), "args":["--exact","native_process_fixture","--nocapture","--skip",format!("rho-lease@{address}")]}), preconditions: vec![],
    }).await
    });
    let (socket, _) = tokio::time::timeout(Duration::from_secs(5), listener.accept())
        .await
        .unwrap()
        .unwrap();
    let mut socket = BufReader::new(socket);
    let mut id = String::new();
    tokio::time::timeout(Duration::from_secs(5), socket.read_line(&mut id))
        .await
        .unwrap()
        .unwrap();
    let id = OperationId::new(id.trim()).unwrap();
    waiter.abort();
    assert!(waiter.await.unwrap_err().is_cancelled());
    drop(host);
    let second = temporary.path().join("second.sqlite");
    assert!(matches!(
        NextHost::open_project(&second, &root).await,
        Err(OperationError::ProjectBusy(_))
    ));
    assert!(!second.exists());
    socket.get_mut().write_all(b"finish").await.unwrap();
    let replacement = tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            match NextHost::open_project(&second, &root).await {
                Ok(host) => break host,
                Err(OperationError::ProjectBusy(_)) => tokio::task::yield_now().await,
                Err(error) => panic!("{error}"),
            }
        }
    })
    .await
    .unwrap();
    let reader = NextHost::open_read_only(&database).unwrap();
    let saved = reader
        .get_operation(&NextHost::local_context(), &id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(saved.status, OperationStatus::Succeeded);
    assert!(!saved.cancellation_requested);
    replacement.drain().await;
}
