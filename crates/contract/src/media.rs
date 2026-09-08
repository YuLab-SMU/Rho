//! Output presentation DTOs; previews never become scientific artifacts.
use crate::MediaReference;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use ts_rs::TS;

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct ImageCrop {
    /// Zero-based original pixel coordinates (SVG uses its declared pixel viewport).
    pub x: u32,
    pub y: u32,
    pub width: u32,
    pub height: u32,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct ViewOutputArguments {
    pub reference: MediaReference,
    #[serde(default)]
    pub crop: Option<ImageCrop>,
    #[serde(default = "preview_edge")]
    #[schemars(range(min = 1, max = 2400))]
    pub max_edge: u32,
}
fn preview_edge() -> u32 {
    1600
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS)]
pub struct OutputView {
    pub reference: MediaReference,
    pub original_width: u32,
    pub original_height: u32,
    pub crop: ImageCrop,
    pub preview_width: u32,
    pub preview_height: u32,
    pub preview_mime_type: String,
    pub preview_sha256: String,
    pub preview_byte_size: u64,
    pub preview_base64: String,
    pub scale_x: f64,
    pub scale_y: f64,
    pub rasterized: bool,
    pub transformations: Vec<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct ReadOutputTextArguments {
    pub reference: MediaReference,
    /// Zero-based UTF-8 byte offset in this immutable artifact.
    #[serde(default)]
    pub offset: u64,
    #[serde(default = "text_limit")]
    #[schemars(range(min = 1, max = 65536))]
    pub limit_bytes: u32,
}
fn text_limit() -> u32 {
    65536
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS)]
pub struct OutputTextPage {
    pub reference: MediaReference,
    pub encoding: String,
    pub byte_start: u64,
    pub byte_end: u64,
    pub text: String,
    pub continuation: Option<ReadOutputTextArguments>,
    pub complete: bool,
    pub limit_reason: Option<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS)]
pub struct OutputResourceChunk {
    pub uri: String,
    pub offset: u64,
    pub byte_size: u32,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS)]
pub struct OutputResourceManifest {
    pub reference: MediaReference,
    pub chunk_bytes: u32,
    pub chunks: Vec<OutputResourceChunk>,
    pub verification: String,
}
