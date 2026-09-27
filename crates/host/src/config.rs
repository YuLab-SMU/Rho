use std::path::{Path, PathBuf};
use std::time::Duration;

use crate::ownership::ProjectLease;
use crate::{ArkConfig, NextHost, REnvironmentConfig, SshConfig};

/// Native runtime selection shared by all edges. This is hosting, not a domain.
#[derive(Debug, Clone)]
pub enum RuntimeConfiguration {
    /// Generic plugin workspace; no fixed scientific owners or R discovery.
    Plugins,
    Project,
    Environment {
        rscript: PathBuf,
    },
    Ark {
        executable: PathBuf,
        r_home: PathBuf,
        environment: Option<String>,
        checkpoint_helper_path: Option<PathBuf>,
    },
}

#[derive(Debug, Clone)]
pub struct HostProfile {
    pub database: PathBuf,
    pub runtime: RuntimeConfiguration,
    pub remote: Option<SshConfig>,
    /// Exact Skill roots discovered and attested by the external platform launcher.
    pub host_skills: Option<PathBuf>,
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
            RuntimeConfiguration::Plugins => "plugins",
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
    /// Workbench restores its selected logical instance before asking R to continue.
    pub async fn open_deferred(&self, project: &Path) -> Result<NextHost, String> {
        self.reserve(project)?.open_deferred().await
    }

    pub fn reserve(&self, project: &Path) -> Result<ReservedHost, String> {
        if matches!(self.runtime, RuntimeConfiguration::Plugins)
            && (self.remote.is_some() || self.host_skills.is_some())
        {
            return Err("Plugin workspaces receive scientific providers and context through installed packages, not fixed Host bindings".into());
        }
        crate::skills::validate_manifest_for_project(
            project,
            &self.database,
            self.host_skills.as_deref(),
        )
        .map_err(|error| error.to_string())?;
        Ok(ReservedHost {
            profile: self.clone(),
            lease: ProjectLease::acquire(project).map_err(|error| error.to_string())?,
        })
    }
}

impl ReservedHost {
    pub async fn open(self) -> Result<NextHost, String> {
        self.open_with_startup(true).await
    }
    pub async fn open_deferred(self) -> Result<NextHost, String> {
        self.open_with_startup(false).await
    }
    async fn open_with_startup(self, auto_continue: bool) -> Result<NextHost, String> {
        let Self { profile, lease } = self;
        let project = lease.root().to_owned();
        let data = profile.database.parent().unwrap_or(Path::new("."));
        match &profile.runtime {
            RuntimeConfiguration::Plugins => {
                NextHost::open_plugin_workspace_reserved(&profile.database, lease).await
            }
            RuntimeConfiguration::Project => {
                NextHost::open_project_reserved(
                    &profile.database,
                    lease,
                    profile.remote.clone(),
                    profile.host_skills.as_deref(),
                )
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
                    profile.host_skills.as_deref(),
                )
                .await
            }
            RuntimeConfiguration::Ark {
                executable,
                r_home,
                environment,
                checkpoint_helper_path,
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
                        checkpoint_helper_path: checkpoint_helper_path.clone(),
                    },
                    environment.as_deref(),
                    profile.remote.clone(),
                    lease,
                    profile.host_skills.as_deref(),
                    auto_continue,
                )
                .await
            }
        }
        .map_err(|error| error.to_string())
    }
}
