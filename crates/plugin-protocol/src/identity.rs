use crate::{ProtocolError, require};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use ts_rs::TS;

macro_rules! identity {
    ($name:ident, $check:ident) => {
        #[derive(
            Debug,
            Clone,
            PartialEq,
            Eq,
            PartialOrd,
            Ord,
            Hash,
            Serialize,
            Deserialize,
            JsonSchema,
            TS,
        )]
        #[serde(try_from = "String", into = "String")]
        #[schemars(with = "String")]
        #[ts(type = "string")]
        pub struct $name(String);
        impl $name {
            pub fn new(value: impl Into<String>) -> Result<Self, ProtocolError> {
                let value = value.into();
                $check(&value)?;
                Ok(Self(value))
            }
            pub fn as_str(&self) -> &str {
                &self.0
            }
        }
        impl TryFrom<String> for $name {
            type Error = ProtocolError;
            fn try_from(value: String) -> Result<Self, Self::Error> {
                Self::new(value)
            }
        }
        impl From<$name> for String {
            fn from(value: $name) -> String {
                value.0
            }
        }
        impl std::fmt::Display for $name {
            fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                self.0.fmt(f)
            }
        }
    };
}

fn name(value: &str) -> Result<(), ProtocolError> {
    require(
        !value.is_empty()
            && value.len() <= 128
            && value.as_bytes()[0].is_ascii_lowercase()
            && value
                .bytes()
                .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || b"._-".contains(&c))
            && !value.contains(".."),
        "identity must be a lowercase name of at most 128 bytes",
    )
}
fn digest(value: &str) -> Result<(), ProtocolError> {
    require(
        value.len() == 71
            && value.starts_with("sha256:")
            && value[7..]
                .bytes()
                .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c)),
        "expected a lowercase sha256 content digest",
    )
}
fn opaque(value: &str) -> Result<(), ProtocolError> {
    require(
        !value.is_empty()
            && value.len() <= 128
            && value
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || b"._-".contains(&c)),
        "opaque identity must contain 1–128 safe ASCII bytes",
    )
}
fn package_path(value: &str) -> Result<(), ProtocolError> {
    require(
        !value.is_empty()
            && value.len() <= 1024
            && !value.contains(['\\', ':'])
            && !value.chars().any(char::is_control)
            && value.split('/').all(|part| {
                !part.is_empty()
                    && part != "."
                    && part != ".."
                    && !part.ends_with(['.', ' '])
                    && !part.starts_with(' ')
            }),
        "package path must be a contained, normalized relative POSIX path",
    )
}

// Journal identities predate plugin instance names and permit namespaced tokens.
// They remain opaque to domain owners; only the original Operation allocates them.
fn operation_id(value: &str) -> Result<(), ProtocolError> {
    require(
        !value.is_empty()
            && value.len() <= 160
            && value
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || b".-_:/".contains(&c)),
        "operation identity must contain 1–160 safe ASCII bytes",
    )
}
identity!(OperationId, operation_id);

identity!(PluginId, name);
identity!(ContributionId, name);
identity!(InstanceAlias, name);
identity!(ContentDigest, digest);
identity!(RevisionId, digest);
identity!(ArtifactId, digest);
identity!(ScenarioRevisionId, digest);
identity!(PluginInstanceId, opaque);
identity!(ViewInstanceId, opaque);
identity!(DraftId, opaque);
identity!(ConnectionId, opaque);
identity!(RequestId, opaque);
identity!(ProjectId, opaque);
identity!(TestProjectId, name);
identity!(PrincipalId, opaque);
identity!(WindowId, opaque);
identity!(ScenarioId, opaque);
identity!(BranchId, opaque);
identity!(ResourceId, opaque);
identity!(NodeId, opaque);
identity!(PackagePath, package_path);

impl PackagePath {
    pub fn is_artifact(&self) -> bool {
        self.0.starts_with("dist/")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn operation_identity_preserves_namespaces_and_validates_deserialization() {
        for value in ["original/run:1", "abc_DEF-123", &"a".repeat(160)] {
            let id = OperationId::new(value).unwrap();
            assert_eq!(
                serde_json::from_value::<OperationId>(serde_json::json!(value)).unwrap(),
                id
            );
        }
        for value in ["", "bad identity", "line\nend", &"a".repeat(161)] {
            assert!(OperationId::new(value).is_err());
            assert!(serde_json::from_value::<OperationId>(serde_json::json!(value)).is_err());
        }
    }

    #[test]
    fn hostile_paths_and_deserialized_identities_are_rejected() {
        for path in [
            "", "/tmp/x", "../x", "a/../x", "a//b", "a/./b", "a\\b", "C:/x", "a/", "a\0b", "x. ",
        ] {
            assert!(PackagePath::new(path).is_err(), "{path:?}");
            assert!(serde_json::from_value::<PackagePath>(serde_json::json!(path)).is_err());
        }
        assert!(PackagePath::new("src/图表.tsx").is_ok());
        assert!(RevisionId::new(format!("sha256:{}", "f".repeat(64))).is_ok());
        assert!(RevisionId::new(format!("sha256:{}", "F".repeat(64))).is_err());
        assert!(PluginId::new("rho.viewer").is_ok());
        assert!(PluginId::new("rho/../../viewer").is_err());
    }
}
