use rho_protocol::*;

fn digest(byte: char) -> ArtifactDigest {
    ArtifactDigest::new(format!("sha256:{}", byte.to_string().repeat(64))).unwrap()
}

fn staged(path: &str, size: u64) -> StagedBlobRef {
    StagedBlobRef {
        relative_path: path.to_string(),
        digest: digest('a'),
        byte_size: size,
    }
}

fn patch(operations: Vec<PatchOperation>, semantics: PatchPathSemantics) -> CanonicalProjectPatch {
    CanonicalProjectPatch::new(
        "patch_test",
        ProjectRevision(7),
        digest('b'),
        semantics,
        operations,
    )
    .unwrap()
}

#[test]
fn patch_canonical_create_replace_delete_rename_round_trip_and_exact_preview() {
    let patch = patch(
        vec![
            PatchOperation::Create {
                path: "R/new.R".to_string(),
                staged: staged("out/new.R", 10),
                mode: 0o644,
                hunk_count: 1,
            },
            PatchOperation::Replace {
                path: "R/old.R".to_string(),
                base_digest: digest('c'),
                staged: staged("out/old.R", 20),
                mode: 0o644,
                hunk_count: 2,
            },
            PatchOperation::Delete {
                path: "R/delete.R".to_string(),
                base_digest: digest('d'),
            },
            PatchOperation::Rename {
                from: "R/from.R".to_string(),
                to: "R/to.R".to_string(),
                base_digest: digest('e'),
            },
        ],
        PatchPathSemantics::CaseSensitive,
    );
    let decoded = decode_canonical_patch(&serde_json::to_vec(&patch).unwrap()).unwrap();
    assert_eq!(decoded, patch);
    let summary = patch.exact_effect_summary();
    assert_eq!(
        (
            summary.creates,
            summary.replaces,
            summary.deletes,
            summary.renames
        ),
        (1, 1, 1, 1)
    );
    assert_eq!(summary.staged_bytes, 30);
    assert!(summary.paths.contains(&"R/from.R -> R/to.R".to_string()));
}

#[test]
fn patch_has_no_shell_host_path_or_unbounded_inline_blob_surface() {
    let patch = patch(
        vec![PatchOperation::Create {
            path: "analysis.R".to_string(),
            staged: staged("sealed/analysis.R", 8),
            mode: 0o644,
            hunk_count: 1,
        }],
        PatchPathSemantics::CaseSensitive,
    );
    let encoded = serde_json::to_string(&patch).unwrap().to_ascii_lowercase();
    for forbidden in [
        "shell",
        "command",
        "host_path",
        "absolute_path",
        "inline_bytes",
        "symlink",
        "hardlink",
    ] {
        assert!(!encoded.contains(forbidden));
    }
}

#[test]
fn patch_rejects_traversal_absolute_backslash_control_unicode_and_depth() {
    for bad in ["../escape", "/absolute", "a\\b", "a\nb", "数据/file.R"] {
        assert!(
            CanonicalProjectPatch::new(
                "patch_bad",
                ProjectRevision(1),
                digest('b'),
                PatchPathSemantics::CaseSensitive,
                vec![PatchOperation::Delete {
                    path: bad.to_string(),
                    base_digest: digest('c'),
                }],
            )
            .is_err(),
            "path should fail: {bad:?}"
        );
    }
    let deep = (0..=MAX_PATCH_PATH_DEPTH)
        .map(|_| "a")
        .collect::<Vec<_>>()
        .join("/");
    assert!(matches!(
        CanonicalProjectPatch::new(
            "patch_deep",
            ProjectRevision(1),
            digest('b'),
            PatchPathSemantics::CaseSensitive,
            vec![PatchOperation::Delete {
                path: deep,
                base_digest: digest('c')
            }],
        ),
        Err(PatchValidationError::PathDepth(_))
    ));
}

#[test]
fn patch_rejects_duplicate_case_fold_and_conflicting_rename_operations() {
    let operations = vec![
        PatchOperation::Delete {
            path: "R/File.R".to_string(),
            base_digest: digest('c'),
        },
        PatchOperation::Create {
            path: "r/file.r".to_string(),
            staged: staged("sealed/new", 1),
            mode: 0o644,
            hunk_count: 1,
        },
    ];
    assert!(matches!(
        CanonicalProjectPatch::new(
            "patch_case",
            ProjectRevision(1),
            digest('b'),
            PatchPathSemantics::CaseInsensitive,
            operations,
        ),
        Err(PatchValidationError::ConflictingPath(_))
    ));
    assert!(matches!(
        CanonicalProjectPatch::new(
            "patch_rename",
            ProjectRevision(1),
            digest('b'),
            PatchPathSemantics::CaseSensitive,
            vec![PatchOperation::Rename {
                from: "a.R".to_string(),
                to: "a.R".to_string(),
                base_digest: digest('c'),
            }],
        ),
        Err(PatchValidationError::ConflictingPath(_))
    ));
}

#[test]
fn patch_limits_operations_file_total_hunks_mode_and_encoded_bytes() {
    assert!(matches!(
        CanonicalProjectPatch::new(
            "patch_mode",
            ProjectRevision(1),
            digest('b'),
            PatchPathSemantics::CaseSensitive,
            vec![PatchOperation::Create {
                path: "x".to_string(),
                staged: staged("x", 1),
                mode: 0o4777,
                hunk_count: 1,
            }],
        ),
        Err(PatchValidationError::UnsafeMode)
    ));
    assert!(matches!(
        CanonicalProjectPatch::new(
            "patch_size",
            ProjectRevision(1),
            digest('b'),
            PatchPathSemantics::CaseSensitive,
            vec![PatchOperation::Create {
                path: "x".to_string(),
                staged: staged("x", MAX_PATCH_FILE_BYTES + 1),
                mode: 0o644,
                hunk_count: 1,
            }],
        ),
        Err(PatchValidationError::FileBytes)
    ));
    assert!(matches!(
        CanonicalProjectPatch::new(
            "patch_hunks",
            ProjectRevision(1),
            digest('b'),
            PatchPathSemantics::CaseSensitive,
            vec![PatchOperation::Create {
                path: "x".to_string(),
                staged: staged("x", 1),
                mode: 0o644,
                hunk_count: MAX_PATCH_HUNKS + 1,
            }],
        ),
        Err(PatchValidationError::HunkCount)
    ));
    assert_eq!(
        decode_canonical_patch(&vec![b'x'; MAX_PATCH_BYTES + 1]).unwrap_err(),
        PatchValidationError::PatchBytes
    );
}

#[test]
fn patch_deterministic_path_property_corpus_fails_closed() {
    for index in 0..1000 {
        let path = match index % 5 {
            0 => format!("safe/file_{index}.R"),
            1 => format!("../escape_{index}"),
            2 => format!("/absolute_{index}"),
            3 => format!("case/File_{index}.R"),
            _ => format!("bad\\file_{index}"),
        };
        let result = CanonicalProjectPatch::new(
            format!("patch_{index}"),
            ProjectRevision(index),
            digest('b'),
            PatchPathSemantics::CaseInsensitive,
            vec![PatchOperation::Delete {
                path: path.clone(),
                base_digest: digest('c'),
            }],
        );
        assert_eq!(result.is_ok(), index % 5 == 0 || index % 5 == 3, "{path}");
    }
}
