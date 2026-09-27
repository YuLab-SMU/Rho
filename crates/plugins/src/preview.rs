//! Fixture preview uses ordinary immutable instances and views, without a native
//! process or any forwarding into the Host capability registry.
use crate::{PluginService, service::*};
use rho_contract as host;
use rho_operation::{Clock, OperationError, SystemClock};
use rho_plugin_protocol::*;
use serde_json::{Value, json};

impl PluginService {
    pub(crate) fn prepare_preview(&self, args: &PreviewPlugin) -> Result<String, OperationError> {
        if args.queries.len() > 128
            || serde_json::to_vec(args).map_err(invalid)?.len() > MAX_CONTROL_BYTES / 4
        {
            return Err(invalid("fixture preview exceeds 128 queries or 256 KiB"));
        }
        let repo = self.repository.lock().unwrap();
        let revision = repo.revision(&args.revision).map_err(error)?;
        let artifact = repo.artifact(&args.artifact).map_err(error)?;
        if artifact.revision != args.revision || revision.manifest.views.is_empty() {
            return Err(invalid(
                "preview requires an exact built artifact with view contributions",
            ));
        }
        crate::runtime::validate_value(
            &revision.manifest.configuration_schema,
            &args.configuration,
            "configuration",
        )
        .map_err(error)?;
        for (index, fixture) in args.queries.iter().enumerate() {
            if !revision
                .manifest
                .requires
                .iter()
                .chain(&revision.manifest.optional_requires)
                .any(|grant| grant.capability == fixture.capability)
            {
                return Err(invalid("fixture query must name a declared requirement"));
            }
            if args.queries[..index].iter().any(|previous| {
                previous.capability == fixture.capability && previous.arguments == fixture.arguments
            }) {
                return Err(invalid(
                    "fixture queries must have unique capability and argument pairs",
                ));
            }
            if let Some(own) = revision
                .manifest
                .capabilities
                .iter()
                .find(|cap| cap.capability == fixture.capability)
            {
                if own.kind != CapabilityKind::Query {
                    return Err(invalid(
                        "fixture must not impersonate a non-query contribution",
                    ));
                }
                crate::runtime::validate_value(
                    &own.input_schema,
                    &fixture.arguments,
                    "fixture arguments",
                )
                .map_err(error)?;
                crate::runtime::validate_value(&own.output_schema, &fixture.data, "fixture data")
                    .map_err(error)?;
            }
        }
        Ok(artifact.target)
    }

    /// Call only after the ordinary view token, principal, window and sequence
    /// checks. Some presentation-only messages continue through common owners;
    /// every other preview request is answered here or rejected, never forwarded.
    pub fn preview_response(
        &self,
        view: &ViewInstanceId,
        body: &PluginViewRequest,
    ) -> Result<Option<Value>, OperationError> {
        let views = self.views.lock().unwrap();
        let live = views
            .get(view)
            .ok_or_else(|| OperationError::NotFound("view connection".into()))?;
        if live.connection.view.purpose != PluginInstancePurpose::FixturePreview {
            return Ok(None);
        }
        match body {
            PluginViewRequest::RegisterCloseHandler { .. } | PluginViewRequest::ObserveLifecycle { .. }
            | PluginViewRequest::PrepareClose { .. } | PluginViewRequest::RefuseClose { .. }
            | PluginViewRequest::BeginTextCopy | PluginViewRequest::FinishTextCopy { .. }
            | PluginViewRequest::CancelTextCopy { .. } | PluginViewRequest::SetState { .. } => Ok(None),
            PluginViewRequest::Query { capability, arguments } => {
                let fixture = live.fixtures.iter().find(|fixture| fixture.capability == *capability && fixture.arguments == *arguments);
                Ok(Some(json!(host::QuerySnapshot {
                    target: host::TargetRef { kind: "plugin_fixture_preview".into(), identity: view.to_string() },
                    source: "fixture_preview".into(), observed_at_ms: SystemClock.now_ms()?,
                    status: if fixture.is_some() { host::QueryStatus::Ready } else { host::QueryStatus::Unavailable },
                    completeness: if fixture.is_some() { host::ObservationCompleteness::Complete } else { host::ObservationCompleteness::Partial },
                    data: fixture.map(|fixture| fixture.data.clone()),
                    notices: vec![if fixture.is_some() { "Fixture data only. No backend or project was queried." } else { "No fixture matches these exact query arguments. The real Host was not queried." }.into()],
                    next_reads: vec![], diagnostics: vec![],
                })))
            }
            _ => Err(OperationError::AccessDenied {
                capability: "fixture_preview".into(),
                missing: vec!["fixture previews cannot invoke, control, inspect or cancel real operations, read original resources, or navigate externally".into()],
            }),
        }
    }
}
