//! Bounded, non-executable JSON-schema subset for third-party contributions.
//!
//! The subset is intentionally closed. It has no references, formats,
//! regular expressions, defaults, conditionals, or extension keywords, so
//! validation never performs I/O or evaluates plugin-controlled code.

use std::fmt;

use serde::{Deserialize, Deserializer, Serialize};
use serde_json::{Map, Value};

pub const MAX_CONTRIBUTION_SCHEMA_BYTES: usize = 64 * 1024;
pub const MAX_CONTRIBUTION_SCHEMA_DEPTH: usize = 8;
pub const MAX_CONTRIBUTION_SCHEMA_PROPERTIES: usize = 128;
pub const MAX_CONTRIBUTION_SCHEMA_ENUM_VALUES: usize = 128;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct JsonSchemaError {
    reason: String,
}

impl JsonSchemaError {
    fn new(reason: impl Into<String>) -> Self {
        Self {
            reason: reason.into(),
        }
    }

    pub fn reason(&self) -> &str {
        &self.reason
    }
}

impl fmt::Display for JsonSchemaError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.reason)
    }
}

impl std::error::Error for JsonSchemaError {}

/// A schema that has already passed the closed Rho contribution-schema
/// grammar and all aggregate bounds.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(transparent)]
pub struct BoundedJsonSchema(Value);

impl BoundedJsonSchema {
    pub fn new(value: Value) -> Result<Self, JsonSchemaError> {
        let encoded = serde_json::to_vec(&value)
            .map_err(|error| JsonSchemaError::new(format!("cannot encode schema: {error}")))?;
        if encoded.len() > MAX_CONTRIBUTION_SCHEMA_BYTES {
            return Err(JsonSchemaError::new(format!(
                "schema exceeds {MAX_CONTRIBUTION_SCHEMA_BYTES} bytes"
            )));
        }

        let mut budget = SchemaBudget::default();
        validate_schema_node(&value, 1, &mut budget)?;
        Ok(Self(value))
    }

    pub fn value(&self) -> &Value {
        &self.0
    }

    /// Validate a contribution call value. Object schemas are closed: fields
    /// not declared in `properties` are rejected.
    pub fn validate_instance(&self, value: &Value) -> Result<(), JsonSchemaError> {
        validate_instance_node(&self.0, value, "$", 1)
    }
}

impl TryFrom<Value> for BoundedJsonSchema {
    type Error = JsonSchemaError;

    fn try_from(value: Value) -> Result<Self, Self::Error> {
        Self::new(value)
    }
}

impl<'de> Deserialize<'de> for BoundedJsonSchema {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let value = Value::deserialize(deserializer)?;
        Self::new(value).map_err(serde::de::Error::custom)
    }
}

#[derive(Debug, Default)]
struct SchemaBudget {
    properties: usize,
    enum_values: usize,
}

fn validate_schema_node(
    value: &Value,
    depth: usize,
    budget: &mut SchemaBudget,
) -> Result<(), JsonSchemaError> {
    if depth > MAX_CONTRIBUTION_SCHEMA_DEPTH {
        return Err(JsonSchemaError::new(format!(
            "schema depth exceeds {MAX_CONTRIBUTION_SCHEMA_DEPTH}"
        )));
    }
    let object = value
        .as_object()
        .ok_or_else(|| JsonSchemaError::new("every schema node must be an object"))?;
    for key in object.keys() {
        if !matches!(
            key.as_str(),
            "type"
                | "required"
                | "properties"
                | "items"
                | "enum"
                | "minimum"
                | "maximum"
                | "minLength"
                | "maxLength"
                | "minItems"
                | "maxItems"
        ) {
            return Err(JsonSchemaError::new(format!(
                "unsupported schema keyword: {key}"
            )));
        }
    }

    let schema_type = object
        .get("type")
        .and_then(Value::as_str)
        .ok_or_else(|| JsonSchemaError::new("schema type must be one string"))?;
    if !matches!(
        schema_type,
        "object" | "array" | "string" | "number" | "integer" | "boolean" | "null"
    ) {
        return Err(JsonSchemaError::new(format!(
            "unsupported schema type: {schema_type}"
        )));
    }

    validate_keyword_ownership(object, schema_type)?;
    match schema_type {
        "object" => validate_object_schema(object, depth, budget)?,
        "array" => {
            let items = object
                .get("items")
                .ok_or_else(|| JsonSchemaError::new("array schema requires items"))?;
            validate_schema_node(items, depth + 1, budget)?;
            validate_unsigned_bounds(object, "minItems", "maxItems")?;
        }
        "string" => validate_unsigned_bounds(object, "minLength", "maxLength")?,
        "number" | "integer" => validate_numeric_bounds(object)?,
        "boolean" | "null" => {}
        _ => unreachable!(),
    }

    if let Some(values) = object.get("enum") {
        let values = values
            .as_array()
            .ok_or_else(|| JsonSchemaError::new("enum must be an array"))?;
        if values.is_empty() {
            return Err(JsonSchemaError::new("enum must not be empty"));
        }
        budget.enum_values = budget
            .enum_values
            .checked_add(values.len())
            .ok_or_else(|| JsonSchemaError::new("schema enum budget overflow"))?;
        if budget.enum_values > MAX_CONTRIBUTION_SCHEMA_ENUM_VALUES {
            return Err(JsonSchemaError::new(format!(
                "schema enum values exceed {MAX_CONTRIBUTION_SCHEMA_ENUM_VALUES}"
            )));
        }
        for item in values {
            if !value_matches_type(item, schema_type) {
                return Err(JsonSchemaError::new(format!(
                    "enum value does not match schema type {schema_type}"
                )));
            }
        }
    }
    Ok(())
}

fn validate_keyword_ownership(
    object: &Map<String, Value>,
    schema_type: &str,
) -> Result<(), JsonSchemaError> {
    for (keyword, owner) in [
        ("required", "object"),
        ("properties", "object"),
        ("items", "array"),
        ("minLength", "string"),
        ("maxLength", "string"),
        ("minItems", "array"),
        ("maxItems", "array"),
    ] {
        if object.contains_key(keyword) && schema_type != owner {
            return Err(JsonSchemaError::new(format!(
                "{keyword} is valid only for {owner} schemas"
            )));
        }
    }
    if (object.contains_key("minimum") || object.contains_key("maximum"))
        && !matches!(schema_type, "number" | "integer")
    {
        return Err(JsonSchemaError::new(
            "minimum/maximum are valid only for numeric schemas",
        ));
    }
    Ok(())
}

fn validate_object_schema(
    object: &Map<String, Value>,
    depth: usize,
    budget: &mut SchemaBudget,
) -> Result<(), JsonSchemaError> {
    let properties = object
        .get("properties")
        .and_then(Value::as_object)
        .ok_or_else(|| JsonSchemaError::new("object schema requires properties"))?;
    budget.properties = budget
        .properties
        .checked_add(properties.len())
        .ok_or_else(|| JsonSchemaError::new("schema property budget overflow"))?;
    if budget.properties > MAX_CONTRIBUTION_SCHEMA_PROPERTIES {
        return Err(JsonSchemaError::new(format!(
            "schema properties exceed {MAX_CONTRIBUTION_SCHEMA_PROPERTIES}"
        )));
    }
    for (name, schema) in properties {
        if name.is_empty()
            || name.len() > crate::MAX_IDENTIFIER_BYTES
            || name.chars().any(char::is_control)
            || contains_bidi_override(name)
        {
            return Err(JsonSchemaError::new(
                "schema property name is empty, oversized, or unsafe",
            ));
        }
        validate_schema_node(schema, depth + 1, budget)?;
    }

    let required = object
        .get("required")
        .map(|value| {
            value
                .as_array()
                .ok_or_else(|| JsonSchemaError::new("required must be an array"))
        })
        .transpose()?
        .map(Vec::as_slice)
        .unwrap_or_default();
    let mut seen = std::collections::BTreeSet::new();
    for item in required {
        let name = item
            .as_str()
            .ok_or_else(|| JsonSchemaError::new("required entries must be strings"))?;
        if !properties.contains_key(name) {
            return Err(JsonSchemaError::new(format!(
                "required property is undeclared: {name}"
            )));
        }
        if !seen.insert(name) {
            return Err(JsonSchemaError::new(format!(
                "duplicate required property: {name}"
            )));
        }
    }
    Ok(())
}

fn validate_unsigned_bounds(
    object: &Map<String, Value>,
    minimum_key: &str,
    maximum_key: &str,
) -> Result<(), JsonSchemaError> {
    let minimum = object
        .get(minimum_key)
        .map(|value| {
            value
                .as_u64()
                .ok_or_else(|| JsonSchemaError::new(format!("{minimum_key} must be an integer")))
        })
        .transpose()?;
    let maximum = object
        .get(maximum_key)
        .map(|value| {
            value
                .as_u64()
                .ok_or_else(|| JsonSchemaError::new(format!("{maximum_key} must be an integer")))
        })
        .transpose()?;
    if matches!((minimum, maximum), (Some(minimum), Some(maximum)) if minimum > maximum) {
        return Err(JsonSchemaError::new(format!(
            "{minimum_key} must not exceed {maximum_key}"
        )));
    }
    Ok(())
}

fn validate_numeric_bounds(object: &Map<String, Value>) -> Result<(), JsonSchemaError> {
    let minimum = object
        .get("minimum")
        .map(|value| {
            value
                .as_f64()
                .ok_or_else(|| JsonSchemaError::new("minimum must be a finite JSON number"))
        })
        .transpose()?;
    let maximum = object
        .get("maximum")
        .map(|value| {
            value
                .as_f64()
                .ok_or_else(|| JsonSchemaError::new("maximum must be a finite JSON number"))
        })
        .transpose()?;
    if matches!((minimum, maximum), (Some(minimum), Some(maximum)) if minimum > maximum) {
        return Err(JsonSchemaError::new("minimum must not exceed maximum"));
    }
    Ok(())
}

fn validate_instance_node(
    schema: &Value,
    value: &Value,
    path: &str,
    depth: usize,
) -> Result<(), JsonSchemaError> {
    if depth > MAX_CONTRIBUTION_SCHEMA_DEPTH {
        return Err(JsonSchemaError::new("instance depth exceeds schema budget"));
    }
    let object = schema
        .as_object()
        .ok_or_else(|| JsonSchemaError::new("validated schema node is not an object"))?;
    let schema_type = object
        .get("type")
        .and_then(Value::as_str)
        .ok_or_else(|| JsonSchemaError::new("validated schema has no type"))?;
    if !value_matches_type(value, schema_type) {
        return Err(JsonSchemaError::new(format!(
            "{path} does not match type {schema_type}"
        )));
    }
    if let Some(allowed) = object.get("enum").and_then(Value::as_array)
        && !allowed.contains(value)
    {
        return Err(JsonSchemaError::new(format!("{path} is not in enum")));
    }

    match schema_type {
        "object" => {
            let value = value.as_object().expect("type checked above");
            let properties = object
                .get("properties")
                .and_then(Value::as_object)
                .expect("schema validated above");
            if let Some(unknown) = value.keys().find(|key| !properties.contains_key(*key)) {
                return Err(JsonSchemaError::new(format!(
                    "{path} contains undeclared property {unknown}"
                )));
            }
            if let Some(required) = object.get("required").and_then(Value::as_array) {
                for name in required.iter().filter_map(Value::as_str) {
                    if !value.contains_key(name) {
                        return Err(JsonSchemaError::new(format!(
                            "{path} is missing required property {name}"
                        )));
                    }
                }
            }
            for (name, child) in value {
                let child_schema = properties.get(name).expect("unknown fields rejected");
                validate_instance_node(child_schema, child, &format!("{path}.{name}"), depth + 1)?;
            }
        }
        "array" => {
            let values = value.as_array().expect("type checked above");
            validate_length_bounds(object, values.len(), "minItems", "maxItems", path)?;
            let items = object.get("items").expect("schema validated above");
            for (index, child) in values.iter().enumerate() {
                validate_instance_node(items, child, &format!("{path}[{index}]"), depth + 1)?;
            }
        }
        "string" => {
            let length = value.as_str().expect("type checked above").chars().count();
            validate_length_bounds(object, length, "minLength", "maxLength", path)?;
        }
        "number" | "integer" => {
            let number = value.as_f64().expect("type checked above");
            if object
                .get("minimum")
                .and_then(Value::as_f64)
                .is_some_and(|minimum| number < minimum)
                || object
                    .get("maximum")
                    .and_then(Value::as_f64)
                    .is_some_and(|maximum| number > maximum)
            {
                return Err(JsonSchemaError::new(format!(
                    "{path} is outside numeric bounds"
                )));
            }
        }
        "boolean" | "null" => {}
        _ => unreachable!(),
    }
    Ok(())
}

fn validate_length_bounds(
    schema: &Map<String, Value>,
    actual: usize,
    minimum_key: &str,
    maximum_key: &str,
    path: &str,
) -> Result<(), JsonSchemaError> {
    let actual = actual as u64;
    if schema
        .get(minimum_key)
        .and_then(Value::as_u64)
        .is_some_and(|minimum| actual < minimum)
        || schema
            .get(maximum_key)
            .and_then(Value::as_u64)
            .is_some_and(|maximum| actual > maximum)
    {
        return Err(JsonSchemaError::new(format!(
            "{path} is outside length bounds"
        )));
    }
    Ok(())
}

fn value_matches_type(value: &Value, schema_type: &str) -> bool {
    match schema_type {
        "object" => value.is_object(),
        "array" => value.is_array(),
        "string" => value.is_string(),
        "number" => value.is_number(),
        "integer" => value.as_i64().is_some() || value.as_u64().is_some(),
        "boolean" => value.is_boolean(),
        "null" => value.is_null(),
        _ => false,
    }
}

fn contains_bidi_override(value: &str) -> bool {
    value.chars().any(|character| {
        matches!(
            character,
            '\u{061c}'
                | '\u{200e}'
                | '\u{200f}'
                | '\u{202a}'..='\u{202e}'
                | '\u{2066}'..='\u{2069}'
        )
    })
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn validates_closed_schema_and_instances() {
        let schema = BoundedJsonSchema::new(json!({
            "type": "object",
            "properties": {
                "path": {"type": "string", "minLength": 1, "maxLength": 20},
                "limit": {"type": "integer", "minimum": 1, "maximum": 10}
            },
            "required": ["path"]
        }))
        .unwrap();
        assert!(
            schema
                .validate_instance(&json!({"path": "data.csv", "limit": 2}))
                .is_ok()
        );
        assert!(
            schema
                .validate_instance(&json!({"path": "data.csv", "extra": true}))
                .is_err()
        );
        assert!(schema.validate_instance(&json!({"limit": 2})).is_err());
        assert!(
            schema
                .validate_instance(&json!({"path": "data.csv", "limit": 11}))
                .is_err()
        );
    }

    #[test]
    fn rejects_executable_remote_and_unknown_keywords() {
        for keyword in ["$ref", "pattern", "format", "default", "allOf"] {
            let mut schema = json!({"type": "string"});
            schema
                .as_object_mut()
                .unwrap()
                .insert(keyword.to_string(), json!("https://example.org/schema"));
            assert!(
                BoundedJsonSchema::new(schema).is_err(),
                "accepted {keyword}"
            );
        }
    }

    #[test]
    fn rejects_depth_property_enum_and_byte_bombs() {
        let mut deep = json!({"type": "string"});
        for _ in 0..MAX_CONTRIBUTION_SCHEMA_DEPTH {
            deep = json!({"type": "array", "items": deep});
        }
        assert!(BoundedJsonSchema::new(deep).is_err());

        let properties = (0..=MAX_CONTRIBUTION_SCHEMA_PROPERTIES)
            .map(|index| (format!("p{index}"), json!({"type": "null"})))
            .collect::<Map<_, _>>();
        assert!(
            BoundedJsonSchema::new(json!({
                "type": "object",
                "properties": properties
            }))
            .is_err()
        );

        let values = (0..=MAX_CONTRIBUTION_SCHEMA_ENUM_VALUES).collect::<Vec<_>>();
        assert!(BoundedJsonSchema::new(json!({"type": "integer", "enum": values})).is_err());

        assert!(
            BoundedJsonSchema::new(json!({
                "type": "string",
                "enum": ["x".repeat(MAX_CONTRIBUTION_SCHEMA_BYTES)]
            }))
            .is_err()
        );
    }

    #[test]
    fn rejects_malformed_or_misowned_bounds() {
        for schema in [
            json!({"type": ["string", "null"]}),
            json!({"type": "object"}),
            json!({"type": "array"}),
            json!({"type": "string", "minimum": 1}),
            json!({"type": "number", "minLength": 1}),
            json!({"type": "string", "minLength": 2, "maxLength": 1}),
            json!({"type": "object", "properties": {}, "required": ["missing"]}),
            json!({"type": "integer", "enum": [1.5]}),
        ] {
            assert!(BoundedJsonSchema::new(schema).is_err());
        }
    }
}
