//! Deterministic package digest computation for Phase 2 workspace plugins.
//!
//! The host computes a SHA-256 digest from a canonical, sorted file inventory.
//! A plugin never declares its own trusted digest: the digest is an executable
//! identity that only the broker records and validates.

use sha2::{Digest, Sha256};

use serde::{Deserialize, Deserializer, Serialize, de};

/// The canonical package digest as a lowercase hexadecimal SHA-256 string.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize)]
#[serde(transparent)]
pub struct PackageDigest(String);

impl PackageDigest {
    /// Build a digest from an already-canonicalized, path-sorted file inventory.
    ///
    /// `entries` is a slice of `(relative_path_bytes, file_content_bytes)`, in
    /// ascending lexicographic order by the normalized relative path. The
    /// caller is responsible for that ordering; this function merely hashes the
    /// length-delimited stream so that no file boundary can be forged.
    pub fn from_inventory(entries: &[(&[u8], &[u8])]) -> Self {
        let mut hasher = Sha256::new();
        for (path, content) in entries {
            hash_bytes(&mut hasher, path);
            hash_bytes(&mut hasher, content);
        }
        let digest = hasher.finalize();
        Self(hex_encode(&digest))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }

    pub fn into_inner(self) -> String {
        self.0
    }

    pub fn parse(value: impl Into<String>) -> Result<Self, &'static str> {
        let value = value.into();
        if value.len() != 64
            || !value
                .bytes()
                .all(|byte| byte.is_ascii_digit() || matches!(byte, b'a'..=b'f'))
        {
            return Err("package digest must be 64 lowercase hexadecimal characters");
        }
        Ok(Self(value))
    }
}

impl<'de> Deserialize<'de> for PackageDigest {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let value = String::deserialize(deserializer)?;
        Self::parse(value).map_err(de::Error::custom)
    }
}

impl std::fmt::Display for PackageDigest {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.0)
    }
}

fn hash_bytes(hasher: &mut Sha256, bytes: &[u8]) {
    // Length-prefix each field so concatenation cannot be ambiguous.
    hasher.update((bytes.len() as u64).to_le_bytes());
    hasher.update(bytes);
}

fn hex_encode(bytes: &[u8]) -> String {
    use std::fmt::Write;
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        write!(&mut out, "{byte:02x}").expect("writing to String cannot fail");
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn digest_is_deterministic() {
        let a = PackageDigest::from_inventory(&[(b"a.js", b"hello"), (b"b.js", b"world")]);
        let b = PackageDigest::from_inventory(&[(b"a.js", b"hello"), (b"b.js", b"world")]);
        assert_eq!(a, b);
    }

    #[test]
    fn digest_sensitive_to_path_and_content() {
        let base = PackageDigest::from_inventory(&[(b"a.js", b"hello")]);
        let diff_content = PackageDigest::from_inventory(&[(b"a.js", b"world")]);
        let diff_path = PackageDigest::from_inventory(&[(b"b.js", b"hello")]);
        assert_ne!(base, diff_content);
        assert_ne!(base, diff_path);
    }

    #[test]
    fn digest_sensitive_to_ordering() {
        let ordered = PackageDigest::from_inventory(&[(b"a.js", b"1"), (b"b.js", b"2")]);
        let reversed = PackageDigest::from_inventory(&[(b"b.js", b"2"), (b"a.js", b"1")]);
        assert_ne!(ordered, reversed);
    }

    #[test]
    fn length_prefix_avoids_concatenation_ambiguity() {
        // ("ab","c") + ( "","d") must differ from ("a","bc") + ("","d").
        let x = PackageDigest::from_inventory(&[(b"ab", b"c")]);
        let y = PackageDigest::from_inventory(&[(b"a", b"bc")]);
        assert_ne!(x, y);
    }

    #[test]
    fn serde_rejects_non_sha256_identity() {
        assert!(serde_json::from_str::<PackageDigest>("\"\"").is_err());
        assert!(serde_json::from_str::<PackageDigest>(&format!("\"{}\"", "A".repeat(64))).is_err());
        let digest = PackageDigest::from_inventory(&[(b"a", b"b")]);
        let encoded = serde_json::to_string(&digest).unwrap();
        assert_eq!(
            serde_json::from_str::<PackageDigest>(&encoded).unwrap(),
            digest
        );
    }
}
