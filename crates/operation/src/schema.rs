use crate::OperationError;
use rho_contract::{CapabilityDescriptor, CapabilityRef, NextRead};
use serde_json::Value;
use std::collections::BTreeMap;

pub(crate) struct CapabilitySchemas {
    input: jsonschema::Validator,
    output: jsonschema::Validator,
    recovery: jsonschema::Validator,
}
fn compile(schema: &Value) -> Result<jsonschema::Validator, OperationError> {
    fn local_references(value: &Value, root: &Value) -> Result<(), OperationError> {
        match value {
            Value::Object(object) => {
                for (key, child) in object {
                    if key == "$ref" {
                        let reference = child.as_str().ok_or_else(|| OperationError::Contract("schema reference is not text".into()))?;
                        if !reference.starts_with("#/") || root.pointer(&reference[1..]).is_none() {
                            return Err(OperationError::Contract(format!("unresolved or non-local schema reference: {reference}")));
                        }
                    }
                    local_references(child, root)?;
                }
            }
            Value::Array(values) => for child in values { local_references(child, root)?; },
            _ => {}
        }
        Ok(())
    }
    local_references(schema, schema)?;
    jsonschema::options().offline().build(schema)
        .map_err(|error| OperationError::Contract(format!("invalid schema: {error}")))
}
impl CapabilitySchemas {
    pub(crate) fn new(descriptor: &CapabilityDescriptor) -> Result<Self, OperationError> {
        let input = compile(&descriptor.input_schema)?;
        let output = compile(&descriptor.output_schema)?;
        let recovery = compile(&descriptor.recovery_schema)?;
        for example in &descriptor.documentation.examples {
            input.validate(&example.arguments).map_err(|error| OperationError::Contract(format!("{} has invalid example: {error}", descriptor.capability.display_key())))?;
            if example.result_explanation.trim().is_empty() {
                return Err(OperationError::Contract("example lacks a result explanation".into()));
            }
        }
        Ok(Self { input, output, recovery })
    }
    pub(crate) fn input(&self, value: &Value) -> Result<(), OperationError> {
        self.input.validate(value).map_err(|error| OperationError::InvalidInput(error.to_string()))
    }
    pub(crate) fn output(&self, value: &Value) -> Result<(), OperationError> {
        self.output.validate(value).map_err(|error| OperationError::Contract(format!("owner output violates registered schema: {error}")))
    }
    pub(crate) fn recovery(&self, value: &Value) -> Result<(), OperationError> {
        self.recovery.validate(value).map_err(|error| OperationError::Contract(format!("owner recovery violates registered schema: {error}")))
    }
}

pub(crate) fn validate_reads(reads: &[NextRead], descriptors: &BTreeMap<CapabilityRef, CapabilityDescriptor>) -> Result<(), OperationError> {
    for read in reads {
        let descriptor = descriptors.get(&read.capability).ok_or_else(|| OperationError::Contract(format!("next read is not registered: {}", read.capability.display_key())))?;
        if descriptor.kind != rho_contract::CapabilityKind::Query {
            return Err(OperationError::Contract("next_reads may only identify read-only queries".into()));
        }
        if read.purpose.trim().is_empty() { return Err(OperationError::Contract("next read needs a purpose".into())); }
        if read.missing_identity_fields.is_empty() { compile(&descriptor.input_schema)?.validate(&read.arguments).map_err(|e|OperationError::Contract(format!("next read arguments: {e}")))?; }
    }
    Ok(())
}
