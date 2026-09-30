use rho_files_api::*;
use std::{fs, path::PathBuf};
use ts_rs::{Config, TS};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let root = PathBuf::from(
        std::env::args_os()
            .nth(1)
            .ok_or("Expected output directory")?,
    );
    let types = Config::new()
        .with_out_dir(root.join("types"))
        .with_large_int("number");
    macro_rules! export {
        ($($type:ty),+ $(,)?) => { $(<$type>::export_all(&types)?;)+ };
    }
    export!(
        ListDirectoryArguments,
        DirectoryPage,
        SearchFilesArguments,
        FileSearchResult,
        ProjectStorage,
        ProjectSnapshotArguments,
        ProjectSnapshot,
        ReadFileArguments,
        FilePage,
        ReadTextArguments,
        TextPage,
        SearchTextArguments,
        SearchTextPage,
        ApplyPatchArguments,
        ProjectPatchResult,
        ProjectPatchRecovery,
        FilePrecondition
    );
    fs::create_dir_all(root.join("schema"))?;
    for (name, schema) in [
        (
            "list-directory",
            schemars::schema_for!(ListDirectoryArguments),
        ),
        ("directory-page", schemars::schema_for!(DirectoryPage)),
        ("search-files", schemars::schema_for!(SearchFilesArguments)),
        (
            "file-search-result",
            schemars::schema_for!(FileSearchResult),
        ),
        ("storage", schemars::schema_for!(ProjectStorage)),
        ("snapshot", schemars::schema_for!(ProjectSnapshotArguments)),
        ("project-snapshot", schemars::schema_for!(ProjectSnapshot)),
        ("read-file", schemars::schema_for!(ReadFileArguments)),
        ("file-page", schemars::schema_for!(FilePage)),
        ("read-text", schemars::schema_for!(ReadTextArguments)),
        ("text-page", schemars::schema_for!(TextPage)),
        ("search-text", schemars::schema_for!(SearchTextArguments)),
        ("text-search-page", schemars::schema_for!(SearchTextPage)),
        ("apply-patch", schemars::schema_for!(ApplyPatchArguments)),
        ("precondition", schemars::schema_for!(FilePrecondition)),
        ("patch-result", schemars::schema_for!(ProjectPatchResult)),
        (
            "patch-recovery",
            schemars::schema_for!(ProjectPatchRecovery),
        ),
    ] {
        fs::write(
            root.join("schema").join(format!("{name}.json")),
            serde_json::to_string_pretty(&schema)?,
        )?;
    }
    Ok(())
}
