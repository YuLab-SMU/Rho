#![forbid(unsafe_code)]
mod text;

use async_trait::async_trait;
use rho_process_engine::{ProcessOptions, ProcessTermination, run_command};
use rho_files_api::{
    FileObservation, FilePage, GitApplyReport, GitObservation, GitStatusEntry, MAX_PROJECT_PATHS,
    ProjectRuntime, ProjectSnapshot, ReadFileArguments, validate_path,
};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeSet,
    path::{Path, PathBuf},
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tokio::io::{AsyncReadExt, AsyncSeekExt};

const MAX_OUTPUT_BYTES: u64 = 4 * 1024 * 1024;
const MAX_FILE_BYTES: u64 = 64 * 1024 * 1024;

pub struct GitProject {
    root: PathBuf,
    identity: String,
    excluded: Vec<PathBuf>,
}
struct Repository {
    root: PathBuf,
    prefix: String,
}
struct GitOutput {
    code: Option<i32>,
    stdout: Vec<u8>,
    stderr: Vec<u8>,
}

impl GitProject {
    pub fn open(root: impl AsRef<Path>, excluded: Vec<PathBuf>) -> Result<Self, String> {
        let root = root.as_ref().canonicalize().map_err(display)?;
        if !root.is_dir() {
            return Err("project root must be an existing directory".into());
        }
        let identity = root
            .to_str()
            .ok_or("project root must be UTF-8")?
            .to_string();
        let mut normalized_exclusions = Vec::new();
        for excluded in excluded {
            // Preserve the lexical exclusion as well as its canonical spelling. macOS
            // temporary paths commonly enter as /var while the project root is /private/var.
            let absolute = if excluded.is_absolute() {
                excluded
            } else {
                root.join(excluded)
            };
            let mut ancestor = absolute.as_path();
            let mut suffix = Vec::new();
            while !ancestor.exists() {
                let Some(name) = ancestor.file_name() else {
                    break;
                };
                suffix.push(name.to_os_string());
                let Some(parent) = ancestor.parent() else {
                    break;
                };
                ancestor = parent;
            }
            let mut canonical = ancestor.canonicalize().map_err(display)?;
            for component in suffix.into_iter().rev() {
                canonical.push(component);
            }
            normalized_exclusions.push(absolute);
            normalized_exclusions.push(canonical);
        }
        Ok(Self {
            root,
            identity,
            excluded: normalized_exclusions,
        })
    }

    async fn repository(&self) -> Result<Option<Repository>, String> {
        self.check_root()?;
        let output = git(&self.root, &["rev-parse", "--show-toplevel"], None).await?;
        if output.code == Some(128) && text(&output.stderr).contains("not a git repository") {
            return Ok(None);
        }
        success(&output)?;
        let root = PathBuf::from(text(&output.stdout).trim_end_matches(['\r', '\n']))
            .canonicalize()
            .map_err(display)?;
        let relative = self.root.strip_prefix(&root).map_err(display)?;
        let prefix = relative
            .to_str()
            .ok_or("Git prefix is not UTF-8")?
            .replace('\\', "/");
        Ok(Some(Repository {
            root,
            prefix: if prefix.is_empty() {
                prefix
            } else {
                format!("{prefix}/")
            },
        }))
    }

    fn checked_path(&self, path: &str) -> Result<PathBuf, String> {
        self.check_root()?;
        validate_path(path)?;
        let result = self.root.join(path);
        if self
            .excluded
            .iter()
            .any(|excluded| result == *excluded || result.starts_with(excluded))
        {
            return Err("path refers to host-owned application data".into());
        }
        let mut current = self.root.clone();
        let components = path.split('/').collect::<Vec<_>>();
        for (index, component) in components.iter().enumerate() {
            current.push(component);
            match std::fs::symlink_metadata(&current) {
                Ok(metadata)
                    if index + 1 < components.len() && metadata.file_type().is_symlink() =>
                {
                    return Err("project paths must not traverse symbolic links".into());
                }
                Ok(_) => {}
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => return Err(display(error)),
            }
        }
        Ok(result)
    }

    fn check_root(&self) -> Result<(), String> {
        let metadata = std::fs::symlink_metadata(&self.root).map_err(display)?;
        if !metadata.is_dir()
            || metadata.file_type().is_symlink()
            || self.root.canonicalize().map_err(display)? != self.root
        {
            return Err("the selected project root changed or is now a symbolic link".into());
        }
        Ok(())
    }

    async fn file(&self, path: &str) -> Result<FileObservation, String> {
        let resolved = self.checked_path(path)?;
        let metadata = match std::fs::symlink_metadata(&resolved) {
            Ok(value) => value,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                return Ok(FileObservation {
                    path: path.into(),
                    kind: "absent".into(),
                    sha256: None,
                    byte_size: 0,
                    mode: None,
                    modified_at_ns: None,
                });
            }
            Err(error) => return Err(display(error)),
        };
        let mode = file_mode(&metadata);
        if metadata.is_dir() {
            return Ok(FileObservation {
                path: path.into(),
                kind: "directory".into(),
                sha256: None,
                byte_size: 0,
                mode,
                modified_at_ns: modified_ns(&metadata),
            });
        }
        if metadata.file_type().is_symlink() {
            let link = std::fs::read_link(&resolved).map_err(display)?;
            let bytes = link
                .to_str()
                .ok_or("symbolic link target is not UTF-8")?
                .as_bytes();
            return Ok(FileObservation {
                path: path.into(),
                kind: "symlink".into(),
                sha256: Some(hash(bytes)),
                byte_size: bytes.len() as u64,
                mode,
                modified_at_ns: modified_ns(&metadata),
            });
        }
        if !metadata.is_file() || metadata.len() > MAX_FILE_BYTES {
            return Err("file observation requires a regular file of at most 64 MiB".into());
        }
        let mut file = tokio::fs::File::open(&resolved).await.map_err(display)?;
        let mut hasher = Sha256::new();
        let mut buffer = [0; 64 * 1024];
        let mut total = 0;
        loop {
            let count = file.read(&mut buffer).await.map_err(display)?;
            if count == 0 {
                break;
            }
            total += count as u64;
            if total > MAX_FILE_BYTES {
                return Err("file grew beyond the observation byte bound".into());
            }
            hasher.update(&buffer[..count]);
        }
        let after = std::fs::symlink_metadata(&resolved).map_err(display)?;
        if after.len() != total
            || metadata.len() != total
            || metadata.modified().ok() != after.modified().ok()
            || after.file_type().is_symlink()
        {
            return Err("file changed while its content was observed".into());
        }
        Ok(FileObservation {
            path: path.into(),
            kind: "regular".into(),
            sha256: Some(format!("sha256:{:x}", hasher.finalize())),
            byte_size: total,
            mode,
            modified_at_ns: modified_ns(&metadata),
        })
    }

    async fn apply_command(&self, patch: &str, flags: &[&str]) -> Result<GitOutput, String> {
        let repository = self.repository().await?;
        let root = repository
            .as_ref()
            .map_or(self.root.as_path(), |repo| repo.root.as_path());
        let prefix = repository
            .as_ref()
            .map(|repo| repo.prefix.trim_end_matches('/'))
            .unwrap_or("");
        let mut args = vec!["apply"];
        args.extend_from_slice(flags);
        if !prefix.is_empty() {
            args.extend(["--directory", prefix]);
        }
        args.push("-");
        git(root, &args, Some(patch.as_bytes())).await
    }
}

#[async_trait]
impl ProjectRuntime for GitProject {
    async fn storage_status(&self) -> Result<rho_files_api::ProjectStorage, String> {
        self.check_root()?;
        let root = self.root.clone();
        let project = self.identity.clone();
        tokio::task::spawn_blocking(move || {
            let stats = fs4::statvfs(&root).map_err(display)?;
            if stats.total_space() == 0
                || stats.available_space() > stats.total_space()
                || stats.free_space() > stats.total_space()
            {
                return Err("Project disk capacity is unavailable".into());
            }
            Ok(rho_files_api::ProjectStorage {
                project,
                free_bytes: stats.free_space(),
                total_bytes: stats.total_space(),
                available_bytes: stats.available_space(),
                observed_at_ms: now_ms(),
            })
        })
        .await
        .map_err(display)?
    }
    async fn list_directory(
        &self,
        args: &rho_files_api::ListDirectoryArguments,
    ) -> Result<rho_files_api::DirectoryPage, String> {
        self.check_root()?;
        let directory = if args.path.is_empty() {
            self.root.clone()
        } else {
            self.checked_path(&args.path)?
        };
        let metadata = std::fs::symlink_metadata(&directory).map_err(display)?;
        if !metadata.is_dir() || metadata.file_type().is_symlink() {
            return Err("directory must not be a symbolic link".into());
        }
        if !(1..=200).contains(&args.limit) {
            return Err("directory page limit must be 1..=200".into());
        }
        let mut entries = Vec::new();
        let mut truncated = false;
        for entry in std::fs::read_dir(&directory).map_err(display)? {
            let entry = entry.map_err(display)?;
            let Ok(name) = entry.file_name().into_string() else {
                truncated = true;
                continue;
            };
            let path = if args.path.is_empty() {
                name.clone()
            } else {
                format!("{}/{}", args.path, name)
            };
            if self.checked_path(&path).is_err() {
                continue;
            }
            if args.after_name.as_ref().is_some_and(|after| &name <= after) {
                continue;
            }
            let metadata = std::fs::symlink_metadata(entry.path()).map_err(display)?;
            let kind = if metadata.file_type().is_symlink() {
                "symlink"
            } else if metadata.is_dir() {
                "directory"
            } else if metadata.is_file() {
                "regular"
            } else {
                "special"
            };
            let entry = rho_files_api::DirectoryEntry {
                path,
                name,
                kind: kind.into(),
                byte_size: metadata.len(),
            };
            // Keep only the next page and one lookahead; enumeration has no lossy prefix cutoff.
            let index = entries
                .binary_search_by(|candidate: &rho_files_api::DirectoryEntry| {
                    candidate.name.cmp(&entry.name)
                })
                .unwrap_or_else(|index| index);
            if index <= args.limit as usize {
                entries.insert(index, entry);
                entries.truncate(args.limit as usize + 1);
            }
        }
        entries.sort_by(|a, b| a.name.cmp(&b.name));
        let next_name = (entries.len() > args.limit as usize)
            .then(|| entries[args.limit as usize - 1].name.clone());
        entries.truncate(args.limit as usize);
        Ok(rho_files_api::DirectoryPage {
            path: args.path.clone(),
            entries,
            next_name,
            truncated,
            notices: if truncated {
                vec!["Non-UTF-8 directory names cannot be represented by the project path protocol; those entries are unavailable.".into()]
            } else {
                Vec::new()
            },
        })
    }

    async fn read_text(
        &self,
        args: &rho_files_api::ReadTextArguments,
    ) -> Result<rho_files_api::TextPage, rho_files_api::ProjectTextError> {
        self.read_text_page(args).await
    }
    async fn search_text(
        &self,
        args: &rho_files_api::SearchTextArguments,
    ) -> Result<rho_files_api::SearchTextPage, rho_files_api::ProjectTextError> {
        self.search_text_page(args).await
    }
    async fn read_file(&self, args: &ReadFileArguments) -> Result<FilePage, String> {
        self.read_page(args).await
    }
    fn root(&self) -> &str {
        &self.identity
    }

    async fn snapshot(&self, paths: &[String], limit: usize) -> Result<ProjectSnapshot, String> {
        if paths.len() > MAX_PROJECT_PATHS || !(1..=200).contains(&limit) {
            return Err("project snapshot bounds exceeded".into());
        }
        let mut files = Vec::new();
        for path in paths {
            files.push(self.file(path).await?);
        }
        let repository = self.repository().await?;
        let mut entries_truncated = false;
        let raw_entries = if let Some(repository) = &repository {
            let listing = git(
                &self.root,
                &[
                    "ls-files",
                    "-z",
                    "--cached",
                    "--others",
                    "--exclude-standard",
                    "--full-name",
                    "--",
                    ".",
                ],
                None,
            )
            .await?;
            success(&listing)?;
            listing
                .stdout
                .split(|byte| *byte == 0)
                .filter(|entry| !entry.is_empty())
                .map(utf8)
                .collect::<Result<Vec<_>, _>>()?
                .into_iter()
                .filter_map(|path| path.strip_prefix(&repository.prefix).map(str::to_string))
                .collect::<Vec<_>>()
        } else {
            let mut entries = Vec::new();
            for entry in std::fs::read_dir(&self.root).map_err(display)?.take(5001) {
                let entry = entry.map_err(display)?;
                entries.push(
                    entry
                        .file_name()
                        .into_string()
                        .map_err(|_| "directory contains non-UTF-8 names")?,
                );
            }
            entries_truncated = entries.len() > 5000;
            entries
        };
        let total_entries = raw_entries.len();
        let mut entries = raw_entries
            .into_iter()
            .filter(|path| self.checked_path(path).is_ok())
            .collect::<BTreeSet<_>>()
            .into_iter()
            .collect::<Vec<_>>();
        entries_truncated |= entries.len() < total_entries || entries.len() > limit;
        entries.truncate(limit);
        let observation = if let Some(repository) = repository {
            let head = git(
                &self.root,
                &["rev-parse", "--verify", "--quiet", "HEAD"],
                None,
            )
            .await?;
            let head = match head.code {
                Some(0) => Some(text(&head.stdout).trim().to_string()),
                Some(1) => None,
                _ => return Err(diagnostic(&head)),
            };
            let status = git(
                &self.root,
                &[
                    "status",
                    "--porcelain=v1",
                    "-z",
                    "--untracked-files=normal",
                    "--",
                    ".",
                ],
                None,
            )
            .await?;
            success(&status)?;
            let mut changes = parse_status(&status.stdout, &repository.prefix)?;
            let total = changes.len();
            changes.retain(|change| self.checked_path(&change.path).is_ok());
            let truncated = changes.len() < total || changes.len() > limit;
            changes.truncate(limit);
            Some(GitObservation {
                repository_root: repository.root.to_string_lossy().into_owned(),
                head,
                changes,
                truncated,
            })
        } else {
            None
        };
        Ok(ProjectSnapshot {
            root: self.identity.clone(),
            git: observation,
            files,
            entries,
            entries_truncated,
            observed_at_ms: now_ms(),
        })
    }

    async fn patch_paths(&self, patch: &str) -> Result<Vec<String>, String> {
        let output = self.apply_command(patch, &["--numstat", "-z"]).await?;
        success(&output)?;
        // Unlike git diff --numstat, git apply reports only the rename destination.
        // Reverse parsing exposes the source without inventing a diff-header parser.
        let reverse = self
            .apply_command(patch, &["--reverse", "--numstat", "-z"])
            .await?;
        success(&reverse)?;
        let prefix = self
            .repository()
            .await?
            .map_or(String::new(), |repo| repo.prefix);
        let mut paths = parse_numstat(&output.stdout)?;
        paths.extend(parse_numstat(&reverse.stdout)?);
        let mut scoped = BTreeSet::new();
        for path in paths {
            let path = path
                .strip_prefix(&prefix)
                .ok_or("patch path escaped the selected project")?;
            self.checked_path(path)?;
            scoped.insert(path.to_string());
        }
        Ok(scoped.into_iter().collect())
    }

    async fn check_patch(&self, patch: &str) -> Result<(), String> {
        success(&self.apply_command(patch, &["--check"]).await?)
    }
    async fn apply_patch(&self, patch: &str) -> GitApplyReport {
        match self.apply_command(patch, &[]).await {
            Ok(output) => GitApplyReport {
                exit_code: output.code,
                diagnostic: diagnostic(&output),
            },
            Err(error) => GitApplyReport {
                exit_code: None,
                diagnostic: error,
            },
        }
    }
}

async fn git(root: &Path, args: &[&str], input: Option<&[u8]>) -> Result<GitOutput, String> {
    let mut command = tokio::process::Command::new("git");
    command
        .arg("--no-pager")
        .args(["-c", "core.fsmonitor=false", "-c", "core.quotePath=false"])
        .args(args)
        .current_dir(root);
    for (name, _) in std::env::vars_os() {
        if name.to_string_lossy().starts_with("GIT_") {
            command.env_remove(name);
        }
    }
    command
        .env("GIT_OPTIONAL_LOCKS", "0")
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("LC_ALL", "C");
    let report = run_command(
        command,
        ProcessOptions {
            timeout: Duration::from_secs(15),
            output_limit_bytes: MAX_OUTPUT_BYTES as usize,
            stdin: input.map(<[u8]>::to_vec),
        },
        tokio::sync::watch::channel(false).1,
    )
    .await
    .map_err(display)?;
    if report.termination != ProcessTermination::Exited {
        return Err(format!(
            "Git process {:?}; inspect current project state before retrying: {:?}",
            report.termination, report.cleanup_error
        ));
    }
    if report.stdout.truncated || report.stderr.truncated {
        return Err("Git output exceeded the 4 MiB bound".into());
    }
    if report.exit_code == Some(0)
        && let Some(error) = report.stdin_error
    {
        return Err(error);
    }
    Ok(GitOutput {
        code: report.exit_code,
        stdout: report.stdout.bytes,
        stderr: report.stderr.bytes,
    })
}
impl GitProject {
    async fn read_page(&self, args: &ReadFileArguments) -> Result<FilePage, String> {
        let observed = self.file(&args.path).await?;
        if observed.kind != "regular" {
            return Err(
                "file byte reads require a regular file; symbolic links are not followed".into(),
            );
        }
        if args
            .expected_sha256
            .as_ref()
            .is_some_and(|expected| Some(expected) != observed.sha256.as_ref())
        {
            return Err("file content no longer matches expected_sha256".into());
        }
        if args.offset > observed.byte_size || args.limit_bytes == 0 || args.limit_bytes > 65536 {
            return Err("file byte range is out of bounds".into());
        }
        let path = self.checked_path(&args.path)?;
        let before = std::fs::symlink_metadata(&path).map_err(display)?;
        if !before.is_file()
            || before.len() != observed.byte_size
            || modified_ns(&before) != observed.modified_at_ns
        {
            return Err("file changed before byte read".into());
        }
        let mut input = tokio::fs::File::open(&path).await.map_err(display)?;
        input
            .seek(std::io::SeekFrom::Start(args.offset))
            .await
            .map_err(display)?;
        let mut bytes = Vec::new();
        input
            .take(u64::from(args.limit_bytes))
            .read_to_end(&mut bytes)
            .await
            .map_err(display)?;
        let after = std::fs::symlink_metadata(&path).map_err(display)?;
        if !after.is_file()
            || before.len() != after.len()
            || before.modified().ok() != after.modified().ok()
        {
            return Err("file changed while reading byte range".into());
        }
        Ok(FilePage {
            offset: args.offset,
            has_more: args.offset + (bytes.len() as u64) < observed.byte_size,
            file: observed,
            bytes,
        })
    }
}

fn success(output: &GitOutput) -> Result<(), String> {
    if output.code == Some(0) {
        Ok(())
    } else {
        Err(diagnostic(output))
    }
}
fn diagnostic(output: &GitOutput) -> String {
    let diagnostic = text(&output.stderr).chars().take(8192).collect::<String>();
    if diagnostic.is_empty() && output.code != Some(0) {
        format!("Git exited with code {:?}", output.code)
    } else {
        diagnostic
    }
}
fn text(bytes: &[u8]) -> String {
    String::from_utf8_lossy(bytes).into_owned()
}
fn display(error: impl std::fmt::Display) -> String {
    error.to_string()
}
fn hash(bytes: &[u8]) -> String {
    format!("sha256:{:x}", Sha256::digest(bytes))
}
fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}
fn modified_ns(metadata: &std::fs::Metadata) -> Option<String> {
    Some(
        metadata
            .modified()
            .ok()?
            .duration_since(UNIX_EPOCH)
            .ok()?
            .as_nanos()
            .to_string(),
    )
}
#[cfg(unix)]
fn file_mode(metadata: &std::fs::Metadata) -> Option<u32> {
    use std::os::unix::fs::PermissionsExt;
    Some(metadata.permissions().mode() & 0o777)
}
#[cfg(not(unix))]
fn file_mode(metadata: &std::fs::Metadata) -> Option<u32> {
    Some(u32::from(metadata.permissions().readonly()))
}

fn parse_numstat(bytes: &[u8]) -> Result<Vec<String>, String> {
    let mut records = bytes.split(|byte| *byte == 0);
    let mut paths = Vec::new();
    while let Some(record) = records.next() {
        if record.is_empty() {
            continue;
        }
        let mut fields = record.splitn(3, |byte| *byte == b'\t');
        fields.next().ok_or("invalid Git numstat")?;
        fields.next().ok_or("invalid Git numstat")?;
        let path = fields.next().ok_or("invalid Git numstat path")?;
        if path.is_empty() {
            paths.push(utf8(records.next().ok_or("missing rename source")?)?);
            paths.push(utf8(records.next().ok_or("missing rename destination")?)?);
        } else {
            paths.push(utf8(path)?);
        }
    }
    Ok(paths)
}
fn parse_status(bytes: &[u8], prefix: &str) -> Result<Vec<GitStatusEntry>, String> {
    let mut records = bytes.split(|byte| *byte == 0);
    let mut changes = Vec::new();
    while let Some(record) = records.next() {
        if record.is_empty() {
            continue;
        }
        if record.len() < 4 || record[2] != b' ' {
            return Err("invalid Git status record".into());
        }
        let path = utf8(&record[3..])?;
        let original = if record[..2]
            .iter()
            .any(|status| matches!(status, b'R' | b'C'))
        {
            Some(utf8(records.next().ok_or("missing rename source")?)?)
        } else {
            None
        };
        let Some(path) = path.strip_prefix(prefix) else {
            continue;
        };
        let path = path.trim_end_matches('/').to_string();
        changes.push(GitStatusEntry {
            path,
            original_path: original.and_then(|path| path.strip_prefix(prefix).map(str::to_string)),
            index_status: char::from(record[0]).to_string(),
            worktree_status: char::from(record[1]).to_string(),
        });
    }
    Ok(changes)
}
fn utf8(bytes: &[u8]) -> Result<String, String> {
    String::from_utf8(bytes.to_vec()).map_err(|_| "Git returned a non-UTF-8 path".into())
}
