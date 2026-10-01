//! Bounded observation of the original native reverse call. No dispatch, runtime
//! lookup, recovery, or caller-supplied provider/caller/project identity.
use crate::{PluginService, content_digest, service::error};
use rho_contract as host;
use rho_operation::OperationError;
use rho_plugin_protocol::*;
use serde_json::json;

pub(crate) fn request_identity(
    provider: &InstanceRef,
    parent: &str,
    request: &RequestId,
    project: &str,
) -> Result<String, OperationError> {
    let identity = json!({"provider":provider,"parent":parent,"request":request,"project":project});
    Ok(format!(
        "delegated-{}",
        content_digest(&serde_json::to_vec(&identity).map_err(error)?).as_str()
    ))
}

impl PluginService {
    pub(crate) async fn delegated_operation(
        &self,
        context: &host::CallContext,
        args: &PluginDelegatedOperationArguments,
    ) -> Result<PluginDelegatedOperation, OperationError> {
        context.validate()?;
        if context.caller.kind != host::CallerKind::Plugin {
            return Err(OperationError::AccessDenied {
                capability: "plugins.delegated_operation@1".into(),
                missing: vec!["the original native backend caller".into()],
            });
        }
        // Read the journal directly so binding validation uses the retained native
        // admission, independently of current registration or result presentation.
        let original = self
            .journal
            .get(&args.parent_operation)
            .await?
            .filter(|record| {
                record.operation.principal() == context.principal()
                    && record.operation.idempotency_scope.as_deref() == Some(self.scope.as_str())
            })
            .ok_or_else(|| OperationError::NotFound(args.parent_operation.to_string()))?;
        let request: PluginRequest =
            serde_json::from_value(original.operation.normalized_arguments.clone())
                .map_err(|_| OperationError::NotFound(args.parent_operation.to_string()))?;
        let binding = &request.binding;
        if binding.project != self.project
            || binding.provider.instance.as_str() != context.caller.id
            || binding.capability.id.as_str() != original.operation.capability.id
            || binding.capability.version != u32::from(original.operation.capability.version)
            || original
                .operation
                .admission
                .as_ref()
                .is_none_or(|admission| {
                    admission.owner_context.get("binding") != Some(&json!(binding))
                })
        {
            return Err(OperationError::NotFound(args.parent_operation.to_string()));
        }
        let request_id = request_identity(
            &binding.provider,
            args.parent_operation.as_str(),
            &args.request,
            &self.scope,
        )?;
        let record = self
            .journal
            .get_request(
                &context.caller,
                context.principal(),
                Some(&self.scope),
                &request_id,
            )
            .await?;
        // Keep the journal contract explicit at this edge. A mismatched retained
        // record is not evidence for this request, even with the same opaque key.
        let record = record.filter(|record| {
            record.operation.caller == context.caller
                && record.operation.principal() == context.principal()
                && record.operation.idempotency_scope.as_deref() == Some(self.scope.as_str())
                && record.operation.causation_id.as_ref() == Some(&args.parent_operation)
                && record.operation.client_request_id == request_id
        });
        Ok(PluginDelegatedOperation {
            operation_id: record.map(|record| record.operation.operation_id),
        })
    }
}
