//! One or two explicitly selected original images; never a screen capture,
//! rendering command or replacement of a producing operation.
use super::*;
pub(super) const TYPES: &[&str] = &["image/png", "image/jpeg", "image/svg+xml"];
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Selection {
    plots: Vec<Source>,
}
#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
enum Inclusion {
    Images {},
    Metadata {},
}
fn annotation_source(plots: &[Source]) -> Result<Value, String> {
    // Order is significant for the explicitly selected comparison. Native
    // session/observation clocks and presentation state are not content versions.
    let lineage = plots
        .iter()
        .map(|p| json!([p.operation, p.sequence]))
        .collect::<Vec<_>>();
    let versions = plots
        .iter()
        .map(|p| &p.reference.digest)
        .collect::<Vec<_>>();
    let digest = |value: &Value| -> Result<String, String> {
        Ok(format!(
            "sha256:{:x}",
            Sha256::digest(serde_json::to_vec(value).map_err(|e| e.to_string())?)
        ))
    };
    Ok(
        json!({"source_id":format!("plots:{}",digest(&json!(lineage))?),"source_version":digest(&json!(versions))?}),
    )
}
pub(super) fn item(
    owner: &InstanceRef,
    window: &WindowId,
    plots: &[Source],
) -> Result<ContextItem, String> {
    check(
        (1..=2).contains(&plots.len()),
        "Select one or two original plots",
    )?;
    let item = ContextItem {
        reference: ContextReference {
            provider: owner.clone(),
            window: window.clone(),
            contribution: ContributionId::new("plots").unwrap(),
            selector: json!({"plots":plots}),
        },
        title: if plots.len() == 1 {
            format!("Plot {}", plots[0].sequence)
        } else {
            "Compare two plots".into()
        },
        description: plots
            .iter()
            .map(|p| {
                format!(
                    "Run {} · output {} · {} bytes",
                    p.operation, p.sequence, p.reference.bytes
                )
            })
            .collect::<Vec<_>>()
            .join("; "),
        kind: "image".into(),
    };
    item.validate().map_err(|e| e.to_string())?;
    Ok(item)
}
impl Owner {
    pub(super) async fn query_plot_context(&self, call: &PluginCall) -> Result<Value, String> {
        let request: PreviewContext = decode(call.arguments.clone())?;
        request.validate().map_err(|e| e.to_string())?;
        check(
            request.reference.provider == self.instance
                && request.reference.contribution.as_str() == "plots",
            "Plot reference belongs to another provider or contribution",
        )?;
        let selection: Selection = decode(request.reference.selector.clone())?;
        let inclusion: Inclusion = decode(request.inclusion.clone())?;
        let item = item(&self.instance, &request.reference.window, &selection.plots)?;
        let mut statuses = vec![];
        let mut resources = vec![];
        let mut seen = std::collections::BTreeSet::new();
        for source in &selection.plots {
            check(
                seen.insert(source.reference.resource.clone()),
                "Select different original plots",
            )?;
            let record = self
                .context_read(
                    call,
                    "operation.get",
                    json!({"operation_id":source.operation}),
                )
                .await?;
            let (original, status) =
                outputs_for(&self.instance, &source.operation, &record["record"], TYPES)?;
            check(
                original.iter().any(|item| json!(item) == json!(source)),
                "Plot selection differs from its original committed output",
            )?;
            if matches!(inclusion, Inclusion::Images {}) {
                check(
                    self.context_grants.resources && call.scopes.contains("resources.read"),
                    "Plot images require the selected resource read grant",
                )?;
                check(
                    ["image/png", "image/jpeg"].contains(&source.reference.media_type.as_str())
                        && (1..=2 * 1024 * 1024).contains(&source.reference.bytes),
                    "Image input supports original PNG/JPEG plots up to 2 MiB each; select metadata for SVG or larger images",
                )?;
                // Consumers verify full bytes/digest and image decoding through
                // the public resource channel before preview or model delivery.
                resources.push(source.reference.clone());
            }
            statuses.push(status);
        }
        let text=selection.plots.iter().zip(&statuses).enumerate().map(|(index,(p,status))|format!(
            "Plot {}: original output {}\nProducing run: {}\nNative R session: {}\nOperation status: {}\nFormat: {} · {} bytes\nOriginal digest: {}\n{}",
            index+1,p.sequence,p.operation,p.session,status,p.reference.media_type,p.reference.bytes,p.reference.digest,
            if resources.is_empty(){"Artifact metadata only; no image content is included."}else{"Original image included; panel zoom, pan and overlays are not captured."}
        )).collect::<Vec<_>>().join("\n\n");
        let (text, truncated) = bounded_text(&text, request.max_bytes as usize);
        let artifacts = selection.plots.iter().enumerate().map(|(index, source)| json!({"label":format!("Plot {}",index+1),"resource":source.reference,"operation":source.operation})).collect::<Vec<_>>();
        let preview = ContextPreview {
            item,
            text,
            truncated,
            data: json!({"inclusion":if resources.is_empty(){"metadata"}else{"images"},"plots":selection.plots,"artifacts":artifacts,"operation_statuses":statuses,"interactive_state":false,
                "annotation_source":annotation_source(&selection.plots)?}),
            resources,
        };
        check(
            preview.item.reference == request.reference,
            "Plot preview changed its original selection",
        )?;
        preview.validate().map_err(|e| e.to_string())?;
        Ok(json!(preview))
    }
}
