//! Fixed, bounded Workspace R inspection contracts for workspace plugins.
//!
//! The guest receives an opaque reference issued from an existing bounded
//! snapshot. It never supplies R code, an environment, a project root, a
//! Workspace identity, or a method name.

use std::collections::{BTreeMap, BTreeSet};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use rho_protocol::{ExpectedWorkspace, WorkspaceIdentity};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};
use thiserror::Error;

pub const MAX_WORKSPACE_OBJECT_REFERENCES: usize = 512;
pub const MAX_WORKSPACE_METADATA_BYTES: usize = 64 * 1024;
pub const MAX_WORKSPACE_PREVIEW_BYTES: usize = 256 * 1024;
pub const MAX_WORKSPACE_PREVIEW_ROWS: usize = 100;
pub const MAX_WORKSPACE_PREVIEW_COLUMNS: usize = 50;
pub const MAX_WORKSPACE_PREVIEW_DEPTH: usize = 4;

pub trait WorkspaceReferenceClock: Send + Sync {
    fn now_millis(&self) -> u64;
}

pub trait WorkspaceReferenceIdSource: Send + Sync {
    fn next_id(&self) -> [u8; 16];
}

#[derive(Debug, Default)]
pub struct SystemWorkspaceReferenceClock;

impl WorkspaceReferenceClock for SystemWorkspaceReferenceClock {
    fn now_millis(&self) -> u64 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|duration| duration.as_millis() as u64)
            .unwrap_or(0)
    }
}

#[derive(Debug, Default)]
pub struct OsWorkspaceReferenceIdSource;

impl WorkspaceReferenceIdSource for OsWorkspaceReferenceIdSource {
    fn next_id(&self) -> [u8; 16] {
        rand::random()
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorkspaceInspectionContext {
    pub project_root: String,
    pub workspace: WorkspaceIdentity,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WorkspaceObjectReferenceView {
    pub reference_id: String,
    pub name: String,
    pub classes: Vec<String>,
    pub object_type: String,
    pub preview_kind: String,
    pub issued_at_millis: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct WorkspaceObjectReferenceRecord {
    view: WorkspaceObjectReferenceView,
    project_root: String,
    workspace: WorkspaceIdentity,
    object_identity_digest: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WorkspaceInspectOperation {
    Metadata,
    Preview,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct WorkspaceInspectRequest {
    pub object_reference: String,
    pub operation: WorkspaceInspectOperation,
}

#[derive(Debug, Clone, PartialEq)]
pub struct PreparedWorkspaceInspection {
    pub reference_id: String,
    pub request_type: &'static str,
    pub arguments: Value,
    pub expected_workspace: ExpectedWorkspace,
    operation: WorkspaceInspectOperation,
    record: WorkspaceObjectReferenceRecord,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WorkspaceInspectErrorCode {
    InvalidProject,
    InvalidSnapshot,
    ReferenceLimit,
    UnknownReference,
    StaleWorkspace,
    ObjectChanged,
    MalformedResult,
    ResultTooLarge,
}

#[derive(Debug, Error, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[error("workspace inspection failed: {code:?}")]
pub struct WorkspaceInspectError {
    pub code: WorkspaceInspectErrorCode,
}

impl WorkspaceInspectError {
    fn new(code: WorkspaceInspectErrorCode) -> Self {
        Self { code }
    }
}

pub struct WorkspaceObjectReferenceRegistry {
    references: BTreeMap<String, WorkspaceObjectReferenceRecord>,
    clock: Arc<dyn WorkspaceReferenceClock>,
    id_source: Arc<dyn WorkspaceReferenceIdSource>,
}

impl std::fmt::Debug for WorkspaceObjectReferenceRegistry {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("WorkspaceObjectReferenceRegistry")
            .field("reference_count", &self.references.len())
            .finish_non_exhaustive()
    }
}

impl Default for WorkspaceObjectReferenceRegistry {
    fn default() -> Self {
        Self::new()
    }
}

impl WorkspaceObjectReferenceRegistry {
    pub fn new() -> Self {
        Self::with_sources(
            Arc::new(SystemWorkspaceReferenceClock),
            Arc::new(OsWorkspaceReferenceIdSource),
        )
    }

    pub fn with_sources(
        clock: Arc<dyn WorkspaceReferenceClock>,
        id_source: Arc<dyn WorkspaceReferenceIdSource>,
    ) -> Self {
        Self {
            references: BTreeMap::new(),
            clock,
            id_source,
        }
    }

    pub fn issue_from_snapshot(
        &mut self,
        context: &WorkspaceInspectionContext,
        snapshot_response: &Value,
    ) -> Result<Vec<WorkspaceObjectReferenceView>, WorkspaceInspectError> {
        validate_context(context)?;
        if !same_workspace_lineage(&decode_workspace(snapshot_response)?, &context.workspace) {
            return Err(WorkspaceInspectError::new(
                WorkspaceInspectErrorCode::StaleWorkspace,
            ));
        }
        let execution = snapshot_response
            .get("execution")
            .filter(|value| value.is_object())
            .unwrap_or(snapshot_response);
        let objects = execution
            .get("objects")
            .and_then(Value::as_array)
            .ok_or_else(|| {
                WorkspaceInspectError::new(WorkspaceInspectErrorCode::InvalidSnapshot)
            })?;
        if objects.len() > 200
            || self.references.len() + objects.len() > MAX_WORKSPACE_OBJECT_REFERENCES
        {
            return Err(WorkspaceInspectError::new(
                WorkspaceInspectErrorCode::ReferenceLimit,
            ));
        }
        let mut decoded = objects
            .iter()
            .map(decode_object_descriptor)
            .collect::<Result<Vec<_>, _>>()?;
        decoded.sort_by(|left, right| left.0.cmp(&right.0));
        if decoded.windows(2).any(|pair| pair[0].0 == pair[1].0) {
            return Err(WorkspaceInspectError::new(
                WorkspaceInspectErrorCode::InvalidSnapshot,
            ));
        }

        let mut issued = Vec::with_capacity(decoded.len());
        let mut staged = Vec::with_capacity(decoded.len());
        let mut staged_ids = BTreeSet::new();
        for (name, classes, object_type, preview_kind, identity_digest) in decoded {
            let reference_id = format!("object.{}", hex_encode(&self.id_source.next_id()));
            if self.references.contains_key(&reference_id)
                || !staged_ids.insert(reference_id.clone())
            {
                return Err(WorkspaceInspectError::new(
                    WorkspaceInspectErrorCode::ReferenceLimit,
                ));
            }
            let view = WorkspaceObjectReferenceView {
                reference_id: reference_id.clone(),
                name,
                classes,
                object_type,
                preview_kind,
                issued_at_millis: self.clock.now_millis(),
            };
            staged.push((
                reference_id,
                WorkspaceObjectReferenceRecord {
                    view: view.clone(),
                    project_root: context.project_root.clone(),
                    workspace: context.workspace.clone(),
                    object_identity_digest: identity_digest,
                },
            ));
            issued.push(view);
        }
        self.references.extend(staged);
        Ok(issued)
    }

    pub fn prepare(
        &self,
        context: &WorkspaceInspectionContext,
        request: &WorkspaceInspectRequest,
    ) -> Result<PreparedWorkspaceInspection, WorkspaceInspectError> {
        validate_context(context)?;
        let record = self
            .references
            .get(&request.object_reference)
            .ok_or_else(|| {
                WorkspaceInspectError::new(WorkspaceInspectErrorCode::UnknownReference)
            })?;
        if record.project_root != context.project_root
            || !same_workspace_lineage(&record.workspace, &context.workspace)
        {
            return Err(WorkspaceInspectError::new(
                WorkspaceInspectErrorCode::StaleWorkspace,
            ));
        }
        Ok(PreparedWorkspaceInspection {
            reference_id: request.object_reference.clone(),
            request_type: "workspace.inspect_object",
            arguments: json!({"name": record.view.name}),
            expected_workspace: ExpectedWorkspace {
                kernel_instance_id: Some(context.workspace.kernel_instance_id.clone()),
                state_revision: Some(context.workspace.state_revision),
                project_revision: Some(context.workspace.project_revision),
            },
            operation: request.operation.clone(),
            record: record.clone(),
        })
    }

    pub fn finish(
        &self,
        context: &WorkspaceInspectionContext,
        prepared: &PreparedWorkspaceInspection,
        response: &Value,
    ) -> Result<Value, WorkspaceInspectError> {
        validate_context(context)?;
        if prepared.record.project_root != context.project_root
            || !same_workspace_lineage(&prepared.record.workspace, &context.workspace)
            || prepared.reference_id != prepared.record.view.reference_id
            || !same_workspace_lineage(&decode_workspace(response)?, &context.workspace)
        {
            return Err(WorkspaceInspectError::new(
                WorkspaceInspectErrorCode::StaleWorkspace,
            ));
        }
        let execution = response
            .get("execution")
            .filter(|value| value.is_object())
            .unwrap_or(response);
        if decode_object_descriptor(execution)?.4 != prepared.record.object_identity_digest {
            return Err(WorkspaceInspectError::new(
                WorkspaceInspectErrorCode::ObjectChanged,
            ));
        }
        let mut projected = Map::new();
        for key in [
            "ok",
            "name",
            "classes",
            "dimensions",
            "size_bytes",
            "typeof",
            "preview_kind",
        ] {
            if let Some(value) = execution.get(key) {
                projected.insert(key.to_string(), value.clone());
            }
        }
        let maximum = match prepared.operation {
            WorkspaceInspectOperation::Metadata => MAX_WORKSPACE_METADATA_BYTES,
            WorkspaceInspectOperation::Preview => {
                if let Some(preview) = execution.get("preview") {
                    validate_preview(preview, 0)?;
                    projected.insert("preview".to_string(), preview.clone());
                }
                if let Some(structure) = execution.get("structure") {
                    validate_preview(structure, 0)?;
                    projected.insert("structure".to_string(), structure.clone());
                }
                MAX_WORKSPACE_PREVIEW_BYTES
            }
        };
        let value = Value::Object(projected);
        let encoded = serde_json::to_vec(&value)
            .map_err(|_| WorkspaceInspectError::new(WorkspaceInspectErrorCode::MalformedResult))?;
        if encoded.len() > maximum {
            return Err(WorkspaceInspectError::new(
                WorkspaceInspectErrorCode::ResultTooLarge,
            ));
        }
        Ok(value)
    }

    pub fn invalidate_project(&mut self, project_root: &str) -> usize {
        let before = self.references.len();
        self.references
            .retain(|_, record| record.project_root != project_root);
        before - self.references.len()
    }

    pub fn list_for_context(
        &self,
        context: &WorkspaceInspectionContext,
    ) -> Vec<WorkspaceObjectReferenceView> {
        self.references
            .values()
            .filter(|record| {
                record.project_root == context.project_root
                    && same_workspace_lineage(&record.workspace, &context.workspace)
            })
            .map(|record| record.view.clone())
            .collect()
    }

    pub fn invalidate_workspace(&mut self, workspace: &WorkspaceIdentity) -> usize {
        let before = self.references.len();
        self.references
            .retain(|_, record| &record.workspace != workspace);
        before - self.references.len()
    }
}

fn same_workspace_lineage(left: &WorkspaceIdentity, right: &WorkspaceIdentity) -> bool {
    left.workspace_id == right.workspace_id
        && left.kernel_instance_id == right.kernel_instance_id
        && left.state_revision == right.state_revision
        && left.project_revision == right.project_revision
}

fn validate_context(context: &WorkspaceInspectionContext) -> Result<(), WorkspaceInspectError> {
    if context.project_root.is_empty()
        || context.project_root == "legacy_unscoped"
        || context.project_root.contains('\\')
        || rho_store::normalize_project_root(&context.project_root) != context.project_root
        || context.workspace.workspace_id.is_empty()
        || context.workspace.kernel_instance_id.is_empty()
    {
        return Err(WorkspaceInspectError::new(
            WorkspaceInspectErrorCode::InvalidProject,
        ));
    }
    Ok(())
}

fn decode_workspace(response: &Value) -> Result<WorkspaceIdentity, WorkspaceInspectError> {
    serde_json::from_value(
        response.get("workspace").cloned().ok_or_else(|| {
            WorkspaceInspectError::new(WorkspaceInspectErrorCode::MalformedResult)
        })?,
    )
    .map_err(|_| WorkspaceInspectError::new(WorkspaceInspectErrorCode::MalformedResult))
}

type ObjectDescriptor = (String, Vec<String>, String, String, String);

fn decode_object_descriptor(value: &Value) -> Result<ObjectDescriptor, WorkspaceInspectError> {
    let name = bounded_string(value.get("name"), 256)?;
    let classes = match value.get("classes") {
        Some(Value::String(class)) => {
            vec![bounded_string(Some(&Value::String(class.clone())), 256)?]
        }
        Some(Value::Array(classes)) => classes
            .iter()
            .map(|value| bounded_string(Some(value), 256))
            .collect::<Result<Vec<_>, _>>()?,
        _ => {
            return Err(WorkspaceInspectError::new(
                WorkspaceInspectErrorCode::MalformedResult,
            ));
        }
    };
    if classes.len() > 32 {
        return Err(WorkspaceInspectError::new(
            WorkspaceInspectErrorCode::MalformedResult,
        ));
    }
    let object_type = bounded_string(value.get("typeof"), 128)?;
    let preview_kind = bounded_string(value.get("preview_kind"), 128)?;
    let identity = json!({
        "classes": classes,
        "name": name,
        "preview_kind": preview_kind,
        "typeof": object_type,
    });
    let digest = hex_encode(&Sha256::digest(serde_json::to_vec(&identity).map_err(
        |_| WorkspaceInspectError::new(WorkspaceInspectErrorCode::MalformedResult),
    )?));
    Ok((name, classes, object_type, preview_kind, digest))
}

fn bounded_string(value: Option<&Value>, maximum: usize) -> Result<String, WorkspaceInspectError> {
    value
        .and_then(Value::as_str)
        .filter(|value| {
            !value.is_empty()
                && value.len() <= maximum
                && !value.chars().any(char::is_control)
                && !value.chars().any(is_bidi_override)
        })
        .map(str::to_string)
        .ok_or_else(|| WorkspaceInspectError::new(WorkspaceInspectErrorCode::MalformedResult))
}

fn validate_preview(value: &Value, depth: usize) -> Result<(), WorkspaceInspectError> {
    if depth > MAX_WORKSPACE_PREVIEW_DEPTH {
        return Err(WorkspaceInspectError::new(
            WorkspaceInspectErrorCode::ResultTooLarge,
        ));
    }
    match value {
        Value::Array(values) => {
            if values.len() > MAX_WORKSPACE_PREVIEW_ROWS {
                return Err(WorkspaceInspectError::new(
                    WorkspaceInspectErrorCode::ResultTooLarge,
                ));
            }
            for value in values {
                validate_preview(value, depth + 1)?;
            }
        }
        Value::Object(values) => {
            if values.len() > MAX_WORKSPACE_PREVIEW_COLUMNS {
                return Err(WorkspaceInspectError::new(
                    WorkspaceInspectErrorCode::ResultTooLarge,
                ));
            }
            for (key, value) in values {
                if key.len() > 512 || key.chars().any(char::is_control) {
                    return Err(WorkspaceInspectError::new(
                        WorkspaceInspectErrorCode::MalformedResult,
                    ));
                }
                validate_preview(value, depth + 1)?;
            }
        }
        Value::String(value) if value.len() > 64 * 1024 => {
            return Err(WorkspaceInspectError::new(
                WorkspaceInspectErrorCode::ResultTooLarge,
            ));
        }
        _ => {}
    }
    Ok(())
}

fn is_bidi_override(character: char) -> bool {
    matches!(
        character,
        '\u{061c}'
            | '\u{200e}'
            | '\u{200f}'
            | '\u{202a}'..='\u{202e}'
            | '\u{2066}'..='\u{2069}'
    )
}

fn hex_encode(bytes: &[u8]) -> String {
    use std::fmt::Write;
    let mut encoded = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        write!(&mut encoded, "{byte:02x}").expect("writing to String cannot fail");
    }
    encoded
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};

    #[derive(Debug)]
    struct Clock(AtomicU64);
    impl WorkspaceReferenceClock for Clock {
        fn now_millis(&self) -> u64 {
            self.0.load(Ordering::SeqCst)
        }
    }
    #[derive(Debug)]
    struct Id([u8; 16]);
    impl WorkspaceReferenceIdSource for Id {
        fn next_id(&self) -> [u8; 16] {
            self.0
        }
    }

    fn identity(project_revision: u64) -> WorkspaceIdentity {
        WorkspaceIdentity {
            workspace_id: "workspace.a".to_string(),
            kernel_instance_id: "kernel.a".to_string(),
            execution_seq: 1,
            state_revision: 2,
            project_revision,
        }
    }

    fn context(project: &str, project_revision: u64) -> WorkspaceInspectionContext {
        WorkspaceInspectionContext {
            project_root: project.to_string(),
            workspace: identity(project_revision),
        }
    }

    fn snapshot(workspace: &WorkspaceIdentity, name: &str) -> Value {
        json!({"execution":{"ok":true,"objects":[{
            "name":name,"classes":["data.frame"],"dimensions":[2,2],
            "size_bytes":128,"typeof":"list","preview_kind":"tabular"
        }]},"workspace":workspace})
    }

    fn inspection(workspace: &WorkspaceIdentity, name: &str) -> Value {
        json!({"execution":{
            "ok":true,"name":name,"classes":["data.frame"],"dimensions":[2,2],
            "size_bytes":128,"typeof":"list","preview_kind":"tabular",
            "preview":{"kind":"tabular","rows":[{"x":1},{"x":2}]},
            "structure":"data.frame: 2 obs.",
            "function_source":{"definition":"must not escape"}
        },"workspace":workspace})
    }

    fn registry() -> WorkspaceObjectReferenceRegistry {
        WorkspaceObjectReferenceRegistry::with_sources(
            Arc::new(Clock(AtomicU64::new(123))),
            Arc::new(Id([7; 16])),
        )
    }

    #[test]
    fn issues_prepares_and_bounds_metadata_and_preview_without_r_code() {
        let context = context("D:/project/a", 3);
        let mut registry = registry();
        let references = registry
            .issue_from_snapshot(&context, &snapshot(&context.workspace, "qc"))
            .unwrap();
        assert_eq!(references[0].issued_at_millis, 123);
        let prepared = registry
            .prepare(
                &context,
                &WorkspaceInspectRequest {
                    object_reference: references[0].reference_id.clone(),
                    operation: WorkspaceInspectOperation::Preview,
                },
            )
            .unwrap();
        assert_eq!(prepared.request_type, "workspace.inspect_object");
        assert_eq!(prepared.arguments, json!({"name": "qc"}));
        let result = registry
            .finish(&context, &prepared, &inspection(&context.workspace, "qc"))
            .unwrap();
        assert!(result.get("preview").is_some());
        assert!(result.get("function_source").is_none());

        let metadata = registry
            .prepare(
                &context,
                &WorkspaceInspectRequest {
                    object_reference: references[0].reference_id.clone(),
                    operation: WorkspaceInspectOperation::Metadata,
                },
            )
            .unwrap();
        let result = registry
            .finish(&context, &metadata, &inspection(&context.workspace, "qc"))
            .unwrap();
        assert!(result.get("preview").is_none());
        assert!(serde_json::to_vec(&result).unwrap().len() < MAX_WORKSPACE_METADATA_BYTES);
    }

    #[test]
    fn same_name_two_projects_and_workspace_restart_are_isolated() {
        let context_a = context("D:/project/a", 3);
        let context_b = context("D:/project/b", 3);
        let mut registry = registry();
        let reference = registry
            .issue_from_snapshot(&context_a, &snapshot(&context_a.workspace, "qc"))
            .unwrap()[0]
            .clone();
        assert_eq!(
            registry
                .prepare(
                    &context_b,
                    &WorkspaceInspectRequest {
                        object_reference: reference.reference_id.clone(),
                        operation: WorkspaceInspectOperation::Metadata
                    }
                )
                .unwrap_err()
                .code,
            WorkspaceInspectErrorCode::StaleWorkspace
        );
        let mut restarted = context_a.clone();
        restarted.workspace.kernel_instance_id = "kernel.b".to_string();
        assert_eq!(
            registry
                .prepare(
                    &restarted,
                    &WorkspaceInspectRequest {
                        object_reference: reference.reference_id,
                        operation: WorkspaceInspectOperation::Preview
                    }
                )
                .unwrap_err()
                .code,
            WorkspaceInspectErrorCode::StaleWorkspace
        );
    }

    #[test]
    fn object_change_late_workspace_and_oversized_preview_fail_closed() {
        let context = context("D:/project/a", 3);
        let mut registry = registry();
        let reference = registry
            .issue_from_snapshot(&context, &snapshot(&context.workspace, "qc"))
            .unwrap()[0]
            .clone();
        let prepared = registry
            .prepare(
                &context,
                &WorkspaceInspectRequest {
                    object_reference: reference.reference_id,
                    operation: WorkspaceInspectOperation::Preview,
                },
            )
            .unwrap();
        let mut changed = inspection(&context.workspace, "qc");
        changed["execution"]["typeof"] = json!("closure");
        assert_eq!(
            registry
                .finish(&context, &prepared, &changed)
                .unwrap_err()
                .code,
            WorkspaceInspectErrorCode::ObjectChanged
        );
        let mut late = inspection(&context.workspace, "qc");
        late["workspace"]["state_revision"] = json!(99);
        assert_eq!(
            registry
                .finish(&context, &prepared, &late)
                .unwrap_err()
                .code,
            WorkspaceInspectErrorCode::StaleWorkspace
        );
        let mut oversized = inspection(&context.workspace, "qc");
        oversized["execution"]["preview"] = json!({"rows": (0..101).collect::<Vec<_>>()});
        assert_eq!(
            registry
                .finish(&context, &prepared, &oversized)
                .unwrap_err()
                .code,
            WorkspaceInspectErrorCode::ResultTooLarge
        );
    }

    #[test]
    fn reference_issue_is_transactional_and_accepts_opaque_active_binding_descriptor() {
        let context = context("D:/project/a", 3);
        let mut registry = registry();
        let duplicate_ids = json!({
            "execution": {"objects": [
                {"name":"a","classes":["numeric"],"typeof":"double","preview_kind":"vector"},
                {"name":"b","classes":["numeric"],"typeof":"double","preview_kind":"vector"}
            ]},
            "workspace": &context.workspace
        });
        assert_eq!(
            registry
                .issue_from_snapshot(&context, &duplicate_ids)
                .unwrap_err()
                .code,
            WorkspaceInspectErrorCode::ReferenceLimit
        );
        assert!(registry.references.is_empty());

        let active = json!({
            "execution": {"objects": [{
                "name":"dynamic","classes":"active_binding",
                "typeof":"active_binding","preview_kind":"opaque"
            }]},
            "workspace": &context.workspace
        });
        let reference = registry.issue_from_snapshot(&context, &active).unwrap();
        assert_eq!(reference[0].object_type, "active_binding");
        assert_eq!(reference[0].classes, vec!["active_binding"]);
    }
}
