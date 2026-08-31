use std::collections::{BTreeMap, BTreeSet};

use rho_protocol::{
    CapabilityDescriptor, CapabilityId, DataClass, DestinationClass, EffectClass, ExecutorKind,
    RetryClass, TargetClass, run_r_descriptor,
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use thiserror::Error;

pub const MAX_CAPABILITY_ARGUMENT_BYTES: usize = 256 * 1024;
pub const MAX_CAPABILITY_ARRAY_ITEMS: usize = 1024;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ResultSensitivityRule {
    SameAsInput,
    Fixed(DataClass),
    AtLeast(DataClass),
}

impl ResultSensitivityRule {
    pub fn classify(self, input: DataClass) -> DataClass {
        match self {
            Self::SameAsInput => input,
            Self::Fixed(value) => value,
            Self::AtLeast(value) => input.join(value),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct RegisteredCapability {
    pub descriptor: CapabilityDescriptor,
    pub result_sensitivity: ResultSensitivityRule,
    pub destinations: Vec<DestinationClass>,
    pub max_argument_bytes: usize,
    pub max_array_items: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ProviderCapabilityDescription {
    pub id: CapabilityId,
    pub display_name: String,
    pub effect_class: EffectClass,
    pub retry_class: RetryClass,
    pub target_class: TargetClass,
    pub destinations: Vec<DestinationClass>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct CapabilitySupport {
    pub targets: BTreeSet<TargetClass>,
    pub destinations: BTreeSet<DestinationClass>,
}

#[derive(Debug, Clone, Default)]
pub struct CapabilityRegistry {
    entries: BTreeMap<CapabilityId, RegisteredCapability>,
}

#[derive(Debug, Error, Clone, PartialEq, Eq)]
pub enum CapabilityRegistryError {
    #[error("duplicate capability id {0}")]
    Duplicate(CapabilityId),
    #[error("capability {0} not found")]
    NotFound(CapabilityId),
    #[error("capability {id} has contradictory metadata: {reason}")]
    ContradictoryMetadata { id: CapabilityId, reason: String },
    #[error("capability {id} arguments exceed bounds: {actual} > {limit}")]
    ArgumentBytesExceeded {
        id: CapabilityId,
        limit: usize,
        actual: usize,
    },
    #[error("capability {id} arguments violate schema: {reason}")]
    SchemaViolation { id: CapabilityId, reason: String },
    #[error("capability registry contains no supported executor target for {0}")]
    UnsupportedTarget(CapabilityId),
}

impl CapabilityRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn canonical() -> Result<Self, CapabilityRegistryError> {
        let mut registry = Self::new();
        for capability in canonical_capabilities() {
            registry.register(capability)?;
        }
        registry.validate_startup()?;
        Ok(registry)
    }

    pub fn register(
        &mut self,
        capability: RegisteredCapability,
    ) -> Result<(), CapabilityRegistryError> {
        validate_metadata(&capability)?;
        let id = capability.descriptor.id.clone();
        if self.entries.contains_key(&id) {
            return Err(CapabilityRegistryError::Duplicate(id));
        }
        self.entries.insert(id, capability);
        Ok(())
    }

    pub fn descriptor(
        &self,
        id: &CapabilityId,
    ) -> Result<&RegisteredCapability, CapabilityRegistryError> {
        self.entries
            .get(id)
            .ok_or_else(|| CapabilityRegistryError::NotFound(id.clone()))
    }

    pub fn validate_arguments(
        &self,
        id: &CapabilityId,
        arguments: &Value,
    ) -> Result<(), CapabilityRegistryError> {
        let entry = self.descriptor(id)?;
        let encoded = serde_json::to_vec(arguments).map_err(|error| {
            CapabilityRegistryError::SchemaViolation {
                id: id.clone(),
                reason: error.to_string(),
            }
        })?;
        if encoded.len() > entry.max_argument_bytes {
            return Err(CapabilityRegistryError::ArgumentBytesExceeded {
                id: id.clone(),
                limit: entry.max_argument_bytes,
                actual: encoded.len(),
            });
        }
        validate_schema_subset(
            id,
            &entry.descriptor.input_schema,
            arguments,
            entry.max_array_items,
        )
    }

    pub fn provider_snapshot(
        &self,
        support: &CapabilitySupport,
    ) -> Vec<ProviderCapabilityDescription> {
        self.entries
            .values()
            .filter(|entry| support.targets.contains(&entry.descriptor.target_class))
            .filter(|entry| {
                entry
                    .destinations
                    .iter()
                    .any(|destination| support.destinations.contains(destination))
            })
            .map(|entry| ProviderCapabilityDescription {
                id: entry.descriptor.id.clone(),
                display_name: entry.descriptor.display_name.clone(),
                effect_class: entry.descriptor.effect_class,
                retry_class: entry.descriptor.retry_class,
                target_class: entry.descriptor.target_class,
                destinations: entry
                    .destinations
                    .iter()
                    .copied()
                    .filter(|destination| support.destinations.contains(destination))
                    .collect(),
            })
            .collect()
    }

    pub fn read_only_observer_snapshot(
        &self,
        support: &CapabilitySupport,
    ) -> Vec<ProviderCapabilityDescription> {
        self.provider_snapshot(support)
            .into_iter()
            .filter(|description| description.effect_class == EffectClass::Read)
            .collect()
    }

    pub fn validate_startup(&self) -> Result<(), CapabilityRegistryError> {
        for entry in self.entries.values() {
            validate_metadata(entry)?;
            if entry.descriptor.allowed_executors.is_empty() {
                return Err(CapabilityRegistryError::UnsupportedTarget(
                    entry.descriptor.id.clone(),
                ));
            }
        }
        Ok(())
    }
}

pub fn canonical_capabilities() -> Vec<RegisteredCapability> {
    vec![
        with_schema(
            descriptor(
                "workspace.inspect",
                "Inspect Workspace state",
                EffectClass::Read,
                RetryClass::PureRead,
                DataClass::ProjectConfidential,
                TargetClass::Workspace,
                vec![ExecutorKind::Workspace],
                true,
            ),
            json!({
                "type": "object",
                "required": ["query"],
                "additionalProperties": false,
                "properties": { "query": {"type": "string", "minLength": 1} }
            }),
            ResultSensitivityRule::SameAsInput,
            vec![DestinationClass::LocalWorkspace],
        ),
        with_schema(
            descriptor(
                "workspace.inspect_object",
                "Inspect a bounded Workspace object summary",
                EffectClass::Read,
                RetryClass::PureRead,
                DataClass::ProjectConfidential,
                TargetClass::Workspace,
                vec![ExecutorKind::Workspace],
                true,
            ),
            json!({
                "type": "object",
                "required": ["object"],
                "additionalProperties": false,
                "properties": { "object": {"type": "string", "minLength": 1} }
            }),
            ResultSensitivityRule::SameAsInput,
            vec![DestinationClass::LocalWorkspace],
        ),
        with_schema(
            descriptor(
                "snapshot.read",
                "Read a bounded staged snapshot",
                EffectClass::Read,
                RetryClass::PureRead,
                DataClass::ProjectConfidential,
                TargetClass::ProjectFiles,
                vec![ExecutorKind::LocalProcess],
                true,
            ),
            json!({
                "type": "object",
                "required": ["snapshot_ref"],
                "additionalProperties": false,
                "properties": { "snapshot_ref": {"type": "string", "minLength": 1} }
            }),
            ResultSensitivityRule::SameAsInput,
            vec![DestinationClass::LocalSandbox],
        ),
        with_schema(
            descriptor(
                "history.errors",
                "Read bounded error history",
                EffectClass::Read,
                RetryClass::PureRead,
                DataClass::ProjectInternal,
                TargetClass::LocalProcess,
                vec![ExecutorKind::LocalProcess],
                true,
            ),
            json!({
                "type": "object",
                "additionalProperties": false,
                "properties": { "limit": {"type": "integer", "minimum": 1} }
            }),
            ResultSensitivityRule::AtLeast(DataClass::ProjectInternal),
            vec![DestinationClass::LocalSandbox],
        ),
        with_schema(
            run_r_descriptor(),
            run_r_descriptor().input_schema,
            ResultSensitivityRule::AtLeast(DataClass::ProjectConfidential),
            vec![DestinationClass::LocalWorkspace],
        ),
        with_schema(
            descriptor(
                "project.apply_patch",
                "Apply project patch",
                EffectClass::ProjectMutation,
                RetryClass::NonIdempotent,
                DataClass::ProjectConfidential,
                TargetClass::ProjectFiles,
                vec![ExecutorKind::LocalProcess],
                true,
            ),
            json!({
                "type": "object",
                "required": ["patch"],
                "additionalProperties": false,
                "properties": { "patch": {"type": "string", "minLength": 1} }
            }),
            ResultSensitivityRule::AtLeast(DataClass::ProjectConfidential),
            vec![DestinationClass::LocalSandbox],
        ),
        with_schema(
            descriptor(
                "network.fetch",
                "Fetch allowlisted network resource",
                EffectClass::ExternalEffect,
                RetryClass::ConditionallyIdempotent,
                DataClass::ProjectConfidential,
                TargetClass::ExternalService,
                vec![ExecutorKind::LocalProcess],
                false,
            ),
            json!({
                "type": "object",
                "required": ["url"],
                "additionalProperties": false,
                "properties": { "url": {"type": "string", "minLength": 1} }
            }),
            ResultSensitivityRule::AtLeast(DataClass::ProjectInternal),
            vec![DestinationClass::AllowlistedDomain],
        ),
        with_schema(
            descriptor(
                "artifact.commit",
                "Commit immutable artifact",
                EffectClass::WorkspaceMutation,
                RetryClass::IdempotentWrite,
                DataClass::ProjectConfidential,
                TargetClass::LocalProcess,
                vec![ExecutorKind::LocalProcess],
                true,
            ),
            json!({
                "type": "object",
                "required": ["digest", "byte_size"],
                "additionalProperties": false,
                "properties": {
                    "digest": {"type": "string", "minLength": 71},
                    "byte_size": {"type": "integer", "minimum": 0}
                }
            }),
            ResultSensitivityRule::AtLeast(DataClass::ProjectInternal),
            vec![DestinationClass::LocalWorkspace],
        ),
    ]
}

pub fn mcp_facade_snapshot_fixture() -> Vec<ProviderCapabilityDescription> {
    CapabilityRegistry::canonical()
        .unwrap()
        .provider_snapshot(&first_party_support())
}

pub fn first_party_adapter_snapshot_fixture() -> Vec<ProviderCapabilityDescription> {
    CapabilityRegistry::canonical()
        .unwrap()
        .provider_snapshot(&first_party_support())
}

pub fn first_party_support() -> CapabilitySupport {
    CapabilitySupport {
        targets: [
            TargetClass::Workspace,
            TargetClass::ProjectFiles,
            TargetClass::LocalProcess,
            TargetClass::ExternalService,
        ]
        .into_iter()
        .collect(),
        destinations: [
            DestinationClass::LocalWorkspace,
            DestinationClass::LocalSandbox,
            DestinationClass::AllowlistedDomain,
        ]
        .into_iter()
        .collect(),
    }
}

fn with_schema(
    mut descriptor: CapabilityDescriptor,
    input_schema: Value,
    result_sensitivity: ResultSensitivityRule,
    destinations: Vec<DestinationClass>,
) -> RegisteredCapability {
    descriptor.input_schema = input_schema;
    RegisteredCapability {
        descriptor,
        result_sensitivity,
        destinations,
        max_argument_bytes: MAX_CAPABILITY_ARGUMENT_BYTES,
        max_array_items: MAX_CAPABILITY_ARRAY_ITEMS,
    }
}

// Registry rows spell every policy dimension out at the call site so a
// capability cannot inherit an implicit authority posture.
#[allow(clippy::too_many_arguments)]
fn descriptor(
    id: &str,
    display_name: &str,
    effect_class: EffectClass,
    retry_class: RetryClass,
    data_class: DataClass,
    target_class: TargetClass,
    allowed_executors: Vec<ExecutorKind>,
    requires_workspace: bool,
) -> CapabilityDescriptor {
    CapabilityDescriptor::new(
        CapabilityId::new(id).expect("canonical capability id is valid"),
        display_name,
        effect_class,
        retry_class,
        data_class,
        target_class,
        allowed_executors,
        requires_workspace,
    )
}

fn validate_metadata(entry: &RegisteredCapability) -> Result<(), CapabilityRegistryError> {
    let id = entry.descriptor.id.clone();
    if entry.descriptor.effect_class != EffectClass::Read
        && entry.descriptor.retry_class == RetryClass::PureRead
    {
        return Err(CapabilityRegistryError::ContradictoryMetadata {
            id,
            reason: "mutation cannot be pure_read".to_string(),
        });
    }
    if entry.descriptor.data_class == DataClass::RestrictedSecret
        && entry
            .result_sensitivity
            .classify(entry.descriptor.data_class)
            == DataClass::Public
    {
        return Err(CapabilityRegistryError::ContradictoryMetadata {
            id,
            reason: "secret input cannot produce public result".to_string(),
        });
    }
    if !entry.descriptor.input_schema.is_object() || !entry.descriptor.output_schema.is_object() {
        return Err(CapabilityRegistryError::ContradictoryMetadata {
            id,
            reason: "schemas must be JSON objects".to_string(),
        });
    }
    Ok(())
}

fn validate_schema_subset(
    id: &CapabilityId,
    schema: &Value,
    value: &Value,
    max_array_items: usize,
) -> Result<(), CapabilityRegistryError> {
    if schema.get("type").and_then(Value::as_str) != Some("object") || !value.is_object() {
        return Err(CapabilityRegistryError::SchemaViolation {
            id: id.clone(),
            reason: "arguments must be a JSON object".to_string(),
        });
    }
    let object = value.as_object().expect("checked object");
    if let Some(required) = schema.get("required").and_then(Value::as_array) {
        for item in required {
            let Some(name) = item.as_str() else {
                continue;
            };
            if !object.contains_key(name) {
                return Err(CapabilityRegistryError::SchemaViolation {
                    id: id.clone(),
                    reason: format!("missing required property {name}"),
                });
            }
        }
    }
    let properties = schema
        .get("properties")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    if schema.get("additionalProperties").and_then(Value::as_bool) == Some(false) {
        for key in object.keys() {
            if !properties.contains_key(key) {
                return Err(CapabilityRegistryError::SchemaViolation {
                    id: id.clone(),
                    reason: format!("unknown property {key}"),
                });
            }
        }
    }
    for (key, property_schema) in properties {
        let Some(actual) = object.get(&key) else {
            continue;
        };
        validate_value_type(id, &key, &property_schema, actual, max_array_items)?;
    }
    Ok(())
}

fn validate_value_type(
    id: &CapabilityId,
    key: &str,
    schema: &Value,
    value: &Value,
    max_array_items: usize,
) -> Result<(), CapabilityRegistryError> {
    match schema.get("type").and_then(Value::as_str) {
        Some("string") => {
            let Some(text) = value.as_str() else {
                return Err(schema_error(id, key, "must be string"));
            };
            if let Some(min_length) = schema.get("minLength").and_then(Value::as_u64)
                && text.len() < min_length as usize
            {
                return Err(schema_error(id, key, "is shorter than minLength"));
            }
            Ok(())
        }
        Some("integer") => {
            if !value.is_i64() && !value.is_u64() {
                return Err(schema_error(id, key, "must be integer"));
            }
            if let Some(minimum) = schema.get("minimum").and_then(Value::as_i64) {
                let actual = value.as_i64().or_else(|| value.as_u64().map(|v| v as i64));
                if actual.is_some_and(|actual| actual < minimum) {
                    return Err(schema_error(id, key, "is below minimum"));
                }
            }
            Ok(())
        }
        Some("array") => {
            let Some(items) = value.as_array() else {
                return Err(schema_error(id, key, "must be array"));
            };
            if items.len() > max_array_items {
                return Err(schema_error(id, key, "array item limit exceeded"));
            }
            Ok(())
        }
        Some("object") if !value.is_object() => Err(schema_error(id, key, "must be object")),
        _ => Ok(()),
    }
}

fn schema_error(id: &CapabilityId, key: &str, reason: &str) -> CapabilityRegistryError {
    CapabilityRegistryError::SchemaViolation {
        id: id.clone(),
        reason: format!("{key} {reason}"),
    }
}
