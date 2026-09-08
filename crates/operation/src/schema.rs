use crate::OperationError;
use rho_contract::{CapabilityDescriptor, NextRead};
use serde_json::Value;
use std::collections::BTreeSet;

pub(crate) struct CapabilitySchemas {
    input: jsonschema::Validator,
    partial_input: jsonschema::Validator,
    input_fields: BTreeSet<String>,
    output: jsonschema::Validator,
    recovery: jsonschema::Validator,
}
fn compile(schema: &Value) -> Result<jsonschema::Validator, OperationError> {
    fn refs(value: &Value, root: &Value) -> Result<(), OperationError> {
        if let Value::Object(object) = value {
            for key in ["$ref", "$dynamicRef", "$recursiveRef"] {
                if let Some(child) = object.get(key) {
                    let reference = child.as_str().ok_or_else(|| {
                        OperationError::Contract("schema reference is not text".into())
                    })?;
                    if reference != "#"
                        && (!reference.starts_with("#/") || root.pointer(&reference[1..]).is_none())
                    {
                        return Err(OperationError::Contract(format!(
                            "unresolved or non-local schema reference: {reference}"
                        )));
                    }
                }
            }
            for (key, child) in object {
                match key.as_str() {
                    "$defs" | "definitions" | "properties" | "patternProperties"
                    | "dependentSchemas" | "dependencies" => {
                        if let Some(children) = child.as_object() {
                            for schema in children.values() {
                                refs(schema, root)?;
                            }
                        }
                    }
                    "allOf" | "anyOf" | "oneOf" | "prefixItems" => {
                        if let Some(children) = child.as_array() {
                            for schema in children {
                                refs(schema, root)?;
                            }
                        }
                    }
                    "items"
                    | "additionalItems"
                    | "additionalProperties"
                    | "unevaluatedItems"
                    | "unevaluatedProperties"
                    | "contains"
                    | "not"
                    | "if"
                    | "then"
                    | "else"
                    | "propertyNames"
                    | "contentSchema" => refs(child, root)?,
                    _ => (),
                }
            }
        }
        Ok(())
    }
    refs(schema, schema)?;
    jsonschema::options()
        .offline()
        .build(schema)
        .map_err(|error| OperationError::Contract(format!("invalid schema: {error}")))
}
fn partial(mut schema: Value) -> Value {
    fn walk(value: &mut Value) {
        if let Value::Object(object) = value {
            object.remove("required");
            if let Some(variants) = object.remove("oneOf") {
                object.insert("anyOf".into(), variants);
            }
            for (key, child) in object {
                match key.as_str() {
                    "$defs" | "definitions" | "properties" | "patternProperties"
                    | "dependentSchemas" | "dependencies" => {
                        if let Some(children) = child.as_object_mut() {
                            for schema in children.values_mut() {
                                walk(schema);
                            }
                        }
                    }
                    "allOf" | "anyOf" | "prefixItems" => {
                        if let Some(children) = child.as_array_mut() {
                            for schema in children {
                                walk(schema);
                            }
                        }
                    }
                    "items"
                    | "additionalItems"
                    | "additionalProperties"
                    | "unevaluatedItems"
                    | "unevaluatedProperties"
                    | "contains"
                    | "not"
                    | "if"
                    | "then"
                    | "else"
                    | "propertyNames" => walk(child),
                    _ => (),
                }
            }
        }
    }
    walk(&mut schema);
    schema
}
fn fields(schema: &Value) -> BTreeSet<String> {
    fn walk(node: &Value, root: &Value, prefix: &str, depth: usize, found: &mut BTreeSet<String>) {
        if depth > 32 {
            return;
        }
        if let Some(reference) = node.get("$ref").and_then(Value::as_str) {
            if let Some(target) = reference.strip_prefix('#').and_then(|p| root.pointer(p)) {
                walk(target, root, prefix, depth + 1, found);
            }
        }
        if let Some(properties) = node.get("properties").and_then(Value::as_object) {
            for (name, child) in properties {
                let path = if prefix.is_empty() {
                    name.clone()
                } else {
                    format!("{prefix}.{name}")
                };
                found.insert(path.clone());
                walk(child, root, &path, depth + 1, found);
            }
        }
        for key in ["anyOf", "allOf", "oneOf"] {
            if let Some(variants) = node.get(key).and_then(Value::as_array) {
                for child in variants {
                    walk(child, root, prefix, depth + 1, found);
                }
            }
        }
    }
    let mut found = BTreeSet::new();
    walk(schema, schema, "", 0, &mut found);
    found
}
impl CapabilitySchemas {
    pub(crate) fn new(descriptor: &CapabilityDescriptor) -> Result<Self, OperationError> {
        let input = compile(&descriptor.input_schema)?;
        let partial_input = compile(&partial(descriptor.input_schema.clone()))?;
        let input_fields = fields(&descriptor.input_schema);
        let output = compile(&descriptor.output_schema)?;
        let recovery = compile(&descriptor.recovery_schema)?;
        for example in &descriptor.documentation.examples {
            input.validate(&example.arguments).map_err(|error| {
                OperationError::Contract(format!(
                    "{} has invalid example: {error}",
                    descriptor.capability.display_key()
                ))
            })?;
            if example.result_explanation.trim().is_empty() {
                return Err(OperationError::Contract(
                    "example lacks a result explanation".into(),
                ));
            }
        }
        Ok(Self {
            input,
            partial_input,
            input_fields,
            output,
            recovery,
        })
    }
    pub(crate) fn input(&self, value: &Value) -> Result<(), OperationError> {
        self.input
            .validate(value)
            .map_err(|error| OperationError::InvalidInput(error.to_string()))
    }
    pub(crate) fn output(&self, value: &Value) -> Result<(), OperationError> {
        self.output.validate(value).map_err(|error| {
            OperationError::Contract(format!("owner output violates registered schema: {error}"))
        })
    }
    pub(crate) fn recovery(&self, value: &Value) -> Result<(), OperationError> {
        self.recovery.validate(value).map_err(|error| {
            OperationError::Contract(format!(
                "owner recovery violates registered schema: {error}"
            ))
        })
    }
    pub(crate) fn read(&self, read: &NextRead) -> Result<(), OperationError> {
        if read.purpose.trim().is_empty() {
            return Err(OperationError::Contract("next read needs a purpose".into()));
        }
        if read.missing_identity_fields.is_empty() {
            return self
                .input(&read.arguments)
                .map_err(|e| OperationError::Contract(format!("next read arguments: {e}")));
        }
        for field in &read.missing_identity_fields {
            let pointer = format!(
                "/{}",
                field
                    .split('.')
                    .map(|part| part.replace('~', "~0").replace('/', "~1"))
                    .collect::<Vec<_>>()
                    .join("/")
            );
            if !self.input_fields.contains(field) || read.arguments.pointer(&pointer).is_some() {
                return Err(OperationError::Contract(format!(
                    "next read declares an invalid or already bound missing identity: {field}"
                )));
            }
        }
        self.partial_input
            .validate(&read.arguments)
            .map_err(|error| {
                OperationError::Contract(format!(
                    "bound next read arguments violate the input schema: {error}"
                ))
            })
    }
}
