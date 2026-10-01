#![forbid(unsafe_code)]
//! Private annotation database. It never opens the Host journal or Application database.
mod annotations;
use rusqlite::Connection;
use std::{path::Path, sync::Mutex, time::Duration};
pub struct AnnotationStore(pub(crate) Mutex<Connection>);
impl AnnotationStore {
    pub fn open(path: &Path) -> Result<Self, String> {
        if let Some(parent) = path.parent().filter(|p| !p.as_os_str().is_empty()) {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        let connection = Connection::open(path).map_err(|e| e.to_string())?;
        connection
            .busy_timeout(Duration::from_secs(5))
            .map_err(|e| e.to_string())?;
        connection
            .execute_batch("PRAGMA synchronous = FULL;")
            .map_err(|e| e.to_string())?;
        annotations::initialize(&connection)?;
        Ok(Self(Mutex::new(connection)))
    }
}
