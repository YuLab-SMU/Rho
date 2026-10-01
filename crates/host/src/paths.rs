use std::path::{Path, PathBuf};

pub fn default_database() -> PathBuf {
    let base = if cfg!(target_os = "windows") {
        std::env::var_os("LOCALAPPDATA").map(PathBuf::from)
    } else if cfg!(target_os = "macos") {
        std::env::var_os("HOME").map(|p| PathBuf::from(p).join("Library/Application Support"))
    } else {
        std::env::var_os("XDG_DATA_HOME")
            .map(PathBuf::from)
            .or_else(|| std::env::var_os("HOME").map(|p| PathBuf::from(p).join(".local/share")))
    };
    base.unwrap_or_else(std::env::temp_dir)
        .join("rho/next.sqlite")
}

/// Candidates include future SQLite sidecars. Adapters retain lexical and resolved exclusions.
pub(crate) fn protected_path_candidates(database: &Path) -> Vec<PathBuf> {
    let application = database.with_extension("studio.sqlite");
    let preferences = database
        .parent()
        .unwrap_or(Path::new("."))
        .join("runtime-preferences.sqlite");
    let mut paths = vec![
        database.to_path_buf(),
        rho_plugins::repository_path(database),
        application.clone(),
        preferences.clone(),
    ];
    for store in [application, preferences] {
        for suffix in ["-journal", "-wal", "-shm"] {
            let mut path = store.as_os_str().to_os_string();
            path.push(suffix);
            paths.push(path.into());
        }
    }
    let mut journals = vec![database.to_path_buf()];
    if let Ok(canonical) = database.canonicalize() {
        journals.push(canonical);
    }
    for journal in journals {
        paths.push(journal.clone());
        for suffix in [".host.lock", "-journal", "-wal", "-shm"] {
            let mut path = journal.as_os_str().to_os_string();
            path.push(suffix);
            paths.push(path.into());
        }
    }
    paths.sort();
    paths.dedup();
    paths
}
