//! Model settings and transient credentials; no model execution.
use crate::AgentTaskError;
use rho_agent_api::*;
fn invalid(message: &str) -> AgentTaskError {
    AgentTaskError::InvalidInput(message.into())
}
fn token(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 160
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"._-:".contains(&b))
}

/// Ephemeral credential material. Deliberately neither Debug nor serializable.
pub struct ComponentModelKey(String);
impl ComponentModelKey {
    pub fn new(value: String) -> Result<Self, AgentTaskError> {
        if value.is_empty() || value.len() > 16384 || !value.bytes().all(|b| b.is_ascii_graphic()) {
            return Err(AgentTaskError::InvalidInput(
                "Invalid model credential".into(),
            ));
        }
        Ok(Self(value))
    }
    pub fn expose(&self) -> &str {
        &self.0
    }
}

pub fn validate_model_connection(
    connection: &ComponentModelConnection,
) -> Result<(), AgentTaskError> {
    let endpoint =
        url::Url::parse(&connection.base_url).map_err(|_| invalid("Invalid model endpoint"))?;
    let local = match endpoint.host() {
        Some(url::Host::Domain("localhost")) => true,
        Some(url::Host::Ipv4(ip)) => ip.is_loopback(),
        Some(url::Host::Ipv6(ip)) => ip.is_loopback(),
        _ => false,
    };
    if connection.base_url.len() > 2048
        || endpoint.host().is_none()
        || !endpoint.username().is_empty()
        || endpoint.password().is_some()
        || endpoint.query().is_some()
        || endpoint.fragment().is_some()
        || !(endpoint.scheme() == "https" || (endpoint.scheme() == "http" && local))
    {
        return Err(invalid(
            "Model endpoint requires HTTPS or explicit loopback HTTP without embedded credentials",
        ));
    }
    if connection.model.trim().is_empty()
        || connection.model.len() > 256
        || connection.model.chars().any(char::is_control)
    {
        return Err(invalid("Invalid model ID"));
    }
    match &connection.credential {
        ComponentCredentialRef::Environment { name }
            if !name.is_empty()
                && name.len() <= 128
                && name.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_')
                && !name.as_bytes()[0].is_ascii_digit() => {}
        ComponentCredentialRef::Session { key_id }
        | ComponentCredentialRef::LocalFile { key_id }
            if token(key_id) => {}
        _ => return Err(invalid("Invalid credential reference")),
    }
    Ok(())
}
