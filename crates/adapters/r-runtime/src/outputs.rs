use base64::{
    Engine, alphabet,
    engine::{DecodePaddingMode, GeneralPurpose, GeneralPurposeConfig},
};
use rho_contract::{
    MediaReference, OperationId, OutputEvent, OutputEvents, OutputEventsArguments, OutputPage,
    ReadOutputArguments,
};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    fs::{File, OpenOptions},
    io::{Read, Write},
    path::{Path, PathBuf},
};

const MAX_LOG: usize = 1024 * 1024;
const MAX_MEDIA: usize = 16 * 1024 * 1024;
const MAX_RUN_MEDIA: usize = 32 * 1024 * 1024;

pub struct OutputStore {
    root: PathBuf,
}
pub struct OutputWriter {
    directory: PathBuf,
    file: File,
    id: OperationId,
    sequence: u64,
    bytes: usize,
    media_bytes: usize,
    truncated: bool,
}

impl OutputStore {
    pub fn open(root: &Path, project: &str) -> Result<Self, String> {
        let root = root
            .join("outputs")
            .join(format!("{:x}", Sha256::digest(project.as_bytes())));
        std::fs::create_dir_all(&root).map_err(err)?;
        Ok(Self {
            root: root.canonicalize().map_err(err)?,
        })
    }
    fn directory(&self, id: &OperationId) -> PathBuf {
        self.root
            .join(format!("{:x}", Sha256::digest(id.as_str().as_bytes())))
    }
    pub fn begin(&self, id: &OperationId) -> Result<OutputWriter, String> {
        let directory = self.directory(id);
        std::fs::create_dir(&directory).map_err(err)?;
        let file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(directory.join("events.jsonl"))
            .map_err(err)?;
        let mut writer = OutputWriter {
            directory,
            file,
            id: id.clone(),
            sequence: 0,
            bytes: 0,
            media_bytes: 0,
            truncated: false,
        };
        writer.event("observation_start", None, None)?;
        Ok(writer)
    }
    fn log(&self, id: &OperationId) -> Result<(Vec<OutputEvent>, bool), String> {
        let directory = self.directory(id);
        let path = self.checked(&directory, "events.jsonl")?;
        let mut bytes = Vec::new();
        File::open(path)
            .map_err(err)?
            .take((MAX_LOG + 32768) as u64)
            .read_to_end(&mut bytes)
            .map_err(err)?;
        if bytes.len() > MAX_LOG + 16384 {
            return Err("output observation log exceeded its bound".into());
        }
        let mut events = Vec::new();
        let mut gap = false;
        let mut previous = 0;
        for line in bytes.split(|b| *b == b'\n').filter(|b| !b.is_empty()) {
            match serde_json::from_slice::<OutputEvent>(line) {
                Ok(event) if event.operation_id == *id && event.sequence > previous => {
                    gap |= event.sequence != previous + 1;
                    previous = event.sequence;
                    events.push(event);
                }
                _ => {
                    gap = true;
                    break;
                }
            }
        }
        Ok((events, gap))
    }
    fn checked(&self, directory: &Path, name: &str) -> Result<PathBuf, String> {
        if self.root.canonicalize().map_err(err)? != self.root
            || directory.canonicalize().map_err(err)? != directory
        {
            return Err("output storage identity changed".into());
        }
        let path = directory.join(name);
        let metadata = std::fs::symlink_metadata(&path)
            .map_err(|e| format!("Original output is unavailable: {e}"))?;
        if !metadata.is_file() || metadata.file_type().is_symlink() {
            return Err("output content must be a regular file".into());
        }
        Ok(path)
    }
    pub fn events(&self, args: &OutputEventsArguments) -> Result<OutputEvents, String> {
        let (all, mut gap) = self.log(&args.operation_id)?;
        gap |= args.after_sequence > all.last().map_or(0, |e| e.sequence);
        let truncated = all.iter().any(|e| e.kind == "truncated");
        let mut events: Vec<_> = all
            .into_iter()
            .filter(|e| e.sequence > args.after_sequence)
            .take(args.limit as usize + 1)
            .collect();
        let has_more = events.len() > args.limit as usize;
        events.truncate(args.limit as usize);
        let next_sequence = events.last().map_or(args.after_sequence, |e| e.sequence);
        Ok(OutputEvents {
            operation_id: args.operation_id.clone(),
            events,
            next_sequence,
            has_more,
            truncated,
            gap,
            notices: if gap {
                vec!["Output observation contains a gap or incomplete record; consult the Operation for execution status.".into()]
            } else {
                Vec::new()
            },
        })
    }
    pub fn read(&self, args: &ReadOutputArguments) -> Result<OutputPage, String> {
        let (events, _) = self.log(&args.reference.operation_id)?;
        if !events
            .iter()
            .any(|e| e.media.as_ref() == Some(&args.reference))
        {
            return Err("media reference does not match the original observation".into());
        }
        let path = self.checked(
            &self.directory(&args.reference.operation_id),
            &format!("{}.bin", args.reference.sequence),
        )?;
        let mut bytes = Vec::new();
        File::open(path)
            .map_err(err)?
            .take((MAX_MEDIA + 1) as u64)
            .read_to_end(&mut bytes)
            .map_err(err)?;
        if bytes.len() > MAX_MEDIA
            || bytes.len() as u64 != args.reference.byte_size
            || digest(&bytes) != args.reference.sha256
        {
            return Err("original media bytes no longer match the output reference".into());
        }
        let start = usize::try_from(args.offset).map_err(err)?;
        if start > bytes.len() {
            return Err("output offset exceeds original byte size".into());
        }
        let end = (start + args.limit_bytes as usize).min(bytes.len());
        Ok(OutputPage {
            reference: args.reference.clone(),
            offset: args.offset,
            bytes: bytes[start..end].to_vec(),
            has_more: end < bytes.len(),
        })
    }
}
impl OutputWriter {
    fn event(
        &mut self,
        kind: &str,
        text: Option<String>,
        media: Option<MediaReference>,
    ) -> Result<(), String> {
        self.sequence += 1;
        let event = OutputEvent {
            operation_id: self.id.clone(),
            sequence: self.sequence,
            kind: kind.into(),
            text,
            media,
            observed_at_ms: super::now_ms(),
        };
        let mut bytes = serde_json::to_vec(&event).map_err(err)?;
        bytes.push(b'\n');
        self.file.write_all(&bytes).map_err(err)?;
        self.file.flush().map_err(err)?;
        self.bytes += bytes.len();
        Ok(())
    }
    fn truncate(&mut self, reason: &str) -> Result<(), String> {
        if !self.truncated {
            self.truncated = true;
            self.event("truncated", Some(reason.into()), None)?;
        }
        Ok(())
    }
    pub fn stream(&mut self, kind: &str, text: &str) -> Result<(), String> {
        let mut remaining = text;
        while !remaining.is_empty() {
            if self.truncated {
                return Ok(());
            }
            if self.bytes >= MAX_LOG || self.sequence >= 4095 {
                return self.truncate("Output observation reached its 1 MiB / 4096 event bound; further output was omitted.");
            }
            let mut end = remaining.len().min(4096);
            while !remaining.is_char_boundary(end) {
                end -= 1;
            }
            self.event(kind, Some(remaining[..end].into()), None)?;
            remaining = &remaining[end..];
        }
        Ok(())
    }
    pub fn display(&mut self, value: &Value) -> Result<Option<MediaReference>, String> {
        if self.truncated {
            return Ok(None);
        }
        let data = &value["data"];
        let mime = ["image/png", "image/jpeg", "image/svg+xml"]
            .into_iter()
            .find(|m| data[*m].is_string());
        let Some(mime) = mime else {
            if let Some(text) = data["text/plain"].as_str() {
                self.stream("display_text", text)?;
            }
            if let Some(map) = data.as_object() {
                let unsupported: Vec<_> =
                    map.keys().filter(|m| *m != "text/plain").cloned().collect();
                if !unsupported.is_empty() {
                    self.stream(
                        "unsupported",
                        &format!("Unsupported display format: {}", unsupported.join(", ")),
                    )?;
                }
            }
            return Ok(None);
        };
        let encoded = data[mime].as_str().unwrap();
        if encoded.len() > MAX_MEDIA * 4 / 3 + 4 {
            self.truncate("Media exceeded the 16 MiB image bound.")?;
            return Ok(None);
        }
        let bytes = if mime == "image/svg+xml" {
            encoded.as_bytes().to_vec()
        } else {
            GeneralPurpose::new(
                &alphabet::STANDARD,
                GeneralPurposeConfig::new()
                    .with_decode_padding_mode(DecodePaddingMode::Indifferent),
            )
            .decode(encoded)
            .map_err(err)?
        };
        if bytes.len() > MAX_MEDIA || self.media_bytes + bytes.len() > MAX_RUN_MEDIA {
            self.truncate("Media exceeded the 16 MiB image / 32 MiB run bound.")?;
            return Ok(None);
        }
        if self.bytes >= MAX_LOG || self.sequence >= 4095 {
            self.truncate("Output event limit reached; image was omitted.")?;
            return Ok(None);
        }
        let reference = MediaReference {
            operation_id: self.id.clone(),
            sequence: self.sequence + 1,
            mime_type: mime.into(),
            byte_size: bytes.len() as u64,
            sha256: digest(&bytes),
            display_id: value["transient"]["display_id"]
                .as_str()
                .map(|s| s.chars().take(160).collect()),
        };
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(self.directory.join(format!("{}.bin", reference.sequence)))
            .map_err(err)?;
        file.write_all(&bytes).map_err(err)?;
        file.sync_all().map_err(err)?;
        self.media_bytes += bytes.len();
        self.event("media", None, Some(reference.clone()))?;
        Ok(Some(reference))
    }
    pub fn finish(&mut self) -> Result<(), String> {
        self.file.sync_all().map_err(err)
    }
}
fn digest(bytes: &[u8]) -> String {
    format!("sha256:{:x}", Sha256::digest(bytes))
}
fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn media_identity_survives_reopen_and_never_uses_a_filename() {
        let temp = tempfile::tempdir().unwrap();
        let store = OutputStore::open(temp.path(), "project").unwrap();
        let id = OperationId::new("op-one").unwrap();
        let mut writer = store.begin(&id).unwrap();
        writer.stream("stdout", "中文输出").unwrap();
        let first=writer.display(&serde_json::json!({"data":{"image/svg+xml":"<svg/>"},"transient":{"display_id":"same"}})).unwrap().unwrap();
        let second=writer.display(&serde_json::json!({"data":{"image/svg+xml":"<svg>different</svg>"},"transient":{"display_id":"same"}})).unwrap().unwrap();
        assert_ne!(first.sequence, second.sequence);
        writer.finish().unwrap();
        drop(store);
        let store = OutputStore::open(temp.path(), "project").unwrap();
        let args = ReadOutputArguments {
            reference: first,
            offset: 0,
            limit_bytes: 65536,
        };
        assert_eq!(store.read(&args).unwrap().bytes, b"<svg/>");
        assert!(
            OutputStore::open(temp.path(), "other")
                .unwrap()
                .read(&args)
                .is_err()
        );
        std::fs::remove_file(
            store
                .directory(&id)
                .join(format!("{}.bin", args.reference.sequence)),
        )
        .unwrap();
        assert!(store.read(&args).is_err());
        assert!(
            store
                .read(&ReadOutputArguments {
                    reference: second,
                    offset: 0,
                    limit_bytes: 65536
                })
                .is_ok()
        );
    }
    #[test]
    fn ark_unpadded_png_and_padded_jpeg_are_readable() {
        let temp = tempfile::tempdir().unwrap();
        let store = OutputStore::open(temp.path(), "project").unwrap();
        let mut writer = store
            .begin(&OperationId::new("op-padding").unwrap())
            .unwrap();
        assert!(
            writer
                .display(&serde_json::json!({"data":{"image/png":"aGVsbG8"}}))
                .unwrap()
                .is_some()
        );
        assert!(
            writer
                .display(&serde_json::json!({"data":{"image/jpeg":"aGVsbG8="}}))
                .unwrap()
                .is_some()
        );
    }
    #[test]
    fn truncation_and_incomplete_tail_are_explicit() {
        let temp = tempfile::tempdir().unwrap();
        let store = OutputStore::open(temp.path(), "project").unwrap();
        let id = OperationId::new("op-limit").unwrap();
        let mut writer = store.begin(&id).unwrap();
        writer.stream("stdout", &"中".repeat(MAX_LOG)).unwrap();
        let args = OutputEventsArguments {
            operation_id: id.clone(),
            after_sequence: 0,
            limit: 100,
        };
        let page = store.events(&args).unwrap();
        assert!(page.truncated && page.has_more);
        writer.file.write_all(b"{incomplete").unwrap();
        assert!(store.events(&args).unwrap().gap);
    }
}
