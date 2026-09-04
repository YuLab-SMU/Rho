//! Executable end-to-end smoke scenarios for the desktop composition root.
//!
//! These scenarios intentionally exercise real subsystem wiring. They live
//! outside `main.rs` so production assembly remains readable and the smoke
//! harness can evolve without becoming application state.

use std::collections::BTreeMap;
use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use anyhow::{Context, Result, anyhow, bail, ensure};
use rho_core::{BrokerState, ExecutionOrigin};
use rho_extension_runtime::{
    BoundedJson, CapabilityDeclaration, DiagnosticSink, DisposeOutcome, ExtensionDiagnostic,
    ExtensionHost, InternalExtensionRuntimeMode, LifecycleDeadlines,
};
use rho_kernel::{ArkLaunchConfig, ArkSession, KernelEvent};
use rho_server::coordinator::{bootstrap_bridge, dispatch_workspace_request};
use rho_server::workspace_lane::WorkspaceBrokerLane;
use rho_store::{RunSummary, Store, StoreExecutor, normalize_project_root};
use serde_json::{Value, json};

use crate::commands::workspace::expected_workspace;
use crate::git;
use crate::internal_extensions::*;
use crate::project::read_viewer_file;
use crate::project_transition::*;
use crate::startup_runtime::*;

include!("smoke/desktop.rs");
include!("smoke/plugin_host.rs");
include!("smoke/extension.rs");
