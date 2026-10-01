use super::*;
use rho_environment_api::InstalledEnvironmentPackage;
use std::collections::BTreeMap;

/// The native helper is run only by explicit Host startup or effectful operations.
/// Query callers can read this established configuration but cannot refresh it.
#[derive(Debug, Clone, Deserialize)]
pub(super) struct NativeConfiguration {
    r_version: String,
    platform: String,
    r_home: String,
    library_paths: Vec<String>,
    jsonlite_library: String,
    renv_available: bool,
    pak_available: bool,
    #[serde(default)]
    observed_at_ms: i64,
    #[serde(default)]
    source: String,
}

impl REnvironmentOwner {
    /// Read the exact managed library and its digest without launching R or
    /// loading namespaces. Explicit verification remains a separate operation.
    pub async fn inspect_realization_library(
        &self,
        receipt: &rho_environment_api::EnvironmentRealization,
    ) -> Result<std::path::PathBuf, String> {
        if receipt.project_root != self.root || !receipt.verified {
            return Err("Library selection requires a verified realization in this project".into());
        }
        let library = self.owned_path(&receipt.library_path)?;
        if library != std::path::Path::new(&receipt.library_path) || !library.is_dir() {
            return Err("Realized library identity changed".into());
        }
        if super::digest(&library).await? != receipt.library_digest {
            return Err("Managed library bytes changed after realization".into());
        }
        Ok(library)
    }
    /// Explicit ordinary-plugin operation: preserve its original process marker
    /// and cancellation evidence while establishing configuration for later reads.
    pub async fn refresh_configuration(
        &self,
        operation_id: &str,
        cancellation: watch::Receiver<bool>,
    ) -> Result<EnvironmentObservation, EnvironmentOwnerError> {
        self.helper_call(
            Some(operation_id),
            "observe",
            json!({"library":null,"limit":1}),
            cancellation,
        )
        .await?;
        self.observe_filesystem(None, 500)
            .await
            .map_err(|error| EnvironmentOwnerError::after_possible_effect(error, None))
    }
    /// Explicit lifecycle setup, never called by a QueryHandler. Failure is
    /// retained so the query reports why native configuration is unavailable.
    pub async fn initialize_observation(&self) -> Result<(), String> {
        match self
            .helper_call(
                None,
                "observe",
                json!({"library":null,"limit":1}),
                watch::channel(false).1,
            )
            .await
        {
            Ok(_) => Ok(()),
            Err(error) => {
                let message = format!(
                    "Native Environment startup observation failed: {}",
                    error.message
                );
                *self.observation.lock().map_err(display)? = Err(message.clone());
                Err(message)
            }
        }
    }

    pub(super) fn remember_configuration(
        &self,
        value: &Value,
        operation_id: Option<&str>,
    ) -> Result<(), String> {
        let mut native: NativeConfiguration =
            serde_json::from_value(value.clone()).map_err(display)?;
        if native.library_paths.is_empty() || native.library_paths.len() > 128 {
            return Err("Native Environment library configuration exceeds its bounds".into());
        }
        native.observed_at_ms = now_ms().map_err(display)?;
        native.source = operation_id.map_or_else(
            || "explicit_host_startup".into(),
            |id| format!("environment_operation:{id}"),
        );
        *self.observation.lock().map_err(display)? = Ok(native);
        Ok(())
    }

    pub(super) async fn observe_filesystem(
        &self,
        library: Option<&str>,
        limit: usize,
    ) -> Result<EnvironmentObservation, String> {
        if !(1..=500).contains(&limit) {
            return Err("Environment observation limit is invalid".into());
        }
        let native = self.observation.lock().map_err(display)?.clone()?;
        let libraries = match library {
            Some(path) => vec![self.owned_path(path)?.to_string_lossy().into_owned()],
            None => native.library_paths.clone(),
        };
        tokio::task::spawn_blocking(move || inventory(native, libraries, limit))
            .await
            .map_err(display)?
    }
}

fn inventory(
    native: NativeConfiguration,
    libraries: Vec<String>,
    limit: usize,
) -> Result<EnvironmentObservation, String> {
    let mut notices = vec!["Runtime configuration and tool availability are cached from the stated startup/operation time. Package versions are current bounded DESCRIPTION observations; no namespace is loaded or tested, and concurrent filesystem changes are possible.".into()];
    let mut packages = BTreeMap::new();
    let mut scanned = 0_usize;
    let mut bytes = 0_usize;
    let mut bounded = false;
    'libraries: for library in &libraries {
        let mut entries = match std::fs::read_dir(library) {
            Ok(entries) => entries,
            Err(error) => {
                notices.push(format!("Library {library} is unavailable: {error}"));
                continue;
            }
        };
        let mut paths = Vec::new();
        for entry in entries.by_ref() {
            scanned += 1;
            if scanned > 20_000 {
                bounded = true;
                break;
            }
            paths.push(entry.map_err(display)?.path());
        }
        paths.sort();
        for path in paths {
            let description = path.join("DESCRIPTION");
            match std::fs::metadata(&description) {
                Ok(metadata) if metadata.is_file() => {}
                Ok(_) => {
                    if notices.len() < 16 {
                        notices.push(format!(
                            "Package metadata {} is not a regular file.",
                            description.display()
                        ));
                    }
                    continue;
                }
                Err(error)
                    if error.kind() == std::io::ErrorKind::NotFound
                        || error.kind() == std::io::ErrorKind::NotADirectory =>
                {
                    continue;
                }
                Err(error) => {
                    if notices.len() < 16 {
                        notices.push(format!(
                            "Package metadata {} is unavailable: {error}",
                            description.display()
                        ));
                    }
                    continue;
                }
            }
            let mut input = match std::fs::File::open(&description) {
                Ok(file) => file.take(256 * 1024 + 1),
                Err(error)
                    if error.kind() == std::io::ErrorKind::NotFound
                        || error.kind() == std::io::ErrorKind::NotADirectory =>
                {
                    continue;
                }
                Err(error) => {
                    if notices.len() < 16 {
                        notices.push(format!(
                            "Package metadata {} is unavailable: {error}",
                            description.display()
                        ));
                    }
                    continue;
                }
            };
            let mut text = Vec::new();
            input.read_to_end(&mut text).map_err(display)?;
            bytes += text.len();
            if text.len() > 256 * 1024 || bytes > 8 * 1024 * 1024 {
                bounded = true;
                break 'libraries;
            }
            let fields = package_fields(&text);
            if let Some((name, version)) = fields {
                packages
                    .entry(name.clone())
                    .or_insert(InstalledEnvironmentPackage {
                        name,
                        version,
                        library: library.clone(),
                    });
            } else if notices.len() < 16 {
                notices.push(format!(
                    "Package metadata {} has no valid Package/Version record.",
                    description.display()
                ));
            }
        }
        if bounded {
            break;
        }
    }
    if bounded {
        notices.push("Filesystem inventory reached its 20,000-entry, 256-KiB-description or 8-MiB-total bound.".into());
    }
    let truncated = bounded || packages.len() > limit;
    Ok(EnvironmentObservation {
        r_version: native.r_version,
        platform: native.platform,
        r_home: native.r_home,
        library_paths: libraries,
        packages: packages.into_values().take(limit).collect(),
        truncated,
        jsonlite_library: native.jsonlite_library,
        renv_available: native.renv_available,
        pak_available: native.pak_available,
        configuration_observed_at_ms: native.observed_at_ms,
        configuration_source: native.source,
        inventory_observed_at_ms: now_ms().map_err(display)?,
        active_workspace_library: None,
        notices,
    })
}

fn package_fields(text: &[u8]) -> Option<(String, String)> {
    let mut name = None;
    let mut version = None;
    for line in text.split(|byte| *byte == b'\n') {
        let line = line.strip_suffix(b"\r").unwrap_or(line);
        if line.is_empty() {
            break;
        }
        if line.first().is_some_and(u8::is_ascii_whitespace) {
            continue;
        }
        let colon = line.iter().position(|byte| *byte == b':')?;
        let (field, value) = (&line[..colon], &line[colon + 1..]);
        match field {
            b"Package" if name.is_none() => {
                name = Some(std::str::from_utf8(value).ok()?.trim().to_string())
            }
            b"Version" if version.is_none() => {
                version = Some(std::str::from_utf8(value).ok()?.trim().to_string())
            }
            b"Package" | b"Version" => return None,
            _ => {}
        }
    }
    let package = PackageVersion {
        name: name?,
        version: version?,
    };
    validate_package(&package).ok()?;
    Some((package.name, package.version))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn observation_never_starts_uninitialized_or_configured_r() {
        let (_directory, runtime) = crate::recovery_tests::environment();
        assert!(
            runtime
                .observe(None, 20)
                .await
                .unwrap_err()
                .contains("has not been established")
        );
        let library = runtime.config.data_root.join("library");
        std::fs::create_dir_all(library.join("fixture")).unwrap();
        std::fs::write(
            library.join("fixture/DESCRIPTION"),
            "Package: fixture\nVersion: 1.0\nDescription: Never execute this content.\n",
        )
        .unwrap();
        runtime.remember_configuration(&json!({"r_version":"4.5.0","platform":"fixture","r_home":"/configured/R","library_paths":[library],"jsonlite_library":"/configured/library","renv_available":true,"pak_available":false}), None).unwrap();
        let first = runtime.observe(None, 20).await.unwrap();
        assert_eq!(first.packages[0].version, "1.0");
        std::fs::write(
            library.join("fixture/DESCRIPTION"),
            "Package: fixture\nVersion: 2.0\n",
        )
        .unwrap();
        let changed = runtime
            .observe(Some(library.to_str().unwrap()), 20)
            .await
            .unwrap();
        assert_eq!(changed.packages[0].version, "2.0");
        assert_eq!(
            first.configuration_observed_at_ms,
            changed.configuration_observed_at_ms
        );
        assert_eq!(changed.configuration_source, "explicit_host_startup");
        // The configured executable is this test executable, not R. Entering
        // any helper path would fail this test instead of returning these facts.
        assert!(!runtime.config.data_root.join("recovery").exists());
    }

    #[test]
    fn description_parser_preserves_native_version_and_rejects_duplicate_identity() {
        assert_eq!(
            package_fields(b"Package: example\nVersion: 1.2-3\nDescription: hello\n continued\n"),
            Some(("example".into(), "1.2-3".into()))
        );
        assert!(package_fields(b"Package: a\nPackage: b\nVersion: 1\n").is_none());
        assert_eq!(
            package_fields(b"Package: example\nVersion: 1.0\nDescription: latin1 caf\xe9\n"),
            Some(("example".into(), "1.0".into()))
        );
    }
}
