use crate::{
    arguments::*,
    manifest,
    metadata::{Failure, Metadata, decode, encoded, now},
    sources,
};
use base64::{Engine, engine::general_purpose::STANDARD};
use rho_annotation_api::*;
use rho_annotation_owner::{ImportedCapture, sha256};
use rho_plugin_sdk::{HostCallClient, protocol::*};
use serde_json::Value;
use std::io::Cursor;

const CHUNK_BYTES: u32 = 64 * 1024;
const DECODE_BYTES: u64 = 64 * 1024 * 1024;

fn dimensions(bytes: &[u8], mime_type: &str) -> Result<(u32, u32), Failure> {
    let format = match mime_type {
        "image/png" => image::ImageFormat::Png,
        "image/jpeg" => image::ImageFormat::Jpeg,
        _ => return Err(Failure::invalid("Captures must be PNG or JPEG")),
    };
    if image::guess_format(bytes).ok() != Some(format) {
        return Err(Failure::invalid(
            "Capture bytes differ from the declared image format",
        ));
    }
    let mut limits = image::Limits::default();
    limits.max_image_width = Some(16384);
    limits.max_image_height = Some(16384);
    limits.max_alloc = Some(DECODE_BYTES);
    let reader = || {
        let mut reader = image::ImageReader::with_format(Cursor::new(bytes), format);
        reader.limits(limits.clone());
        reader
    };
    let size = reader().into_dimensions().map_err(Failure::invalid)?;
    // Reserve up to eight bytes per pixel before allocating a decoded image.
    // Decoder allocation limits are additional best-effort limits, not an OS sandbox.
    if size.0 == 0 || size.1 == 0 || u64::from(size.0) * u64::from(size.1) * 8 > DECODE_BYTES {
        return Err(Failure::invalid(
            "Capture decoded dimensions exceed the image budget",
        ));
    }
    let decoded = reader().decode().map_err(|_| {
        Failure::invalid("Captured image is damaged or exceeds the decoding budget")
    })?;
    if (decoded.width(), decoded.height()) != size {
        return Err(Failure::invalid("Capture dimensions changed during decode"));
    }
    Ok(size)
}

pub async fn import(
    metadata: &Metadata,
    call: &PluginCall,
    host: &HostCallClient,
    caller: &PluginViewCaller,
) -> Result<Value, Failure> {
    let input: CaptureImport = decode(&call.arguments)?;
    ResourceRead {
        reference: input.reference.clone(),
        offset: 0,
        limit: CHUNK_BYTES,
    }
    .validate()
    .map_err(Failure::invalid)?;
    if input.reference.bytes == 0
        || input.reference.bytes > MAX_ANNOTATION_CAPTURE_BYTES as u64
        || !matches!(
            input.reference.media_type.as_str(),
            "image/png" | "image/jpeg"
        )
    {
        return Err(Failure::invalid(
            "Capture resources must be PNG/JPEG and at most 8 MiB",
        ));
    }
    sources::require(
        metadata,
        call,
        &manifest::key("resources.read"),
        &["resources.read".into()].into(),
    )?;
    let actor = metadata.actor(caller);
    let identity = encoded(&input.reference)?;
    if let Some(receipt) =
        metadata
            .owner
            .replay_capture_import(&actor, &input.request_id, &identity)?
    {
        return encoded(receipt);
    }
    let mut bytes = Vec::with_capacity(input.reference.bytes as usize);
    while (bytes.len() as u64) < input.reference.bytes {
        let offset = bytes.len() as u64;
        let read = ResourceRead {
            reference: input.reference.clone(),
            offset,
            limit: CHUNK_BYTES,
        };
        let chunk: ResourceChunk = decode(
            &sources::query(host, call, manifest::key("resources.read"), encoded(read)?).await?,
        )?;
        let expected = (input.reference.bytes - offset).min(CHUNK_BYTES as u64) as usize;
        let next = (offset + (expected as u64) < input.reference.bytes)
            .then_some(offset + expected as u64);
        if chunk.reference != input.reference
            || chunk.offset != offset
            || chunk.next != next
            || chunk.base64.len() > expected.div_ceil(3) * 4
        {
            return Err(Failure::invalid(
                "Capture resource range differs from its exact reference",
            ));
        }
        let part = STANDARD
            .decode(chunk.base64)
            .map_err(|_| Failure::invalid("Invalid capture encoding"))?;
        if part.len() != expected {
            return Err(Failure::invalid("Capture resource range is incomplete"));
        }
        bytes.extend_from_slice(&part);
    }
    if sha256(&bytes) != input.reference.digest.as_str() {
        return Err(Failure::invalid(
            "Capture resource digest does not match its bytes",
        ));
    }
    let (width, height) = dimensions(&bytes, &input.reference.media_type)?;
    if sources::caller(metadata, call, host).await? != *caller {
        return Err(Failure::invalid(
            "The original caller changed before capture admission",
        ));
    }
    encoded(metadata.owner.import_capture(
        &actor,
        &input.request_id,
        &identity,
        ImportedCapture {
            mime_type: &input.reference.media_type,
            width,
            height,
            bytes: &bytes,
        },
        now(),
    )?)
}

pub fn read(metadata: &Metadata, input: CaptureRead) -> Result<Value, Failure> {
    if input.limit == 0 || input.limit > CHUNK_BYTES {
        return Err(Failure::invalid("Capture reads hold 1..=65536 bytes"));
    }
    let (capture, bytes) = metadata
        .owner
        .capture(&metadata.scope, &input.capture.capture_id)?;
    if capture != input.capture || input.offset > bytes.len() as u64 {
        return Err(Failure::invalid(
            "Capture read differs from the retained image or range",
        ));
    }
    let start = input.offset as usize;
    let end = (start + input.limit as usize).min(bytes.len());
    encoded(CaptureChunk {
        capture,
        offset: input.offset,
        base64: STANDARD.encode(&bytes[start..end]),
        next: (end < bytes.len()).then_some(end as u64),
    })
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    pub(crate) fn png() -> Vec<u8> {
        let mut bytes = Cursor::new(Vec::new());
        image::RgbImage::from_pixel(3, 2, image::Rgb([30, 90, 180]))
            .write_to(&mut bytes, image::ImageFormat::Png)
            .unwrap();
        bytes.into_inner()
    }
    #[test]
    fn captures_decode_bytes_and_refuse_corruption_or_false_media_type() {
        let png = png();
        assert_eq!(dimensions(&png, "image/png").unwrap(), (3, 2));
        assert!(dimensions(&png, "image/jpeg").is_err());
        assert!(dimensions(&png[..png.len() / 2], "image/png").is_err());
        assert!(dimensions(b"not an image", "image/png").is_err());
        let mut jpeg = Cursor::new(Vec::new());
        image::RgbImage::from_pixel(3, 2, image::Rgb([90, 30, 180]))
            .write_to(&mut jpeg, image::ImageFormat::Jpeg)
            .unwrap();
        assert_eq!(dimensions(jpeg.get_ref(), "image/jpeg").unwrap(), (3, 2));
    }
}

/// A labeled captured view from a contributed source; retained separately from source media.
pub async fn upload(metadata: &Metadata, call: &PluginCall, host: &HostCallClient,
    caller: &PluginViewCaller) -> Result<Value, Failure> {
    let input: CaptureUpload = decode(&call.arguments)?;
    if input.base64.is_empty() || input.base64.len() > 768 * 1024 {
        return Err(Failure::invalid("Captured view exceeds the 576 KiB PNG limit"));
    }
    sources::window(caller, &input.reference.window)?;
    let bytes = STANDARD.decode(&input.base64).map_err(Failure::invalid)?;
    let (width, height) = dimensions(&bytes, "image/png")?;
    let actor = metadata.actor(caller);
    let identity = serde_json::json!({"reference":input.reference,"inclusion":input.inclusion,
        "sha256":sha256(&bytes),"width":width,"height":height,"kind":"browser_captured_view"});
    if let Some(receipt) = metadata.owner.replay_capture_import(&actor, &input.request_id, &identity)? {
        return encoded(receipt);
    }
    // Validate the exact original contributed source before admitting browser evidence.
    let selection = AnnotationSelection { source:"plugin".into(), label:"Captured view".into(),
        reference:encoded(&input.reference)?, inclusion:serde_json::to_string(&input.inclusion).map_err(Failure::invalid)? };
    sources::freeze(metadata, call, host, &selection, &AnnotationAnchor::WholeItem).await?;
    if sources::caller(metadata, call, host).await? != *caller {
        return Err(Failure::invalid("The source view changed before capture admission"));
    }
    encoded(metadata.owner.import_capture(&actor, &input.request_id, &identity,
        ImportedCapture { mime_type:"image/png", width, height, bytes:&bytes }, now())?)
}
