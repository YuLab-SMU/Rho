use rho_contract::{
    CapabilityRef, Invocation, MediaReference, OperationStatus, QueryRequest, QueryStatus,
    RunROutput,
};
use rho_host::{ArkConfig, NextHost};
use serde_json::json;
use std::{path::PathBuf, time::Duration};

fn request(id: &str, code: &str) -> Invocation {
    Invocation {
        client_request_id: id.into(),
        capability: CapabilityRef::new("workspace.run_r", 1).unwrap(),
        arguments: json!({"workspace_instance_id":"main","code":code,"output_mode":"console"}),
        preconditions: Vec::new(),
    }
}

fn query(id: &str, arguments: serde_json::Value) -> QueryRequest {
    QueryRequest {
        capability: CapabilityRef::new(id, 1).unwrap(),
        arguments,
    }
}

fn output(record: &rho_contract::OperationRecord) -> RunROutput {
    serde_json::from_value(record.output.clone().unwrap()).unwrap()
}

fn media(output: &RunROutput, mime: &str) -> MediaReference {
    output
        .output_references
        .iter()
        .find(|reference| reference.mime_type == mime)
        .cloned()
        .unwrap_or_else(|| panic!("missing {mime} output: {:?}", output.output_references))
}

async fn read_output(host: &NextHost, reference: &MediaReference) -> Vec<u8> {
    let snapshot = host
        .query_snapshot(
            &NextHost::local_context(),
            query(
                "workspace.read_output",
                json!({"reference":reference,"offset":0,"limit_bytes":65536}),
            ),
        )
        .await
        .unwrap();
    assert_eq!(snapshot.status, QueryStatus::Ready, "{snapshot:?}");
    snapshot
        .data
        .unwrap()["bytes"]
        .as_array()
        .unwrap()
        .iter()
        .map(|byte| byte.as_u64().unwrap() as u8)
        .collect()
}

async fn assert_html_artifact(host: &NextHost, reference: &MediaReference) {
    assert_eq!(reference.mime_type, "text/html");
    let html = String::from_utf8(read_output(host, reference).await).unwrap();
    assert!(html.contains("html-widget"), "HTML widget marker missing");
    assert!(html.to_ascii_lowercase().contains("datatables"), "DT dependency missing");
    assert!(!html.contains("<script src="), "local script was not inlined");
    assert!(!html.contains("<link rel=\"stylesheet\" href="), "local stylesheet was not inlined");
    assert!(!html.contains("file://"), "HTML artifact retained a file URL");
}

#[tokio::test]
#[ignore = "requires real Ark 0.1.252, R, DT and htmlwidgets; run with RHO_ARK and RHO_R_HOME"]
async fn real_ark_htmlwidgets_survive_reattach_reload_failures_and_keep_plot_outputs_separate() {
    let directory = tempfile::tempdir().unwrap();
    let host = NextHost::open_ark(
        directory.path().join("html-widgets.sqlite"),
        ArkConfig {
            executable: PathBuf::from(std::env::var_os("RHO_ARK").expect("RHO_ARK required")),
            r_home: PathBuf::from(std::env::var_os("RHO_R_HOME").expect("RHO_R_HOME required")),
            project_root: directory.path().into(),
            data_root: directory.path().join("runtime"),
            execution_timeout: Duration::from_secs(30),
            library_path: None,
            checkpoint_helper_path: None,
        },
    )
    .await
    .unwrap();
    let context = NextHost::local_context();

    let first = host
        .invoke(
            &context,
            request(
                "dt-first",
                "stopifnot(requireNamespace('DT', quietly=TRUE)); library(DT); widget <- DT::datatable(data.frame(group=c('a','b'), value=1:2), options=list(pageLength=2)); widget",
            ),
        )
        .await
        .unwrap();
    assert_eq!(first.status, OperationStatus::Succeeded, "{first:?}");
    let first_output = output(&first);
    let session = first_output.session_id.clone();
    let first_html = media(&first_output, "text/html");
    assert_html_artifact(&host, &first_html).await;

    let second = host
        .invoke(&context, request("dt-repeat", "print(widget); invisible(NULL)"))
        .await
        .unwrap();
    assert_eq!(second.status, OperationStatus::Succeeded, "{second:?}");
    let second_output = output(&second);
    assert_eq!(second_output.session_id, session);
    let second_html = media(&second_output, "text/html");
    assert_html_artifact(&host, &second_html).await;

    let attached = host
        .invoke(
            &context,
            request("dt-attached-package", "library(ggplot2); print(widget); invisible(NULL)"),
        )
        .await
        .unwrap();
    assert_eq!(attached.status, OperationStatus::Succeeded, "{attached:?}");
    let attached_output = output(&attached);
    assert_eq!(attached_output.session_id, session);
    let attached_html = media(&attached_output, "text/html");
    assert_html_artifact(&host, &attached_html).await;

    let reloaded = host
        .invoke(
            &context,
            request(
                "dt-reload",
                "if ('package:DT' %in% search()) detach('package:DT', unload=TRUE); if ('htmlwidgets' %in% loadedNamespaces()) unloadNamespace('htmlwidgets'); library(DT); print(widget); TRUE",
            ),
        )
        .await
        .unwrap();
    assert_eq!(reloaded.status, OperationStatus::Succeeded, "{reloaded:?}");
    let reloaded_output = output(&reloaded);
    assert_eq!(reloaded_output.session_id, session);
    let reloaded_html = media(&reloaded_output, "text/html");
    assert_html_artifact(&host, &reloaded_html).await;

    let plot = host
        .invoke(&context, request("plot-separate", "plot(1:10); invisible(NULL)"))
        .await
        .unwrap();
    assert_eq!(plot.status, OperationStatus::Succeeded, "{plot:?}");
    let plot_output = output(&plot);
    assert_eq!(plot_output.session_id, session);
    assert_eq!(plot_output.output_references.len(), 1, "{plot_output:?}");
    assert_eq!(media(&plot_output, "image/png").mime_type, "image/png");

    let after_failures = host
        .invoke(&context, request("same-session", "1 + 1"))
        .await
        .unwrap();
    assert_eq!(after_failures.status, OperationStatus::Succeeded, "{after_failures:?}");
    let after_output = output(&after_failures);
    assert_eq!(after_output.session_id, session);
    assert!(after_output.value.is_null());
    assert!(after_output.stdout.contains("[1] 2"), "{after_output:?}");
}
