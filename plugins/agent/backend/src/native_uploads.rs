//! Bounded transient browser transfer. Finish goes through the task's owner;
//! chunks are neither durable task records nor scientific Operations.
use crate::metadata::Failure;
use rho_agent_api::{AgentControllerRef, AgentTaskControl};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    sync::Mutex,
    time::{Duration, Instant},
};

pub const CHUNK_BYTES: usize = 64 * 1024;
const TOTAL_BYTES: u64 = 32 * 1024 * 1024;
const MAX_FILES: usize = 16;
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct Upload {
    #[schemars(length(min = 36, max = 36))]
    pub request_id: String,
    pub control: AgentTaskControl,
    #[schemars(length(min = 1, max = 240))]
    pub name: String,
    #[schemars(length(min = 1, max = 128))]
    pub mime_type: String,
    #[schemars(range(max = 8388608))]
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
pub struct Progress<T = Upload> {
    pub upload: T,
    pub received: u64,
    pub complete: bool,
}
struct Staged<T> {
    upload: T,
    controller: AgentControllerRef,
    bytes: Vec<u8>,
    touched: Instant,
}
pub(crate) struct Uploads<T = Upload>(Mutex<BTreeMap<String, Staged<T>>>);
impl<T> Default for Uploads<T> {
    fn default() -> Self {
        Self(Mutex::new(BTreeMap::new()))
    }
}
/// Transfer identity only. Each task owner checks its own controller before
/// staging or finishing; this buffer never supplies task authority.
pub(crate) trait Transfer: Clone + PartialEq {
    fn validate(&self) -> Result<(), Failure>;
    fn id(&self) -> &str;
    fn bytes(&self) -> u64;
    fn sha256(&self) -> &str;
}
impl Upload {
    pub fn validate(&self) -> Result<(), Failure> {
        if uuid::Uuid::parse_str(&self.request_id)
            .ok()
            .is_none_or(|id| id.to_string() != self.request_id)
            || self.control.task_id.is_empty()
            || self.control.task_id.len() > 160
            || self.name.is_empty()
            || self.name.len() > 240
            || self
                .name
                .chars()
                .any(|c| c.is_control() || c == '/' || c == '\\')
            || self.mime_type.is_empty()
            || self.mime_type.len() > 128
            || !self.mime_type.is_ascii()
            || self.mime_type.chars().any(char::is_control)
            || self.bytes > 8 * 1024 * 1024
            || self.sha256.len() != 64
            || !self
                .sha256
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        {
            return Err(Failure::invalid(
                "Invalid attachment transfer identity or size",
            ));
        }
        Ok(())
    }
}
impl Transfer for Upload {
    fn validate(&self) -> Result<(), Failure> {
        Upload::validate(self)
    }
    fn id(&self) -> &str {
        &self.request_id
    }
    fn bytes(&self) -> u64 {
        self.bytes
    }
    fn sha256(&self) -> &str {
        &self.sha256
    }
}
impl<T: Transfer> Uploads<T> {
    /// A confirmed owner record makes an identical reselected transfer redundant.
    /// Drop only this descriptor/controller pair, without touching another transfer.
    pub fn discard(&self, upload: &T, controller: &AgentControllerRef) -> Result<(), Failure> {
        let mut entries = self
            .0
            .lock()
            .map_err(|_| Failure::invalid("Attachment staging is unavailable"))?;
        if entries
            .get(upload.id())
            .is_some_and(|entry| &entry.upload == upload && &entry.controller == controller)
        {
            entries.remove(upload.id());
        }
        Ok(())
    }
    pub fn stage(
        &self,
        upload: T,
        controller: AgentControllerRef,
        offset: u64,
        part: &[u8],
    ) -> Result<Progress<T>, Failure> {
        upload.validate()?;
        if offset > upload.bytes()
            || !offset.is_multiple_of(CHUNK_BYTES as u64)
            || part.len() != (upload.bytes() - offset).min(CHUNK_BYTES as u64) as usize
            || (part.is_empty() && upload.bytes() != 0)
        {
            return Err(Failure::invalid(
                "Attachment chunk range differs from its original file",
            ));
        }
        let mut entries = self
            .0
            .lock()
            .map_err(|_| Failure::invalid("Attachment staging is unavailable"))?;
        entries.retain(|_, entry| entry.touched.elapsed() < Duration::from_secs(30 * 60));
        if !entries.contains_key(upload.id()) {
            if offset != 0 {
                return Err(Failure::invalid(
                    "The incomplete upload is no longer staged; reselect its original file",
                ));
            }
            if entries.len() >= MAX_FILES
                || entries.values().map(|e| e.upload.bytes()).sum::<u64>() + upload.bytes()
                    > TOTAL_BYTES
            {
                return Err(Failure::invalid(
                    "Attachment staging is full; finish existing transfers before adding files",
                ));
            }
            entries.insert(
                upload.id().to_owned(),
                Staged {
                    upload: upload.clone(),
                    controller: controller.clone(),
                    bytes: Vec::new(),
                    touched: Instant::now(),
                },
            );
        }
        let entry = entries.get_mut(upload.id()).unwrap();
        if entry.upload != upload || entry.controller != controller {
            return Err(Failure::invalid("The original attachment transfer changed"));
        }
        let offset = offset as usize;
        if offset == entry.bytes.len() {
            entry.bytes.extend_from_slice(part);
        } else if entry.bytes.get(offset..offset + part.len()) != Some(part) {
            return Err(Failure::invalid(
                "The attachment chunk conflicts with its original bytes",
            ));
        }
        entry.touched = Instant::now();
        Ok(Progress {
            received: entry.bytes.len() as u64,
            complete: entry.bytes.len() as u64 == upload.bytes(),
            upload,
        })
    }
    pub fn take(&self, upload: &T, controller: &AgentControllerRef) -> Result<Vec<u8>, Failure> {
        upload.validate()?;
        let mut entries = self
            .0
            .lock()
            .map_err(|_| Failure::invalid("Attachment staging is unavailable"))?;
        let entry = entries.get(upload.id()).ok_or_else(|| Failure::invalid("Inspect the original attachment receipt, or reselect its file to finish the transfer"))?;
        if &entry.upload != upload
            || &entry.controller != controller
            || entry.bytes.len() as u64 != upload.bytes()
        {
            return Err(Failure::invalid(
                "The original attachment transfer is incomplete or changed",
            ));
        }
        let entry = entries.remove(upload.id()).unwrap();
        if format!("{:x}", Sha256::digest(&entry.bytes)) != upload.sha256() {
            return Err(Failure::invalid(
                "Attachment checksum does not match the selected file; no asset was admitted",
            ));
        }
        Ok(entry.bytes)
    }
}
