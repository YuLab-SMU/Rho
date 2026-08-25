use std::collections::BTreeSet;
use std::fmt::{self, Display};

use serde::{Deserialize, Deserializer, Serialize, de};
use serde_json::Value;
use thiserror::Error;

/// Export a bounded Rust integer as Rho's existing JSON/TypeScript `number`.
///
/// This affects generated metadata only. Serde keeps the original integer and
/// each transported field must independently preserve JavaScript's exact range.
pub struct UiIpcNumber;

impl specta::Type for UiIpcNumber {
    fn definition(types: &mut specta::Types) -> specta::datatype::DataType {
        <i32 as specta::Type>::definition(types)
    }
}

/// Export an intentionally opaque JSON payload as TypeScript `unknown`.
///
/// This keeps exporter-only metadata in the contract crate instead of making
/// production callers depend directly on a language-specific generator.
pub struct UiIpcUnknown;

impl specta::Type for UiIpcUnknown {
    fn definition(types: &mut specta::Types) -> specta::datatype::DataType {
        <specta_typescript::Unknown as specta::Type>::definition(types)
    }
}

pub const MAX_ID_BYTES: usize = 128;
pub const MAX_LABEL_BYTES: usize = 512;
pub const MAX_PURPOSE_BYTES: usize = 2 * 1024;
pub const MAX_OPAQUE_TEXT_BYTES: usize = 4 * 1024;
pub const MAX_ICON_BYTES: usize = 32;
pub const MAX_BOUNDED_JSON_DEPTH: usize = 16;
pub const MAX_BOUNDED_JSON_NODES: usize = 4_096;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Error)]
#[serde(tag = "code", rename_all = "snake_case")]
pub enum ContractError {
    #[error("invalid identifier at {path}: {reason}")]
    InvalidIdentifier { path: String, reason: String },
    #[error("invalid value at {path}: {reason}")]
    InvalidValue { path: String, reason: String },
    #[error("{path} exceeds its limit: {actual} > {limit}")]
    LimitExceeded {
        path: String,
        limit: usize,
        actual: usize,
    },
    #[error("duplicate value at {path}: {value}")]
    Duplicate { path: String, value: String },
    #[error("missing reference at {path}: {value}")]
    MissingReference { path: String, value: String },
    #[error("stale revision at {path}: expected {expected}, actual {actual}")]
    StaleRevision {
        path: String,
        expected: u64,
        actual: u64,
    },
    #[error("serialization failed at {path}: {reason}")]
    Serialization { path: String, reason: String },
}

pub trait Validate {
    fn validate(&self) -> Result<(), ContractError>;
}

fn valid_id_character(character: char, first: bool) -> bool {
    character.is_ascii_alphanumeric() || (!first && matches!(character, '.' | '_' | '-' | ':'))
}

pub fn validate_id(value: &str, path: &str) -> Result<(), ContractError> {
    if value.is_empty() {
        return Err(ContractError::InvalidIdentifier {
            path: path.to_string(),
            reason: "identifier is empty".to_string(),
        });
    }
    if value.len() > MAX_ID_BYTES {
        return Err(ContractError::LimitExceeded {
            path: path.to_string(),
            limit: MAX_ID_BYTES,
            actual: value.len(),
        });
    }
    if let Some((index, character)) = value
        .chars()
        .enumerate()
        .find(|(index, character)| !valid_id_character(*character, *index == 0))
    {
        return Err(ContractError::InvalidIdentifier {
            path: path.to_string(),
            reason: format!("unsupported character {character:?} at scalar index {index}"),
        });
    }
    Ok(())
}

pub fn validate_text(
    value: &str,
    path: &str,
    maximum_bytes: usize,
    allow_empty: bool,
    allow_line_breaks: bool,
) -> Result<(), ContractError> {
    if !allow_empty && value.is_empty() {
        return Err(ContractError::InvalidValue {
            path: path.to_string(),
            reason: "text is empty".to_string(),
        });
    }
    if value.len() > maximum_bytes {
        return Err(ContractError::LimitExceeded {
            path: path.to_string(),
            limit: maximum_bytes,
            actual: value.len(),
        });
    }
    if value.chars().any(|character| {
        character.is_control() && !(allow_line_breaks && matches!(character, '\n' | '\r' | '\t'))
    }) {
        return Err(ContractError::InvalidValue {
            path: path.to_string(),
            reason: "text contains an unsupported control character".to_string(),
        });
    }
    if value.chars().any(is_bidi_control) {
        return Err(ContractError::InvalidValue {
            path: path.to_string(),
            reason: "text contains an explicit bidirectional control character".to_string(),
        });
    }
    Ok(())
}

fn is_bidi_control(character: char) -> bool {
    matches!(
        character,
        '\u{061c}'
            | '\u{200e}'
            | '\u{200f}'
            | '\u{202a}'..='\u{202e}'
            | '\u{2066}'..='\u{2069}'
    )
}

pub fn validate_label(value: &str, path: &str) -> Result<(), ContractError> {
    validate_text(value, path, MAX_LABEL_BYTES, false, false)
}

pub fn validate_purpose(value: &str, path: &str) -> Result<(), ContractError> {
    validate_text(value, path, MAX_PURPOSE_BYTES, false, true)
}

pub fn validate_opaque_text(value: &str, path: &str) -> Result<(), ContractError> {
    validate_text(value, path, MAX_OPAQUE_TEXT_BYTES, false, false)
}

pub fn validate_icon(value: &str, path: &str) -> Result<(), ContractError> {
    validate_text(value, path, MAX_ICON_BYTES, false, false)
}

pub fn ensure_revision(path: &str, expected: u64, actual: u64) -> Result<(), ContractError> {
    if expected != actual {
        return Err(ContractError::StaleRevision {
            path: path.to_string(),
            expected,
            actual,
        });
    }
    Ok(())
}

pub fn next_revision(path: &str, revision: u64) -> Result<u64, ContractError> {
    revision
        .checked_add(1)
        .ok_or_else(|| ContractError::InvalidValue {
            path: path.to_string(),
            reason: "revision overflow".to_string(),
        })
}

pub fn validate_unique<'a>(
    path: &str,
    values: impl IntoIterator<Item = &'a str>,
) -> Result<(), ContractError> {
    let mut seen = BTreeSet::new();
    for value in values {
        if !seen.insert(value) {
            return Err(ContractError::Duplicate {
                path: path.to_string(),
                value: value.to_string(),
            });
        }
    }
    Ok(())
}

pub fn encoded_json_len<T: Serialize>(path: &str, value: &T) -> Result<usize, ContractError> {
    serde_json::to_vec(value)
        .map(|encoded| encoded.len())
        .map_err(|error| ContractError::Serialization {
            path: path.to_string(),
            reason: error.to_string(),
        })
}

pub fn validate_json_value(
    path: &str,
    value: &Value,
    maximum_bytes: usize,
) -> Result<(), ContractError> {
    let encoded = encoded_json_len(path, value)?;
    if encoded > maximum_bytes {
        return Err(ContractError::LimitExceeded {
            path: path.to_string(),
            limit: maximum_bytes,
            actual: encoded,
        });
    }
    fn walk(
        path: &str,
        value: &Value,
        depth: usize,
        nodes: &mut usize,
    ) -> Result<(), ContractError> {
        if depth > MAX_BOUNDED_JSON_DEPTH {
            return Err(ContractError::LimitExceeded {
                path: format!("{path}.depth"),
                limit: MAX_BOUNDED_JSON_DEPTH,
                actual: depth,
            });
        }
        *nodes += 1;
        if *nodes > MAX_BOUNDED_JSON_NODES {
            return Err(ContractError::LimitExceeded {
                path: format!("{path}.nodes"),
                limit: MAX_BOUNDED_JSON_NODES,
                actual: *nodes,
            });
        }
        match value {
            Value::Array(values) => {
                for child in values {
                    walk(path, child, depth + 1, nodes)?;
                }
            }
            Value::Object(values) => {
                for child in values.values() {
                    walk(path, child, depth + 1, nodes)?;
                }
            }
            _ => {}
        }
        Ok(())
    }
    walk(path, value, 1, &mut 0)
}

macro_rules! bounded_id {
    ($name:ident, $path:literal) => {
        #[derive(Debug, Clone, Hash, PartialEq, Eq, PartialOrd, Ord, Serialize, specta::Type)]
        #[serde(transparent)]
        pub struct $name(String);

        impl $name {
            pub fn new(value: impl Into<String>) -> Result<Self, ContractError> {
                let value = value.into();
                validate_id(&value, $path)?;
                Ok(Self(value))
            }

            pub fn as_str(&self) -> &str {
                &self.0
            }
        }

        impl Display for $name {
            fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
                formatter.write_str(&self.0)
            }
        }

        impl AsRef<str> for $name {
            fn as_ref(&self) -> &str {
                self.as_str()
            }
        }

        impl<'de> Deserialize<'de> for $name {
            fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
            where
                D: Deserializer<'de>,
            {
                let value = String::deserialize(deserializer)?;
                Self::new(value).map_err(de::Error::custom)
            }
        }
    };
}

bounded_id!(ProjectId, "project_id");
bounded_id!(SurfaceId, "surface_id");
bounded_id!(SurfaceInstanceId, "surface_instance_id");
bounded_id!(SurfaceModeId, "surface_mode_id");
bounded_id!(PluginId, "plugin_id");
bounded_id!(PackageDigest, "package_digest");
bounded_id!(ApplicationComponentId, "application_component_id");
bounded_id!(ResourceProviderId, "resource_provider_id");
bounded_id!(ResourceKindId, "resource_kind_id");
bounded_id!(ResourceCapabilityId, "resource_capability_id");
bounded_id!(RuntimeProviderId, "runtime_provider_id");
bounded_id!(RuntimeInstanceId, "runtime_instance_id");
bounded_id!(RuntimeKindId, "runtime_kind_id");
bounded_id!(RuntimeCapabilityId, "runtime_capability_id");
bounded_id!(CommandId, "command_id");
bounded_id!(PredicateId, "predicate_id");
bounded_id!(OperationId, "operation_id");
bounded_id!(SceneId, "scene_id");
bounded_id!(ScenePresetId, "scene_preset_id");
bounded_id!(LayoutNodeId, "layout_node_id");
bounded_id!(PageId, "page_id");
bounded_id!(SectionId, "section_id");
bounded_id!(BlockId, "block_id");
bounded_id!(ViewGroupId, "view_group_id");
bounded_id!(CheckSnapshotId, "check_snapshot_id");
bounded_id!(CheckResultId, "check_result_id");
bounded_id!(CheckRuleId, "check_rule_id");

#[cfg(test)]
mod tests {
    use super::*;
    use proptest::prelude::*;

    proptest! {
        #[test]
        fn accepted_ascii_ids_round_trip(body in "[a-zA-Z0-9][a-zA-Z0-9._:-]{0,63}") {
            let id = SurfaceId::new(body.clone()).unwrap();
            let encoded = serde_json::to_string(&id).unwrap();
            let decoded: SurfaceId = serde_json::from_str(&encoded).unwrap();
            prop_assert_eq!(decoded.as_str(), body);
        }
    }

    #[test]
    fn identifiers_reject_control_unicode_and_over_limit_values() {
        for value in ["", "bad id", "bad\n", "界"] {
            assert!(SurfaceId::new(value).is_err(), "{value:?}");
        }
        assert!(SurfaceId::new("x".repeat(MAX_ID_BYTES)).is_ok());
        assert!(SurfaceId::new("x".repeat(MAX_ID_BYTES + 1)).is_err());
        assert!(serde_json::from_str::<SurfaceId>("\"bad id\"").is_err());
        assert!(validate_label("safe\u{202e}spoof", "label").is_err());
    }

    #[test]
    fn labels_accept_natural_rtl_and_multilingual_text_without_direction_overrides() {
        for value in ["مرحبا بالعالم", "שלום עולם", "分析结果 🧬"] {
            assert!(validate_label(value, "label").is_ok(), "{value:?}");
        }
    }

    #[test]
    fn bounded_json_rejects_depth_and_byte_overflow() {
        let mut deep = Value::Null;
        for _ in 0..=MAX_BOUNDED_JSON_DEPTH {
            deep = serde_json::json!([deep]);
        }
        assert!(validate_json_value("value", &deep, usize::MAX).is_err());
        let large = serde_json::json!({"value": "x".repeat(64)});
        assert!(validate_json_value("value", &large, 16).is_err());
    }
}
