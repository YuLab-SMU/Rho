//! Explicit synthetic model tests owned by this ordinary plugin process. No
//! scientific context, tools or Host access is passed to the diagnostic engine.
use crate::{
    arguments::*,
    metadata::{Failure, Metadata, decode, encoded, now},
};
use rho_agent_api::ComponentModelTestState;
use rho_agent_api::component::{ComponentModelDiagnostic, ComponentModelTestRequest};
use rho_agent_engine::RigAgentEngine;
use rho_agent_owner::component::ComponentTaskError;
use rho_plugin_sdk::protocol::{PluginCall, PluginViewCaller};
use serde_json::Value;
use std::sync::Mutex;
use tokio_util::sync::CancellationToken;

#[derive(Default)]
pub struct Diagnostics {
    engine: RigAgentEngine,
    live: Mutex<Option<(String, CancellationToken)>>,
}
struct Live<'a> {
    diagnostics: &'a Diagnostics,
    request: String,
    cancellation: CancellationToken,
}
impl Drop for Live<'_> {
    fn drop(&mut self) {
        // Abort/disconnect leaves the stored original observation unfinished.
        // Reading it after this guard retires reports interruption, never replay.
        self.cancellation.cancel();
        if let Ok(mut live) = self.diagnostics.live.lock()
            && live.as_ref().is_some_and(|(id, _)| id == &self.request)
        {
            *live = None;
        }
    }
}
fn unavailable() -> Failure {
    Failure {
        code: "unavailable",
        message: "Model test state is unavailable".into(),
    }
}
fn active(state: ComponentModelTestState) -> bool {
    matches!(
        state,
        ComponentModelTestState::Queued | ComponentModelTestState::Running
    )
}
impl Diagnostics {
    pub fn observe(
        &self,
        mut diagnostic: ComponentModelDiagnostic,
    ) -> Result<ComponentModelDiagnostic, Failure> {
        let live = self.live.lock().map_err(|_| unavailable())?;
        if active(diagnostic.state)
            && live
                .as_ref()
                .is_none_or(|(id, _)| id != &diagnostic.request_id)
        {
            diagnostic.state = ComponentModelTestState::Interrupted;
            diagnostic.detail = Some(
                "The original model test is no longer owned by this process; it was not restarted"
                    .into(),
            );
        }
        Ok(diagnostic)
    }
    pub fn cancel_all(&self) {
        if let Ok(live) = self.live.lock()
            && let Some((_, cancellation)) = &*live
        {
            cancellation.cancel();
        }
    }
    pub fn read(&self, metadata: &Metadata, arguments: &Value) -> Result<Value, Failure> {
        let request: ModelDiagnostic = decode(arguments)?;
        if request.request_id.is_empty() || request.request_id.len() > 160 {
            return Err(Failure::invalid(
                "Invalid model diagnostic request identity",
            ));
        }
        let diagnostic = metadata
            .owner
            .store
            .component_diagnostic(&metadata.scope, &request.request_id)?
            .ok_or(ComponentTaskError::NotFound)?;
        encoded(self.observe(diagnostic)?)
    }
    pub fn stop(
        &self,
        metadata: &Metadata,
        call: &PluginCall,
        origin: PluginViewCaller,
    ) -> Result<Value, Failure> {
        let args: StopModelDiagnostic = decode(&call.arguments)?;
        let admitted_at = now();
        let actor = metadata.actor(origin, admitted_at);
        let diagnostic = metadata
            .owner
            .store
            .component_diagnostic(&metadata.scope, &args.request_id)?
            .ok_or(ComponentTaskError::NotFound)?;
        if diagnostic.version != args.expected_version {
            return Err(ComponentTaskError::Conflict.into());
        }
        // Consume the fresh native actor through the same owner admission. An
        // existing original test is observed, never recreated or started here.
        let (diagnostic, repeated) = metadata.owner.begin_model_test(
            &actor,
            &ComponentModelTestRequest {
                project_root: metadata.scope.project.clone(),
                window: diagnostic.window.clone(),
                request_id: diagnostic.request_id.clone(),
                model_settings_version: diagnostic.model_settings_version,
                kind: diagnostic.kind,
            },
            admitted_at,
        )?;
        if !repeated {
            return Err(ComponentTaskError::Conflict.into());
        }
        {
            let live = self.live.lock().map_err(|_| unavailable())?;
            if let Some((id, cancellation)) = &*live
                && id == &args.request_id
            {
                cancellation.cancel();
            }
        }
        // A stop request is not a completed network result. The original Invoke
        // remains active until its future settles and writes the final state.
        encoded(self.observe(diagnostic)?)
    }
    pub async fn start(
        &self,
        metadata: &Metadata,
        call: &PluginCall,
        origin: PluginViewCaller,
    ) -> Result<Value, Failure> {
        let args: TestModel = decode(&call.arguments)?;
        let admitted_at = now();
        let actor = metadata.actor(origin, admitted_at);
        let request = ComponentModelTestRequest {
            project_root: metadata.scope.project.clone(),
            window: actor.window().clone(),
            request_id: args.request_id.clone(),
            model_settings_version: args.model_settings_version,
            kind: args.kind,
        };
        let (diagnostic, key, guard) = {
            let mut live = self.live.lock().map_err(|_| unavailable())?;
            if metadata
                .owner
                .store
                .component_diagnostic(&metadata.scope, &args.request_id)?
                .is_some()
            {
                let (diagnostic, _) =
                    metadata
                        .owner
                        .begin_model_test(&actor, &request, admitted_at)?;
                drop(live);
                return encoded(self.observe(diagnostic)?);
            }
            if live.is_some() {
                return Err(Failure { code: "busy", message: "An original model test is still running; inspect or stop it before starting another".into() });
            }
            let settings = metadata.owner.store.component_settings(&metadata.scope)?;
            if settings.version != args.model_settings_version {
                return Err(ComponentTaskError::Conflict.into());
            }
            let connection = settings
                .connection
                .as_ref()
                .ok_or_else(|| Failure::invalid("Configure a model before testing"))?;
            let key = metadata.model_key(&connection.credential)?;
            let (diagnostic, repeated) =
                metadata
                    .owner
                    .begin_model_test(&actor, &request, admitted_at)?;
            if repeated {
                return Err(ComponentTaskError::Conflict.into());
            }
            let cancellation = CancellationToken::new();
            *live = Some((args.request_id.clone(), cancellation.clone()));
            let guard = Live {
                diagnostics: self,
                request: args.request_id,
                cancellation,
            };
            (diagnostic, key, guard)
        };
        metadata.owner.update_model_test(
            &metadata.scope,
            &diagnostic.request_id,
            ComponentModelTestState::Running,
            None,
            now(),
        )?;
        let result = self
            .engine
            .test_model(
                diagnostic.model,
                key,
                diagnostic.kind,
                guard.cancellation.clone(),
            )
            .await;
        let (state, detail) = if guard.cancellation.is_cancelled() {
            (
                ComponentModelTestState::Interrupted,
                Some("Model test stopped".into()),
            )
        } else {
            match result {
                Ok(()) => (ComponentModelTestState::Passed, None),
                // Engine errors are authored, bounded diagnostics; raw provider
                // responses and credentials are never stored here.
                Err(detail) => (ComponentModelTestState::Failed, Some(detail)),
            }
        };
        let result = metadata.owner.update_model_test(
            &metadata.scope,
            &diagnostic.request_id,
            state,
            detail,
            now(),
        )?;
        drop(guard);
        encoded(result)
    }
}
