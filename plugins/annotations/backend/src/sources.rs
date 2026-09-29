use crate::{
    manifest,
    metadata::{Failure, Metadata, decode},
};
use rho_annotation_api::*;
use rho_annotation_owner::{FrozenEvidence, annotation_digest};
use rho_plugin_sdk::{HostCallClient, protocol::*};
use serde_json::{Value, json};
use std::collections::BTreeSet;

pub(crate) fn require(
    metadata: &Metadata,
    call: &PluginCall,
    capability: &CapabilityKey,
    scopes: &BTreeSet<String>,
) -> Result<(), Failure> {
    if !scopes.is_subset(&call.scopes)
        || !metadata.grants.iter().any(|g| {
            &g.capability == capability
                && scopes.is_subset(&g.scopes)
                && g.scopes.is_subset(&call.scopes)
        })
    {
        return Err(Failure {
            code: "access_denied",
            message:
                "The original caller and annotation instance must both hold the source query grant"
                    .into(),
        });
    }
    Ok(())
}
pub(crate) async fn query(
    host: &HostCallClient,
    call: &PluginCall,
    capability: CapabilityKey,
    arguments: Value,
) -> Result<Value, Failure> {
    let reply = host
        .begin(
            RequestId::new(format!("annotation-read-{}", uuid::Uuid::new_v4())).unwrap(),
            call.request.clone(),
            capability,
            arguments,
        )
        .map_err(|_| Failure::invalid("Annotation source observation capacity is unavailable"))?
        .receive()
        .await
        .map_err(|_| Failure {
            code: "source_unavailable",
            message: "The exact source observation was unavailable; no annotation was written"
                .into(),
        })?;
    if reply["status"] != "ready"
        || reply["completeness"] != "complete"
        || reply.get("data").is_none()
    {
        return Err(Failure::invalid("The source observation is not complete"));
    }
    Ok(reply["data"].clone())
}
pub async fn caller(
    metadata: &Metadata,
    call: &PluginCall,
    host: &HostCallClient,
) -> Result<PluginViewCaller, Failure> {
    let cap = manifest::key("views.caller");
    require(metadata, call, &cap, &["plugins.read".into()].into())?;
    let data = query(host, call, cap, json!({})).await?;
    if data.get("view").is_none() {
        return Err(Failure::invalid("Caller observation has no identity"));
    }
    decode(&data)
}
pub fn window(caller: &PluginViewCaller, window: &WindowId) -> Result<(), Failure> {
    if caller
        .view
        .as_ref()
        .is_some_and(|origin| &origin.window != window)
    {
        return Err(Failure {
            code: "access_denied",
            message: "Annotation source belongs to another window".into(),
        });
    }
    Ok(())
}
pub async fn freeze(
    metadata: &Metadata,
    call: &PluginCall,
    host: &HostCallClient,
    selection: &AnnotationSelection,
    anchor: &AnnotationAnchor,
) -> Result<FrozenEvidence, Failure> {
    let reference: ContextReference = decode(&selection.reference)?;
    let inclusion: Value = serde_json::from_str(&selection.inclusion).map_err(Failure::invalid)?;
    let request = PreviewContext {
        reference: reference.clone(),
        inclusion,
        max_bytes: 16384,
    };
    request.validate().map_err(Failure::invalid)?;
    let inspect = manifest::key("plugins.inspect");
    require(metadata, call, &inspect, &["plugins.read".into()].into())?;
    let inspection: PluginInspection = decode(
        &query(
            host,
            call,
            inspect,
            json!({"revision":reference.provider.revision}),
        )
        .await?,
    )?;
    if inspection.summary.revision != reference.provider.revision
        || inspection.summary.plugin != reference.provider.plugin
        || inspection.manifest.id != reference.provider.plugin
        || !inspection
            .artifacts
            .iter()
            .any(|a| a.id == reference.provider.artifact)
    {
        return Err(Failure::invalid(
            "Source differs from the selected exact package and artifact",
        ));
    }
    let context = inspection
        .manifest
        .contexts
        .iter()
        .find(|c| c.id == reference.contribution)
        .ok_or_else(|| Failure::invalid("This exact package does not declare the context"))?;
    let descriptor = inspection
        .manifest
        .capabilities
        .iter()
        .find(|c| c.capability == context.preview && c.kind == CapabilityKind::Query)
        .ok_or_else(|| Failure::invalid("Context has no declared preview query"))?;
    require(
        metadata,
        call,
        &descriptor.capability,
        &descriptor.required_scopes,
    )?;
    let preview: ContextPreview = decode(
        &query(
            host,
            call,
            descriptor.capability.clone(),
            json!(PluginRequest {
                binding: ProviderBinding {
                    provider: reference.provider.clone(),
                    project: call.binding.project.clone(),
                    capability: descriptor.capability.clone(),
                    target: None
                },
                arguments: json!(request),
                preconditions: Value::Null,
            }),
        )
        .await?,
    )?;
    preview.validate().map_err(Failure::invalid)?;
    if preview.item.reference != reference
        || preview.truncated
        || preview.text.len() > 16384
        || !preview.resources.is_empty()
    {
        return Err(Failure::invalid(
            "Freeze requires a complete bounded text inclusion from the exact source",
        ));
    }
    let identity: AnnotationContextIdentity =
        decode(preview.data.get("annotation_source").ok_or_else(|| {
            Failure::invalid("This source has not supplied an annotation lineage and version")
        })?)?;
    if identity.source_id.is_empty()
        || identity.source_id.len() > 4096
        || identity.source_version.is_empty()
        || identity.source_version.len() > 4096
    {
        return Err(Failure::invalid(
            "Source lineage or version is missing or oversized",
        ));
    }
    let fragment = match anchor {
        AnnotationAnchor::WholeItem | AnnotationAnchor::CapturedView { .. } => preview.text.clone(),
        AnnotationAnchor::TextQuote {
            quote,
            start,
            end,
            unit,
        } => {
            if quoted(&preview.text, *start, *end, *unit) != Some(quote.as_str()) {
                return Err(Failure::invalid(
                    "The quotation does not match this exact inclusion and range",
                ));
            }
            quote.clone()
        }
        _ => {
            return Err(Failure::invalid(
                "This source flow supports whole-item and text-quote anchors",
            ));
        }
    };
    // Namespace owner-supplied lineage without interpreting any scientific selector.
    let source_id = format!(
        "contribution:{}",
        annotation_digest(&json!([
            reference.provider,
            reference.contribution,
            identity.source_id
        ]))?
    );
    Ok(FrozenEvidence {
        source: AnnotationSourceRef {
            owner: AnnotationSourceOwner::Plugin,
            source_id,
            source_version: identity.source_version,
            title: preview.item.title.clone(),
        },
        fragment: json!({"text":fragment,"data":preview.data,"description":preview.item.description,"captured":true}),
        normalized_selection: Some(AnnotationSelection {
            label: preview.item.title,
            ..selection.clone()
        }),
    })
}
fn quoted(text: &str, start: u64, end: u64, unit: AnnotationCharacterUnit) -> Option<&str> {
    let byte = |target| -> Option<usize> {
        let mut position = 0u64;
        for (offset, ch) in text.char_indices() {
            if position == target {
                return Some(offset);
            }
            position = position.checked_add(match unit {
                AnnotationCharacterUnit::Utf8 => ch.len_utf8() as u64,
                AnnotationCharacterUnit::Utf16 => ch.len_utf16() as u64,
                AnnotationCharacterUnit::UnicodeScalar => 1,
            })?;
            if position > target {
                return None;
            }
        }
        (position == target).then_some(text.len())
    };
    text.get(byte(start)?..byte(end)?)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn quote_ranges_preserve_unicode_and_reject_split_characters() {
        assert_eq!(
            quoted("a🧬中z", 1, 3, AnnotationCharacterUnit::Utf16),
            Some("🧬")
        );
        assert_eq!(quoted("a🧬中z", 1, 2, AnnotationCharacterUnit::Utf16), None);
        assert_eq!(
            quoted("a🧬中z", 1, 5, AnnotationCharacterUnit::Utf8),
            Some("🧬")
        );
        assert_eq!(
            quoted("a🧬中z", 1, 3, AnnotationCharacterUnit::UnicodeScalar),
            Some("🧬中")
        );
        assert_eq!(quoted("a", 9, 10, AnnotationCharacterUnit::Utf8), None);
    }
}

// Inclusion is stored as a portable JSON string; key order must not change its receipt identity.
pub(crate) fn canonical(value: Value) -> Value {
    match value {
        Value::Object(map) => Value::Object(
            map.into_iter()
                .map(|(key, value)| (key, canonical(value)))
                .collect::<std::collections::BTreeMap<_, _>>()
                .into_iter()
                .collect(),
        ),
        Value::Array(values) => Value::Array(values.into_iter().map(canonical).collect()),
        other => other,
    }
}
