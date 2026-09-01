    #[test]
    fn desktop_shutdown_waits_for_project_transition_gate() {
        let runtime = tokio::runtime::Runtime::new().unwrap();
        runtime.block_on(async {
            let tempdir = TempDir::new().unwrap();
            let project_root = tempdir.path().join("project-a");
            std::fs::create_dir_all(&project_root).unwrap();
            let store_path = tempdir.path().join("rho.sqlite");
            let normalized_root = normalize_project_root(project_root.to_string_lossy().as_ref());
            Store::open(&store_path)
                .unwrap()
                .set_project_root(Some(&normalized_root))
                .unwrap();
            let state = Arc::new(test_app_state(tempdir.path(), &project_root, &store_path));
            let transition = state.project_transition_gate.lock().await;
            let closing_state = Arc::clone(&state);
            let closing = tokio::spawn(async move { shutdown_application(&closing_state).await });
            tokio::time::sleep(Duration::from_millis(10)).await;
            assert!(!closing.is_finished());
            drop(transition);
            closing.await.unwrap().unwrap();
        });
    }

    #[test]
    fn project_switch_returns_failed_restored_and_preserves_previous_state() {
        let runtime = tokio::runtime::Runtime::new().unwrap();
        runtime.block_on(async {
            let tempdir = TempDir::new().unwrap();
            let project_a = tempdir.path().join("project-a");
            let project_b = tempdir.path().join("project-b");
            std::fs::create_dir_all(&project_a).unwrap();
            std::fs::create_dir_all(&project_b).unwrap();
            let store_path = tempdir.path().join("rho.sqlite");
            let mut store = Store::open(&store_path).unwrap();
            let root_a = normalize_project_root(project_a.to_string_lossy().as_ref());
            store.set_project_root(Some(&root_a)).unwrap();
            let state = test_app_state(tempdir.path(), &project_a, &store_path);
            let previous_session = save_session_fixture(&state, &project_a, "old.R", 210);
            save_session_fixture(&state, &project_b, "new.R", 260);
            state
                .switch_test_control
                .succeed_without_running(SwitchTestStep::SyncWorkspace);
            state.switch_test_control.fail(
                SwitchTestStep::SetActiveProjectRoot,
                "inject store root failure",
            );
            state
                .switch_test_control
                .succeed_without_running(SwitchTestStep::RestoreWorkspace);

            let response =
                switch_project_with_watcher_factory(project_b.clone(), None, &state, |_| {
                    Ok(ProjectWatcherControl::noop())
                })
                .await
                .unwrap();

            let restored_root = project_a.to_string_lossy().replace('\\', "/");
            assert_eq!(response.status, "failed_restored");
            assert_eq!(
                response.reason_code.as_deref(),
                Some("project_switch_store_root_failed")
            );
            assert_eq!(
                response.restored_root.as_deref(),
                Some(restored_root.as_str())
            );
            assert_eq!(
                response.session.active_document,
                previous_session.active_document
            );
            assert_eq!(
                state
                    .project_root
                    .read()
                    .await
                    .to_string_lossy()
                    .replace('\\', "/"),
                project_a.to_string_lossy().replace('\\', "/")
            );
            let active_root = Store::open(&store_path)
                .unwrap()
                .active_project_root()
                .unwrap()
                .unwrap();
            assert_eq!(active_root, root_a);
        });
    }

    #[test]
    fn project_switch_returns_fatal_when_restore_path_fails() {
        let runtime = tokio::runtime::Runtime::new().unwrap();
        runtime.block_on(async {
            let tempdir = TempDir::new().unwrap();
            let project_a = tempdir.path().join("project-a");
            let project_b = tempdir.path().join("project-b");
            std::fs::create_dir_all(&project_a).unwrap();
            std::fs::create_dir_all(&project_b).unwrap();
            let store_path = tempdir.path().join("rho.sqlite");
            let mut store = Store::open(&store_path).unwrap();
            let root_a = normalize_project_root(project_a.to_string_lossy().as_ref());
            store.set_project_root(Some(&root_a)).unwrap();
            let state = test_app_state(tempdir.path(), &project_a, &store_path);
            let previous_session = save_session_fixture(&state, &project_a, "old.R", 210);
            state
                .switch_test_control
                .succeed_without_running(SwitchTestStep::SyncWorkspace);
            state.switch_test_control.fail(
                SwitchTestStep::SetActiveProjectRoot,
                "inject store root failure",
            );
            state
                .switch_test_control
                .fail(SwitchTestStep::RestoreWorkspace, "inject restore failure");

            let response =
                switch_project_with_watcher_factory(project_b.clone(), None, &state, |_| {
                    Ok(ProjectWatcherControl::noop())
                })
                .await
                .unwrap();

            assert_eq!(response.status, "fatal");
            assert!(response.restart_required);
            assert_eq!(
                response.reason_code.as_deref(),
                Some("project_switch_restore_failed")
            );
            assert_eq!(
                response.session.active_document,
                previous_session.active_document
            );
            assert_eq!(
                state
                    .project_root
                    .read()
                    .await
                    .to_string_lossy()
                    .replace('\\', "/"),
                project_a.to_string_lossy().replace('\\', "/")
            );
        });
    }

    #[test]
    fn enforces_the_documented_minimum_r_version() {
        assert!(ensure_supported_r_version("4.3.3").is_err());
        assert!(ensure_supported_r_version("4.4.0").is_ok());
        assert!(ensure_supported_r_version("5.0.0").is_ok());
        assert!(ensure_supported_r_version("invalid").is_err());
    }

    #[test]
    fn requires_arm64_r_only_for_apple_silicon_macos() {
        assert!(r_architecture_supported("macos", "aarch64", "aarch64"));
        assert!(r_architecture_supported("macos", "aarch64", "arm64"));
        assert!(!r_architecture_supported("macos", "aarch64", "x86_64"));
        assert!(r_architecture_supported("windows", "x86_64", "x86_64"));
        assert!(r_architecture_supported("linux", "x86_64", "x86_64"));
        assert!(!r_architecture_supported("linux", "x86_64", "aarch64"));
        assert!(!r_architecture_supported("linux", "x86_64", "arm64"));
        assert!(r_architecture_supported("linux", "aarch64", "aarch64"));

        if cfg!(all(target_os = "macos", target_arch = "aarch64")) {
            assert!(ensure_supported_r_architecture("aarch64").is_ok());
            assert!(ensure_supported_r_architecture("x86_64").is_err());
        }
        if cfg!(all(target_os = "linux", target_arch = "x86_64")) {
            assert!(ensure_supported_r_architecture("x86_64").is_ok());
            assert!(ensure_supported_r_architecture("aarch64").is_err());
            let detail = ensure_supported_r_architecture("aarch64")
                .unwrap_err()
                .to_string();
            assert!(detail.contains("R_ARCH_MISMATCH"));
            assert!(detail.contains("Rho for Linux x64 requires x86_64 R"));
        }
    }

    #[test]
    fn executable_path_search_preserves_spaces_and_unicode() {
        let directory = TempDir::new().unwrap();
        let first = directory.path().join("missing path");
        let second = directory.path().join("R 工具");
        std::fs::create_dir_all(&first).unwrap();
        std::fs::create_dir_all(&second).unwrap();
        let executable = if cfg!(windows) {
            "Rscript.exe"
        } else {
            "Rscript"
        };
        let expected = second.join(executable);
        std::fs::write(&expected, b"fixture").unwrap();
        let search_path = std::env::join_paths([first, second]).unwrap();

        assert_eq!(
            find_executable_on_path(executable, &search_path),
            Some(expected)
        );
    }

    #[test]
    fn invalid_persisted_r_selection_fails_without_falling_through() {
        let directory = TempDir::new().unwrap();
        let missing = directory.path().join("missing R/Rscript");
        let error = locate_rscript(Some(&missing)).unwrap_err();
        assert!(
            error
                .to_string()
                .contains("selected Rscript path does not point to a file")
        );
    }

    #[test]
    fn ark_lookup_prefers_installed_macos_sidecar_and_falls_back_to_development() {
        let directory = TempDir::new().unwrap();
        let manifest_dir = directory.path().join("desktop/src-tauri");
        let resource_dir = directory.path().join("Rho.app/Contents/Resources");
        let current_exe = directory.path().join("Rho.app/Contents/MacOS/rho-desktop");
        std::fs::create_dir_all(current_exe.parent().unwrap()).unwrap();
        std::fs::create_dir_all(manifest_dir.join("binaries")).unwrap();
        let candidates = ark_candidate_paths(
            "macos",
            "aarch64",
            &manifest_dir,
            &resource_dir,
            &current_exe,
        );
        let installed = current_exe.parent().unwrap().join("ark");
        let development = manifest_dir.join("binaries/ark-aarch64-apple-darwin");
        assert_eq!(candidates, vec![installed.clone(), development.clone()]);

        std::fs::write(&development, b"development").unwrap();
        assert_eq!(
            locate_ark_from_candidates(candidates.clone()).unwrap(),
            development
        );
        std::fs::write(&installed, b"installed").unwrap();
        assert_eq!(locate_ark_from_candidates(candidates).unwrap(), installed);
    }

    #[test]
    fn ark_lookup_prefers_installed_linux_sidecar_and_falls_back_to_development() {
        let directory = TempDir::new().unwrap();
        let manifest_dir = directory.path().join("desktop/src-tauri");
        let resource_dir = directory.path().join("usr/share/rho");
        let current_exe = directory.path().join("usr/bin/rho-desktop");
        std::fs::create_dir_all(current_exe.parent().unwrap()).unwrap();
        std::fs::create_dir_all(manifest_dir.join("binaries")).unwrap();
        let candidates = ark_candidate_paths(
            "linux",
            "x86_64",
            &manifest_dir,
            &resource_dir,
            &current_exe,
        );
        let bundled = resource_dir.join("resources/runtime/ark");
        let installed = current_exe.parent().unwrap().join("ark");
        let deb_development = manifest_dir.join("../resources/runtime/ark");
        let development = manifest_dir.join("binaries/ark-x86_64-unknown-linux-gnu");
        assert_eq!(
            candidates,
            vec![
                bundled.clone(),
                installed.clone(),
                deb_development.clone(),
                development.clone()
            ]
        );

        std::fs::write(&development, b"development").unwrap();
        assert_eq!(
            locate_ark_from_candidates(candidates.clone()).unwrap(),
            development
        );
        std::fs::write(&installed, b"installed").unwrap();
        assert_eq!(locate_ark_from_candidates(candidates).unwrap(), installed);
    }

    #[test]
    fn ark_lookup_linux_aarch64_prefers_bundled_deb_runtime_then_development() {
        let directory = TempDir::new().unwrap();
        let manifest_dir = directory.path().join("desktop/src-tauri");
        let resource_dir = directory.path().join("usr/share/rho");
        let current_exe = directory.path().join("usr/bin/rho-desktop");
        std::fs::create_dir_all(current_exe.parent().unwrap()).unwrap();
        std::fs::create_dir_all(manifest_dir.join("binaries")).unwrap();
        std::fs::create_dir_all(manifest_dir.join("../resources/runtime")).unwrap();
        std::fs::create_dir_all(resource_dir.join("resources/runtime")).unwrap();
        let candidates = ark_candidate_paths(
            "linux",
            "aarch64",
            &manifest_dir,
            &resource_dir,
            &current_exe,
        );
        let bundled = resource_dir.join("resources/runtime/ark");
        let installed = current_exe.parent().unwrap().join("ark");
        let deb_development = manifest_dir.join("../resources/runtime/ark");
        let development = manifest_dir.join("binaries/ark-aarch64-unknown-linux-gnu");
        assert_eq!(
            candidates,
            vec![
                bundled.clone(),
                installed.clone(),
                deb_development.clone(),
                development.clone()
            ]
        );

        std::fs::write(&development, b"development").unwrap();
        assert_eq!(
            locate_ark_from_candidates(candidates.clone()).unwrap(),
            development
        );
        std::fs::write(&bundled, b"bundled").unwrap();
        assert_eq!(locate_ark_from_candidates(candidates).unwrap(), bundled);
    }

    #[test]
    fn ark_lookup_retains_windows_resources_and_rejects_unknown_targets() {
        let root = Path::new("C:/rho");
        let windows = ark_candidate_paths(
            "windows",
            "x86_64",
            root,
            Path::new("C:/installed"),
            Path::new("C:/installed/rho-desktop.exe"),
        );
        assert_eq!(
            windows,
            vec![
                PathBuf::from("C:/installed/resources/runtime/ark.exe"),
                PathBuf::from("C:/rho/../resources/runtime/ark.exe")
            ]
        );
        assert!(ark_candidate_paths("macos", "x86_64", root, root, root).is_empty());
        assert!(locate_ark_from_candidates(Vec::new()).is_err());
    }

    #[test]
    fn writes_probe_code_to_a_utf8_r_script() {
        let expression = "cat('Rho UTF-8: 中文')\n";
        let script = write_r_probe_script(expression).unwrap();
        assert_eq!(
            script.path().extension().and_then(|value| value.to_str()),
            Some("R")
        );
        assert_eq!(std::fs::read_to_string(script.path()).unwrap(), expression);
    }

    #[test]
    fn parses_base_r_probe_without_requiring_user_startup_files() {
        // The probe parser validates the reported architecture against the
        // current platform, so the fixture must use an arch the host accepts:
        // Apple Silicon accepts aarch64; every other host accepts x86_64.
        let arch = if cfg!(all(target_os = "macos", target_arch = "aarch64")) {
            "aarch64"
        } else {
            "x86_64"
        };
        let probe = parse_r_runtime_probe(&format!(
            "__RHO_HOME__C:/Program Files/R/R-4.4.2\n\
             __RHO_BIN__C:/Program Files/R/R-4.4.2/bin/x64\n\
             __RHO_ARCH__{arch}\n\
             __RHO_PATH_SEP__;\n\
             __RHO_VERSION__R version 4.4.2\n\
             __RHO_VERSION_NUMBER__4.4.2\n\
             __RHO_PROFILE_USER__C:/Users/test/Documents/.Rprofile\n\
             __RHO_ENVIRON_USER__C:/Users/test/Documents/.Renviron\n\
             __RHO_LIBS__C:/Users/test/R/win-library/4.4;C:/Program Files/R/R-4.4.2/library\n"
        ))
        .unwrap();
        assert_eq!(probe.r_home, "C:/Program Files/R/R-4.4.2");
        assert!(probe.r_bin.ends_with("bin/x64"));
        assert_eq!(probe.r_arch, arch);
        assert_eq!(probe.path_sep, ";");
        assert_eq!(probe.r_version, "R version 4.4.2");
        assert!(probe.r_libs.contains("win-library"));
        assert!(probe.r_profile_user.is_none());
        assert!(probe.r_environ_user.is_none());
    }

    #[test]
    fn rejects_x86_and_old_r_probe_results_before_runtime_generation() {
        if cfg!(all(target_os = "macos", target_arch = "aarch64")) {
            let x86 = parse_r_runtime_probe(
                "__RHO_HOME__/Library/Frameworks/R.framework/Resources\n\
                 __RHO_BIN__/Library/Frameworks/R.framework/Resources/bin\n\
                 __RHO_ARCH__x86_64\n\
                 __RHO_PATH_SEP__:\n",
            )
            .unwrap_err();
            assert!(x86.to_string().contains("R_ARCH_MISMATCH"));
        }

        // Same platform-valid arch as the parse test above: the version gate
        // (not the architecture gate) must be what rejects this old R.
        let arch = if cfg!(all(target_os = "macos", target_arch = "aarch64")) {
            "aarch64"
        } else {
            "x86_64"
        };
        let old = parse_r_runtime_probe(&format!(
            "__RHO_HOME__/Library/Frameworks/R.framework/Resources\n\
             __RHO_BIN__/Library/Frameworks/R.framework/Resources/bin\n\
             __RHO_ARCH__{arch}\n\
             __RHO_PATH_SEP__:\n\
             __RHO_VERSION__R version 4.3.3\n\
             __RHO_VERSION_NUMBER__4.3.3\n"
        ))
        .unwrap_err();
        assert!(old.to_string().contains("requires R 4.4"));
    }

    #[test]
    fn retains_only_user_startup_paths_that_are_files() {
        let directory = TempDir::new().unwrap();
        let profile = directory.path().join(".Rprofile");
        std::fs::write(&profile, "options(rho.test = TRUE)").unwrap();
        let environ = directory.path().join(".Renviron");
        let nested_directory = directory.path().join("not-a-file");
        std::fs::create_dir(&nested_directory).unwrap();

        assert_eq!(
            existing_startup_file(profile.to_string_lossy().into_owned()),
            Some(profile)
        );
        assert_eq!(
            existing_startup_file(environ.to_string_lossy().into_owned()),
            None
        );
        assert_eq!(
            existing_startup_file(nested_directory.to_string_lossy().into_owned()),
            None
        );
    }

    #[test]
    fn disables_missing_user_startup_files_without_placeholder_environment_paths() {
        let mut command = Command::new("Rscript");
        let empty_site = configure_user_startup(
            &mut command,
            RUserStartupFiles {
                profile: None,
                environ: None,
            },
        )
        .unwrap();
        let arguments = command
            .get_args()
            .map(|value| value.to_string_lossy().into_owned())
            .collect::<Vec<_>>();
        let environment = command
            .get_envs()
            .map(|(name, _)| name.to_string_lossy().into_owned())
            .collect::<Vec<_>>();

        assert!(empty_site.is_none());
        assert!(arguments.contains(&"--no-init-file".to_string()));
        assert!(arguments.contains(&"--no-environ".to_string()));
        assert!(!environment.contains(&"R_PROFILE_USER".to_string()));
        assert!(!environment.contains(&"R_ENVIRON_USER".to_string()));
    }

    #[test]
    fn binds_each_existing_user_startup_file_independently() {
        let mut profile_only = Command::new("Rscript");
        configure_user_startup(
            &mut profile_only,
            RUserStartupFiles {
                profile: Some(Path::new("C:/Users/test/.Rprofile")),
                environ: None,
            },
        )
        .unwrap();
        let profile_arguments = profile_only
            .get_args()
            .map(|value| value.to_string_lossy().into_owned())
            .collect::<Vec<_>>();
        let profile_environment = profile_only
            .get_envs()
            .map(|(name, _)| name.to_string_lossy().into_owned())
            .collect::<Vec<_>>();
        assert!(!profile_arguments.contains(&"--no-init-file".to_string()));
        assert!(profile_arguments.contains(&"--no-environ".to_string()));
        assert!(profile_environment.contains(&"R_PROFILE_USER".to_string()));
        assert!(!profile_environment.contains(&"R_ENVIRON_USER".to_string()));

        let mut environ_only = Command::new("Rscript");
        let empty_site = configure_user_startup(
            &mut environ_only,
            RUserStartupFiles {
                profile: None,
                environ: Some(Path::new("C:/Users/test/.Renviron")),
            },
        )
        .unwrap();
        let environ_arguments = environ_only
            .get_args()
            .map(|value| value.to_string_lossy().into_owned())
            .collect::<Vec<_>>();
        let environ_environment = environ_only
            .get_envs()
            .map(|(name, _)| name.to_string_lossy().into_owned())
            .collect::<Vec<_>>();
        assert!(empty_site.is_some());
        assert!(environ_arguments.contains(&"--no-init-file".to_string()));
        assert!(!environ_arguments.contains(&"--no-environ".to_string()));
        assert!(!environ_environment.contains(&"R_PROFILE_USER".to_string()));
        assert!(environ_environment.contains(&"R_ENVIRON_USER".to_string()));
    }

    #[test]
    fn classifies_empty_stderr_probe_exit_as_recoverable() {
        let issue = classify_startup_error(
            "R runtime probe failed (exit_code=Some(1), timed_out=false): stdout= stderr=",
        );
        assert_eq!(issue.code, "R_PROBE_EXITED");
        assert!(issue.actions.contains(&"choose_rscript".to_string()));
    }

    #[test]
    fn classifies_macos_architecture_mismatch_with_stable_recovery_code() {
        let issue = classify_startup_error(
            "R_ARCH_MISMATCH: Rho for Apple Silicon requires arm64 R; found `x86_64`",
        );
        assert_eq!(issue.code, "R_ARCH_MISMATCH");
        assert_eq!(issue.phase, "probing_base_r");
        assert!(issue.actions.contains(&"choose_rscript".to_string()));
    }

    #[test]
    fn startup_recovery_copy_uses_the_platform_rscript_name() {
        for detail in [
            "selected Rscript path does not point to a file",
            "Rscript was not found",
            "R runtime probe failed (exit_code=Some(1), timed_out=false): stdout= stderr=",
            "unclassified runtime failure",
        ] {
            let issue = classify_startup_error(detail);
            assert!(issue.message.contains(platform::rscript_display_name()));
            if !cfg!(windows) {
                assert!(!issue.message.contains("Rscript.exe"));
            }
        }
    }

    #[test]
    fn classifies_missing_ark_as_repairable_installation_failure() {
        let issue = classify_startup_error("bundled Ark executable was not found");
        assert_eq!(issue.code, "ARK_RESOURCE_MISSING");
        assert_eq!(issue.phase, "checking_installation");
        assert!(issue.actions.contains(&"retry".to_string()));
    }

    #[test]
    fn classifies_missing_r_as_recoverable_discovery_failure() {
        let issue = classify_startup_error("Rscript was not found");
        assert_eq!(issue.code, "R_NOT_FOUND");
        assert_eq!(issue.phase, "locating_r");
        assert!(issue.actions.contains(&"choose_rscript".to_string()));
    }

    #[test]
    fn bounds_multiline_subprocess_diagnostics() {
        let value = format!("secret-free\r\n{}", "x".repeat(5000));
        let bounded = bounded_diagnostic(&value);
        assert!(!bounded.contains(['\r', '\n']));
        assert_eq!(bounded.chars().count(), 4096);
    }

    #[test]
    fn redacts_common_secret_shapes_from_diagnostics() {
        let bounded = bounded_diagnostic(
            "DEEPSEEK_API_KEY=secret Authorization=token Bearer another-secret safe",
        );
        assert!(!bounded.contains("secret"));
        assert!(!bounded.contains("another-secret"));
        assert!(bounded.contains("<redacted>"));
        assert!(bounded.ends_with("safe"));
    }

    #[test]
    fn startup_error_display_preserves_bounded_redacted_context_chain() {
        let error = anyhow::anyhow!("migration rejected: unsupported schema version 15")
            .context("opening Rho event store")
            .context("starting Workspace R");
        let displayed = display_error_chain(&error);
        assert_eq!(
            displayed,
            "starting Workspace R: opening Rho event store: migration rejected: unsupported schema version 15"
        );

        let secret = anyhow::anyhow!("token=private-value").context("opening Rho event store");
        let displayed = display_error_chain(&secret);
        assert!(!displayed.contains("private-value"));
        assert!(displayed.contains("token=<redacted>"));
    }

    #[test]
    fn safe_delete_project_file_deletes_supported_project_file() {
        let directory = TempDir::new().unwrap();
        let root = directory.path().canonicalize().unwrap();
        let file = root.join("analysis.R");
        std::fs::write(&file, "x <- 1").unwrap();
        safe_delete_project_file(&root, "analysis.R").unwrap();
        assert!(!file.exists());
    }

    #[test]
    fn safe_delete_project_file_rejects_missing_file() {
        let directory = TempDir::new().unwrap();
        let root = directory.path().canonicalize().unwrap();
        let error = safe_delete_project_file(&root, "missing.R").unwrap_err();
        assert!(error.to_string().contains("does not exist"));
    }

    #[test]
    fn safe_delete_project_file_rejects_unsupported_extension() {
        let directory = TempDir::new().unwrap();
        let root = directory.path().canonicalize().unwrap();
        let file = root.join("figure.png");
        std::fs::write(&file, [0_u8, 1, 2]).unwrap();
        let error = safe_delete_project_file(&root, "figure.png").unwrap_err();
        assert!(
            error
                .to_string()
                .contains("Unsupported or binary project file")
        );
    }

    #[test]
    fn safe_delete_project_file_rejects_parent_escape() {
        let directory = TempDir::new().unwrap();
        let root = directory.path().canonicalize().unwrap();
        let error = safe_delete_project_file(&root, "../outside.R").unwrap_err();
        assert!(error.to_string().contains("parent, root or drive prefix"));
    }

    #[test]
    fn safe_delete_project_file_rejects_symlink_escape() {
        let directory = TempDir::new().unwrap();
        let outside_dir = TempDir::new().unwrap();
        let root = directory.path().canonicalize().unwrap();
        let outside = outside_dir.path().join("outside.R");
        std::fs::write(&outside, "outside <- TRUE").unwrap();
        let link = root.join("link-outside.R");
        #[cfg(windows)]
        let symlink_result = std::os::windows::fs::symlink_file(&outside, &link);
        #[cfg(unix)]
        let symlink_result = std::os::unix::fs::symlink(&outside, &link);
        if let Err(error) = symlink_result {
            if error.raw_os_error() == Some(1314) {
                return;
            }
            panic!("Could not create symlink test fixture: {error}");
        }
        let error = safe_delete_project_file(&root, "link-outside.R").unwrap_err();
        assert!(error.to_string().contains("escapes project root"));
        assert!(outside.exists());
    }

    #[test]
    fn safe_delete_project_file_rejects_directories() {
        let directory = TempDir::new().unwrap();
        let root = directory.path().canonicalize().unwrap();
        std::fs::create_dir(root.join("folder.R")).unwrap();
        let error = safe_delete_project_file(&root, "folder.R").unwrap_err();
        assert!(error.to_string().contains("is not a file"));
        assert!(root.join("folder.R").is_dir());
    }

    #[test]
    fn ensure_artifact_export_target_rejects_parent_escape_and_collisions() {
        let directory = TempDir::new().unwrap();
        let root = directory.path().canonicalize().unwrap();
        let existing = root.join("plots").join("qc.png");
        std::fs::create_dir_all(existing.parent().unwrap()).unwrap();
        std::fs::write(&existing, [137_u8, 80, 78, 71, 13, 10, 26, 10]).unwrap();

        let escape = ensure_artifact_export_target(&root, "../outside.png", &["png"]).unwrap_err();
        assert!(escape.to_string().contains("parent, root or drive prefix"));

        let collision = ensure_artifact_export_target(&root, "plots/qc.png", &["png"]).unwrap_err();
        assert!(collision.to_string().contains("already exists"));
    }

    #[test]
    fn data_view_delimited_text_writes_exact_utf8_csv_with_crlf_and_quotes() {
        let page = json!({
            "columns": [
                { "name": "sample", "label": "sample" },
                { "name": "note", "label": "note" }
            ],
            "rows": [
                { "row_name": "row,1", "cells": ["plain", "line\r\nbreak"] },
                { "row_name": "第二行", "cells": [null, "He said \"hi\""] }
            ]
        });
        let output = data_view_delimited_text(&page, ',').unwrap();
        let expected = concat!(
            "row_name,sample,note\r\n",
            "\"row,1\",plain,\"line\r\nbreak\"\r\n",
            "第二行,,\"He said \"\"hi\"\"\"\r\n"
        );
        assert_eq!(output, expected);
        assert_eq!(output.as_bytes()[output.len() - 2..], [b'\r', b'\n']);
    }

    #[test]
    fn data_view_delimited_text_writes_exact_utf8_tsv_with_missing_values() {
        let page = json!({
            "columns": [
                { "name": "detected", "label": "detected" },
                { "name": "group", "label": "group\tlabel" }
            ],
            "rows": [
                { "row_name": "cell_1", "cells": ["A", "组1"] },
                { "row_name": "cell_2", "cells": [null, ""] }
            ]
        });
        let output = data_view_delimited_text(&page, '\t').unwrap();
        let expected = concat!(
            "row_name\tdetected\t\"group\tlabel\"\r\n",
            "cell_1\tA\t组1\r\n",
            "cell_2\t\t\r\n"
        );
        assert_eq!(output, expected);
        assert!(String::from_utf8(output.into_bytes()).is_ok());
    }

    #[test]
    fn data_view_delimited_text_preserves_empty_missing_and_non_finite_values() {
        let page = json!({
            "columns": [
                { "name": "empty" },
                { "name": "missing" },
                { "name": "nan" },
                { "name": "positive" },
                { "name": "negative" }
            ],
            "rows": [{
                "row_name": "sample_1",
                "cells": ["", null, "NaN", "Inf", "-Inf"],
                "cell_states": ["empty", "na", "nan", "pos_inf", "neg_inf"]
            }]
        });

        let output = data_view_delimited_text(&page, ',').unwrap();

        assert_eq!(
            output,
            "row_name,empty,missing,nan,positive,negative\r\nsample_1,,,NaN,Inf,-Inf\r\n"
        );
    }

    #[test]
    fn data_view_artifact_metadata_replays_normalized_query_sort_and_window() {
        let page = json!({
            "row_offset": 25,
            "rows": [{"row_name": "cell_35", "cells": ["S35"]}],
            "column_offset": 1,
            "columns": [{"index": 1, "name": "reads", "label": "reads"}],
            "query": "S",
            "sort_column": 1,
            "sort_direction": "desc"
        });

        let metadata = data_view_artifact_metadata(&page, "qc", "table", "table", "csv");

        assert_eq!(metadata["object_name"], "qc");
        assert_eq!(metadata["row_offset"], 25);
        assert_eq!(metadata["row_count"], 1);
        assert_eq!(metadata["column_offset"], 1);
        assert_eq!(metadata["column_count"], 1);
        assert_eq!(metadata["query"], "S");
        assert_eq!(metadata["sort_column"], 1);
        assert_eq!(metadata["sort_direction"], "desc");
        assert_eq!(metadata["format"], "csv");
    }

    #[test]
    fn validates_png_signature() {
        assert!(has_png_signature(&[137, 80, 78, 71, 13, 10, 26, 10, 0, 1]));
        assert!(!has_png_signature(b"not-a-png"));
    }

    #[test]
    fn decodes_padded_and_unpadded_plot_png_payloads() {
        assert_eq!(
            decode_plot_png_base64("iVBORw0KGgo=").unwrap(),
            b"\x89PNG\r\n\x1a\n"
        );
        assert_eq!(
            decode_plot_png_base64("iVBORw0KGgo").unwrap(),
            b"\x89PNG\r\n\x1a\n"
        );
        assert!(decode_plot_png_base64("A").is_err());
        assert!(decode_plot_png_base64("not=base64").is_err());
    }

    fn render_job_fixture(job_id: &str, project_root: &str, status: &str) -> RenderJobState {
        RenderJobState {
            job_id: job_id.to_string(),
            project_root: project_root.to_string(),
            path: "report.Rmd".to_string(),
            document_version: Some(3),
            status: status.to_string(),
            artifact_id: None,
            output_path: None,
            tool: None,
            media_type: None,
            provenance_complete: None,
            message: None,
            terminal_reason: None,
            submitted_at: "2026-08-03T00:00:00Z".to_string(),
            completed_at: None,
        }
    }

    #[test]
    fn render_job_terminal_transitions_are_monotonic() {
        let mut job = render_job_fixture("render_1", "D:/project", "running");
        finish_render_job(&mut job, "completed", None, Some("completed"));
        assert!(render_job_is_terminal(&job.status));
        finish_render_job(
            &mut job,
            "interrupted",
            Some("late cancellation".to_string()),
            Some("user_interrupt"),
        );
        assert_eq!(job.status, "completed");
        assert_eq!(job.terminal_reason.as_deref(), Some("completed"));
        assert!(job.message.is_none());
    }

    #[test]
    fn render_job_restart_reconciliation_distinguishes_run_truth() {
        let mut before_start = render_job_fixture("render_1", "D:/project", "cancel_requested");
        reconcile_render_job(&mut before_start, None, None, None);
        assert_eq!(before_start.status, "interrupted");
        assert_eq!(
            before_start.terminal_reason.as_deref(),
            Some("workspace_restart_before_start")
        );

        let mut completed = render_job_fixture("render_2", "D:/project", "cancel_requested");
        reconcile_render_job(&mut completed, Some("completed"), None, Some("completed"));
        assert_eq!(completed.status, "completed");

        let mut failed = render_job_fixture("render_3", "D:/project", "cancel_requested");
        reconcile_render_job(
            &mut failed,
            Some("failed"),
            Some("render error".to_string()),
            Some("r_error"),
        );
        assert_eq!(failed.status, "failed");
        assert_eq!(failed.message.as_deref(), Some("render error"));

        let mut interrupted = render_job_fixture("render_4", "D:/project", "cancel_requested");
        reconcile_render_job(
            &mut interrupted,
            Some("interrupted"),
            None,
            Some("cancelled_during_restart"),
        );
        assert_eq!(interrupted.status, "interrupted");
        assert_eq!(
            interrupted.terminal_reason.as_deref(),
            Some("cancelled_during_restart")
        );
    }

    #[test]
    fn render_job_serialization_keeps_project_and_document_identity() {
        let job = render_job_fixture("render_1", "D:/project-a", "submitted");
        let value = serde_json::to_value(job).unwrap();
        assert_eq!(value["job_id"], "render_1");
        assert_eq!(value["project_root"], "D:/project-a");
        assert_eq!(value["path"], "report.Rmd");
        assert_eq!(value["document_version"], 3);
        assert_eq!(value["status"], "submitted");
        assert!(value["artifact_id"].is_null());
    }

    #[test]
    fn render_job_attaches_only_the_exact_artifact_projection() {
        let mut job = render_job_fixture("render_1", "D:/project-a", "running");
        let artifact = ArtifactRecordSummary {
            artifact_id: "artifact_render_1_render".to_string(),
            artifact_kind: "render_output".to_string(),
            run_id: Some("render_1".to_string()),
            project_root: "D:/project-a".to_string(),
            output_path: "report.html".to_string(),
            source_path: Some("report.Rmd".to_string()),
            execution_mode: Some("render".to_string()),
            document_version: Some(3),
            workspace_id: Some("ws-1".to_string()),
            state_revision: Some(2),
            project_revision: Some(4),
            media_type: "text/html".to_string(),
            metadata_json: "{}".to_string(),
            provenance_complete: true,
            incomplete_reason: None,
            created_at: "2026-08-03T00:00:00Z".to_string(),
        };

        attach_render_artifact(&mut job, &artifact);

        assert_eq!(job.artifact_id.as_deref(), Some("artifact_render_1_render"));
        assert_eq!(job.output_path.as_deref(), Some("report.html"));
        assert_eq!(job.media_type.as_deref(), Some("text/html"));
        assert_eq!(job.provenance_complete, Some(true));
    }

    #[test]
    #[ignore = "writes the requested generated TypeScript contract"]
    fn project_typescript_export() {
        let output_path = std::env::var_os("RHO_PROJECT_BINDINGS_PATH")
            .expect("RHO_PROJECT_BINDINGS_PATH must name the generated file");
        tauri_specta::Builder::<tauri::Wry>::new()
            .commands(tauri_specta::collect_commands![
                crate::commands::project_session::project_open,
                crate::commands::project_session::project_pick_directory,
                crate::commands::project_session::project_restore_session,
            ])
            .error_handling(tauri_specta::ErrorHandlingMode::Throw)
            .export(specta_typescript::Typescript::default(), output_path)
            .expect("Project TypeScript export must succeed");
    }

    #[test]
    #[ignore = "writes the requested generated TypeScript contract"]
    fn startup_typescript_export() {
        let output_path = std::env::var_os("RHO_STARTUP_BINDINGS_PATH")
            .expect("RHO_STARTUP_BINDINGS_PATH must name the generated file");
        tauri_specta::Builder::<tauri::Wry>::new()
            .commands(tauri_specta::collect_commands![
                crate::commands::startup::startup_bootstrap,
                crate::commands::startup::startup_choose_rscript,
                crate::commands::startup::workspace_start,
                crate::commands::startup::startup_diagnostics,
            ])
            .error_handling(tauri_specta::ErrorHandlingMode::Throw)
            .export(specta_typescript::Typescript::default(), output_path)
            .expect("Startup TypeScript export must succeed");
    }

    #[test]
    #[ignore = "writes the requested generated TypeScript contract"]
    fn history_typescript_export() {
        let output_path = std::env::var_os("RHO_HISTORY_BINDINGS_PATH")
            .expect("RHO_HISTORY_BINDINGS_PATH must name the generated file");
        tauri_specta::Builder::<tauri::Wry>::new()
            .commands(tauri_specta::collect_commands![
                crate::commands::runs::list_runs,
                crate::commands::artifacts::list_artifact_records,
                crate::commands::runs::list_problems,
                crate::commands::artifacts::list_plot_artifacts,
                crate::commands::artifacts::read_plot_artifact,
                crate::commands::runs::retry_run,
            ])
            .error_handling(tauri_specta::ErrorHandlingMode::Throw)
            .export(specta_typescript::Typescript::default(), output_path)
            .expect("History TypeScript export must succeed");
    }

    #[test]
    #[ignore = "writes the requested generated TypeScript contract"]
    fn environment_typescript_export() {
        let output_path = std::env::var_os("RHO_ENVIRONMENT_BINDINGS_PATH")
            .expect("RHO_ENVIRONMENT_BINDINGS_PATH must name the generated file");
        tauri_specta::Builder::<tauri::Wry>::new()
            .commands(tauri_specta::collect_commands![
                crate::commands::environment::environment_health,
                crate::commands::environment::environment_reobserve,
            ])
            .error_handling(tauri_specta::ErrorHandlingMode::Throw)
            .export(specta_typescript::Typescript::default(), output_path)
            .expect("Environment TypeScript export must succeed");
    }

    #[test]
    #[ignore = "writes the requested generated TypeScript contract"]
    fn git_typescript_export() {
        let output_path = std::env::var_os("RHO_GIT_BINDINGS_PATH")
            .expect("RHO_GIT_BINDINGS_PATH must name the generated file");
        tauri_specta::Builder::<tauri::Wry>::new()
            .commands(tauri_specta::collect_commands![
                crate::git_commands::git_status,
                crate::git_commands::git_log,
            ])
            .error_handling(tauri_specta::ErrorHandlingMode::Throw)
            .export(specta_typescript::Typescript::default(), output_path)
            .expect("Git TypeScript export must succeed");
    }

    #[test]
    fn startup_log_tail_is_unicode_safe_and_exactly_bounded() {
        let content = format!("discarded{}kept", "界".repeat(65_536));
        let tail = crate::commands::startup::startup_log_tail(&content);
        assert_eq!(tail.chars().count(), 65_536);
        assert!(tail.ends_with("kept"));
        assert!(!tail.contains("discarded"));
    }
