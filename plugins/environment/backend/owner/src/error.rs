/// Native uncertainty and confirmed cancellation, without a core journal result.
#[derive(Debug)]
pub struct EnvironmentOwnerError {
    pub message: String,
    pub possible_effect: bool,
    pub recovery: Option<serde_json::Value>,
    pub cancellation_confirmed: bool,
}
impl EnvironmentOwnerError {
    pub fn before_effect(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            possible_effect: false,
            recovery: None,
            cancellation_confirmed: false,
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
            cancellation_confirmed: false,
        }
    }
    pub fn cancelled(message: impl Into<String>, recovery: Option<serde_json::Value>) -> Self {
        Self {
            message: message.into(),
            possible_effect: true,
            recovery,
            cancellation_confirmed: true,
        }
    }
}
impl std::fmt::Display for EnvironmentOwnerError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        self.message.fmt(f)
    }
}
impl std::error::Error for EnvironmentOwnerError {}
