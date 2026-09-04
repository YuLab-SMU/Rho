//! Asynchronous durable repository for Agent turn state.
//!
//! The repository owns no connection or authority of its own. It is a narrow
//! cloneable facade over [`StoreExecutor`](crate::StoreExecutor), and every
//! operation reuses the synchronous [`Store`](crate::Store) implementation on
//! that executor's one SQLite worker.

use rho_protocol::Envelope;

use crate::{
    AgentConversationDraft, AgentConversationSummary, AgentConversationTurn, AgentTurnDetail,
    AgentTurnDraft, AgentTurnEventDraft, AgentTurnFinish, AgentTurnSummary, RuntimeOutputPage,
    Store, StoreExecutor, StoreExecutorError, query::required_project_root,
};

#[derive(Clone, Debug)]
pub struct AgentRepository {
    executor: StoreExecutor,
}

impl StoreExecutor {
    pub fn agent_repository(&self) -> AgentRepository {
        AgentRepository {
            executor: self.clone(),
        }
    }
}

impl AgentRepository {
    /// Clone the shared executor for an adjacent durable service that must
    /// participate in the same application connection lane.
    pub fn store_executor(&self) -> StoreExecutor {
        self.executor.clone()
    }

    pub async fn create_conversation(
        &self,
        mut draft: AgentConversationDraft,
    ) -> Result<AgentConversationSummary, StoreExecutorError> {
        draft.project_root = required_project_root(&draft.project_root)?;
        self.executor
            .call(move |connection| Store::borrowed(connection).create_agent_conversation(&draft))
            .await
    }

    pub async fn list_conversations(
        &self,
        project_root: String,
        limit: Option<usize>,
    ) -> Result<Vec<AgentConversationSummary>, StoreExecutorError> {
        let project_root = required_project_root(&project_root)?;
        self.executor
            .call(move |connection| {
                Store::borrowed(connection).list_agent_conversations(&project_root, limit)
            })
            .await
    }

    pub async fn get_conversation(
        &self,
        project_root: String,
        conversation_id: String,
    ) -> Result<Option<AgentConversationSummary>, StoreExecutorError> {
        let project_root = required_project_root(&project_root)?;
        self.executor
            .call(move |connection| {
                Store::borrowed(connection).get_agent_conversation(&project_root, &conversation_id)
            })
            .await
    }

    pub async fn list_turns(
        &self,
        project_root: String,
        conversation_id: Option<String>,
        limit: Option<usize>,
    ) -> Result<Vec<AgentTurnSummary>, StoreExecutorError> {
        let project_root = required_project_root(&project_root)?;
        self.executor
            .call(move |connection| {
                let store = Store::borrowed(connection);
                match conversation_id.as_deref() {
                    Some(conversation_id) => store.list_agent_turns_for_conversation(
                        &project_root,
                        conversation_id,
                        limit,
                    ),
                    None => store.list_agent_turns(&project_root, limit),
                }
            })
            .await
    }

    pub async fn conversation_turn_ids(
        &self,
        project_root: String,
        conversation_id: String,
    ) -> Result<Vec<String>, StoreExecutorError> {
        let project_root = required_project_root(&project_root)?;
        self.executor
            .call(move |connection| {
                Store::borrowed(connection)
                    .agent_conversation_turn_ids(&project_root, &conversation_id)
            })
            .await
    }

    pub async fn delete_conversation(
        &self,
        project_root: String,
        conversation_id: String,
    ) -> Result<usize, StoreExecutorError> {
        let project_root = required_project_root(&project_root)?;
        self.executor
            .call(move |connection| {
                Store::borrowed(connection)
                    .delete_agent_conversation(&project_root, &conversation_id)
            })
            .await
    }

    pub async fn create_turn_with_conversation(
        &self,
        mut conversation: AgentConversationDraft,
        mut turn: AgentTurnDraft,
    ) -> Result<(), StoreExecutorError> {
        conversation.project_root = required_project_root(&conversation.project_root)?;
        turn.project_root = required_project_root(&turn.project_root)?;
        self.executor
            .call(move |connection| {
                Store::borrowed(connection)
                    .create_agent_turn_with_conversation(&conversation, &turn)
            })
            .await
    }

    pub async fn create_turn_in_conversation(
        &self,
        conversation_id: String,
        retry_of_turn_id: Option<String>,
        mut turn: AgentTurnDraft,
    ) -> Result<(), StoreExecutorError> {
        turn.project_root = required_project_root(&turn.project_root)?;
        self.executor
            .call(move |connection| {
                Store::borrowed(connection).create_agent_turn_in_conversation(
                    &conversation_id,
                    retry_of_turn_id.as_deref(),
                    &turn,
                )
            })
            .await
    }

    pub async fn recent_conversation(
        &self,
        project_root: String,
        conversation_id: String,
        excluded_turn_id: String,
        limit: usize,
    ) -> Result<Vec<AgentConversationTurn>, StoreExecutorError> {
        let project_root = required_project_root(&project_root)?;
        self.executor
            .call(move |connection| {
                Store::borrowed(connection).recent_agent_conversation(
                    &project_root,
                    &conversation_id,
                    &excluded_turn_id,
                    limit,
                )
            })
            .await
    }

    pub async fn append_protocol_event(&self, event: Envelope) -> Result<i64, StoreExecutorError> {
        self.executor
            .call(move |connection| Store::borrowed(connection).append_event(&event))
            .await
    }

    pub async fn append_turn_event(
        &self,
        event: AgentTurnEventDraft,
    ) -> Result<i64, StoreExecutorError> {
        let event_id = self
            .executor
            .call(move |connection| Store::borrowed(connection).append_agent_turn_event(&event))
            .await?;

        // The insert above is authoritative. Publishing is deliberately
        // best-effort so it cannot turn a successful append into a failure.
        self.executor.publish_agent_turn_event(event_id).await;
        Ok(event_id)
    }

    pub async fn get_turn_detail(
        &self,
        project_root: String,
        turn_id: String,
    ) -> Result<Option<AgentTurnDetail>, StoreExecutorError> {
        let project_root = required_project_root(&project_root)?;
        self.executor
            .call(move |connection| {
                Store::borrowed(connection).get_agent_turn_detail(&project_root, &turn_id)
            })
            .await
    }

    pub async fn get_conversation_turn(
        &self,
        project_root: String,
        conversation_id: String,
        requested_turn_id: String,
    ) -> Result<Option<AgentConversationTurn>, StoreExecutorError> {
        let project_root = required_project_root(&project_root)?;
        self.executor
            .call(move |connection| {
                Store::borrowed(connection).get_agent_conversation_turn(
                    &project_root,
                    &conversation_id,
                    &requested_turn_id,
                )
            })
            .await
    }

    pub async fn runtime_output_page(
        &self,
        project_root: String,
        execution_id: String,
        after_sequence: i64,
        page_size: usize,
        byte_budget: usize,
    ) -> Result<RuntimeOutputPage, StoreExecutorError> {
        let project_root = required_project_root(&project_root)?;
        self.executor
            .call(move |connection| {
                Store::borrowed(connection).runtime_output_page(
                    &project_root,
                    &execution_id,
                    after_sequence,
                    page_size,
                    byte_budget,
                )
            })
            .await
    }

    pub async fn update_turn_status(
        &self,
        turn_id: String,
        status: String,
    ) -> Result<usize, StoreExecutorError> {
        self.executor
            .call(move |connection| {
                Store::borrowed(connection).update_agent_turn_status(&turn_id, &status)
            })
            .await
    }

    pub async fn finish_turn(&self, finish: AgentTurnFinish) -> Result<(), StoreExecutorError> {
        let projection_finish = finish.clone();
        let projection_turn_id = finish.turn_id.clone();
        self.executor
            .call(move |connection| Store::borrowed(connection).finish_agent_turn(&finish))
            .await?;

        // As with append, finishing is already committed at this point. A
        // failed projection query is recoverable by the existing invalidation
        // path and must not be surfaced as a failed finish.
        let project_root = self
            .executor
            .call(move |connection| {
                Store::borrowed(connection).agent_turn_project_root(&projection_turn_id)
            })
            .await;
        if let Ok(Some(project_root)) = project_root {
            let _ =
                self.executor
                    .agent_turn_events()
                    .send(crate::AgentTurnEventFrame::from_finish(
                        project_root,
                        &projection_finish,
                    ));
        }
        Ok(())
    }

    pub async fn clear_history(&self, project_root: String) -> Result<usize, StoreExecutorError> {
        let project_root = required_project_root(&project_root)?;
        self.executor
            .call(move |connection| Store::borrowed(connection).clear_agent_history(&project_root))
            .await
    }
}

#[cfg(test)]
mod tests {
    use tempfile::TempDir;

    use super::*;
    use crate::StoreError;

    fn conversation(project_root: &str) -> AgentConversationDraft {
        AgentConversationDraft {
            conversation_id: "conversation-a".to_string(),
            project_root: project_root.to_string(),
            title: "Async Agent".to_string(),
            legacy_unthreaded: false,
        }
    }

    fn turn(project_root: &str) -> AgentTurnDraft {
        AgentTurnDraft {
            turn_id: "turn-a".to_string(),
            project_root: project_root.to_string(),
            prompt: "Inspect the project".to_string(),
            model: "test-model".to_string(),
            workspace_id: "workspace-a".to_string(),
            state_revision_before: 2,
            project_revision_before: 3,
        }
    }

    fn event(turn_id: &str, title: &str) -> AgentTurnEventDraft {
        AgentTurnEventDraft {
            turn_id: turn_id.to_string(),
            event_type: "agent.test".to_string(),
            title: title.to_string(),
            body: None,
            status: "completed".to_string(),
            tool: None,
            request_id: None,
            code: None,
            details_json: "{}".to_string(),
        }
    }

    #[tokio::test]
    async fn agent_repository_persists_reopens_and_isolates_projects() {
        let directory = TempDir::new().unwrap();
        let database = directory.path().join("rho.sqlite");
        let executor = StoreExecutor::open(&database).await.unwrap();
        let repository = executor.agent_repository();
        repository
            .create_turn_with_conversation(conversation("D:/projects/A"), turn("D:/projects/A"))
            .await
            .unwrap();
        repository
            .append_turn_event(event("turn-a", "Persisted"))
            .await
            .unwrap();
        repository
            .finish_turn(AgentTurnFinish {
                turn_id: "turn-a".to_string(),
                status: "completed".to_string(),
                terminal_reason: None,
                workspace_id_after: Some("workspace-a".to_string()),
                state_revision_after: Some(2),
                project_revision_after: Some(3),
                final_message: Some("Done".to_string()),
                error_message: None,
            })
            .await
            .unwrap();
        assert!(
            repository
                .get_turn_detail("D:/projects/B".to_string(), "turn-a".to_string())
                .await
                .unwrap()
                .is_none()
        );
        drop(repository);
        drop(executor);

        let reopened = StoreExecutor::open(&database)
            .await
            .unwrap()
            .agent_repository();
        let detail = reopened
            .get_turn_detail("D:/projects/A".to_string(), "turn-a".to_string())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(detail.turn.status, "completed");
        assert_eq!(detail.turn.final_message.as_deref(), Some("Done"));
        assert_eq!(detail.events.len(), 1);
        assert_eq!(
            reopened
                .list_conversations("D:/projects/A".to_string(), None)
                .await
                .unwrap()
                .len(),
            1
        );
        assert_eq!(
            reopened
                .get_conversation("D:/projects/A".to_string(), "conversation-a".to_string(),)
                .await
                .unwrap()
                .unwrap()
                .turn_count,
            1
        );
        assert_eq!(
            reopened
                .list_turns("D:/projects/A".to_string(), None, None)
                .await
                .unwrap()
                .len(),
            1
        );
        assert_eq!(
            reopened
                .conversation_turn_ids("D:/projects/A".to_string(), "conversation-a".to_string(),)
                .await
                .unwrap(),
            vec!["turn-a"]
        );
        assert_eq!(
            reopened
                .delete_conversation("D:/projects/A".to_string(), "conversation-a".to_string(),)
                .await
                .unwrap(),
            1
        );
        assert!(
            reopened
                .list_conversations("D:/projects/A".to_string(), None)
                .await
                .unwrap()
                .is_empty()
        );
    }

    #[tokio::test]
    async fn agent_repository_recovers_after_rejected_write() {
        let directory = TempDir::new().unwrap();
        let repository = StoreExecutor::open(directory.path().join("rho.sqlite"))
            .await
            .unwrap()
            .agent_repository();
        let error = repository
            .append_turn_event(event("missing-turn", "Rejected"))
            .await
            .unwrap_err();
        assert!(matches!(
            error,
            StoreExecutorError::Store(StoreError::Sqlite(_))
        ));

        repository
            .create_turn_with_conversation(conversation("D:/projects/A"), turn("D:/projects/A"))
            .await
            .unwrap();
        repository
            .append_turn_event(event("turn-a", "Recovered"))
            .await
            .unwrap();
        assert_eq!(
            repository
                .get_turn_detail("D:/projects/A".to_string(), "turn-a".to_string())
                .await
                .unwrap()
                .unwrap()
                .events
                .len(),
            1
        );
    }

    #[tokio::test]
    async fn agent_turn_frames_follow_durable_writes_and_carry_normalized_project_root() {
        let directory = TempDir::new().unwrap();
        let database = directory.path().join("rho.sqlite");
        let executor = StoreExecutor::open(&database).await.unwrap();
        let repository = executor.agent_repository();
        let mut frames = executor.agent_turn_events().subscribe();

        repository
            .create_turn_with_conversation(
                conversation("D:\\projects\\A\\"),
                turn("D:\\projects\\A\\"),
            )
            .await
            .unwrap();
        repository
            .append_turn_event(event("turn-a", "First activity"))
            .await
            .unwrap();

        let append_frame = frames.try_recv().unwrap();
        assert_eq!(append_frame.project_root, "D:/projects/A");
        assert_eq!(append_frame.turn_id, "turn-a");
        let persisted_after_append = repository
            .get_turn_detail("D:/projects/A".to_string(), "turn-a".to_string())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(persisted_after_append.events.len(), 1);
        assert_eq!(
            append_frame.event.unwrap().id,
            persisted_after_append.events[0].id
        );

        repository
            .finish_turn(AgentTurnFinish {
                turn_id: "turn-a".to_string(),
                status: "completed".to_string(),
                terminal_reason: Some("completed".to_string()),
                workspace_id_after: Some("workspace-a".to_string()),
                state_revision_after: Some(2),
                project_revision_after: Some(3),
                final_message: Some("All done".to_string()),
                error_message: None,
            })
            .await
            .unwrap();

        let finish_frame = frames.try_recv().unwrap();
        assert_eq!(finish_frame.project_root, "D:/projects/A");
        assert_eq!(finish_frame.turn_id, "turn-a");
        let update = finish_frame.turn_update.unwrap();
        assert_eq!(update.status, "completed");
        assert_eq!(update.final_message.as_deref(), Some("All done"));
        assert_eq!(update.terminal_reason.as_deref(), Some("completed"));
        let persisted_after_finish = repository
            .get_turn_detail("D:/projects/A".to_string(), "turn-a".to_string())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(persisted_after_finish.turn.status, "completed");
    }

    #[tokio::test]
    async fn agent_turn_frame_is_bounded_while_store_keeps_full_details() {
        let directory = TempDir::new().unwrap();
        let database = directory.path().join("rho.sqlite");
        let executor = StoreExecutor::open(&database).await.unwrap();
        let repository = executor.agent_repository();
        let mut frames = executor.agent_turn_events().subscribe();

        repository
            .create_turn_with_conversation(conversation("D:/projects/A"), turn("D:/projects/A"))
            .await
            .unwrap();
        let full_details = format!("{{\"payload\":\"{}\"}}", "x".repeat(100_000));
        let mut large = event("turn-a", "Large payload");
        large.event_type = "e".repeat(8_000);
        large.title = "t".repeat(8_000);
        large.body = Some("b".repeat(8_000));
        large.status = "s".repeat(8_000);
        large.tool = Some("tool".repeat(2_000));
        large.request_id = Some("request".repeat(2_000));
        large.code = Some("c".repeat(8_000));
        large.details_json = full_details.clone();
        repository.append_turn_event(large).await.unwrap();

        let frame = frames.try_recv().unwrap();
        assert!(frame.payload_truncated);
        assert!(
            frame.event.is_none(),
            "over-budget payload keeps identity only"
        );
        assert_eq!(frame.project_root, "D:/projects/A");
        assert_eq!(frame.turn_id, "turn-a");
        assert!(
            serde_json::to_vec(&frame).unwrap().len() <= crate::agent::AGENT_TURN_FRAME_MAX_BYTES
        );
        let persisted = repository
            .get_turn_detail("D:/projects/A".to_string(), "turn-a".to_string())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(persisted.events[0].details_json, full_details);
        assert_eq!(
            persisted.events[0].body.as_deref().map(str::len),
            Some(8_000)
        );
        assert_eq!(
            persisted.events[0].code.as_deref().map(str::len),
            Some(8_000)
        );
    }
}
