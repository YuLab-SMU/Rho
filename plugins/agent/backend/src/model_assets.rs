//! Rho uploads use the existing component asset repository. Transfer buffers
//! contain no draft or execution state, and attachment bytes never enter an Operation.
use crate::{
    metadata::{Failure, Metadata, decode, encoded, now},
    native_uploads::{Progress, Transfer, Uploads},
};
use base64::{Engine, engine::general_purpose::STANDARD};
use rho_agent_api::{AgentAsset, AgentContextSelection, AgentControllerRef, component::*};
use rho_agent_engine::AgentModelImage;
use rho_agent_owner::component::ComponentTaskError;
use rho_plugin_sdk::protocol::{PluginCall, PluginViewCaller};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::collections::BTreeSet;

const TEXT_BYTES: u64 = 32 * 1024;
const IMAGE_BYTES: u64 = 2 * 1024 * 1024;

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct Upload {
    #[schemars(length(min = 36, max = 36))]
    pub request_id: String,
    #[schemars(length(min = 1, max = 160))]
    pub conversation_id: String,
    #[schemars(length(min = 1, max = 240))]
    pub name: String,
    /// The browser selects one of the supported representations before transfer.
    #[schemars(length(min = 1, max = 128))]
    pub mime_type: String,
    #[schemars(range(max = 2097152))]
    pub bytes: u64,
    #[schemars(length(min = 64, max = 64))]
    pub sha256: String,
}
#[derive(Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct Chunk {
    pub upload: Upload,
    pub offset: u64,
    #[schemars(length(max = 87384))]
    pub data: String,
}
#[derive(Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct Finish {
    pub upload: Upload,
}
#[derive(Serialize, Deserialize, JsonSchema)]
pub struct Assets {
    pub conversation_id: String,
    #[schemars(length(max = 64))]
    pub assets: Vec<AgentAsset>,
}
#[derive(Serialize, Deserialize, JsonSchema)]
pub struct Imported {
    pub conversation_id: String,
    pub asset: AgentAsset,
}

fn image(mime: &str) -> bool {
    matches!(mime, "image/png" | "image/jpeg")
}
impl Transfer for Upload {
    fn id(&self) -> &str {
        &self.request_id
    }
    fn bytes(&self) -> u64 {
        self.bytes
    }
    fn sha256(&self) -> &str {
        &self.sha256
    }
    fn validate(&self) -> Result<(), Failure> {
        if uuid::Uuid::parse_str(&self.request_id)
            .ok()
            .is_none_or(|id| id.to_string() != self.request_id)
            || self.conversation_id.is_empty()
            || self.conversation_id.len() > 160
            || self.name.is_empty()
            || self.name.len() > 240
            || self
                .name
                .chars()
                .any(|c| c.is_control() || c == '/' || c == '\\')
            || !(image(&self.mime_type) || self.mime_type == "text/plain")
            || self.bytes
                > if image(&self.mime_type) {
                    IMAGE_BYTES
                } else {
                    TEXT_BYTES
                }
            || self.sha256.len() != 64
            || !self
                .sha256
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        {
            return Err(Failure::invalid(
                "Rho attachments require an exact identity: UTF-8 text up to 32 KiB, or PNG/JPEG up to 2 MiB",
            ));
        }
        Ok(())
    }
}
impl Upload {
    fn asset(&self) -> AgentAsset {
        AgentAsset {
            asset_id: self.request_id.clone(),
            name: self.name.clone(),
            mime_type: self.mime_type.clone(),
            bytes: self.bytes,
            sha256: self.sha256.clone(),
        }
    }
}
fn validate_bytes(asset: &AgentAsset, bytes: &[u8]) -> Result<(), Failure> {
    if asset.bytes != bytes.len() as u64 || asset.sha256 != format!("{:x}", Sha256::digest(bytes)) {
        return Err(Failure::invalid(
            "Attachment bytes differ from their original identity",
        ));
    }
    if image(&asset.mime_type) {
        let valid = bytes.len() as u64 <= IMAGE_BYTES
            && if asset.mime_type == "image/png" {
                bytes.starts_with(b"\x89PNG\r\n\x1a\n") && bytes.get(12..16) == Some(b"IHDR")
            } else {
                bytes.starts_with(&[0xff, 0xd8, 0xff]) && bytes.ends_with(&[0xff, 0xd9])
            };
        if !valid {
            return Err(Failure::invalid(
                "The attachment bytes do not match their image format or size",
            ));
        }
    } else if asset.mime_type != "text/plain"
        || bytes.len() as u64 > TEXT_BYTES
        || std::str::from_utf8(bytes).is_err()
        || bytes.contains(&0)
    {
        return Err(Failure::invalid(
            "Text attachments require UTF-8 without binary content, up to 32 KiB",
        ));
    }
    Ok(())
}

#[derive(Default)]
pub struct ModelAssets {
    uploads: Uploads<Upload>,
}
impl ModelAssets {
    fn controller(
        metadata: &Metadata,
        upload: &Upload,
        caller: PluginViewCaller,
    ) -> Result<AgentControllerRef, Failure> {
        upload.validate()?;
        let controller = metadata.actor(caller, now()).window().clone();
        let conversation = metadata
            .owner
            .store
            .component_conversation(&metadata.scope, &upload.conversation_id)?
            .ok_or(ComponentTaskError::NotFound)?;
        if conversation.controller != controller || conversation.archived {
            return Err(Failure::invalid(
                "The attachment's original Rho task controller is no longer editable",
            ));
        }
        Ok(controller)
    }
    pub fn stage(
        &self,
        metadata: &Metadata,
        call: &PluginCall,
        caller: PluginViewCaller,
    ) -> Result<Value, Failure> {
        let input: Chunk = decode(&call.arguments)?;
        let controller = Self::controller(metadata, &input.upload, caller)?;
        if input.data.len() > 87384 {
            return Err(Failure::invalid("Attachment chunk exceeds its byte limit"));
        }
        let bytes = STANDARD
            .decode(input.data)
            .map_err(|_| Failure::invalid("Invalid attachment chunk encoding"))?;
        let progress: Progress<Upload> =
            self.uploads
                .stage(input.upload, controller, input.offset, &bytes)?;
        encoded(progress)
    }
    pub fn finish(
        &self,
        metadata: &Metadata,
        call: &PluginCall,
        caller: PluginViewCaller,
    ) -> Result<Value, Failure> {
        let input: Finish = decode(&call.arguments)?;
        let controller = Self::controller(metadata, &input.upload, caller.clone())?;
        let upload = input.upload;
        let asset = upload.asset();
        match metadata.owner.store.component_asset(
            &metadata.scope,
            &upload.conversation_id,
            &upload.request_id,
        ) {
            Ok((original, _)) => {
                if original.asset_id != asset.asset_id
                    || original.name != asset.name
                    || original.mime_type != asset.mime_type
                    || original.bytes != asset.bytes
                    || original.sha256 != asset.sha256
                {
                    return Err(Failure::invalid("The original attachment identity changed"));
                }
                self.uploads.discard(&upload, &controller)?;
                return encoded(Imported {
                    conversation_id: upload.conversation_id,
                    asset: original,
                });
            }
            Err(ComponentTaskError::NotFound) => {}
            Err(error) => return Err(error.into()),
        }
        let bytes = self.uploads.take(&upload, &controller)?;
        validate_bytes(&asset, &bytes)?;
        let at = now();
        metadata.owner.put_asset(
            &metadata.actor(caller, at),
            &upload.conversation_id,
            &asset,
            &bytes,
            at,
        )?;
        encoded(Imported {
            conversation_id: upload.conversation_id,
            asset,
        })
    }
}

pub fn list(metadata: &Metadata, call: &PluginCall) -> Result<Value, Failure> {
    let args: crate::arguments::Conversation = decode(&call.arguments)?;
    if args.conversation_id.is_empty() || args.conversation_id.len() > 160 {
        return Err(Failure::invalid("Invalid conversation identity"));
    }
    encoded(Assets {
        assets: metadata
            .owner
            .store
            .component_assets(&metadata.scope, &args.conversation_id)?,
        conversation_id: args.conversation_id,
    })
}

#[derive(Default)]
pub struct Captured {
    pub sources: Vec<ComponentSourceSnapshot>,
    pub images: Vec<AgentModelImage>,
}
pub fn capture(metadata: &Metadata, request: &ComponentAgentStart) -> Result<Captured, Failure> {
    let ids = request.assets.as_deref().unwrap_or(&[]);
    if ids.len() + request.sources.len() > 16 {
        return Err(Failure::invalid(
            "At most 16 context sources and attachments can be included",
        ));
    }
    let mut captured = Captured::default();
    let mut seen = BTreeSet::new();
    for id in ids {
        if !seen.insert(id) {
            return Err(Failure::invalid("The same attachment was selected twice"));
        }
        let (asset, bytes) =
            metadata
                .owner
                .store
                .component_asset(&metadata.scope, &request.conversation_id, id)?;
        validate_bytes(&asset, &bytes)?;
        let uri = format!(
            "rho://attachments/component/{}/{}",
            request.conversation_id, id
        );
        let is_image = image(&asset.mime_type);
        let text = if is_image {
            captured.images.push(AgentModelImage {
                label: uri.clone(),
                mime_type: asset.mime_type.clone(),
                base64: STANDARD.encode(&bytes),
            });
            format!(
                "User-uploaded image {}. Its immutable attachment identity is retained with this turn. Image bytes are supplied only when this attachment is explicitly selected for the current Send.",
                asset.name
            )
        } else {
            String::from_utf8(bytes)
                .map_err(|_| Failure::invalid("Attachment text must use UTF-8"))?
        };
        captured.sources.push(ComponentSourceSnapshot {
            selection: AgentContextSelection { source: "attachments".into(), label: asset.name.clone(), reference: json!({"conversation_id":request.conversation_id,"asset_id":asset.asset_id,"sha256":asset.sha256}), inclusion: if is_image { "image" } else { "text" }.into() },
            title: asset.name.clone(), description: "User-uploaded attachment".into(), text,
            native_data: json!({"origin":"user_upload","uri":uri,"attachment":asset}), truncated: false, observations: vec![],
            evidence: vec![ComponentAgentEvidence::Attachment { conversation_id: request.conversation_id.clone(), asset }],
        });
    }
    if captured.images.len() > 2 {
        return Err(Failure::invalid(
            "Select at most two images for one Rho Send",
        ));
    }
    Ok(captured)
}

pub fn validate_images(
    metadata: &Metadata,
    settings: &rho_agent_api::ComponentModelSettings,
    images: &[AgentModelImage],
) -> Result<(), Failure> {
    if images.len() > 2 {
        return Err(Failure::invalid(
            "Select at most two images across attachments and context for one Rho Send",
        ));
    }
    if images.is_empty() {
        return Ok(());
    }
    let connection = settings
        .connection
        .as_ref()
        .ok_or_else(|| Failure::invalid("Configure a model before sending images"))?;
    let digest = rho_agent_owner::component::component_digest(connection)?;
    let latest = metadata
        .owner
        .store
        .component_diagnostics(&metadata.scope)?
        .into_iter()
        .find(|d| {
            d.kind == rho_agent_api::ComponentModelTestKind::Images && d.connection_digest == digest
        });
    if latest.is_none_or(|d| d.state != rho_agent_api::ComponentModelTestState::Passed) {
        return Err(Failure::invalid(
            "Image input is not verified for this model; run Test image input first. The draft is retained",
        ));
    }
    Ok(())
}
