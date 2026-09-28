//! Converts admitted core records once; there is no second model or tool lifecycle.
use async_trait::async_trait;
use rho_agent_engine::*;
use rho_application::*;
use rho_contract::*;
use serde_json::Value;
use std::sync::Arc;
use tokio_util::sync::CancellationToken;

#[derive(Default)]
pub struct RigComponentEngine(RigAgentEngine);
struct PortAdapter {
    port: Arc<dyn ComponentRunPort>,
    origin: Arc<()>,
}
struct AdapterTicket {
    origin: Arc<()>,
    admission: ComponentToolAdmission,
}
impl PortAdapter {
    fn ticket<'a>(
        &self,
        ticket: &'a AgentToolTicket,
    ) -> Result<&'a ComponentToolAdmission, ApplicationError> {
        ticket
            .get::<AdapterTicket>()
            .filter(|t| Arc::ptr_eq(&self.origin, &t.origin))
            .map(|t| &t.admission)
            .ok_or_else(|| {
                ApplicationError::InvalidInput(
                    "Tool ticket does not belong to this model run".into(),
                )
            })
    }
    async fn diagnosed<T>(&self, result: Result<T, ApplicationError>) -> Result<T, String> {
        match result {
            Ok(value) => Ok(value),
            Err(error) => {
                let _ = self.port.record_diagnostic(error.diagnostic()).await;
                Err(error.to_string())
            }
        }
    }
}
#[async_trait]
impl AgentModelPort for PortAdapter {
    async fn begin_model_call(&self) -> Result<u32, String> {
        self.diagnosed(self.port.begin_model_call().await).await
    }
    async fn prepare_tool(
        &self,
        model_call: u32,
        call_id: &str,
        name: &str,
        arguments: Value,
    ) -> Result<AgentToolAdmission, String> {
        let admission = self
            .diagnosed(
                self.port
                    .prepare_tool(model_call, call_id, name, arguments)
                    .await,
            )
            .await?;
        if matches!(admission.tool.action, ComponentToolAction::Rejected { .. }) {
            return Ok(AgentToolAdmission::Rejected {
                feedback: admission.tool.receipt.result,
            });
        }
        Ok(AgentToolAdmission::Ready(AgentToolTicket::new(
            AdapterTicket {
                origin: self.origin.clone(),
                admission,
            },
        )))
    }
    async fn execute_tool(&self, ticket: AgentToolTicket) -> Result<Value, String> {
        let admission = self.diagnosed(self.ticket(&ticket)).await?;
        self.diagnosed(
            self.port
                .execute_tool(ComponentToolAdmission {
                    tool: admission.tool.clone(),
                    repeated: admission.repeated,
                })
                .await,
        )
        .await
    }
    async fn append_text(&self, text: String) -> Result<(), String> {
        self.port.append_text(text).await.map_err(|e| e.to_string())
    }
    async fn record_usage(
        &self,
        input_tokens: Option<u64>,
        output_tokens: Option<u64>,
    ) -> Result<(), String> {
        self.port
            .record_usage(input_tokens, output_tokens)
            .await
            .map_err(|e| e.to_string())
    }
    async fn interrupted_tool(&self, ticket: &AgentToolTicket) -> Result<(), String> {
        let admission = self.ticket(ticket).map_err(|e| e.to_string())?;
        self.port
            .interrupted_tool(&admission.tool)
            .await
            .map_err(|e| e.to_string())
    }
}
#[async_trait]
impl ComponentAgentEngine for RigComponentEngine {
    async fn test_model(
        &self,
        model: ComponentModelConnection,
        key: ComponentModelKey,
        kind: ComponentModelTestKind,
        cancellation: CancellationToken,
    ) -> Result<(), String> {
        self.0.test_model(model, key, kind, cancellation).await
    }
    async fn execute(&self, request: ComponentEngineExecution) -> ComponentEngineOutcome {
        let run = request.run;
        let input = AgentModelRun {
            run_id: run.run_id,
            profile: run.profile,
            model: run.model,
            budget: run.budget,
            created_at_ms: run.created_at_ms,
            text: run.request.text,
            permission_policy: run.request.grant.permission_policy,
            task_intent: run.task_intent,
        };
        let images = request
            .images
            .into_iter()
            .map(|image| {
                let label = match image.reference {
                    ComponentImageSource::Scientific(reference) => format!(
                        "Selected image: {} / output {}",
                        reference.operation_id.as_str(),
                        reference.sequence
                    ),
                    ComponentImageSource::Attachment {
                        conversation_id,
                        asset,
                    } => format!(
                        "User-uploaded image: {} (rho://attachments/component/{}/{}, sha256:{})",
                        asset.name, conversation_id, asset.asset_id, asset.sha256
                    ),
                };
                AgentModelImage {
                    label,
                    mime_type: image.mime_type,
                    base64: image.base64,
                }
            })
            .collect();
        let outcome = self
            .0
            .execute(AgentModelExecution {
                run: input,
                context: request.context,
                images,
                tools: request.tools,
                key: request.key,
                port: Arc::new(PortAdapter {
                    port: request.port,
                    origin: Arc::new(()),
                }),
                cancellation: request.cancellation,
            })
            .await;
        match outcome {
            AgentModelOutcome::Completed => ComponentEngineOutcome::Completed,
            AgentModelOutcome::Stopped => ComponentEngineOutcome::Stopped,
            AgentModelOutcome::Failed(error) => ComponentEngineOutcome::Failed(error),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;
    struct Port {
        calls: Mutex<Vec<String>>,
        fail: bool,
    }
    fn admission() -> ComponentToolAdmission {
        ComponentToolAdmission {
            repeated: true,
            tool: StoredComponentTool {
                receipt: ComponentToolReceipt {
                    receipt_id: "original-receipt".into(),
                    run_id: "run".into(),
                    model_call: 1,
                    tool_call_id: "native-call".into(),
                    capability: "fixture.read".into(),
                    arguments_digest: "arguments".into(),
                    action_digest: "action".into(),
                    client_request_id: "original-request".into(),
                    mutation: false,
                    phase: ComponentToolPhase::Intent,
                    operation_id: None,
                    application_request_id: None,
                    result: None,
                    evidence: vec![],
                    updated_at_ms: 1,
                },
                action: ComponentToolAction::Query(QueryRequest {
                    capability: CapabilityRef::new("fixture.read", 1).unwrap(),
                    arguments: serde_json::json!({"captured":"value"}),
                }),
                calls: vec![],
            },
        }
    }
    #[async_trait]
    impl ComponentRunPort for Port {
        async fn begin_model_call(&self) -> Result<u32, ApplicationError> {
            self.calls.lock().unwrap().push("begin".into());
            if self.fail {
                Err(ApplicationError::Budget("owner-budget".into()))
            } else {
                Ok(1)
            }
        }
        async fn prepare_tool(
            &self,
            _: u32,
            _: &str,
            _: &str,
            _: Value,
        ) -> Result<ComponentToolAdmission, ApplicationError> {
            Ok(admission())
        }
        async fn execute_tool(
            &self,
            value: ComponentToolAdmission,
        ) -> Result<Value, ApplicationError> {
            assert!(value.repeated);
            assert_eq!(value.tool.receipt.client_request_id, "original-request");
            assert_eq!(
                serde_json::to_value(value.tool.action).unwrap(),
                serde_json::to_value(admission().tool.action).unwrap()
            );
            self.calls.lock().unwrap().push("execute".into());
            Ok(serde_json::json!({"original":true}))
        }
        async fn append_text(&self, _: String) -> Result<(), ApplicationError> {
            Ok(())
        }
        async fn record_diagnostic(&self, _: Diagnostic) -> Result<(), ApplicationError> {
            self.calls.lock().unwrap().push("diagnostic".into());
            Ok(())
        }
        async fn record_usage(
            &self,
            _: Option<u64>,
            _: Option<u64>,
        ) -> Result<(), ApplicationError> {
            Ok(())
        }
        async fn interrupted_tool(
            &self,
            tool: &StoredComponentTool,
        ) -> Result<(), ApplicationError> {
            assert_eq!(tool.receipt.receipt_id, "original-receipt");
            self.calls.lock().unwrap().push("interrupted".into());
            Ok(())
        }
    }
    fn adapter(port: Arc<Port>) -> PortAdapter {
        PortAdapter {
            port,
            origin: Arc::new(()),
        }
    }
    #[tokio::test]
    async fn opaque_admission_retains_original_request_and_rejects_another_run_or_fabricated_ticket()
     {
        let port = Arc::new(Port {
            calls: Mutex::default(),
            fail: false,
        });
        let first = adapter(port.clone());
        let second = adapter(port.clone());
        let AgentToolAdmission::Ready(ticket) = first
            .prepare_tool(1, "call", "tool", Value::Null)
            .await
            .unwrap()
        else {
            panic!()
        };
        assert!(second.execute_tool(ticket.clone()).await.is_err());
        assert!(second.interrupted_tool(&ticket).await.is_err());
        assert!(
            first
                .execute_tool(AgentToolTicket::new("fabricated"))
                .await
                .is_err()
        );
        assert!(port.calls.lock().unwrap().iter().all(|c| c == "diagnostic"));
        assert_eq!(
            first.execute_tool(ticket.clone()).await.unwrap(),
            serde_json::json!({"original":true})
        );
        first.interrupted_tool(&ticket).await.unwrap();
        assert_eq!(
            *port.calls.lock().unwrap(),
            ["diagnostic", "diagnostic", "execute", "interrupted"]
        );
    }
    #[tokio::test]
    async fn owner_error_records_its_diagnostic_before_returning_to_the_public_engine() {
        let port = Arc::new(Port {
            calls: Mutex::default(),
            fail: true,
        });
        let adapter = adapter(port.clone());
        assert!(
            adapter
                .begin_model_call()
                .await
                .unwrap_err()
                .contains("owner-budget")
        );
        assert_eq!(*port.calls.lock().unwrap(), ["begin", "diagnostic"]);
    }
}
