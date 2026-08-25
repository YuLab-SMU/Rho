//! Asynchronous Artifact, Plot and retention persistence boundary.

use crate::{
    ArtifactRecordSummary, PlotArtifactSummary, PlotPayloadPruneResult, ProjectRetentionSummary,
    RunDetail, RuntimeOutputPolicy, Store, StoreExecutor, StoreExecutorError,
    query::required_project_root,
};

#[derive(Clone, Debug)]
pub struct ArtifactRecordProjection {
    pub artifact: ArtifactRecordSummary,
    pub run: Option<RunDetail>,
}

#[derive(Clone, Debug)]
pub struct RunArtifactProjection {
    pub run_id: String,
    pub run: Option<RunDetail>,
    pub artifact: Option<ArtifactRecordSummary>,
}

#[derive(Clone, Debug)]
pub struct ArtifactRetentionProjection {
    pub summary: ProjectRetentionSummary,
    pub runtime_policy: RuntimeOutputPolicy,
}

#[derive(Clone, Debug)]
pub struct ArtifactRepository {
    executor: StoreExecutor,
}

impl StoreExecutor {
    pub fn artifact_repository(&self) -> ArtifactRepository {
        ArtifactRepository {
            executor: self.clone(),
        }
    }
}

impl ArtifactRepository {
    pub async fn list_plots(
        &self,
        project_root: String,
        workspace_id: Option<String>,
        session_only: bool,
        limit: Option<usize>,
    ) -> Result<Vec<PlotArtifactSummary>, StoreExecutorError> {
        let project_root = required_project_root(&project_root)?;
        self.executor
            .call(move |connection| {
                Store::borrowed(connection).list_plot_artifacts(
                    limit,
                    Some(&project_root),
                    workspace_id.as_deref(),
                    session_only,
                )
            })
            .await
    }

    pub async fn get_plot(
        &self,
        project_root: String,
        plot_id: String,
    ) -> Result<Option<PlotArtifactSummary>, StoreExecutorError> {
        let project_root = required_project_root(&project_root)?;
        self.executor
            .call(move |connection| {
                Store::borrowed(connection).get_plot_artifact(&project_root, &plot_id)
            })
            .await
    }

    pub async fn list_records(
        &self,
        project_root: String,
        workspace_id: Option<String>,
        session_only: bool,
        limit: Option<usize>,
    ) -> Result<Vec<ArtifactRecordSummary>, StoreExecutorError> {
        let project_root = required_project_root(&project_root)?;
        self.executor
            .call(move |connection| {
                Store::borrowed(connection).list_artifact_records(
                    limit,
                    &project_root,
                    workspace_id.as_deref(),
                    session_only,
                )
            })
            .await
    }

    pub async fn get_record(
        &self,
        project_root: String,
        artifact_id: String,
    ) -> Result<Option<ArtifactRecordProjection>, StoreExecutorError> {
        let project_root = required_project_root(&project_root)?;
        self.executor
            .call(move |connection| {
                let store = Store::borrowed(connection);
                let Some(artifact) = store.get_artifact_record(&project_root, &artifact_id)? else {
                    return Ok(None);
                };
                let run = artifact
                    .run_id
                    .as_deref()
                    .map(|run_id| store.get_run_detail(&project_root, run_id))
                    .transpose()?
                    .flatten();
                Ok(Some(ArtifactRecordProjection { artifact, run }))
            })
            .await
    }

    pub async fn run_artifacts(
        &self,
        project_root: String,
        run_ids: Vec<String>,
        artifact_kind: String,
    ) -> Result<Vec<RunArtifactProjection>, StoreExecutorError> {
        let project_root = required_project_root(&project_root)?;
        self.executor
            .call(move |connection| {
                let store = Store::borrowed(connection);
                run_ids
                    .into_iter()
                    .map(|run_id| {
                        let run = store.get_run_detail(&project_root, &run_id)?;
                        let artifact = store.get_artifact_record_for_run(
                            &project_root,
                            &run_id,
                            &artifact_kind,
                        )?;
                        Ok(RunArtifactProjection {
                            run_id,
                            run,
                            artifact,
                        })
                    })
                    .collect()
            })
            .await
    }

    pub async fn clear_records(
        &self,
        project_root: String,
        workspace_id: Option<String>,
        session_only: bool,
    ) -> Result<usize, StoreExecutorError> {
        let project_root = required_project_root(&project_root)?;
        self.executor
            .call(move |connection| {
                Store::borrowed(connection).clear_artifact_records(
                    &project_root,
                    workspace_id.as_deref(),
                    session_only,
                )
            })
            .await
    }

    pub async fn clear_plots(
        &self,
        project_root: String,
        workspace_id: Option<String>,
        session_only: bool,
    ) -> Result<usize, StoreExecutorError> {
        let project_root = required_project_root(&project_root)?;
        self.executor
            .call(move |connection| {
                Store::borrowed(connection).clear_plot_artifacts(
                    Some(&project_root),
                    workspace_id.as_deref(),
                    session_only,
                )
            })
            .await
    }

    pub async fn prune_plot_payloads(
        &self,
        project_root: String,
        workspace_id: Option<String>,
        session_only: bool,
    ) -> Result<PlotPayloadPruneResult, StoreExecutorError> {
        let project_root = required_project_root(&project_root)?;
        self.executor
            .call(move |connection| {
                Store::borrowed(connection).prune_plot_artifact_payloads(
                    Some(&project_root),
                    workspace_id.as_deref(),
                    session_only,
                )
            })
            .await
    }

    pub async fn retention(
        &self,
        project_root: String,
        workspace_id: Option<String>,
    ) -> Result<ArtifactRetentionProjection, StoreExecutorError> {
        let project_root = required_project_root(&project_root)?;
        self.executor
            .call(move |connection| {
                let store = Store::borrowed(connection);
                Ok(ArtifactRetentionProjection {
                    summary: store
                        .project_retention_summary(&project_root, workspace_id.as_deref())?,
                    runtime_policy: store.get_runtime_output_policy(&project_root)?,
                })
            })
            .await
    }
}

#[cfg(test)]
mod tests {
    use tempfile::tempdir;

    use super::*;
    use crate::{ArtifactRecordDraft, PlotArtifactDraft, RunDraft, RunFinish};

    fn create_run(store: &mut Store, project_root: &str, run_id: &str, workspace_id: &str) {
        store
            .create_run(&RunDraft {
                run_id: run_id.to_string(),
                parent_run_id: None,
                project_root: project_root.to_string(),
                origin: "user".to_string(),
                request_type: "workspace.render_document".to_string(),
                operation_class: "scientific".to_string(),
                code: "render".to_string(),
                arguments_json: "{}".to_string(),
                source_path: Some("report.qmd".to_string()),
                execution_mode: Some("render".to_string()),
                document_version: Some(1),
                workspace_id: workspace_id.to_string(),
                state_revision_before: 1,
                project_revision_before: 1,
                environment_snapshot_id: None,
            })
            .unwrap();
        store
            .finish_run(&RunFinish {
                run_id: run_id.to_string(),
                status: "completed".to_string(),
                terminal_reason: Some("completed".to_string()),
                workspace_id: Some(workspace_id.to_string()),
                state_revision_after: Some(2),
                project_revision_after: Some(2),
                stdout: None,
                value_text: None,
                messages: Vec::new(),
                warnings: Vec::new(),
                error_message: None,
                error_call: None,
                traceback: Vec::new(),
                environment_snapshot_id_after: None,
            })
            .unwrap();
    }

    fn create_plot(
        store: &mut Store,
        project_root: &str,
        run_id: &str,
        plot_id: &str,
        workspace_id: &str,
        payload: &str,
    ) {
        store
            .create_plot_artifact(&PlotArtifactDraft {
                plot_id: plot_id.to_string(),
                run_id: run_id.to_string(),
                project_root: Some(project_root.to_string()),
                source_path: Some("report.qmd".to_string()),
                execution_mode: Some("render".to_string()),
                document_version: Some(1),
                workspace_id: Some(workspace_id.to_string()),
                state_revision: Some(2),
                project_revision: Some(2),
                media_type: "image/png".to_string(),
                payload_json: payload.to_string(),
                provenance_complete: true,
            })
            .unwrap();
    }

    fn create_record(
        store: &mut Store,
        project_root: &str,
        run_id: &str,
        artifact_id: &str,
        workspace_id: &str,
    ) {
        store
            .create_artifact_record(&ArtifactRecordDraft {
                artifact_id: artifact_id.to_string(),
                artifact_kind: "render_output".to_string(),
                run_id: Some(run_id.to_string()),
                project_root: project_root.to_string(),
                output_path: format!("artifacts/{artifact_id}.html"),
                source_path: Some("report.qmd".to_string()),
                execution_mode: Some("render".to_string()),
                document_version: Some(1),
                workspace_id: Some(workspace_id.to_string()),
                state_revision: Some(2),
                project_revision: Some(2),
                media_type: "text/html".to_string(),
                metadata_json: "{}".to_string(),
                provenance_complete: true,
                incomplete_reason: None,
            })
            .unwrap();
    }

    #[tokio::test]
    async fn repository_preserves_projection_retention_mutation_and_project_isolation() {
        let directory = tempdir().unwrap();
        let database = directory.path().join("rho.sqlite");
        let mut store = Store::open(&database).unwrap();
        create_run(&mut store, "/projects/a", "run-a", "workspace-a");
        create_run(&mut store, "/projects/b", "run-b", "workspace-b");
        let payload_a = format!("{{\"image/png\":\"{}\"}}", "a".repeat(512));
        let payload_b = format!("{{\"image/png\":\"{}\"}}", "b".repeat(512));
        create_plot(
            &mut store,
            "/projects/a",
            "run-a",
            "plot-a",
            "workspace-a",
            &payload_a,
        );
        create_plot(
            &mut store,
            "/projects/b",
            "run-b",
            "plot-b",
            "workspace-b",
            &payload_b,
        );
        create_record(
            &mut store,
            "/projects/a",
            "run-a",
            "artifact-a",
            "workspace-a",
        );
        create_record(
            &mut store,
            "/projects/b",
            "run-b",
            "artifact-b",
            "workspace-b",
        );
        drop(store);

        let repository = StoreExecutor::open(&database)
            .await
            .unwrap()
            .artifact_repository();
        assert!(
            repository
                .list_plots(" ".to_string(), None, false, None)
                .await
                .is_err()
        );
        let plots = repository
            .list_plots(
                "/projects/a/".to_string(),
                Some("workspace-a".to_string()),
                true,
                Some(1),
            )
            .await
            .unwrap();
        assert_eq!(plots.len(), 1);
        assert_eq!(plots[0].plot_id, "plot-a");
        assert!(
            repository
                .get_plot("/projects/b".to_string(), "plot-a".to_string())
                .await
                .unwrap()
                .is_none()
        );

        let record = repository
            .get_record("/projects/a".to_string(), "artifact-a".to_string())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(record.run.unwrap().run_id, "run-a");
        let recovered = repository
            .run_artifacts(
                "/projects/a".to_string(),
                vec!["run-a".to_string()],
                "render_output".to_string(),
            )
            .await
            .unwrap();
        assert_eq!(
            recovered[0].artifact.as_ref().unwrap().artifact_id,
            "artifact-a"
        );

        let retention = repository
            .retention("/projects/a".to_string(), Some("workspace-a".to_string()))
            .await
            .unwrap();
        assert_eq!(retention.summary.session.plot_history_count, 1);
        assert_eq!(retention.summary.session.artifact_record_count, 1);
        assert_eq!(retention.runtime_policy.project_root, "/projects/a");

        let pruned = repository
            .prune_plot_payloads(
                "/projects/a".to_string(),
                Some("workspace-a".to_string()),
                true,
            )
            .await
            .unwrap();
        assert_eq!(pruned.pruned_count, 1);
        assert_ne!(
            repository
                .get_plot("/projects/a".to_string(), "plot-a".to_string())
                .await
                .unwrap()
                .unwrap()
                .payload_json,
            payload_a
        );
        assert_eq!(
            repository
                .get_plot("/projects/b".to_string(), "plot-b".to_string())
                .await
                .unwrap()
                .unwrap()
                .payload_json,
            payload_b
        );

        assert_eq!(
            repository
                .clear_records(
                    "/projects/a".to_string(),
                    Some("workspace-a".to_string()),
                    true,
                )
                .await
                .unwrap(),
            1
        );
        assert!(
            repository
                .list_records("/projects/a".to_string(), None, false, None)
                .await
                .unwrap()
                .is_empty()
        );
        assert_eq!(
            repository
                .list_records("/projects/b".to_string(), None, false, None)
                .await
                .unwrap()
                .len(),
            1
        );
        assert_eq!(
            repository
                .clear_plots(
                    "/projects/a".to_string(),
                    Some("workspace-a".to_string()),
                    true,
                )
                .await
                .unwrap(),
            1
        );
        assert!(
            repository
                .get_plot("/projects/b".to_string(), "plot-b".to_string())
                .await
                .unwrap()
                .is_some()
        );
    }
}
