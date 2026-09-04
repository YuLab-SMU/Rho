    use super::*;
    use std::fs;
    use tempfile::TempDir;

    #[tokio::test]
    async fn cancelling_a_queued_workspace_claim_releases_no_shared_capacity() {
        let lane = Arc::new(AgentWorkspaceLane::default());
        let held = lane.gate.lock().await;
        let queued_lane = lane.clone();
        let workspace_operation_started = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let queued_operation_started = workspace_operation_started.clone();
        let queued = tokio::spawn(async move {
            let _guard = queued_lane.gate.lock().await;
            let _execution = queued_lane.begin_execution("turn-queued", "run-queued")?;
            queued_operation_started.store(true, std::sync::atomic::Ordering::SeqCst);
            Ok::<(), anyhow::Error>(())
        });
        tokio::task::yield_now().await;
        assert_eq!(lane.cancel_turn("turn-queued"), None);
        drop(held);
        let error = queued.await.unwrap().unwrap_err();
        assert!(
            error
                .to_string()
                .contains("cancelled before Workspace R admission")
        );
        assert!(!workspace_operation_started.load(std::sync::atomic::Ordering::SeqCst));
        lane.clear_turn_cancellation("turn-queued");
        assert!(lane.gate.try_lock().is_ok());
    }

    #[tokio::test]
    async fn workspace_lane_serializes_two_claims_and_completes_both() {
        use std::sync::atomic::{AtomicUsize, Ordering};

        let lane = Arc::new(AgentWorkspaceLane::default());
        let active = Arc::new(AtomicUsize::new(0));
        let maximum_active = Arc::new(AtomicUsize::new(0));
        let completed = Arc::new(AtomicUsize::new(0));
        let first_acquired = Arc::new(tokio::sync::Notify::new());
        let release_first = Arc::new(tokio::sync::Notify::new());

        let first = {
            let lane = lane.clone();
            let active = active.clone();
            let maximum_active = maximum_active.clone();
            let completed = completed.clone();
            let first_acquired = first_acquired.clone();
            let release_first = release_first.clone();
            tokio::spawn(async move {
                let _guard = lane.gate.lock().await;
                let now = active.fetch_add(1, Ordering::SeqCst) + 1;
                maximum_active.fetch_max(now, Ordering::SeqCst);
                first_acquired.notify_one();
                release_first.notified().await;
                active.fetch_sub(1, Ordering::SeqCst);
                completed.fetch_add(1, Ordering::SeqCst);
            })
        };
        first_acquired.notified().await;

        let second = {
            let lane = lane.clone();
            let active = active.clone();
            let maximum_active = maximum_active.clone();
            let completed = completed.clone();
            tokio::spawn(async move {
                let _guard = lane.gate.lock().await;
                let now = active.fetch_add(1, Ordering::SeqCst) + 1;
                maximum_active.fetch_max(now, Ordering::SeqCst);
                active.fetch_sub(1, Ordering::SeqCst);
                completed.fetch_add(1, Ordering::SeqCst);
            })
        };

        tokio::task::yield_now().await;
        assert_eq!(completed.load(Ordering::SeqCst), 0);
        release_first.notify_one();
        first.await.unwrap();
        second.await.unwrap();
        assert_eq!(completed.load(Ordering::SeqCst), 2);
        assert_eq!(maximum_active.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn workspace_lane_cancellation_returns_only_the_owning_active_run() {
        let lane = AgentWorkspaceLane::default();
        let _gate = lane.gate.lock().await;
        let execution = lane.begin_execution("turn-active", "run-active").unwrap();

        assert_eq!(lane.cancel_turn("turn-other"), None);
        assert_eq!(
            lane.cancel_turn("turn-active").as_deref(),
            Some("run-active")
        );

        drop(execution);
        lane.clear_turn_cancellation("turn-active");
        lane.clear_turn_cancellation("turn-other");
    }

    #[tokio::test]
    async fn agent_persistence_progresses_while_workspace_lane_is_held() {
        let directory = TempDir::new().unwrap();
        let database = directory.path().join("rho.sqlite");
        let mut store = Store::open(&database).unwrap();
        let project_root = "D:/Rho/project";
        store.set_project_root(Some(project_root)).unwrap();
        store
            .create_agent_turn_with_conversation(
                &rho_store::AgentConversationDraft {
                    conversation_id: "conversation-wait".to_string(),
                    project_root: project_root.to_string(),
                    title: "Workspace wait".to_string(),
                    legacy_unthreaded: false,
                },
                &rho_store::AgentTurnDraft {
                    turn_id: "turn-wait".to_string(),
                    project_root: project_root.to_string(),
                    prompt: "inspect workspace".to_string(),
                    model: "test".to_string(),
                    workspace_id: "ws-test".to_string(),
                    state_revision_before: 1,
                    project_revision_before: 1,
                },
            )
            .unwrap();
        let executor = rho_store::StoreExecutor::open(&database).await.unwrap();
        let context = Arc::new(WorkspaceBrokerLane::new(
            BrokerState::new("ws-test"),
            executor.clone(),
        ));
        let _agent_store = executor.agent_repository();
        let workspace_guard = context.lock().await;

        tokio::time::timeout(
            std::time::Duration::from_millis(250),
            async {
                let detail = tokio::time::timeout(
                    std::time::Duration::from_millis(250),
                    executor.agent_repository().get_turn_detail(
                        project_root.to_string(),
                        "turn-wait".to_string(),
                    ),
                )
                .await
                .expect("Agent query waited for the held Workspace lane")
                .unwrap();
                assert!(detail.is_some());
            },
        )
        .await
        .expect("Agent persistence waited for the held Workspace lane");

        drop(workspace_guard);
    }

    #[test]
    fn translates_r_expression_ranges_into_editor_coordinates() {
        let arguments = json!({
            "code": "value <- 1\nstop('😀')",
            "source_path": "R/analysis.R",
            "source_range": {
                "start_line": 20,
                "start_column": 7,
                "end_line": 21,
                "end_column": 11
            }
        });
        let result = json!({
            "ok": false,
            "error": {
                "message": "boom",
                "stage": "evaluation",
                "range_kind": "r_expression",
                "source_range": {
                    "start_line": 2,
                    "start_column": 1,
                    "end_line": 2,
                    "end_column": 10
                }
            }
        });

        assert_eq!(
            translated_run_error_range(&arguments, &result),
            Some(RunErrorRange {
                start_line: 21,
                start_column: 1,
                end_line: 21,
                end_column: 11,
                range_kind: "r_expression".to_string(),
            })
        );

        let first_line_arguments = json!({
            "code": "stop('错误')",
            "source_path": "analysis.R",
            "source_range": {
                "start_line": 4,
                "start_column": 8,
                "end_line": 4,
                "end_column": 18
            }
        });
        let first_line_result = json!({
            "error": {
                "stage": "evaluation",
                "range_kind": "r_expression",
                "source_range": {
                "start_line": 1,
                "start_column": 1,
                "end_line": 1,
                "end_column": 11
            }}
        });
        let range = translated_run_error_range(&first_line_arguments, &first_line_result).unwrap();
        assert_eq!((range.start_line, range.start_column), (4, 8));
        assert_eq!((range.end_line, range.end_column), (4, 18));
    }

    #[test]
    fn translates_validated_parse_tokens_into_utf16_editor_coordinates() {
        let arguments = json!({
            "code": "prefix <- '😀'\nbroken <- c(1， 2)",
            "source_path": "分析.R",
            "source_range": {
                "start_line": 10,
                "start_column": 5,
                "end_line": 11,
                "end_column": 20
            }
        });
        let result = json!({
            "ok": false,
            "error": {
                "message": "<text>:2:14: unexpected input",
                "stage": "parse",
                "range_kind": "r_parse_token",
                "source_range": {
                    "start_line": 2,
                    "start_column": 14,
                    "end_line": 2,
                    "end_column": 15
                }
            }
        });

        assert_eq!(
            translated_run_error_range(&arguments, &result),
            Some(RunErrorRange {
                start_line: 11,
                start_column: 14,
                end_line: 11,
                end_column: 15,
                range_kind: "r_parse_token".to_string(),
            })
        );

        let supplementary_arguments = json!({
            "code": "😀，",
            "source_path": "analysis.R",
            "source_range": {
                "start_line": 4,
                "start_column": 3,
                "end_line": 4,
                "end_column": 6
            }
        });
        let supplementary_result = json!({
            "error": {
                "stage": "parse",
                "range_kind": "r_parse_token",
                "source_range": {
                    "start_line": 1,
                    "start_column": 2,
                    "end_line": 1,
                    "end_column": 3
                }
            }
        });
        assert_eq!(
            translated_run_error_range(&supplementary_arguments, &supplementary_result),
            Some(RunErrorRange {
                start_line: 4,
                start_column: 5,
                end_line: 4,
                end_column: 6,
                range_kind: "r_parse_token".to_string(),
            })
        );
    }

    #[test]
    fn rejects_untrusted_partial_or_out_of_scope_diagnostic_ranges() {
        let valid_result = json!({
            "error": {
                "stage": "evaluation",
                "range_kind": "r_expression",
                "source_range": {
                "start_line": 1,
                "start_column": 1,
                "end_line": 1,
                "end_column": 5
            }}
        });
        for arguments in [
            json!({
                "code": "stop('boom')",
                "source_path": "<console>",
                "source_range": {"start_line": 1, "start_column": 1, "end_line": 1, "end_column": 13}
            }),
            json!({
                "code": "stop('boom')",
                "source_path": "../outside.R",
                "source_range": {"start_line": 1, "start_column": 1, "end_line": 1, "end_column": 13}
            }),
            json!({
                "code": "stop('boom')",
                "source_path": "analysis.R",
                "source_range": {"start_line": 1, "start_column": 1, "end_line": 1}
            }),
            json!({
                "code": "stop('boom')",
                "source_path": "analysis.R",
                "source_range": {"start_line": 1, "start_column": 1, "end_line": 1, "end_column": 3}
            }),
        ] {
            assert!(translated_run_error_range(&arguments, &valid_result).is_none());
        }

        let arguments = json!({
            "code": "stop('boom')",
            "source_path": "analysis.R",
            "source_range": {"start_line": 1, "start_column": 1, "end_line": 1, "end_column": 13}
        });
        assert!(
            translated_run_error_range(
                &arguments,
                &json!({"error": {"source_range": {
                    "start_line": 1,
                    "start_column": 0,
                    "end_line": 1,
                    "end_column": 5
                }, "stage": "evaluation", "range_kind": "r_expression"}}),
            )
            .is_none()
        );
        assert!(
            translated_run_error_range(
                &arguments,
                &json!({"ok": false, "error": {"message": "result unavailable"}}),
            )
            .is_none()
        );
        assert!(translated_run_error_range(&arguments, &json!({"ok": true})).is_none());
        for result in [
            json!({"error": {
                "stage": "parse",
                "range_kind": "r_expression",
                "source_range": {"start_line": 1, "start_column": 1, "end_line": 1, "end_column": 2}
            }}),
            json!({"error": {
                "stage": "evaluation",
                "range_kind": "r_parse_token",
                "source_range": {"start_line": 1, "start_column": 1, "end_line": 1, "end_column": 2}
            }}),
            json!({"error": {
                "stage": "parse",
                "range_kind": "unknown",
                "source_range": {"start_line": 1, "start_column": 1, "end_line": 1, "end_column": 2}
            }}),
            json!({"error": {
                "stage": "parse",
                "source_range": {"start_line": 1, "start_column": 1, "end_line": 1, "end_column": 2}
            }}),
        ] {
            assert!(translated_run_error_range(&arguments, &result).is_none());
        }
    }

    #[test]
    fn reads_bounded_bridge_json() {
        assert_eq!(
            read_bounded_json(br#"{"ok":true,"value":42}"#.as_slice()).unwrap(),
            json!({"ok": true, "value": 42})
        );
    }

    fn write_result_manifest(
        result_file: &ResultFile,
        field: &str,
        value: &Value,
        digest_override: Option<&str>,
    ) {
        let sidecar = serde_json::to_vec(value).unwrap();
        fs::write(result_file.directory.join("field-0001.json"), &sidecar).unwrap();
        let digest = digest_override
            .map(str::to_string)
            .unwrap_or_else(|| sha256_hex(&sidecar));
        fs::write(
            &result_file.path,
            serde_json::to_vec(&json!({
                "rho_result_manifest_version": 2,
                "inline": {"ok": true},
                "sidecars": [{
                    "field": field,
                    "file": "field-0001.json",
                    "bytes": sidecar.len(),
                    "sha256": digest
                }]
            }))
            .unwrap(),
        )
        .unwrap();
    }

    #[test]
    fn imports_verified_workspace_result_sidecars_and_cleans_execution_directory() {
        let directory;
        {
            let result_file = ResultFile::new("runtime-execution:sidecar-normal").unwrap();
            directory = result_file.directory.clone();
            write_result_manifest(
                &result_file,
                "stdout",
                &Value::String("large streamed output".repeat(100)),
                None,
            );
            let decoded = result_file.read_json().unwrap();
            assert_eq!(decoded["ok"], true);
            assert!(
                decoded["stdout"]
                    .as_str()
                    .unwrap()
                    .contains("large streamed output")
            );
        }
        assert!(!directory.exists());
    }

    #[test]
    fn workspace_r_publisher_externalizes_oversized_fields_when_rscript_is_available() {
        let available = std::process::Command::new("Rscript")
            .arg("--version")
            .output();
        if available.is_err() {
            return;
        }
        let result_file = ResultFile::new("runtime-execution:r-publisher-v2").unwrap();
        let script = bridge_result_publisher(
            "list(ok = TRUE, stdout = paste(rep('x', 1100000L), collapse = ''))",
            &result_file,
        )
        .unwrap();
        let script_path = result_file.directory.join("publisher-test.R");
        fs::write(&script_path, script).unwrap();
        let status = std::process::Command::new("Rscript")
            .arg(&script_path)
            .status()
            .unwrap();
        assert!(status.success());
        assert!(result_file.directory.join("field-0002.json").is_file());
        let decoded = result_file.read_json().unwrap();
        assert_eq!(decoded["ok"], true);
        assert_eq!(decoded["stdout"].as_str().unwrap().len(), 1_100_000);
    }

    #[test]
    fn rejects_missing_tampered_and_duplicate_workspace_result_sidecars() {
        let result_file = ResultFile::new("runtime-execution:sidecar-tampered").unwrap();
        write_result_manifest(
            &result_file,
            "stdout",
            &Value::String("private output".to_string()),
            Some(&"0".repeat(64)),
        );
        assert!(
            result_file
                .read_json()
                .unwrap_err()
                .to_string()
                .contains("digest")
        );

        let missing = ResultFile::new("runtime-execution:sidecar-missing").unwrap();
        write_result_manifest(&missing, "stdout", &json!("output"), None);
        fs::remove_file(missing.directory.join("field-0001.json")).unwrap();
        assert!(missing.read_json().is_err());

        let duplicate = ResultFile::new("runtime-execution:sidecar-duplicate").unwrap();
        write_result_manifest(&duplicate, "ok", &json!("collision"), None);
        assert!(
            duplicate
                .read_json()
                .unwrap_err()
                .to_string()
                .contains("both inline and sidecar")
        );
    }

    #[cfg(unix)]
    #[test]
    fn rejects_symlinked_workspace_result_sidecars() {
        use std::os::unix::fs::symlink;
        let result_file = ResultFile::new("runtime-execution:sidecar-symlink").unwrap();
        let external = result_file
            .directory
            .parent()
            .unwrap()
            .join(format!("external-{}.json", Uuid::new_v4().simple()));
        fs::write(&external, b"{\"secret\":true}").unwrap();
        let link = result_file.directory.join("field-0001.json");
        symlink(&external, &link).unwrap();
        fs::write(
            &result_file.path,
            serde_json::to_vec(&json!({
                "rho_result_manifest_version": 2,
                "inline": {},
                "sidecars": [{
                    "field": "stdout",
                    "file": "field-0001.json",
                    "bytes": fs::metadata(&external).unwrap().len(),
                    "sha256": sha256_hex(&fs::read(&external).unwrap())
                }]
            }))
            .unwrap(),
        )
        .unwrap();
        assert!(
            result_file
                .read_json()
                .unwrap_err()
                .to_string()
                .contains("non-symlink")
        );
        fs::remove_file(external).unwrap();
    }

    #[test]
    fn validates_caller_provided_execution_ids() {
        assert!(valid_caller_execution_id(
            "render_15f0f1b2d4d64e1688a5f8725bc23e7a"
        ));
        assert!(!valid_caller_execution_id(""));
        assert!(valid_caller_execution_id("render-with-dashes"));
        assert!(valid_caller_execution_id("runtime-execution:1234.abcd"));
        assert!(!valid_caller_execution_id("render/path"));
        assert!(!valid_caller_execution_id(&"x".repeat(129)));
    }

    #[test]
    fn render_artifact_identity_is_bound_to_the_exact_execution() {
        assert_eq!(
            render_artifact_id("render_15f0f1b2d4d64e1688a5f8725bc23e7a"),
            "artifact_render_15f0f1b2d4d64e1688a5f8725bc23e7a_render"
        );
        assert_ne!(
            render_artifact_id("render_a"),
            render_artifact_id("render_b")
        );
    }

    #[test]
    fn render_output_requires_a_materialized_project_file() {
        let project = tempfile::tempdir().unwrap();
        assert!(!materialized_project_output(
            project.path(),
            "results/missing.rds"
        ));
        fs::create_dir_all(project.path().join("results")).unwrap();
        fs::write(project.path().join("results/output.rds"), b"rds").unwrap();
        assert!(materialized_project_output(
            project.path(),
            "results/output.rds"
        ));
        assert!(!materialized_project_output(
            project.path(),
            "../outside.rds"
        ));
    }

    #[test]
    fn generated_output_delta_discovers_created_and_modified_project_results() {
        let project = tempfile::tempdir().unwrap();
        fs::create_dir_all(project.path().join("results")).unwrap();
        fs::create_dir_all(project.path().join(".rho")).unwrap();
        fs::write(project.path().join("existing.csv"), "a\n1\n").unwrap();
        fs::write(project.path().join("analysis.R"), "summary(x)\n").unwrap();
        fs::write(project.path().join(".rho").join("internal.csv"), "hidden\n").unwrap();
        let before = capture_generated_output_snapshot(project.path());

        fs::write(project.path().join("existing.csv"), "a\n1\n2\n").unwrap();
        fs::write(
            project.path().join("results").join("plot.png"),
            b"png-bytes",
        )
        .unwrap();
        let after = capture_generated_output_snapshot(project.path());
        let deltas = generated_output_deltas(&before, &after);

        assert_eq!(
            deltas
                .iter()
                .map(|delta| (delta.path.as_str(), delta.change_kind))
                .collect::<Vec<_>>(),
            vec![
                ("existing.csv", "modified"),
                ("results/plot.png", "created")
            ]
        );
        assert!(!after.files.contains_key("analysis.R"));
        assert!(!after.files.contains_key(".rho/internal.csv"));
    }

    #[test]
    fn generated_output_snapshots_are_root_isolated_and_delta_bounded() {
        let project_a = tempfile::tempdir().unwrap();
        let project_b = tempfile::tempdir().unwrap();
        let before_a = capture_generated_output_snapshot(project_a.path());
        fs::write(project_a.path().join("result.csv"), "project-a\n").unwrap();
        fs::write(project_b.path().join("result.csv"), "project-b\n").unwrap();
        for index in 0..=MAX_GENERATED_OUTPUT_RECORDS {
            fs::write(
                project_a.path().join(format!("output-{index:03}.json")),
                "{}\n",
            )
            .unwrap();
        }

        let deltas_a = generated_output_deltas(
            &before_a,
            &capture_generated_output_snapshot(project_a.path()),
        );
        let snapshot_b = capture_generated_output_snapshot(project_b.path());
        assert_eq!(deltas_a.len(), MAX_GENERATED_OUTPUT_RECORDS);
        assert!(snapshot_b.files.contains_key("result.csv"));
        assert!(!snapshot_b.files.contains_key("output-000.json"));
    }

    #[test]
    fn generated_output_media_types_cover_analysis_files() {
        assert_eq!(
            infer_output_media_type("results/table.xlsx"),
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        );
        assert_eq!(
            infer_output_media_type("results/object.rds"),
            "application/x-r-data"
        );
        assert_eq!(
            infer_output_media_type("results/data.parquet"),
            "application/vnd.apache.parquet"
        );
        assert_eq!(infer_output_media_type("results/figure.jpeg"), "image/jpeg");
    }

    #[test]
    fn rejects_oversized_bridge_json_before_unbounded_read() {
        let bytes = vec![b' '; MAX_FRAME_BYTES + 1];
        let error = read_bounded_json(bytes.as_slice()).unwrap_err();
        assert!(error.to_string().contains("exceeds"));
    }

    #[test]
    fn reports_workspace_r_errors_before_result_file_errors() {
        let events = vec![CorrelatedKernelEvent {
            parent_id: Some("request-1".to_string()),
            event: KernelEvent::Error {
                traceback: "there is no package called 'jsonlite'".to_string(),
            },
        }];

        let error = ensure_no_kernel_errors(&events).unwrap_err();
        assert!(error.to_string().contains("no package called 'jsonlite'"));
    }

    #[test]
    fn probe_results_without_ok_are_successful() {
        assert!(!workspace_result_failed(&json!({
            "packages": [],
            "total_count": 0
        })));
        assert!(!workspace_result_failed(&json!({ "ok": true })));
        assert!(workspace_result_failed(&json!({
            "ok": false,
            "error": { "message": "inventory unavailable" }
        })));
    }

    #[test]
    fn normalizes_unpadded_png_plot_payloads_before_persistence() {
        for (encoded, expected) in [
            ("iVBORw0KGgo=", "iVBORw0KGgo="),
            ("iVBORw0KGgo", "iVBORw0KGgo="),
            ("iVBORw0KGg", "iVBORw0KGg=="),
        ] {
            let events = vec![CorrelatedKernelEvent {
                parent_id: Some("request-plot".to_string()),
                event: KernelEvent::DisplayData {
                    data: json!({ "image/png": encoded }),
                },
            }];
            let plots = extract_plot_payloads(&events);
            assert_eq!(plots.len(), 1);
            let payload: Value = serde_json::from_str(&plots[0].1).unwrap();
            assert_eq!(payload["image/png"], expected);
        }
    }

    #[test]
    fn deduplicates_identical_plot_payloads_within_one_execution() {
        let events = ["iVBORw0KGgo=", "iVBORw0KGgo"]
            .into_iter()
            .map(|encoded| CorrelatedKernelEvent {
                parent_id: Some("request-plot".to_string()),
                event: KernelEvent::DisplayData {
                    data: json!({ "image/png": encoded }),
                },
            })
            .collect::<Vec<_>>();

        let plots = extract_plot_payloads(&events);

        assert_eq!(plots.len(), 1);
        let payload: Value = serde_json::from_str(&plots[0].1).unwrap();
        assert_eq!(payload["image/png"], "iVBORw0KGgo=");
    }

    #[test]
    fn preserves_distinct_plot_payloads_within_one_execution() {
        let events = ["iVBORw0KGgo=", "iVBORw0KGg=="]
            .into_iter()
            .map(|encoded| CorrelatedKernelEvent {
                parent_id: Some("request-plot".to_string()),
                event: KernelEvent::DisplayData {
                    data: json!({ "image/png": encoded }),
                },
            })
            .collect::<Vec<_>>();

        let plots = extract_plot_payloads(&events);

        assert_eq!(plots.len(), 2);
        let first: Value = serde_json::from_str(&plots[0].1).unwrap();
        let second: Value = serde_json::from_str(&plots[1].1).unwrap();
        assert_eq!(first["image/png"], "iVBORw0KGgo=");
        assert_eq!(second["image/png"], "iVBORw0KGg==");
    }

    #[test]
    fn rejects_malformed_png_plot_payloads() {
        for encoded in ["A", "not=base64", "%%%", "iVBORw0KGgo==", "abc===="] {
            let events = vec![CorrelatedKernelEvent {
                parent_id: Some("request-plot".to_string()),
                event: KernelEvent::DisplayData {
                    data: json!({ "image/png": encoded }),
                },
            }];
            assert!(extract_plot_payloads(&events).is_empty());
        }
    }

    #[test]
    fn redacts_credentials_from_agent_diagnostics() {
        let input = concat!(
            "https://example.test/models/x?alt=sse&KEY=secret-value&mode=1\n",
            "Authorization: Bearer another-secret\n",
            "{\"api_key\":\"json-secret\",\"access_token\": \"spaced-secret\"}"
        );
        let redacted = redact_sensitive_text(input);
        assert!(!redacted.contains("secret-value"));
        assert!(!redacted.contains("another-secret"));
        assert!(!redacted.contains("json-secret"));
        assert!(!redacted.contains("spaced-secret"));
        assert!(redacted.contains("&KEY=[REDACTED]&mode=1"));
    }
