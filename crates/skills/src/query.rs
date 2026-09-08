use super::*;
use rho_operation::QueryHandler;
use schemars::schema_for;
use serde_json::{Value, json};
#[derive(Clone, Copy)]
pub enum SkillQueryKind {
    List,
    Read,
    ResolveContext,
}
pub struct SkillQueryHandler {
    owner: Arc<SkillOwner>,
    kind: SkillQueryKind,
    descriptor: CapabilityDescriptor,
}
impl SkillQueryHandler {
    pub fn new(owner: Arc<SkillOwner>, kind: SkillQueryKind) -> Self {
        let (id, summary, input_schema, output_schema, example) = match kind {
            SkillQueryKind::List => (
                "skill.list",
                "Discover standard Skills and their source-qualified identities",
                schema_for!(SkillListArguments).to_value(),
                schema_for!(SkillListPage).to_value(),
                json!({"working_directory":"."}),
            ),
            SkillQueryKind::Read => (
                "skill.read",
                "Read an exact Skill body, resource manifest or resource byte page",
                schema_for!(SkillReadArguments).to_value(),
                schema_for!(SkillReadPage).to_value(),
                json!({"working_directory":".","skill_ref":"skill-source:example:scope:manifest","expected_digest":"sha256:example","kind":"manifest"}),
            ),
            SkillQueryKind::ResolveContext => (
                "host.resolve_context",
                "Resolve explicit method bindings against visible Skills and native capabilities",
                schema_for!(ResolveContextArguments).to_value(),
                schema_for!(ResolvedSkillContext).to_value(),
                json!({"working_directory":"."}),
            ),
        };
        Self {owner,kind,descriptor:CapabilityDescriptor {kind:CapabilityKind::Query,capability:CapabilityRef::new(id,1).unwrap(),domain:if matches!(kind,SkillQueryKind::ResolveContext){"host"}else{"skill"}.into(),input_schema,output_schema,recovery_schema:json!({"type":"null"}),documentation:CapabilityDocumentation {summary:summary.into(),purpose:summary.into(),when_to_use:vec!["Discover methods or retrieve the exact method resources needed by an external task".into()],limitations:vec!["Queries do not execute Skill scripts, install dependencies, load R packages or grant permissions".into(),"Names do not merge sources; disabled/rejected host methods cannot be re-enabled by application bindings".into(),"Missing machine-readable dependencies remain undeclared; compatibility prose is not proof of availability".into()],owner:"Skills owner with Application method binding port".into(),effects:"Read source metadata/content and persist resource-read receipts in the Application store; no scientific action".into(),retry_rule:"Retry unchanged reads only while expected digests remain valid; after content changes discover a new reference and reassess the method binding".into(),cancellation_rule:"Bounded read; cancellation does not execute a method or change scientific state".into(),preconditions:vec![CapabilityPrecondition {parameter:"working_directory".into(),requirement:"Explicit normalized project-relative directory; '.' denotes project root".into(),read_from:None}],examples:vec![CapabilityExample {arguments:example,result_explanation:"Catalog entries expose a stable source identity and a content-bound Skill reference; use returned digests for resource reads. Context reports explicit choices and unmet conditions without choosing a workflow.".into()}],related_capabilities:vec![CapabilityRef::new("skill.list",1).unwrap(),CapabilityRef::new("skill.read",1).unwrap(),CapabilityRef::new("host.resolve_context",1).unwrap()],related_skills:vec![],position_units:vec!["Text offsets and limits count UTF-8 bytes; binary offsets count original bytes; manifest offsets count zero-based resource entries".into()]},required_scopes:BTreeSet::from(["skill.read".into()]),potential_effects:BTreeSet::new(),idempotency:IdempotencyClass::Pure,retry:RetryClass::Safe,cancellation:CancellationClass::Unsupported}}
    }
}
#[async_trait]
impl QueryHandler for SkillQueryHandler {
    fn descriptor(&self) -> &CapabilityDescriptor {
        &self.descriptor
    }
    fn normalize_arguments(&self, value: &Value) -> Result<Value, OperationError> {
        match self.kind {
            SkillQueryKind::List => {
                let a: SkillListArguments =
                    serde_json::from_value(value.clone()).map_err(invalid)?;
                validate_relative(&a.working_directory, true)?;
                if a.limit == 0
                    || a.limit > 50
                    || a.filter.len() > 1024
                    || a.cursor.as_ref().is_some_and(|c| c.len() > 256)
                    || a.source_id.as_ref().is_some_and(|s| s.len() > 160)
                {
                    return Err(OperationError::InvalidInput(
                        "Skill listing requires limit 1..=50 and bounded filter/source/cursor"
                            .into(),
                    ));
                }
                serde_json::to_value(a).map_err(invalid)
            }
            SkillQueryKind::Read => {
                let a: SkillReadArguments =
                    serde_json::from_value(value.clone()).map_err(invalid)?;
                validate_relative(&a.working_directory, true)?;
                if a.skill_ref.len() > 512
                    || a.expected_digest.len() > 128
                    || a.limit_bytes == 0
                    || a.limit_bytes > 65536
                    || a.resource_limit == 0
                    || a.resource_limit > 200
                    || a.external_task_ref.as_ref().is_some_and(|r| r.len() > 1024)
                {
                    return Err(OperationError::InvalidInput("Skill read requires bounded references, bytes 1..=65536 and resource_limit 1..=200".into()));
                }
                serde_json::to_value(a).map_err(invalid)
            }
            SkillQueryKind::ResolveContext => {
                let a: ResolveContextArguments =
                    serde_json::from_value(value.clone()).map_err(invalid)?;
                validate_relative(&a.working_directory, true)?;
                if a.limit == 0
                    || a.limit > 50
                    || a.cursor.as_ref().is_some_and(|c| c.len() > 256)
                    || a.external_task_ref.as_ref().is_some_and(|r| r.len() > 1024)
                {
                    return Err(OperationError::InvalidInput(
                        "Context requires limit 1..=50 and bounded task/cursor".into(),
                    ));
                }
                if let Some(target) = &a.target {
                    target.validate()?;
                }
                serde_json::to_value(a).map_err(invalid)
            }
        }
    }
    async fn query(&self, _: &Value) -> Result<QuerySnapshot, OperationError> {
        Err(OperationError::InvalidInput(
            "Skill queries require trusted caller context".into(),
        ))
    }
    async fn query_for(
        &self,
        context: &CallContext,
        value: &Value,
    ) -> Result<QuerySnapshot, OperationError> {
        let mut next_reads = vec![];
        let (data, complete) = match self.kind {
            SkillQueryKind::List => {
                let a: SkillListArguments =
                    serde_json::from_value(value.clone()).map_err(invalid)?;
                let page = self.owner.list(context, &a).await?;
                if let Some(cursor) = &page.next_cursor {
                    let mut next = a.clone();
                    next.cursor = Some(cursor.clone());
                    next_reads.push(NextRead::query(
                        "skill.list",
                        "Continue visible methods and source notices",
                        serde_json::to_value(next).map_err(invalid)?,
                    ));
                }
                for skill in page.skills.iter().take(4) {
                    next_reads.push(NextRead::query("skill.read","Inspect the selected Skill resource manifest",json!({"working_directory":a.working_directory,"skill_ref":skill.skill_ref,"expected_digest":skill.skill_digest,"kind":"manifest"})));
                }
                (serde_json::to_value(&page).map_err(invalid)?, page.complete)
            }
            SkillQueryKind::Read => {
                let a: SkillReadArguments =
                    serde_json::from_value(value.clone()).map_err(invalid)?;
                let page = self.owner.read(context, &a).await?;
                if let Some(offset) = page.next_offset {
                    let mut next = a;
                    next.offset = offset;
                    next_reads.push(NextRead::query(
                        "skill.read",
                        "Continue the same resource version",
                        serde_json::to_value(next).map_err(invalid)?,
                    ));
                }
                (serde_json::to_value(&page).map_err(invalid)?, page.complete)
            }
            SkillQueryKind::ResolveContext => {
                let a: ResolveContextArguments =
                    serde_json::from_value(value.clone()).map_err(invalid)?;
                let result = self.owner.resolve_context(context, &a).await?;
                if let Some(cursor) = &result.discoverable.next_cursor {
                    let mut next = a;
                    next.cursor = Some(cursor.clone());
                    next_reads.push(NextRead::query(
                        "host.resolve_context",
                        "Continue discoverable methods",
                        serde_json::to_value(next).map_err(invalid)?,
                    ));
                }
                (
                    serde_json::to_value(&result).map_err(invalid)?,
                    result.discoverable.complete && result.bindings_complete,
                )
            }
        };
        Ok(QuerySnapshot {
            target: TargetRef {
                kind: "project".into(),
                identity: self.owner.project_root.clone(),
            },
            source: "skills".into(),
            observed_at_ms: SystemClock.now_ms()?,
            status: QueryStatus::Ready,
            completeness: if complete {
                ObservationCompleteness::Complete
            } else {
                ObservationCompleteness::Partial
            },
            data: Some(data),
            notices: vec![],
            next_reads,
            diagnostics: vec![],
        })
    }
}
