use crate::{service::*, *};
use rho_contract as host;
use rho_operation::OperationError;
use rho_plugin_protocol::*;

impl PluginService {
    pub(crate) fn validate_instance_grants(
        &self,
        context: &host::CallContext,
        manifest: &PluginManifest,
        grants: &[CapabilityRequirement],
    ) -> Result<(), OperationError> {
        let registry = self.registry()?.snapshot();
        for grant in grants {
            let capability = host::CapabilityRef::new(
                grant.capability.id.as_str(),
                grant.capability.version.try_into().map_err(invalid)?,
            )?;
            let (required_scopes, available) =
                if let Some(descriptor) = registry.descriptor(&capability) {
                    (
                        descriptor.required_scopes.clone(),
                        descriptor.kind != host::CapabilityKind::Control
                            || registry.control_handler(&capability).is_ok(),
                    )
                } else if let Some(own) = manifest
                    .capabilities
                    .iter()
                    .find(|own| own.capability == grant.capability)
                {
                    // Combined UI/backend packages may declare their own contract
                    // before publication. Calls still go through the scoped router.
                    (own.required_scopes.clone(), true)
                } else {
                    // A saved plugin revision can supply a contract before its
                    // provider is activated. The grant remains dormant until a
                    // live provider is resolved by the ordinary scoped router.
                    // This permits two ordinary plugins to reference each
                    // other's read capabilities without an activation cycle.
                    let repository = self.repository.lock().unwrap();
                    let mut after = None;
                    let mut declared = None;
                    for _ in 0..10 {
                        let page = repository.list_page(after.as_ref(), 100).map_err(error)?;
                        for installed in page.revisions {
                            let revision = repository.revision(&installed.revision).map_err(error)?;
                            if let Some(own) = revision.manifest.capabilities.iter().find(|own| own.capability == grant.capability) {
                                if let Some((kind, scopes)) = &declared {
                                    if *kind != own.kind || *scopes != own.required_scopes {
                                        return Err(OperationError::Contract(format!("conflicting saved contracts for {}", capability.display_key())));
                                    }
                                } else {
                                    declared = Some((own.kind, own.required_scopes.clone()));
                                }
                            }
                        }
                        after = page.next;
                        if after.is_none() { break; }
                    }
                    let (_, scopes) = declared.ok_or_else(|| OperationError::UnknownCapability(capability.display_key()))?;
                    (scopes, true)
                };
            if !available
                || !required_scopes.is_subset(&grant.scopes)
                || !grant.scopes.is_subset(&context.scopes)
            {
                return Err(OperationError::AccessDenied { capability: capability.display_key(),
                    missing: vec!["declared grant must fit the existing caller authority and an available handler contract".into()] });
            }
        }
        Ok(())
    }

    pub(crate) fn prepare_instance_resume(
        &self,
        context: &host::CallContext,
        args: &ResumePlugin,
    ) -> Result<PluginActivation, OperationError> {
        let principal = plugin_principal_id(context.principal());
        let (record, activation, manifest) = {
            let repo = self.repository.lock().unwrap();
            let (record, activation) = repo
                .suspended_activation(&args.instance, &self.project, &principal, &args.suspension)
                .map_err(|fault| match fault {
                    PluginError::Invalid(message) => invalid(message),
                    PluginError::Missing(identity) => OperationError::NotFound(identity),
                    other => error(other),
                })?;
            let manifest = repo
                .revision(&args.instance.revision)
                .map_err(error)?
                .manifest;
            (record, activation, manifest)
        };
        let target = if manifest.backend.is_some() {
            backend_target()
        } else {
            "ui-web".into()
        };
        if activation.target != target {
            return Err(invalid("retained artifact target does not match this Host"));
        }
        manifest
            .validate_activation_grants(&activation.grants)
            .map_err(error)?;
        // These grants were validated at the original activation and cannot
        // change here. Their providers may still be suspended: resuming this
        // owner must not start them or invent a replacement. Each later call
        // still validates the currently available exact contract and provider.
        for grant in &activation.grants {
            if !grant.scopes.is_subset(&context.scopes) {
                return Err(OperationError::AccessDenied {
                    capability: format!("{}@{}", grant.capability.id, grant.capability.version),
                    missing: grant.scopes.difference(&context.scopes).cloned().collect(),
                });
            }
        }
        Ok(PluginActivation {
            revision: args.instance.revision.clone(),
            artifact: args.instance.artifact.clone(),
            target,
            project: self.project.clone(),
            project_root: Some(self.scope.clone().into()),
            principal,
            alias: record.alias,
            configuration: record.configuration,
            grants: activation.grants,
        })
    }
}
