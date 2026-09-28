//! Exercise the production driver using only its public inputs and owner ports.
use super::*;
use async_trait::async_trait;
use rho_agent_api::*;
use rho_agent_engine::*;
use rho_agent_owner::ComponentModelKey;

#[derive(Clone, Copy)]
enum Behavior {
    Run,
    Reject,
    AdmissionFailure,
    ExecutionFailure,
    Wait,
}
#[derive(Default)]
struct Evidence {
    model_calls: u32,
    prepared: Vec<(u32, String, String, Value)>,
    executed: Vec<String>,
    interrupted: Vec<String>,
    text: String,
    usage: Vec<(Option<u64>, Option<u64>)>,
}
struct Port {
    behavior: Behavior,
    evidence: Mutex<Evidence>,
    entered: Notify,
}
#[derive(Clone)]
struct Ticket {
    model_call: u32,
    call: String,
    name: String,
    arguments: Value,
}
impl Port {
    fn new(behavior: Behavior) -> Arc<Self> {
        Arc::new(Self {
            behavior,
            evidence: Mutex::default(),
            entered: Notify::new(),
        })
    }
}
#[async_trait]
impl AgentModelPort for Port {
    async fn begin_model_call(&self) -> Result<u32, String> {
        let mut e = self.evidence.lock().unwrap();
        e.model_calls += 1;
        Ok(e.model_calls)
    }
    async fn prepare_tool(
        &self,
        model_call: u32,
        call: &str,
        name: &str,
        arguments: Value,
    ) -> Result<AgentToolAdmission, String> {
        if matches!(self.behavior, Behavior::AdmissionFailure) {
            return Err("Owner admission failed".into());
        }
        self.evidence.lock().unwrap().prepared.push((
            model_call,
            call.into(),
            name.into(),
            arguments.clone(),
        ));
        if matches!(self.behavior, Behavior::Reject) {
            return Ok(AgentToolAdmission::Rejected {
                feedback: Some(json!({"status":"rejected","reason":"use the offered arguments"})),
            });
        }
        Ok(AgentToolAdmission::Ready(AgentToolTicket::new(Ticket {
            model_call,
            call: call.into(),
            name: name.into(),
            arguments,
        })))
    }
    async fn execute_tool(&self, ticket: AgentToolTicket) -> Result<Value, String> {
        let t = ticket.get::<Ticket>().ok_or("Foreign ticket")?;
        assert_eq!(t.model_call, 1);
        assert_eq!(t.name, "workspace_observe_object");
        assert_eq!(t.arguments, json!({"name":"fixture"}));
        self.evidence.lock().unwrap().executed.push(t.call.clone());
        self.entered.notify_one();
        if matches!(self.behavior, Behavior::Wait) {
            return std::future::pending().await;
        }
        if matches!(self.behavior, Behavior::ExecutionFailure) {
            return Err("Owner execution acknowledgement failed".into());
        }
        Ok(json!({"observed":"fixture"}))
    }
    async fn append_text(&self, text: String) -> Result<(), String> {
        self.evidence.lock().unwrap().text.push_str(&text);
        Ok(())
    }
    async fn record_usage(&self, input: Option<u64>, output: Option<u64>) -> Result<(), String> {
        self.evidence.lock().unwrap().usage.push((input, output));
        Ok(())
    }
    async fn interrupted_tool(&self, ticket: &AgentToolTicket) -> Result<(), String> {
        let t = ticket.get::<Ticket>().ok_or("Foreign interrupted ticket")?;
        self.evidence
            .lock()
            .unwrap()
            .interrupted
            .push(t.call.clone());
        Ok(())
    }
}
fn input(
    provider: &Provider,
    port: Arc<Port>,
    protocol: ComponentModelProtocol,
) -> AgentModelExecution {
    AgentModelExecution {
        run: AgentModelRun {
            run_id: "captured-run".into(),
            profile: ComponentAgentProfile::Project,
            model: ComponentModelConnection {
                protocol,
                base_url: if protocol == ComponentModelProtocol::Anthropic {
                    provider.url.trim_end_matches("/v1").into()
                } else {
                    provider.url.clone()
                },
                model: "synthetic".into(),
                credential: ComponentCredentialRef::Environment {
                    name: "UNUSED_FIXTURE_KEY".into(),
                },
            },
            budget: ComponentAgentBudget {
                model_calls: 4,
                tool_calls: 4,
                context_bytes: 65536,
                tool_result_bytes: 65536,
                output_tokens: 512,
                duration_ms: 10000,
            },
            created_at_ms: std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_millis() as u64,
            text: "Observe the selected object".into(),
            permission_policy: Some(ComponentPermissionPolicy::Ask),
            task_intent: None,
        },
        context: "bounded owner observation".into(),
        images: vec![],
        tools: vec![ComponentToolSpec {
            name: "workspace_observe_object".into(),
            description: "Read a captured object".into(),
            parameters: schema(),
        }],
        key: ComponentModelKey::new("synthetic-key".into()).unwrap(),
        port,
        cancellation: CancellationToken::new(),
    }
}
#[tokio::test]
async fn production_driver_dispatches_the_original_ticket_and_records_text_and_usage() {
    let provider = Provider::new(Scenario::Tool).await;
    let port = Port::new(Behavior::Run);
    assert_eq!(
        RigAgentEngine::default()
            .execute(input(
                &provider,
                port.clone(),
                ComponentModelProtocol::OpenaiCompletions
            ))
            .await,
        AgentModelOutcome::Completed
    );
    let e = port.evidence.lock().unwrap();
    assert_eq!(e.model_calls, 2);
    assert_eq!(e.prepared.len(), 1);
    assert_eq!(e.executed, [e.prepared[0].1.clone()]);
    assert!(e.interrupted.is_empty());
    assert_eq!(e.text, "Observed fixture.");
    assert_eq!(e.usage.last(), Some(&(Some(22), Some(14))));
    assert_eq!(provider.requests().len(), 2);
    let wire = serde_json::to_string(&provider.requests()).unwrap();
    assert!(!wire.contains("synthetic-key"));
}
#[tokio::test]
async fn production_rejection_returns_owner_feedback_without_dispatch_or_interruption() {
    let provider = Provider::new(Scenario::Tool).await;
    let port = Port::new(Behavior::Reject);
    assert_eq!(
        RigAgentEngine::default()
            .execute(input(
                &provider,
                port.clone(),
                ComponentModelProtocol::OpenaiCompletions
            ))
            .await,
        AgentModelOutcome::Completed
    );
    let e = port.evidence.lock().unwrap();
    assert_eq!(e.prepared.len(), 1);
    assert!(e.executed.is_empty() && e.interrupted.is_empty());
    let calls = provider.requests();
    assert_eq!(calls.len(), 2);
    assert!(calls[1].to_string().contains("use the offered arguments"));
}
#[tokio::test]
async fn production_owner_failures_stop_the_next_model_call_and_retain_only_admitted_intent() {
    for behavior in [Behavior::AdmissionFailure, Behavior::ExecutionFailure] {
        let provider = Provider::new(Scenario::Tool).await;
        let port = Port::new(behavior);
        let outcome = RigAgentEngine::default()
            .execute(input(
                &provider,
                port.clone(),
                ComponentModelProtocol::OpenaiCompletions,
            ))
            .await;
        assert!(
            matches!(outcome,AgentModelOutcome::Failed(message) if message.starts_with("Owner "))
        );
        assert_eq!(provider.requests().len(), 1);
        let e = port.evidence.lock().unwrap();
        if matches!(behavior, Behavior::AdmissionFailure) {
            assert!(e.prepared.is_empty() && e.executed.is_empty() && e.interrupted.is_empty());
        } else {
            assert_eq!(e.prepared.len(), 1);
            assert_eq!(e.interrupted, e.executed);
        }
    }
}
#[tokio::test]
async fn production_cancel_during_tool_wait_returns_the_exact_original_ticket() {
    let provider = Provider::new(Scenario::Tool).await;
    let port = Port::new(Behavior::Wait);
    let request = input(
        &provider,
        port.clone(),
        ComponentModelProtocol::OpenaiCompletions,
    );
    let cancellation = request.cancellation.clone();
    let task = tokio::spawn(async move { RigAgentEngine::default().execute(request).await });
    tokio::time::timeout(Duration::from_secs(3), port.entered.notified())
        .await
        .unwrap();
    cancellation.cancel();
    assert_eq!(
        tokio::time::timeout(Duration::from_secs(2), task)
            .await
            .unwrap()
            .unwrap(),
        AgentModelOutcome::Stopped
    );
    let e = port.evidence.lock().unwrap();
    assert_eq!(e.interrupted, [e.prepared[0].1.clone()]);
    assert_eq!(provider.requests().len(), 1);
}
#[tokio::test]
async fn production_images_keep_owner_labels_and_bytes_for_both_provider_protocols() {
    for protocol in [
        ComponentModelProtocol::OpenaiCompletions,
        ComponentModelProtocol::Anthropic,
    ] {
        let provider = Provider::new(Scenario::Text).await;
        let port = Port::new(Behavior::Run);
        let mut request = input(&provider, port.clone(), protocol);
        request.tools.clear();
        request.images = vec![AgentModelImage {
            label: "Selected image: original-operation / output 7".into(),
            mime_type: "image/png".into(),
            base64: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB".into(),
        }];
        assert_eq!(
            RigAgentEngine::default().execute(request).await,
            AgentModelOutcome::Completed
        );
        let calls = provider.requests();
        assert_eq!(calls.len(), 1);
        let content = calls[0]["messages"]
            .as_array()
            .unwrap()
            .iter()
            .find(|m| m["role"] == "user")
            .unwrap()["content"]
            .as_array()
            .unwrap();
        assert_eq!(
            content[0]["text"],
            "Selected image: original-operation / output 7"
        );
        assert!(
            content[1]
                .to_string()
                .contains("iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB")
        );
        assert!(
            content.last().unwrap()["text"]
                .as_str()
                .unwrap()
                .contains("bounded owner observation")
        );
    }
}
#[tokio::test]
async fn production_preflight_failure_and_precancellation_never_contact_provider() {
    let provider = Provider::new(Scenario::Text).await;
    for kind in [0, 1, 2] {
        let port = Port::new(Behavior::Run);
        let mut request = input(
            &provider,
            port.clone(),
            ComponentModelProtocol::OpenaiCompletions,
        );
        match kind {
            0 => request.cancellation.cancel(),
            1 => request.run.model.base_url = "https://user:secret@invalid.example".into(),
            _ => request.run.budget.context_bytes = 1,
        }
        let outcome = RigAgentEngine::default().execute(request).await;
        assert!(matches!(
            outcome,
            AgentModelOutcome::Stopped | AgentModelOutcome::Failed(_)
        ));
        assert_eq!(port.evidence.lock().unwrap().model_calls, 0);
        assert!(provider.requests().is_empty());
    }
}
