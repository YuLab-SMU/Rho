use anyhow::{Context, Result, ensure};
use base64::{Engine as _, engine::general_purpose::STANDARD};
use minisign_verify::{PublicKey, Signature};
use reqwest::{
    Url,
    header::ACCEPT,
    redirect::{Action, Attempt, Policy},
};
use semver::Version;
use serde::Serialize;
use std::time::Duration;

pub const WEBSITE_URL: &str = "https://yulab-smu.top/Rho/";
pub const SOURCE_URL: &str = "https://github.com/YuLab-SMU/Rho";
pub const NATIVE_UPDATE_STABLE_ENDPOINT: &str =
    "https://yulab-smu.top/Rho/updates/tauri/stable.json";
pub const NATIVE_UPDATE_DEVELOPMENT_ENDPOINT: &str =
    "https://yulab-smu.top/Rho/updates/tauri/development.json";

const MAX_NATIVE_UPDATE_NOTES_CHARS: usize = 500;
const MAX_NATIVE_UPDATE_SIGNATURE_BYTES: usize = 16 * 1024;
const MAX_NATIVE_UPDATE_ARTIFACT_BYTES: usize = 1024 * 1024 * 1024;
const NATIVE_UPDATE_DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(10 * 60);
const DEFAULT_NATIVE_UPDATE_NOTES: &str = "A signed Rho update is available.";
const TAURI_CONFIG: &str = include_str!("../tauri.conf.json");

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ReleaseChannel {
    Stable,
    Development,
}

impl ReleaseChannel {
    pub fn for_version(version: &Version) -> Self {
        if version.pre.is_empty() {
            Self::Stable
        } else {
            Self::Development
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Stable => "stable",
            Self::Development => "development",
        }
    }
}

pub fn native_manifest_url(channel: ReleaseChannel) -> &'static str {
    match channel {
        ReleaseChannel::Stable => NATIVE_UPDATE_STABLE_ENDPOINT,
        ReleaseChannel::Development => NATIVE_UPDATE_DEVELOPMENT_ENDPOINT,
    }
}

pub fn native_updater_supported() -> bool {
    native_updater_supported_for(std::env::consts::OS, std::env::consts::ARCH)
}

fn native_updater_supported_for(os: &str, arch: &str) -> bool {
    matches!(
        (os, arch),
        ("windows", "x86_64") | ("macos", "aarch64") | ("linux", "x86_64")
    )
}

fn native_update_asset_url_is_allowed(url: &Url) -> bool {
    url.scheme() == "https"
        && url.host_str() == Some("github.com")
        && url.username().is_empty()
        && url.password().is_none()
        && url.query().is_none()
        && url.fragment().is_none()
        && url.path().starts_with("/YuLab-SMU/Rho/releases/download/")
}

fn native_update_redirect(attempt: Attempt<'_>) -> Action {
    let allowed_host = matches!(
        attempt.url().host_str(),
        Some(
            "github.com"
                | "objects.githubusercontent.com"
                | "github-releases.githubusercontent.com"
                | "release-assets.githubusercontent.com"
        )
    );
    if attempt.url().scheme() != "https" || !allowed_host {
        return attempt.error("native updater download redirect left the trusted release hosts");
    }
    if attempt.previous().len() >= 5 {
        return attempt.error("native updater download redirected too many times");
    }
    attempt.follow()
}

fn canonical_base64_text(value: &str, label: &str, maximum: usize) -> Result<String> {
    ensure!(
        !value.is_empty() && value.len() <= maximum && !value.chars().any(char::is_whitespace),
        "UPDATE_INVALID: {label} is not bounded base64 text"
    );
    let decoded = STANDARD
        .decode(value)
        .with_context(|| format!("UPDATE_INVALID: {label} is not base64"))?;
    ensure!(
        STANDARD.encode(&decoded) == value,
        "UPDATE_INVALID: {label} is not canonical base64"
    );
    String::from_utf8(decoded).context(format!("UPDATE_INVALID: {label} is not UTF-8"))
}

fn exact_minisign_text(value: &str, expected_lines: usize, label: &str) -> Result<()> {
    ensure!(
        value.lines().count() == expected_lines
            && value
                .chars()
                .all(|character| !character.is_control() || matches!(character, '\n' | '\t')),
        "UPDATE_INVALID: {label} has an invalid textual shape"
    );
    Ok(())
}

fn configured_native_update_public_key() -> Result<PublicKey> {
    let config: serde_json::Value = serde_json::from_str(TAURI_CONFIG)
        .context("UPDATE_INVALID: bundled Tauri config is invalid")?;
    let encoded = config
        .pointer("/plugins/updater/pubkey")
        .and_then(serde_json::Value::as_str)
        .context("UPDATE_INVALID: bundled updater public key is missing")?;
    let decoded = canonical_base64_text(encoded, "bundled updater public key", 4096)?;
    exact_minisign_text(&decoded, 2, "bundled updater public key")?;
    PublicKey::decode(&decoded).context("UPDATE_INVALID: bundled updater public key is invalid")
}

fn parsed_native_update_signature(encoded_signature: &str) -> Result<Signature> {
    let decoded = canonical_base64_text(
        encoded_signature,
        "native updater signature",
        MAX_NATIVE_UPDATE_SIGNATURE_BYTES,
    )?;
    exact_minisign_text(&decoded, 4, "native updater signature")?;
    Signature::decode(&decoded).context("UPDATE_INVALID: native updater signature is invalid")
}

pub fn validate_native_update_candidate_metadata(
    version: &str,
    download_url: &Url,
    encoded_signature: &str,
) -> Result<()> {
    ensure!(
        version.len() <= 128 && Version::parse(version).is_ok(),
        "UPDATE_INVALID: native update version is not bounded SemVer"
    );
    ensure!(
        native_update_asset_url_is_allowed(download_url),
        "UPDATE_INVALID: native updater artifact URL is not allowlisted"
    );
    let _ = parsed_native_update_signature(encoded_signature)?;
    Ok(())
}

fn verify_native_update_signature(
    artifact: &[u8],
    encoded_signature: &str,
    public_key: &PublicKey,
) -> Result<()> {
    let signature = parsed_native_update_signature(encoded_signature)?;
    public_key
        .verify(artifact, &signature, true)
        .context("UPDATE_INVALID: native updater signature does not match the bundled public key")
}

fn native_update_next_length(current_length: usize, incoming_length: usize) -> Result<usize> {
    let next_length = current_length
        .checked_add(incoming_length)
        .context("UPDATE_DOWNLOAD: native updater artifact length overflow")?;
    ensure!(
        next_length <= MAX_NATIVE_UPDATE_ARTIFACT_BYTES,
        "UPDATE_DOWNLOAD: native updater artifact exceeds the byte budget"
    );
    Ok(next_length)
}

fn append_bounded_update_chunk(destination: &mut Vec<u8>, chunk: &[u8]) -> Result<()> {
    native_update_next_length(destination.len(), chunk.len())?;
    destination.extend_from_slice(chunk);
    Ok(())
}

pub async fn download_and_verify_native_update(
    update: &tauri_plugin_updater::Update,
) -> Result<Vec<u8>> {
    validate_native_update_candidate_metadata(
        &update.version,
        &update.download_url,
        &update.signature,
    )?;
    let client = reqwest::Client::builder()
        .timeout(NATIVE_UPDATE_DOWNLOAD_TIMEOUT)
        .redirect(Policy::custom(native_update_redirect))
        .build()
        .context("UPDATE_DOWNLOAD: could not create the native update client")?;
    let mut response = client
        .get(update.download_url.clone())
        .header(ACCEPT, "application/octet-stream")
        .send()
        .await
        .context("UPDATE_DOWNLOAD: could not download the native update")?;
    ensure!(
        response.status().is_success(),
        "UPDATE_DOWNLOAD: native update download returned HTTP {}",
        response.status()
    );
    if let Some(content_length) = response.content_length() {
        ensure!(
            content_length <= MAX_NATIVE_UPDATE_ARTIFACT_BYTES as u64,
            "UPDATE_DOWNLOAD: native updater artifact exceeds the byte budget"
        );
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .context("UPDATE_DOWNLOAD: could not read the native update")?
    {
        append_bounded_update_chunk(&mut bytes, &chunk)?;
    }
    let public_key = configured_native_update_public_key()?;
    verify_native_update_signature(&bytes, &update.signature, &public_key)?;
    Ok(bytes)
}

#[cfg(windows)]
fn install_windows_native_update(bytes: &[u8]) -> Result<()> {
    use std::{io::Write, process::Command};

    ensure!(
        bytes.starts_with(b"MZ"),
        "UPDATE_INSTALL: verified native updater artifact is not an executable"
    );
    let mut installer = tempfile::Builder::new()
        .prefix("rho-native-updater-")
        .suffix(".exe")
        .tempfile()
        .context("UPDATE_INSTALL: could not stage the Windows updater")?;
    installer
        .write_all(bytes)
        .context("UPDATE_INSTALL: could not write the Windows updater")?;
    installer
        .as_file()
        .sync_all()
        .context("UPDATE_INSTALL: could not synchronize the Windows updater")?;
    let (_, installer_path) = installer
        .keep()
        .context("UPDATE_INSTALL: could not preserve the Windows updater handoff")?;
    Command::new(&installer_path)
        .arg("/UPDATE")
        .spawn()
        .context("UPDATE_INSTALL: could not start the Windows updater")?;
    std::process::exit(0);
}

#[cfg(target_os = "macos")]
const MAX_MACOS_ARCHIVE_ENTRIES: usize = 100_000;
#[cfg(target_os = "macos")]
const MAX_MACOS_EXPANDED_BYTES: u64 = 4 * 1024 * 1024 * 1024;

#[cfg(target_os = "macos")]
fn ensure_regular_macos_app_directory(path: &std::path::Path, label: &str) -> Result<()> {
    let metadata = std::fs::symlink_metadata(path)
        .with_context(|| format!("UPDATE_INSTALL: {label} is unavailable"))?;
    ensure!(
        metadata.is_dir() && !metadata.file_type().is_symlink(),
        "UPDATE_INSTALL: {label} must be a non-symlink directory"
    );
    Ok(())
}

#[cfg(target_os = "macos")]
fn macos_app_bundle_path(executable: &std::path::Path) -> Result<std::path::PathBuf> {
    let macos_directory = executable
        .parent()
        .context("UPDATE_INSTALL: current executable has no parent directory")?;
    let contents_directory = macos_directory
        .parent()
        .context("UPDATE_INSTALL: current executable has no Contents directory")?;
    let bundle = contents_directory
        .parent()
        .context("UPDATE_INSTALL: current executable has no app bundle")?;
    ensure!(
        macos_directory.file_name().and_then(|value| value.to_str()) == Some("MacOS")
            && contents_directory
                .file_name()
                .and_then(|value| value.to_str())
                == Some("Contents")
            && bundle.extension().and_then(|value| value.to_str()) == Some("app"),
        "UPDATE_INSTALL: current executable is not in a macOS app bundle"
    );
    ensure_regular_macos_app_directory(bundle, "current app bundle")?;
    Ok(bundle.to_path_buf())
}

#[cfg(target_os = "macos")]
fn validate_macos_archive_path(path: &std::path::Path) -> Result<()> {
    let mut components = path.components();
    ensure!(
        matches!(components.next(), Some(std::path::Component::Normal(name)) if name == "Rho.app"),
        "UPDATE_INSTALL: macOS updater archive must have Rho.app at its root"
    );
    ensure!(
        components.all(|component| matches!(component, std::path::Component::Normal(_))),
        "UPDATE_INSTALL: macOS updater archive contains an unsafe path"
    );
    Ok(())
}

#[cfg(target_os = "macos")]
fn extract_macos_native_update_archive(
    bytes: &[u8],
    destination: &std::path::Path,
) -> Result<std::path::PathBuf> {
    use std::io::Cursor;

    ensure_regular_macos_app_directory(destination, "macOS updater staging directory")?;
    let decoder = flate2::read::GzDecoder::new(Cursor::new(bytes));
    let mut archive = tar::Archive::new(decoder);
    let mut entries = 0_usize;
    let mut expanded_bytes = 0_u64;
    for entry in archive
        .entries()
        .context("UPDATE_INSTALL: could not read the macOS updater archive")?
    {
        let mut entry = entry.context("UPDATE_INSTALL: macOS updater archive entry is invalid")?;
        entries = entries
            .checked_add(1)
            .context("UPDATE_INSTALL: macOS updater archive entry count overflow")?;
        ensure!(
            entries <= MAX_MACOS_ARCHIVE_ENTRIES,
            "UPDATE_INSTALL: macOS updater archive has too many entries"
        );
        let entry_size = entry
            .header()
            .size()
            .context("UPDATE_INSTALL: macOS updater archive entry size is invalid")?;
        expanded_bytes = expanded_bytes
            .checked_add(entry_size)
            .context("UPDATE_INSTALL: macOS updater archive size overflow")?;
        ensure!(
            expanded_bytes <= MAX_MACOS_EXPANDED_BYTES,
            "UPDATE_INSTALL: macOS updater archive expands beyond the byte budget"
        );
        validate_macos_archive_path(
            &entry
                .path()
                .context("UPDATE_INSTALL: macOS updater archive path is invalid")?,
        )?;
        entry
            .unpack_in(destination)
            .context("UPDATE_INSTALL: could not safely extract the macOS updater archive")?;
    }
    let staged_app = destination.join("Rho.app");
    ensure_regular_macos_app_directory(&staged_app, "staged macOS app bundle")?;
    let executable = staged_app.join("Contents/MacOS/rho-desktop");
    let executable_metadata = std::fs::symlink_metadata(&executable)
        .context("UPDATE_INSTALL: staged macOS app executable is missing")?;
    ensure!(
        executable_metadata.is_file() && !executable_metadata.file_type().is_symlink(),
        "UPDATE_INSTALL: staged macOS app executable is invalid"
    );
    Ok(staged_app)
}

#[cfg(target_os = "macos")]
fn verify_macos_staged_app(staged_app: &std::path::Path) -> Result<()> {
    let status = std::process::Command::new("/usr/bin/codesign")
        .args(["--verify", "--deep", "--strict"])
        .arg(staged_app)
        .status()
        .context("UPDATE_INSTALL: could not verify the staged macOS app signature")?;
    ensure!(
        status.success(),
        "UPDATE_INSTALL: staged macOS app signature verification failed"
    );
    Ok(())
}

#[cfg(target_os = "macos")]
fn replace_macos_app_with<F>(
    target_app: &std::path::Path,
    staged_app: &std::path::Path,
    mut rename: F,
) -> Result<std::path::PathBuf>
where
    F: FnMut(&std::path::Path, &std::path::Path) -> std::io::Result<()>,
{
    ensure_regular_macos_app_directory(target_app, "current macOS app bundle")?;
    ensure_regular_macos_app_directory(staged_app, "staged macOS app bundle")?;
    let parent = target_app
        .parent()
        .context("UPDATE_INSTALL: current macOS app has no parent directory")?;
    let backup = parent.join(format!(".rho-updater-backup-{}", uuid::Uuid::new_v4()));
    ensure!(
        !backup.exists(),
        "UPDATE_INSTALL: macOS updater backup path already exists"
    );
    rename(target_app, &backup)
        .context("UPDATE_INSTALL: could not preserve the current macOS app")?;
    match rename(staged_app, target_app) {
        Ok(()) => Ok(backup),
        Err(error) => {
            if let Err(rollback_error) = rename(&backup, target_app) {
                return Err(anyhow::anyhow!(
                    "UPDATE_INSTALL: could not install the staged macOS app ({error}) or restore the current app ({rollback_error})"
                ));
            }
            Err(anyhow::Error::new(error).context(
                "UPDATE_INSTALL: staged macOS app replacement failed; current app was restored",
            ))
        }
    }
}

#[cfg(target_os = "macos")]
fn restore_macos_app_after_launch_failure(
    target_app: &std::path::Path,
    backup: &std::path::Path,
) -> Result<()> {
    ensure_regular_macos_app_directory(target_app, "new macOS app bundle")?;
    ensure_regular_macos_app_directory(backup, "macOS app backup")?;
    std::fs::remove_dir_all(target_app)
        .context("UPDATE_INSTALL: could not remove the unlaunched macOS app")?;
    std::fs::rename(backup, target_app)
        .context("UPDATE_INSTALL: could not restore the current macOS app after launch failure")
}

#[cfg(target_os = "macos")]
fn install_macos_native_update(bytes: &[u8]) -> Result<()> {
    let target_app = macos_app_bundle_path(
        &std::env::current_exe()
            .context("UPDATE_INSTALL: could not locate the current executable")?,
    )?;
    let parent = target_app
        .parent()
        .context("UPDATE_INSTALL: current macOS app has no parent directory")?;
    let staging = tempfile::Builder::new()
        .prefix(".rho-updater-stage-")
        .tempdir_in(parent)
        .context("UPDATE_INSTALL: could not create a same-volume macOS staging directory")?;
    let staged_app = extract_macos_native_update_archive(bytes, staging.path())?;
    verify_macos_staged_app(&staged_app)?;
    let backup = replace_macos_app_with(&target_app, &staged_app, |source, destination| {
        std::fs::rename(source, destination)
    })?;
    let launch_result = std::process::Command::new("/usr/bin/open")
        .arg("-n")
        .arg(&target_app)
        .status()
        .context("UPDATE_INSTALL: could not launch the updated macOS app");
    if let Err(error) = launch_result.and_then(|status| {
        ensure!(
            status.success(),
            "UPDATE_INSTALL: updated macOS app launch returned a failure status"
        );
        Ok(())
    }) {
        if let Err(rollback_error) = restore_macos_app_after_launch_failure(&target_app, &backup) {
            return Err(anyhow::anyhow!(
                "UPDATE_INSTALL: updated macOS app did not launch ({error}) and current app rollback failed ({rollback_error})"
            ));
        }
        return Err(error.context(
            "UPDATE_INSTALL: updated macOS app did not launch; current app was restored",
        ));
    }
    let _ = std::fs::remove_dir_all(&backup);
    std::process::exit(0);
}

#[cfg(target_os = "linux")]
fn linux_appimage_path() -> Result<std::path::PathBuf> {
    let value = std::env::var_os("APPIMAGE")
        .context("UPDATE_INSTALL: APPIMAGE does not identify the running Linux package")?;
    let path = std::path::PathBuf::from(value);
    ensure!(
        path.is_absolute(),
        "UPDATE_INSTALL: APPIMAGE must be an absolute path"
    );
    let metadata = std::fs::symlink_metadata(&path)
        .context("UPDATE_INSTALL: current AppImage is unavailable")?;
    ensure!(
        metadata.is_file() && !metadata.file_type().is_symlink(),
        "UPDATE_INSTALL: current AppImage must be a regular non-symlink file"
    );
    Ok(path)
}

#[cfg(target_os = "linux")]
fn replace_linux_appimage_with<F>(
    target: &std::path::Path,
    staged: &std::path::Path,
    mut rename: F,
) -> Result<std::path::PathBuf>
where
    F: FnMut(&std::path::Path, &std::path::Path) -> std::io::Result<()>,
{
    let parent = target
        .parent()
        .context("UPDATE_INSTALL: current AppImage has no parent directory")?;
    let backup = parent.join(format!(
        ".rho-updater-backup-{}.AppImage",
        uuid::Uuid::new_v4()
    ));
    ensure!(
        !backup.exists(),
        "UPDATE_INSTALL: Linux updater backup path already exists"
    );
    rename(target, &backup).context("UPDATE_INSTALL: could not preserve the current AppImage")?;
    match rename(staged, target) {
        Ok(()) => Ok(backup),
        Err(error) => {
            rename(&backup, target).context(
                "UPDATE_INSTALL: could not restore the current AppImage after replacement failure",
            )?;
            Err(anyhow::Error::new(error).context(
                "UPDATE_INSTALL: staged AppImage replacement failed; current image was restored",
            ))
        }
    }
}

#[cfg(target_os = "linux")]
fn install_linux_native_update(bytes: &[u8]) -> Result<()> {
    use std::io::Write;
    use std::os::unix::fs::PermissionsExt;

    ensure!(
        bytes.starts_with(b"\x7fELF"),
        "UPDATE_INSTALL: verified Linux updater artifact is not an ELF AppImage"
    );
    let target = linux_appimage_path()?;
    let parent = target
        .parent()
        .context("UPDATE_INSTALL: current AppImage has no parent directory")?;
    let mut staged = tempfile::Builder::new()
        .prefix(".rho-updater-stage-")
        .suffix(".AppImage")
        .tempfile_in(parent)
        .context("UPDATE_INSTALL: could not stage the Linux AppImage")?;
    staged
        .write_all(bytes)
        .context("UPDATE_INSTALL: could not write the Linux AppImage")?;
    staged
        .as_file()
        .sync_all()
        .context("UPDATE_INSTALL: could not synchronize the Linux AppImage")?;
    std::fs::set_permissions(staged.path(), std::fs::Permissions::from_mode(0o755))
        .context("UPDATE_INSTALL: could not make the Linux AppImage executable")?;
    let smoke = std::process::Command::new(staged.path())
        .args(["--appimage-extract-and-run", "--smoke-test"])
        .env("APPIMAGE", staged.path())
        .status()
        .context("UPDATE_INSTALL: could not smoke-test the staged Linux AppImage")?;
    ensure!(
        smoke.success(),
        "UPDATE_INSTALL: staged Linux AppImage smoke test failed"
    );
    let (_, staged_path) = staged
        .keep()
        .context("UPDATE_INSTALL: could not preserve the staged Linux AppImage")?;
    let backup = replace_linux_appimage_with(&target, &staged_path, |source, destination| {
        std::fs::rename(source, destination)
    })?;
    match std::process::Command::new(&target)
        .env("APPIMAGE", &target)
        .spawn()
    {
        Ok(_) => {
            let _ = std::fs::remove_file(backup);
            std::process::exit(0);
        }
        Err(error) => {
            let _ = std::fs::remove_file(&target);
            std::fs::rename(&backup, &target)
                .context("UPDATE_INSTALL: updated AppImage did not launch and rollback failed")?;
            Err(anyhow::Error::new(error).context(
                "UPDATE_INSTALL: updated AppImage did not launch; current image was restored",
            ))
        }
    }
}

pub fn install_verified_native_update(
    _update: &tauri_plugin_updater::Update,
    bytes: &[u8],
) -> Result<()> {
    #[cfg(windows)]
    return install_windows_native_update(bytes);
    #[cfg(target_os = "macos")]
    return install_macos_native_update(bytes);
    #[cfg(target_os = "linux")]
    return install_linux_native_update(bytes);
    #[cfg(not(any(windows, target_os = "macos", target_os = "linux")))]
    {
        let _ = bytes;
        Err(anyhow::anyhow!(
            "UPDATE_PLATFORM_UNAVAILABLE: native updates are not available for this platform"
        ))
    }
}

pub fn normalized_native_update_notes(notes: Option<&str>) -> Result<String> {
    let notes = notes
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(DEFAULT_NATIVE_UPDATE_NOTES);
    ensure!(
        !notes.chars().any(char::is_control),
        "UPDATE_INVALID: native update notes contain control characters"
    );
    ensure!(
        notes.chars().count() <= MAX_NATIVE_UPDATE_NOTES_CHARS,
        "UPDATE_INVALID: native update notes exceed the character budget"
    );
    Ok(notes.to_string())
}

pub fn validate_product_url(value: &str) -> Result<()> {
    let url = reqwest::Url::parse(value).context("UPDATE_INVALID: release page URL is invalid")?;
    let rho_page = url.scheme() == "https"
        && url.host_str() == Some("yulab-smu.top")
        && (url.path() == "/Rho" || url.path().starts_with("/Rho/"));
    let source = url.scheme() == "https"
        && url.host_str() == Some("github.com")
        && (url.path() == "/YuLab-SMU/Rho" || url.path() == "/YuLab-SMU/Rho/");
    ensure!(
        rho_page || source,
        "UPDATE_INVALID: release page URL is not allowlisted"
    );
    ensure!(
        url.username().is_empty() && url.password().is_none(),
        "UPDATE_INVALID: URL credentials are forbidden"
    );
    ensure!(
        url.query().is_none() && url.fragment().is_none(),
        "UPDATE_INVALID: URL query and fragment are forbidden"
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    const TEST_PUBLIC_KEY: &str = "untrusted comment: minisign public key E7620F1842B4E81F\nRWQf6LRCGA9i53mlYecO4IzT51TGPpvWucNSCh1CBM0QTaLn73Y7GFO3";
    const TEST_PREHASHED_SIGNATURE: &str = "untrusted comment: signature from minisign secret key\nRUQf6LRCGA9i559r3g7V1qNyJDApGip8MfqcadIgT9CuhV3EMhHoN1mGTkUidF/z7SrlQgXdy8ofjb7bNJJylDOocrCo8KLzZwo=\ntrusted comment: timestamp:1556193335\tfile:test\ny/rUw2y8/hOUYjZU71eHp/Wo1KZ40fGy2VJEDl34XMJM+TX48Ss/17u3IvIfbVR1FkZZSNCisQbuQY+bHwhEBg==";

    #[test]
    fn derives_release_channel() {
        assert_eq!(
            ReleaseChannel::for_version(&Version::parse("0.2.0").unwrap()),
            ReleaseChannel::Stable
        );
        assert_eq!(
            ReleaseChannel::for_version(&Version::parse("0.2.0-dev.12").unwrap()),
            ReleaseChannel::Development
        );
    }

    #[test]
    fn native_updater_uses_distinct_channel_endpoints() {
        assert_eq!(
            native_manifest_url(ReleaseChannel::Stable),
            "https://yulab-smu.top/Rho/updates/tauri/stable.json"
        );
        assert_eq!(
            native_manifest_url(ReleaseChannel::Development),
            "https://yulab-smu.top/Rho/updates/tauri/development.json"
        );
    }

    #[test]
    fn native_updater_platform_scope_is_explicit() {
        assert!(native_updater_supported_for("windows", "x86_64"));
        assert!(native_updater_supported_for("macos", "aarch64"));
        assert!(native_updater_supported_for("linux", "x86_64"));
        assert!(!native_updater_supported_for("macos", "x86_64"));
    }

    #[test]
    fn native_update_notes_are_bounded_plain_text() {
        assert_eq!(
            normalized_native_update_notes(None).unwrap(),
            "A signed Rho update is available."
        );
        assert!(normalized_native_update_notes(Some("line one\nline two")).is_err());
        assert!(normalized_native_update_notes(Some(&"x".repeat(501))).is_err());
    }

    #[test]
    fn native_updater_download_is_allowlisted_bounded_and_signed() {
        let valid = Url::parse(
            "https://github.com/YuLab-SMU/Rho/releases/download/v0.4.0-dev.40/Rho_0.4.0-dev.40_x64-setup.exe",
        )
        .unwrap();
        assert!(native_update_asset_url_is_allowed(&valid));
        for value in [
            "https://example.test/Rho_0.4.0-dev.40_x64-setup.exe",
            "https://github.com/YuLab-SMU/Rho/releases/download/v0.4.0-dev.40/file.exe?download=1",
            "https://user:secret@github.com/YuLab-SMU/Rho/releases/download/v0.4.0-dev.40/file.exe",
        ] {
            assert!(
                !native_update_asset_url_is_allowed(&Url::parse(value).unwrap()),
                "{value}"
            );
        }
        assert_eq!(
            native_update_next_length(MAX_NATIVE_UPDATE_ARTIFACT_BYTES - 1, 1).unwrap(),
            MAX_NATIVE_UPDATE_ARTIFACT_BYTES
        );
        assert!(native_update_next_length(MAX_NATIVE_UPDATE_ARTIFACT_BYTES, 1).is_err());
        assert!(native_update_next_length(usize::MAX, 1).is_err());

        let public_key = PublicKey::decode(TEST_PUBLIC_KEY).unwrap();
        let encoded_signature = STANDARD.encode(TEST_PREHASHED_SIGNATURE);
        assert!(
            validate_native_update_candidate_metadata("0.4.0-dev.41", &valid, &encoded_signature,)
                .is_ok()
        );
        assert!(
            validate_native_update_candidate_metadata("not-semver", &valid, &encoded_signature)
                .is_err()
        );
        assert!(
            validate_native_update_candidate_metadata("0.4.0-dev.41", &valid, "not a signature",)
                .is_err()
        );
        assert!(verify_native_update_signature(b"test", &encoded_signature, &public_key).is_ok());
        assert!(verify_native_update_signature(b"Test", &encoded_signature, &public_key).is_err());
    }

    #[test]
    fn product_urls_are_allowlisted_without_credentials_or_fragments() {
        for value in [
            "https://yulab-smu.top/Rho/",
            "https://github.com/YuLab-SMU/Rho",
        ] {
            assert!(validate_product_url(value).is_ok(), "{value}");
        }
        for value in [
            "https://example.test/Rho/",
            "https://user:secret@yulab-smu.top/Rho/",
            "https://yulab-smu.top/Rho/?tracking=1",
            "https://github.com/YuLab-SMU/Rho#download",
        ] {
            assert!(validate_product_url(value).is_err(), "{value}");
        }
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn macos_native_update_staging_and_replacement_are_transactional() {
        let root = tempfile::tempdir().unwrap();
        let source_app = root.path().join("source/Rho.app");
        let source_executable = source_app.join("Contents/MacOS/rho-desktop");
        std::fs::create_dir_all(source_executable.parent().unwrap()).unwrap();
        std::fs::write(&source_executable, "new app").unwrap();

        let mut archive_bytes = Vec::new();
        {
            let encoder =
                flate2::write::GzEncoder::new(&mut archive_bytes, flate2::Compression::default());
            let mut archive = tar::Builder::new(encoder);
            archive.append_dir_all("Rho.app", &source_app).unwrap();
            archive.into_inner().unwrap().finish().unwrap();
        }
        let staging = root.path().join("staging");
        std::fs::create_dir(&staging).unwrap();
        let staged_app = extract_macos_native_update_archive(&archive_bytes, &staging).unwrap();
        assert_eq!(
            std::fs::read(staged_app.join("Contents/MacOS/rho-desktop")).unwrap(),
            b"new app"
        );

        let target_app = root.path().join("Rho.app");
        let target_executable = target_app.join("Contents/MacOS/rho-desktop");
        std::fs::create_dir_all(target_executable.parent().unwrap()).unwrap();
        std::fs::write(&target_executable, "old app").unwrap();
        let mut moves = 0;
        let error = replace_macos_app_with(&target_app, &staged_app, |source, destination| {
            moves += 1;
            if moves == 2 {
                return Err(std::io::Error::other("injected replacement failure"));
            }
            std::fs::rename(source, destination)
        })
        .unwrap_err();
        assert!(error.to_string().contains("current app was restored"));
        assert_eq!(
            std::fs::read(target_app.join("Contents/MacOS/rho-desktop")).unwrap(),
            b"old app"
        );
        assert!(staged_app.is_dir());
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn linux_appimage_replacement_is_transactional() {
        let root = tempfile::tempdir().unwrap();
        let target = root.path().join("Rho.AppImage");
        let staged = root.path().join("staged.AppImage");
        std::fs::write(&target, b"old image").unwrap();
        std::fs::write(&staged, b"new image").unwrap();
        let backup = replace_linux_appimage_with(&target, &staged, |source, destination| {
            std::fs::rename(source, destination)
        })
        .unwrap();
        assert_eq!(std::fs::read(&target).unwrap(), b"new image");
        assert_eq!(std::fs::read(&backup).unwrap(), b"old image");

        let failed_target = root.path().join("failed.AppImage");
        let failed_staged = root.path().join("failed-staged.AppImage");
        std::fs::write(&failed_target, b"original").unwrap();
        std::fs::write(&failed_staged, b"replacement").unwrap();
        let mut moves = 0;
        let error =
            replace_linux_appimage_with(&failed_target, &failed_staged, |source, destination| {
                moves += 1;
                if moves == 2 {
                    return Err(std::io::Error::other("injected replacement failure"));
                }
                std::fs::rename(source, destination)
            })
            .unwrap_err();
        assert!(error.to_string().contains("current image was restored"));
        assert_eq!(std::fs::read(&failed_target).unwrap(), b"original");
        assert_eq!(std::fs::read(&failed_staged).unwrap(), b"replacement");
    }
}
