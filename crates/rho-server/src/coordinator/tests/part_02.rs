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
