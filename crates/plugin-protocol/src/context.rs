//! Bounded context discovery and preview shared by contributed query owners.
//! Selectors and inclusion options remain owner-defined. A reference does not
//! grant access, preserve source bytes, or authorize an operation.
use crate::*;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use ts_rs::TS;

pub const MAX_CONTEXT_ITEMS: u16 = 20;
pub const MAX_CONTEXT_SELECTOR_BYTES: usize = 16 * 1024;
pub const MAX_CONTEXT_TEXT_BYTES: u32 = 64 * 1024;

fn bounded_json(value: &Value, limit: usize) -> Result<(), ProtocolError> {
    require(
        serde_json::to_vec(value)
            .map_err(|e| ProtocolError(e.to_string()))?
            .len()
            <= limit,
        "context selector or data exceeds its byte limit",
    )
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct ContextReference {
    pub provider: InstanceRef,
    pub contribution: ContributionId,
    pub window: WindowId,
    /// Owner-defined identity and observed native version/digest. Preview must
    /// revalidate these against the original source; never silently refresh them.
    pub selector: Value,
}
impl ContextReference {
    pub fn validate(&self) -> Result<(), ProtocolError> {
        bounded_json(&self.selector, MAX_CONTEXT_SELECTOR_BYTES)
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct ContextItem {
    pub reference: ContextReference,
    pub title: String,
    pub description: String,
    /// A presentation hint supplied by the owner, not a closed core view enum.
    pub kind: String,
}
impl ContextItem {
    pub fn validate(&self) -> Result<(), ProtocolError> {
        self.reference.validate()?;
        bounded_text(&self.title, 1024, "context title")?;
        require(
            self.description.len() <= 4096,
            "context description exceeds 4096 bytes",
        )?;
        bounded_text(&self.kind, 128, "context kind")
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct ContextSearch {
    pub window: WindowId,
    /// Empty text lists available sources. Owners document which fields match.
    pub text: String,
    /// Opaque owner cursor; continuation does not imply a frozen multi-page read.
    pub after: Option<Value>,
    #[schemars(range(min = 1, max = 20))]
    pub limit: u16,
}
impl ContextSearch {
    pub fn validate(&self) -> Result<(), ProtocolError> {
        require(self.text.len() <= 4096, "context search exceeds 4096 bytes")?;
        require(
            (1..=MAX_CONTEXT_ITEMS).contains(&self.limit),
            "context page limit must be 1–20",
        )?;
        if let Some(cursor) = &self.after {
            bounded_json(cursor, MAX_CONTEXT_SELECTOR_BYTES)?;
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct ContextPage {
    #[schemars(length(max = 20))]
    pub items: Vec<ContextItem>,
    pub next: Option<Value>,
    /// Explain partial, cached or unavailable observations without concealing
    /// them as empty results. Completeness also belongs in the query envelope.
    #[schemars(length(max = 8))]
    pub notices: Vec<String>,
}
impl ContextPage {
    pub fn validate(&self) -> Result<(), ProtocolError> {
        require(
            self.items.len() <= usize::from(MAX_CONTEXT_ITEMS),
            "context page exceeds 20 items",
        )?;
        for item in &self.items {
            item.validate()?;
        }
        if let Some(cursor) = &self.next {
            bounded_json(cursor, MAX_CONTEXT_SELECTOR_BYTES)?;
        }
        require(
            self.notices.len() <= 8 && self.notices.iter().all(|notice| notice.len() <= 4096),
            "context notices exceed their limit",
        )
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct PreviewContext {
    pub reference: ContextReference,
    /// Owner-defined inclusion, such as a captured selection or a table range.
    pub inclusion: Value,
    #[schemars(range(min = 1, max = 65536))]
    pub max_bytes: u32,
}
impl PreviewContext {
    pub fn validate(&self) -> Result<(), ProtocolError> {
        self.reference.validate()?;
        bounded_json(&self.inclusion, MAX_CONTEXT_SELECTOR_BYTES)?;
        require(
            (1..=MAX_CONTEXT_TEXT_BYTES).contains(&self.max_bytes),
            "context preview limit must be 1–65536 bytes",
        )
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct ContextPreview {
    pub item: ContextItem,
    /// Plain text, never executable markup. Truncation must end at a UTF-8 boundary.
    pub text: String,
    pub truncated: bool,
    /// Owner-defined bounded presentation data. Large artifacts use resources.
    pub data: Value,
    #[schemars(length(max = 8))]
    pub resources: Vec<ResourceReference>,
}
impl ContextPreview {
    pub fn validate(&self) -> Result<(), ProtocolError> {
        self.item.validate()?;
        require(
            self.text.len() <= MAX_CONTEXT_TEXT_BYTES as usize,
            "context text exceeds 64 KiB",
        )?;
        bounded_json(&self.data, MAX_CONTEXT_TEXT_BYTES as usize)?;
        require(
            self.resources.len() <= 8,
            "context preview exceeds 8 resources",
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn context_requests_bound_unicode_and_opaque_options_without_native_core_types() {
        let mut search: ContextSearch =
            serde_json::from_value(json!({"window":"one","text":"研究","after":null,"limit":20}))
                .unwrap();
        search.validate().unwrap();
        search.limit = 21;
        assert!(search.validate().is_err());
        search.limit = 1;
        search.text = "研".repeat(1366);
        assert!(search.validate().is_err());
        search.text.clear();
        search.after = Some(json!({"cursor":"x".repeat(MAX_CONTEXT_SELECTOR_BYTES)}));
        assert!(search.validate().is_err());
        let reference = ContextReference {
            provider: InstanceRef {
                plugin: PluginId::new("example.context").unwrap(),
                instance: PluginInstanceId::new("instance").unwrap(),
                revision: RevisionId::new(format!("sha256:{}", "a".repeat(64))).unwrap(),
                artifact: ArtifactId::new(format!("sha256:{}", "b".repeat(64))).unwrap(),
            },
            contribution: ContributionId::new("documents").unwrap(),
            window: WindowId::new("one").unwrap(),
            selector: json!({"native":"opaque","version":7}),
        };
        let mut preview = PreviewContext {
            reference: reference.clone(),
            inclusion: json!({"kind":"selection"}),
            max_bytes: 65536,
        };
        preview.validate().unwrap();
        preview.max_bytes = 0;
        assert!(preview.validate().is_err());
        let mut result = ContextPreview {
            item: ContextItem {
                reference,
                title: "研究.R".into(),
                description: String::new(),
                kind: "text".into(),
            },
            text: "🙂".repeat(16384),
            truncated: true,
            data: json!({}),
            resources: vec![],
        };
        result.validate().unwrap();
        result.text.push('x');
        assert!(result.validate().is_err());
        let mut wire = serde_json::to_value(preview).unwrap();
        wire["principal"] = json!("forged");
        assert!(serde_json::from_value::<PreviewContext>(wire).is_err());
    }
}
