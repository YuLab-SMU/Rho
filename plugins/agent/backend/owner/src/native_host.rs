//! Host tools keep the caller's fixed scope outside model-supplied arguments.
//! Native owners still validate their full schema and compare-and-swap fields.
use crate::AgentTaskError;
use serde_json::Value;
use std::collections::BTreeMap;

fn invalid(message: &str) -> AgentTaskError {
    AgentTaskError::InvalidInput(message.into())
}

/// Expose only the fields the model may supply. Preserve definitions, native
/// constraints and optional fields; a fixed branch is not a model parameter.
pub fn native_host_tool_schema(
    original: &Value,
    fixed: &BTreeMap<String, Value>,
) -> Result<Value, AgentTaskError> {
    let mut schema = original.clone();
    if schema["type"] != "object" {
        return Err(invalid("Host tools require an object input contract"));
    }
    if fixed.is_empty() {
        return Ok(schema);
    }
    let properties = schema
        .get_mut("properties")
        .and_then(Value::as_object_mut)
        .ok_or_else(|| invalid("Host tool input properties are unavailable"))?;
    for name in fixed.keys() {
        if properties.remove(name).is_none() {
            return Err(invalid(
                "A fixed Host argument is outside its native contract",
            ));
        }
    }
    if let Some(required) = schema.get_mut("required") {
        let required = required
            .as_array_mut()
            .ok_or_else(|| invalid("Invalid required Host input fields"))?;
        if required.iter().any(|value| !value.is_string()) {
            return Err(invalid("Invalid required Host input field"));
        }
        required.retain(|value| !fixed.contains_key(value.as_str().unwrap()));
    }
    Ok(schema)
}

/// Build the exact request before durable admission. Model input cannot replace
/// any fixed value, even with an identical copy. Native Host preconditions live
/// in its declared arguments; plugin-provider preconditions do not apply here.
pub fn native_host_tool_arguments(
    fixed: &BTreeMap<String, Value>,
    arguments: &Value,
    preconditions: &Value,
) -> Result<Value, AgentTaskError> {
    if !preconditions.is_null() {
        return Err(invalid(
            "Host tools use only their declared native preconditions",
        ));
    }
    let mut arguments = arguments
        .as_object()
        .cloned()
        .ok_or_else(|| invalid("Host tool arguments must be an object"))?;
    for (name, value) in fixed {
        if arguments.contains_key(name) {
            return Err(invalid(
                "Model arguments cannot replace a captured Host field",
            ));
        }
        arguments.insert(name.clone(), value.clone());
    }
    Ok(Value::Object(arguments))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn branch_is_captured_outside_model_input_while_native_cas_remains_required() {
        let schema = json!({"type":"object","additionalProperties":false,
            "$defs":{"Revision":{"type":"string","pattern":"^sha256:"}},
            "properties":{"branch":{"type":"string"},"expected_head":{"$ref":"#/$defs/Revision"},
                "changes":{"type":"object"},"note":{"type":"string"}},
            "required":["branch","expected_head","changes"]});
        let fixed = BTreeMap::from([("branch".into(), json!("chosen-branch"))]);
        let model_schema = native_host_tool_schema(&schema, &fixed).unwrap();
        assert!(model_schema["properties"].get("branch").is_none());
        assert_eq!(
            model_schema["required"],
            json!(["expected_head", "changes"])
        );
        assert_eq!(model_schema["$defs"], schema["$defs"]);
        assert_eq!(
            model_schema["properties"]["note"],
            schema["properties"]["note"]
        );
        assert_eq!(model_schema["additionalProperties"], false);
        let model_input = json!({"expected_head":"sha256:original","changes":{}});
        assert_eq!(
            native_host_tool_arguments(&fixed, &model_input, &Value::Null).unwrap(),
            json!({"branch":"chosen-branch","expected_head":"sha256:original","changes":{}})
        );
        assert!(model_input.get("branch").is_none());
        assert!(schema["properties"].get("branch").is_some());
        for branch in ["chosen-branch", "another-branch"] {
            assert!(
                native_host_tool_arguments(&fixed, &json!({"branch":branch}), &Value::Null)
                    .is_err()
            );
        }
        assert!(native_host_tool_arguments(&fixed, &json!({}), &json!([])).is_err());
        assert!(native_host_tool_arguments(&fixed, &json!([]), &Value::Null).is_err());
    }

    #[test]
    fn unknown_fixed_fields_and_non_object_contracts_are_not_reinterpreted() {
        let fixed = BTreeMap::from([("branch".into(), json!("chosen-branch"))]);
        for schema in [
            json!({"type":"array"}),
            json!({"type":"object"}),
            json!({"type":"object","properties":{"project":{"type":"string"}}}),
        ] {
            assert!(native_host_tool_schema(&schema, &fixed).is_err());
        }
        let schema = json!({"type":"object","properties":{},"additionalProperties":false});
        assert_eq!(
            native_host_tool_schema(&schema, &BTreeMap::new()).unwrap(),
            schema
        );
        let empty = json!({"type":"object","additionalProperties":false});
        assert_eq!(
            native_host_tool_schema(&empty, &BTreeMap::new()).unwrap(),
            empty
        );
        assert_eq!(
            native_host_tool_arguments(&BTreeMap::new(), &json!({}), &Value::Null).unwrap(),
            json!({})
        );
    }
}
