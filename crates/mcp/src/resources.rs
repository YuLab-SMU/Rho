//! Presentation/resources use authorized Host output reads only; no storage paths.
use super::*;
use base64::{
    Engine,
    engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD},
};
use rho_contract::{
    MediaReference, OutputResourceChunk, OutputResourceManifest, OutputView, ViewOutputArguments,
};
use rho_operation::OperationError;
use rmcp::model::{
    AnnotateAble, Content, ListResourceTemplatesResult, RawResource, RawResourceTemplate,
    ReadResourceResult, ResourceContents,
};

pub(super) fn original_uri(reference: &MediaReference) -> Result<String, OperationError> {
    let token = URL_SAFE_NO_PAD.encode(serde_json::to_vec(reference).map_err(invalid_operation)?);
    Ok(format!(
        "rho-output://{}/{token}",
        if reference.byte_size <= 4 * 1024 * 1024 {
            "original"
        } else {
            "manifest"
        }
    ))
}
fn token_reference(token: &str) -> Result<MediaReference, OperationError> {
    if token.len() > 8192 {
        return Err(invalid_operation("output resource reference is too large"));
    }
    serde_json::from_slice(&URL_SAFE_NO_PAD.decode(token).map_err(invalid_operation)?)
        .map_err(invalid_operation)
}
pub(super) fn templates() -> ListResourceTemplatesResult {
    let mut result = ListResourceTemplatesResult::default();
    for (uri, name, description) in [
        (
            "rho-output://original/{reference}",
            "Original scientific output",
            "Original bytes up to 4 MiB. Obtain a bound reference URI from rho.output.view.",
        ),
        (
            "rho-output://manifest/{reference}",
            "Large original manifest",
            "Original SHA-256 and ordered 64 KiB chunk resource links.",
        ),
        (
            "rho-output://chunk/{offset}/{reference}",
            "Original byte chunk",
            "Read a manifest-provided chunk and verify the assembled original digest.",
        ),
    ] {
        result.resource_templates.push(
            RawResourceTemplate::new(uri, name)
                .with_description(description)
                .no_annotation(),
        );
    }
    result
}
impl McpEdge {
    pub(super) async fn native_view(&self, args: Value) -> Result<CallToolResult, OperationError> {
        let _: ViewOutputArguments =
            serde_json::from_value(args.clone()).map_err(invalid_operation)?;
        let snapshot = self
            .host
            .query_snapshot(
                &self.context,
                QueryRequest {
                    capability: CapabilityRef::new("output.view", 1)?,
                    arguments: args,
                },
            )
            .await?;
        if snapshot.status != rho_contract::QueryStatus::Ready {
            return Ok(CallToolResult::structured_error(json!({"result":snapshot})));
        }
        let view: OutputView = serde_json::from_value(
            snapshot
                .data
                .clone()
                .ok_or_else(|| invalid_operation("output view omitted its data"))?,
        )
        .map_err(invalid_operation)?;
        let uri = original_uri(&view.reference)?;
        let resource = RawResource::new(
            uri,
            format!(
                "{} output {}",
                view.reference.operation_id.as_str(),
                view.reference.sequence
            ),
        )
        .with_mime_type(if view.reference.byte_size <= 4 * 1024 * 1024 {
            view.reference.mime_type.clone()
        } else {
            "application/json".into()
        })
        .with_description(
            "Immutable original scientific evidence; preview transformations do not replace it.",
        );
        let mut result = CallToolResult::structured(json!({"result":snapshot}));
        // The image is native MCP content; avoid duplicate base64 in structured JSON/text.
        if let Some(data) = result
            .structured_content
            .as_mut()
            .and_then(|value| value.get_mut("result"))
            .and_then(|value| value.get_mut("data"))
            .and_then(Value::as_object_mut)
        {
            data.remove("preview_base64");
        }
        let metadata = result.structured_content.clone().unwrap();
        result.content = vec![
            Content::image(view.preview_base64, view.preview_mime_type),
            Content::resource_link(resource),
            Content::text(serde_json::to_string(&metadata).map_err(invalid_operation)?),
        ];
        Ok(result)
    }
    pub(super) async fn read_output_resource(
        &self,
        uri: &str,
    ) -> Result<ReadResourceResult, OperationError> {
        let rest = uri
            .strip_prefix("rho-output://")
            .ok_or_else(|| invalid_operation("unknown resource scheme"))?;
        let parts: Vec<_> = rest.split('/').collect();
        let (kind, offset, token) = match parts.as_slice() {
            ["original", token] => ("original", 0, *token),
            ["manifest", token] => ("manifest", 0, *token),
            ["chunk", offset, token] => (
                "chunk",
                offset.parse::<usize>().map_err(invalid_operation)?,
                *token,
            ),
            _ => return Err(invalid_operation("invalid output resource URI")),
        };
        let reference = token_reference(token)?;
        let bytes = self.host.verified_output(&self.context, &reference).await?;
        let content = resource_content(uri, kind, offset, token, reference, &bytes)?;
        Ok(ReadResourceResult::new(vec![content]))
    }
}

fn resource_content(
    uri: &str,
    kind: &str,
    offset: usize,
    token: &str,
    reference: MediaReference,
    bytes: &[u8],
) -> Result<ResourceContents, OperationError> {
    let content = match kind {
        "original" => {
            if bytes.len() > 4 * 1024 * 1024 {
                return Err(OperationError::BudgetExceeded(
                    "Use the original manifest and its 64 KiB chunks".into(),
                ));
            }
            ResourceContents::blob(STANDARD.encode(&bytes), uri)
                .with_mime_type(reference.mime_type.clone())
        }
        "manifest" => {
            let chunks = (0..bytes.len())
                .step_by(65536)
                .map(|offset| OutputResourceChunk {
                    uri: format!("rho-output://chunk/{offset}/{token}"),
                    offset: offset as u64,
                    byte_size: (bytes.len() - offset).min(65536) as u32,
                })
                .collect();
            let manifest=OutputResourceManifest{reference,chunk_bytes:65536,chunks,verification:"Concatenate chunks in offset order; assembled UTF-8-independent raw bytes must match reference.byte_size and reference.sha256.".into()};
            ResourceContents::text(
                serde_json::to_string(&manifest).map_err(invalid_operation)?,
                uri,
            )
            .with_mime_type("application/json")
        }
        _ => {
            if offset % 65536 != 0 || offset >= bytes.len() {
                return Err(invalid_operation(
                    "chunk offset must be an existing aligned manifest position",
                ));
            }
            ResourceContents::blob(
                STANDARD.encode(&bytes[offset..(offset + 65536).min(bytes.len())]),
                uri,
            )
            .with_mime_type("application/octet-stream")
        }
    };

    Ok(content)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn reference(size: usize) -> MediaReference {
        MediaReference {
            operation_id: OperationId::new("op-resource").unwrap(),
            sequence: 2,
            mime_type: "image/png".into(),
            byte_size: size as u64,
            sha256: "sha256:expected-original-digest".into(),
            display_id: Some("图".into()),
        }
    }
    #[test]
    fn large_original_manifest_chunks_reassemble_exact_bytes() {
        let bytes = (0..4 * 1024 * 1024 + 173)
            .map(|index| (index % 251) as u8)
            .collect::<Vec<_>>();
        let reference = reference(bytes.len());
        let uri = original_uri(&reference).unwrap();
        assert!(uri.starts_with("rho-output://manifest/"));
        let token = uri.rsplit('/').next().unwrap();
        assert_eq!(token_reference(token).unwrap(), reference);
        assert!(
            resource_content("unused", "original", 0, token, reference.clone(), &bytes).is_err()
        );
        let manifest =
            resource_content(&uri, "manifest", 0, token, reference.clone(), &bytes).unwrap();
        let ResourceContents::TextResourceContents { text, .. } = manifest else {
            panic!("manifest must be JSON text")
        };
        let manifest: OutputResourceManifest = serde_json::from_str(&text).unwrap();
        assert_eq!(manifest.reference, reference);
        assert_eq!(manifest.chunk_bytes, 65536);
        let mut reassembled = Vec::new();
        for chunk in manifest.chunks {
            let content = resource_content(
                &chunk.uri,
                "chunk",
                chunk.offset as usize,
                token,
                reference.clone(),
                &bytes,
            )
            .unwrap();
            let ResourceContents::BlobResourceContents { blob, .. } = content else {
                panic!("chunk must be blob")
            };
            let data = STANDARD.decode(blob).unwrap();
            assert_eq!(data.len(), chunk.byte_size as usize);
            assert!(data.len() <= 65536);
            reassembled.extend(data);
        }
        assert_eq!(reassembled, bytes);
        assert!(resource_content("unused", "chunk", 1, token, reference.clone(), &bytes).is_err());
        assert!(
            resource_content("unused", "chunk", bytes.len(), token, reference, &bytes).is_err()
        );
    }
    #[test]
    fn small_original_is_complete_blob_without_path_tokens() {
        let reference = reference(3);
        let uri = original_uri(&reference).unwrap();
        assert!(uri.starts_with("rho-output://original/"));
        let content = resource_content(&uri, "original", 0, "unused", reference, b"abc").unwrap();
        let ResourceContents::BlobResourceContents { blob, .. } = content else {
            panic!("original must be blob")
        };
        assert_eq!(STANDARD.decode(blob).unwrap(), b"abc");
        assert!(token_reference("../private").is_err());
        assert!(token_reference(&"a".repeat(8193)).is_err());
    }
}
