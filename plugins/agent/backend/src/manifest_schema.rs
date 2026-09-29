//! Compact generated contracts without weakening validation or changing literals.
//! Capability descriptions remain the public documentation; repeated Rust type
//! annotations and long local definition names need not consume package space.
use serde_json::Value;
use std::collections::BTreeMap;

pub(super) fn compact(mut schema: Value) -> Value {
    let names: BTreeMap<_, _> = schema
        .get("$defs")
        .and_then(Value::as_object)
        .into_iter()
        .flat_map(|definitions| definitions.keys())
        .enumerate()
        .map(|(index, name)| (format!("#/$defs/{name}"), format!("#/$defs/d{index}")))
        .collect();
    fn visit(value: &mut Value, names: &BTreeMap<String, String>) {
        match value {
            Value::Array(values) => values.iter_mut().for_each(|value| visit(value, names)),
            Value::Object(object) => {
                for annotation in ["title", "description"] {
                    if object.get(annotation).is_some_and(Value::is_string) {
                        object.remove(annotation);
                    }
                }
                if let Some(reference) = object.get_mut("$ref") {
                    if let Some(replacement) = reference.as_str().and_then(|name| names.get(name)) {
                        *reference = Value::String(replacement.clone());
                    }
                }
                for (key, value) in object.iter_mut() {
                    if matches!(
                        key.as_str(),
                        "$defs"
                            | "definitions"
                            | "properties"
                            | "patternProperties"
                            | "dependentSchemas"
                            | "dependencies"
                    ) {
                        // Keys here are user/type names, even when they happen
                        // to be "default", "enum", "title" or "$ref".
                        if let Value::Object(schemas) = value {
                            for schema in schemas.values_mut() {
                                visit(schema, names);
                            }
                        }
                        continue;
                    }
                    // These values are application data, not schemas. In
                    // particular a default may contain literal "$ref" text.
                    if !matches!(key.as_str(), "const" | "default" | "enum" | "examples") {
                        visit(value, names);
                    }
                }
            }
            _ => {}
        }
    }
    visit(&mut schema, &names);
    if let Some(Value::Object(definitions)) = schema.get_mut("$defs") {
        *definitions = std::mem::take(definitions)
            .into_iter()
            .map(|(name, value)| (names[&format!("#/$defs/{name}")][8..].into(), value))
            .collect();
    }
    schema
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn compact_contract_preserves_fields_constraints_references_and_literal_values() {
        let literal = json!({"title":"Kept","description":"Kept","$ref":"#/$defs/LongType"});
        let schema = json!({
            "$schema":"https://json-schema.org/draft/2020-12/schema",
            "title":"Generated", "description":"Generated documentation",
            "type":"object", "additionalProperties":false,
            "$defs":{"LongType":{"type":"string","minLength":1,"maxLength":8}},
            "properties":{
                "title":{"$ref":"#/$defs/LongType"},
                "description":{"type":"string"},
                "$ref":{"type":"string"},
                "default":{"$ref":"#/$defs/LongType"},
                "enum":{"$ref":"#/$defs/LongType"},
                "value":{"oneOf":[{"const":literal},{"enum":[literal]}],"default":literal,"examples":[literal]}
            },
            "required":["title","description","$ref","value"]
        });
        let mut expected = schema.clone();
        expected.as_object_mut().unwrap().remove("title");
        expected.as_object_mut().unwrap().remove("description");
        expected["$defs"] = json!({"d0":schema["$defs"]["LongType"]});
        expected["properties"]["title"]["$ref"] = json!("#/$defs/d0");
        expected["properties"]["default"]["$ref"] = json!("#/$defs/d0");
        expected["properties"]["enum"]["$ref"] = json!("#/$defs/d0");
        assert_eq!(compact(schema), expected);
    }
}
