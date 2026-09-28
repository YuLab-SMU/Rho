//! Temporary capture conversion while ordinary backend composition replaces core adapters.
use rho_application::ApplicationError;
use serde::{Serialize, de::DeserializeOwned};
pub(crate) fn wire<T: Serialize + ?Sized, U: DeserializeOwned>(
    value: &T,
) -> Result<U, ApplicationError> {
    serde_json::to_vec(value)
        .and_then(|bytes| serde_json::from_slice(&bytes))
        .map_err(|_| ApplicationError::Storage("Agent storage capture conversion failed".into()))
}
