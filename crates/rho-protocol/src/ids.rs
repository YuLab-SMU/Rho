use std::{fmt, str::FromStr};

use serde::{Deserialize, Deserializer, Serialize, Serializer, de};
use thiserror::Error;
use uuid::Uuid;

pub const MAX_ID_BYTES: usize = 256;
pub const ORDERED_ID_VERSION: &str = "uuidv7";

#[derive(Debug, Error, Clone, PartialEq, Eq)]
pub enum IdError {
    #[error("{kind} id must not be empty")]
    Empty { kind: &'static str },
    #[error("{kind} id must not contain leading or trailing whitespace")]
    SurroundingWhitespace { kind: &'static str },
    #[error("{kind} id must not contain control characters")]
    ControlCharacter { kind: &'static str },
    #[error("{kind} id exceeds {max} bytes")]
    TooLong { kind: &'static str, max: usize },
}

fn validate_id(kind: &'static str, value: impl Into<String>) -> Result<String, IdError> {
    let value = value.into();
    if value.is_empty() {
        return Err(IdError::Empty { kind });
    }
    if value.trim() != value {
        return Err(IdError::SurroundingWhitespace { kind });
    }
    if value.chars().any(char::is_control) {
        return Err(IdError::ControlCharacter { kind });
    }
    if value.len() > MAX_ID_BYTES {
        return Err(IdError::TooLong {
            kind,
            max: MAX_ID_BYTES,
        });
    }
    Ok(value)
}

macro_rules! define_id {
    ($name:ident, $kind:literal, $prefix:literal) => {
        #[derive(Clone, PartialEq, Eq, PartialOrd, Ord, Hash)]
        pub struct $name(String);

        impl $name {
            pub const KIND: &'static str = $kind;
            pub const GENERATED_PREFIX: &'static str = $prefix;

            pub fn new(value: impl Into<String>) -> Result<Self, IdError> {
                validate_id(Self::KIND, value).map(Self)
            }

            pub fn generate() -> Self {
                Self(format!(
                    "{}{}",
                    Self::GENERATED_PREFIX,
                    Uuid::now_v7().simple()
                ))
            }

            pub fn generated_uses_ordered_uuid_policy() -> &'static str {
                ORDERED_ID_VERSION
            }

            pub fn as_str(&self) -> &str {
                &self.0
            }

            pub fn into_string(self) -> String {
                self.0
            }
        }

        impl fmt::Debug for $name {
            fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                f.debug_tuple(stringify!($name)).field(&self.0).finish()
            }
        }

        impl fmt::Display for $name {
            fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                f.write_str(&self.0)
            }
        }

        impl FromStr for $name {
            type Err = IdError;

            fn from_str(value: &str) -> Result<Self, Self::Err> {
                Self::new(value)
            }
        }

        impl TryFrom<String> for $name {
            type Error = IdError;

            fn try_from(value: String) -> Result<Self, Self::Error> {
                Self::new(value)
            }
        }

        impl TryFrom<&str> for $name {
            type Error = IdError;

            fn try_from(value: &str) -> Result<Self, Self::Error> {
                Self::new(value)
            }
        }

        impl Serialize for $name {
            fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
            where
                S: Serializer,
            {
                serializer.serialize_str(&self.0)
            }
        }

        impl<'de> Deserialize<'de> for $name {
            fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
            where
                D: Deserializer<'de>,
            {
                let value = String::deserialize(deserializer)?;
                Self::new(value).map_err(de::Error::custom)
            }
        }
    };
}

define_id!(ProjectId, "project", "project_");
define_id!(WorkspaceId, "workspace", "workspace_");
define_id!(KernelInstanceId, "kernel_instance", "kernel_");
define_id!(SessionId, "logical_session", "session_");
define_id!(ProviderSessionId, "provider_session", "provider_session_");
define_id!(RunId, "run", "run_");
define_id!(TurnId, "turn", "turn_");
define_id!(ToolCallId, "tool_call", "tool_call_");
define_id!(ExecutionId, "execution", "execution_");
define_id!(JobId, "job", "job_");
define_id!(ArtifactId, "artifact", "artifact_");
define_id!(SecretId, "secret", "secret_");
define_id!(CapabilityId, "capability", "capability_");
define_id!(OperationId, "operation", "operation_");
define_id!(EnvironmentId, "environment", "environment_");
define_id!(
    RuntimeRealizationId,
    "runtime_realization",
    "runtime_realization_"
);
define_id!(EnvironmentPlanId, "environment_plan", "environment_plan_");
define_id!(
    EnvironmentDesiredRevisionId,
    "environment_desired_revision",
    "env_desired_"
);
define_id!(
    EnvironmentRealizationRevisionId,
    "environment_realization_revision",
    "env_realized_"
);
define_id!(
    EnvironmentReceiptId,
    "environment_receipt",
    "environment_receipt_"
);
define_id!(
    ExecutionProfileId,
    "execution_profile",
    "execution_profile_"
);
define_id!(
    RepositoryProfileId,
    "repository_profile",
    "repository_profile_"
);
define_id!(LibraryLayerId, "library_layer", "library_layer_");
define_id!(ProviderId, "provider", "provider_");
define_id!(EventId, "event", "event_");
define_id!(StreamId, "stream", "stream_");
define_id!(CorrelationId, "correlation", "correlation_");
define_id!(CausationId, "causation", "causation_");
define_id!(TraceId, "trace", "trace_");
