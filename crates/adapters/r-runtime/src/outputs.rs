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
    collections::BTreeMap,
    fs::{File, OpenOptions},
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};

const MAX_LOG: usize = 1024 * 1024;
const MAX_MEDIA: usize = 16 * 1024 * 1024;
const MAX_RUN_MEDIA: usize = 32 * 1024 * 1024;

pub struct OutputStore {
    root: PathBuf,
    verified: Mutex<VerifiedCache>,
}

const VERIFIED_CACHE_BYTES: usize = 64 * 1024 * 1024;
#[derive(Default)]
struct VerifiedCache { entries: BTreeMap<String, VerifiedEntry>, bytes: usize, tick: u64 }
struct VerifiedEntry { identity: FileIdentity, bytes: Arc<[u8]>, used: u64 }
#[derive(PartialEq, Eq)]
struct FileIdentity {
    size: u64,
    modified: Option<std::time::SystemTime>,
    created: Option<std::time::SystemTime>,
    #[cfg(unix)] device: u64,
    #[cfg(unix)] inode: u64,
    #[cfg(unix)] changed: (i64, i64),
}
fn identity(metadata: &std::fs::Metadata) -> FileIdentity {
    #[cfg(unix)] use std::os::unix::fs::MetadataExt;
    FileIdentity {
        size: metadata.len(), modified: metadata.modified().ok(), created: metadata.created().ok(),
        #[cfg(unix)] device: metadata.dev(),
        #[cfg(unix)] inode: metadata.ino(),
        #[cfg(unix)] changed: (metadata.ctime(), metadata.ctime_nsec()),
    }
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
            verified: Mutex::new(VerifiedCache::default()),
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
    /// Verify original identity once, then share immutable bytes across pages and
    /// presentation adapters. A storage mutation invalidates the cached identity.
    /// The lock coalesces concurrent validation of the same original.
    pub fn verified_original(&self, reference: &MediaReference) -> Result<Arc<[u8]>, String> {
        let path = self.checked(&self.directory(&reference.operation_id), &format!("{}.bin", reference.sequence))?;
        let current = identity(&std::fs::metadata(&path).map_err(err)?);
        let key = serde_json::to_string(reference).map_err(err)?;
        let mut cache = self.verified.lock().map_err(err)?;
        cache.tick += 1;
        let tick = cache.tick;
        if let Some(entry) = cache.entries.get_mut(&key) {
            if entry.identity == current { entry.used = tick; return Ok(entry.bytes.clone()); }
        }
        if let Some(entry) = cache.entries.remove(&key) { cache.bytes -= entry.bytes.len(); }
        let (events, _) = self.log(&reference.operation_id)?;
        if !events
            .iter()
            .any(|e| e.media.as_ref() == Some(reference))
        {
            return Err("media reference does not match the original observation".into());
        }
        let mut bytes = Vec::new();
        let file = File::open(&path).map_err(err)?;
        if identity(&file.metadata().map_err(err)?) != current { return Err("output storage changed while opening the original".into()); }
        file
            .take((MAX_MEDIA + 1) as u64)
            .read_to_end(&mut bytes)
            .map_err(err)?;
        if bytes.len() > MAX_MEDIA
            || bytes.len() as u64 != reference.byte_size
            || digest(&bytes) != reference.sha256
            || identity(&std::fs::metadata(&path).map_err(err)?) != current
        {
            return Err("original media bytes no longer match the output reference".into());
        }
        while cache.bytes + bytes.len() > VERIFIED_CACHE_BYTES || cache.entries.len() >= 32 {
            let Some(oldest) = cache.entries.iter().min_by_key(|(_,entry)|entry.used).map(|(key,_)|key.clone()) else {break};
            if let Some(entry) = cache.entries.remove(&oldest) {cache.bytes -= entry.bytes.len();}
        }
        let bytes: Arc<[u8]> = bytes.into();
        cache.bytes += bytes.len();
        cache.entries.insert(key, VerifiedEntry{identity:current,bytes:bytes.clone(),used:tick});
        Ok(bytes)
    }
    pub fn read(&self, args: &ReadOutputArguments) -> Result<OutputPage, String> {
        if !(1..=65536).contains(&args.limit_bytes) { return Err("output page limit must be 1..=65536 bytes".into()); }
        let bytes = self.verified_original(&args.reference)?;
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

    /// Append a rendered help document exactly once after its observation writer
    /// has finished. It is a text artifact and cannot become a plot.
    pub fn append_text(&self, id: &OperationId, text: &str) -> Result<MediaReference, String> {
        if text.len() > MAX_MEDIA { return Err("help text exceeds the 16 MiB artifact bound".into()); }
        let (events, gap) = self.log(id)?;
        if gap { return Err("cannot append help to an incomplete output log".into()); }
        let sha256 = digest(text.as_bytes());
        if let Some(reference) = events.iter().filter(|event|event.kind == "text_artifact").find_map(|event|event.media.as_ref()) {
            if reference.sha256 == sha256 && reference.byte_size == text.len() as u64 { return Ok(reference.clone()); }
            return Err("help artifact already exists with different content".into());
        }
        let directory = self.directory(id);
        let log = self.checked(&directory,"events.jsonl")?;
        let log_size = std::fs::metadata(&log).map_err(err)?.len();
        let media_bytes: u64 = events.iter().filter_map(|event|event.media.as_ref()).map(|reference|reference.byte_size).sum();
        if log_size as usize >= MAX_LOG || events.len() >= 4095 || media_bytes + text.len() as u64 > MAX_RUN_MEDIA as u64 {
            return Err("output budget cannot retain complete help text".into());
        }
        let sequence = events.last().map_or(1,|event|event.sequence+1);
        let reference = MediaReference {operation_id:id.clone(),sequence,mime_type:"text/plain".into(),byte_size:text.len() as u64,sha256,display_id:None};
        let mut file = OpenOptions::new().write(true).create_new(true).open(directory.join(format!("{sequence}.bin"))).map_err(err)?;
        file.write_all(text.as_bytes()).map_err(err)?;
        file.sync_all().map_err(err)?;
        let mut writer = OutputWriter {directory,file:OpenOptions::new().append(true).open(log).map_err(err)?,id:id.clone(),sequence:sequence-1,bytes:log_size as usize,media_bytes:media_bytes as usize,truncated:false};
        writer.event("text_artifact",None,Some(reference.clone()))?;
        writer.finish()?;
        Ok(reference)
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

#[async_trait::async_trait]
impl rho_workspace::WorkspaceOutputs for OutputStore {
    async fn output_events(&self, args: &OutputEventsArguments) -> Result<OutputEvents, String> {
        self.events(args)
    }
    async fn read_output(&self, args: &ReadOutputArguments) -> Result<OutputPage, String> {
        self.read(args)
    }
    async fn list_outputs(
        &self,
        args: &OutputEventsArguments,
    ) -> Result<rho_contract::MediaPage, String> {
        let (events, gap) = self.log(&args.operation_id)?;
        let mut media: Vec<_> = events
            .into_iter()
            .filter(|e| e.sequence > args.after_sequence)
            .filter_map(|e| {
                e.media.map(|reference| rho_contract::MediaSummary {
                    reference,
                    observed_at_ms: e.observed_at_ms,
                })
            })
            .take(args.limit as usize + 1)
            .collect();
        let has_more = media.len() > args.limit as usize;
        media.truncate(args.limit as usize);
        Ok(rho_contract::MediaPage {
            operation_id: args.operation_id.clone(),
            next_sequence: media
                .last()
                .map_or(args.after_sequence, |m| m.reference.sequence),
            media,
            has_more,
            gap,
        })
    }
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
