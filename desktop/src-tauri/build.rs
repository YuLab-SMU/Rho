use std::process::Command;

fn frontend_entry() -> String {
    let manifest_path = std::path::Path::new("../dist/asset-manifest.json");
    println!("cargo:rerun-if-changed={}", manifest_path.display());
    std::fs::read_to_string(manifest_path)
        .ok()
        .and_then(|manifest| serde_json::from_str::<serde_json::Value>(&manifest).ok())
        .and_then(|manifest| {
            manifest
                .get("index.html")?
                .get("file")?
                .as_str()
                .map(str::to_string)
        })
        .unwrap_or_else(|| "unbuilt".to_string())
}

fn main() {
    println!("cargo:rerun-if-env-changed=RHO_BUILD_COMMIT");
    println!("cargo:rerun-if-changed=../../.git/HEAD");
    let commit = std::env::var("RHO_BUILD_COMMIT")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .or_else(|| {
            Command::new("git")
                .args(["rev-parse", "HEAD"])
                .output()
                .ok()
                .filter(|output| output.status.success())
                .and_then(|output| String::from_utf8(output.stdout).ok())
                .map(|value| value.trim().to_string())
                .filter(|value| !value.is_empty())
        })
        .unwrap_or_else(|| "unknown".to_string());
    println!("cargo:rustc-env=RHO_BUILD_COMMIT={commit}");
    println!("cargo:rustc-env=RHO_FRONTEND_ENTRY={}", frontend_entry());
    tauri_build::build()
}
