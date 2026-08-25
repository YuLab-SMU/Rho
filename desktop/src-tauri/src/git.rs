use anyhow::{Context, Result, bail};
use serde::{Deserialize, Serialize};
use std::ffi::{OsStr, OsString};
use std::io::Read;
use std::path::Path;
use std::process::{Command, Stdio};
use std::sync::{OnceLock, RwLock};

const MAX_GIT_STDOUT_BYTES: usize = 8 * 1024 * 1024;
const MAX_GIT_STDERR_BYTES: usize = 64 * 1024;

static PROCESS_PATH: OnceLock<RwLock<Option<OsString>>> = OnceLock::new();

pub fn set_process_path(path: OsString) {
    let mut configured = PROCESS_PATH
        .get_or_init(|| RwLock::new(None))
        .write()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    *configured = Some(path);
}

fn configured_process_path() -> Option<OsString> {
    PROCESS_PATH.get().and_then(|path| {
        path.read()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone()
    })
}

pub struct GitCommandOutput {
    pub stdout: Vec<u8>,
    pub stdout_truncated: bool,
}

fn read_bounded(mut stream: impl Read, limit: usize) -> std::io::Result<(Vec<u8>, bool)> {
    let mut captured = Vec::with_capacity(limit.min(64 * 1024));
    let mut buffer = [0u8; 16 * 1024];
    let mut truncated = false;
    loop {
        let read = stream.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        let remaining = limit.saturating_sub(captured.len());
        let keep = remaining.min(read);
        captured.extend_from_slice(&buffer[..keep]);
        truncated |= keep < read;
    }
    Ok((captured, truncated))
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct GitStatus {
    pub is_repo: bool,
    pub branch: Option<String>,
    pub dirty: bool,
    pub ahead: i32,
    pub behind: i32,
    #[specta(type = i32)]
    pub untracked: usize,
    #[specta(type = i32)]
    pub modified: usize,
    #[specta(type = i32)]
    pub staged: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct GitLogEntry {
    pub hash: String,
    pub author: String,
    pub date: String,
    pub message: String,
}

pub fn decode_stdout(stdout: Vec<u8>) -> Result<String> {
    String::from_utf8(stdout).context("git returned non-UTF-8 stdout")
}

pub fn run_git(project_root: &Path, args: &[&str]) -> Result<String> {
    let output = run_git_bounded(project_root, args, MAX_GIT_STDOUT_BYTES)?;
    if output.stdout_truncated {
        bail!(
            "git output exceeded the {} byte limit",
            MAX_GIT_STDOUT_BYTES
        );
    }
    decode_stdout(output.stdout)
}

pub fn run_git_bounded(
    project_root: &Path,
    args: &[&str],
    stdout_limit: usize,
) -> Result<GitCommandOutput> {
    let mut child = git_command(project_root, args)
        .spawn()
        .context("failed to run git")?;
    let stdout = child
        .stdout
        .take()
        .context("failed to capture git stdout")?;
    let stderr = child
        .stderr
        .take()
        .context("failed to capture git stderr")?;
    let stdout_reader = std::thread::spawn(move || read_bounded(stdout, stdout_limit));
    let stderr_reader = std::thread::spawn(move || read_bounded(stderr, MAX_GIT_STDERR_BYTES));
    let status = child.wait().context("failed to wait for git")?;
    let (stdout, stdout_truncated) = stdout_reader
        .join()
        .map_err(|_| anyhow::anyhow!("git stdout reader failed"))?
        .context("failed to read git stdout")?;
    let (stderr, stderr_truncated) = stderr_reader
        .join()
        .map_err(|_| anyhow::anyhow!("git stderr reader failed"))?
        .context("failed to read git stderr")?;
    if !status.success() {
        let mut diagnostic = String::from_utf8_lossy(&stderr).trim().to_string();
        if stderr_truncated {
            diagnostic.push_str(" [truncated]");
        }
        bail!("git error: {diagnostic}");
    }
    Ok(GitCommandOutput {
        stdout,
        stdout_truncated,
    })
}

fn git_command(project_root: &Path, args: &[&str]) -> Command {
    let process_path = configured_process_path();
    git_command_with_path(project_root, args, process_path.as_deref())
}

fn git_command_with_path(
    project_root: &Path,
    args: &[&str],
    process_path: Option<&OsStr>,
) -> Command {
    let mut command = Command::new("git");
    hide_console_window(&mut command);
    command
        .args(args)
        .current_dir(project_root)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if let Some(process_path) = process_path {
        command.env("PATH", process_path);
    }
    command
}

fn hide_console_window(_command: &mut Command) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        _command.creation_flags(0x0800_0000);
    }
}

pub fn git_status(project_root: &Path) -> Result<GitStatus> {
    // Check if it's a git repo
    let is_repo = run_git(project_root, &["rev-parse", "--git-dir"]).is_ok();
    if !is_repo {
        return Ok(GitStatus {
            is_repo: false,
            branch: None,
            dirty: false,
            ahead: 0,
            behind: 0,
            untracked: 0,
            modified: 0,
            staged: 0,
        });
    }
    // Branch name
    let branch = run_git(project_root, &["rev-parse", "--abbrev-ref", "HEAD"])
        .ok()
        .map(|s| s.trim().to_string());
    // Dirty check
    let dirty = !run_git(project_root, &["diff", "--stat"])
        .unwrap_or_default()
        .trim()
        .is_empty()
        || !run_git(project_root, &["diff", "--cached", "--stat"])
            .unwrap_or_default()
            .trim()
            .is_empty();
    // Ahead/behind
    let (ahead, behind) = if branch.as_deref() != Some("HEAD") {
        let ahead_str =
            run_git(project_root, &["rev-list", "--count", "@{u}..HEAD"]).unwrap_or_default();
        let behind_str =
            run_git(project_root, &["rev-list", "--count", "HEAD..@{u}"]).unwrap_or_default();
        (
            ahead_str.trim().parse().unwrap_or(0),
            behind_str.trim().parse().unwrap_or(0),
        )
    } else {
        (0, 0)
    };
    // File counts
    let status_output = run_git(project_root, &["status", "--porcelain"]).unwrap_or_default();
    let mut untracked = 0usize;
    let mut modified = 0usize;
    let mut staged = 0usize;
    for line in status_output.lines() {
        if line.len() < 2 {
            continue;
        }
        let idx = &line[0..2];
        if idx.starts_with("??") {
            untracked += 1;
        } else {
            if idx.contains('M')
                || idx.contains('A')
                || idx.contains('D')
                || idx.contains('R')
                || idx.contains('C')
                || idx.contains('U')
                || idx.contains('T')
            {
                if idx.chars().next().map_or(false, |c| c != ' ' && c != '?') {
                    staged += 1;
                }
                if idx.chars().nth(1).map_or(false, |c| c != ' ') {
                    modified += 1;
                }
            }
        }
    }
    Ok(GitStatus {
        is_repo: true,
        branch,
        dirty,
        ahead,
        behind,
        untracked,
        modified,
        staged,
    })
}

pub fn git_log(project_root: &Path, limit: usize) -> Result<Vec<GitLogEntry>> {
    let output = run_git(
        project_root,
        &[
            "log",
            "--oneline",
            &format!("-{}", limit.min(50)),
            "--format=%H|%an|%ai|%s",
        ],
    )?;
    let entries: Vec<GitLogEntry> = output
        .lines()
        .filter_map(|line| {
            let parts: Vec<&str> = line.splitn(4, '|').collect();
            if parts.len() < 4 {
                return None;
            }
            Some(GitLogEntry {
                hash: parts[0][..8.min(parts[0].len())].to_string(),
                author: parts[1].to_string(),
                date: parts[2][..10].to_string(),
                message: parts[3].to_string(),
            })
        })
        .collect();
    Ok(entries)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    #[test]
    fn bounded_reader_caps_captured_bytes_while_draining_input() {
        let input = vec![b'x'; 4096];
        let (captured, truncated) = read_bounded(Cursor::new(input), 128).unwrap();
        assert_eq!(captured.len(), 128);
        assert!(truncated);
    }

    #[test]
    fn successful_git_metadata_rejects_invalid_utf8() {
        let error = decode_stdout(vec![b'f', 0x80, b'o']).unwrap_err();
        assert!(error.to_string().contains("non-UTF-8 stdout"));
    }

    #[test]
    fn git_commands_use_the_centralized_bounded_builder() {
        let command = git_command_with_path(
            Path::new("C:/project"),
            &["status", "--porcelain"],
            Some(OsStr::new("/opt/homebrew/bin:/usr/bin")),
        );
        assert_eq!(command.get_program(), "git");
        assert_eq!(
            command.get_args().collect::<Vec<_>>(),
            vec!["status", "--porcelain"]
        );
        assert_eq!(command.get_current_dir(), Some(Path::new("C:/project")));
        assert_eq!(
            command
                .get_envs()
                .find(|(name, _)| *name == "PATH")
                .and_then(|(_, value)| value),
            Some(OsStr::new("/opt/homebrew/bin:/usr/bin"))
        );
    }
}
