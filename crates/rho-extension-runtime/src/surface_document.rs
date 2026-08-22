//! Bounded declarative documents and exact events for workspace-plugin Surfaces.

use std::collections::BTreeSet;

use rho_ui_contract::{
    PackageDigest as UiPackageDigest, PluginId as UiPluginId, ProjectId, SurfaceId,
    SurfaceInstanceId, validate_json_value,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use thiserror::Error;

pub const PLUGIN_SURFACE_DOCUMENT_CONTRACT: &str = "rho.plugin_surface_document.v1";
pub const PLUGIN_SURFACE_EVENT_CONTRACT: &str = "rho.plugin_surface_event.v1";
pub const MAX_SURFACE_DOCUMENT_BYTES: usize = 1024 * 1024;
pub const MAX_SURFACE_DOCUMENT_DEPTH: usize = 12;
pub const MAX_SURFACE_DOCUMENT_BLOCKS: usize = 256;
pub const MAX_SURFACE_DOCUMENT_CONTROLS: usize = 64;
pub const MAX_SURFACE_DOCUMENT_TEXT_BYTES: usize = 64 * 1024;
pub const MAX_SURFACE_DOCUMENT_TABLE_ROWS: usize = 200;
pub const MAX_SURFACE_DOCUMENT_TABLE_COLUMNS: usize = 32;
pub const MAX_SURFACE_SELECT_OPTIONS: usize = 128;
pub const MAX_SURFACE_EVENT_VALUE_BYTES: usize = 64 * 1024;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SurfaceKeyValueItemV1 {
    pub key: String,
    pub value: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SurfaceSelectOptionV1 {
    pub value: String,
    pub label: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum SurfaceBlockV1 {
    Row {
        blocks: Vec<SurfaceBlockV1>,
    },
    Column {
        blocks: Vec<SurfaceBlockV1>,
    },
    Grid {
        columns: u8,
        blocks: Vec<SurfaceGridItemV1>,
    },
    Tabs {
        active_tab_id: String,
        tabs: Vec<SurfaceTabV1>,
    },
    Group {
        label: Option<String>,
        blocks: Vec<SurfaceBlockV1>,
    },
    Text {
        text: String,
    },
    Code {
        code: String,
        language: Option<String>,
    },
    KeyValue {
        items: Vec<SurfaceKeyValueItemV1>,
    },
    Table {
        columns: Vec<String>,
        rows: Vec<Vec<String>>,
    },
    Notice {
        tone: SurfaceNoticeToneV1,
        text: String,
    },
    ArtifactImageRef {
        artifact_id: String,
        media_type: String,
        alt: String,
    },
    Field {
        control_id: String,
        label: String,
        value: String,
        placeholder: Option<String>,
        disabled: bool,
        busy: bool,
    },
    Select {
        control_id: String,
        label: String,
        value: String,
        options: Vec<SurfaceSelectOptionV1>,
        disabled: bool,
        busy: bool,
    },
    CommandButton {
        control_id: String,
        label: String,
        command_id: String,
        disabled: bool,
        busy: bool,
    },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SurfaceGridItemV1 {
    pub column_span: u8,
    pub block: Box<SurfaceBlockV1>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SurfaceTabV1 {
    pub tab_id: String,
    pub label: String,
    pub blocks: Vec<SurfaceBlockV1>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SurfaceNoticeToneV1 {
    Info,
    Success,
    Warning,
    Error,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SurfaceDocumentV1 {
    pub contract: String,
    pub revision: u64,
    pub title: String,
    pub blocks: Vec<SurfaceBlockV1>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SurfaceControlKindV1 {
    Field,
    Select,
    CommandButton,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SurfaceControlDescriptorV1 {
    pub control_id: String,
    pub kind: SurfaceControlKindV1,
    pub disabled: bool,
    pub busy: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SurfaceEventKindV1 {
    Input,
    Change,
    Submit,
    Activate,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SurfaceEventV1 {
    pub contract: String,
    pub project_id: ProjectId,
    pub plugin_id: UiPluginId,
    pub package_digest: UiPackageDigest,
    pub activation_generation: u64,
    pub host_instance_id: String,
    pub surface_id: SurfaceId,
    pub instance_id: SurfaceInstanceId,
    pub expected_project_revision: u64,
    pub expected_surface_revision: u64,
    pub expected_document_revision: u64,
    pub expected_resource_revision: Option<u64>,
    pub expected_runtime_generation: Option<u64>,
    pub expected_page_revision: Option<u64>,
    pub expected_layout_revision: Option<u64>,
    pub control_id: String,
    pub event_kind: SurfaceEventKindV1,
    pub value: Value,
}

#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum SurfaceDocumentError {
    #[error("surface document is malformed")]
    Malformed,
    #[error("surface document exceeds a safety budget")]
    LimitExceeded,
    #[error("surface document contains an invalid value")]
    Invalid,
    #[error("surface event targets an unknown or incompatible control")]
    UnknownControl,
    #[error("surface event is stale or belongs to another exact route")]
    StaleIdentity,
}

impl SurfaceDocumentV1 {
    pub fn parse(value: Value) -> Result<Self, SurfaceDocumentError> {
        let bytes = serde_json::to_vec(&value).map_err(|_| SurfaceDocumentError::Malformed)?;
        if bytes.len() > MAX_SURFACE_DOCUMENT_BYTES {
            return Err(SurfaceDocumentError::LimitExceeded);
        }
        let document: Self =
            serde_json::from_value(value).map_err(|_| SurfaceDocumentError::Malformed)?;
        document.validate()?;
        Ok(document)
    }

    pub fn validate(&self) -> Result<(), SurfaceDocumentError> {
        let bytes = serde_json::to_vec(self).map_err(|_| SurfaceDocumentError::Malformed)?;
        if bytes.len() > MAX_SURFACE_DOCUMENT_BYTES {
            return Err(SurfaceDocumentError::LimitExceeded);
        }
        if self.contract != PLUGIN_SURFACE_DOCUMENT_CONTRACT || self.revision == 0 {
            return Err(SurfaceDocumentError::Invalid);
        }
        validate_text(&self.title, false)?;
        let mut budget = DocumentBudget::default();
        for block in &self.blocks {
            validate_block(block, 1, &mut budget)?;
        }
        Ok(())
    }

    pub fn controls(&self) -> Vec<SurfaceControlDescriptorV1> {
        let mut controls = Vec::new();
        for block in &self.blocks {
            collect_controls(block, &mut controls);
        }
        controls
    }

    pub fn artifact_image_refs(&self) -> Vec<(&str, &str)> {
        let mut refs = Vec::new();
        for block in &self.blocks {
            collect_artifacts(block, &mut refs);
        }
        refs
    }

    pub fn validate_event(&self, event: &SurfaceEventV1) -> Result<(), SurfaceDocumentError> {
        event.validate()?;
        if event.expected_document_revision != self.revision {
            return Err(SurfaceDocumentError::StaleIdentity);
        }
        let control = self
            .controls()
            .into_iter()
            .find(|control| control.control_id == event.control_id)
            .ok_or(SurfaceDocumentError::UnknownControl)?;
        if control.disabled || control.busy {
            return Err(SurfaceDocumentError::UnknownControl);
        }
        let compatible = matches!(
            (control.kind, &event.event_kind),
            (
                SurfaceControlKindV1::Field,
                SurfaceEventKindV1::Input | SurfaceEventKindV1::Change | SurfaceEventKindV1::Submit
            ) | (SurfaceControlKindV1::Select, SurfaceEventKindV1::Change)
                | (
                    SurfaceControlKindV1::CommandButton,
                    SurfaceEventKindV1::Activate
                )
        );
        compatible
            .then_some(())
            .ok_or(SurfaceDocumentError::UnknownControl)
    }
}

impl SurfaceEventV1 {
    pub fn validate(&self) -> Result<(), SurfaceDocumentError> {
        if self.contract != PLUGIN_SURFACE_EVENT_CONTRACT
            || self.activation_generation == 0
            || self.expected_project_revision == 0
            || self.expected_surface_revision == 0
            || self.expected_document_revision == 0
            || self.expected_resource_revision == Some(0)
            || self.expected_runtime_generation == Some(0)
            || self.expected_page_revision == Some(0)
            || self.expected_layout_revision == Some(0)
        {
            return Err(SurfaceDocumentError::Invalid);
        }
        validate_identifier(&self.host_instance_id)?;
        validate_identifier(&self.control_id)?;
        validate_json_value(
            "plugin_surface_event.value",
            &self.value,
            MAX_SURFACE_EVENT_VALUE_BYTES,
        )
        .map_err(|_| SurfaceDocumentError::LimitExceeded)
    }
}

#[derive(Default)]
struct DocumentBudget {
    blocks: usize,
    controls: usize,
    control_ids: BTreeSet<String>,
    tab_ids: BTreeSet<String>,
}

fn validate_block(
    block: &SurfaceBlockV1,
    depth: usize,
    budget: &mut DocumentBudget,
) -> Result<(), SurfaceDocumentError> {
    if depth > MAX_SURFACE_DOCUMENT_DEPTH {
        return Err(SurfaceDocumentError::LimitExceeded);
    }
    budget.blocks += 1;
    if budget.blocks > MAX_SURFACE_DOCUMENT_BLOCKS {
        return Err(SurfaceDocumentError::LimitExceeded);
    }
    match block {
        SurfaceBlockV1::Row { blocks }
        | SurfaceBlockV1::Column { blocks }
        | SurfaceBlockV1::Group { blocks, .. } => {
            if let SurfaceBlockV1::Group {
                label: Some(label), ..
            } = block
            {
                validate_text(label, true)?;
            }
            validate_children(blocks, depth, budget)?;
        }
        SurfaceBlockV1::Grid { columns, blocks } => {
            if !(1..=12).contains(columns) {
                return Err(SurfaceDocumentError::Invalid);
            }
            for item in blocks {
                if item.column_span == 0 || item.column_span > *columns {
                    return Err(SurfaceDocumentError::Invalid);
                }
                validate_block(&item.block, depth + 1, budget)?;
            }
        }
        SurfaceBlockV1::Tabs {
            active_tab_id,
            tabs,
        } => {
            validate_identifier(active_tab_id)?;
            if tabs.is_empty() || !tabs.iter().any(|tab| tab.tab_id == *active_tab_id) {
                return Err(SurfaceDocumentError::Invalid);
            }
            for tab in tabs {
                validate_identifier(&tab.tab_id)?;
                validate_text(&tab.label, true)?;
                if !budget.tab_ids.insert(tab.tab_id.clone()) {
                    return Err(SurfaceDocumentError::Invalid);
                }
                validate_children(&tab.blocks, depth, budget)?;
            }
        }
        SurfaceBlockV1::Text { text } => validate_text(text, false)?,
        SurfaceBlockV1::Code { code, language } => {
            validate_text(code, false)?;
            if let Some(language) = language {
                validate_identifier(language)?;
            }
        }
        SurfaceBlockV1::KeyValue { items } => {
            if items.len() > MAX_SURFACE_DOCUMENT_TABLE_ROWS {
                return Err(SurfaceDocumentError::LimitExceeded);
            }
            for item in items {
                validate_text(&item.key, true)?;
                validate_text(&item.value, false)?;
            }
        }
        SurfaceBlockV1::Table { columns, rows } => {
            if columns.is_empty()
                || columns.len() > MAX_SURFACE_DOCUMENT_TABLE_COLUMNS
                || rows.len() > MAX_SURFACE_DOCUMENT_TABLE_ROWS
            {
                return Err(SurfaceDocumentError::LimitExceeded);
            }
            for column in columns {
                validate_text(column, true)?;
            }
            for row in rows {
                if row.len() != columns.len() {
                    return Err(SurfaceDocumentError::Invalid);
                }
                for cell in row {
                    validate_text(cell, false)?;
                }
            }
        }
        SurfaceBlockV1::Notice { text, .. } => validate_text(text, false)?,
        SurfaceBlockV1::ArtifactImageRef {
            artifact_id,
            media_type,
            alt,
        } => {
            validate_identifier(artifact_id)?;
            validate_media_type(media_type)?;
            if !media_type.starts_with("image/") {
                return Err(SurfaceDocumentError::Invalid);
            }
            validate_text(alt, false)?;
        }
        SurfaceBlockV1::Field {
            control_id,
            label,
            value,
            placeholder,
            ..
        } => {
            validate_control(control_id, label, budget)?;
            validate_text(value, false)?;
            if let Some(placeholder) = placeholder {
                validate_text(placeholder, false)?;
            }
        }
        SurfaceBlockV1::Select {
            control_id,
            label,
            value,
            options,
            ..
        } => {
            validate_control(control_id, label, budget)?;
            if options.is_empty() || options.len() > MAX_SURFACE_SELECT_OPTIONS {
                return Err(SurfaceDocumentError::LimitExceeded);
            }
            let mut values = BTreeSet::new();
            for option in options {
                validate_identifier(&option.value)?;
                validate_text(&option.label, true)?;
                if !values.insert(option.value.as_str()) {
                    return Err(SurfaceDocumentError::Invalid);
                }
            }
            if !options.iter().any(|option| option.value == *value) {
                return Err(SurfaceDocumentError::Invalid);
            }
        }
        SurfaceBlockV1::CommandButton {
            control_id,
            label,
            command_id,
            ..
        } => {
            validate_control(control_id, label, budget)?;
            validate_identifier(command_id)?;
        }
    }
    Ok(())
}

fn validate_children(
    blocks: &[SurfaceBlockV1],
    depth: usize,
    budget: &mut DocumentBudget,
) -> Result<(), SurfaceDocumentError> {
    for child in blocks {
        validate_block(child, depth + 1, budget)?;
    }
    Ok(())
}

fn validate_control(
    control_id: &str,
    label: &str,
    budget: &mut DocumentBudget,
) -> Result<(), SurfaceDocumentError> {
    validate_identifier(control_id)?;
    validate_text(label, true)?;
    budget.controls += 1;
    if budget.controls > MAX_SURFACE_DOCUMENT_CONTROLS
        || !budget.control_ids.insert(control_id.to_string())
    {
        return Err(SurfaceDocumentError::LimitExceeded);
    }
    Ok(())
}

fn validate_text(value: &str, required: bool) -> Result<(), SurfaceDocumentError> {
    if value.len() > MAX_SURFACE_DOCUMENT_TEXT_BYTES
        || (required && value.trim().is_empty())
        || value
            .chars()
            .any(|character| character.is_control() && character != '\n' && character != '\t')
        || contains_bidi_override(value)
    {
        return Err(SurfaceDocumentError::Invalid);
    }
    Ok(())
}

fn validate_identifier(value: &str) -> Result<(), SurfaceDocumentError> {
    if value.is_empty()
        || value.len() > 128
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b':' | b'_' | b'-'))
    {
        return Err(SurfaceDocumentError::Invalid);
    }
    Ok(())
}

fn validate_media_type(value: &str) -> Result<(), SurfaceDocumentError> {
    if value.is_empty()
        || value.len() > 128
        || value.matches('/').count() != 1
        || !value.bytes().all(|byte| {
            byte.is_ascii_lowercase()
                || byte.is_ascii_digit()
                || matches!(byte, b'/' | b'+' | b'.' | b'-')
        })
    {
        return Err(SurfaceDocumentError::Invalid);
    }
    Ok(())
}

fn contains_bidi_override(value: &str) -> bool {
    value.chars().any(|character| matches!(character, '\u{061c}' | '\u{200e}' | '\u{200f}' | '\u{202a}'..='\u{202e}' | '\u{2066}'..='\u{2069}'))
}

fn collect_controls(block: &SurfaceBlockV1, controls: &mut Vec<SurfaceControlDescriptorV1>) {
    match block {
        SurfaceBlockV1::Row { blocks }
        | SurfaceBlockV1::Column { blocks }
        | SurfaceBlockV1::Group { blocks, .. } => {
            for child in blocks {
                collect_controls(child, controls);
            }
        }
        SurfaceBlockV1::Grid { blocks, .. } => {
            for child in blocks {
                collect_controls(&child.block, controls);
            }
        }
        SurfaceBlockV1::Tabs { tabs, .. } => {
            for tab in tabs {
                for child in &tab.blocks {
                    collect_controls(child, controls);
                }
            }
        }
        SurfaceBlockV1::Field {
            control_id,
            disabled,
            busy,
            ..
        } => controls.push(SurfaceControlDescriptorV1 {
            control_id: control_id.clone(),
            kind: SurfaceControlKindV1::Field,
            disabled: *disabled,
            busy: *busy,
        }),
        SurfaceBlockV1::Select {
            control_id,
            disabled,
            busy,
            ..
        } => controls.push(SurfaceControlDescriptorV1 {
            control_id: control_id.clone(),
            kind: SurfaceControlKindV1::Select,
            disabled: *disabled,
            busy: *busy,
        }),
        SurfaceBlockV1::CommandButton {
            control_id,
            disabled,
            busy,
            ..
        } => controls.push(SurfaceControlDescriptorV1 {
            control_id: control_id.clone(),
            kind: SurfaceControlKindV1::CommandButton,
            disabled: *disabled,
            busy: *busy,
        }),
        _ => {}
    }
}

fn collect_artifacts<'a>(block: &'a SurfaceBlockV1, refs: &mut Vec<(&'a str, &'a str)>) {
    match block {
        SurfaceBlockV1::Row { blocks }
        | SurfaceBlockV1::Column { blocks }
        | SurfaceBlockV1::Group { blocks, .. } => {
            for child in blocks {
                collect_artifacts(child, refs);
            }
        }
        SurfaceBlockV1::Grid { blocks, .. } => {
            for child in blocks {
                collect_artifacts(&child.block, refs);
            }
        }
        SurfaceBlockV1::Tabs { tabs, .. } => {
            for tab in tabs {
                for child in &tab.blocks {
                    collect_artifacts(child, refs);
                }
            }
        }
        SurfaceBlockV1::ArtifactImageRef {
            artifact_id,
            media_type,
            ..
        } => refs.push((artifact_id, media_type)),
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn document() -> SurfaceDocumentV1 {
        SurfaceDocumentV1 {
            contract: PLUGIN_SURFACE_DOCUMENT_CONTRACT.to_string(),
            revision: 7,
            title: "Differential expression".to_string(),
            blocks: vec![SurfaceBlockV1::Column {
                blocks: vec![
                    SurfaceBlockV1::Tabs {
                        active_tab_id: "summary".to_string(),
                        tabs: vec![SurfaceTabV1 {
                            tab_id: "summary".to_string(),
                            label: "Summary".to_string(),
                            blocks: vec![SurfaceBlockV1::Grid {
                                columns: 12,
                                blocks: vec![SurfaceGridItemV1 {
                                    column_span: 12,
                                    block: Box::new(SurfaceBlockV1::Text {
                                        text: "Three contrasts are ready.".to_string(),
                                    }),
                                }],
                            }],
                        }],
                    },
                    SurfaceBlockV1::Field {
                        control_id: "contrast".to_string(),
                        label: "Contrast".to_string(),
                        value: "treated-control".to_string(),
                        placeholder: None,
                        disabled: false,
                        busy: false,
                    },
                    SurfaceBlockV1::CommandButton {
                        control_id: "run".to_string(),
                        label: "Run".to_string(),
                        command_id: "analysis.run".to_string(),
                        disabled: false,
                        busy: false,
                    },
                    SurfaceBlockV1::ArtifactImageRef {
                        artifact_id: "plot.volcano".to_string(),
                        media_type: "image/png".to_string(),
                        alt: "Volcano plot".to_string(),
                    },
                ],
            }],
        }
    }

    fn event(kind: SurfaceEventKindV1, control_id: &str) -> SurfaceEventV1 {
        SurfaceEventV1 {
            contract: PLUGIN_SURFACE_EVENT_CONTRACT.to_string(),
            project_id: ProjectId::new("project.fixture").unwrap(),
            plugin_id: UiPluginId::new("org.example.surface").unwrap(),
            package_digest: UiPackageDigest::new(format!("sha256:{}", "a".repeat(64))).unwrap(),
            activation_generation: 3,
            host_instance_id: "host.fixture".to_string(),
            surface_id: SurfaceId::new("ui.surface.analysis").unwrap(),
            instance_id: SurfaceInstanceId::new("surface-instance.fixture").unwrap(),
            expected_project_revision: 2,
            expected_surface_revision: 5,
            expected_document_revision: 7,
            expected_resource_revision: Some(4),
            expected_runtime_generation: Some(9),
            expected_page_revision: Some(6),
            expected_layout_revision: Some(8),
            control_id: control_id.to_string(),
            event_kind: kind,
            value: json!("treated-control"),
        }
    }

    #[test]
    fn parses_nested_document_and_discovers_only_typed_refs_and_controls() {
        let value = serde_json::to_value(document()).unwrap();
        let parsed = SurfaceDocumentV1::parse(value).unwrap();
        assert_eq!(parsed.controls().len(), 2);
        assert_eq!(
            parsed.artifact_image_refs(),
            vec![("plot.volcano", "image/png")]
        );
        assert!(
            parsed
                .validate_event(&event(SurfaceEventKindV1::Input, "contrast"))
                .is_ok()
        );
        assert!(
            parsed
                .validate_event(&event(SurfaceEventKindV1::Activate, "run"))
                .is_ok()
        );
    }

    #[test]
    fn rejects_raw_markup_blocks_unknown_fields_and_bidi_spoofing() {
        for hostile in [
            json!({"contract": PLUGIN_SURFACE_DOCUMENT_CONTRACT, "revision": 1, "title": "x", "blocks": [{"kind": "raw_html", "html": "<script>invoke()</script>"}]}),
            json!({"contract": PLUGIN_SURFACE_DOCUMENT_CONTRACT, "revision": 1, "title": "x", "blocks": [{"kind": "text", "text": "safe", "onclick": "invoke()"}]}),
            json!({"contract": PLUGIN_SURFACE_DOCUMENT_CONTRACT, "revision": 1, "title": "x\u{202e}dialog", "blocks": []}),
        ] {
            assert!(SurfaceDocumentV1::parse(hostile).is_err());
        }

        let escaped_text = json!({
            "contract": PLUGIN_SURFACE_DOCUMENT_CONTRACT,
            "revision": 1,
            "title": "Literal text",
            "blocks": [{"kind": "text", "text": "<script>window.__TAURI__.invoke()</script>"}]
        });
        assert!(SurfaceDocumentV1::parse(escaped_text).is_ok());
    }

    #[test]
    fn enforces_depth_block_control_and_encoded_byte_budgets() {
        let mut nested = SurfaceBlockV1::Text {
            text: "leaf".into(),
        };
        for _ in 0..MAX_SURFACE_DOCUMENT_DEPTH {
            nested = SurfaceBlockV1::Column {
                blocks: vec![nested],
            };
        }
        let mut too_deep = document();
        too_deep.blocks = vec![nested];
        assert_eq!(
            too_deep.validate(),
            Err(SurfaceDocumentError::LimitExceeded)
        );

        let mut too_many = document();
        too_many.blocks = (0..=MAX_SURFACE_DOCUMENT_BLOCKS)
            .map(|_| SurfaceBlockV1::Text { text: "x".into() })
            .collect();
        assert_eq!(
            too_many.validate(),
            Err(SurfaceDocumentError::LimitExceeded)
        );

        let mut duplicate = document();
        duplicate.blocks.push(SurfaceBlockV1::Field {
            control_id: "contrast".into(),
            label: "Duplicate".into(),
            value: String::new(),
            placeholder: None,
            disabled: false,
            busy: false,
        });
        assert_eq!(
            duplicate.validate(),
            Err(SurfaceDocumentError::LimitExceeded)
        );

        let mut oversized = document();
        oversized.blocks = vec![SurfaceBlockV1::Text {
            text: "x".repeat(MAX_SURFACE_DOCUMENT_BYTES),
        }];
        assert_eq!(
            oversized.validate(),
            Err(SurfaceDocumentError::LimitExceeded)
        );
    }

    #[test]
    fn rejects_unknown_disabled_incompatible_stale_and_oversized_events() {
        let document = document();
        assert_eq!(
            document.validate_event(&event(SurfaceEventKindV1::Activate, "missing")),
            Err(SurfaceDocumentError::UnknownControl)
        );
        assert_eq!(
            document.validate_event(&event(SurfaceEventKindV1::Activate, "contrast")),
            Err(SurfaceDocumentError::UnknownControl)
        );
        let mut stale = event(SurfaceEventKindV1::Input, "contrast");
        stale.expected_document_revision = 6;
        assert_eq!(
            document.validate_event(&stale),
            Err(SurfaceDocumentError::StaleIdentity)
        );
        let mut oversized = event(SurfaceEventKindV1::Input, "contrast");
        oversized.value = json!("x".repeat(MAX_SURFACE_EVENT_VALUE_BYTES + 1));
        assert_eq!(
            document.validate_event(&oversized),
            Err(SurfaceDocumentError::LimitExceeded)
        );

        let mut disabled = document.clone();
        if let SurfaceBlockV1::Column { blocks } = &mut disabled.blocks[0]
            && let SurfaceBlockV1::Field { disabled, .. } = &mut blocks[1]
        {
            *disabled = true;
        }
        assert_eq!(
            disabled.validate_event(&event(SurfaceEventKindV1::Input, "contrast")),
            Err(SurfaceDocumentError::UnknownControl)
        );
    }
}
