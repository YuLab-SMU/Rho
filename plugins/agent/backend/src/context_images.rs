//! Capture only explicitly included public image resources; never follow history.
use crate::{
    manifest,
    metadata::{Failure, Metadata, decode},
    native_selection::{query, require},
};
use base64::{Engine, engine::general_purpose::STANDARD};
use rho_agent_owner::{AgentContextImage, MAX_CONTEXT_IMAGE_BYTES};
use rho_plugin_sdk::{HostCallClient, protocol::*};
use serde_json::json;
use std::io::Cursor;

fn validate_image(bytes: &[u8], mime: &str) -> Result<(), Failure> {
    let format = match mime {
        "image/png" => image::ImageFormat::Png,
        "image/jpeg" => image::ImageFormat::Jpeg,
        _ => return Err(Failure::invalid("Context resources must be PNG or JPEG")),
    };
    if image::guess_format(bytes).ok() != Some(format) {
        return Err(Failure::invalid(
            "Context image bytes differ from their format",
        ));
    }
    let mut limits = image::Limits::default();
    limits.max_image_width = Some(16384);
    limits.max_image_height = Some(16384);
    limits.max_alloc = Some(64 * 1024 * 1024);
    let reader = || {
        let mut r = image::ImageReader::with_format(Cursor::new(bytes), format);
        r.limits(limits.clone());
        r
    };
    let (width, height) = reader()
        .into_dimensions()
        .map_err(|_| Failure::invalid("Context image dimensions are invalid"))?;
    if width == 0 || height == 0 || u64::from(width) * u64::from(height) * 8 > 64 * 1024 * 1024 {
        return Err(Failure::invalid(
            "Context image exceeds the decoding budget",
        ));
    }
    reader()
        .decode()
        .map_err(|_| Failure::invalid("Context image is damaged or exceeds the decoding budget"))?;
    Ok(())
}
pub(crate) async fn capture(
    metadata: &Metadata,
    call: &PluginCall,
    host: &HostCallClient,
    owner: &InstanceRef,
    resources: &[ResourceReference],
    remaining: usize,
) -> Result<Vec<(AgentContextImage, Vec<u8>)>, Failure> {
    if resources.len() > remaining {
        return Err(Failure::invalid(
            "Select at most two context images per Send",
        ));
    }
    if resources.is_empty() {
        return Ok(vec![]);
    }
    require(
        metadata,
        call,
        &manifest::key("resources.read"),
        &["resources.read".into()].into(),
    )?;
    let mut captured = vec![];
    for resource in resources {
        ResourceRead {
            reference: resource.clone(),
            offset: 0,
            limit: 65536,
        }
        .validate()
        .map_err(|e| Failure::invalid(&e.to_string()))?;
        if &resource.owner != owner
            || !(1..=MAX_CONTEXT_IMAGE_BYTES).contains(&resource.bytes)
            || !matches!(resource.media_type.as_str(), "image/png" | "image/jpeg")
        {
            return Err(Failure::invalid(
                "Context images must belong to the exact source and be PNG/JPEG up to 2 MiB; the draft is retained",
            ));
        }
        let mut bytes = Vec::with_capacity(resource.bytes as usize);
        while (bytes.len() as u64) < resource.bytes {
            let offset = bytes.len() as u64;
            let read = ResourceRead {
                reference: resource.clone(),
                offset,
                limit: 65536,
            };
            let chunk: ResourceChunk = decode(
                &query(
                    host,
                    &call.request,
                    manifest::key("resources.read"),
                    json!(read),
                )
                .await?,
            )?;
            let expected = (resource.bytes - offset).min(65536) as usize;
            let next =
                (offset + (expected as u64) < resource.bytes).then_some(offset + expected as u64);
            if chunk.reference != *resource
                || chunk.offset != offset
                || chunk.next != next
                || chunk.base64.len() > expected.div_ceil(3) * 4
            {
                return Err(Failure::invalid(
                    "Context resource range differs from its exact identity",
                ));
            }
            let part = STANDARD
                .decode(chunk.base64)
                .map_err(|_| Failure::invalid("Invalid context image encoding"))?;
            if part.len() != expected {
                return Err(Failure::invalid("Context image resource is incomplete"));
            }
            bytes.extend_from_slice(&part);
        }
        let image = AgentContextImage {
            reference: json!(resource),
            sha256: resource.digest.to_string(),
            mime_type: resource.media_type.clone(),
            bytes: resource.bytes,
        };
        image.verify(&bytes)?;
        validate_image(&bytes, &image.mime_type)?;
        captured.push((image, bytes));
    }
    Ok(captured)
}
