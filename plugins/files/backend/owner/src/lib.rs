//! Files/Git scientific interpretation, independent of Host admission and storage.
#![forbid(unsafe_code)]
mod patch;
mod search;
pub use patch::*;
pub use search::{search_files, list_matching_files};

#[cfg(test)]
mod tests;
