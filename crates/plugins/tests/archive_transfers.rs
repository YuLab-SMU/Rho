use base64::{Engine, engine::general_purpose::STANDARD};
use rho_plugin_protocol::*;
use rho_plugins::*;
use serde_json::json;
use std::{fs, path::Path};
fn package(path: &Path) -> PluginArchive {
    fs::create_dir_all(path.join("dist")).unwrap();
    fs::write(path.join("main.js"), "// 科学\n".repeat(14000)).unwrap();
    fs::write(path.join("deps.lock"), "none").unwrap();
    fs::write(path.join("BUILD.md"), "Copy main.js to dist/index.html").unwrap();
    fs::write(path.join("dist/index.html"), "<p>Independent package</p>").unwrap();
    fs::write(path.join("plugin.json"),serde_json::to_vec(&json!({
        "protocol_version":1,"id":"example.archive","name":"Archive fixture","version":"1","description":"Independent package","license":"MIT",
        "source":{"files":["main.js"],"lockfiles":["deps.lock"],"build_instructions":"BUILD.md","build":null},
        "dependencies":{},"requires":[],"capabilities":[],"contexts":[],"backend":null,
        "views":[{"id":"main","title":"Main","entrypoint":"dist/index.html","state_schema":{"type":"object"},"configuration_schema":{"type":"object"},"resource_kinds":[]}],
        "configuration_schema":{"type":"object"},"default_configuration":{}
    })).unwrap()).unwrap();
    snapshot_directory(path, None, "ui-web").unwrap()
}
fn ids() -> (ProjectId, PrincipalId, OperationId) {
    (
        ProjectId::new("project").unwrap(),
        PrincipalId::new("principal").unwrap(),
        OperationId::new("original").unwrap(),
    )
}
fn reference(id: &str, bytes: &[u8]) -> PluginArchiveReference {
    PluginArchiveReference {
        archive: ArchiveId::new(id).unwrap(),
        digest: content_digest(bytes),
        bytes: bytes.len() as u64,
    }
}
fn chunks(reference: &PluginArchiveReference, bytes: &[u8]) -> Vec<StagePluginArchive> {
    bytes
        .chunks(ARCHIVE_CHUNK_BYTES)
        .enumerate()
        .map(|(i, b)| StagePluginArchive {
            reference: reference.clone(),
            offset: (i * ARCHIVE_CHUNK_BYTES) as u64,
            base64: STANDARD.encode(b),
        })
        .collect()
}
fn stage(
    repo: &mut PluginRepository,
    p: &ProjectId,
    a: &PrincipalId,
    r: &PluginArchiveReference,
    bytes: &[u8],
    now: u64,
) {
    for chunk in chunks(r, bytes) {
        repo.stage_archive(p, a, &chunk, now).unwrap();
    }
}

#[test]
fn immutable_out_of_order_chunks_verify_complete_content_and_native_visibility() {
    let temp = tempfile::tempdir().unwrap();
    let archive = package(&temp.path().join("source"));
    let bytes = serde_json::to_vec_pretty(&archive).unwrap();
    let mut repo = PluginRepository::open(&temp.path().join("store")).unwrap();
    let (p, a, _) = ids();
    let r = reference("upload", &bytes);
    let mut parts = chunks(&r, &bytes);
    parts.reverse();
    repo.stage_archive(&p, &a, &parts[0], 0).unwrap();
    assert!(!repo.archive_progress(&p, &a, &r).unwrap().complete);
    assert!(repo.inspect_archive(&p, &a, &r).is_err());
    for part in &parts {
        repo.stage_archive(&p, &a, part, 0).unwrap();
    }
    assert_eq!(
        repo.archive_progress(&p, &a, &r).unwrap().received,
        bytes.len() as u64
    );
    assert_eq!(
        repo.inspect_archive(&p, &a, &r).unwrap().revision,
        archive.revision.id
    );
    assert!(
        repo.list().unwrap().is_empty(),
        "inspection installed a package"
    );
    let page = repo
        .read_archive_chunk(
            &p,
            &a,
            &ReadPluginArchive {
                reference: r.clone(),
                offset: 65530,
                limit: 40,
            },
        )
        .unwrap();
    assert_eq!(STANDARD.decode(page.base64).unwrap(), bytes[65530..65570]);
    assert_eq!(page.next, Some(65570));
    for (project, principal) in [
        (p.clone(), PrincipalId::new("other").unwrap()),
        (ProjectId::new("other").unwrap(), a.clone()),
    ] {
        assert!(repo.archive_progress(&project, &principal, &r).is_err());
        assert!(repo.inspect_archive(&project, &principal, &r).is_err());
    }
    let mut wrong = parts[0].clone();
    wrong.reference.bytes += 1;
    assert!(repo.stage_archive(&p, &a, &wrong, 0).is_err());
    let mut wrong = parts.last().unwrap().clone();
    wrong.base64 = STANDARD.encode(vec![0; ARCHIVE_CHUNK_BYTES]);
    assert!(repo.stage_archive(&p, &a, &wrong, 0).is_err());
    let mut wrong = parts.last().unwrap().clone();
    wrong.offset = 1;
    assert!(repo.stage_archive(&p, &a, &wrong, 0).is_err());
    let mut corrupt = reference("corrupt", &bytes);
    corrupt.digest = content_digest(b"wrong");
    stage(&mut repo, &p, &a, &corrupt, &bytes, 0);
    assert!(repo.archive_progress(&p, &a, &corrupt).unwrap().complete);
    assert!(repo.inspect_archive(&p, &a, &corrupt).is_err());
    let invalid = b"{\"not\":\"a package\"}";
    let invalid_ref = reference("invalid", invalid);
    stage(&mut repo, &p, &a, &invalid_ref, invalid, 0);
    assert!(repo.inspect_archive(&p, &a, &invalid_ref).is_err());
}
#[test]
fn import_and_receipt_are_atomic_and_preserve_accepted_source_until_settlement() {
    let temp = tempfile::tempdir().unwrap();
    let archive = package(&temp.path().join("source"));
    let bytes = serde_json::to_vec_pretty(&archive).unwrap();
    let root = temp.path().join("store");
    let mut repo = PluginRepository::open(&root).unwrap();
    let (p, a, op) = ids();
    let r = reference("upload", &bytes);
    stage(&mut repo, &p, &a, &r, &bytes, 0);
    assert!(
        repo.import_archive_operation(&p, &a, &op, &r).is_err(),
        "unaccepted import"
    );
    repo.hold_archive(&p, &a, &op, &r).unwrap();
    let db = rusqlite::Connection::open(root.join("catalog-v1.sqlite3")).unwrap();
    db.execute_batch("CREATE TRIGGER reject_receipt BEFORE INSERT ON plugin_archive_receipts BEGIN SELECT RAISE(ABORT,'lost receipt'); END;").unwrap();
    assert!(repo.import_archive_operation(&p, &a, &op, &r).is_err());
    assert!(repo.list().unwrap().is_empty());
    assert!(
        repo.archive_operation_receipt(&p, &a, &op)
            .unwrap()
            .is_none()
    );
    db.execute_batch("DROP TRIGGER reject_receipt;").unwrap();
    let first = repo.import_archive_operation(&p, &a, &op, &r).unwrap();
    assert_eq!(first.revision, archive.revision.id);
    assert!(matches!(
        repo.remove(&first.revision),
        Err(PluginError::Referenced(_))
    ));
    assert_eq!(
        repo.import_archive_operation(&p, &a, &op, &r).unwrap(),
        first
    );
    assert!(
        repo.archive_operation_receipt(&p, &PrincipalId::new("other").unwrap(), &op)
            .unwrap()
            .is_none()
    );
    let other = reference("other", &bytes);
    assert!(repo.import_archive_operation(&p, &a, &op, &other).is_err());
    repo.release_archive(&p, &a, &op, 0).unwrap();
    assert!(repo.discard_archive(&p, &a, &r).unwrap().discarded);
    assert!(repo.discard_archive(&p, &a, &r).unwrap().discarded);
    assert!(repo.archive_progress(&p, &a, &r).is_err());
    repo.release_reference("archive_import", op.as_str(), &first.revision)
        .unwrap();
    repo.remove(&first.revision).unwrap();
    assert_eq!(
        repo.archive_operation_receipt(&p, &a, &op).unwrap(),
        Some(first.clone())
    );
    assert_eq!(
        repo.import_archive_operation(&p, &a, &op, &r).unwrap(),
        first
    );
    assert!(
        repo.list().unwrap().is_empty(),
        "original receipt replay reinstalled removed package"
    );
}
#[test]
fn exports_fix_exact_artifacts_and_rollback_partial_transfers() {
    let temp = tempfile::tempdir().unwrap();
    let archive = package(&temp.path().join("source"));
    let root = temp.path().join("store");
    let mut repo = PluginRepository::open(&root).unwrap();
    repo.import(&archive).unwrap();
    let (p, a, op) = ids();
    let args = ExportPluginArchive {
        revision: archive.revision.id.clone(),
        artifacts: vec![],
    };
    let source = repo
        .export_archive_operation(&p, &a, &op, &args, 0)
        .unwrap();
    assert!(
        repo.inspect_archive(&p, &a, &source.reference)
            .unwrap()
            .artifacts
            .is_empty()
    );
    let all = ExportPluginArchive {
        revision: args.revision.clone(),
        artifacts: archive.artifacts.iter().map(|a| a.id.clone()).collect(),
    };
    assert!(repo.export_archive_operation(&p, &a, &op, &all, 0).is_err());
    let complete = repo
        .export_archive_operation(&p, &a, &OperationId::new("complete").unwrap(), &all, 0)
        .unwrap();
    assert_eq!(complete.artifacts, all.artifacts);
    let exported = repo.validated_archive(&p, &a, &complete.reference).unwrap();
    assert_eq!(
        serde_json::to_value(exported).unwrap(),
        serde_json::to_value(&archive).unwrap()
    );
    let mut upload = chunks(
        &source.reference,
        &serde_json::to_vec(&repo.export_selection(&args).unwrap()).unwrap(),
    )
    .remove(0);
    assert!(repo.stage_archive(&p, &a, &upload, 0).is_err());
    upload.reference.archive = ArchiveId::new("upload").unwrap();
    repo.stage_archive(&p, &a, &upload, 0).unwrap();
    let db = rusqlite::Connection::open(root.join("catalog-v1.sqlite3")).unwrap();
    let before: i64 = db
        .query_row("SELECT COUNT(*) FROM plugin_archives", [], |r| r.get(0))
        .unwrap();
    db.execute_batch("CREATE TRIGGER reject_export BEFORE INSERT ON plugin_archive_receipts BEGIN SELECT RAISE(ABORT,'lost receipt'); END;").unwrap();
    assert!(
        repo.export_archive_operation(&p, &a, &OperationId::new("fail").unwrap(), &all, 0)
            .is_err()
    );
    assert_eq!(
        db.query_row("SELECT COUNT(*) FROM plugin_archives", [], |r| r
            .get::<_, i64>(0))
            .unwrap(),
        before
    );
    let mut duplicates = all.clone();
    duplicates.artifacts.extend(all.artifacts.clone());
    assert!(repo.export_selection(&duplicates).is_err());
}
#[test]
fn declared_capacity_and_expiry_never_discard_accepted_archives_or_mutate_on_reads() {
    let temp = tempfile::tempdir().unwrap();
    let mut repo = PluginRepository::open(temp.path()).unwrap();
    let (p, a, op) = ids();
    let bytes = b"retained";
    let held = reference("held", bytes);
    stage(&mut repo, &p, &a, &held, bytes, 0);
    repo.hold_archive(&p, &a, &op, &held).unwrap();
    assert!(repo.discard_archive(&p, &a, &held).is_err());
    let loose = reference("loose", bytes);
    stage(&mut repo, &p, &a, &loose, bytes, 0);
    assert!(repo.archive_progress(&p, &a, &loose).unwrap().complete);
    let trigger = reference("trigger", bytes);
    let late = 24 * 60 * 60 * 1000;
    stage(&mut repo, &p, &a, &trigger, bytes, late);
    assert!(repo.archive_progress(&p, &a, &loose).is_err());
    assert!(repo.archive_progress(&p, &a, &held).unwrap().complete);
    repo.release_archive(&p, &a, &op, late).unwrap();
    let later = reference("later", bytes);
    stage(&mut repo, &p, &a, &later, bytes, late * 2);
    assert!(repo.archive_progress(&p, &a, &held).is_err());
    let principal = PrincipalId::new("capacity").unwrap();
    let mut chunk = StagePluginArchive {
        reference: PluginArchiveReference {
            archive: ArchiveId::new("large-a").unwrap(),
            digest: content_digest(b"declared"),
            bytes: MAX_PLUGIN_ARCHIVE_BYTES,
        },
        offset: 0,
        base64: STANDARD.encode(vec![0; ARCHIVE_CHUNK_BYTES]),
    };
    repo.stage_archive(&p, &principal, &chunk, late * 2)
        .unwrap();
    chunk.reference.archive = ArchiveId::new("large-b").unwrap();
    repo.stage_archive(&p, &principal, &chunk, late * 2)
        .unwrap();
    chunk.reference.archive = ArchiveId::new("large-c").unwrap();
    assert!(
        repo.stage_archive(&p, &principal, &chunk, late * 2)
            .is_err()
    );
    for id in ["p2", "p3"] {
        let principal = PrincipalId::new(id).unwrap();
        for suffix in ["a", "b"] {
            chunk.reference.archive = ArchiveId::new(suffix).unwrap();
            repo.stage_archive(&p, &principal, &chunk, late * 2)
                .unwrap();
        }
    }
    // One small transfer remains, so the global reservation cannot fit a full eighth archive.
    let principal = PrincipalId::new("p4").unwrap();
    chunk.reference.archive = ArchiveId::new("a").unwrap();
    repo.stage_archive(&p, &principal, &chunk, late * 2)
        .unwrap();
    chunk.reference.archive = ArchiveId::new("b").unwrap();
    assert!(
        repo.stage_archive(&p, &principal, &chunk, late * 2)
            .is_err()
    );
}
