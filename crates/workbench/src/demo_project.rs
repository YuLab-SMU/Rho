use std::path::{Path, PathBuf};

const DEMO_VERSION: &str = "1";

const FILES: &[(&str, &[u8])] = &[
    ("README.md", include_bytes!("../../../examples/rho-demo/README.md")),
    (".gitignore", include_bytes!("../../../examples/rho-demo/.gitignore")),
    ("demo-manifest.json", include_bytes!("../../../examples/rho-demo/demo-manifest.json")),
    ("rho-demo.Rproj", include_bytes!("../../../examples/rho-demo/rho-demo.Rproj")),
    ("R/demo_helpers.R", include_bytes!("../../../examples/rho-demo/R/demo_helpers.R")),
    (
        "scripts/01_import_clean.R",
        include_bytes!("../../../examples/rho-demo/scripts/01_import_clean.R"),
    ),
    (
        "scripts/02_transform_model.R",
        include_bytes!("../../../examples/rho-demo/scripts/02_transform_model.R"),
    ),
    (
        "scripts/03_figures_viewer.R",
        include_bytes!("../../../examples/rho-demo/scripts/03_figures_viewer.R"),
    ),
    (
        "scripts/04_report.R",
        include_bytes!("../../../examples/rho-demo/scripts/04_report.R"),
    ),
    ("run_demo.R", include_bytes!("../../../examples/rho-demo/run_demo.R")),
    (
        "report/development_report.qmd",
        include_bytes!("../../../examples/rho-demo/report/development_report.qmd"),
    ),
    (
        "data/raw/gapminder.csv",
        include_bytes!("../../../examples/rho-demo/data/raw/gapminder.csv"),
    ),
    (
        "data/raw/source.json",
        include_bytes!("../../../examples/rho-demo/data/raw/source.json"),
    ),
    (
        "data/processed/.gitkeep",
        include_bytes!("../../../examples/rho-demo/data/processed/.gitkeep"),
    ),
    (
        "output/figures/.gitkeep",
        include_bytes!("../../../examples/rho-demo/output/figures/.gitkeep"),
    ),
];

pub fn materialize_demo_project() -> Result<PathBuf, String> {
    let root = std::env::var_os("RHO_DEMO_PROJECT")
        .map(PathBuf::from)
        .unwrap_or(default_path()?);
    materialize_demo_project_at(&root)
}

pub fn materialize_demo_project_at(root: &Path) -> Result<PathBuf, String> {
    if !root.is_absolute() {
        return Err("the demo project path must be absolute".into());
    }
    if root.exists() && !root.is_dir() {
        return Err("the demo project path is not a directory".into());
    }
    std::fs::create_dir_all(root).map_err(|error| format!("create demo project: {error}"))?;
    let root = root
        .canonicalize()
        .map_err(|error| format!("resolve demo project: {error}"))?;
    for (relative, bytes) in FILES {
        let path = root.join(relative);
        if path.exists() {
            if !path.is_file() {
                return Err(format!("demo resource path is not a file: {relative}"));
            }
            continue;
        }
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|error| format!("create demo resource directory: {error}"))?;
        }
        std::fs::write(&path, bytes).map_err(|error| format!("write demo resource {relative}: {error}"))?;
    }
    let manifest = root.join("demo-manifest.json");
    let value: serde_json::Value = serde_json::from_slice(
        &std::fs::read(&manifest).map_err(|error| format!("read demo manifest: {error}"))?,
    )
    .map_err(|error| format!("parse demo manifest: {error}"))?;
    if value.get("version").and_then(serde_json::Value::as_str) != Some(DEMO_VERSION) {
        return Err("unsupported demo project version".into());
    }
    Ok(root)
}

fn default_path() -> Result<PathBuf, String> {
    let home = std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
        .ok_or("the user home directory is unavailable")?;
    #[cfg(target_os = "macos")]
    {
        return Ok(home.join("Library/Application Support/Rho/demo-project"));
    }
    #[cfg(target_os = "windows")]
    {
        let base = std::env::var_os("LOCALAPPDATA")
            .map(PathBuf::from)
            .unwrap_or_else(|| home.clone());
        return Ok(base.join("Rho/demo-project"));
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        let base = std::env::var_os("XDG_DATA_HOME")
            .map(PathBuf::from)
            .unwrap_or_else(|| home.join(".local/share"));
        Ok(base.join("rho/demo-project"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn materializes_a_complete_project_without_overwriting_user_files() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("demo");
        let first = materialize_demo_project_at(&root).unwrap();
        assert_eq!(first, root.canonicalize().unwrap());
        assert!(root.join("data/raw/gapminder.csv").is_file());
        assert!(root.join("scripts/03_figures_viewer.R").is_file());
        let manifest = std::fs::read_to_string(root.join("demo-manifest.json")).unwrap();
        assert!(manifest.contains("rho-gapminder-demo"));
        assert!(manifest.contains("\"version\": \"1\""));
        std::fs::write(root.join("README.md"), "my notes\n").unwrap();
        materialize_demo_project_at(&root).unwrap();
        assert_eq!(std::fs::read_to_string(root.join("README.md")).unwrap(), "my notes\n");
    }

    #[test]
    fn rejects_a_file_as_the_project_root() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("not-a-directory");
        std::fs::write(&root, "x").unwrap();
        assert!(materialize_demo_project_at(&root).unwrap_err().contains("not a directory"));
    }
}
