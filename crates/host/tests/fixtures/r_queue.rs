//! Acceptance through the public owner contract and original Host journal.
use super::*;
use rho_operation::OperationError;

pub async fn console(host: &NextHost, instance: &InstanceRef, session: &Value) -> Value {
    native_query(
        host,
        instance,
        "r.console",
        json!({"expected_session":session}),
    )
    .await
}
pub async fn wait(
    host: &NextHost,
    instance: &InstanceRef,
    session: &Value,
    predicate: impl Fn(&Value) -> bool,
) -> Value {
    tokio::time::timeout(Duration::from_secs(20), async {
        let mut interval = tokio::time::interval(Duration::from_millis(30));
        loop {
            interval.tick().await;
            let state = console(host, instance, session).await;
            if predicate(&state) {
                return state;
            }
        }
    })
    .await
    .expect("native queue observation deadline")
}
pub async fn control(
    host: &NextHost,
    instance: &InstanceRef,
    session: &Value,
    pause: bool,
    pause_id: Value,
    allowed: Value,
) -> Result<Value, OperationError> {
    let cap = if pause {
        "r.pause_queue"
    } else {
        "r.resume_queue"
    };
    let mut binding = binding(host, instance, cap).await;
    binding["target"] = session.clone();
    host.dispatch(&NextHost::local_context(),HostRequest::Control(ControlRequest {
        capability:CapabilityRef::new(cap,1).unwrap(),
        arguments:json!({"binding":binding,"arguments":{"session_id":session,"pause_id":pause_id,"only_operation_ids":allowed}}),
    })).await
}
pub async fn resume(host: &NextHost, instance: &InstanceRef, session: &Value, ids: Value) {
    let state = wait(host, instance, session, |s| {
        s["awaiting_commit"] == json!([])
    })
    .await;
    assert!(!state["console"]["pause"].is_null());
    control(
        host,
        instance,
        session,
        false,
        state["console"]["pause"]["id"].clone(),
        ids,
    )
    .await
    .unwrap();
}
async fn request(
    host: &NextHost,
    instance: &InstanceRef,
    session: &Value,
    id: &str,
    code: &str,
) -> Invocation {
    invocation(
        id,
        "r.execute",
        json!({"binding":binding(host,instance,"r.execute").await,"arguments":{"expected_session":session,"code":code}}),
    )
}
pub fn start(
    host: &Arc<NextHost>,
    request: Invocation,
) -> tokio::task::JoinHandle<Result<OperationRecord, OperationError>> {
    let host = host.clone();
    tokio::spawn(async move { host.invoke(&NextHost::local_context(), request).await })
}
pub async fn completed(
    task: tokio::task::JoinHandle<Result<OperationRecord, OperationError>>,
) -> OperationRecord {
    tokio::time::timeout(Duration::from_secs(20), task)
        .await
        .unwrap()
        .unwrap()
        .unwrap()
}
pub async fn exercise(
    host: &Arc<NextHost>,
    instance: &InstanceRef,
    session: &Value,
    db: &Path,
    project: &Path,
) {
    // Fail only the original terminal transaction, after native effects and the
    // exact recovery candidate have been retained. No simulated owner results.
    let sql = rusqlite::Connection::open(db).unwrap();
    sql.execute_batch("CREATE TRIGGER block_queue_commit BEFORE UPDATE OF status ON operations WHEN NEW.status='succeeded' AND OLD.client_request_id='queue-gated' BEGIN SELECT RAISE(ABORT,'queue acceptance terminal write fault'); END;").unwrap();
    let first = request(
        host,
        instance,
        session,
        "queue-gated",
        "queue_order <- 'first'; 'first'",
    )
    .await;
    let first_id = match host
        .invoke(&NextHost::local_context(), first.clone())
        .await
        .unwrap_err()
    {
        OperationError::CommitPending { operation_id, .. } => operation_id,
        error => panic!("expected original commit failure: {error}"),
    };
    let second=start(host,request(host,instance,session,"queue-second","writeLines('second', 'queue-second-started'); queue_order <- c(queue_order, 'second'); queue_order").await);
    let state = wait(host, instance, session, |s| {
        s["console"]["pending"].as_array().unwrap().len() == 1
    })
    .await;
    assert_eq!(state["awaiting_commit"], json!([first_id]));
    assert!(!project.join("queue-second-started").exists());
    let second_id = state["console"]["pending"][0]["operation_id"].clone();
    let pause = control(
        host,
        instance,
        session,
        true,
        Value::Null,
        json!([first_id, second_id]),
    )
    .await
    .unwrap();
    assert!(
        control(
            host,
            instance,
            session,
            false,
            pause["console"]["pause"]["id"].clone(),
            json!([first_id, second_id])
        )
        .await
        .is_err(),
        "a control cannot confirm a scientific commit"
    );
    let status = query(
        host,
        "operation.commit_status",
        json!({"operation_id":first_id}),
    )
    .await;
    assert_eq!(status["phase"], "durable");
    sql.execute_batch("DROP TRIGGER block_queue_commit;")
        .unwrap();
    let original = host
        .reconcile_commit(
            &NextHost::local_context(),
            &ReconcileOperationCommit {
                reference: serde_json::from_value(status["reference"].clone()).unwrap(),
            },
        )
        .await
        .unwrap();
    assert_eq!(original.status, OperationStatus::Succeeded);
    assert_eq!(original.operation.operation_id, first_id);
    assert!(
        !project.join("queue-second-started").exists(),
        "explicit pause survives settlement"
    );
    resume(host, instance, session, json!([second_id])).await;
    assert_eq!(
        completed(second).await.output.unwrap()["value"],
        json!(["first", "second"])
    );
    assert!(project.join("queue-second-started").is_file());
    assert_eq!(
        host.invoke(&NextHost::local_context(), first)
            .await
            .unwrap()
            .operation
            .operation_id,
        first_id
    );

    let failed = host
        .invoke(
            &NextHost::local_context(),
            request(
                host,
                instance,
                session,
                "queue-error",
                "queue_order <- c(queue_order, 'failed'); stop('queue acceptance failure')",
            )
            .await,
        )
        .await
        .unwrap();
    assert_eq!(failed.status, OperationStatus::Failed);
    let next = start(
        host,
        request(
            host,
            instance,
            session,
            "queue-after-error",
            "queue_order <- c(queue_order, 'resumed'); queue_order",
        )
        .await,
    );
    let state = wait(host, instance, session, |s| {
        s["console"]["pending"].as_array().unwrap().len() == 1 && s["awaiting_commit"] == json!([])
    })
    .await;
    let next_id = state["console"]["pending"][0]["operation_id"].clone();
    let pause_id = state["console"]["pause"]["id"].clone();
    assert!(
        control(
            host,
            instance,
            session,
            false,
            json!("stale-pause"),
            Value::Null
        )
        .await
        .is_err()
    );
    assert!(
        control(
            host,
            instance,
            session,
            false,
            pause_id.clone(),
            json!([next_id])
        )
        .await
        .is_err(),
        "failed original identity must remain in scope"
    );
    control(
        host,
        instance,
        session,
        false,
        pause_id,
        json!([failed.operation.operation_id, next_id]),
    )
    .await
    .unwrap();
    assert_eq!(
        completed(next).await.output.unwrap()["value"],
        json!(["first", "second", "failed", "resumed"])
    );

    let paused = control(host, instance, session, true, Value::Null, Value::Null)
        .await
        .unwrap();
    let cancelled = start(
        host,
        request(
            host,
            instance,
            session,
            "queue-pending-cancel",
            "writeLines('unexpected', 'cancelled-run-started')",
        )
        .await,
    );
    let state = wait(host, instance, session, |s| {
        s["console"]["pending"].as_array().unwrap().len() == 1
    })
    .await;
    let cancel_id: OperationId =
        serde_json::from_value(state["console"]["pending"][0]["operation_id"].clone()).unwrap();
    let after = start(
        host,
        request(
            host,
            instance,
            session,
            "queue-after-cancel",
            "'after pending cancellation'",
        )
        .await,
    );
    wait(host, instance, session, |s| {
        s["console"]["pending"].as_array().unwrap().len() == 2
    })
    .await;
    assert!(
        host.request_cancellation(&NextHost::local_context(), &cancel_id)
            .await
            .unwrap()
            .accepted
    );
    let cancelled = completed(cancelled).await;
    assert_eq!(cancelled.status, OperationStatus::Cancelled);
    assert_eq!(cancelled.output.unwrap()["started"], false);
    assert!(!project.join("cancelled-run-started").exists());
    let state = wait(host, instance, session, |s| {
        s["awaiting_commit"] == json!([])
    })
    .await;
    assert!(
        control(
            host,
            instance,
            session,
            false,
            paused["console"]["pause"]["id"].clone(),
            Value::Null
        )
        .await
        .is_err()
    );
    resume(
        host,
        instance,
        session,
        json!([cancel_id, state["console"]["pending"][0]["operation_id"]]),
    )
    .await;
    assert_eq!(
        completed(after).await.output.unwrap()["value"],
        "after pending cancellation"
    );
}

/// An unstarted owner exposes a stable queue target. The immutable session
/// creation contract does not support cancellation; pause/resume remains usable.
pub async fn paused_creation(host: &Arc<NextHost>, instance: &InstanceRef) -> OperationRecord {
    let initial = native_query(host, instance, "r.session", json!({})).await;
    assert_eq!(initial["state"], "unstarted");
    let target = initial["queue_target"].clone();
    assert!(target.as_str().unwrap().starts_with("unstarted:"));
    control(host, instance, &target, true, Value::Null, Value::Null)
        .await
        .unwrap();
    let creation = start(
        host,
        invocation(
            "paused-creation",
            "r.create_session",
            json!({"binding":binding(host,instance,"r.create_session").await,"arguments":{}}),
        ),
    );
    let state = wait(host, instance, &target, |s| {
        s["console"]["pending"].as_array().unwrap().len() == 1
    })
    .await;
    let id: OperationId =
        serde_json::from_value(state["console"]["pending"][0]["operation_id"].clone()).unwrap();
    assert!(matches!(
        host.request_cancellation(&NextHost::local_context(), &id)
            .await,
        Err(OperationError::CancellationUnsupported(_))
    ));
    assert_eq!(
        native_query(host, instance, "r.session", json!({})).await["state"],
        "unstarted"
    );
    resume(host, instance, &target, json!([id])).await;
    let result = completed(creation).await;
    assert_eq!(result.status, OperationStatus::Succeeded, "{result:?}");
    result
}

/// Exercise real process admission, not only the queue's in-memory limit. No R
/// statement may start while full, and observations/controls retain capacity.
pub async fn full_queue(
    host: &Arc<NextHost>,
    instance: &InstanceRef,
    session: &Value,
    project: &Path,
) {
    control(host, instance, session, true, Value::Null, Value::Null)
        .await
        .unwrap();
    let mut tasks = Vec::new();
    for n in 0..33 {
        tasks.push(start(
            host,
            request(
                host,
                instance,
                session,
                &format!("full-queue-{n}"),
                "writeLines('unexpected', 'full-queue-started')",
            )
            .await,
        ));
    }
    let state = wait(host, instance, session, |s| {
        s["console"]["pending"].as_array().unwrap().len() == 33
    })
    .await;
    assert_eq!(state["accepting"], false);
    assert!(state["console"]["current"].is_null());
    let ids: Vec<OperationId> = state["console"]["pending"]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| serde_json::from_value(v["operation_id"].clone()).unwrap())
        .collect();
    let overflow = completed(start(
        host,
        request(
            host,
            instance,
            session,
            "full-queue-overflow",
            "stop('overflow must not start')",
        )
        .await,
    ))
    .await;
    assert_eq!(overflow.status, OperationStatus::Failed, "{overflow:?}");
    assert_eq!(
        console(host, instance, session).await["console"]["pending"]
            .as_array()
            .unwrap()
            .len(),
        33
    );
    control(
        host,
        instance,
        session,
        true,
        state["console"]["pause"]["id"].clone(),
        json!(ids),
    )
    .await
    .unwrap();
    for id in &ids {
        assert!(
            host.request_cancellation(&NextHost::local_context(), id)
                .await
                .unwrap()
                .accepted
        );
    }
    for task in tasks {
        let result = completed(task).await;
        assert_eq!(result.status, OperationStatus::Cancelled, "{result:?}");
        assert_eq!(result.output.unwrap()["started"], false);
    }
    assert!(!project.join("full-queue-started").exists());
    let cleared = wait(host, instance, session, |s| {
        s["console"]["pending"] == json!([]) && s["awaiting_commit"] == json!([])
    })
    .await;
    assert_eq!(cleared["accepting"], true);
    resume(host, instance, session, json!(ids)).await;
}
