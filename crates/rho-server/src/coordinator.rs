use std::collections::{BTreeMap, HashMap, HashSet};
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex as StdMutex};
use std::time::UNIX_EPOCH;

use anyhow::{Context, Result, bail, ensure};
use rho_core::{BrokerState, ExecutionOrigin, ExecutionRequest};
use rho_kernel::{ArkSession, CorrelatedKernelEvent, KernelEvent};
use rho_protocol::{Envelope, ExpectedWorkspace, MAX_FRAME_BYTES, MessageKind, OperationClass};
use rho_store::{
    AgentConversationTurn, AgentRepository, AgentTurnContextItemDraft, AgentTurnEventDraft,
    AgentTurnFinish, ArtifactRecordDraft, BorrowedStore, EnvironmentSnapshotDraft,
    PlotArtifactDraft, RunDraft, RunErrorRange, RunFinish, Store, StoreConnection, StoreExecutor,
    StoreExecutorOperationError,
};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use tokio::sync::{Mutex, oneshot};
use uuid::Uuid;

#[cfg(test)]
use crate::workspace_lane::WorkspaceBrokerLane;

include!("coordinator/shared_types.rs");
include!("coordinator/startup.rs");
include!("coordinator/workspace_dispatch.rs");
include!("coordinator/agent_context.rs");
include!("coordinator/acp_execution.rs");
include!("coordinator/environment.rs");
include!("coordinator/workspace_protocol.rs");

#[cfg(test)]
mod tests {
    include!("coordinator/tests/part_01.rs");
    include!("coordinator/tests/part_02.rs");
}
