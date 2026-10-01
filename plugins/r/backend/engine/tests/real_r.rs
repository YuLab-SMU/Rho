//! Explicit native acceptance in a disposable project, without Host or journal code.
use rho_r_api::*;
use rho_r_engine::{ArkConfig, ArkRuntime, OutputStore};
use std::{path::PathBuf, sync::Arc, time::Duration};

async fn exercise(runtime: &ArkRuntime, data: &std::path::Path) -> Result<(), String> {
    let operation = OperationId::new("external-r-engine/run").map_err(|e| e.to_string())?;
    let report = runtime.execute(&operation, &RunRArguments {
        code: "x <- 21; cat('R 插件 α\\n'); f <- tempfile(fileext='.html'); writeLines('<html><body>retained independent viewer</body></html>', f); getOption('viewer')(f); x * 2".into(),
        ..Default::default()
    }).await.map_err(|e| e.message)?;
    if report.outcome != rho_plugin_protocol::PluginOutcome::Succeeded || report.value != 42 {
        return Err(format!("native execution failed: {report:?}"));
    }
    if !report.stdout.contains("R 插件 α") {
        return Err("Unicode output was lost".into());
    }
    let html = report
        .output_references
        .iter()
        .find(|r| r.mime_type == "text/html")
        .ok_or("Viewer output was not retained")?;
    let store = OutputStore::open_read_only(data, runtime.project_root().unwrap())?
        .ok_or("Native output evidence was not retained")?;
    let bytes = store.verified_original(html)?;
    if !String::from_utf8_lossy(&bytes).contains("retained independent viewer") {
        return Err("Retained Viewer bytes differ".into());
    }
    let observation = runtime
        .query(&WorkspaceQuery::Snapshot(SnapshotArguments {
            limit: 20,
            expected_session: Some(runtime.session_id().into()),
        }))
        .await
        .map_err(|e| e.message)?;
    let snapshot: WorkspaceSnapshotData =
        serde_json::from_value(observation.data).map_err(|e| e.to_string())?;
    if !snapshot.objects.iter().any(|binding| binding.name == "x") {
        return Err("Native object observation did not see the original session".into());
    }
    Ok(())
}

#[tokio::test]
#[ignore = "requires explicitly configured RHO_ARK and RHO_R_HOME"]
async fn standalone_native_r_preserves_session_and_viewer_evidence() {
    let project = tempfile::tempdir().unwrap();
    let project_root = project.path().canonicalize().unwrap();
    let data = project_root.join("owned-runtime");
    let runtime = Arc::new(
        ArkRuntime::launch(ArkConfig {
            checkpoint_helper_path: None,
            executable: PathBuf::from(std::env::var_os("RHO_ARK").expect("RHO_ARK")),
            r_home: PathBuf::from(std::env::var_os("RHO_R_HOME").expect("RHO_R_HOME")),
            project_root,
            data_root: data.clone(),
            execution_timeout: Duration::from_secs(30),
            library_path: None,
        })
        .await
        .unwrap(),
    );
    let result = exercise(&runtime, &data).await;
    let stopped = runtime.shutdown().await;
    result.unwrap();
    stopped.unwrap();
    assert_eq!(runtime.native_process_alive().await.unwrap(), Some(false));
}
