use std::{
    collections::BTreeMap,
    fs::{self, File},
    io::Write,
    path::{Path, PathBuf},
};

use rho_protocol::{ExecutionId, OperationId};
use serde::{Deserialize, Serialize};
use thiserror::Error;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum RunnerJobState {
    Prepared,
    Submitted,
    Running,
    Succeeded,
    Failed,
    Cancelled,
    Uncertain,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct RunnerProcessHandle {
    pub handle_id: String,
    pub pid: Option<u32>,
    pub start_identity: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct RunnerJobRecord {
    pub execution_id: ExecutionId,
    pub operation_id: OperationId,
    pub spec_digest: String,
    pub command_id: String,
    pub argv: Vec<String>,
    pub remote_job_id: String,
    pub state: RunnerJobState,
    pub process_handle: Option<RunnerProcessHandle>,
    pub terminal_reason_code: Option<String>,
    pub artifact_manifest_digests: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
struct JournalDocument {
    schema_version: u16,
    records: BTreeMap<OperationId, RunnerJobRecord>,
}

#[derive(Debug, Error)]
pub enum RunnerJournalError {
    #[error("runner journal IO failed")]
    Io(#[from] std::io::Error),
    #[error("runner journal is malformed or unsupported")]
    Malformed,
    #[error("runner operation conflicts with an existing spec")]
    OperationConflict,
    #[error("runner operation is unknown")]
    UnknownOperation,
}

pub struct RunnerJournal {
    path: PathBuf,
    document: JournalDocument,
}

impl RunnerJournal {
    pub fn open(path: impl AsRef<Path>) -> Result<Self, RunnerJournalError> {
        let path = path.as_ref().to_path_buf();
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }
        let document = if path.exists() {
            let document: JournalDocument = serde_json::from_slice(&fs::read(&path)?)
                .map_err(|_| RunnerJournalError::Malformed)?;
            if document.schema_version != 1 {
                return Err(RunnerJournalError::Malformed);
            }
            document
        } else {
            JournalDocument {
                schema_version: 1,
                records: BTreeMap::new(),
            }
        };
        Ok(Self { path, document })
    }

    pub fn prepare(
        &mut self,
        record: RunnerJobRecord,
    ) -> Result<(RunnerJobRecord, bool), RunnerJournalError> {
        if let Some(existing) = self.document.records.get(&record.operation_id) {
            if existing.spec_digest != record.spec_digest
                || existing.execution_id != record.execution_id
            {
                return Err(RunnerJournalError::OperationConflict);
            }
            return Ok((existing.clone(), true));
        }
        self.document
            .records
            .insert(record.operation_id.clone(), record.clone());
        self.persist()?;
        Ok((record, false))
    }

    pub fn update(
        &mut self,
        operation_id: &OperationId,
        update: impl FnOnce(&mut RunnerJobRecord),
    ) -> Result<RunnerJobRecord, RunnerJournalError> {
        let record = self
            .document
            .records
            .get_mut(operation_id)
            .ok_or(RunnerJournalError::UnknownOperation)?;
        update(record);
        let record = record.clone();
        self.persist()?;
        Ok(record)
    }

    pub fn by_operation(&self, operation_id: &OperationId) -> Option<&RunnerJobRecord> {
        self.document.records.get(operation_id)
    }

    pub fn by_execution(&self, execution_id: &ExecutionId) -> Option<&RunnerJobRecord> {
        self.document
            .records
            .values()
            .find(|record| &record.execution_id == execution_id)
    }

    pub fn records(&self) -> impl Iterator<Item = &RunnerJobRecord> {
        self.document.records.values()
    }

    fn persist(&self) -> Result<(), RunnerJournalError> {
        let temp = self.path.with_extension("json.tmp");
        let bytes =
            serde_json::to_vec(&self.document).map_err(|_| RunnerJournalError::Malformed)?;
        {
            let mut file = File::create(&temp)?;
            file.write_all(&bytes)?;
            file.sync_all()?;
        }
        fs::rename(&temp, &self.path)?;
        if let Some(parent) = self.path.parent() {
            File::open(parent)?.sync_all()?;
        }
        Ok(())
    }
}
