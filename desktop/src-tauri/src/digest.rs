use sha2::{Digest, Sha256};

pub(crate) fn text_sha256(content: &str) -> String {
    format!("{:x}", Sha256::digest(content.as_bytes()))
}
