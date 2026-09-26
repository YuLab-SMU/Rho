/// Native evidence classification. The transport layer must preserve uncertainty;
/// only the caller's authoritative operation mechanism commits a result.
#[derive(Debug)]
pub struct RemoteOwnerError {
    pub message: String,
    pub possible_effect: bool,
    pub recovery: Option<serde_json::Value>,
}
impl RemoteOwnerError {
    pub fn before_effect(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            possible_effect: false,
            recovery: None,
        }
    }
    pub fn after_possible_effect(
        message: impl Into<String>,
        recovery: Option<serde_json::Value>,
    ) -> Self {
        Self {
            message: message.into(),
            possible_effect: true,
            recovery,
        }
    }
}
impl std::fmt::Display for RemoteOwnerError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        self.message.fmt(f)
    }
}
impl std::error::Error for RemoteOwnerError {}
