use std::path::{Path, PathBuf};

use crate::ownership::ProjectLease;
use crate::NextHost;

/// Generic Host storage configuration. Scientific providers belong to plugins.
#[derive(Debug, Clone)]
pub struct HostProfile {
    pub database: PathBuf,
}

/// A native project lease reserved before ending the old Host. No database
/// recovery or plugin backend starts until open() consumes the reservation.
pub struct ReservedHost {
    profile: HostProfile,
    lease: ProjectLease,
}

impl HostProfile {
    pub async fn open(&self, project: &Path) -> Result<NextHost, String> {
        self.reserve(project)?.open().await
    }

    pub fn reserve(&self, project: &Path) -> Result<ReservedHost, String> {
        Ok(ReservedHost {
            profile: self.clone(),
            lease: ProjectLease::acquire(project).map_err(|error| error.to_string())?,
        })
    }
}

impl ReservedHost {
    pub async fn open(self) -> Result<NextHost, String> {
        NextHost::open_plugin_workspace_reserved(&self.profile.database, self.lease)
            .await
            .map_err(|error| error.to_string())
    }
}
