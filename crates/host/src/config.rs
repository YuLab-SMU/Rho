use std::path::{Path, PathBuf};
use std::time::Duration;

use crate::ownership::ProjectLease;
use crate::{ArkConfig, NextHost, REnvironmentConfig, SshConfig};

/// Native runtime selection shared by all edges. This is hosting, not a domain.
#[derive(Debug, Clone)]
pub enum RuntimeConfiguration {
    Project,
    Environment {
        rscript: PathBuf,
    },
    Ark {
        executable: PathBuf,
        r_home: PathBuf,
        environment: Option<String>,
    },
}

#[derive(Debug, Clone)]
pub struct HostProfile {
    pub database: PathBuf,
    pub runtime: RuntimeConfiguration,
    pub remote: Option<SshConfig>,
}

/// A native project lease, reserved before ending the old Host. No database
/// recovery or runtime is started until open() consumes the reservation.
pub struct ReservedHost {
    profile: HostProfile,
    lease: ProjectLease,
}

impl HostProfile {
    pub fn runtime_name(&self) -> &'static str {
        match self.runtime {
            RuntimeConfiguration::Project => "project",
            RuntimeConfiguration::Environment { .. } => "environment",
            RuntimeConfiguration::Ark { .. } => "ark",
        }
    }

    /// Bindings to a receipt or remote directory must not follow a project switch.
    pub fn for_new_project(&self) -> Self {
        let mut profile = self.clone();
        profile.remote = None;
        if let RuntimeConfiguration::Ark { environment, .. } = &mut profile.runtime {
            *environment = None;
        }
        profile
    }

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
        let Self { profile, lease } = self;
        let project = lease.root().to_owned();
        let data = profile.database.parent().unwrap_or(Path::new("."));
        match &profile.runtime {
            RuntimeConfiguration::Project => {
                NextHost::open_project_reserved(&profile.database, lease, profile.remote.clone())
                    .await
            }
            RuntimeConfiguration::Environment { rscript } => {
                NextHost::open_environment_reserved(
                    &profile.database,
                    REnvironmentConfig {
                        rscript: rscript.clone(),
                        project_root: project.to_owned(),
                        data_root: data.join("environment"),
                        timeout: Duration::from_secs(300),
                    },
                    profile.remote.clone(),
                    lease,
                )
                .await
            }
            RuntimeConfiguration::Ark {
                executable,
                r_home,
                environment,
            } => {
                NextHost::open_ark_reserved(
                    &profile.database,
                    ArkConfig {
                        executable: executable.clone(),
                        r_home: r_home.clone(),
                        project_root: project.to_owned(),
                        data_root: data.join("runtime"),
                        execution_timeout: Duration::from_secs(600),
                        library_path: None,
                    },
                    environment.as_deref(),
                    profile.remote.clone(),
                    lease,
                )
                .await
            }
        }
        .map_err(|error| error.to_string())
    }
}
