use rho_annotation_api::*;
use rho_annotation_owner::*;
use rho_annotation_store::AnnotationStore;
use serde_json::json;
use std::sync::Arc;

struct Fixture {
    directory: tempfile::TempDir,
    store: Arc<AnnotationStore>,
    owner: AnnotationOwner,
    author: AnnotationAuthor,
    actor: AnnotationActor,
}
fn actor(principal: &str, window: &str) -> AnnotationActor {
    AnnotationActor::admitted(
        AnnotationScope {
            project: "/project".into(),
            principal: principal.into(),
        },
        AnnotationWindowRef {
            window_id: window.into(),
            incarnation: format!("{window}-life"),
        },
    )
}

fn selection() -> AnnotationSelection {
    AnnotationSelection {
        source: "files".into(),
        label: "analysis.R".into(),
        reference: json!({"path":"analysis.R","expected_sha256":"sha256:abc"}),
        inclusion: "text".into(),
    }
}

fn frozen(version: &str) -> FrozenEvidence {
    FrozenEvidence {
        source: AnnotationSourceRef {
            owner: AnnotationSourceOwner::File,
            source_id: "file:analysis.R".into(),
            source_version: version.into(),
            title: "analysis.R".into(),
        },
        fragment: json!({"quote":"fit <- lm(y ~ x)"}),
        normalized_selection: None,
    }
}

impl Fixture {
    fn new() -> Self {
        let directory = tempfile::tempdir().unwrap();
        let store =
            Arc::new(AnnotationStore::open(&directory.path().join("state.sqlite")).unwrap());
        let author = AnnotationAuthor {
            kind: AnnotationAuthorKind::Human,
            id: "alice".into(),
        };
        Self {
            directory,
            actor: actor("alice", "window"),
            author,
            owner: AnnotationOwner::new(store.clone()),
            store,
        }
    }
    fn command(&self, request_id: &str, command: AnnotationCommand) -> AnnotationsCommand {
        AnnotationsCommand {
            project_root: "/project".into(),
            window: self.actor.window().clone(),
            request_id: request_id.into(),
            command,
        }
    }
    fn freeze(&self, request_id: &str, version: &str, anchor: AnnotationAnchor) -> String {
        let request = self.command(
            request_id,
            AnnotationCommand::Freeze {
                selection: selection(),
                session: None,
                anchor,
            },
        );
        let receipt = self
            .owner
            .freeze(&self.actor, &request, frozen(version), 10)
            .unwrap();
        let AnnotationCommandOutcome::Evidence { evidence_id } = receipt.outcome else {
            panic!("freeze yields evidence")
        };
        evidence_id
    }
    fn create(
        &self,
        request_id: &str,
        evidence_id: &str,
        note: &str,
        now: u64,
    ) -> AnnotationRevisionRef {
        let request = self.command(
            request_id,
            AnnotationCommand::Create {
                evidence_id: evidence_id.into(),
                note: note.into(),
                labels: vec!["question".into()],
                marks: vec![],
                continued_from: None,
            },
        );
        let receipt = self
            .owner
            .write(&self.actor, &self.author, &request, now)
            .unwrap();
        let AnnotationCommandOutcome::Annotation { annotation } = receipt.outcome else {
            panic!("create yields a revision")
        };
        annotation
    }
}

#[test]
fn evidence_is_frozen_once_and_revisions_append_under_cas_with_tombstones() {
    let f = Fixture::new();
    let quote = AnnotationAnchor::TextQuote {
        quote: "fit <- lm(y ~ x)".into(),
        start: 3,
        end: 19,
        unit: AnnotationCharacterUnit::Utf16,
    };
    let evidence_id = f.freeze("freeze-1", "sha256:v1", quote.clone());
    let again = f
        .owner
        .freeze(
            &f.actor,
            &f.command(
                "freeze-1",
                AnnotationCommand::Freeze {
                    selection: selection(),
                    session: None,
                    anchor: quote.clone(),
                },
            ),
            frozen("sha256:v1"),
            11,
        )
        .unwrap();
    assert!(
        matches!(again.outcome, AnnotationCommandOutcome::Evidence { evidence_id: ref id } if *id == evidence_id)
    );

    let first = f.create(
        "create-1",
        &evidence_id,
        "Why is the intercept dropped?",
        20,
    );
    assert_eq!(first.revision, 1);
    let (revision, evidence) = f.owner.read(f.actor.scope(), &first).unwrap();
    assert_eq!(revision.note, "Why is the intercept dropped?");
    assert_eq!(evidence.source.source_version, "sha256:v1");
    assert_eq!(evidence.anchor, quote);
    assert_eq!(revision.author, f.author);

    let update = f.command(
        "update-1",
        AnnotationCommand::Update {
            expected: first.clone(),
            note: "Intercept is implicit.".into(),
            labels: vec![],
            marks: vec![],
        },
    );
    let second = f.owner.write(&f.actor, &f.author, &update, 30).unwrap();
    let AnnotationCommandOutcome::Annotation { annotation: second } = second.outcome else {
        panic!()
    };
    assert_eq!(second.revision, 2);
    let stale = f.command(
        "update-stale",
        AnnotationCommand::Update {
            expected: first.clone(),
            note: "Other window".into(),
            labels: vec![],
            marks: vec![],
        },
    );
    assert!(matches!(
        f.owner.write(&f.actor, &f.author, &stale, 31),
        Err(AnnotationError::Conflict)
    ));
    let (historical, _) = f.owner.read(f.actor.scope(), &first).unwrap();
    assert_eq!(
        historical.note, "Why is the intercept dropped?",
        "earlier revisions remain readable"
    );
    let head = f
        .owner
        .head(f.actor.scope(), &first.annotation_id)
        .unwrap()
        .unwrap();
    assert_eq!(head.note, "Intercept is implicit.");
    assert_eq!(
        head.evidence_id, evidence_id,
        "a text revision never rebinds the source version"
    );

    let (listed, next) = f
        .owner
        .list(f.actor.scope(), Some("file:analysis.R"), None, 10, false)
        .unwrap();
    assert_eq!(listed.len(), 1);
    assert!(next.is_none());
    assert_eq!(listed[0].revision.annotation, second);
    assert_eq!(listed[0].source.source_version, "sha256:v1");

    let delete = f.command(
        "delete-1",
        AnnotationCommand::Delete {
            expected: second.clone(),
        },
    );
    let deleted = f.owner.write(&f.actor, &f.author, &delete, 40).unwrap();
    assert!(matches!(
        deleted.outcome,
        AnnotationCommandOutcome::Annotation {
            annotation: AnnotationRevisionRef { revision: 3, .. }
        }
    ));
    assert!(
        f.owner
            .list(f.actor.scope(), Some("file:analysis.R"), None, 10, false)
            .unwrap()
            .0
            .is_empty()
    );
    let (with_deleted, _) = f
        .owner
        .list(f.actor.scope(), Some("file:analysis.R"), None, 10, true)
        .unwrap();
    assert!(with_deleted[0].revision.deleted);
    let revive = f.command(
        "update-deleted",
        AnnotationCommand::Update {
            expected: with_deleted[0].revision.annotation.clone(),
            note: "back".into(),
            labels: vec![],
            marks: vec![],
        },
    );
    assert!(matches!(
        f.owner.write(&f.actor, &f.author, &revive, 41),
        Err(AnnotationError::Conflict)
    ));
    let (_, evidence_after) = f.owner.read(f.actor.scope(), &first).unwrap();
    assert_eq!(
        evidence_after.fragment,
        json!({"quote":"fit <- lm(y ~ x)"}),
        "evidence outlives tombstones"
    );
}

#[test]
fn receipts_are_durable_idempotent_and_reject_changed_input() {
    let f = Fixture::new();
    let evidence_id = f.freeze("freeze-1", "sha256:v1", AnnotationAnchor::WholeItem);
    let first = f.create("create-1", &evidence_id, "Overall question", 20);
    let replay = f.command(
        "create-1",
        AnnotationCommand::Create {
            evidence_id: evidence_id.clone(),
            note: "Overall question".into(),
            labels: vec!["question".into()],
            marks: vec![],
            continued_from: None,
        },
    );
    let again = f.owner.write(&f.actor, &f.author, &replay, 25).unwrap();
    assert!(
        matches!(again.outcome, AnnotationCommandOutcome::Annotation { annotation } if annotation == first)
    );
    let reopened = AnnotationStore::open(&f.directory.path().join("state.sqlite")).unwrap();
    let owner = AnnotationOwner::new(Arc::new(reopened));
    assert_eq!(
        owner
            .receipt(f.actor.scope(), "create-1")
            .unwrap()
            .unwrap()
            .receipt
            .outcome,
        AnnotationCommandOutcome::Annotation {
            annotation: first.clone()
        }
    );
    assert_eq!(
        owner
            .list(f.actor.scope(), None, None, 10, false)
            .unwrap()
            .0
            .len(),
        1
    );
    let changed = f.command(
        "create-1",
        AnnotationCommand::Create {
            evidence_id,
            note: "Different".into(),
            labels: vec![],
            marks: vec![],
            continued_from: None,
        },
    );
    assert!(matches!(
        f.owner.write(&f.actor, &f.author, &changed, 26),
        Err(AnnotationError::RequestConflict)
    ));
}

#[test]
fn history_continues_across_source_versions_without_moving_marks() {
    let f = Fixture::new();
    let old = f.freeze("freeze-old", "sha256:v1", AnnotationAnchor::WholeItem);
    let first = f.create("create-old", &old, "Old version note", 20);
    let new = f.freeze("freeze-new", "sha256:v2", AnnotationAnchor::WholeItem);
    let same_version = f.command(
        "continue-same",
        AnnotationCommand::Create {
            evidence_id: old.clone(),
            note: "x".into(),
            labels: vec![],
            marks: vec![],
            continued_from: Some(first.clone()),
        },
    );
    assert!(matches!(
        f.owner.write(&f.actor, &f.author, &same_version, 21),
        Err(AnnotationError::InvalidInput(_))
    ));
    let recaptured = f.freeze(
        "freeze-same-version-again",
        "sha256:v1",
        AnnotationAnchor::WholeItem,
    );
    let duplicate_version = f.command(
        "continue-recapture",
        AnnotationCommand::Create {
            evidence_id: recaptured,
            note: "Still the same content".into(),
            labels: vec![],
            marks: vec![],
            continued_from: Some(first.clone()),
        },
    );
    assert!(
        matches!(
            f.owner.write(&f.actor, &f.author, &duplicate_version, 22),
            Err(AnnotationError::InvalidInput(_))
        ),
        "a new evidence ID is not a new source version"
    );
    let continued = f.command(
        "continue",
        AnnotationCommand::Create {
            evidence_id: new.clone(),
            note: "Still true on v2".into(),
            labels: vec![],
            marks: vec![],
            continued_from: Some(first.clone()),
        },
    );
    let receipt = f.owner.write(&f.actor, &f.author, &continued, 30).unwrap();
    let AnnotationCommandOutcome::Annotation { annotation: second } = receipt.outcome else {
        panic!()
    };
    let (revision, evidence) = f.owner.read(f.actor.scope(), &second).unwrap();
    assert_eq!(revision.continued_from, Some(first.clone()));
    assert_eq!(evidence.source.source_version, "sha256:v2");
    let (items, _) = f
        .owner
        .list(f.actor.scope(), Some("file:analysis.R"), None, 10, false)
        .unwrap();
    assert_eq!(items.len(), 2);
    assert_eq!(items[0].source.source_version, "sha256:v2", "newest first");
    assert_eq!(items[1].source.source_version, "sha256:v1");
    let (page, next) = f.owner.list(f.actor.scope(), None, None, 1, false).unwrap();
    assert_eq!(page.len(), 1);
    let (rest, done) = f
        .owner
        .list(f.actor.scope(), None, next.as_deref(), 1, false)
        .unwrap();
    assert_eq!(rest[0].revision.annotation, first);
    assert!(done.is_none());
}

#[test]
fn captures_store_verified_bytes_and_marks_require_captured_views() {
    let f = Fixture::new();
    let png = b"\x89PNG\r\n\x1a\nfixture".to_vec();
    let capture = f.command(
        "capture-1",
        AnnotationCommand::Capture {
            mime_type: "image/png".into(),
            width: 640,
            height: 480,
            base64: String::new(),
            original_media: false,
        },
    );
    let receipt = f.owner.store_capture(&f.actor, &capture, &png, 5).unwrap();
    let AnnotationCommandOutcome::Capture { capture: reference } = receipt.outcome else {
        panic!()
    };
    assert_eq!(reference.byte_size, png.len() as u64);
    let (stored, bytes) = f
        .owner
        .capture(f.actor.scope(), &reference.capture_id)
        .unwrap();
    assert_eq!(stored, reference);
    assert_eq!(bytes, png);
    let mut wrong = reference.clone();
    wrong.width = 1;
    let bad = f.command(
        "freeze-bad",
        AnnotationCommand::Freeze {
            selection: selection(),
            session: None,
            anchor: AnnotationAnchor::CapturedView { capture: wrong },
        },
    );
    assert!(matches!(
        f.owner.freeze(&f.actor, &bad, frozen("sha256:v1"), 6),
        Err(AnnotationError::Conflict)
    ));
    let evidence_id = f.freeze(
        "freeze-1",
        "sha256:v1",
        AnnotationAnchor::CapturedView {
            capture: reference.clone(),
        },
    );
    let marks = vec![
        AnnotationMark::Rectangle {
            x: 0.1,
            y: 0.1,
            width: 0.3,
            height: 0.2,
        },
        AnnotationMark::Text {
            x: 0.5,
            y: 0.5,
            text: "Outlier".into(),
        },
    ];
    let create = f.command(
        "create-1",
        AnnotationCommand::Create {
            evidence_id: evidence_id.clone(),
            note: String::new(),
            labels: vec![],
            marks: marks.clone(),
            continued_from: None,
        },
    );
    let receipt = f.owner.write(&f.actor, &f.author, &create, 10).unwrap();
    let AnnotationCommandOutcome::Annotation { annotation } = receipt.outcome else {
        panic!()
    };
    assert_eq!(
        f.owner.read(f.actor.scope(), &annotation).unwrap().0.marks,
        marks
    );
    let plain = f.freeze("freeze-plain", "sha256:v1", AnnotationAnchor::WholeItem);
    let with_marks = f.command(
        "create-plain",
        AnnotationCommand::Create {
            evidence_id: plain,
            note: "n".into(),
            labels: vec![],
            marks,
            continued_from: None,
        },
    );
    assert!(matches!(
        f.owner.write(&f.actor, &f.author, &with_marks, 11),
        Err(AnnotationError::InvalidInput(_))
    ));
    let outside = f.command(
        "create-outside",
        AnnotationCommand::Create {
            evidence_id,
            note: String::new(),
            labels: vec![],
            marks: vec![AnnotationMark::Rectangle {
                x: 5.0,
                y: 0.0,
                width: 0.1,
                height: 0.1,
            }],
            continued_from: None,
        },
    );
    assert!(matches!(
        f.owner.write(&f.actor, &f.author, &outside, 12),
        Err(AnnotationError::InvalidInput(_))
    ));
    let oversized = vec![0u8; MAX_ANNOTATION_CAPTURE_BYTES + 1];
    let big = f.command(
        "capture-big",
        AnnotationCommand::Capture {
            mime_type: "image/png".into(),
            width: 1,
            height: 1,
            base64: String::new(),
            original_media: false,
        },
    );
    assert!(matches!(
        f.owner.store_capture(&f.actor, &big, &oversized, 13),
        Err(AnnotationError::Budget(_))
    ));
}

#[test]
fn storage_failure_rolls_back_and_other_principals_see_nothing() {
    let f = Fixture::new();
    let evidence_id = f.freeze("freeze-1", "sha256:v1", AnnotationAnchor::WholeItem);
    let raw = rusqlite::Connection::open(f.directory.path().join("state.sqlite")).unwrap();
    raw.execute_batch("CREATE TRIGGER fail_receipt BEFORE INSERT ON annotation_receipts WHEN NEW.request_id='create-1' BEGIN SELECT RAISE(ABORT,'injected receipt failure'); END;").unwrap();
    let create = f.command(
        "create-1",
        AnnotationCommand::Create {
            evidence_id: evidence_id.clone(),
            note: "n".into(),
            labels: vec![],
            marks: vec![],
            continued_from: None,
        },
    );
    assert!(matches!(
        f.owner.write(&f.actor, &f.author, &create, 20),
        Err(AnnotationError::Storage(_))
    ));
    assert!(
        f.owner
            .list(f.actor.scope(), None, None, 10, true)
            .unwrap()
            .0
            .is_empty()
    );
    assert!(
        f.owner
            .receipt(f.actor.scope(), "create-1")
            .unwrap()
            .is_none()
    );
    raw.execute_batch("DROP TRIGGER fail_receipt").unwrap();
    let annotation = f.create("create-1", &evidence_id, "n", 21);
    let bob_actor = actor("bob", "bob-window");
    assert!(matches!(
        f.owner.read(bob_actor.scope(), &annotation),
        Err(AnnotationError::NotFound)
    ));
    assert!(
        f.owner
            .list(bob_actor.scope(), None, None, 10, true)
            .unwrap()
            .0
            .is_empty()
    );
    let mut other_window = f.command(
        "create-2",
        AnnotationCommand::Create {
            evidence_id,
            note: "n".into(),
            labels: vec![],
            marks: vec![],
            continued_from: None,
        },
    );
    other_window.window.incarnation = "elsewhere".into();
    assert!(matches!(
        f.owner.write(&f.actor, &f.author, &other_window, 22),
        Err(AnnotationError::Conflict)
    ));
    let _ = &f.store;
}

#[test]
fn project_identity_and_author_are_preserved_without_source_authority() {
    let f = Fixture::new();
    let evidence = f.freeze("freeze", "sha256:original", AnnotationAnchor::WholeItem);
    let author = AnnotationAuthor {
        kind: AnnotationAuthorKind::Agent,
        id: "agent/task-1".into(),
    };
    let command = f.command(
        "create",
        AnnotationCommand::Create {
            evidence_id: evidence,
            note: "中文 note".into(),
            labels: vec![],
            marks: vec![],
            continued_from: None,
        },
    );
    let receipt = f.owner.write(&f.actor, &author, &command, 20).unwrap();
    let AnnotationCommandOutcome::Annotation { annotation } = receipt.outcome else {
        panic!()
    };
    assert_eq!(
        f.owner.read(f.actor.scope(), &annotation).unwrap().0.author,
        author
    );
    let other_project = AnnotationScope {
        project: "/other".into(),
        principal: "alice".into(),
    };
    assert!(matches!(
        f.owner.read(&other_project, &annotation),
        Err(AnnotationError::NotFound)
    ));
    assert!(f.owner.receipt(&other_project, "create").unwrap().is_none());
    assert!(
        f.owner
            .list(&other_project, None, None, 10, false)
            .unwrap()
            .0
            .is_empty()
    );
    let mut mismatched = command.clone();
    mismatched.project_root = "/other".into();
    assert!(matches!(
        f.owner.write(&f.actor, &author, &mismatched, 21),
        Err(AnnotationError::Conflict)
    ));
}

#[test]
fn separate_connections_commit_one_original_request_and_one_cas_update() {
    let f = Fixture::new();
    let evidence = f.freeze("freeze", "v1", AnnotationAnchor::WholeItem);
    let command = f.command(
        "create",
        AnnotationCommand::Create {
            evidence_id: evidence,
            note: "Original".into(),
            labels: vec![],
            marks: vec![],
            continued_from: None,
        },
    );
    let barrier = Arc::new(std::sync::Barrier::new(2));
    let run = |command: AnnotationsCommand| {
        let store =
            Arc::new(AnnotationStore::open(&f.directory.path().join("state.sqlite")).unwrap());
        let barrier = barrier.clone();
        std::thread::spawn(move || {
            let owner = AnnotationOwner::new(store);
            barrier.wait();
            owner.write(
                &actor("alice", "window"),
                &AnnotationAuthor {
                    kind: AnnotationAuthorKind::Human,
                    id: "alice".into(),
                },
                &command,
                30,
            )
        })
    };
    let left = run(command.clone());
    let right = run(command);
    let first = left.join().unwrap().unwrap();
    assert_eq!(first, right.join().unwrap().unwrap());
    let AnnotationCommandOutcome::Annotation { annotation } = first.outcome else {
        panic!()
    };
    assert_eq!(
        f.owner
            .list(f.actor.scope(), None, None, 10, false)
            .unwrap()
            .0
            .len(),
        1
    );
    let update = |request: &str| {
        f.command(
            request,
            AnnotationCommand::Update {
                expected: annotation.clone(),
                note: request.into(),
                labels: vec![],
                marks: vec![],
            },
        )
    };
    let left = run(update("left"));
    let right = run(update("right"));
    let outcomes = [left.join().unwrap(), right.join().unwrap()];
    assert_eq!(outcomes.iter().filter(|result| result.is_ok()).count(), 1);
    assert_eq!(
        outcomes
            .iter()
            .filter(|result| matches!(result, Err(AnnotationError::Conflict)))
            .count(),
        1
    );
    assert_eq!(
        f.owner
            .head(f.actor.scope(), &annotation.annotation_id)
            .unwrap()
            .unwrap()
            .annotation
            .revision,
        2
    );
    assert_eq!(
        ["left", "right"]
            .iter()
            .filter(|id| f.owner.receipt(f.actor.scope(), id).unwrap().is_some())
            .count(),
        1
    );
}

#[test]
fn project_budget_is_transactional_across_principals_and_tombstones() {
    let f = Fixture::new();
    let evidence = f.freeze("freeze", "v1", AnnotationAnchor::WholeItem);
    let original = f.create("create", &evidence, "n", 20);
    let delete = f.command(
        "delete",
        AnnotationCommand::Delete {
            expected: original.clone(),
        },
    );
    f.owner.write(&f.actor, &f.author, &delete, 21).unwrap();
    // Seed charged private bytes without building thousands of unrelated UI requests.
    let raw = rusqlite::Connection::open(f.directory.path().join("state.sqlite")).unwrap();
    raw.execute(
        "INSERT INTO annotation_captures VALUES(?1,?2,?3,?4,zeroblob(?5))",
        rusqlite::params![
            "/project",
            "bob",
            "budget-fixture",
            "{}",
            MAX_PROJECT_ANNOTATION_BYTES
        ],
    )
    .unwrap();
    let request = f.command(
        "over-budget",
        AnnotationCommand::Create {
            evidence_id: evidence,
            note: "Too much".into(),
            labels: vec![],
            marks: vec![],
            continued_from: None,
        },
    );
    assert!(matches!(
        f.owner.write(&f.actor, &f.author, &request, 22),
        Err(AnnotationError::Budget(_))
    ));
    assert!(
        f.owner
            .receipt(f.actor.scope(), "over-budget")
            .unwrap()
            .is_none()
    );
    let all = f
        .owner
        .list(f.actor.scope(), None, None, 10, true)
        .unwrap()
        .0;
    assert_eq!(all.len(), 1);
    assert!(all[0].revision.deleted);
    assert_eq!(
        f.owner.read(f.actor.scope(), &original).unwrap().0.note,
        "n"
    );
}
