//! Rho-managed official DeepSeek ACP component and private native launch home.
//! Discovery never installs software or changes the user's DSH configuration.
use serde_json::{Value, json};
use std::{
    ffi::OsString,
    fs::{self, OpenOptions},
    io::{Read, Write},
    path::{Path, PathBuf},
    process::Stdio,
    time::Duration,
};
use tokio::{io::AsyncReadExt, process::Command};

pub(crate) const VERSION: &str = "0.1.2-alpha.2";
const MARKER: &str = "rho-component.json";
const CONFIG_LIMIT: u64 = 1024 * 1024;
static INSTALL_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

pub(crate) struct DeepseekLaunch {
    pub program: PathBuf,
    pub args: Vec<OsString>,
    pub env: (OsString, OsString),
    pub owned_home: PathBuf,
}

fn user_home() -> Option<PathBuf> {
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
        .filter(|p| p.is_absolute())
}

fn components_root() -> Result<PathBuf, String> {
    let root = if let Some(root) = std::env::var_os("RHO_AGENT_COMPONENTS_DIR") {
        PathBuf::from(root)
    } else {
        let data = if cfg!(windows) {
            std::env::var_os("LOCALAPPDATA").map(PathBuf::from)
        } else if cfg!(target_os = "macos") {
            user_home().map(|home| home.join("Library/Application Support"))
        } else {
            std::env::var_os("XDG_DATA_HOME")
                .map(PathBuf::from)
                .or_else(|| user_home().map(|home| home.join(".local/share")))
        };
        data.ok_or("The local application-data directory is unavailable")?
            .join("rho/agent-components")
    };
    if !root.is_absolute() {
        return Err("The Agent component directory must be an absolute path".into());
    }
    Ok(root)
}

fn component_path() -> Result<PathBuf, String> {
    Ok(components_root()?.join(format!("deepseek-{VERSION}")))
}

fn search_dirs() -> Vec<PathBuf> {
    let mut dirs: Vec<_> = std::env::var_os("PATH")
        .map(|path| {
            std::env::split_paths(&path)
                .filter(|dir| dir.is_absolute())
                .take(128)
                .collect()
        })
        .unwrap_or_default();
    if let Some(home) = user_home() {
        dirs.extend([home.join(".local/bin"), home.join(".npm-global/bin")]);
    }
    if cfg!(target_os = "macos") {
        dirs.extend([
            PathBuf::from("/opt/homebrew/bin"),
            PathBuf::from("/usr/local/bin"),
        ]);
    }
    dirs
}

fn node() -> Result<PathBuf, String> {
    let name = if cfg!(windows) { "node.exe" } else { "node" };
    search_dirs()
        .into_iter()
        .map(|dir| dir.join(name))
        .find(|path| path.is_file())
        .ok_or_else(|| {
            "Node.js was not found. Install Node.js before connecting DeepSeek Harness".into()
        })
}

fn npm_script() -> Result<PathBuf, String> {
    for dir in search_dirs() {
        // npm's Windows command wrapper requires a shell. Run its installed JS
        // entry point through Node instead on every platform.
        let candidates = [
            dir.join("node_modules/npm/bin/npm-cli.js"),
            dir.join("../lib/node_modules/npm/bin/npm-cli.js"),
            dir.join("npm"),
        ];
        for candidate in candidates {
            if let Ok(path) = candidate.canonicalize()
                && path.is_file()
                && path.extension().is_some_and(|ext| ext == "js")
            {
                return Ok(path);
            }
        }
    }
    Err("npm was not found. Install Node.js with npm before connecting DeepSeek Harness".into())
}

fn read_json(path: &Path) -> Option<Value> {
    let file = fs::File::open(path).ok()?;
    let mut content = String::new();
    file.take(CONFIG_LIMIT + 1)
        .read_to_string(&mut content)
        .ok()?;
    if content.len() as u64 > CONFIG_LIMIT {
        return None;
    }
    serde_json::from_str(&content).ok()
}

fn package_entry(component: &Path) -> Option<PathBuf> {
    let component = component.canonicalize().ok()?;
    for package in ["dsh", "dsh-acp-app"] {
        let manifest = read_json(
            &component.join(format!("node_modules/@deepseek-ai/{package}/package.json")),
        )?;
        if manifest["name"] != format!("@deepseek-ai/{package}") || manifest["version"] != VERSION {
            return None;
        }
    }
    let package = component.join("node_modules/@deepseek-ai/dsh");
    let manifest = read_json(&package.join("package.json"))?;
    let bin = manifest["bin"]
        .as_str()
        .or_else(|| manifest["bin"]["dsh"].as_str())?;
    let entry = package.join(bin).canonicalize().ok()?;
    (entry.is_file() && entry.starts_with(&component)).then_some(entry)
}

fn installed_at(component: &Path) -> bool {
    let marker = read_json(&component.join(MARKER));
    marker.is_some_and(|marker| {
        marker["schema"] == 1
            && marker["dsh_version"] == VERSION
            && marker["acp_version"] == VERSION
            && package_entry(component).is_some()
    })
}

pub(crate) fn is_installed() -> bool {
    component_path().is_ok_and(|component| installed_at(&component))
}

struct OwnedDirectory(PathBuf);
impl OwnedDirectory {
    fn keep(mut self) -> PathBuf {
        std::mem::take(&mut self.0)
    }
}
impl Drop for OwnedDirectory {
    fn drop(&mut self) {
        // This guard is only constructed after this call created the UUID path.
        if !self.0.as_os_str().is_empty() {
            let _ = fs::remove_dir_all(&self.0);
        }
    }
}

fn private_dir(path: &Path) -> Result<(), String> {
    let mut builder = fs::DirBuilder::new();
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    builder
        .create(path)
        .map_err(|_| "Could not create the private DeepSeek directory".into())
}

async fn drain(mut reader: impl tokio::io::AsyncRead + Unpin) -> Vec<u8> {
    let mut tail = Vec::new();
    let mut chunk = [0; 8192];
    while let Ok(length) = reader.read(&mut chunk).await {
        if length == 0 {
            break;
        }
        tail.extend_from_slice(&chunk[..length]);
        if tail.len() > 16 * 1024 {
            tail.drain(..tail.len() - 16 * 1024);
        }
    }
    tail
}

async fn finish_drain(mut task: tokio::task::JoinHandle<Vec<u8>>) -> Vec<u8> {
    match tokio::time::timeout(Duration::from_secs(2), &mut task).await {
        Ok(Ok(output)) => output,
        _ => {
            task.abort();
            Vec::new()
        }
    }
}

fn restore_native_helper(component: &Path) -> Result<(), String> {
    // The official dsh-subprocess-local postinstall only restores executable
    // permissions on node-pty's shipped helper. Keep this exact, bounded step
    // while npm lifecycle scripts remain disabled.
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let platform = if cfg!(target_os = "macos") {
            "darwin"
        } else {
            std::env::consts::OS
        };
        let architecture = match std::env::consts::ARCH {
            "x86_64" => "x64",
            "aarch64" => "arm64",
            other => other,
        };
        let component = component
            .canonicalize()
            .map_err(|_| "Could not inspect the installed component")?;
        for package in [
            "node_modules/node-pty",
            "node_modules/@deepseek-ai/dsh-subprocess-local/node_modules/node-pty",
        ] {
            for relative in [
                format!("prebuilds/{platform}-{architecture}/spawn-helper"),
                "build/Release/spawn-helper".into(),
            ] {
                let candidate = component.join(package).join(relative);
                if let Ok(path) = candidate.canonicalize() {
                    if !path.starts_with(&component) || !path.is_file() {
                        return Err(
                            "The native DeepSeek helper escaped its component directory".into()
                        );
                    }
                    fs::set_permissions(path, fs::Permissions::from_mode(0o755))
                        .map_err(|_| "Could not prepare the native DeepSeek subprocess helper")?;
                }
            }
        }
    }
    #[cfg(not(unix))]
    let _ = component;
    Ok(())
}

fn npm_failure(output: &[u8]) -> String {
    // Raw npm diagnostics may contain authenticated registry URLs or local
    // credentials. Retain only npm's stable uppercase error code.
    for line in String::from_utf8_lossy(output).lines().rev() {
        if let Some(code) = line
            .strip_prefix("npm error code ")
            .or_else(|| line.strip_prefix("npm ERR! code "))
            && !code.is_empty()
            && code.len() <= 40
            && code
                .bytes()
                .all(|c| c.is_ascii_uppercase() || c.is_ascii_digit() || c == b'_')
        {
            return format!(
                "Official DeepSeek component installation failed ({code}). Check npm connectivity and retry Setup"
            );
        }
    }
    "Official DeepSeek component installation failed. Check npm connectivity and retry Setup".into()
}

pub async fn install() -> Result<(), String> {
    let _install = INSTALL_LOCK.lock().await;
    let target = component_path()?;
    if installed_at(&target) {
        return Ok(());
    }
    let program = node()?;
    let npm = npm_script()?;
    let parent = target.parent().ok_or("Invalid Agent component directory")?;
    fs::create_dir_all(parent).map_err(|_| "Could not create the Agent component directory")?;
    let stage = OwnedDirectory(parent.join(format!(".deepseek-install-{}", uuid::Uuid::new_v4())));
    private_dir(&stage.0)?;
    let mut child = Command::new(program)
        .arg(npm)
        .arg("install")
        .arg("--prefix")
        .arg(&stage.0)
        .args([
            "--ignore-scripts",
            "--no-audit",
            "--no-fund",
            "--package-lock=true",
            "--save-exact",
        ])
        .arg(format!("@deepseek-ai/dsh@{VERSION}"))
        .arg(format!("@deepseek-ai/dsh-acp-app@{VERSION}"))
        .current_dir(&stage.0)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|_| "Could not start npm for DeepSeek component setup")?;
    let stdout = tokio::spawn(drain(
        child.stdout.take().ok_or("npm stdout is unavailable")?,
    ));
    let stderr = tokio::spawn(drain(
        child.stderr.take().ok_or("npm stderr is unavailable")?,
    ));
    let status = tokio::time::timeout(Duration::from_secs(180), child.wait()).await;
    if status.is_err() {
        let _ = child.kill().await;
        stdout.abort();
        stderr.abort();
        return Err("DeepSeek component setup timed out after three minutes; retry Setup when npm is reachable".into());
    }
    let status = status
        .unwrap()
        .map_err(|_| "Could not observe the npm setup result")?;
    let (_, output) = tokio::join!(finish_drain(stdout), finish_drain(stderr));
    if !status.success() {
        return Err(npm_failure(&output));
    }
    if package_entry(&stage.0).is_none() {
        return Err("The installed DeepSeek packages did not match the required official component versions".into());
    }
    restore_native_helper(&stage.0)?;
    fs::write(
        stage.0.join(MARKER),
        json!({"schema":1,"dsh_version":VERSION,"acp_version":VERSION}).to_string(),
    )
    .map_err(|_| "Could not record DeepSeek component readiness")?;
    match fs::rename(&stage.0, &target) {
        Ok(()) => Ok(()),
        Err(_) if installed_at(&target) => Ok(()),
        Err(_) => Err("Could not publish the DeepSeek component. Its destination may contain an incomplete installation".into()),
    }
}

fn copy_private(source: &Path, destination: &Path) -> Result<(), String> {
    let mut input = match fs::File::open(source) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(_) => return Err("Could not read the native DeepSeek settings or credentials".into()),
    };
    let metadata = input
        .metadata()
        .map_err(|_| "Could not inspect native DeepSeek settings")?;
    if !metadata.is_file() || metadata.len() > CONFIG_LIMIT {
        return Err("Native DeepSeek settings must be regular files no larger than 1 MiB".into());
    }
    let mut data = Vec::new();
    (&mut input)
        .take(CONFIG_LIMIT + 1)
        .read_to_end(&mut data)
        .map_err(|_| "Could not read native DeepSeek settings")?;
    if data.len() as u64 > CONFIG_LIMIT {
        return Err("Native DeepSeek settings grew beyond the 1 MiB limit".into());
    }
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut output = options
        .open(destination)
        .map_err(|_| "Could not create private DeepSeek settings")?;
    output
        .write_all(&data)
        .map_err(|_| "Could not copy private DeepSeek settings".into())
}

fn prepare_at(
    component: &Path,
    source: &Path,
    parent: &Path,
    persistent: &Path,
) -> Result<DeepseekLaunch, String> {
    if !installed_at(component) {
        return Err("Set up the official DeepSeek ACP component before connecting".into());
    }
    let program = node()?;
    let entry =
        package_entry(component).ok_or("The DeepSeek component entry point is unavailable")?;
    let owned = OwnedDirectory(parent.join(format!("rho-deepseek-{}", uuid::Uuid::new_v4())));
    private_dir(&owned.0)?;
    for name in ["settings.yaml", ".credentials.yaml"] {
        copy_private(&source.join(name), &owned.0.join(name))?;
    }
    fs::create_dir_all(persistent)
        .map_err(|_| "Could not create persistent DeepSeek native session storage")?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(persistent, fs::Permissions::from_mode(0o700))
            .map_err(|_| "Could not protect persistent DeepSeek native session storage")?;
    }
    let persistent = persistent
        .canonicalize()
        .map_err(|_| "Could not resolve persistent DeepSeek native session storage")?;
    let profile = owned.0.join("profiles/acp");
    fs::create_dir_all(&profile)
        .map_err(|_| "Could not prepare the native DeepSeek ACP profile")?;
    // These are the official ACP profile bundles and native provider overrides.
    // No user's profiles, npm packages, rules, or another product's files enter
    // this private home. Native history outlives its temporary credential copies.
    let manifest = json!({
        "name":"rho-deepseek-acp", "private":true,
        "dsh":{"profile":{
            "bundles":["@deepseek-ai/dsh-base","@deepseek-ai/dsh-acp-app"],
            "patchReload":"startup"
        }}
    });
    let patch = json!([
        {"id":"session-persistence-jsonl","config":{"root":persistent.join("sessions")}},
        {"id":"storage-json","config":{"root":persistent.join("storages")}},
        {"id":"attachment-local","config":{"dshHome":persistent}}
    ]);
    fs::write(profile.join("package.json"), manifest.to_string())
        .and_then(|_| fs::write(profile.join("cordis.patch.yml"), patch.to_string()))
        .map_err(|_| "Could not write the private native DeepSeek ACP profile")?;
    let owned_home = owned.keep();
    let launch = DeepseekLaunch {
        program,
        args: vec![entry.into_os_string(), "--profile".into(), "acp".into()],
        env: ("DSH_HOME".into(), owned_home.clone().into_os_string()),
        owned_home,
    };
    Ok(launch)
}

pub(crate) fn prepare() -> Result<DeepseekLaunch, String> {
    let source = std::env::var_os("DSH_HOME")
        .map(PathBuf::from)
        .or_else(|| user_home().map(|home| home.join(".dsh")))
        .ok_or("The native DeepSeek configuration directory is unavailable")?;
    if !source.is_absolute() {
        return Err("The native DSH_HOME must be an absolute path".into());
    }
    prepare_at(
        &component_path()?,
        &source,
        &std::env::temp_dir(),
        &components_root()?.join(format!("deepseek-{VERSION}-data")),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture(root: &Path) {
        for package in ["dsh", "dsh-acp-app"] {
            let path = root.join(format!("node_modules/@deepseek-ai/{package}"));
            fs::create_dir_all(&path).unwrap();
            fs::write(
                path.join("package.json"),
                json!({
                    "name":format!("@deepseek-ai/{package}"), "version":VERSION,
                    "bin":{"dsh":"bin.js"}
                })
                .to_string(),
            )
            .unwrap();
            fs::write(path.join("bin.js"), "").unwrap();
        }
        fs::write(
            root.join(MARKER),
            json!({"schema":1,"dsh_version":VERSION,"acp_version":VERSION}).to_string(),
        )
        .unwrap();
    }

    #[test]
    fn readiness_requires_both_pinned_packages_and_a_contained_entrypoint() {
        let root = tempfile::tempdir().unwrap();
        assert!(!installed_at(root.path()));
        fixture(root.path());
        assert!(installed_at(root.path()));
        let manifest = root
            .path()
            .join("node_modules/@deepseek-ai/dsh-acp-app/package.json");
        fs::write(
            &manifest,
            json!({"name":"@deepseek-ai/dsh-acp-app","version":"0.1.1"}).to_string(),
        )
        .unwrap();
        assert!(!installed_at(root.path()));
        fixture(root.path());
        fs::write(
            root.path()
                .join("node_modules/@deepseek-ai/dsh/package.json"),
            json!({
                "name":"@deepseek-ai/dsh", "version":VERSION, "bin":"/etc/passwd"
            })
            .to_string(),
        )
        .unwrap();
        assert!(!installed_at(root.path()));
    }

    #[test]
    fn private_copy_does_not_mutate_native_credentials() {
        let root = tempfile::tempdir().unwrap();
        let source = root.path().join("source.yaml");
        let copy = root.path().join("copy.yaml");
        fs::write(&source, "test-key: private\n").unwrap();
        copy_private(&source, &copy).unwrap();
        assert_eq!(fs::read(&copy).unwrap(), fs::read(&source).unwrap());
        fs::write(&copy, "native migration only changes the private copy").unwrap();
        assert_eq!(fs::read_to_string(source).unwrap(), "test-key: private\n");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(copy).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }
    }

    #[test]
    fn installer_diagnostics_never_return_registry_credentials() {
        let error = npm_failure(b"https://user:secret@registry.invalid\nnpm error code E401\n");
        assert!(error.contains("E401"));
        assert!(!error.contains("secret"));
        assert!(!error.contains("registry.invalid"));
        assert!(!npm_failure(b"npm error code SECRET=private\n").contains("private"));
    }
}
