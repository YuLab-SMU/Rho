use std::path::{Path, PathBuf};
use std::sync::mpsc::{RecvTimeoutError, Sender, channel};
use std::time::Duration;

use anyhow::{Context, Result, ensure};
use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};

pub const PROJECT_FILES_CHANGED_EVENT: &str = "project://files-changed";

#[derive(Clone, Debug, Serialize)]
pub struct ProjectFile {
    pub path: String,
    pub name: String,
    pub kind: &'static str,
    pub size_bytes: u64,
}

#[derive(Clone, Debug, Serialize, Default)]
pub struct ProjectState {
    pub root: String,
    pub files: Vec<ProjectFile>,
}

#[derive(Clone, Debug, Serialize, Deserialize, Default)]
pub struct PanelSizes {
    pub left: Option<u32>,
    pub right: Option<u32>,
    pub dock: Option<u32>,
}

#[derive(Clone, Debug, Serialize, Deserialize, Default)]
pub struct ProjectDocumentSession {
    pub path: String,
    pub cursor_start: usize,
    pub cursor_end: usize,
    pub draft_content: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, Default)]
pub struct ProjectSessionSnapshot {
    pub open_documents: Vec<ProjectDocumentSession>,
    pub active_document: Option<String>,
    pub panels: PanelSizes,
}

#[derive(Clone, Debug, Serialize, Deserialize, Default)]
struct GlobalProjectIndex {
    last_opened_project: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
pub struct UnavailableProject {
    pub path: String,
    pub reason: String,
}

#[derive(Clone, Debug, Serialize, Default)]
pub struct ProjectRestoreResponse {
    pub status: String,
    pub project: Option<ProjectState>,
    pub session: ProjectSessionSnapshot,
    pub unavailable: Option<UnavailableProject>,
}

impl ProjectRestoreResponse {
    pub fn ready(project: ProjectState, session: ProjectSessionSnapshot) -> Self {
        Self {
            status: "ready".to_string(),
            project: Some(project),
            session,
            unavailable: None,
        }
    }

    pub fn unavailable(path: String, reason: impl Into<String>) -> Self {
        Self {
            status: "unavailable".to_string(),
            project: None,
            session: ProjectSessionSnapshot::default(),
            unavailable: Some(UnavailableProject {
                path,
                reason: reason.into(),
            }),
        }
    }

    pub fn cancelled() -> Self {
        Self {
            status: "cancelled".to_string(),
            project: None,
            session: ProjectSessionSnapshot::default(),
            unavailable: None,
        }
    }
}

#[derive(Clone, Serialize)]
pub struct ProjectFileChangeEvent {
    pub root: String,
    pub changed_paths: Vec<String>,
}

#[derive(Clone)]
pub struct ProjectSessionStore {
    index_path: PathBuf,
    sessions_dir: PathBuf,
}

impl ProjectSessionStore {
    pub fn new(data_dir: PathBuf) -> Result<Self> {
        let session_dir = data_dir.join("project-sessions");
        std::fs::create_dir_all(&session_dir)?;
        Ok(Self {
            index_path: session_dir.join("index.json"),
            sessions_dir: session_dir.join("projects"),
        })
    }

    pub fn last_opened_project(&self) -> Result<Option<PathBuf>> {
        let index = self.load_index_or_default()?;
        Ok(index.last_opened_project.map(PathBuf::from))
    }

    pub fn save_last_opened_project(&self, root: &Path) -> Result<()> {
        std::fs::create_dir_all(&self.sessions_dir)?;
        let index = GlobalProjectIndex {
            last_opened_project: Some(root.to_string_lossy().replace('\\', "/")),
        };
        self.write_json(&self.index_path, &index)
    }

    pub fn load_session(&self, root: &Path) -> Result<ProjectSessionSnapshot> {
        std::fs::create_dir_all(&self.sessions_dir)?;
        let path = self.session_path(root);
        if !path.is_file() {
            return Ok(ProjectSessionSnapshot::default());
        }
        let content = std::fs::read_to_string(&path)?;
        serde_json::from_str(&content).with_context(|| format!("parsing {}", path.display()))
    }

    pub fn load_session_or_default(&self, root: &Path) -> ProjectSessionSnapshot {
        self.load_session(root).unwrap_or_default()
    }

    pub fn save_session(&self, root: &Path, snapshot: &ProjectSessionSnapshot) -> Result<()> {
        std::fs::create_dir_all(&self.sessions_dir)?;
        self.write_json(&self.session_path(root), snapshot)
    }

    pub fn session_path(&self, root: &Path) -> PathBuf {
        self.sessions_dir
            .join(format!("{}.json", stable_project_key(root)))
    }

    fn load_index_or_default(&self) -> Result<GlobalProjectIndex> {
        if !self.index_path.is_file() {
            return Ok(GlobalProjectIndex::default());
        }
        let content = std::fs::read_to_string(&self.index_path)?;
        serde_json::from_str(&content).or_else(|_| Ok(GlobalProjectIndex::default()))
    }

    fn write_json<T: Serialize>(&self, path: &Path, value: &T) -> Result<()> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        std::fs::write(path, serde_json::to_vec_pretty(value)?)?;
        Ok(())
    }
}

pub struct ProjectWatcherControl {
    stop_tx: Sender<()>,
}

impl ProjectWatcherControl {
    pub fn stop(self) {
        let _ = self.stop_tx.send(());
    }
}

pub fn replace_project_watcher(
    watcher: &mut Option<ProjectWatcherControl>,
    app: AppHandle,
    root: PathBuf,
) -> Result<()> {
    if let Some(existing) = watcher.take() {
        existing.stop();
    }
    *watcher = Some(start_project_watcher(app, root)?);
    Ok(())
}

pub fn start_project_watcher(app: AppHandle, root: PathBuf) -> Result<ProjectWatcherControl> {
    let (event_tx, event_rx) = channel();
    let (stop_tx, stop_rx) = channel();
    let mut watcher: RecommendedWatcher = notify::recommended_watcher(move |result| {
        let _ = event_tx.send(result);
    })?;
    watcher.watch(&root, RecursiveMode::Recursive)?;
    let normalized_root = root.clone();
    std::thread::spawn(move || {
        let _watcher = watcher;
        loop {
            if stop_rx.try_recv().is_ok() {
                break;
            }
            match event_rx.recv_timeout(Duration::from_millis(250)) {
                Ok(Ok(event)) => {
                    let changed_paths = event
                        .paths
                        .iter()
                        .filter_map(|path| relative_project_path(&normalized_root, path).ok())
                        .filter(|path| {
                            path.is_empty() || ensure_editable_file(Path::new(path)).is_ok()
                        })
                        .collect::<Vec<_>>();
                    let payload = ProjectFileChangeEvent {
                        root: normalized_root.to_string_lossy().replace('\\', "/"),
                        changed_paths,
                    };
                    let _ = app.emit(PROJECT_FILES_CHANGED_EVENT, payload);
                }
                Ok(Err(_)) => continue,
                Err(RecvTimeoutError::Timeout) => continue,
                Err(RecvTimeoutError::Disconnected) => break,
            }
        }
    });
    Ok(ProjectWatcherControl { stop_tx })
}

pub fn default_project_root() -> PathBuf {
    let development = PathBuf::from(r"D:\Rho");
    if development.is_dir() {
        return development;
    }
    std::env::var_os("USERPROFILE")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."))
        .join("Documents")
        .join("Rho")
}

pub fn validate_project_root(path: &Path) -> Result<PathBuf> {
    normalize_project_root(path, true)
}

pub fn normalize_existing_project_root(path: &Path) -> Result<PathBuf> {
    normalize_project_root(path, false)
}

fn normalize_project_root(path: &Path, create_if_missing: bool) -> Result<PathBuf> {
    let root = if path.exists() {
        path.canonicalize()?
    } else if create_if_missing {
        std::fs::create_dir_all(path)?;
        path.canonicalize()?
    } else {
        anyhow::bail!("Project path does not exist");
    };
    ensure!(root.is_dir(), "Project path is not a directory");
    Ok(root)
}

pub fn project_path(root: &Path, relative: &str) -> Result<PathBuf> {
    ensure!(!relative.trim().is_empty(), "Project file path is empty");
    let candidate = root.join(relative);
    let normalized = if candidate.exists() {
        candidate.canonicalize()?
    } else {
        let parent = candidate
            .parent()
            .context("Project file path has no parent")?;
        std::fs::create_dir_all(parent)?;
        parent.canonicalize()?.join(
            candidate
                .file_name()
                .context("Project file path has no file name")?,
        )
    };
    ensure!(
        normalized.starts_with(root),
        "Project file path escapes project root"
    );
    Ok(normalized)
}

pub fn ensure_editable_file(path: &Path) -> Result<()> {
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    ensure!(
        matches!(
            extension.as_str(),
            "r" | "rmd" | "qmd" | "txt" | "csv" | "tsv"
        ),
        "Unsupported project file type: .{extension}"
    );
    Ok(())
}

pub fn list_project_files(root: &Path) -> Result<ProjectState> {
    let mut files = Vec::new();
    collect_project_files(root, root, &mut files, 0)?;
    files.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(ProjectState {
        root: root.to_string_lossy().replace('\\', "/"),
        files,
    })
}

fn collect_project_files(
    root: &Path,
    directory: &Path,
    files: &mut Vec<ProjectFile>,
    depth: usize,
) -> Result<()> {
    if depth > 4 {
        return Ok(());
    }
    for entry in std::fs::read_dir(directory)? {
        let entry = entry?;
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().to_string();
        if name.starts_with('.') || name == "target" || name == "renv" {
            continue;
        }
        if path.is_dir() {
            collect_project_files(root, &path, files, depth + 1)?;
            continue;
        }
        if !path.is_file() || ensure_editable_file(&path).is_err() {
            continue;
        }
        let relative = relative_project_path(root, &path)?;
        files.push(ProjectFile {
            path: relative,
            name,
            kind: "source",
            size_bytes: path.metadata()?.len(),
        });
    }
    Ok(())
}

pub fn relative_project_path(root: &Path, path: &Path) -> Result<String> {
    Ok(path
        .strip_prefix(root)?
        .to_string_lossy()
        .replace('\\', "/"))
}

pub fn stable_project_key(root: &Path) -> String {
    root.to_string_lossy()
        .as_bytes()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>()
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn project_paths_stay_inside_root() {
        let directory = TempDir::new().unwrap();
        let root = directory.path().canonicalize().unwrap();
        let nested = project_path(&root, "analysis.R").unwrap();
        assert!(nested.starts_with(&root));
        assert!(project_path(&root, "../outside.R").is_err());
    }

    #[test]
    fn project_files_only_include_supported_sources() {
        let directory = TempDir::new().unwrap();
        std::fs::write(directory.path().join("analysis.R"), "1 + 1").unwrap();
        std::fs::write(directory.path().join("notes.md"), "notes").unwrap();
        let root = directory.path().canonicalize().unwrap();
        let state = list_project_files(&root).unwrap();
        assert_eq!(state.files.len(), 1);
        assert_eq!(state.files[0].path, "analysis.R");
    }

    #[test]
    fn project_session_store_round_trips() {
        let directory = TempDir::new().unwrap();
        let project_dir = directory.path().join("analysis");
        std::fs::create_dir_all(&project_dir).unwrap();
        let store = ProjectSessionStore::new(directory.path().join("data")).unwrap();
        let snapshot = ProjectSessionSnapshot {
            open_documents: vec![ProjectDocumentSession {
                path: "analysis.R".to_string(),
                cursor_start: 4,
                cursor_end: 9,
                draft_content: Some("x <- 1".to_string()),
            }],
            active_document: Some("analysis.R".to_string()),
            panels: PanelSizes {
                left: Some(200),
                right: Some(320),
                dock: Some(280),
            },
        };
        store.save_last_opened_project(&project_dir).unwrap();
        store.save_session(&project_dir, &snapshot).unwrap();
        assert_eq!(
            store.last_opened_project().unwrap().unwrap(),
            PathBuf::from(project_dir.to_string_lossy().to_string())
        );
        let restored = store.load_session(&project_dir).unwrap();
        assert_eq!(restored.active_document.as_deref(), Some("analysis.R"));
        assert_eq!(
            restored.open_documents[0].draft_content.as_deref(),
            Some("x <- 1")
        );
        assert_eq!(restored.panels.dock, Some(280));
    }

    #[test]
    fn missing_or_invalid_session_degrades_to_default() {
        let directory = TempDir::new().unwrap();
        let project_dir = directory.path().join("analysis");
        std::fs::create_dir_all(&project_dir).unwrap();
        let store = ProjectSessionStore::new(directory.path().join("data")).unwrap();
        let path = store.session_path(&project_dir);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, "{not json").unwrap();
        let restored = store.load_session_or_default(&project_dir);
        assert!(restored.open_documents.is_empty());
        assert!(restored.active_document.is_none());
    }

    #[test]
    fn normalize_existing_project_root_rejects_missing_directory() {
        let directory = TempDir::new().unwrap();
        let path = directory.path().join("missing");
        assert!(normalize_existing_project_root(&path).is_err());
    }
}
