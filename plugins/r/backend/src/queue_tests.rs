use super::*;
use serde_json::json;
use std::{future::Future, pin::Pin};

fn call(id: &str) -> PluginCall {
    serde_json::from_value(json!({
        "request":id,"operation_id":id,"principal":"principal","scopes":["workspace.run_r"],
        "binding":{"capability":{"id":"r.execute","version":1},"provider":{"instance":"instance","plugin":"org.rho.r",
        "revision":format!("sha256:{}","a".repeat(64)),"artifact":format!("sha256:{}","b".repeat(64))},"project":"project","target":"native-session"},
        "arguments":{"code":"中文 + 1","expected_session":"native-session"},"preconditions":null,"owner_context":null
    })).unwrap()
}
fn id(call: &PluginCall) -> OperationId {
    OperationId::new(call.operation_id.as_ref().unwrap()).unwrap()
}
fn settled(call: &PluginCall, outcome: PluginOutcome) -> OperationSettlement {
    OperationSettlement {
        operation_id: id(call),
        binding: call.binding.clone(),
        outcome,
    }
}
fn control(queue: &Queue, pause: bool, allowed: Option<Vec<OperationId>>) -> Result<(), String> {
    queue.control(
        pause,
        &QueueControlArguments {
            session_id: "native-session".into(),
            pause_id: queue
                .observe("native-session", None)
                .console
                .pause
                .map(|p| p.id),
            only_operation_ids: allowed,
        },
    )
}
async fn pending<F: Future>(future: Pin<&mut F>) {
    tokio::select! { biased; _ = future => panic!("queued work must remain pending"), _ = std::future::ready(()) => () }
}

#[test]
fn versioned_run_keeps_its_source_and_summary_after_the_caller_changes_input() {
    let queue = Queue::default();
    let mut current = call("source-run");
    current.binding.capability.version = 2;
    let source = json!({"view_id":"document:one","label":"分析.R","kind":"selection"});
    current.arguments = json!({"expected_session":"native-session","run":{"code":"中文 <- 42","output_mode":"console","source":source}});
    queue.admit(&current).unwrap();
    current.arguments["run"]["code"] = json!("changed");
    current.arguments["run"]["source"]["label"] = json!("another.R");
    let pending = queue.observe("native-session", None).console.pending;
    assert_eq!(pending[0].operation_id, id(&current));
    assert_eq!(pending[0].summary, "中文 <- 42");
    assert_eq!(serde_json::to_value(&pending[0].source).unwrap(), source);
}

#[tokio::test]
async fn fifo_waits_for_original_settlement_and_old_ack_cannot_advance_the_next_run() {
    let queue = Queue::default();
    let lane = Arc::new(Lane::new(()));
    let a = call("first");
    let b = call("second");
    let c = call("third");
    for call in [&a, &b, &c] {
        queue.admit(call).unwrap();
    }
    let (_cancel, cancellation) = watch::channel(false);
    let current = queue
        .acquire(&id(&a), lane.clone(), cancellation.clone())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        queue.observe("native-session", None).console.pending.len(),
        2
    );
    queue.finished(&id(&a), PluginOutcome::Succeeded).unwrap();
    drop(current);
    let b_id = id(&b);
    let second = queue.acquire(&b_id, lane.clone(), cancellation.clone());
    tokio::pin!(second);
    pending(second.as_mut()).await;
    let mut wrong = settled(&a, PluginOutcome::Succeeded);
    wrong.binding.target = Some("other-session".into());
    assert!(queue.settle(&wrong).is_err());
    pending(second.as_mut()).await;
    queue
        .settle(&settled(
            &call("unknown-before-dispatch"),
            PluginOutcome::Cancelled,
        ))
        .unwrap();
    pending(second.as_mut()).await;
    queue
        .settle(&settled(&a, PluginOutcome::Succeeded))
        .unwrap();
    let current = second.await.unwrap().unwrap();
    queue
        .settle(&settled(&a, PluginOutcome::Succeeded))
        .unwrap();
    assert_eq!(
        queue
            .observe("native-session", None)
            .console
            .current
            .unwrap()
            .operation_id,
        id(&b)
    );
    let c_id = id(&c);
    let third = queue.acquire(&c_id, lane.clone(), cancellation);
    tokio::pin!(third);
    queue.finished(&id(&b), PluginOutcome::Failed).unwrap();
    drop(current);
    assert!(
        control(&queue, false, None).is_err(),
        "resume cannot manufacture final commit"
    );
    pending(third.as_mut()).await;
    queue.settle(&settled(&b, PluginOutcome::Failed)).unwrap();
    pending(third.as_mut()).await;
    assert!(
        control(&queue, false, Some(vec![id(&c)])).is_err(),
        "failed pause identity must also be in scope"
    );
    control(&queue, false, Some(vec![id(&b), id(&c)])).unwrap();
    let current = third.await.unwrap().unwrap();
    queue.finished(&id(&c), PluginOutcome::Succeeded).unwrap();
    drop(current);
    queue
        .settle(&settled(&c, PluginOutcome::Succeeded))
        .unwrap();
    assert!(queue.is_empty());
}

#[tokio::test]
async fn cancellation_while_paused_or_waiting_for_a_read_lane_has_no_native_start() {
    for paused in [false, true] {
        let queue = Queue::default();
        let lane = Arc::new(Lane::new(()));
        let a = call("cancelled");
        let b = call("waiting");
        queue.admit(&a).unwrap();
        queue.admit(&b).unwrap();
        if paused {
            control(&queue, true, None).unwrap();
        }
        let read = lane.clone().lock_owned().await;
        let (cancel, cancellation) = watch::channel(false);
        let a_id = id(&a);
        let acquiring = queue.acquire(&a_id, lane.clone(), cancellation);
        tokio::pin!(acquiring);
        pending(acquiring.as_mut()).await;
        cancel.send_replace(true);
        assert!(acquiring.await.unwrap().is_none());
        drop(read);
        let state = queue.observe("native-session", None);
        assert!(state.console.current.is_none());
        assert_eq!(state.awaiting_commit, vec![id(&a)]);
        assert_eq!(state.console.pending[0].operation_id, id(&b));
        assert!(control(&queue, false, None).is_err());
        queue.finished(&id(&a), PluginOutcome::Cancelled).unwrap();
        queue
            .settle(&settled(&a, PluginOutcome::Cancelled))
            .unwrap();
        control(&queue, false, Some(vec![id(&a), id(&b)])).unwrap();
        let (_cancel, cancellation) = watch::channel(false);
        let current = queue
            .acquire(&id(&b), lane, cancellation)
            .await
            .unwrap()
            .unwrap();
        queue.finished(&id(&b), PluginOutcome::Succeeded).unwrap();
        drop(current);
        queue
            .settle(&settled(&b, PluginOutcome::Succeeded))
            .unwrap();
    }
}

#[tokio::test]
async fn host_rejection_pauses_a_native_success_and_resume_is_an_exact_scoped_control() {
    let queue = Queue::default();
    let a = call("native-success");
    let b = call("other-work");
    queue.admit(&a).unwrap();
    queue.admit(&b).unwrap();
    let (_cancel, cancellation) = watch::channel(false);
    let current = queue
        .acquire(&id(&a), Arc::new(Lane::new(())), cancellation)
        .await
        .unwrap()
        .unwrap();
    assert!(
        queue
            .settle(&settled(&a, PluginOutcome::Succeeded))
            .is_err(),
        "a running native call has not returned a result"
    );
    queue.finished(&id(&a), PluginOutcome::Succeeded).unwrap();
    drop(current);
    queue
        .settle(&settled(&a, PluginOutcome::Uncertain))
        .unwrap();
    let original = queue.observe("native-session", None).console.pause.unwrap();
    assert_eq!(original.operation_id, Some(id(&a)));
    let mut args = QueueControlArguments {
        session_id: "native-session".into(),
        pause_id: Some("stale-pause".into()),
        only_operation_ids: None,
    };
    assert!(queue.control(false, &args).is_err());
    args.pause_id = Some(original.id.clone());
    args.only_operation_ids = Some(vec![id(&a)]);
    assert!(queue.control(false, &args).is_err());
    args.only_operation_ids = Some(vec![id(&a), id(&b)]);
    queue.control(false, &args).unwrap();
    assert!(
        queue.control(false, &args).is_err(),
        "a consumed pause cannot be replayed"
    );
    control(&queue, true, None).unwrap();
    let current = queue.observe("native-session", None).console.pause.unwrap();
    queue
        .settle(&settled(&a, PluginOutcome::Uncertain))
        .unwrap();
    assert_eq!(
        queue.observe("native-session", None).console.pause.unwrap(),
        current,
        "old settlement cannot replace the new pause"
    );
}

#[tokio::test]
async fn quota_retains_unsettled_items_and_shutdown_wakes_a_paused_queue() {
    let queue = Queue::default();
    for n in 0..MAX_ACCEPTED {
        queue.admit(&call(&format!("run-{n}"))).unwrap();
    }
    assert!(queue.admit(&call("overflow")).is_err());
    assert!(queue.admit(&call("run-0")).is_err());
    control(&queue, true, None).unwrap();
    let a = call("run-0");
    let a_id = id(&a);
    let (_cancel, cancellation) = watch::channel(false);
    let acquiring = queue.acquire(&a_id, Arc::new(Lane::new(())), cancellation);
    tokio::pin!(acquiring);
    pending(acquiring.as_mut()).await;
    queue.begin_shutdown();
    assert!(acquiring.await.unwrap().is_none());
    assert!(!queue.is_empty());
    assert!(!queue.observe("native-session", None).accepting);
    queue
        .settle(&settled(&a, PluginOutcome::Cancelled))
        .unwrap();
    assert!(queue.admit(&call("after-close")).is_err());
    assert!(control(&queue, false, None).is_err());
}
