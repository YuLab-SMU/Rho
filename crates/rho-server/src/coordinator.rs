use std::collections::{BTreeMap, HashMap, HashSet};
use std::ffi::OsString;
use std::fs;
use std::future::Future;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::process::Stdio;
use std::sync::{Arc, Mutex as StdMutex};
use std::time::UNIX_EPOCH;

use anyhow::{Context, Result, bail, ensure};
use rho_agent_transport::{
    AgentAuthenticator, AuthenticatedAgent, read_async_frame, write_async_frame,
};
use rho_core::{BrokerState, ExecutionOrigin, ExecutionRequest};
use rho_kernel::{ArkLaunchConfig, ArkSession, CorrelatedKernelEvent, KernelEvent};
use rho_protocol::{Envelope, ExpectedWorkspace, MAX_FRAME_BYTES, MessageKind, OperationClass};
use rho_store::{
    AgentConversationTurn, AgentRepository, AgentTurnContextItemDraft, AgentTurnEventDraft,
    AgentTurnFinish, ApprovalDecisionRecord, ApprovalRequestDraft, ArtifactRecordDraft,
    BorrowedStore, EnvironmentOperationDecisionRecord, EnvironmentOperationFinish,
    EnvironmentOperationRequestDraft, EnvironmentOperationRequestSummary, EnvironmentSnapshotDraft,
    PlotArtifactDraft, RunDraft, RunErrorRange, RunFinish, Store, StoreConnection, StoreExecutor,
    StoreExecutorOperationError, normalize_project_root,
};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use tokio::io::AsyncWriteExt;
use tokio::sync::{Mutex, oneshot};
use uuid::Uuid;

use crate::workspace_lane::{WorkspaceBrokerLane, WorkspaceBrokerState};

include!("coordinator/shared_types.rs");
include!("coordinator/startup.rs");
include!("coordinator/workspace_dispatch.rs");
include!("coordinator/agent_context.rs");
include!("coordinator/agent_execution.rs");
include!("coordinator/agent_authorization.rs");
include!("coordinator/environment.rs");
include!("coordinator/workspace_protocol.rs");

#[cfg(test)]
mod tests {
    include!("coordinator/tests/part_01.rs");
    include!("coordinator/tests/part_02.rs");
}
