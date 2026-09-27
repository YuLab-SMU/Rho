//! Transient document ownership. Destruction is not a flush acknowledgement.
use crate::{PLUGINS_RUN_SCOPE, PluginService, service::invalid};
use async_trait::async_trait;
use rho_contract as host;
use rho_operation::{CapabilityRegistry, ControlHandler, OperationError};
use rho_plugin_protocol::*;
use schemars::schema_for;
use serde_json::{Value, json};
use std::{collections::BTreeSet, sync::Arc};

pub(crate) fn register(
    service: &Arc<PluginService>,
    registry: &mut CapabilityRegistry,
) -> Result<(), OperationError> {
    registry.register_control_handler(Arc::new(Release {
        service: service.clone(),
        descriptor: host::CapabilityDescriptor {
            kind: host::CapabilityKind::Control,
            capability: host::CapabilityRef::new("views.release_renderer", 1).unwrap(),
            domain: "plugins".into(),
            input_schema: schema_for!(ReleasePluginViewRenderer).to_value(),
            output_schema: schema_for!(PluginViewRendererRelease).to_value(),
            recovery_schema: json!({"type":["object","null"]}),
            required_scopes: BTreeSet::from([PLUGINS_RUN_SCOPE.into()]),
            potential_effects: BTreeSet::new(),
            idempotency: host::IdempotencyClass::Pure,
            retry: host::RetryClass::Safe,
            cancellation: host::CancellationClass::Unsupported,
            documentation: host::CapabilityDocumentation {
                summary: "Release one ended document's close-handler registration".into(),
                purpose: "Allow the containing shell to retire an acknowledged document after destruction or navigation.".into(),
                owner: "plugins".into(),
                when_to_use: vec!["Only after the containing shell destroys this exact renderer; never for heartbeat expiry, hiding or an uncertain disconnect.".into()],
                limitations: vec!["Requires the original private view credential, connection, window, project and principal. Plugin callers cannot use this port. Credentials remain outside Operation records.".into(), "A lost notification retains uncertainty. Deregistration never attests to saved content; a concurrent close is refused and must be retried explicitly.".into()],
                effects: "Remove only one transient registration. Does not change saved state, close a view, cancel work or release a backend.".into(),
                retry_rule: "An identical repeat is harmless while the original connection exists. Never substitute a new renderer or connection.".into(),
                cancellation_rule: "No persistent operation is created. Lost acknowledgement does not prove deregistration.".into(),
                preconditions: vec![],
                examples: vec![host::CapabilityExample {
                    arguments: json!({"view":"view-example","connection":"connection-example","window":"window-example","renderer":"renderer-example","call_token":"private-shell-credential"}),
                    result_explanation: "Whether the exact registration was removed, without a flush or closure receipt.".into(),
                }],
                related_capabilities: vec![host::CapabilityRef::new("views.close", 1).unwrap()],
                related_skills: vec![], position_units: vec![],
            },
        },
    }))
}

struct Release {
    service: Arc<PluginService>,
    descriptor: host::CapabilityDescriptor,
}
#[async_trait]
impl ControlHandler for Release {
    fn descriptor(&self) -> &host::CapabilityDescriptor {
        &self.descriptor
    }
    async fn control(
        &self,
        context: &host::CallContext,
        arguments: Value,
    ) -> Result<Value, OperationError> {
        let args: ReleasePluginViewRenderer = serde_json::from_value(arguments)
            .map_err(|_| invalid("invalid renderer release arguments"))?;
        // Serialize against final native closure. No journal, token rotation,
        // message-sequence allocation or scientific dispatch is involved.
        let _guard = self.service.gate.lock().await;
        if context.caller.kind == host::CallerKind::Plugin {
            return Err(invalid("renderer release belongs to the containing shell"));
        }
        self.service.check_window_context(context, &args.window)?;
        let mut views = self.service.views.lock().unwrap();
        let live = views
            .get_mut(&args.view)
            .filter(|live| {
                live.connection.connection == args.connection
                    && live.connection.call_token == args.call_token
                    && live.connection.view.window == args.window
                    && live.context.principal() == context.principal()
            })
            .ok_or_else(|| OperationError::NotFound("view connection".into()))?;
        let released = live.renderers.remove(&args.renderer);
        if released {
            if let Some(close) = &mut live.closing {
                close.renderer_ended();
            }
            self.service
                .view_sequences
                .send_modify(|version| *version = version.wrapping_add(1));
        }
        serde_json::to_value(PluginViewRendererRelease {
            view: args.view,
            renderer: args.renderer,
            released,
        })
        .map_err(invalid)
    }
}
