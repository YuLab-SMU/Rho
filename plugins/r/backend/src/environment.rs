//! Environment semantics stay with its selected provider. R reads the public
//! selection and explicitly delegates verification before launching its session.
use crate::host_calls::HostCalls;
use base64::Engine;
use rho_environment_api::{
    EnvironmentLibrary, EnvironmentReportKind, EnvironmentResult, Verification,
};
use rho_plugin_sdk::protocol::*;
use rho_r_api::{CreateRSession, NativeError, REnvironmentSelection, RSessionEnvironment};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{path::Path, time::Duration};

pub const SCOPES: &[&str] = &[
    "workspace.run_r",
    "project.read",
    "environment.read",
    "environment.write",
    "operation.read",
    "resources.read",
];
pub fn key(id: &str, version: u32) -> CapabilityKey {
    CapabilityKey {
        id: ContributionId::new(id).unwrap(),
        version,
    }
}
pub fn granted(grants: &[CapabilityRequirement]) -> bool {
    [
        (
            key("environment.library", 2),
            vec![
                "project.read",
                "environment.read",
                "operation.read",
                "resources.read",
            ],
        ),
        (
            key("environment.verify", 2),
            vec![
                "project.read",
                "environment.write",
                "operation.read",
                "resources.read",
            ],
        ),
        (key("resources.read", 1), vec!["resources.read"]),
    ]
    .iter()
    .all(|(key, scopes)| {
        grants
            .iter()
            .any(|g| g.capability == *key && scopes.iter().all(|scope| g.scopes.contains(*scope)))
    })
}
pub fn arguments(call: &PluginCall, value: Value, enabled: bool) -> Result<CreateRSession, String> {
    if !enabled || !SCOPES.iter().all(|scope| call.scopes.contains(*scope)) {
        return Err("Environment session creation requires explicitly selected Environment and resource grants and their scopes".into());
    }
    let args: CreateRSession = serde_json::from_value(value).map_err(error)?;
    let binding = &args.environment.binding;
    if binding.capability != key("environment.library", 2)
        || binding.project != call.binding.project
    {
        return Err("Select an exact Environment library provider in this project".into());
    }
    Ok(args)
}
pub fn validate_library(
    library: &EnvironmentLibrary,
    selection: &REnvironmentSelection,
    project: &str,
    r_home: &Path,
) -> Result<(), String> {
    let mut expected = selection.binding.clone();
    expected.target = library.binding.target.clone();
    let selected_rscript = r_home.join("bin/Rscript").canonicalize().map_err(error)?;
    if library.binding != expected
        || library.binding.target.is_none()
        || selection
            .binding
            .target
            .as_ref()
            .is_some_and(|target| Some(target) != library.binding.target.as_ref())
        || library.realization != selection.realization
        || library.project_root != project
        || library.source.project != expected.project
        || library.source.capability != key("environment.realize", 2)
        || library.source.provider.plugin != expected.provider.plugin
        || library.source.target != library.binding.target
        || library.report.owner != library.source.provider
        || library.report.media_type != "application/json"
        || library.report.bytes == 0
        || library.report.bytes > 4 * 1024 * 1024
        || Path::new(&library.rscript) != selected_rscript
        || !Path::new(&library.library_path).is_absolute()
        || !Path::new(&library.storage_root).is_absolute()
        || !Path::new(&library.library_path).starts_with(&library.storage_root)
        || library.r_version.is_empty()
        || library.platform.is_empty()
    {
        return Err("Environment selection differs from its original realization, provider, project or configured R installation".into());
    }
    Ok(())
}
pub async fn select(
    host: &HostCalls,
    call: &PluginCall,
    selection: &REnvironmentSelection,
    project: &str,
    r_home: &Path,
) -> Result<EnvironmentLibrary, String> {
    let observation=host.call(call.request.clone(),None,key("environment.library",2),
        json!({"binding":selection.binding,"arguments":{"realization_operation_id":selection.realization}}),Duration::from_secs(30)).await?;
    if observation["status"] != "ready" || observation["completeness"] != "complete" {
        return Err("Environment library selection is incomplete or unavailable".into());
    }
    let library: EnvironmentLibrary =
        serde_json::from_value(observation["data"].clone()).map_err(error)?;
    validate_library(&library, selection, project, r_home)?;
    Ok(library)
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Qualification {
    pub session_target: String,
    pub environment: EnvironmentLibrary,
}
pub fn qualify(
    call: &PluginCall,
    target: &str,
    enabled: bool,
    project: &str,
    r_home: &Path,
) -> Result<EnvironmentLibrary, String> {
    let args = arguments(call, call.arguments.clone(), enabled)?;
    let qualified: Qualification =
        serde_json::from_value(call.owner_context.clone()).map_err(error)?;
    if qualified.session_target != target
        || args.environment.binding != qualified.environment.binding
    {
        return Err("Environment or R target changed after session admission".into());
    }
    validate_library(&qualified.environment, &args.environment, project, r_home)?;
    Ok(qualified.environment)
}
fn recovery(
    call: &PluginCall,
    library: &EnvironmentLibrary,
    request: &RequestId,
    child: Option<&str>,
) -> Value {
    json!({"operation_id":call.operation_id,"environment":library,"delegated_verification_request":request,"verification_operation":child,
        "automatic_reexecution":false,"action":"inspect_original_session_creation_and_its_causally_linked_verification_before_new_creation"})
}
pub async fn verify(
    host: &HostCalls,
    call: &PluginCall,
    library: &EnvironmentLibrary,
    project: &str,
    r_home: &Path,
    deadline: Duration,
) -> Result<RSessionEnvironment, NativeError> {
    let original = call
        .operation_id
        .as_ref()
        .expect("admitted original identity");
    let request = RequestId::new(format!(
        "r-environment-verify-{:x}",
        Sha256::digest(original.as_bytes())
    ))
    .unwrap();
    let selection = REnvironmentSelection {
        binding: library.binding.clone(),
        realization: library.realization.clone(),
    };
    let mut verification_binding = library.binding.clone();
    verification_binding.capability = key("environment.verify", 2);
    let record=host.call(call.request.clone(),Some(request.clone()),key("environment.verify",2),
        json!({"binding":verification_binding,"arguments":{"realization_operation_id":library.realization},"preconditions":null}),deadline).await
        .map_err(|e|NativeError::after_possible_effect(e,Some(recovery(call,library,&request,None))))?;
    let child = record["operation"]["operation_id"].as_str();
    let unconfirmed = |message: String| {
        NativeError::after_possible_effect(message, Some(recovery(call, library, &request, child)))
    };
    let operation = &record["operation"];
    if child.is_none()
        || operation["causation_id"] != json!(original)
        || operation["capability"] != json!(verification_binding.capability)
        || operation["idempotency_scope"] != project
        || operation["normalized_arguments"]
            != json!({"binding":verification_binding,"arguments":{"realization_operation_id":library.realization},"preconditions":null})
        || operation["admission"]["owner_context"]["binding"] != json!(verification_binding)
    {
        return Err(unconfirmed("Delegated verification did not preserve its original session parent, provider or realization".into()));
    }
    if record["status"] != "succeeded" {
        let mut failure = unconfirmed(
            "Environment verification did not succeed; no R session was launched".into(),
        );
        failure.effect_may_have_occurred =
            !matches!(record["status"].as_str(), Some("failed" | "cancelled"));
        return Err(failure);
    }
    let result: EnvironmentResult =
        serde_json::from_value(record["output"].clone()).map_err(|e| unconfirmed(error(e)))?;
    if result.operation.as_str() != child.unwrap()
        || result.kind != EnvironmentReportKind::Verification
        || result.verified != Some(true)
        || result.report.owner != verification_binding.provider
    {
        return Err(unconfirmed(
            "Delegated verification result changed its original identity or outcome".into(),
        ));
    }
    let bytes = read_report(host, call, &result.report)
        .await
        .map_err(&unconfirmed)?;
    let verified: Verification =
        serde_json::from_slice(&bytes).map_err(|e| unconfirmed(error(e)))?;
    if !verified.verified
        || !verified.library_digest_matches
        || !verified.errors.is_empty()
        || verified.probes.iter().any(|probe| !probe.loadable)
    {
        return Err(unconfirmed(
            "The complete Environment report did not confirm verification".into(),
        ));
    }
    let current = select(host, call, &selection, project, r_home)
        .await
        .map_err(&unconfirmed)?;
    if current != *library {
        return Err(unconfirmed(
            "Selected Environment changed during native verification".into(),
        ));
    }
    Ok(RSessionEnvironment {
        selection,
        source: library.source.clone(),
        report: library.report.clone(),
        verification: result.operation,
        verification_report: result.report,
        library_path: library.library_path.clone(),
        library_digest: library.library_digest.clone(),
    })
}
async fn read_report(
    host: &HostCalls,
    call: &PluginCall,
    reference: &ResourceReference,
) -> Result<Vec<u8>, String> {
    if reference.bytes == 0
        || reference.bytes > 4 * 1024 * 1024
        || reference.media_type != "application/json"
    {
        return Err("Invalid Environment verification report bounds".into());
    }
    let read = async {
        let mut bytes = Vec::with_capacity(reference.bytes as usize);
        while (bytes.len() as u64) < reference.bytes {
            let offset = bytes.len() as u64;
            let response = host
                .call(
                    call.request.clone(),
                    None,
                    key("resources.read", 1),
                    json!(ResourceRead {
                        reference: reference.clone(),
                        offset,
                        limit: MAX_RESOURCE_READ_BYTES
                    }),
                    Duration::from_secs(30),
                )
                .await?;
            if response["status"] != "ready" || response["completeness"] != "complete" {
                return Err("Verification report is unavailable or partial".into());
            }
            let chunk: ResourceChunk =
                serde_json::from_value(response["data"].clone()).map_err(error)?;
            let expected = (reference.bytes - offset).min(u64::from(MAX_RESOURCE_READ_BYTES));
            let end = offset + expected;
            let data = base64::engine::general_purpose::STANDARD
                .decode(chunk.base64)
                .map_err(error)?;
            if chunk.reference != *reference
                || chunk.offset != offset
                || data.len() as u64 != expected
                || chunk.next != (end < reference.bytes).then_some(end)
            {
                return Err("Verification report chunk changed identity, offset or length".into());
            }
            bytes.extend(data);
        }
        if format!("sha256:{:x}", Sha256::digest(&bytes)) != reference.digest.as_str() {
            return Err("Verification report digest changed".into());
        }
        Ok(bytes)
    };
    tokio::time::timeout(Duration::from_secs(30), read)
        .await
        .map_err(|_| "Verification report read is unconfirmed")?
}
fn error(e: impl std::fmt::Display) -> String {
    e.to_string()
}

#[cfg(test)]
#[path = "environment_tests.rs"]
mod tests;
