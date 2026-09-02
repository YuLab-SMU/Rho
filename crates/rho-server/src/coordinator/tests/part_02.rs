    #[test]
    fn contextual_prompt_does_not_attach_console_or_run_content_implicitly() {
        let private_runtime_marker = "PRIVATE-CONSOLE-TRANSCRIPT-DO-NOT-ATTACH";
        let prompt = contextual_agent_prompt("Explain the selected function", &[], None, None, &[]);
        assert!(!prompt.contains(private_runtime_marker));
        assert!(!prompt.contains("RuntimeOutputEvent"));
        assert!(prompt.contains("\"status\": \"not_available\""));
    }

    fn agent_context_test_profile() -> AgentRuntimeModelProfile {
        AgentRuntimeModelProfile {
            settings_revision: 9,
            route_capability: "agent.chat".to_string(),
            profile_id: "model.test".to_string(),
            provider_kind: "registered".to_string(),
            runtime_provider_id: "provider.test".to_string(),
            registered_provider_id: Some("test".to_string()),
            model_id: "test".to_string(),
            api_key_env: None,
            api_key_required: false,
            base_url: None,
            base_url_env: None,
            wire_api: None,
            disable_stream_options: false,
            tool_calling: "yes".to_string(),
            provider_display_name: "Test".to_string(),
            model_display_name: "Test".to_string(),
            context_window_tokens: 32_768,
            reserved_output_tokens: 4_096,
            context_capacity_source: "conservative_default".to_string(),
            capability_routes: vec![],
            plugin_tools: vec![],
        }
    }

    #[test]
    fn explicit_runtime_context_is_redacted_receipted_and_digest_bound() {
        let raw = "result=42\nhttps://runtime.test/result?key=runtime-secret&view=full\nAuthorization: Bearer second-secret";
        let explicit = AgentExplicitContextItem {
            source_kind: "runtime_output".to_string(),
            source_id: "runtime-execution:test:4-9".to_string(),
            source_revision: "sequence:9".to_string(),
            source_sha256: "a".repeat(64),
            trust_class: "explicit_project_data".to_string(),
            original_bytes: raw.len() as i64,
            content: redact_agent_context_text(raw),
        };
        let profile = agent_context_test_profile();
        let plan = plan_agent_context(
            "Explain this result",
            &[],
            None,
            None,
            &[],
            Some(&explicit),
            &profile,
            "turn.explicit",
            "conversation.test",
        )
        .unwrap();

        assert!(!plan.model_prompt.contains("runtime-secret"));
        assert!(!plan.model_prompt.contains("second-secret"));
        assert!(plan.model_prompt.contains("[REDACTED]"));
        let receipt = plan
            .receipts
            .iter()
            .find(|item| item.source_kind == "runtime_output")
            .expect("runtime output receipt");
        assert_eq!(
            receipt.source_id.as_deref(),
            Some("runtime-execution:test:4-9")
        );
        assert_eq!(receipt.source_revision.as_deref(), Some("sequence:9"));
        assert_eq!(receipt.source_sha256, "a".repeat(64));
        assert_eq!(receipt.trust_class, "explicit_project_data");

        let mut changed = explicit.clone();
        changed.content.push_str("\nnew committed projection");
        changed.source_sha256 = "b".repeat(64);
        let changed_plan = plan_agent_context(
            "Explain this result",
            &[],
            None,
            None,
            &[],
            Some(&changed),
            &profile,
            "turn.explicit",
            "conversation.test",
        )
        .unwrap();
        assert_ne!(plan.digest, changed_plan.digest);
    }

    #[test]
    fn context_planner_rejects_oversized_current_request_and_receipts_match_dispatch() {
        let profile = agent_context_test_profile();
        let prompt = "CURRENT REQUEST MUST STAY EXACT";
        let plan = plan_agent_context(
            prompt,
            &[],
            None,
            None,
            &[],
            None,
            &profile,
            "turn.test",
            "conversation.test",
        )
        .unwrap();
        assert!(plan.model_prompt.ends_with(prompt));
        assert_eq!(
            plan.receipts[0].source_sha256,
            sha256_hex(prompt.as_bytes())
        );
        assert_eq!(plan.receipts[0].included_bytes, prompt.len() as i64);
        assert!(
            plan.receipts
                .iter()
                .all(|item| item.source_kind != "runtime_output")
        );

        let oversized = "x".repeat(25_000);
        let error = plan_agent_context(
            &oversized,
            &[],
            None,
            None,
            &[],
            None,
            &profile,
            "turn.large",
            "conversation.test",
        )
        .unwrap_err()
        .to_string();
        assert!(error.contains("will not truncate it"));
    }

    #[test]
    fn discovers_project_skill_manifest_from_active_root() {
        let project_root = std::env::temp_dir()
            .join("rho")
            .join("project-skills")
            .join(Uuid::new_v4().to_string());
        let skills_dir = project_root.join(".rho").join("skills");
        fs::create_dir_all(&skills_dir).unwrap();
        fs::write(
            skills_dir.join("manifest.json"),
            serde_json::to_string_pretty(&json!({
                "schema_version": 1,
                "skills": [{
                    "id": "qc-notes",
                    "title": "QC notes",
                    "description": "Bounded project QC notes.",
                    "instructions_path": "qc-notes.md",
                    "references": ["thresholds.json"]
                }]
            }))
            .unwrap(),
        )
        .unwrap();
        fs::write(
            skills_dir.join("qc-notes.md"),
            "# QC\nUse the project thresholds.\n",
        )
        .unwrap();
        fs::write(
            skills_dir.join("thresholds.json"),
            "{\"detected_min\":200,\"mitochondrial_percent_max\":20}\n",
        )
        .unwrap();

        let discovery = discover_project_skills(&normalized_path(&project_root));

        assert!(discovery.discovery_error.is_none());
        assert_eq!(discovery.skills.len(), 1);
        assert_eq!(discovery.skills[0].id, "qc-notes");
        assert_eq!(discovery.skills[0].trust_status, PROJECT_SKILL_TRUST_STATUS);
        assert_eq!(discovery.skills[0].references.len(), 1);

        fs::remove_dir_all(project_root).ok();
    }

    #[test]
    fn rejects_project_skill_paths_that_escape_skill_root() {
        let project_root = std::env::temp_dir()
            .join("rho")
            .join("project-skills")
            .join(Uuid::new_v4().to_string());
        let skills_dir = project_root.join(".rho").join("skills");
        fs::create_dir_all(&skills_dir).unwrap();
        fs::write(
            skills_dir.join("manifest.json"),
            serde_json::to_string_pretty(&json!({
                "schema_version": 1,
                "skills": [{
                    "id": "qc-notes",
                    "title": "QC notes",
                    "instructions_path": "../outside.md"
                }]
            }))
            .unwrap(),
        )
        .unwrap();
        fs::write(
            project_root.join(".rho").join("outside.md"),
            "should not load",
        )
        .unwrap();

        let discovery = discover_project_skills(&normalized_path(&project_root));

        assert!(discovery.skills.is_empty());
        assert!(
            discovery
                .discovery_error
                .as_deref()
                .unwrap_or_default()
                .contains("must stay within .rho/skills")
        );

        fs::remove_dir_all(project_root).ok();
    }

    #[test]
    fn rejects_project_skill_symlink_paths() {
        let error = ensure_not_project_skill_symlink(Path::new("D:/Rho/.rho/skills/link.md"), true)
            .unwrap_err();
        assert!(error.to_string().contains("uses a symlink"));
    }

    #[test]
    fn rejects_invalid_project_skill_manifest_json() {
        let project_root = std::env::temp_dir()
            .join("rho")
            .join("project-skills")
            .join(Uuid::new_v4().to_string());
        let skills_dir = project_root.join(".rho").join("skills");
        fs::create_dir_all(&skills_dir).unwrap();
        fs::write(skills_dir.join("manifest.json"), "{ not valid json ").unwrap();

        let discovery = discover_project_skills(&normalized_path(&project_root));

        assert!(discovery.skills.is_empty());
        assert!(
            discovery
                .discovery_error
                .as_deref()
                .unwrap_or_default()
                .contains("not valid JSON")
        );

        fs::remove_dir_all(project_root).ok();
    }

    #[test]
    fn rejects_oversized_project_skill_manifest() {
        let project_root = std::env::temp_dir()
            .join("rho")
            .join("project-skills")
            .join(Uuid::new_v4().to_string());
        let skills_dir = project_root.join(".rho").join("skills");
        fs::create_dir_all(&skills_dir).unwrap();
        fs::write(
            skills_dir.join("manifest.json"),
            "x".repeat(MAX_PROJECT_SKILL_MANIFEST_BYTES as usize + 1),
        )
        .unwrap();

        let discovery = discover_project_skills(&normalized_path(&project_root));

        assert!(discovery.skills.is_empty());
        assert!(
            discovery
                .discovery_error
                .as_deref()
                .unwrap_or_default()
                .contains("manifest is too large")
        );

        fs::remove_dir_all(project_root).ok();
    }



    #[test]
    fn coordinator_probe_script_uses_a_flushed_utf8_r_file_instead_of_inline_e() {
        let script_file = write_coordinator_probe_script().unwrap();
        let script_path = script_file.path();
        let args = coordinator_probe_args(
            script_path,
            4321,
            Path::new("r/rho.agent"),
            "mock",
            "probe prompt",
        );

        assert_eq!(
            script_path.extension().and_then(|value| value.to_str()),
            Some("R")
        );
        assert_eq!(
            std::fs::read_to_string(script_path).unwrap(),
            coordinator_probe_script()
        );
        assert_eq!(
            args,
            vec![
                script_path.as_os_str().to_os_string(),
                OsString::from("4321"),
                Path::new("r/rho.agent").as_os_str().to_os_string(),
                OsString::from("mock"),
                OsString::from("probe prompt"),
            ]
        );
        assert!(!args.iter().any(|arg| arg == "-e"));
        assert!(
            !args
                .iter()
                .any(|arg| arg.to_string_lossy().contains("rho_agent_connect"))
        );
    }

    fn coordinator_probe_fixture_child(fixture: &str) -> tokio::process::Child {
        tokio::process::Command::new(std::env::current_exe().unwrap())
            .arg("--ignored")
            .arg("--nocapture")
            .arg(fixture)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true)
            .spawn()
            .unwrap()
    }

    #[test]
    #[ignore = "child-process fixture for coordinator probe diagnostics"]
    fn coordinator_probe_exit_child_fixture() {
        println!("probe fixture stdout ?token=fixture-secret");
        println!("{}", "x".repeat(PROBE_CHILD_DIAGNOSTIC_BYTES + 128));
        eprintln!("probe fixture stderr");
    }

    #[test]
    #[ignore = "child-process fixture for coordinator probe diagnostics"]
    fn coordinator_probe_timeout_child_fixture() {
        println!("probe timeout stdout ?token=fixture-secret");
        eprintln!("probe timeout stderr");
        std::io::Write::flush(&mut std::io::stdout()).unwrap();
        std::io::Write::flush(&mut std::io::stderr()).unwrap();
        std::thread::sleep(std::time::Duration::from_secs(5));
    }

    #[tokio::test]
    async fn coordinator_probe_reports_bounded_output_when_child_exits_before_authentication() {
        let mut child = coordinator_probe_fixture_child("coordinator_probe_exit_child_fixture");
        let output = ProbeChildOutput::capture(&mut child).unwrap();
        let error = await_probe_authentication(
            std::future::pending::<std::result::Result<(), &'static str>>(),
            &mut child,
            output,
            std::time::Duration::from_secs(5),
        )
        .await
        .unwrap_err()
        .to_string();

        assert!(error.contains("exited before authentication"));
        assert!(error.contains("probe fixture stdout ?token=[REDACTED]"));
        assert!(error.contains("probe fixture stderr"));
        assert!(error.contains("... [truncated]"));
        assert!(error.len() < PROBE_CHILD_DIAGNOSTIC_BYTES * 2 + 1_000);
        assert!(!error.contains("fixture-secret"));
    }

    #[tokio::test]
    async fn coordinator_probe_timeout_terminates_child_and_reports_bounded_output() {
        let mut child =
            coordinator_probe_fixture_child("coordinator_probe_timeout_child_fixture");
        let output = ProbeChildOutput::capture(&mut child).unwrap();
        let error = await_probe_authentication(
            std::future::pending::<std::result::Result<(), &'static str>>(),
            &mut child,
            output,
            std::time::Duration::from_millis(100),
        )
        .await
        .unwrap_err()
        .to_string();

        assert!(error.contains("timed out waiting for Agent R coordinator probe authentication"));
        assert!(error.contains("probe timeout stdout ?token=[REDACTED]"));
        assert!(error.contains("probe timeout stderr"));
        assert!(!error.contains("fixture-secret"));
    }









    #[test]
    fn bridge_expression_supports_wp2_object_inspection() {
        let (class, expression) = bridge_expression(
            "workspace.inspect_data_object",
            &json!({"object_name": "sce"}),
        )
        .unwrap();

        assert!(matches!(class, OperationClass::Probe));
        assert!(expression.contains("rho_inspect_data_object"));
        assert!(expression.contains("\"sce\""));
    }

    #[test]
    fn bridge_expression_bounds_lockfile_inventory_and_requires_project_root() {
        let (class, low) = bridge_expression(
            "workspace.list_lockfile_packages",
            &json!({"project_root": "C:/projects/quoted \"root\"", "limit": 0}),
        )
        .unwrap();
        let (_, high) = bridge_expression(
            "workspace.list_lockfile_packages",
            &json!({"project_root": "C:/projects/b", "limit": 900}),
        )
        .unwrap();

        assert!(matches!(class, OperationClass::Probe));
        assert!(low.contains("rho_list_lockfile_packages"));
        assert!(low.contains("C:/projects/quoted \\\"root\\\""));
        assert!(low.contains("limit = 1L"));
        assert!(high.contains("limit = 500L"));
        assert!(
            bridge_expression("workspace.list_lockfile_packages", &json!({"limit": 50}),).is_err()
        );
    }

    #[test]
    fn package_names_are_bounded_and_legacy_environment_bridge_calls_are_absent() {
        assert!(validate_environment_package_name("SummarizedExperiment").is_ok());
        for invalid in ["", "bad-name", "pkg@1.0", "../pkg", "\u{5305}"] {
            assert!(validate_environment_package_name(invalid).is_err());
        }
        for request_type in [
            "environment.initialize",
            "environment.restore",
            "environment.snapshot",
            "environment.package_install",
            "environment.package_update",
            "environment.package_remove",
        ] {
            assert!(bridge_expression(request_type, &json!({})).is_err());
        }
    }

    #[test]
    fn local_help_lookup_is_bounded_escaped_and_read_only() {
        let (class, expression) = bridge_expression(
            "workspace.function_help",
            &json!({"name": "mean\"quoted", "package": "base"}),
        )
        .unwrap();
        assert!(matches!(class, OperationClass::Probe));
        assert!(expression.contains("rho_function_help(\"mean\\\"quoted\", package = \"base\")"));

        for arguments in [
            json!({"name": ""}),
            json!({"name": "x".repeat(129)}),
            json!({"name": "mean", "package": "bad-package"}),
            json!({"name": "bad\nname"}),
        ] {
            assert!(bridge_expression("workspace.function_help", &arguments).is_err());
        }
    }

    #[test]
    fn installed_documentation_lookup_is_qualified_escaped_and_read_only() {
        let (class, expression) = bridge_expression(
            "workspace.function_documentation",
            &json!({"name": "mean\"quoted", "package": "base"}),
        )
        .unwrap();
        assert!(matches!(class, OperationClass::Probe));
        assert!(
            expression
                .contains("rho_function_documentation(\"mean\\\"quoted\", package = \"base\")")
        );

        for arguments in [
            json!({"name": "", "package": "base"}),
            json!({"name": "x".repeat(129), "package": "base"}),
            json!({"name": "mean", "package": ""}),
            json!({"name": "mean", "package": "bad-package"}),
            json!({"name": "bad\nname", "package": "base"}),
        ] {
            assert!(bridge_expression("workspace.function_documentation", &arguments).is_err());
        }
    }

    #[test]
    fn lint_lookup_is_project_relative_version_bound_and_read_only() {
        let (class, expression) = bridge_expression(
            "workspace.lint_file",
            &json!({"path": "R/analysis quoted.R", "document_version": 7}),
        )
        .unwrap();
        assert!(matches!(class, OperationClass::Probe));
        assert!(
            expression.contains("rho_lint_file(\"R/analysis quoted.R\", document_version = 7)")
        );

        for arguments in [
            json!({"path": "", "document_version": 1}),
            json!({"path": "../analysis.R", "document_version": 1}),
            json!({"path": "C:/analysis.R", "document_version": 1}),
            json!({"path": "analysis.txt", "document_version": 1}),
            json!({"path": "analysis.R", "document_version": -1}),
            json!({"path": "analysis.R", "document_version": null}),
        ] {
            assert!(bridge_expression("workspace.lint_file", &arguments).is_err());
        }
    }

    #[test]
    fn format_lookup_is_source_and_document_version_bound() {
        let (class, expression) = bridge_expression(
            "workspace.format_r_source",
            &json!({
                "source": "x<-1+2\n",
                "path": "R/analysis quoted.R",
                "document_version": 7
            }),
        )
        .unwrap();
        assert!(matches!(class, OperationClass::Probe));
        assert!(expression.contains("rho_format_r_source"));
        assert!(expression.contains("R/analysis quoted.R"));
        assert!(expression.contains("document_version = 7"));

        for arguments in [
            json!({"source": "x <- 1", "path": "analysis.txt", "document_version": 1}),
            json!({"source": "x <- 1", "path": "../analysis.R", "document_version": 1}),
            json!({"source": "x\0 <- 1", "path": "analysis.R", "document_version": 1}),
            json!({"source": "x <- 1", "path": "analysis.R", "document_version": -1}),
            json!({"source": "x".repeat(1024 * 1024 + 1), "path": "analysis.R", "document_version": 1}),
        ] {
            assert!(bridge_expression("workspace.format_r_source", &arguments).is_err());
        }
    }

    #[test]
    fn project_reference_lookup_is_bounded_escaped_and_read_only() {
        let (class, expression) = bridge_expression(
            "workspace.find_project_references",
            &json!({
                "name": "mean\"quoted",
                "project_root": "C:/project with space",
                "limit": 999
            }),
        )
        .unwrap();
        assert!(matches!(class, OperationClass::Probe));
        assert!(expression.contains("rho_find_project_references(\"mean\\\"quoted\""));
        assert!(expression.contains("\"C:/project with space\", limit = 200L"));

        for arguments in [
            json!({"name": "", "project_root": "C:/project"}),
            json!({"name": "x".repeat(129), "project_root": "C:/project"}),
            json!({"name": "bad\nname", "project_root": "C:/project"}),
            json!({"name": "mean", "project_root": ""}),
            json!({"name": "mean", "project_root": "x".repeat(1001)}),
            json!({"name": "mean", "project_root": "bad\nroot"}),
        ] {
            assert!(bridge_expression("workspace.find_project_references", &arguments).is_err());
        }
    }



    #[test]
    fn bridge_expression_supports_wp2_paged_reads() {
        let (class, expression) = bridge_expression(
            "workspace.read_data_view",
            &json!({
                "object_name": "sce",
                "view_token": "sha256:token",
                "view_kind": "assay",
                "view_key": "counts",
                "row_offset": 10,
                "row_limit": 20,
                "column_offset": 5,
                "column_limit": 8,
                "query": " target \"quoted\" ",
                "sort_column": 3,
                "sort_direction": "desc"
            }),
        )
        .unwrap();

        assert!(matches!(class, OperationClass::Probe));
        assert!(expression.contains("rho_read_data_view"));
        assert!(expression.contains("object_name = \"sce\""));
        assert!(expression.contains("view_kind = \"assay\""));
        assert!(expression.contains("row_offset = 10"));
        assert!(expression.contains("column_limit = 8"));
        assert!(expression.contains("query = \"target \\\"quoted\\\"\""));
        assert!(expression.contains("sort_column = 3L"));
        assert!(expression.contains("sort_direction = \"desc\""));
    }

    #[test]
    fn bridge_expression_normalizes_absent_data_view_query_and_sort() {
        let (_, expression) = bridge_expression(
            "workspace.read_data_view",
            &json!({
                "object_name": "qc",
                "view_token": "token",
                "view_kind": "table",
                "view_key": "table"
            }),
        )
        .unwrap();

        assert!(expression.contains("query = NULL"));
        assert!(expression.contains("sort_column = NULL"));
        assert!(expression.contains("sort_direction = NULL"));
    }

    #[test]
    fn bridge_expression_rejects_invalid_data_view_query_and_sort() {
        let base = json!({
            "object_name": "qc",
            "view_token": "token",
            "view_kind": "table",
            "view_key": "table"
        });
        let mut invalid_query = base.clone();
        invalid_query["query"] = json!("line\nbreak");
        assert!(bridge_expression("workspace.read_data_view", &invalid_query).is_err());

        let mut unpaired_sort = base.clone();
        unpaired_sort["sort_column"] = json!(0);
        assert!(bridge_expression("workspace.read_data_view", &unpaired_sort).is_err());

        let mut invalid_direction = base;
        invalid_direction["sort_column"] = json!(0);
        invalid_direction["sort_direction"] = json!("up");
        assert!(bridge_expression("workspace.read_data_view", &invalid_direction).is_err());
    }



    #[test]
    fn canonical_snapshot_detects_lockfile_drift() {
        let directory = std::env::temp_dir().join(format!("rho-lockfile-{}", Uuid::new_v4()));
        fs::create_dir_all(&directory).unwrap();
        let lockfile = directory.join("renv.lock");
        fs::write(
            &lockfile,
            r#"{"Packages":{"testpkg":{"Version":"1.0.0","Source":"Repository"}}}"#,
        )
        .unwrap();

        let snapshot = canonicalize_environment_snapshot(
            "D:/Rho/project".to_string(),
            RawEnvironmentReceipt {
                project_dir: "D:/Rho/project".to_string(),
                runtime: RawRuntimeState {
                    version: Some("4.5.0".to_string()),
                    platform: Some("x86_64-w64-mingw32".to_string()),
                },
                library_paths: vec!["D:/Rho/project/renv/library".to_string()],
                installed_packages: RawInstalledPackages {
                    values: vec![RawInstalledPackage {
                        name: "testpkg".to_string(),
                        version: Some("2.0.0".to_string()),
                        library: Some("D:/Rho/project/renv/library".to_string()),
                    }],
                    truncated: false,
                    incomplete_reason: None,
                },
                renv: RawRenvState {
                    status: Some("active".to_string()),
                    has_lockfile: Some(true),
                    lockfile_path: Some(lockfile.to_string_lossy().replace('\\', "/")),
                    package_available: Some(true),
                    project_library: Some("D:/Rho/project/renv".to_string()),
                    active: Some(true),
                },
                bioconductor: RawBioconductorState {
                    status: Some("available".to_string()),
                    version: Some("3.21".to_string()),
                    package_available: Some(true),
                },
            },
        );

        assert_eq!(snapshot.renv.synchronization, "drifted");
        assert!(snapshot.renv.lockfile.valid);
        assert_eq!(snapshot.renv.lockfile.packages.len(), 1);

        let _ = fs::remove_dir_all(&directory);
    }

    #[test]
    fn finalize_environment_snapshot_trims_to_byte_budget() {
        let mut snapshot = CanonicalEnvironmentSnapshot {
            project_root: "D:/Rho/project".to_string(),
            runtime: CanonicalRuntimeState {
                version: Some("4.5.0".to_string()),
                platform: Some("x86_64-w64-mingw32".to_string()),
            },
            bioconductor: CanonicalBioconductorState {
                status: "available".to_string(),
                version: Some("3.21".to_string()),
                package_available: true,
            },
            library_paths: vec!["D:/Rho/project/renv/library".repeat(4000)],
            installed_packages: (0..320)
                .map(|index| CanonicalInstalledPackage {
                    name: format!("pkg_{index:04}"),
                    version: Some("1.0.0".to_string()),
                    library: Some("D:/Rho/project/renv/library/very/long/path".repeat(160)),
                })
                .collect(),
            renv: CanonicalRenvState {
                status: "active".to_string(),
                has_lockfile: true,
                package_available: true,
                project_library: Some("D:/Rho/project/renv".to_string()),
                active: true,
                lockfile: CanonicalLockfileState {
                    exists: true,
                    sha256: Some("abc".to_string()),
                    valid: true,
                    packages: (0..160)
                        .map(|index| CanonicalLockfilePackage {
                            name: format!("lockpkg_{index:04}"),
                            version: Some("1.0.0".to_string()),
                            source: Some("Repository".repeat(40)),
                        })
                        .collect(),
                },
                synchronization: "drifted".to_string(),
            },
            incomplete_reason: None,
        };

        let encoded = finalize_environment_snapshot_json(&mut snapshot).unwrap();

        assert!(encoded.len() <= MAX_CANONICAL_SNAPSHOT_BYTES);
        assert!(
            snapshot
                .incomplete_reason
                .as_deref()
                .unwrap_or_default()
                .contains("canonical_snapshot_trimmed_to_budget")
        );
    }
