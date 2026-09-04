use std::collections::BTreeMap;
use std::io::Read;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result, anyhow, ensure};
use chrono::Utc;
use rho_evidence_graph::{
    ClaimTrace, EvidenceGraph, EvidenceSubgraph, GraphEdge, GraphGap, GraphHealth, GraphNode,
    GraphProvenanceRef, ProjectGraphHealth,
};
use rho_protocol::{
    AuthorityDigest, AuthorityKindV1, AuthorityObservationV1, AuthorityRefV1, AuthorityStatusV1,
    ProjectId, ProjectRevision, StateRevision,
};
use rho_ui_contract::{
    AuthorityKindViewV1, AuthorityObservationViewV1, AuthorityReferenceViewV1, ClaimTraceViewV1,
    EVIDENCE_GRAPH_VIEW_CONTRACT, EvidenceEdgeId, EvidenceEdgeViewV1, EvidenceGapFactV1,
    EvidenceGapId, EvidenceGapViewV1, EvidenceGraphHealthViewV1, EvidenceNodeId,
    EvidenceNodeViewV1, EvidenceSubgraphViewV1,
};
use serde::{Serialize, de::DeserializeOwned};
use serde_json::Value;
use sha2::{Digest, Sha256};

use crate::application_state::{run_store_executor_service, store_executor};
use crate::digest::text_sha256;
use crate::{AppState, normalize_project_root};

pub(crate) struct ActiveGraphContext {
    pub(crate) root: PathBuf,
    pub(crate) project_id: ProjectId,
    pub(crate) health: ProjectGraphHealth,
}

pub(crate) fn project_id_for_root(root: &Path) -> Result<ProjectId> {
    let normalized = normalize_project_root(root.to_string_lossy().as_ref());
    ProjectId::new(format!("project.{}", text_sha256(&normalized)))
        .context("deriving the active Evidence Graph project identity")
}

pub(crate) fn activate_project_graph(state: &AppState, root: &Path) -> Result<ProjectGraphHealth> {
    let project_id = project_id_for_root(root)?;
    Ok(state.evidence_graph.activate(root, project_id))
}

pub(crate) async fn active_graph_context(state: &AppState) -> Result<ActiveGraphContext> {
    let root = state.project_root.read().await.clone();
    let project_id = project_id_for_root(&root)?;
    let health = state.evidence_graph.activate(&root, project_id.clone());
    Ok(ActiveGraphContext {
        root,
        project_id,
        health,
    })
}

pub(crate) fn graph_health_view(context: &ActiveGraphContext) -> Result<EvidenceGraphHealthViewV1> {
    let project_id = ui_project_id(&context.project_id)?;
    let graph = context.health.graph.as_ref();
    Ok(EvidenceGraphHealthViewV1 {
        contract: EVIDENCE_GRAPH_VIEW_CONTRACT.to_string(),
        project_id,
        engine: "ladybug".to_string(),
        available: context.health.available,
        schema_version: graph.map_or(0, |value| value.schema_version),
        graph_revision: graph.map_or(0, |value| value.graph_revision),
        authority_cursor: graph.map_or(0, |value| value.authority_cursor),
        last_ingest_success_at: graph.and_then(|value| value.last_ingest_success_at.clone()),
        last_ingest_error_code: graph.and_then(|value| value.last_ingest_error_code.clone()),
        error_code: context.health.error_code.clone(),
        message: context.health.message.clone(),
    })
}

pub(crate) fn require_available(context: &ActiveGraphContext) -> Result<()> {
    ensure!(
        context.health.available,
        "Evidence Graph is unavailable ({}): {}",
        context
            .health
            .error_code
            .as_deref()
            .unwrap_or("GRAPH_UNAVAILABLE"),
        context.health.message.as_deref().unwrap_or("unknown error")
    );
    Ok(())
}

pub(crate) fn project_node(_graph: &EvidenceGraph, node: GraphNode) -> Result<EvidenceNodeViewV1> {
    let data_class = match node.data_class {
        rho_protocol::DataClass::RestrictedSecret => {
            return Err(anyhow!(
                "Evidence Graph exposed restricted-secret node data"
            ));
        }
        value => convert_enum(value)?,
    };
    let authority_ref = node
        .authority_ref
        .as_ref()
        .map(authority_reference_view)
        .transpose()?;
    Ok(EvidenceNodeViewV1 {
        node_id: EvidenceNodeId::new(node.node_id)?,
        kind: convert_enum(node.kind)?,
        stable_key: node.stable_key,
        label: node.label,
        summary: node
            .payload
            .get("summary")
            .and_then(Value::as_str)
            .map(str::to_string),
        claim_kind: node
            .payload
            .get("claim_kind")
            .and_then(Value::as_str)
            .map(str::to_string),
        data_class,
        promotion_state: convert_enum(node.promotion_state)?,
        status: convert_enum(node.status)?,
        authority_ref,
        created_at: node.created_at,
        updated_at: node.updated_at,
    })
}

pub(crate) fn project_subgraph(
    graph: &EvidenceGraph,
    subgraph: EvidenceSubgraph,
) -> Result<EvidenceSubgraphViewV1> {
    let provenance = provenance_for_edges(graph, &subgraph.edges)?;
    Ok(EvidenceSubgraphViewV1 {
        contract: EVIDENCE_GRAPH_VIEW_CONTRACT.to_string(),
        project_id: ui_project_id(graph.project_id())?,
        root_node: project_node(graph, subgraph.root_node)?,
        nodes: subgraph
            .nodes
            .into_iter()
            .map(|node| project_node(graph, node))
            .collect::<Result<Vec<_>>>()?,
        edges: subgraph
            .edges
            .into_iter()
            .map(|edge| project_edge(edge, &provenance))
            .collect::<Result<Vec<_>>>()?,
        truncated: subgraph.truncated,
    })
}

pub(crate) fn project_claim_trace(
    graph: &EvidenceGraph,
    trace: ClaimTrace,
) -> Result<ClaimTraceViewV1> {
    let provenance = provenance_for_edges(graph, &trace.edges)?;
    Ok(ClaimTraceViewV1 {
        contract: EVIDENCE_GRAPH_VIEW_CONTRACT.to_string(),
        project_id: ui_project_id(graph.project_id())?,
        claim: project_node(graph, trace.claim)?,
        nodes: trace
            .nodes
            .into_iter()
            .map(|node| project_node(graph, node))
            .collect::<Result<Vec<_>>>()?,
        edges: trace
            .edges
            .into_iter()
            .map(|edge| project_edge(edge, &provenance))
            .collect::<Result<Vec<_>>>()?,
        gaps: trace
            .gaps
            .into_iter()
            .map(project_gap)
            .collect::<Result<Vec<_>>>()?,
        authority_refs: trace
            .authority_refs
            .iter()
            .map(authority_reference_view)
            .collect::<Result<Vec<_>>>()?,
        truncated: trace.truncated,
    })
}

pub(crate) fn project_gap(gap: GraphGap) -> Result<EvidenceGapViewV1> {
    Ok(EvidenceGapViewV1 {
        gap_id: EvidenceGapId::new(gap.gap_id)?,
        subject_node: gap.subject_node.map(EvidenceNodeId::new).transpose()?,
        rule_id: gap.rule_id,
        status: convert_enum(gap.status)?,
        basis: bounded_gap_facts(&gap.basis),
        detected_revision: gap.detected_revision,
        resolved_revision: gap.resolved_revision,
        detected_at: gap.detected_at,
        resolved_at: gap.resolved_at,
    })
}

fn project_edge(
    edge: GraphEdge,
    provenance: &BTreeMap<String, GraphProvenanceRef>,
) -> Result<EvidenceEdgeViewV1> {
    let reference = edge
        .provenance_ref_id
        .as_ref()
        .and_then(|id| provenance.get(id))
        .map(|value| authority_reference_view(&value.value.reference))
        .transpose()?;
    Ok(EvidenceEdgeViewV1 {
        edge_id: EvidenceEdgeId::new(edge.edge_id)?,
        from_node: EvidenceNodeId::new(edge.from_node)?,
        to_node: EvidenceNodeId::new(edge.to_node)?,
        predicate: convert_enum(edge.predicate)?,
        polarity: convert_enum(edge.polarity)?,
        status: convert_enum(edge.status)?,
        promotion_state: convert_enum(edge.promotion_state)?,
        provenance: reference,
        confidence: edge.confidence,
        created_at: edge.created_at,
        updated_at: edge.updated_at,
    })
}

fn provenance_for_edges(
    graph: &EvidenceGraph,
    edges: &[GraphEdge],
) -> Result<BTreeMap<String, GraphProvenanceRef>> {
    let mut ids = edges
        .iter()
        .filter_map(|edge| edge.provenance_ref_id.clone())
        .collect::<Vec<_>>();
    ids.sort();
    ids.dedup();
    Ok(graph
        .get_provenance_refs(&ids)?
        .into_iter()
        .map(|value| (value.ref_id.clone(), value))
        .collect())
}

pub(crate) async fn resolve_authority_observations(
    state: &AppState,
    context: &ActiveGraphContext,
    references: &[AuthorityRefV1],
) -> Result<Vec<AuthorityObservationV1>> {
    for reference in references {
        ensure!(
            reference.project_id == context.project_id,
            "authority reference belongs to another project"
        );
    }
    let observed_at = Utc::now().to_rfc3339();
    let mut resolved = BTreeMap::new();
    for reference in references
        .iter()
        .filter(|reference| reference.kind == AuthorityKindV1::SourceAnchor)
    {
        let observation = resolve_source_anchor(state, context, reference, &observed_at)?;
        resolved.insert(authority_key(reference), observation);
    }

    let store_refs = references
        .iter()
        .filter(|reference| reference.kind != AuthorityKindV1::SourceAnchor)
        .cloned()
        .collect::<Vec<_>>();
    if !store_refs.is_empty() {
        let executor = store_executor(state).await?;
        let project_root = normalize_project_root(context.root.to_string_lossy().as_ref());
        let observed_at_for_store = observed_at.clone();
        let observations = run_store_executor_service(executor, move |store| {
            let observations = store_refs
                .iter()
                .map(|reference| {
                    resolve_store_reference(store, &project_root, reference, &observed_at_for_store)
                })
                .collect::<std::result::Result<Vec<_>, _>>()?;
            Ok(observations)
        })
        .await?;
        for observation in observations {
            resolved.insert(authority_key(&observation.reference), observation);
        }
    }
    references
        .iter()
        .map(|reference| {
            resolved
                .remove(&authority_key(reference))
                .ok_or_else(|| anyhow!("authority resolver omitted {}", reference.authority_id))
        })
        .collect()
}

fn resolve_store_reference(
    store: &mut rho_store::BorrowedStore<'_>,
    project_root: &str,
    reference: &AuthorityRefV1,
    observed_at: &str,
) -> std::result::Result<AuthorityObservationV1, rho_store::StoreError> {
    let mut limitations = Vec::new();
    let mut digest = None;
    let mut project_revision = None;
    let mut state_revision = None;
    let status = match reference.kind {
        AuthorityKindV1::Run => {
            match store.get_run_detail(project_root, &reference.authority_id)? {
                Some(run) => {
                    project_revision = nonnegative_revision(run.project_revision_after);
                    state_revision = nonnegative_state_revision(run.state_revision_after);
                    map_authority_status(&run.status)
                }
                None => AuthorityStatusV1::Missing,
            }
        }
        AuthorityKindV1::Artifact => {
            match store.get_artifact_record(project_root, &reference.authority_id)? {
                Some(artifact) => {
                    project_revision = nonnegative_revision(artifact.project_revision);
                    state_revision = nonnegative_state_revision(artifact.state_revision);
                    digest = artifact_digest(&artifact.metadata_json);
                    if digest.is_none() {
                        limitations.push(
                            "Artifact exists, but its Store projection has no canonical byte digest."
                                .to_string(),
                        );
                    }
                    AuthorityStatusV1::Present
                }
                None => AuthorityStatusV1::Missing,
            }
        }
        AuthorityKindV1::EnvironmentSnapshot => {
            match store.get_environment_snapshot(&reference.authority_id)? {
                Some(snapshot) if snapshot.project_root == project_root => {
                    digest = AuthorityDigest::new(format!(
                        "sha256:{:x}",
                        Sha256::digest(snapshot.canonical_json.as_bytes())
                    ))
                    .ok();
                    AuthorityStatusV1::Present
                }
                _ => AuthorityStatusV1::Missing,
            }
        }
        AuthorityKindV1::AgentTurn => {
            match store.get_agent_turn_detail(project_root, &reference.authority_id)? {
                Some(detail) => {
                    project_revision = nonnegative_revision(detail.turn.project_revision_after);
                    state_revision = nonnegative_state_revision(detail.turn.state_revision_after);
                    map_authority_status(&detail.turn.status)
                }
                None => AuthorityStatusV1::Missing,
            }
        }
        AuthorityKindV1::Job
        | AuthorityKindV1::Patch
        | AuthorityKindV1::Revision
        | AuthorityKindV1::CheckFinding => {
            limitations.push(
                "This authority kind has no active desktop resolver in the current cut."
                    .to_string(),
            );
            AuthorityStatusV1::Missing
        }
        AuthorityKindV1::SourceAnchor => unreachable!("source anchors resolve from project files"),
    };
    Ok(AuthorityObservationV1 {
        reference: reference.clone(),
        status,
        digest,
        project_revision,
        state_revision,
        observed_at: observed_at.to_string(),
        limitations,
    })
}

fn resolve_source_anchor(
    state: &AppState,
    context: &ActiveGraphContext,
    reference: &AuthorityRefV1,
    observed_at: &str,
) -> Result<AuthorityObservationV1> {
    let node = state
        .evidence_graph
        .with_graph(&context.root, &context.project_id, |graph| {
            graph.get_authority_node(reference)
        });
    let Ok(node) = node else {
        return Ok(missing_observation(
            reference,
            observed_at,
            "Source anchor is not present in the active project graph.",
        ));
    };
    let receipt = node
        .payload
        .get("receipt")
        .cloned()
        .map(serde_json::from_value::<rho_protocol::AuthorityReceiptV1>)
        .transpose()?;
    let Some(rho_protocol::AuthorityReceiptV1::SourceAnchor(anchor)) = receipt else {
        return Ok(missing_observation(
            reference,
            observed_at,
            "Source anchor receipt is unavailable.",
        ));
    };
    let candidate = context.root.join(&anchor.path);
    if !candidate.exists() {
        return Ok(missing_observation(
            reference,
            observed_at,
            "Source file no longer exists.",
        ));
    }
    let path = contained_source_path(&context.root, &anchor.path)?;
    if !path.is_file() {
        return Ok(missing_observation(
            reference,
            observed_at,
            "Source anchor no longer resolves to a regular file.",
        ));
    }
    let current_digest = digest_file(&path)?;
    Ok(AuthorityObservationV1 {
        reference: reference.clone(),
        status: if current_digest == anchor.content_digest {
            AuthorityStatusV1::Present
        } else {
            AuthorityStatusV1::Stale
        },
        digest: Some(current_digest),
        project_revision: Some(anchor.project_revision),
        state_revision: None,
        observed_at: observed_at.to_string(),
        limitations: Vec::new(),
    })
}

fn contained_source_path(root: &Path, relative: &str) -> Result<PathBuf> {
    let candidate = root.join(relative);
    let canonical = candidate
        .canonicalize()
        .with_context(|| format!("resolving source anchor {relative}"))?;
    ensure!(
        canonical.starts_with(root),
        "source anchor escapes project root"
    );
    Ok(canonical)
}

fn digest_file(path: &Path) -> Result<AuthorityDigest> {
    let mut file = std::fs::File::open(path)?;
    let mut digest = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let read = file.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        digest.update(&buffer[..read]);
    }
    AuthorityDigest::new(format!("sha256:{:x}", digest.finalize())).map_err(anyhow::Error::from)
}

fn missing_observation(
    reference: &AuthorityRefV1,
    observed_at: &str,
    limitation: &str,
) -> AuthorityObservationV1 {
    AuthorityObservationV1 {
        reference: reference.clone(),
        status: AuthorityStatusV1::Missing,
        digest: None,
        project_revision: None,
        state_revision: None,
        observed_at: observed_at.to_string(),
        limitations: vec![limitation.to_string()],
    }
}

fn map_authority_status(status: &str) -> AuthorityStatusV1 {
    match status {
        "pending" | "queued" | "requested" | "waiting" => AuthorityStatusV1::Pending,
        "running" | "executing" => AuthorityStatusV1::Running,
        "completed" | "succeeded" | "success" => AuthorityStatusV1::Succeeded,
        "failed" | "error" => AuthorityStatusV1::Failed,
        "cancelled" | "canceled" | "interrupted" => AuthorityStatusV1::Cancelled,
        "committed" => AuthorityStatusV1::Committed,
        _ => AuthorityStatusV1::Uncertain,
    }
}

fn artifact_digest(metadata_json: &str) -> Option<AuthorityDigest> {
    let metadata: Value = serde_json::from_str(metadata_json).ok()?;
    ["digest", "sha256", "content_sha256"]
        .into_iter()
        .filter_map(|key| metadata.get(key).and_then(Value::as_str))
        .find_map(|value| {
            let normalized = if value.starts_with("sha256:") {
                value.to_string()
            } else {
                format!("sha256:{value}")
            };
            AuthorityDigest::new(normalized).ok()
        })
}

fn nonnegative_revision(value: Option<i64>) -> Option<ProjectRevision> {
    value
        .and_then(|value| u64::try_from(value).ok())
        .map(ProjectRevision)
}

fn nonnegative_state_revision(value: Option<i64>) -> Option<StateRevision> {
    value
        .and_then(|value| u64::try_from(value).ok())
        .map(StateRevision)
}

pub(crate) fn authority_reference_view(
    reference: &AuthorityRefV1,
) -> Result<AuthorityReferenceViewV1> {
    Ok(AuthorityReferenceViewV1 {
        kind: convert_enum(reference.kind)?,
        authority_id: reference.authority_id.clone(),
    })
}

pub(crate) fn authority_observation_view(
    observation: AuthorityObservationV1,
) -> Result<AuthorityObservationViewV1> {
    Ok(AuthorityObservationViewV1 {
        reference: authority_reference_view(&observation.reference)?,
        status: convert_enum(observation.status)?,
        digest: observation.digest.map(AuthorityDigest::into_string),
        project_revision: observation.project_revision.map(|value| value.0),
        state_revision: observation.state_revision.map(|value| value.0),
        observed_at: observation.observed_at,
        limitations: observation.limitations,
    })
}

pub(crate) fn protocol_authority_ref(
    project_id: &ProjectId,
    reference: &AuthorityReferenceViewV1,
) -> Result<AuthorityRefV1> {
    Ok(AuthorityRefV1::new(
        project_id.clone(),
        convert_enum::<AuthorityKindViewV1, AuthorityKindV1>(reference.kind)?,
        reference.authority_id.clone(),
    )?)
}

pub(crate) fn ui_project_id(project_id: &ProjectId) -> Result<rho_ui_contract::ProjectId> {
    rho_ui_contract::ProjectId::new(project_id.as_str()).map_err(anyhow::Error::from)
}

pub(crate) fn convert_enum<T, U>(value: T) -> Result<U>
where
    T: Serialize,
    U: DeserializeOwned,
{
    Ok(serde_json::from_value(serde_json::to_value(value)?)?)
}

fn authority_key(reference: &AuthorityRefV1) -> String {
    format!("{:?}:{}", reference.kind, reference.authority_id)
}

fn bounded_gap_facts(value: &Value) -> Vec<EvidenceGapFactV1> {
    let mut facts = match value {
        Value::Object(values) => values
            .iter()
            .map(|(key, value)| EvidenceGapFactV1 {
                key: key.clone(),
                value: bounded_json_text(value),
            })
            .collect::<Vec<_>>(),
        value => vec![EvidenceGapFactV1 {
            key: "basis".to_string(),
            value: bounded_json_text(value),
        }],
    };
    facts.sort_by(|left, right| left.key.cmp(&right.key));
    facts.truncate(32);
    facts
}

fn bounded_json_text(value: &Value) -> String {
    let text = match value {
        Value::String(value) => value.clone(),
        value => value.to_string(),
    };
    text.chars().take(512).collect()
}

#[allow(dead_code)]
fn _assert_graph_health_send(_: GraphHealth) {}
