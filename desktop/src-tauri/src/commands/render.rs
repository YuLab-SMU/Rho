use anyhow::Context;
use rho_core::ExecutionOrigin;
use rho_server::workspace_lane::WorkspaceBrokerState;
use rho_store::{ArtifactRecordSummary, normalize_project_root};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tauri::State;
use uuid::Uuid;

use crate::application_state::{active_context, active_session, store_executor};
use crate::project::project_path;
use crate::{
    AppState, dispatch_workspace_request, dispatch_workspace_request_with_execution_id,
    display_error,
};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct RenderJobState {
    pub(crate) job_id: String,
    pub(crate) project_root: String,
    pub(crate) path: String,
    pub(crate) document_version: Option<i64>,
    pub(crate) status: String,
    pub(crate) artifact_id: Option<String>,
    pub(crate) output_path: Option<String>,
    pub(crate) tool: Option<String>,
    pub(crate) media_type: Option<String>,
    pub(crate) provenance_complete: Option<bool>,
    pub(crate) message: Option<String>,
    pub(crate) terminal_reason: Option<String>,
    pub(crate) submitted_at: String,
    pub(crate) completed_at: Option<String>,
}

pub(crate) fn attach_render_artifact(job: &mut RenderJobState, artifact: &ArtifactRecordSummary) {
    job.artifact_id = Some(artifact.artifact_id.clone());
    job.output_path = Some(artifact.output_path.clone());
    job.media_type = Some(artifact.media_type.clone());
    job.provenance_complete = Some(artifact.provenance_complete);
}

pub(crate) fn render_job_is_terminal(status: &str) -> bool {
    matches!(status, "completed" | "failed" | "interrupted")
}

pub(crate) fn finish_render_job(
    job: &mut RenderJobState,
    status: &str,
    message: Option<String>,
    terminal_reason: Option<&str>,
) {
    if render_job_is_terminal(&job.status) {
        return;
    }
    job.status = status.to_string();
    job.message = message;
    job.terminal_reason = terminal_reason.map(str::to_string);
    job.completed_at = Some(chrono::Utc::now().to_rfc3339());
}

pub(crate) fn reconcile_render_job(
    job: &mut RenderJobState,
    run_status: Option<&str>,
    run_message: Option<String>,
    terminal_reason: Option<&str>,
) {
    if render_job_is_terminal(&job.status) {
        return;
    }
    match run_status {
        Some("completed") => finish_render_job(job, "completed", None, Some("completed")),
        Some("failed") => finish_render_job(job, "failed", run_message, terminal_reason),
        Some("interrupted") => finish_render_job(
            job,
            "interrupted",
            Some("Render interrupted while Workspace R restarted.".to_string()),
            terminal_reason,
        ),
        _ => finish_render_job(
            job,
            "interrupted",
            Some("Render stopped before Workspace R restarted.".to_string()),
            Some("workspace_restart_before_start"),
        ),
    }
}

#[derive(Deserialize)]
pub(crate) struct RenderRequest {
    path: String,
    format: Option<String>,
    document_version: Option<i64>,
}

#[tauri::command]
pub(crate) async fn render_document(
    request: RenderRequest,
    state: State<'_, AppState>,
) -> Result<Value, String> {
    let root = state.project_root.read().await.clone();
    let source_path = request.path.clone();
    let file = project_path(&root, &source_path).map_err(display_error)?;
    let extension = file
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    if !matches!(extension.as_str(), "rmd" | "qmd") {
        return Err("Render only supports project .Rmd and .qmd files".to_string());
    }
    if !file.is_file() {
        return Err(format!("Render source does not exist: {source_path}"));
    }
    let session = active_session(&state).await.map_err(display_error)?;
    let context = active_context(&state).await.map_err(display_error)?;
    let mut context = context.lock().await;
    let WorkspaceBrokerState { broker, executor } = &mut *context;
    let payload = json!({
        "arguments": {
            "path": file.to_string_lossy(),
            "format": request.format,
            "source_path": source_path,
            "execution_mode": "render",
            "document_version": request.document_version
        },
        "expected_workspace": broker.identity()
    });
    dispatch_workspace_request(
        "workspace.render_document",
        &payload,
        ExecutionOrigin::User,
        session.as_ref(),
        broker,
        executor,
    )
    .await
    .map_err(display_error)
}

#[tauri::command]
pub(crate) async fn render_document_job(
    path: String,
    document_version: Option<i64>,
    state: State<'_, AppState>,
) -> Result<Value, String> {
    let root = state.project_root.read().await.clone();
    let project_root = normalize_project_root(root.to_string_lossy().as_ref());
    let file = project_path(&root, &path).map_err(display_error)?;
    let extension = file
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    if !matches!(extension.as_str(), "rmd" | "qmd") {
        return Err("Render only supports project .Rmd and .qmd files".to_string());
    }
    if !file.is_file() {
        return Err(format!("Render source does not exist: {path}"));
    }

    let job_id = format!("render_{}", Uuid::new_v4().simple());
    let job_id_return = job_id.clone();
    let job_project_root = project_root.clone();
    let render_jobs = state.render_jobs.clone();
    let render_tasks = state.render_tasks.clone();
    {
        let mut jobs = render_jobs.lock().await;
        jobs.insert(
            job_id.clone(),
            RenderJobState {
                job_id: job_id.clone(),
                project_root,
                path: path.clone(),
                document_version,
                status: "submitted".to_string(),
                artifact_id: None,
                output_path: None,
                tool: None,
                media_type: None,
                provenance_complete: None,
                message: None,
                terminal_reason: None,
                submitted_at: chrono::Utc::now().to_rfc3339(),
                completed_at: None,
            },
        );
    }
    let session_arc = state.session.read().await.clone();
    let context_arc = state.context.lock().await.clone();
    let file_path = file.to_string_lossy().to_string();
    let task_job_id = job_id.clone();
    let task = tauri::async_runtime::spawn(async move {
        tokio::task::yield_now().await;
        let session = match session_arc {
            Some(s) => s,
            None => {
                eprintln!("render_document_job [{job_id}]: no active session");
                let mut jobs = render_jobs.lock().await;
                if let Some(job) = jobs.get_mut(&job_id) {
                    finish_render_job(
                        job,
                        "failed",
                        Some("No active Workspace R session".to_string()),
                        Some("workspace_unavailable"),
                    );
                }
                drop(jobs);
                render_tasks.lock().await.remove(&job_id);
                return;
            }
        };
        let context = match context_arc {
            Some(c) => c,
            None => {
                eprintln!("render_document_job [{job_id}]: no active context");
                let mut jobs = render_jobs.lock().await;
                if let Some(job) = jobs.get_mut(&job_id) {
                    finish_render_job(
                        job,
                        "failed",
                        Some("No active coordinator context".to_string()),
                        Some("coordinator_unavailable"),
                    );
                }
                drop(jobs);
                render_tasks.lock().await.remove(&job_id);
                return;
            }
        };
        let mut context = context.lock().await;
        let cancelled_before_start = {
            let mut jobs = render_jobs.lock().await;
            match jobs.get_mut(&job_id) {
                None => true,
                Some(job) if job.status == "cancel_requested" => {
                    finish_render_job(
                        job,
                        "interrupted",
                        Some("Render cancelled before it started.".to_string()),
                        Some("user_cancel_before_start"),
                    );
                    true
                }
                Some(job) => {
                    job.status = "running".to_string();
                    false
                }
            }
        };
        if cancelled_before_start {
            render_tasks.lock().await.remove(&job_id);
            return;
        }
        let WorkspaceBrokerState { broker, executor } = &mut *context;
        let payload = serde_json::json!({
            "arguments": {
                "path": file_path,
                "source_path": path,
                "execution_mode": "render",
                "document_version": document_version,
            },
            "expected_workspace": broker.identity()
        });
        let outcome = dispatch_workspace_request_with_execution_id(
            "workspace.render_document",
            &payload,
            ExecutionOrigin::User,
            session.as_ref(),
            broker,
            executor,
            Some(&job_id),
        )
        .await;
        let artifact_id = outcome
            .as_ref()
            .ok()
            .filter(|response| response["execution"]["ok"].as_bool().unwrap_or(false))
            .and_then(|response| response["artifact_id"].as_str())
            .map(str::to_string);
        let artifact = match artifact_id {
            Some(artifact_id) => executor
                .artifact_repository()
                .get_record(job_project_root.clone(), artifact_id)
                .await
                .ok()
                .flatten()
                .map(|projection| projection.artifact),
            None => None,
        };
        let mut jobs = render_jobs.lock().await;
        if let Some(job) = jobs.get_mut(&job_id) {
            match outcome {
                Ok(response) if response["execution"]["ok"].as_bool().unwrap_or(false) => {
                    job.artifact_id = response["artifact_id"].as_str().map(str::to_string);
                    job.output_path = response["execution"]["output_path"]
                        .as_str()
                        .map(str::to_string);
                    job.tool = response["execution"]["tool"].as_str().map(str::to_string);
                    job.media_type = response["artifact_media_type"].as_str().map(str::to_string);
                    if let Some(artifact) = artifact.as_ref() {
                        attach_render_artifact(job, artifact);
                    }
                    finish_render_job(job, "completed", None, Some("completed"));
                }
                Ok(response) => {
                    let message = response["execution"]["error"]["message"]
                        .as_str()
                        .unwrap_or("Render failed")
                        .to_string();
                    finish_render_job(job, "failed", Some(message), Some("r_error"));
                }
                Err(_error) if job.status == "cancel_requested" => {
                    finish_render_job(
                        job,
                        "interrupted",
                        Some("Render cancelled.".to_string()),
                        Some("user_interrupt"),
                    );
                }
                Err(error) => {
                    eprintln!("render_document_job [{job_id}]: dispatch failed: {error:#}");
                    finish_render_job(
                        job,
                        "failed",
                        Some(format!("{error:#}")),
                        Some("execution_error"),
                    );
                }
            }
        }
        render_tasks.lock().await.remove(&job_id);
    });
    state.render_tasks.lock().await.insert(task_job_id, task);
    Ok(serde_json::json!({ "job_id": job_id_return, "status": "submitted" }))
}

#[tauri::command]
pub(crate) async fn render_job_status(
    job_id: Option<String>,
    state: State<'_, AppState>,
) -> Result<Value, String> {
    let root = state.project_root.read().await.clone();
    let project_root = normalize_project_root(root.to_string_lossy().as_ref());
    let mut jobs = state.render_jobs.lock().await;
    let cutoff = chrono::Utc::now() - chrono::Duration::minutes(5);
    jobs.retain(|_, job| {
        !render_job_is_terminal(&job.status)
            || job.completed_at.as_ref().is_none_or(|at| {
                chrono::DateTime::parse_from_rfc3339(at)
                    .map(|value| value.with_timezone(&chrono::Utc) >= cutoff)
                    .unwrap_or(true)
            })
    });
    if let Some(id) = job_id {
        let job_project_root = jobs
            .get(&id)
            .filter(|job| job.project_root == project_root)
            .map(|job| job.project_root.clone())
            .context("Render job not found")
            .map_err(display_error)?;
        drop(jobs);
        let durable = match store_executor(&state).await {
            Ok(executor) => executor
                .artifact_repository()
                .run_artifacts(
                    job_project_root,
                    vec![id.clone()],
                    "render_output".to_string(),
                )
                .await
                .ok()
                .and_then(|mut projections| projections.pop()),
            Err(_) => None,
        };
        if let Some(durable) = durable {
            let mut jobs = state.render_jobs.lock().await;
            if let Some(job) = jobs.get_mut(&id) {
                if let Some(artifact) = durable.artifact.as_ref() {
                    attach_render_artifact(job, artifact);
                }
                if let Some(run) = durable.run.as_ref() {
                    reconcile_render_job(
                        job,
                        Some(run.status.as_str()),
                        run.error_message.clone(),
                        run.terminal_reason.as_deref(),
                    );
                }
            }
        }
        let jobs = state.render_jobs.lock().await;
        let job = jobs
            .get(&id)
            .filter(|job| job.project_root == project_root)
            .context("Render job not found")
            .map_err(display_error)?;
        Ok(serde_json::json!(job))
    } else {
        let list: Vec<&RenderJobState> = jobs
            .values()
            .filter(|job| job.project_root == project_root)
            .collect();
        Ok(serde_json::json!(list))
    }
}

#[tauri::command]
pub(crate) async fn cancel_render_job(
    job_id: String,
    state: State<'_, AppState>,
) -> Result<Value, String> {
    let root = state.project_root.read().await.clone();
    let project_root = normalize_project_root(root.to_string_lossy().as_ref());
    let should_interrupt = {
        let mut jobs = state.render_jobs.lock().await;
        let job = jobs
            .get_mut(&job_id)
            .filter(|job| job.project_root == project_root)
            .context("Render job not found")
            .map_err(display_error)?;
        match job.status.as_str() {
            "submitted" => {
                job.status = "cancel_requested".to_string();
                false
            }
            "running" => {
                job.status = "cancel_requested".to_string();
                true
            }
            "cancel_requested" | "interrupted" => false,
            "completed" | "failed" => {
                return Err(format!("Render job is already {}", job.status));
            }
            _ => return Err(format!("Render job has invalid status: {}", job.status)),
        }
    };
    if should_interrupt {
        let marked = store_executor(&state)
            .await
            .map_err(display_error)?
            .run_repository()
            .request_cancel(project_root, job_id.clone())
            .await
            .map_err(display_error)?;
        let session = active_session(&state).await.map_err(display_error)?;
        session.interrupt().await.map_err(display_error)?;
        return Ok(json!({
            "job_id": job_id,
            "status": "cancel_requested",
            "run_marked": marked
        }));
    }
    Ok(json!({
        "job_id": job_id,
        "status": "cancel_requested"
    }))
}
