use rho_contract::{RProbe, RSelection};
use std::{
    path::{Path, PathBuf},
    time::Duration,
};
use tokio::{io::AsyncReadExt, process::Command};

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

fn on_path(name: &str) -> Vec<PathBuf> {
    std::env::var_os("PATH")
        .map(|p| {
            std::env::split_paths(&p)
                .map(|p| p.join(name))
                .filter(|p| p.is_file())
                .collect()
        })
        .unwrap_or_default()
}

pub fn discover_r() -> Vec<RSelection> {
    let mut ark = std::env::current_exe()
        .ok()
        .and_then(|p| {
            p.parent()
                .map(|p| p.join(if cfg!(windows) { "ark.exe" } else { "ark" }))
        })
        .filter(|p| p.is_file());
    if ark.is_none() {
        ark = on_path(if cfg!(windows) { "ark.exe" } else { "ark" })
            .into_iter()
            .next();
    }
    let mut paths = on_path(if cfg!(windows) { "R.exe" } else { "R" });
    if cfg!(target_os = "macos") {
        paths.push(PathBuf::from(
            "/Library/Frameworks/R.framework/Resources/bin/R",
        ));
    }
    let mut seen = std::collections::BTreeSet::new();
    paths
        .into_iter()
        .filter_map(|p| p.canonicalize().ok())
        .filter(|p| seen.insert(p.clone()))
        .take(16)
        .map(|p| RSelection {
            executable: p.to_string_lossy().into_owned(),
            ark: ark
                .as_ref()
                .map(|p| p.to_string_lossy().into_owned())
                .unwrap_or_default(),
        })
        .collect()
}

/// Executes only the explicitly named candidate. Failure never selects a different R.
pub async fn probe_r(selection: &RSelection) -> RProbe {
    let mut result = RProbe {
        selection: selection.clone(),
        r_home: None,
        version: None,
        architecture: None,
        jsonlite: false,
        rlang: false,
        ark_available: false,
        usable: false,
        diagnostics: Vec::new(),
    };
    let r = match checked_executable(&selection.executable) {
        Ok(path) => path,
        Err(error) => {
            result.diagnostics.push(format!("R: {error}"));
            return result;
        }
    };
    result.selection.executable = r.to_string_lossy().into_owned();
    let code = "cat('RHO_PROBE\\n', R.home(), '\\n', as.character(getRversion()), '\\n', R.version$arch, '\\n', requireNamespace('jsonlite', quietly=TRUE), '\\n', requireNamespace('rlang', quietly=TRUE), '\\n', sep='')";
    match bounded_command(&r, &["--vanilla", "--slave", "-e", code]).await {
        Ok(output) => {
            let lines: Vec<_> = output.lines().collect();
            if let Some(index) = lines.iter().position(|l| *l == "RHO_PROBE")
                && lines.len() >= index + 6
            {
                result.r_home = Some(lines[index + 1].into());
                result.version = Some(lines[index + 2].into());
                result.architecture = Some(lines[index + 3].into());
                result.jsonlite = lines[index + 4] == "TRUE";
                result.rlang = lines[index + 5] == "TRUE";
            } else {
                result
                    .diagnostics
                    .push("R did not return complete installation metadata".into());
            }
        }
        Err(error) => result.diagnostics.push(format!("R probe failed: {error}")),
    }
    match checked_executable(&selection.ark) {
        Ok(path) => match bounded_command(&path, &["--version"]).await {
            Ok(version) if version.to_lowercase().contains("ark") => {
                result.ark_available = true;
                result.selection.ark = path.to_string_lossy().into_owned();
            }
            Ok(_) => result.diagnostics.push("Selected program did not identify itself as Ark".into()),
            Err(error) => result.diagnostics.push(format!("Ark probe failed: {error}")),
        },
        Err(error) => result.diagnostics.push(format!("Ark: {error}. Select an existing Ark executable; see https://github.com/posit-dev/ark/releases")),
    }
    if !result.jsonlite {
        result.diagnostics.push("jsonlite is missing in this R. Install it explicitly in R with install.packages('jsonlite').".into());
    }
    if !result.rlang {
        result.diagnostics.push("rlang is missing; object values will remain uninspected. Install it explicitly with install.packages('rlang') to enable safe previews.".into());
    }
    result.usable = result.r_home.is_some()
        && result.version.is_some()
        && result.jsonlite
        && result.ark_available;
    result
}

fn checked_executable(path: &str) -> Result<PathBuf, String> {
    if path.len() > 4096 || !Path::new(path).is_absolute() {
        return Err("select an absolute executable path".into());
    }
    let path = Path::new(path).canonicalize().map_err(|e| e.to_string())?;
    if !path.is_file() {
        return Err("path is not a regular file".into());
    }
    Ok(path)
}

pub(crate) async fn bounded_command(program: &Path, args: &[&str]) -> Result<String, String> {
    let mut command = Command::new(program);
    command
        .args(args)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .kill_on_drop(true);
    // Runtime probes do not need provider credentials or user startup scripts.
    for (name, _) in std::env::vars_os() {
        let upper = name.to_string_lossy().to_ascii_uppercase();
        if upper.contains("TOKEN")
            || upper.contains("SECRET")
            || upper.contains("PASSWORD")
            || upper.ends_with("KEY")
        {
            command.env_remove(name);
        }
    }
    let mut child = command.spawn().map_err(|e| e.to_string())?;
    let mut stdout = child
        .stdout
        .take()
        .ok_or("probe stdout unavailable")?
        .take(65537);
    let mut output = Vec::new();
    let result = tokio::time::timeout(Duration::from_secs(10), async {
        stdout
            .read_to_end(&mut output)
            .await
            .map_err(|e| e.to_string())?;
        if output.len() > 65536 {
            return Err("probe exceeded 64 KiB".into());
        }
        if !child.wait().await.map_err(|e| e.to_string())?.success() {
            return Err("program exited unsuccessfully".into());
        }
        String::from_utf8(output).map_err(|e| e.to_string())
    })
    .await;
    result.map_err(|_| "probe timed out".to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn invalid_explicit_r_is_not_replaced() {
        let probe = probe_r(&RSelection {
            executable: "/missing/rho-test-R".into(),
            ark: "/missing/ark".into(),
        })
        .await;
        assert!(!probe.usable);
        assert_eq!(probe.selection.executable, "/missing/rho-test-R");
        assert!(probe.r_home.is_none());
    }
}
