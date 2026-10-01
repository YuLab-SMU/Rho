//! Bounded inspection and explicit disposal of unpublished capture payloads.
//! The owner must qualify a terminal unsuccessful Core operation, confirmed
//! provider release and the exact preview before invoking disposal.
use super::*;
use rho_r_api::RCaptureMaterial;

pub struct RecoveryAttempt {
    pub material: RCaptureMaterial,
    pub lease: Option<Arc<RecoveryLease>>,
}

impl RecoveryArchive {
    /// Missing archives and attempts remain absent. No directory scan, storage
    /// creation, graph hashing, R startup or recovery happens in this observation.
    pub fn inspect_attempt(
        data_root: &Path,
        scope: RecoveryScope,
        operation: &OperationId,
    ) -> Result<RecoveryAttempt, String> {
        let archive = Self::open(data_root, scope.clone())?;
        let lease = if let Some(archive) = &archive {
            match fs::symlink_metadata(archive.directory(operation)) {
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
                Err(e) => return Err(error(e)),
                Ok(_) => Some(Arc::new(archive.acquire(operation)?)),
            }
        } else {
            None
        };
        let material = if let Some(lease) = &lease {
            lease.capture_material()?
        } else {
            let identity = archive.as_ref().map(|archive| &archive.identity);
            RCaptureMaterial {
                fingerprint: fingerprint(&(data_root, scope, operation, identity))?,
                payload_bytes: None,
                staging_bytes: None,
                capture_metadata_available: false,
            }
        };
        Ok(RecoveryAttempt { material, lease })
    }
}

fn fingerprint(value: &impl Serialize) -> Result<rho_plugin_protocol::ContentDigest, String> {
    let bytes = serde_json::to_vec(value).map_err(error)?;
    rho_plugin_protocol::ContentDigest::new(format!("sha256:{:x}", Sha256::digest(bytes)))
        .map_err(error)
}

#[derive(Serialize, PartialEq, Eq)]
struct Stamp {
    identity: FileIdentity,
    bytes: u64,
    modified: std::time::SystemTime,
    #[cfg(unix)]
    change: (i64, i64),
}
impl Stamp {
    fn from(metadata: &Metadata) -> Result<Self, String> {
        Ok(Self {
            identity: FileIdentity::of(metadata),
            bytes: metadata.len(),
            modified: metadata.modified().map_err(error)?,
            #[cfg(unix)]
            change: {
                use std::os::unix::fs::MetadataExt;
                (metadata.ctime(), metadata.ctime_nsec())
            },
        })
    }
}
fn stamp(path: &Path) -> Result<Option<Stamp>, String> {
    match fs::symlink_metadata(path) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(error(e)),
        Ok(before) => {
            let file = checked_file(path, false)?;
            let before = Stamp::from(&before)?;
            if before != Stamp::from(&file.metadata().map_err(error)?)? {
                return Err("Capture material changed while it was observed".into());
            }
            Ok(Some(before))
        }
    }
}
impl RecoveryLease {
    pub fn capture_material(&self) -> Result<RCaptureMaterial, String> {
        self.check()?;
        let names = [
            "payload.rds",
            "payload.staging",
            "capture.json",
            "capture.staging",
            "context.json",
            "context.staging",
        ];
        let files = names
            .iter()
            .map(|name| stamp(&self.directory.join(name)))
            .collect::<Result<Vec<_>, _>>()?;
        let complete = self.capture().is_ok();
        // Read a bounded set twice, so even metadata parsing cannot hide a
        // changed preview. Payload bytes are never read or hashed here.
        for (name, observed) in names.iter().zip(&files) {
            if &stamp(&self.directory.join(name))? != observed {
                return Err("Capture material changed while it was observed".into());
            }
        }
        self.check()?;
        Ok(RCaptureMaterial {
            fingerprint: fingerprint(&(
                &self.archive.scope,
                &self.operation,
                &self.archive.identity,
                &self.identity,
                &files,
            ))?,
            payload_bytes: files[0].as_ref().map(|file| file.bytes),
            staging_bytes: files[1].as_ref().map(|file| file.bytes),
            capture_metadata_available: complete,
        })
    }

    /// Removes only the two fixed graph files. All original metadata, locks and
    /// controls remain. The owner retains this lease through Core settlement.
    /// An error may follow partial removal and must retain that uncertainty.
    pub fn discard_capture_payloads(
        &self,
        expected: &rho_plugin_protocol::ContentDigest,
    ) -> Result<RCaptureMaterial, String> {
        let before = self.capture_material()?;
        if &before.fingerprint != expected {
            return Err("Capture material changed since its preview".into());
        }
        for name in ["payload.rds", "payload.staging"] {
            let path = self.directory.join(name);
            if stamp(&path)?.is_some() {
                self.check()?;
                fs::remove_file(path).map_err(error)?;
                sync_directory(&self.directory)?;
            }
        }
        self.capture_material()
    }
}
