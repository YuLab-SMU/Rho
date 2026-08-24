//! Code-generation-only markers for the Runtime Output IPC contract.
//!
//! Rho's existing JSON/Tauri contract transports bounded counters, revisions,
//! byte counts, and sequences as JavaScript numbers. Specta deliberately
//! rejects Rust `i64`/`usize` by default, so every opt-in is explicit at the
//! field that owns the bounded value instead of enabling a global lossy cast.

use specta::{Type, Types, datatype::DataType};

/// Export a bounded Rust integer as the existing JSON/TypeScript `number`.
///
/// This marker affects generated type metadata only; Serde continues to encode
/// the original integer. Runtime Output invariants keep transported values in
/// JavaScript's exact integer range.
pub struct RuntimeOutputIpcNumber;

impl Type for RuntimeOutputIpcNumber {
    fn definition(types: &mut Types) -> DataType {
        <i32 as Type>::definition(types)
    }
}

#[derive(Type, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RuntimeExecutionStatus {
    Admitted,
    Running,
    Completed,
    Failed,
    Interrupted,
}

#[derive(Type, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RuntimeOutputState {
    Collecting,
    Complete,
    Partial,
    Unavailable,
    Pruned,
}

#[derive(Type, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RuntimeOutputPresentationKind {
    Stdout,
    Value,
    Message,
    Warning,
    Error,
    Status,
    DisplayRef,
}

#[derive(Type, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RuntimeOutputStorageKind {
    InlineText,
    InlineJson,
    RecordRef,
    Tombstone,
}

#[derive(Type, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RuntimeOutputReferenceKind {
    Plot,
    Artifact,
}
