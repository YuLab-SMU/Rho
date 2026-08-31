use serde::{Deserialize, Serialize};
use thiserror::Error;

use crate::DataClass;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ClassifiedSource {
    pub source_id: String,
    pub data_class: DataClass,
}

#[derive(Debug, Error, Clone, PartialEq, Eq)]
pub enum ClassificationError {
    #[error("data classification is missing or unknown")]
    MissingOrUnknown,
    #[error("classification source set is empty")]
    EmptySources,
}

pub fn combine_classifications(
    sources: &[ClassifiedSource],
) -> Result<DataClass, ClassificationError> {
    let mut values = sources.iter().map(|source| source.data_class);
    let first = values.next().ok_or(ClassificationError::EmptySources)?;
    Ok(values.fold(first, DataClass::join))
}
