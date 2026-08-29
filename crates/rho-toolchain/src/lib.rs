//! Project-owned R and Python toolchain coordination.
//!
//! `rho.toml` is the admission contract. Ordinary execution is read-only with
//! respect to package installation and lockfiles; explicit sync/lock operations
//! are journaled before the first external effect. Every run/live activation
//! writes a bounded `environment.json` receipt.

mod adapter;
mod command;
mod config;
mod doctor;
mod journal;
mod receipt;
mod remote;
mod rig;
mod target;

use std::path::PathBuf;

pub use adapter::adapt_plan_for_target;
pub use command::{
    CommandSpec, ToolchainPlan, ToolchainPlanKind, lock_plan, python_run_plan,
    r_package_install_plan, r_run_plan, sync_plan,
};
pub use config::{
    ExactVersion, ProjectComputeConfig, PythonToolchainConfig, PythonVersion, RToolchainConfig,
    RuntimeToolchainConfig, ToolchainConfig, ToolchainConfigDocument, load_toolchain_config,
};
pub use doctor::{DoctorCheck, DoctorReport, DoctorStatus, doctor, doctor_for_target};
pub use journal::{
    EffectStatus, ExternalEffectRecord, OperationJournal, OperationKind, OperationStatus,
    execute_journaled_operation, operation_journal_path,
};
pub use receipt::{
    EnvironmentReceipt, EnvironmentReceiptMode, PythonEnvironmentReceipt, REnvironmentReceipt,
    RLibraryLayers, environment_receipt_path, read_and_validate_environment_receipt,
    write_environment_receipt,
};
pub use remote::{
    RemoteHelperOperation, RemoteHelperRequest, RemoteHelperResponse, invoke_remote_helper,
    verify_ssh_host_fingerprint,
};
pub use rig::{RigInstallation, RigInventory, parse_rig_inventory, resolve_r_installation};
pub use target::{
    ComputeHost, ComputeIsolation, ComputeTarget, LOCAL_TARGET_ID, TargetRegistry,
    TargetRegistryDocument, load_target_registry, validate_target_id,
};

#[derive(Debug, thiserror::Error)]
pub enum ToolchainError {
    #[error("toolchain path is not project-contained: {0}")]
    PathContainment(PathBuf),
    #[error("toolchain path contains a symbolic link: {0}")]
    SymbolicLink(PathBuf),
    #[error("rho.toml is missing at {0}")]
    MissingConfig(PathBuf),
    #[error("rho.toml exceeds the {limit}-byte bound ({actual} bytes)")]
    ConfigTooLarge { limit: usize, actual: usize },
    #[error("rho.toml is invalid: {0}")]
    InvalidConfig(String),
    #[error("toolchain version must be exact x.y.z: {0}")]
    InvalidVersion(String),
    #[error("rig inventory is invalid: {0}")]
    InvalidRigInventory(String),
    #[error("R {0} is not installed through rig")]
    RInstallationMissing(String),
    #[error("multiple rig installations match exact R {0}")]
    AmbiguousRInstallation(String),
    #[error("Rscript is missing beside the rig-selected R binary: {0}")]
    MissingRscript(PathBuf),
    #[error("toolchain identity is invalid: {0}")]
    InvalidIdentity(String),
    #[error("compute target is invalid: {0}")]
    InvalidTarget(String),
    #[error("compute target was not found: {0}")]
    TargetNotFound(String),
    #[error("toolchain command failed to start: {0}")]
    CommandStart(String),
    #[error("toolchain command failed: {0}")]
    CommandFailed(String),
    #[error("toolchain journal is invalid: {0}")]
    InvalidJournal(String),
    #[error("environment receipt is invalid: {0}")]
    InvalidReceipt(String),
    #[error(transparent)]
    Io(#[from] std::io::Error),
    #[error(transparent)]
    Json(#[from] serde_json::Error),
}
