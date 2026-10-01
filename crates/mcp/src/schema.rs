use schemars::{Schema, transform::transform_subschemas};
use serde_json::{Map, Value};

/// Rust numeric widths are not JSON Schema formats. MCP clients such as Kimi
/// compile schemas with Ajv and otherwise log each unknown format into the TUI.
/// Keep the actual type/range constraints and the authoritative Host schema.
pub(crate) fn object(mut value: Value) -> Result<Map<String, Value>, String> {
    let schema: &mut Schema = (&mut value)
        .try_into()
        .map_err(|_| "tool schema is not an object")?;
    portable_numeric_formats(schema);
    value
        .as_object()
        .cloned()
        .ok_or_else(|| "tool schema is not an object".into())
}

fn portable_numeric_formats(schema: &mut Schema) {
    if matches!(
        schema.get("format").and_then(Value::as_str),
        Some(
            "int"
                | "int8"
                | "int16"
                | "int32"
                | "int64"
                | "int128"
                | "uint"
                | "uint8"
                | "uint16"
                | "uint32"
                | "uint64"
                | "uint128"
                | "float"
                | "double"
        )
    ) {
        schema.remove("format");
    }
    // Traverse schema positions only: examples, defaults, enums and constants
    // can contain user data with a `format` key and must remain byte-equivalent.
    transform_subschemas(&mut portable_numeric_formats, schema);
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn numeric_annotations_are_removed_without_changing_constraints_or_data() {
        let source = json!({
            "type":"object",
            "$defs":{"Version":{"type":"integer","format":"uint16","minimum":0,"maximum":65535}},
            "properties":{
                "version":{"$ref":"#/$defs/Version"},
                "times":{"type":"array","items":{"anyOf":[
                    {"type":"integer","format":"uint64","minimum":0}, {"type":"null"}
                ]}},
                "format":{"type":"string","const":"uint32"},
                "timestamp":{"type":"string","format":"date-time"},
                "id":{"type":"string","format":"uuid"}
            },
            "required":["version"],
            "additionalProperties":false,
            "examples":[{"type":"integer","format":"uint16"}],
            "default":{"format":"uint32"},
            "const":{"format":"uint64"},
            "enum":[{"format":"uint"}]
        });
        let mut expected = source.clone();
        expected["$defs"]["Version"]
            .as_object_mut()
            .unwrap()
            .remove("format");
        expected["properties"]["times"]["items"]["anyOf"][0]
            .as_object_mut()
            .unwrap()
            .remove("format");
        assert_eq!(Value::Object(object(source).unwrap()), expected);
    }

    #[test]
    fn generated_rust_numbers_have_portable_schemas() {
        let source = schemars::schema_for!((
            u8, u16, u32, u64, u128, usize, i8, i16, i32, i64, i128, isize, f32, f64
        ))
        .to_value();
        let result = Value::Object(object(source.clone()).unwrap());
        for item in result["prefixItems"].as_array().unwrap() {
            assert!(item.get("format").is_none(), "{item}");
            assert!(matches!(item["type"].as_str(), Some("integer" | "number")));
        }
        assert_eq!(source["prefixItems"][0]["format"], "uint8");
        assert_eq!(result["minItems"], source["minItems"]);
        assert_eq!(result["maxItems"], source["maxItems"]);
    }
}
