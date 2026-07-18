use std::collections::BTreeSet;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::mpsc::{RecvTimeoutError, Sender, channel};
use std::time::{Duration, Instant};

use anyhow::{Context, Result, ensure};
use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};

pub const PROJECT_FILES_CHANGED_EVENT: &str = "project://files-changed";
pub const MAX_EDITABLE_FILE_BYTES: u64 = 8 * 1024 * 1024;
pub const MAX_PROJECT_FILES: usize = 2_000;
pub const MAX_PROJECT_ENTRIES: usize = 10_000;
pub const MAX_PROJECT_DEPTH: usize = 8;

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
    pub truncated: bool,
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
#[serde(default)]
pub struct ProjectSessionSnapshot {
    pub open_documents: Vec<ProjectDocumentSession>,
    pub closed_documents: Vec<ProjectDocumentSession>,
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
            last_opened_project: Some(display_path(root)),
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
        atomic_write(path, &serde_json::to_vec_pretty(value)?)
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
                    let mut changed_paths = BTreeSet::new();
                    collect_changed_paths(&normalized_root, &event.paths, &mut changed_paths);
                    let coalesce_started = Instant::now();
                    loop {
                        let remaining =
                            Duration::from_millis(500).saturating_sub(coalesce_started.elapsed());
                        if remaining.is_zero() {
                            break;
                        }
                        match event_rx.recv_timeout(remaining.min(Duration::from_millis(120))) {
                            Ok(Ok(next)) => collect_changed_paths(
                                &normalized_root,
                                &next.paths,
                                &mut changed_paths,
                            ),
                            Ok(Err(_)) => continue,
                            Err(RecvTimeoutError::Timeout) => break,
                            Err(RecvTimeoutError::Disconnected) => return,
                        }
                    }
                    if changed_paths.is_empty() {
                        continue;
                    }
                    let payload = ProjectFileChangeEvent {
                        root: display_path(&normalized_root),
                        changed_paths: changed_paths.into_iter().collect(),
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
    let relative = Path::new(relative);
    ensure!(relative.is_relative(), "Project file path must be relative");
    ensure!(
        relative.components().all(|component| matches!(
            component,
            std::path::Component::Normal(_) | std::path::Component::CurDir
        )),
        "Project file path contains a parent, root or drive prefix"
    );
    let candidate = root.join(relative);
    let normalized = if candidate.exists() {
        candidate.canonicalize()?
    } else {
        let parent = candidate
            .parent()
            .context("Project file path has no parent")?;
        let mut existing_ancestor = parent;
        while !existing_ancestor.exists() {
            existing_ancestor = existing_ancestor
                .parent()
                .context("Project file path has no existing ancestor")?;
        }
        let canonical_ancestor = existing_ancestor.canonicalize()?;
        ensure!(
            canonical_ancestor.starts_with(root),
            "Project file path escapes project root"
        );
        canonical_ancestor.join(candidate.strip_prefix(existing_ancestor)?)
    };
    ensure!(
        normalized.starts_with(root),
        "Project file path escapes project root"
    );
    Ok(normalized)
}

pub fn ensure_editable_file(path: &Path) -> Result<()> {
    let file_name = path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    ensure!(
        matches!(
            file_name.as_str(),
            "description"
                | "namespace"
                | "license"
                | "news"
                | ".rbuildignore"
                | ".gitignore"
                | ".renviron"
                | ".rprofile"
        ) || matches!(
            extension.as_str(),
            "r" | "rmd"
                | "qmd"
                | "rd"
                | "rproj"
                | "md"
                | "txt"
                | "csv"
                | "tsv"
                | "yaml"
                | "yml"
                | "json"
                | "toml"
                | "ini"
                | "html"
                | "css"
                | "js"
                | "ts"
                | "jsx"
                | "tsx"
                | "sql"
                | "stan"
                | "c"
                | "cc"
                | "cpp"
                | "h"
                | "hpp"
                | "sh"
                | "ps1"
                | "bat"
        ),
        "Unsupported or binary project file: {file_name}"
    );
    Ok(())
}

fn ignored_project_directory(name: &str) -> bool {
    matches!(
        name.to_ascii_lowercase().as_str(),
        ".git" | ".rho" | ".rproj.user" | ".worktrees" | "target" | "renv" | "node_modules"
    )
}

fn collect_changed_paths(root: &Path, paths: &[PathBuf], output: &mut BTreeSet<String>) {
    output.extend(
        paths
            .iter()
            .filter_map(|path| relative_project_path(root, path).ok())
            .filter(|path| path.is_empty() || ensure_editable_file(Path::new(path)).is_ok()),
    );
}

pub fn ensure_editable_file_size(path: &Path) -> Result<()> {
    let size = path.metadata()?.len();
    ensure!(
        size <= MAX_EDITABLE_FILE_BYTES,
        "Project file is too large for the source editor: {size} bytes (limit: {MAX_EDITABLE_FILE_BYTES} bytes)"
    );
    Ok(())
}

pub fn ensure_editable_content_size(content: &str) -> Result<()> {
    let size = content.len() as u64;
    ensure!(
        size <= MAX_EDITABLE_FILE_BYTES,
        "Project file content is too large for the source editor: {size} bytes (limit: {MAX_EDITABLE_FILE_BYTES} bytes)"
    );
    Ok(())
}

pub fn atomic_write(path: &Path, content: &[u8]) -> Result<()> {
    let parent = path.parent().context("Project file path has no parent")?;
    std::fs::create_dir_all(parent)?;
    let mut temporary = tempfile::NamedTempFile::new_in(parent)?;
    temporary.write_all(content)?;
    temporary.as_file().sync_all()?;
    temporary
        .persist(path)
        .map_err(|error| anyhow::Error::new(error.error))?;
    Ok(())
}

pub fn atomic_write_new(path: &Path, content: &[u8]) -> Result<()> {
    let parent = path.parent().context("Project file path has no parent")?;
    std::fs::create_dir_all(parent)?;
    let mut temporary = tempfile::NamedTempFile::new_in(parent)?;
    temporary.write_all(content)?;
    temporary.as_file().sync_all()?;
    temporary
        .persist_noclobber(path)
        .map_err(|error| anyhow::Error::new(error.error))?;
    Ok(())
}

pub fn list_project_files(root: &Path) -> Result<ProjectState> {
    let mut files = Vec::new();
    let mut scanned_entries = 0;
    let truncated = collect_project_files(root, root, &mut files, &mut scanned_entries, 0)?;
    files.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(ProjectState {
        root: display_path(root),
        files,
        truncated,
    })
}

fn collect_project_files(
    root: &Path,
    directory: &Path,
    files: &mut Vec<ProjectFile>,
    scanned_entries: &mut usize,
    depth: usize,
) -> Result<bool> {
    if depth > MAX_PROJECT_DEPTH {
        return Ok(true);
    }
    let remaining_entries = MAX_PROJECT_ENTRIES.saturating_sub(*scanned_entries);
    if remaining_entries == 0 {
        return Ok(true);
    }
    let mut entries = std::fs::read_dir(directory)?
        .take(remaining_entries + 1)
        .collect::<std::io::Result<Vec<_>>>()?;
    let entry_limit_reached = entries.len() > remaining_entries;
    entries.truncate(remaining_entries);
    *scanned_entries += entries.len();
    entries.sort_by_key(|entry| entry.file_name().to_string_lossy().to_ascii_lowercase());
    let mut directories = Vec::new();
    for entry in entries {
        if files.len() >= MAX_PROJECT_FILES {
            return Ok(true);
        }
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().to_string();
        let file_type = entry.file_type()?;
        if file_type.is_symlink() {
            continue;
        }
        if file_type.is_dir() {
            if ignored_project_directory(&name) {
                continue;
            }
            let canonical = path.canonicalize()?;
            if canonical.starts_with(root) {
                directories.push(path);
            }
            continue;
        }
        if !file_type.is_file() || ensure_editable_file(&path).is_err() {
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
    if entry_limit_reached {
        return Ok(true);
    }
    for directory in directories {
        if collect_project_files(root, &directory, files, scanned_entries, depth + 1)? {
            return Ok(true);
        }
    }
    Ok(false)
}

pub fn relative_project_path(root: &Path, path: &Path) -> Result<String> {
    Ok(path
        .strip_prefix(root)?
        .to_string_lossy()
        .replace('\\', "/"))
}

pub fn stable_project_key(root: &Path) -> String {
    let mut hash = 0xcbf29ce484222325_u64;
    for byte in display_path(root).as_bytes() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x100000001b3);
    }
    format!("{hash:016x}")
}

pub fn display_path(path: &Path) -> String {
    let normalized = path.to_string_lossy().replace('\\', "/");
    if let Some(rest) = normalized.strip_prefix("//?/UNC/") {
        return format!("//{rest}");
    }
    normalized
        .strip_prefix("//?/")
        .unwrap_or(&normalized)
        .to_string()
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
    fn project_files_exclude_unsupported_binary_files() {
        let directory = TempDir::new().unwrap();
        std::fs::write(directory.path().join("analysis.R"), "1 + 1").unwrap();
        std::fs::write(directory.path().join("figure.png"), [0_u8, 1, 2]).unwrap();
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
            closed_documents: Vec::new(),
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

    #[test]
    fn rejected_project_path_does_not_create_outside_directories() {
        let directory = TempDir::new().unwrap();
        let project = directory.path().join("project");
        std::fs::create_dir_all(&project).unwrap();
        let root = project.canonicalize().unwrap();
        let outside = directory.path().join("outside");

        assert!(project_path(&root, "../outside/analysis.R").is_err());
        assert!(!outside.exists());
    }

    #[test]
    fn project_session_key_has_fixed_windows_safe_length() {
        let root = PathBuf::from(format!(r"C:\{}", "nested\\".repeat(80)));
        let key = stable_project_key(&root);
        assert_eq!(key.len(), 16);
        assert!(key.bytes().all(|byte| byte.is_ascii_hexdigit()));
    }

    #[test]
    fn project_files_preserve_r_package_content_for_the_frontend_tree() {
        let directory = TempDir::new().unwrap();
        std::fs::create_dir_all(directory.path().join("R")).unwrap();
        std::fs::create_dir_all(directory.path().join("man")).unwrap();
        std::fs::create_dir_all(directory.path().join("tests/testthat")).unwrap();
        std::fs::write(directory.path().join("DESCRIPTION"), "Package: example").unwrap();
        std::fs::write(directory.path().join("NAMESPACE"), "export(example)").unwrap();
        std::fs::write(directory.path().join(".Rbuildignore"), "^notes$").unwrap();
        std::fs::write(
            directory.path().join("R/example.R"),
            "example <- function() 1",
        )
        .unwrap();
        std::fs::write(directory.path().join("man/example.Rd"), "\\name{example}").unwrap();
        std::fs::write(
            directory.path().join("tests/testthat/test-example.R"),
            "testthat::expect_true(TRUE)",
        )
        .unwrap();
        std::fs::write(directory.path().join("logo.png"), [0_u8, 1, 2]).unwrap();

        let root = directory.path().canonicalize().unwrap();
        let paths = list_project_files(&root)
            .unwrap()
            .files
            .into_iter()
            .map(|file| file.path)
            .collect::<Vec<_>>();

        assert_eq!(
            paths,
            vec![
                ".Rbuildignore",
                "DESCRIPTION",
                "NAMESPACE",
                "R/example.R",
                "man/example.Rd",
                "tests/testthat/test-example.R",
            ]
        );
    }

    #[test]
    fn windows_extended_paths_are_user_readable_and_stable() {
        assert_eq!(
            display_path(Path::new(r"\\?\E:\YuNotebooks\project")),
            "E:/YuNotebooks/project"
        );
        assert_eq!(
            display_path(Path::new(r"\\?\UNC\server\share\project")),
            "//server/share/project"
        );
        assert_eq!(
            stable_project_key(Path::new(r"\\?\E:\YuNotebooks\project")),
            stable_project_key(Path::new(r"E:\YuNotebooks\project"))
        );
    }

    #[test]
    fn oversized_project_files_are_rejected_before_editor_read() {
        let directory = TempDir::new().unwrap();
        let path = directory.path().join("large.csv");
        let file = std::fs::File::create(&path).unwrap();
        file.set_len(MAX_EDITABLE_FILE_BYTES + 1).unwrap();

        assert!(ensure_editable_file_size(&path).is_err());
        assert!(ensure_editable_content_size(&"x".repeat(1024)).is_ok());
    }

    #[test]
    fn atomic_writes_replace_or_preserve_as_requested() {
        let directory = TempDir::new().unwrap();
        let path = directory.path().join("analysis.R");
        std::fs::write(&path, "old").unwrap();

        atomic_write(&path, b"new").unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "new");

        assert!(atomic_write_new(&path, b"unexpected").is_err());
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "new");
    }
}
