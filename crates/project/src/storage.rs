use super::*;

#[derive(Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
struct StorageArguments {}

pub struct ProjectStorageHandler {
    owner: Arc<ProjectOwner>,
    descriptor: CapabilityDescriptor,
}
impl ProjectStorageHandler {
    pub fn new(owner: Arc<ProjectOwner>) -> Self {
        Self {
            owner,
            descriptor: descriptor(
                "project.storage_status",
                CapabilityKind::Query,
                schema_for!(StorageArguments).to_value(),
                schema_for!(ProjectStorage).to_value(),
            ),
        }
    }
}
#[async_trait]
impl QueryHandler for ProjectStorageHandler {
    fn descriptor(&self) -> &CapabilityDescriptor {
        &self.descriptor
    }
    fn normalize_arguments(&self, value: &Value) -> Result<Value, OperationError> {
        let args: StorageArguments = serde_json::from_value(value.clone()).map_err(invalid)?;
        serde_json::to_value(args).map_err(invalid)
    }
    async fn query(&self, value: &Value) -> Result<QuerySnapshot, OperationError> {
        self.normalize_arguments(value)?;
        let mut reply = QuerySnapshot {
            target: self.owner.target(),
            source: "filesystem capacity".into(),
            observed_at_ms: SystemClock.now_ms()?,
            status: QueryStatus::Unavailable,
            completeness: ObservationCompleteness::Unknown,
            data: None,
            notices: Vec::new(),
            next_reads: Vec::new(),
            diagnostics: Vec::new(),
        };
        // Capacity reads do not read project files or contend with their write lane.
        match self.owner.runtime.storage_status().await {
            Ok(storage)
                if storage.project == self.owner.runtime.root()
                    && storage.total_bytes > 0
                    && storage.available_bytes <= storage.total_bytes
                    && storage.free_bytes <= storage.total_bytes =>
            {
                reply.observed_at_ms = storage.observed_at_ms;
                reply.status = QueryStatus::Ready;
                reply.completeness = ObservationCompleteness::Complete;
                reply.data = Some(serde_json::to_value(storage).map_err(invalid)?);
            }
            Ok(_) => reply
                .notices
                .push("Invalid project disk observation".into()),
            Err(error) => reply.notices.push(error),
        }
        Ok(reply)
    }
}
