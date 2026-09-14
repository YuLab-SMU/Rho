//! User attachment reads belong to Application storage, never to scientific output owners.
use super::*;
use base64::{Engine, engine::general_purpose::STANDARD};
use sha2::{Digest, Sha256};

const IMAGE_BYTES: usize = 2 * 1024 * 1024;
const TEXT_BYTES: usize = 32 * 1024;
fn image(mime: &str) -> bool {
    matches!(mime, "image/png" | "image/jpeg")
}
fn validate(name: &str, mime: &str, bytes: &[u8]) -> Result<(), ApplicationError> {
    if name.is_empty() || name.len() > 256 || name.chars().any(char::is_control) {
        return Err(error("Invalid attachment name"));
    }
    if image(mime) {
        if bytes.len() > IMAGE_BYTES {
            return Err(ApplicationError::Budget(
                "Images are limited to 2 MiB each".into(),
            ));
        }
        let valid = if mime == "image/png" {
            bytes.starts_with(b"\x89PNG\r\n\x1a\n") && bytes.get(12..16) == Some(b"IHDR")
        } else {
            bytes.starts_with(&[0xff, 0xd8, 0xff]) && bytes.ends_with(&[0xff, 0xd9])
        };
        if !valid {
            return Err(error(
                "The attachment bytes do not match their image format",
            ));
        }
    } else {
        let extension = name
            .rsplit_once('.')
            .map(|(_, extension)| extension.to_ascii_lowercase())
            .unwrap_or_default();
        if !(mime.starts_with("text/")
            || matches!(
                mime,
                "application/json"
                    | "application/xml"
                    | "application/yaml"
                    | "application/javascript"
            )
            || matches!(
                extension.as_str(),
                "r" | "rmd"
                    | "qmd"
                    | "txt"
                    | "md"
                    | "csv"
                    | "tsv"
                    | "json"
                    | "yaml"
                    | "yml"
                    | "py"
                    | "js"
                    | "ts"
                    | "sql"
                    | "log"
                    | "xml"
                    | "html"
                    | "css"
                    | "sh"
                    | "toml"
                    | "ini"
                    | "tex"
            ))
            || mime.starts_with("image/")
        {
            return Err(error(
                "Rho attachments support UTF-8 text, PNG and JPEG files",
            ));
        }
        if bytes.len() > TEXT_BYTES {
            return Err(ApplicationError::Budget(
                "Text attachments are limited to 32 KiB each".into(),
            ));
        }
        let text =
            std::str::from_utf8(bytes).map_err(|_| error("Text attachments must use UTF-8"))?;
        if text.contains('\0') {
            return Err(error("Binary files cannot be included as text attachments"));
        }
    }
    Ok(())
}
impl ComponentAgentService {
    pub fn add_asset(
        &self,
        host: &NextHost,
        context: &CallContext,
        project: &str,
        window: &ApplicationWindowRef,
        conversation_id: &str,
        asset_id: &str,
        name: &str,
        mime_type: &str,
        data: &str,
    ) -> Result<AgentAsset, ApplicationError> {
        let actor = Self::actor(host, context, project, window)?;
        uuid::Uuid::parse_str(asset_id).map_err(|_| error("Invalid attachment identity"))?;
        if data.len() > IMAGE_BYTES * 4 / 3 + 4 {
            return Err(ApplicationError::Budget(
                "Attachment upload exceeds 2 MiB".into(),
            ));
        }
        let name = name.rsplit(['/', '\\']).next().unwrap_or(name);
        if mime_type.len() > 128 || mime_type.chars().any(char::is_control) {
            return Err(error("Invalid attachment format"));
        }
        let mime = mime_type
            .split(';')
            .next()
            .unwrap_or_default()
            .trim()
            .to_ascii_lowercase();
        let bytes = STANDARD
            .decode(data)
            .map_err(|_| error("Invalid attachment encoding"))?;
        validate(name, &mime, &bytes)?;
        let asset = AgentAsset {
            asset_id: asset_id.into(),
            name: name.into(),
            mime_type: if image(&mime) {
                mime
            } else {
                "text/plain".into()
            },
            bytes: bytes.len() as u64,
            sha256: format!("{:x}", Sha256::digest(&bytes)),
        };
        self.owner
            .put_asset(&actor, conversation_id, &asset, &bytes, now())?;
        Ok(asset)
    }
    pub fn assets(
        &self,
        host: &NextHost,
        context: &CallContext,
        project: &str,
        conversation_id: &str,
    ) -> Result<Vec<AgentAsset>, ApplicationError> {
        self.owner
            .store
            .component_assets(&Self::scope(host, context, project)?, conversation_id)
    }
    pub fn asset(
        &self,
        host: &NextHost,
        context: &CallContext,
        request: &ReadComponentAgentAsset,
    ) -> Result<(AgentAsset, Vec<u8>), ApplicationError> {
        self.owner.store.component_asset(
            &Self::scope(host, context, &request.project_root)?,
            &request.conversation_id,
            &request.asset_id,
        )
    }
    pub fn remove_asset(
        &self,
        host: &NextHost,
        context: &CallContext,
        project: &str,
        window: &ApplicationWindowRef,
        conversation_id: &str,
        asset_id: &str,
        draft_version: u64,
    ) -> Result<ComponentAgentConversation, ApplicationError> {
        let actor = Self::actor(host, context, project, window)?;
        self.owner
            .remove_asset(&actor, conversation_id, asset_id, draft_version, now())?;
        self.conversation(host, context, project, conversation_id)
    }
    pub(super) fn captured_assets(
        &self,
        scope: &ApplicationScope,
        request: &ComponentAgentStart,
    ) -> Result<Vec<(AgentAsset, Vec<u8>)>, ApplicationError> {
        let ids = request.assets.as_deref().unwrap_or(&[]);
        if ids.len() + request.sources.len() > 16 {
            return Err(ApplicationError::Budget(
                "At most 16 context sources and attachments can be included".into(),
            ));
        }
        let mut seen = BTreeSet::new();
        ids.iter()
            .map(|id| {
                if !seen.insert(id) {
                    return Err(error("The same attachment was selected twice"));
                }
                let (asset, bytes) =
                    self.owner
                        .store
                        .component_asset(scope, &request.conversation_id, id)?;
                validate(&asset.name, &asset.mime_type, &bytes)?;
                if asset.bytes != bytes.len() as u64
                    || asset.sha256 != format!("{:x}", Sha256::digest(&bytes))
                {
                    return Err(ApplicationError::Diagnostic(Box::new(Diagnostic {
                        code: DiagnosticCode::ContentChanged,
                        continuation: DiagnosticContinuation::RefreshObservation,
                        message: "Attachment bytes no longer match the captured identity".into(),
                        next_reads: vec![],
                    })));
                }
                Ok((asset, bytes))
            })
            .collect()
    }
}
pub(super) fn include(
    prepared: &mut context::PreparedContext,
    conversation_id: &str,
    assets: Vec<(AgentAsset, Vec<u8>)>,
) -> Result<(), ApplicationError> {
    for (asset, bytes) in assets {
        let uri = format!(
            "rho://attachments/component/{conversation_id}/{}",
            asset.asset_id
        );
        let is_image = image(&asset.mime_type);
        let text = if is_image {
            format!(
                "User-uploaded image {}. Its actual image content is included with this request.",
                asset.name
            )
        } else {
            String::from_utf8(bytes.clone()).map_err(|_| error("Attachment text must use UTF-8"))?
        };
        if is_image {
            prepared.images.push(ComponentImageInput {
                reference: ComponentImageSource::Attachment {
                    conversation_id: conversation_id.into(),
                    asset: asset.clone(),
                },
                mime_type: asset.mime_type.clone(),
                base64: STANDARD.encode(&bytes),
                sha256: format!("sha256:{}", asset.sha256),
            });
        }
        prepared.context.sources.push(ComponentSourceSnapshot {
            selection: AgentContextSelection { source: "attachments".into(), label: asset.name.clone(),
                reference: json!({"conversation_id":conversation_id,"asset_id":asset.asset_id,"sha256":asset.sha256}), inclusion: if is_image { "image" } else { "text" }.into() },
            title: asset.name.clone(), description: "User-uploaded attachment".into(), text,
            native_data: json!({"origin":"user_upload","uri":uri,"attachment":asset}), truncated: false, observations: vec![],
            evidence: vec![ComponentAgentEvidence::Attachment { conversation_id: conversation_id.into(), asset }],
        });
    }
    if prepared.images.len() > 2
        || serde_json::to_vec(&prepared.context).map_err(error)?.len() > 64 * 1024
    {
        return Err(ApplicationError::Budget(
            "Selected context exceeds the text/image budget (64 KiB and two images)".into(),
        ));
    }
    Ok(())
}
