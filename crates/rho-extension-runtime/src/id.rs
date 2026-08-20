use std::{fmt, num::NonZeroU64, str::FromStr};

use serde::{Deserialize, Deserializer, Serialize, de};

use crate::{
    ExtensionError, IdentifierCharacterClass, IdentifierErrorReason, IdentifierKind,
    MAX_IDENTIFIER_BYTES,
};

fn validate_identifier(value: &str, kind: IdentifierKind) -> Result<(), ExtensionError> {
    if value.is_empty() {
        return Err(ExtensionError::InvalidIdentifier {
            kind,
            reason: IdentifierErrorReason::Empty,
        });
    }
    if value.len() > MAX_IDENTIFIER_BYTES {
        return Err(ExtensionError::InvalidIdentifier {
            kind,
            reason: IdentifierErrorReason::TooLong {
                actual_bytes: value.len(),
                max_bytes: MAX_IDENTIFIER_BYTES,
            },
        });
    }

    for (byte_index, character) in value.char_indices() {
        let accepted = character.is_ascii_lowercase()
            || character.is_ascii_digit()
            || matches!(character, '.' | '_' | '-');
        if accepted {
            continue;
        }

        let class = if !character.is_ascii() {
            IdentifierCharacterClass::NonAscii
        } else if matches!(character, '/' | '\\') {
            IdentifierCharacterClass::PathSeparator
        } else if character.is_ascii_whitespace() {
            IdentifierCharacterClass::Whitespace
        } else if character.is_ascii_control() {
            IdentifierCharacterClass::Control
        } else if character.is_ascii_uppercase() {
            IdentifierCharacterClass::Uppercase
        } else {
            IdentifierCharacterClass::OtherAscii
        };

        return Err(ExtensionError::InvalidIdentifier {
            kind,
            reason: IdentifierErrorReason::InvalidCharacter { byte_index, class },
        });
    }

    Ok(())
}

macro_rules! validated_id {
    ($name:ident, $kind:expr) => {
        #[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize)]
        #[serde(transparent)]
        pub struct $name(String);

        impl $name {
            pub fn new(value: impl Into<String>) -> Result<Self, ExtensionError> {
                let value = value.into();
                validate_identifier(&value, $kind)?;
                Ok(Self(value))
            }

            pub fn as_str(&self) -> &str {
                &self.0
            }

            pub fn into_inner(self) -> String {
                self.0
            }
        }

        impl AsRef<str> for $name {
            fn as_ref(&self) -> &str {
                self.as_str()
            }
        }

        impl fmt::Display for $name {
            fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
                formatter.write_str(&self.0)
            }
        }

        impl FromStr for $name {
            type Err = ExtensionError;

            fn from_str(value: &str) -> Result<Self, Self::Err> {
                Self::new(value)
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

validated_id!(PluginId, IdentifierKind::Plugin);
validated_id!(CapabilityId, IdentifierKind::Capability);
validated_id!(OperationId, IdentifierKind::Operation);
validated_id!(ScopeKindId, IdentifierKind::ScopeKind);
validated_id!(ScopeId, IdentifierKind::Scope);

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct ActivationGeneration(NonZeroU64);

impl ActivationGeneration {
    pub fn new(value: u64) -> Result<Self, ExtensionError> {
        NonZeroU64::new(value)
            .map(Self)
            .ok_or(ExtensionError::ZeroActivationGeneration)
    }

    pub fn get(self) -> u64 {
        self.0.get()
    }
}

impl fmt::Display for ActivationGeneration {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        self.0.fmt(formatter)
    }
}

impl TryFrom<u64> for ActivationGeneration {
    type Error = ExtensionError;

    fn try_from(value: u64) -> Result<Self, Self::Error> {
        Self::new(value)
    }
}
