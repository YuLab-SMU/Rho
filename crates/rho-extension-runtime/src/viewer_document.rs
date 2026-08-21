//! Fixed, host-rendered document contract for third-party Viewer/Panel output.
//!
//! The contract contains data only. It cannot carry HTML, Markdown, CSS,
//! JavaScript, URLs, raw paths, base64 payloads, DOM identifiers, or event
//! handlers.

use std::fmt;

use serde::{Deserialize, Serialize};

pub const PLUGIN_VIEWER_DOCUMENT_CONTRACT: &str = "rho.plugin_viewer_document.v1";
pub const MAX_VIEWER_BLOCKS: usize = 128;
pub const MAX_VIEWER_TEXT_BYTES: usize = 64 * 1024;
pub const MAX_VIEWER_TABLE_ROWS: usize = 500;
pub const MAX_VIEWER_TABLE_COLUMNS: usize = 100;
pub const MAX_VIEWER_KEY_VALUE_ITEMS: usize = 128;
pub const MAX_VIEWER_DOCUMENT_JSON_BYTES: usize = 1024 * 1024;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ViewerDocumentV1 {
    pub contract: String,
    pub title: String,
    pub blocks: Vec<ViewerBlockV1>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum ViewerBlockV1 {
    Text {
        text: String,
    },
    Code {
        code: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        language: Option<String>,
    },
    KeyValue {
        items: Vec<ViewerKeyValueItemV1>,
    },
    Table {
        columns: Vec<String>,
        rows: Vec<Vec<String>>,
    },
    Notice {
        tone: ViewerNoticeToneV1,
        text: String,
    },
    ArtifactImageRef {
        artifact_id: String,
        media_type: String,
        alt: String,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ViewerKeyValueItemV1 {
    pub key: String,
    pub value: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ViewerNoticeToneV1 {
    Info,
    Warning,
    Error,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum PluginCommandResultV1 {
    Notification { message: String },
    ViewerDocument { document: ViewerDocumentV1 },
    ArtifactRef { artifact_id: String },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ViewerDocumentError(String);

impl ViewerDocumentError {
    pub fn message(&self) -> &str {
        &self.0
    }
}

impl fmt::Display for ViewerDocumentError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.0)
    }
}

impl std::error::Error for ViewerDocumentError {}

impl ViewerDocumentV1 {
    pub fn parse(value: serde_json::Value) -> Result<Self, ViewerDocumentError> {
        let bytes = serde_json::to_vec(&value)
            .map_err(|_| ViewerDocumentError("ViewerDocument could not be encoded".to_string()))?;
        if bytes.len() > MAX_VIEWER_DOCUMENT_JSON_BYTES {
            return Err(ViewerDocumentError(format!(
                "ViewerDocument exceeds {MAX_VIEWER_DOCUMENT_JSON_BYTES} bytes"
            )));
        }
        let document: Self = serde_json::from_value(value)
            .map_err(|_| ViewerDocumentError("ViewerDocument shape is invalid".to_string()))?;
        document.validate()?;
        Ok(document)
    }

    pub fn validate(&self) -> Result<(), ViewerDocumentError> {
        if self.contract != PLUGIN_VIEWER_DOCUMENT_CONTRACT {
            return Err(ViewerDocumentError(
                "ViewerDocument contract is unsupported".to_string(),
            ));
        }
        validate_single_line(&self.title, 128, "ViewerDocument title")?;
        validate_not_trusted_surface_text(&self.title, "ViewerDocument title")?;
        if self.blocks.len() > MAX_VIEWER_BLOCKS {
            return Err(ViewerDocumentError(format!(
                "ViewerDocument exceeds {MAX_VIEWER_BLOCKS} blocks"
            )));
        }
        for block in &self.blocks {
            match block {
                ViewerBlockV1::Text { text } | ViewerBlockV1::Notice { text, .. } => {
                    validate_display_text(text, MAX_VIEWER_TEXT_BYTES, "Viewer text")?;
                }
                ViewerBlockV1::Code { code, language } => {
                    validate_display_text(code, MAX_VIEWER_TEXT_BYTES, "Viewer code")?;
                    if let Some(language) = language
                        && (language.is_empty()
                            || language.len() > 32
                            || !language.bytes().all(|byte| {
                                byte.is_ascii_lowercase()
                                    || byte.is_ascii_digit()
                                    || matches!(byte, b'+' | b'#' | b'-' | b'_')
                            }))
                    {
                        return Err(ViewerDocumentError(
                            "Viewer code language is invalid".to_string(),
                        ));
                    }
                }
                ViewerBlockV1::KeyValue { items } => {
                    if items.len() > MAX_VIEWER_KEY_VALUE_ITEMS {
                        return Err(ViewerDocumentError(format!(
                            "Viewer key/value block exceeds {MAX_VIEWER_KEY_VALUE_ITEMS} items"
                        )));
                    }
                    for item in items {
                        validate_single_line(&item.key, 1024, "Viewer key")?;
                        validate_display_text(&item.value, MAX_VIEWER_TEXT_BYTES, "Viewer value")?;
                    }
                }
                ViewerBlockV1::Table { columns, rows } => {
                    if columns.is_empty() || columns.len() > MAX_VIEWER_TABLE_COLUMNS {
                        return Err(ViewerDocumentError(format!(
                            "Viewer table must have 1 to {MAX_VIEWER_TABLE_COLUMNS} columns"
                        )));
                    }
                    if rows.len() > MAX_VIEWER_TABLE_ROWS {
                        return Err(ViewerDocumentError(format!(
                            "Viewer table exceeds {MAX_VIEWER_TABLE_ROWS} rows"
                        )));
                    }
                    for column in columns {
                        validate_single_line(column, 1024, "Viewer table column")?;
                    }
                    for row in rows {
                        if row.len() != columns.len() {
                            return Err(ViewerDocumentError(
                                "Viewer table row width does not match columns".to_string(),
                            ));
                        }
                        for cell in row {
                            validate_display_text(
                                cell,
                                MAX_VIEWER_TEXT_BYTES,
                                "Viewer table cell",
                            )?;
                        }
                    }
                }
                ViewerBlockV1::ArtifactImageRef {
                    artifact_id,
                    media_type,
                    alt,
                } => {
                    if artifact_id.is_empty()
                        || artifact_id.len() > 128
                        || !artifact_id.bytes().all(|byte| {
                            byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-' | b'.')
                        })
                    {
                        return Err(ViewerDocumentError(
                            "Viewer Artifact ID is invalid".to_string(),
                        ));
                    }
                    if !matches!(
                        media_type.as_str(),
                        "image/png" | "image/jpeg" | "image/gif" | "image/webp"
                    ) {
                        return Err(ViewerDocumentError(
                            "Viewer Artifact media type is unsupported".to_string(),
                        ));
                    }
                    validate_single_line(alt, 1024, "Viewer image alt text")?;
                }
            }
        }
        let bytes = serde_json::to_vec(self)
            .map_err(|_| ViewerDocumentError("ViewerDocument could not be encoded".to_string()))?;
        if bytes.len() > MAX_VIEWER_DOCUMENT_JSON_BYTES {
            return Err(ViewerDocumentError(format!(
                "ViewerDocument exceeds {MAX_VIEWER_DOCUMENT_JSON_BYTES} bytes"
            )));
        }
        Ok(())
    }

    pub fn artifact_image_refs(&self) -> impl Iterator<Item = (&str, &str)> {
        self.blocks.iter().filter_map(|block| match block {
            ViewerBlockV1::ArtifactImageRef {
                artifact_id,
                media_type,
                ..
            } => Some((artifact_id.as_str(), media_type.as_str())),
            _ => None,
        })
    }
}

impl PluginCommandResultV1 {
    pub fn parse(value: serde_json::Value) -> Result<Self, ViewerDocumentError> {
        let bytes = serde_json::to_vec(&value).map_err(|_| {
            ViewerDocumentError("Plugin command result could not be encoded".to_string())
        })?;
        if bytes.len() > MAX_VIEWER_DOCUMENT_JSON_BYTES {
            return Err(ViewerDocumentError(
                "Plugin command result exceeds its byte budget".to_string(),
            ));
        }
        let result: Self = serde_json::from_value(value).map_err(|_| {
            ViewerDocumentError("Plugin command result shape is invalid".to_string())
        })?;
        match &result {
            Self::Notification { message } => {
                validate_display_text(message, 1024, "Plugin notification")?;
                validate_not_trusted_surface_text(message, "Plugin notification")?;
            }
            Self::ViewerDocument { document } => document.validate()?,
            Self::ArtifactRef { artifact_id } => {
                if artifact_id.is_empty()
                    || artifact_id.len() > 128
                    || !artifact_id.bytes().all(|byte| {
                        byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-' | b'.')
                    })
                {
                    return Err(ViewerDocumentError(
                        "Plugin command Artifact ID is invalid".to_string(),
                    ));
                }
            }
        }
        Ok(result)
    }
}

fn validate_single_line(
    value: &str,
    maximum_bytes: usize,
    label: &str,
) -> Result<(), ViewerDocumentError> {
    if value.is_empty()
        || value.trim() != value
        || value.len() > maximum_bytes
        || value.chars().any(char::is_control)
        || contains_bidi_override(value)
    {
        return Err(ViewerDocumentError(format!("{label} is invalid")));
    }
    Ok(())
}

fn validate_display_text(
    value: &str,
    maximum_bytes: usize,
    label: &str,
) -> Result<(), ViewerDocumentError> {
    if value.len() > maximum_bytes
        || value.contains('\0')
        || value.chars().any(contains_disallowed_control)
        || contains_bidi_override(value)
    {
        return Err(ViewerDocumentError(format!("{label} is invalid")));
    }
    Ok(())
}

fn validate_not_trusted_surface_text(value: &str, label: &str) -> Result<(), ViewerDocumentError> {
    let lowercase = value.to_lowercase();
    if [
        "approval",
        "credential",
        "password",
        "updater",
        "security alert",
        "system dialog",
    ]
    .iter()
    .any(|term| lowercase.contains(term))
    {
        return Err(ViewerDocumentError(format!(
            "{label} uses reserved trusted-surface terminology"
        )));
    }
    Ok(())
}

fn contains_disallowed_control(character: char) -> bool {
    character.is_control() && !matches!(character, '\n' | '\r' | '\t')
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

    fn document() -> serde_json::Value {
        json!({
            "contract": PLUGIN_VIEWER_DOCUMENT_CONTRACT,
            "title": "CSV metadata",
            "blocks": [
                {"kind": "text", "text": "Bounded project data"},
                {"kind": "code", "code": "summary(data)", "language": "r"},
                {"kind": "key_value", "items": [{"key": "Rows", "value": "2"}]},
                {"kind": "table", "columns": ["a", "b"], "rows": [["1", "2"]]},
                {"kind": "notice", "tone": "info", "text": "Untrusted plugin output"},
                {"kind": "artifact_image_ref", "artifact_id": "artifact_1", "media_type": "image/png", "alt": "Plot"}
            ]
        })
    }

    #[test]
    fn parses_fixed_document_and_lists_artifact_refs() {
        let document = ViewerDocumentV1::parse(document()).unwrap();
        assert_eq!(document.blocks.len(), 6);
        assert_eq!(
            document.artifact_image_refs().collect::<Vec<_>>(),
            vec![("artifact_1", "image/png")]
        );
    }

    #[test]
    fn rejects_html_urls_base64_handlers_unknown_fields_and_bidi() {
        for (path, value) in [
            (("blocks", 0, "html"), json!("<script>alert(1)</script>")),
            (("blocks", 0, "url"), json!("https://example.org")),
            (("blocks", 0, "onclick"), json!("run()")),
            (("blocks", 5, "path"), json!("/tmp/plot.png")),
            (("blocks", 5, "base64"), json!("AAAA")),
        ] {
            let mut value_doc = document();
            value_doc[path.0][path.1][path.2] = value;
            assert!(ViewerDocumentV1::parse(value_doc).is_err());
        }
        let mut bidi = document();
        bidi["title"] = json!("Trusted\u{202e}origin");
        assert!(ViewerDocumentV1::parse(bidi).is_err());
    }

    #[test]
    fn enforces_block_table_text_and_total_budgets() {
        let mut too_many = document();
        too_many["blocks"] = serde_json::Value::Array(
            (0..=MAX_VIEWER_BLOCKS)
                .map(|_| json!({"kind": "text", "text": "x"}))
                .collect(),
        );
        assert!(ViewerDocumentV1::parse(too_many).is_err());

        let mut wide = document();
        wide["blocks"] = json!([{
            "kind": "table",
            "columns": (0..=MAX_VIEWER_TABLE_COLUMNS).map(|index| format!("c{index}")).collect::<Vec<_>>(),
            "rows": []
        }]);
        assert!(ViewerDocumentV1::parse(wide).is_err());

        let mut long = document();
        long["blocks"] = json!([{"kind": "text", "text": "x".repeat(MAX_VIEWER_TEXT_BYTES + 1)}]);
        assert!(ViewerDocumentV1::parse(long).is_err());

        let huge = json!({
            "contract": PLUGIN_VIEWER_DOCUMENT_CONTRACT,
            "title": "Huge",
            "blocks": (0..20).map(|_| json!({
                "kind": "text", "text": "x".repeat(MAX_VIEWER_TEXT_BYTES)
            })).collect::<Vec<_>>()
        });
        assert!(ViewerDocumentV1::parse(huge).is_err());
    }

    #[test]
    fn command_result_accepts_only_fixed_result_kinds() {
        assert!(
            PluginCommandResultV1::parse(json!({
                "kind": "notification", "message": "CSV metadata is ready"
            }))
            .is_ok()
        );
        assert!(
            PluginCommandResultV1::parse(json!({
                "kind": "viewer_document", "document": document()
            }))
            .is_ok()
        );
        assert!(
            PluginCommandResultV1::parse(json!({
                "kind": "artifact_ref", "artifact_id": "artifact_1"
            }))
            .is_ok()
        );
        assert!(
            PluginCommandResultV1::parse(json!({
                "kind": "html", "html": "<script>alert(1)</script>"
            }))
            .is_err()
        );
        assert!(
            PluginCommandResultV1::parse(json!({
                "kind": "notification", "message": "Approval required"
            }))
            .is_err()
        );
        let mut spoofed = document();
        spoofed["title"] = json!("Credential prompt");
        assert!(ViewerDocumentV1::parse(spoofed).is_err());
    }
}
