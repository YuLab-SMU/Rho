use super::{WORKSPACE_READ_SCOPE, WorkspaceRunHandler};
use async_trait::async_trait;
use rho_contract::*;
use rho_operation::{Clock, OperationError, OperationRecords, QueryHandler, SystemClock};
use schemars::schema_for;
use serde_json::{Value, json};
use std::{collections::BTreeSet, sync::Arc};

#[derive(Clone, Copy)]
pub enum OutputQueryKind {
    Events,
    List,
    Read,
    Status,
    View,
    ReadText,
}
pub struct WorkspaceOutputHandler {
    owner: Option<Arc<WorkspaceRunHandler>>,
    source: Option<Arc<dyn WorkspaceOutputs>>,
    project_root: Option<String>,
    records: Arc<dyn OperationRecords>,
    kind: OutputQueryKind,
    descriptor: CapabilityDescriptor,
    previews: Arc<std::sync::Mutex<PreviewCache>>,
}
impl WorkspaceOutputHandler {
    pub fn new(
        owner: Arc<WorkspaceRunHandler>,
        records: Arc<dyn OperationRecords>,
        kind: OutputQueryKind,
    ) -> Self {
        Self::with_store(Some(owner), None, None, records, kind)
    }
    pub fn with_store(
        owner: Option<Arc<WorkspaceRunHandler>>,
        source: Option<Arc<dyn WorkspaceOutputs>>,
        project_root: Option<String>,
        records: Arc<dyn OperationRecords>,
        kind: OutputQueryKind,
    ) -> Self {
        let project_root = project_root.or_else(|| {
            owner
                .as_ref()
                .and_then(|o| o.runtime.project_root().map(str::to_string))
        });
        let (id, schema) = match kind {
            OutputQueryKind::List => (
                "workspace.list_outputs",
                schema_for!(OutputEventsArguments).to_value(),
            ),
            OutputQueryKind::Events => (
                "workspace.output_events",
                schema_for!(OutputEventsArguments).to_value(),
            ),
            OutputQueryKind::Read => (
                "workspace.read_output",
                schema_for!(ReadOutputArguments).to_value(),
            ),
            OutputQueryKind::View => ("output.view", schema_for!(ViewOutputArguments).to_value()),
            OutputQueryKind::ReadText => (
                "output.read_text",
                schema_for!(ReadOutputTextArguments).to_value(),
            ),
            OutputQueryKind::Status => (
                "workspace.runtime_status",
                json!({"type":"object","properties":{},"additionalProperties":false}),
            ),
        };
        Self {
            previews: Arc::new(std::sync::Mutex::new(PreviewCache::default())),
            owner,
            source,
            project_root,
            records,
            kind,
            descriptor: CapabilityDescriptor {
                kind: CapabilityKind::Query,
                capability: CapabilityRef::new(id, 1).unwrap(),
                documentation: rho_contract::builtin_documentation(id),
                recovery_schema: serde_json::json!({"type":"null"}),
                domain: "workspace".into(),
                input_schema: schema,
                output_schema: match kind {
                    OutputQueryKind::List => schema_for!(MediaPage).to_value(),
                    OutputQueryKind::Events => schema_for!(OutputEvents).to_value(),
                    OutputQueryKind::Read => schema_for!(OutputPage).to_value(),
                    OutputQueryKind::Status => schema_for!(RuntimeStatus).to_value(),
                    OutputQueryKind::View => schema_for!(OutputView).to_value(),
                    OutputQueryKind::ReadText => schema_for!(OutputTextPage).to_value(),
                },
                required_scopes: BTreeSet::from([WORKSPACE_READ_SCOPE.into()]),
                potential_effects: BTreeSet::new(),
                idempotency: IdempotencyClass::Pure,
                retry: RetryClass::Safe,
                cancellation: CancellationClass::Unsupported,
            },
        }
    }
    pub async fn verified_original_for(
        &self,
        context: &CallContext,
        reference: &MediaReference,
    ) -> Result<Arc<[u8]>, OperationError> {
        context.validate()?;
        if !context.scopes.contains(WORKSPACE_READ_SCOPE) {
            return Err(OperationError::AccessDenied {
                capability: "output.original".into(),
                missing: vec![WORKSPACE_READ_SCOPE.into()],
            });
        }
        OperationId::new(reference.operation_id.as_str())?;
        if reference.sequence == 0 || reference.byte_size > 16 * 1024 * 1024 {
            return Err(invalid("invalid original output identity/bounds"));
        }
        self.visible(context, &reference.operation_id).await?;
        self.source
            .as_ref()
            .ok_or_else(|| OperationError::Unavailable("Output store is unavailable".into()))?
            .verified_original(reference)
            .await
            .map_err(OperationError::ContentChanged)
    }
    async fn visible(&self, context: &CallContext, id: &OperationId) -> Result<(), OperationError> {
        let record = self
            .records
            .get(id.as_str())
            .await
            .map_err(invalid)?
            .ok_or_else(|| invalid("output operation is not visible"))?;
        if record.operation.principal() != context.principal()
            || record.operation.idempotency_scope.as_deref() != self.project_root.as_deref()
            || record.operation.domain != "workspace"
        {
            return Err(invalid("output belongs to another project or principal"));
        }
        Ok(())
    }
}
#[async_trait]
impl QueryHandler for WorkspaceOutputHandler {
    fn descriptor(&self) -> &CapabilityDescriptor {
        &self.descriptor
    }
    fn normalize_arguments(&self, value: &Value) -> Result<Value, OperationError> {
        match self.kind {
            OutputQueryKind::Events | OutputQueryKind::List => {
                let args: OutputEventsArguments =
                    serde_json::from_value(value.clone()).map_err(invalid)?;
                OperationId::new(args.operation_id.as_str())?;
                if !(1..=100).contains(&args.limit) {
                    return Err(invalid("output event limit must be 1..=100"));
                }
                serde_json::to_value(args).map_err(invalid)
            }
            OutputQueryKind::Read => {
                let args: ReadOutputArguments =
                    serde_json::from_value(value.clone()).map_err(invalid)?;
                OperationId::new(args.reference.operation_id.as_str())?;
                if !(1..=65536).contains(&args.limit_bytes)
                    || args.reference.sequence == 0
                    || args.offset > args.reference.byte_size
                {
                    return Err(invalid("invalid media read bounds"));
                }
                serde_json::to_value(args).map_err(invalid)
            }
            OutputQueryKind::View => {
                let args: ViewOutputArguments =
                    serde_json::from_value(value.clone()).map_err(invalid)?;
                validate_view(&args)?;
                serde_json::to_value(args).map_err(invalid)
            }
            OutputQueryKind::ReadText => {
                let args: ReadOutputTextArguments =
                    serde_json::from_value(value.clone()).map_err(invalid)?;
                if args.reference.mime_type != "text/plain"
                    || !(1..=65536).contains(&args.limit_bytes)
                {
                    return Err(invalid(
                        "text artifact reads require text/plain and limit 1..=65536",
                    ));
                }
                serde_json::to_value(args).map_err(invalid)
            }
            OutputQueryKind::Status => {
                if value != &json!({}) {
                    return Err(invalid("runtime status accepts no arguments"));
                }
                Ok(value.clone())
            }
        }
    }
    async fn query(&self, _value: &Value) -> Result<QuerySnapshot, OperationError> {
        Err(invalid("caller context is required"))
    }
    async fn query_for(
        &self,
        context: &CallContext,
        value: &Value,
    ) -> Result<QuerySnapshot, OperationError> {
        let result = match self.kind {
            OutputQueryKind::List => {
                let args: OutputEventsArguments =
                    serde_json::from_value(value.clone()).map_err(invalid)?;
                self.visible(context, &args.operation_id).await?;
                match &self.source {
                    Some(source) => source
                        .list_outputs(&args)
                        .await
                        .and_then(|v| serde_json::to_value(v).map_err(|e| e.to_string())),
                    None => Err("Historical media store is unavailable".into()),
                }
            }
            OutputQueryKind::Events => {
                let args: OutputEventsArguments =
                    serde_json::from_value(value.clone()).map_err(invalid)?;
                self.visible(context, &args.operation_id).await?;
                (if let Some(source) = &self.source {
                    source.output_events(&args).await
                } else {
                    self.owner
                        .as_ref()
                        .unwrap()
                        .runtime
                        .output_events(&args)
                        .await
                })
                .and_then(|r| serde_json::to_value(r).map_err(|e| e.to_string()))
            }
            OutputQueryKind::Read => {
                let args: ReadOutputArguments =
                    serde_json::from_value(value.clone()).map_err(invalid)?;
                self.visible(context, &args.reference.operation_id).await?;
                (if let Some(source) = &self.source {
                    source.read_output(&args).await
                } else {
                    self.owner
                        .as_ref()
                        .unwrap()
                        .runtime
                        .read_output(&args)
                        .await
                })
                .and_then(|r| serde_json::to_value(r).map_err(|e| e.to_string()))
            }
            OutputQueryKind::View => {
                let args: ViewOutputArguments =
                    serde_json::from_value(value.clone()).map_err(invalid)?;
                validate_view(&args)?;
                let bytes = self.verified_original_for(context, &args.reference).await?;
                let cache = self.previews.clone();
                let view = tokio::task::spawn_blocking(move || {
                    let key = serde_json::to_string(&args).map_err(invalid)?;
                    let mut cache = cache.lock().map_err(invalid)?;
                    if let Some(view) = cache.entries.get(&key) {
                        return Ok(view.clone());
                    }
                    let view = render_preview(&bytes, &args)?;
                    while cache.bytes + view.preview_base64.len() > 8 * 1024 * 1024
                        || cache.entries.len() >= 16
                    {
                        let Some(key) = cache.entries.keys().next().cloned() else {
                            break;
                        };
                        if let Some(old) = cache.entries.remove(&key) {
                            cache.bytes -= old.preview_base64.len();
                        }
                    }
                    cache.bytes += view.preview_base64.len();
                    cache.entries.insert(key, view.clone());
                    Ok::<_, OperationError>(view)
                })
                .await
                .map_err(invalid)??;
                serde_json::to_value(view).map_err(|e| e.to_string())
            }
            OutputQueryKind::ReadText => {
                let args: ReadOutputTextArguments =
                    serde_json::from_value(value.clone()).map_err(invalid)?;
                let bytes = self.verified_original_for(context, &args.reference).await?;
                serde_json::to_value(text_page(&bytes, &args)?).map_err(|e| e.to_string())
            }
            OutputQueryKind::Status => {
                let owner = self.owner.as_ref().unwrap();
                let mut status = owner.runtime.runtime_status();
                if owner.lane.try_lock().is_err() && status.state == "idle" {
                    status.state = "busy".into();
                }
                serde_json::to_value(status).map_err(|e| e.to_string())
            }
        };
        let (status, data, notices) = match result {
            Ok(data) => (QueryStatus::Ready, Some(data), Vec::new()),
            Err(error) => (QueryStatus::Unavailable, None, vec![error]),
        };
        let mut next_reads = Vec::new();
        if let Some(data) = &data {
            let next = match self.kind {
                OutputQueryKind::ReadText => data
                    .get("continuation")
                    .filter(|value| !value.is_null())
                    .cloned()
                    .map(|args| {
                        (
                            "Continue the same immutable UTF-8 text artifact",
                            "output.read_text",
                            args,
                        )
                    }),
                OutputQueryKind::View => data.get("reference").cloned().map(|reference| {
                    (
                        "Read original evidence bytes; the preview is only a presentation",
                        "workspace.read_output",
                        json!({"reference":reference,"offset":0,"limit_bytes":65536}),
                    )
                }),
                OutputQueryKind::Read
                    if data.get("has_more").and_then(Value::as_bool) == Some(true) =>
                {
                    let mut args: ReadOutputArguments =
                        serde_json::from_value(value.clone()).map_err(invalid)?;
                    args.offset += data
                        .get("bytes")
                        .and_then(Value::as_array)
                        .map_or(0, Vec::len) as u64;
                    Some((
                        "Continue original evidence bytes",
                        "workspace.read_output",
                        serde_json::to_value(args).map_err(invalid)?,
                    ))
                }
                OutputQueryKind::List | OutputQueryKind::Events
                    if data.get("has_more").and_then(Value::as_bool) == Some(true) =>
                {
                    let mut args: OutputEventsArguments =
                        serde_json::from_value(value.clone()).map_err(invalid)?;
                    args.after_sequence = data
                        .get("next_sequence")
                        .and_then(Value::as_u64)
                        .unwrap_or(args.after_sequence);
                    Some((
                        "Continue output observations",
                        if matches!(self.kind, OutputQueryKind::List) {
                            "workspace.list_outputs"
                        } else {
                            "workspace.output_events"
                        },
                        serde_json::to_value(args).map_err(invalid)?,
                    ))
                }
                _ => None,
            };
            if let Some((purpose, capability, arguments)) = next {
                next_reads.push(NextRead {
                    purpose: purpose.into(),
                    capability: CapabilityRef::new(capability, 1)?,
                    arguments,
                    missing_identity_fields: vec![],
                });
            }
        }
        let diagnostics = if status == QueryStatus::Unavailable {
            notices
                .iter()
                .map(|notice| OperationError::Unavailable(notice.clone()).diagnostic())
                .collect()
        } else {
            vec![]
        };
        Ok(QuerySnapshot {
            next_reads,
            diagnostics,
            target: TargetRef {
                kind: if self.owner.is_some() {
                    "workspace"
                } else {
                    "project"
                }
                .into(),
                identity: self
                    .owner
                    .as_ref()
                    .map(|o| o.runtime.session_id().to_string())
                    .or_else(|| self.project_root.clone())
                    .unwrap_or_default(),
            },
            source: if matches!(self.kind, OutputQueryKind::Status) {
                "ark/runtime-observation"
            } else {
                "workspace/output-store"
            }
            .into(),
            observed_at_ms: SystemClock.now_ms()?,
            status,
            completeness: ObservationCompleteness::Partial,
            data,
            notices,
        })
    }
}
fn invalid(error: impl std::fmt::Display) -> OperationError {
    OperationError::InvalidInput(error.to_string())
}

#[async_trait]
pub trait WorkspaceOutputs: Send + Sync {
    async fn verified_original(&self, _reference: &MediaReference) -> Result<Arc<[u8]>, String> {
        Err("Verified original output reads are unavailable".into())
    }
    async fn output_events(&self, args: &OutputEventsArguments) -> Result<OutputEvents, String>;
    async fn read_output(&self, args: &ReadOutputArguments) -> Result<OutputPage, String>;
    async fn list_outputs(&self, args: &OutputEventsArguments) -> Result<MediaPage, String>;
}

#[derive(Default)]
struct PreviewCache {
    entries: std::collections::BTreeMap<String, OutputView>,
    bytes: usize,
}
fn validate_view(args: &ViewOutputArguments) -> Result<(), OperationError> {
    if !(1..=2400).contains(&args.max_edge) {
        return Err(invalid("preview max_edge must be 1..=2400 pixels"));
    }
    if !matches!(
        args.reference.mime_type.as_str(),
        "image/png" | "image/jpeg" | "image/svg+xml"
    ) {
        return Err(invalid("view supports PNG, JPEG and static SVG originals"));
    }
    if args
        .crop
        .as_ref()
        .is_some_and(|crop| crop.width == 0 || crop.height == 0)
    {
        return Err(invalid("crop dimensions must be positive"));
    }
    Ok(())
}
fn checked_crop(
    args: &ViewOutputArguments,
    width: u32,
    height: u32,
) -> Result<ImageCrop, OperationError> {
    let crop = args.crop.clone().unwrap_or(ImageCrop {
        x: 0,
        y: 0,
        width,
        height,
    });
    if crop.width == 0
        || crop.height == 0
        || crop
            .x
            .checked_add(crop.width)
            .is_none_or(|right| right > width)
        || crop
            .y
            .checked_add(crop.height)
            .is_none_or(|bottom| bottom > height)
    {
        return Err(invalid("crop lies outside original dimensions"));
    }
    Ok(crop)
}
fn scaled_dimensions(width: u32, height: u32, edge: u32) -> (u32, u32) {
    let scale = (f64::from(edge) / f64::from(width.max(height))).min(1.0);
    (
        (f64::from(width) * scale).round().max(1.0) as u32,
        (f64::from(height) * scale).round().max(1.0) as u32,
    )
}
fn media_digest(bytes: &[u8]) -> String {
    use sha2::Digest;
    format!("sha256:{:x}", sha2::Sha256::digest(bytes))
}
fn render_preview(bytes: &[u8], args: &ViewOutputArguments) -> Result<OutputView, OperationError> {
    use base64::Engine;
    use image::{DynamicImage, ImageFormat};
    validate_view(args)?;
    let rasterized = args.reference.mime_type == "image/svg+xml";
    let mut transformations = Vec::new();
    let (mut preview, original_width, original_height, crop) = if rasterized {
        let mut options = resvg::usvg::Options::default();
        options.resources_dir = None;
        options.image_href_resolver.resolve_string = Box::new(|_, _| None);
        options.fontdb_mut().load_system_fonts();
        // usvg/resvg supports static SVG only; the string resolver cannot read files or URLs.
        let tree = resvg::usvg::Tree::from_data(bytes, &options).map_err(invalid)?;
        let width = tree.size().width().ceil() as u32;
        let height = tree.size().height().ceil() as u32;
        let crop = checked_crop(args, width, height)?;
        let (pw, ph) = scaled_dimensions(crop.width, crop.height, args.max_edge);
        let mut pixmap = resvg::tiny_skia::Pixmap::new(pw, ph)
            .ok_or_else(|| invalid("preview dimensions cannot be allocated"))?;
        let sx = pw as f32 / crop.width as f32;
        let sy = ph as f32 / crop.height as f32;
        let transform = resvg::tiny_skia::Transform::from_row(
            sx,
            0.0,
            0.0,
            sy,
            -(crop.x as f32) * sx,
            -(crop.y as f32) * sy,
        );
        resvg::render(&tree, transform, &mut pixmap.as_mut());
        // tiny-skia is premultiplied RGBA; PNG serialization converts it back correctly.
        let encoded = pixmap.encode_png().map_err(invalid)?;
        let image =
            image::load_from_memory_with_format(&encoded, ImageFormat::Png).map_err(invalid)?;
        transformations.push("Static SVG rasterized to PNG; scripts and external file/network resources are disabled. Text uses installed fonts.".into());
        (image, width, height, crop)
    } else {
        let format = if args.reference.mime_type == "image/png" {
            ImageFormat::Png
        } else {
            ImageFormat::Jpeg
        };
        let mut reader = image::ImageReader::with_format(std::io::Cursor::new(bytes), format);
        let mut limits = image::Limits::default();
        limits.max_image_width = Some(32768);
        limits.max_image_height = Some(32768);
        limits.max_alloc = Some(128 * 1024 * 1024);
        reader.limits(limits);
        let image = reader.decode().map_err(invalid)?;
        let width = image.width();
        let height = image.height();
        let crop = checked_crop(args, width, height)?;
        let image = image.crop_imm(crop.x, crop.y, crop.width, crop.height);
        let (pw, ph) = scaled_dimensions(crop.width, crop.height, args.max_edge);
        (
            image.resize_exact(pw, ph, image::imageops::FilterType::Lanczos3),
            width,
            height,
            crop,
        )
    };
    if args.crop.is_some() {
        transformations.push("Cropped using zero-based original pixel coordinates.".into());
    }
    let mut reduced = false;
    let encoded = loop {
        let mut encoded = std::io::Cursor::new(Vec::new());
        preview
            .write_to(&mut encoded, ImageFormat::Png)
            .map_err(invalid)?;
        let encoded = encoded.into_inner();
        if encoded.len() <= 512 * 1024 {
            break encoded;
        }
        if preview.width() == 1 && preview.height() == 1 {
            return Err(OperationError::BudgetExceeded(
                "PNG preview cannot fit the 512 KiB encoding budget".into(),
            ));
        }
        let width = ((preview.width() as f64) * 0.8).floor().max(1.0) as u32;
        let height = ((preview.height() as f64) * 0.8).floor().max(1.0) as u32;
        preview = DynamicImage::ImageRgba8(image::imageops::resize(
            &preview.to_rgba8(),
            width,
            height,
            image::imageops::FilterType::Lanczos3,
        ));
        reduced = true;
    };
    if reduced {
        transformations.push("Preview dimensions were reduced until lossless PNG encoding fit 512 KiB; the original is unchanged.".into());
    }
    if preview.width() != crop.width || preview.height() != crop.height {
        transformations.push(
            "Preview was resampled; use a smaller original-coordinate crop for finer detail."
                .into(),
        );
    }
    Ok(OutputView {
        reference: args.reference.clone(),
        original_width,
        original_height,
        scale_x: f64::from(preview.width()) / f64::from(crop.width),
        scale_y: f64::from(preview.height()) / f64::from(crop.height),
        crop,
        preview_width: preview.width(),
        preview_height: preview.height(),
        preview_mime_type: "image/png".into(),
        preview_sha256: media_digest(&encoded),
        preview_byte_size: encoded.len() as u64,
        preview_base64: base64::engine::general_purpose::STANDARD.encode(encoded),
        rasterized,
        transformations,
    })
}
fn text_page(
    bytes: &[u8],
    args: &ReadOutputTextArguments,
) -> Result<OutputTextPage, OperationError> {
    if args.reference.mime_type != "text/plain" || !(1..=65536).contains(&args.limit_bytes) {
        return Err(invalid("text/plain output and limit 1..=65536 required"));
    }
    let text = std::str::from_utf8(bytes).map_err(invalid)?;
    let start = usize::try_from(args.offset).map_err(invalid)?;
    if start > text.len() || !text.is_char_boundary(start) {
        return Err(invalid("text offset must be a valid UTF-8 boundary"));
    }
    let mut end = (start + args.limit_bytes as usize).min(text.len());
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    if end == start && start < text.len() {
        return Err(OperationError::BudgetExceeded(
            "limit_bytes cannot hold the next UTF-8 character; increase it to at least 4".into(),
        ));
    }
    loop {
        let continuation = (end < text.len()).then(|| ReadOutputTextArguments {
            reference: args.reference.clone(),
            offset: end as u64,
            limit_bytes: args.limit_bytes,
        });
        let page = OutputTextPage {
            reference: args.reference.clone(),
            encoding: "utf-8".into(),
            byte_start: start as u64,
            byte_end: end as u64,
            text: text[start..end].into(),
            complete: continuation.is_none(),
            limit_reason: continuation.as_ref().map(|_| "utf8_byte_budget".into()),
            continuation,
        };
        if serde_json::to_vec(&page).map_err(invalid)?.len() <= 65536 {
            return Ok(page);
        }
        end = start + (end - start) / 2;
        while !text.is_char_boundary(end) {
            end -= 1;
        }
        if end == start {
            return Err(OperationError::BudgetExceeded(
                "text identity exceeds the page budget".into(),
            ));
        }
    }
}

#[cfg(test)]
mod media_tests {
    use super::*;
    use base64::Engine;
    fn reference(bytes: &[u8], mime: &str) -> MediaReference {
        MediaReference {
            operation_id: OperationId::new("op-media-test").unwrap(),
            sequence: 1,
            mime_type: mime.into(),
            byte_size: bytes.len() as u64,
            sha256: media_digest(bytes),
            display_id: None,
        }
    }
    fn args(bytes: &[u8], mime: &str) -> ViewOutputArguments {
        ViewOutputArguments {
            reference: reference(bytes, mime),
            crop: None,
            max_edge: 1600,
        }
    }
    fn encoded_image(format: image::ImageFormat) -> Vec<u8> {
        let image = image::DynamicImage::ImageRgb8(image::RgbImage::from_fn(80, 40, |x, y| {
            image::Rgb([x as u8, y as u8, 50])
        }));
        let mut bytes = std::io::Cursor::new(Vec::new());
        image.write_to(&mut bytes, format).unwrap();
        bytes.into_inner()
    }
    #[test]
    fn png_jpeg_previews_crop_and_validate_original_dimensions() {
        for (format, mime) in [
            (image::ImageFormat::Png, "image/png"),
            (image::ImageFormat::Jpeg, "image/jpeg"),
        ] {
            let bytes = encoded_image(format);
            let mut args = args(&bytes, mime);
            args.crop = Some(ImageCrop {
                x: 10,
                y: 5,
                width: 20,
                height: 10,
            });
            let preview = render_preview(&bytes, &args).unwrap();
            assert_eq!((preview.original_width, preview.original_height), (80, 40));
            assert_eq!((preview.preview_width, preview.preview_height), (20, 10));
            assert!(!preview.rasterized);
            let png = base64::engine::general_purpose::STANDARD
                .decode(preview.preview_base64)
                .unwrap();
            assert_eq!(media_digest(&png), preview.preview_sha256);
            assert!(png.len() <= 512 * 1024);
            args.crop = Some(ImageCrop {
                x: 79,
                y: 0,
                width: 2,
                height: 1,
            });
            assert!(render_preview(&bytes, &args).is_err());
        }
    }
    #[test]
    fn svg_is_static_cropped_and_external_images_are_unreadable() {
        let svg=br##"<svg xmlns="http://www.w3.org/2000/svg" width="100" height="50"><script>throw new Error('must never run')</script><image href="file:///not-permitted/secret.png" width="100" height="50"/><rect x="50" y="0" width="50" height="50" fill="#ff0000"/></svg>"##;
        let mut args = args(svg, "image/svg+xml");
        args.crop = Some(ImageCrop {
            x: 50,
            y: 0,
            width: 50,
            height: 50,
        });
        let preview = render_preview(svg, &args).unwrap();
        assert!(preview.rasterized);
        let png = base64::engine::general_purpose::STANDARD
            .decode(preview.preview_base64)
            .unwrap();
        let pixels = image::load_from_memory(&png).unwrap().to_rgba8();
        assert_eq!(pixels.get_pixel(25, 25).0, [255, 0, 0, 255]);
        assert_eq!(preview.reference, args.reference);
    }
    #[test]
    fn noisy_preview_adapts_dimensions_to_actual_encoded_byte_budget() {
        let mut state = 17u32;
        let image = image::RgbImage::from_fn(1800, 1200, |_, _| {
            let mut channels = [0; 3];
            for channel in &mut channels {
                state = state.wrapping_mul(1664525).wrapping_add(1013904223);
                *channel = (state >> 24) as u8;
            }
            image::Rgb(channels)
        });
        let mut original = std::io::Cursor::new(Vec::new());
        image::DynamicImage::ImageRgb8(image)
            .write_to(&mut original, image::ImageFormat::Png)
            .unwrap();
        let bytes = original.into_inner();
        let args = args(&bytes, "image/png");
        let preview = render_preview(&bytes, &args).unwrap();
        assert!(preview.preview_byte_size <= 512 * 1024);
        assert!(preview.preview_width < 1600);
        assert!(
            preview
                .transformations
                .iter()
                .any(|text| text.contains("512 KiB"))
        );
        assert_eq!(preview.reference.sha256, media_digest(&bytes));
    }
    #[test]
    fn invalid_images_and_out_of_bounds_previews_are_explicit_errors() {
        assert!(render_preview(b"not png", &args(b"not png", "image/png")).is_err());
        assert!(render_preview(b"not svg", &args(b"not svg", "image/svg+xml")).is_err());
        let bytes = encoded_image(image::ImageFormat::Png);
        let mut args = args(&bytes, "image/png");
        args.max_edge = 2401;
        assert!(render_preview(&bytes, &args).is_err());
    }
    #[test]
    fn help_text_is_utf8_and_json_bounded_without_rerendering() {
        let text = "😀\\\"\n".repeat(20000);
        let bytes = text.as_bytes();
        let mut args = ReadOutputTextArguments {
            reference: reference(bytes, "text/plain"),
            offset: 0,
            limit_bytes: 65536,
        };
        let mut collected = String::new();
        let mut pages = 0;
        loop {
            let page = text_page(bytes, &args).unwrap();
            assert!(serde_json::to_vec(&page).unwrap().len() <= 65536);
            collected.push_str(&page.text);
            pages += 1;
            match page.continuation {
                Some(next) => args = next,
                None => break,
            }
        }
        assert!(pages > 1);
        assert_eq!(collected, text);
        args.offset = 1;
        assert!(text_page(bytes, &args).is_err());
    }
}

#[cfg(test)]
mod media_authority_tests {
    use super::*;
    struct Records(OperationRecord);
    #[async_trait]
    impl OperationRecords for Records {
        async fn get(&self, id: &str) -> Result<Option<OperationRecord>, String> {
            Ok((id == self.0.operation.operation_id.as_str()).then(|| self.0.clone()))
        }
        async fn successful_outputs(
            &self,
            _: &str,
            _: &CapabilityRef,
            _: Option<&str>,
            _: usize,
        ) -> Result<rho_operation::OperationOutputPage, String> {
            Err("not used".into())
        }
    }
    struct Originals {
        reference: MediaReference,
        bytes: Arc<[u8]>,
        reads: std::sync::atomic::AtomicUsize,
    }
    #[async_trait]
    impl WorkspaceOutputs for Originals {
        async fn verified_original(&self, reference: &MediaReference) -> Result<Arc<[u8]>, String> {
            self.reads.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            if reference != &self.reference {
                return Err("identity mismatch".into());
            }
            Ok(self.bytes.clone())
        }
        async fn output_events(&self, _: &OutputEventsArguments) -> Result<OutputEvents, String> {
            Err("not used".into())
        }
        async fn read_output(&self, _: &ReadOutputArguments) -> Result<OutputPage, String> {
            Err("not used".into())
        }
        async fn list_outputs(&self, _: &OutputEventsArguments) -> Result<MediaPage, String> {
            Err("not used".into())
        }
    }
    fn fixture() -> (WorkspaceOutputHandler, CallContext, Arc<Originals>) {
        let caller = CallerIdentity {
            kind: CallerKind::Human,
            id: "owner".into(),
        };
        let context = CallContext {
            caller: caller.clone(),
            principal: None,
            scopes: BTreeSet::from([WORKSPACE_READ_SCOPE.into()]),
            connection_id: "test".into(),
            correlation_id: None,
            causation_id: None,
            trace_parent: None,
        };
        let bytes: Arc<[u8]> = Arc::from(&b"text evidence"[..]);
        let reference = MediaReference {
            operation_id: OperationId::new("op-authority").unwrap(),
            sequence: 1,
            mime_type: "text/plain".into(),
            byte_size: bytes.len() as u64,
            sha256: media_digest(&bytes),
            display_id: None,
        };
        let record = OperationRecord {
            operation: Operation {
                operation_id: reference.operation_id.clone(),
                client_request_id: "request".into(),
                caller,
                principal: None,
                capability: CapabilityRef::new("workspace.run_r", 1).unwrap(),
                domain: "workspace".into(),
                target: TargetRef {
                    kind: "workspace".into(),
                    identity: "session".into(),
                },
                normalized_arguments: json!({}),
                invocation_digest: "digest".into(),
                idempotency_scope: Some("/project".into()),
                preconditions: vec![],
                potential_effects: BTreeSet::new(),
                correlation_id: "test".into(),
                causation_id: None,
                trace_parent: None,
                accepted_at_ms: 1,
            },
            status: OperationStatus::Succeeded,
            outcome: Some(OperationOutcome::Succeeded),
            output: None,
            error: None,
            recovery: None,
            cancellation_requested: false,
            updated_at_ms: 1,
        };
        let source = Arc::new(Originals {
            reference,
            bytes,
            reads: std::sync::atomic::AtomicUsize::new(0),
        });
        (
            WorkspaceOutputHandler::with_store(
                None,
                Some(source.clone()),
                Some("/project".into()),
                Arc::new(Records(record)),
                OutputQueryKind::ReadText,
            ),
            context,
            source,
        )
    }
    #[tokio::test]
    async fn original_port_checks_principal_project_scope_before_reading() {
        let (mut owner, context, source) = fixture();
        assert_eq!(
            &*owner
                .verified_original_for(&context, &source.reference)
                .await
                .unwrap(),
            b"text evidence"
        );
        let mut stranger = context.clone();
        stranger.caller.id = "stranger".into();
        assert!(
            owner
                .verified_original_for(&stranger, &source.reference)
                .await
                .is_err()
        );
        let mut denied = context.clone();
        denied.scopes.clear();
        assert!(matches!(
            owner
                .verified_original_for(&denied, &source.reference)
                .await,
            Err(OperationError::AccessDenied { .. })
        ));
        owner.project_root = Some("/different".into());
        assert!(
            owner
                .verified_original_for(&context, &source.reference)
                .await
                .is_err()
        );
        assert_eq!(source.reads.load(std::sync::atomic::Ordering::SeqCst), 1);
    }
}
