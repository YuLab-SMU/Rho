//! Transitional path selection and typed forwarding to Agent-owned credentials.
use rho_application::{ApplicationError, ApplicationScope, ComponentModelKey};
use rho_contract::ComponentCredentialRef;
use std::path::PathBuf;

pub(super) struct CredentialFile(Option<rho_agent_store::CredentialFile>);
impl CredentialFile {
    pub(super) fn user_config() -> Self {
        let base = if cfg!(target_os = "windows") {
            std::env::var_os("APPDATA").map(PathBuf::from)
        } else if cfg!(target_os = "macos") {
            std::env::var_os("HOME").map(|p| PathBuf::from(p).join("Library/Application Support"))
        } else {
            std::env::var_os("XDG_CONFIG_HOME")
                .map(PathBuf::from)
                .or_else(|| std::env::var_os("HOME").map(|p| PathBuf::from(p).join(".config")))
        };
        Self(
            base.filter(|p| p.is_absolute())
                .map(|p| rho_agent_store::CredentialFile::at(p.join("rho/model-credentials.json"))),
        )
    }
    #[cfg(test)]
    pub(super) fn at(path: PathBuf) -> Self {
        Self(Some(rho_agent_store::CredentialFile::at(path)))
    }
    fn store(&self) -> Result<&rho_agent_store::CredentialFile, ApplicationError> {
        self.0.as_ref().ok_or_else(|| {
            ApplicationError::InvalidInput("The user configuration directory is unavailable".into())
        })
    }
    pub(super) fn put(
        &self,
        scope: &ApplicationScope,
        value: String,
    ) -> Result<ComponentCredentialRef, ApplicationError> {
        self.store()?.put(&scope.into(), value).map_err(Into::into)
    }
    pub(super) fn key(
        &self,
        scope: &ApplicationScope,
        key_id: &str,
    ) -> Result<ComponentModelKey, ApplicationError> {
        self.store()?.key(&scope.into(), key_id).map_err(Into::into)
    }
    pub(super) fn remove(
        &self,
        scope: &ApplicationScope,
        key_id: &str,
    ) -> Result<(), ApplicationError> {
        self.store()?
            .remove(&scope.into(), key_id)
            .map_err(Into::into)
    }
}
