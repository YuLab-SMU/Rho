#!/usr/bin/env python3
"""Validate the structure and provenance of a Rho research package."""

from __future__ import annotations

import argparse
import csv
import json
from pathlib import Path

try:
    import yaml
except ImportError:  # pragma: no cover - the host skill validator already needs PyYAML
    yaml = None


REQUIRED_FILES = [
    "research-intent.yaml",
    "corpus-manifest.csv",
    "paper-matrix.csv",
    "claim-register.csv",
    "positioning-brief.md",
    "evaluation-map.md",
    "source-ledger.md",
    "experiment-protocols/phase-1-internal-ablation.md",
    "experiment-protocols/phase-2-native-workflow.md",
    "run-log.jsonl",
]

REQUIRED_INTENT_KEYS = {
    "research_question",
    "audience",
    "corpus_root",
    "reading_depth",
    "source_policy",
    "output_dir",
}

PAPER_MATRIX_FIELDS = {
    "paper_id",
    "title",
    "problem",
    "task",
    "intervention",
    "comparator",
    "evaluator",
    "metrics",
    "results",
    "limitations",
    "locators",
    "review_status",
}

CLAIM_FIELDS = {
    "claim_id",
    "claim_text",
    "claim_type",
    "claim_status",
    "supporting_sources",
    "warrant",
    "limitation",
    "required_test",
}


def read_csv(path: Path) -> tuple[list[str], list[dict[str, str]]]:
    with path.open(encoding="utf-8", newline="") as handle:
        reader = csv.DictReader(handle)
        return list(reader.fieldnames or []), list(reader)


def nonempty(value: str | None) -> bool:
    return bool(value and value.strip())


def validate(package: Path, draft: bool) -> tuple[bool, dict[str, object]]:
    errors: list[str] = []
    warnings: list[str] = []
    for relative in REQUIRED_FILES:
        if not (package / relative).exists():
            errors.append(f"missing {relative}")

    intent_path = package / "research-intent.yaml"
    intent: dict[str, object] = {}
    if intent_path.exists():
        if yaml is None:
            errors.append("PyYAML is required to read research-intent.yaml")
        else:
            try:
                parsed = yaml.safe_load(intent_path.read_text(encoding="utf-8"))
                if isinstance(parsed, dict):
                    intent = parsed
                else:
                    errors.append("research-intent.yaml must contain a mapping")
            except yaml.YAMLError as exc:
                errors.append(f"invalid research-intent.yaml: {exc}")
        missing = sorted(REQUIRED_INTENT_KEYS - set(intent))
        errors.extend(f"research-intent.yaml missing {key}" for key in missing)

    manifest_rows: list[dict[str, str]] = []
    if (package / "corpus-manifest.csv").exists():
        try:
            manifest_fields, manifest_rows = read_csv(package / "corpus-manifest.csv")
            required = {"source_id", "kind", "relative_path", "sha256", "status"}
            errors.extend(
                f"corpus-manifest.csv missing column {field}"
                for field in sorted(required - set(manifest_fields))
            )
            ids = [row.get("source_id", "") for row in manifest_rows]
            if len(ids) != len(set(ids)):
                errors.append("corpus-manifest.csv contains duplicate source_id values")
        except (OSError, csv.Error) as exc:
            errors.append(f"cannot read corpus-manifest.csv: {exc}")

    matrix_rows: list[dict[str, str]] = []
    if (package / "paper-matrix.csv").exists():
        try:
            matrix_fields, matrix_rows = read_csv(package / "paper-matrix.csv")
            errors.extend(
                f"paper-matrix.csv missing column {field}"
                for field in sorted(PAPER_MATRIX_FIELDS - set(matrix_fields))
            )
            paper_ids = [row.get("paper_id", "") for row in matrix_rows]
            if len(paper_ids) != len(set(paper_ids)):
                errors.append("paper-matrix.csv contains duplicate paper_id values")
            if not draft and len(matrix_rows) != 28:
                errors.append(f"strict package needs 28 paper rows, found {len(matrix_rows)}")
            if draft and len(matrix_rows) < 28:
                warnings.append(f"draft matrix has {len(matrix_rows)} of 28 paper rows")
        except (OSError, csv.Error) as exc:
            errors.append(f"cannot read paper-matrix.csv: {exc}")

    claim_rows: list[dict[str, str]] = []
    if (package / "claim-register.csv").exists():
        try:
            claim_fields, claim_rows = read_csv(package / "claim-register.csv")
            errors.extend(
                f"claim-register.csv missing column {field}"
                for field in sorted(CLAIM_FIELDS - set(claim_fields))
            )
            claim_ids = [row.get("claim_id", "") for row in claim_rows]
            if len(claim_ids) != len(set(claim_ids)):
                errors.append("claim-register.csv contains duplicate claim_id values")
            if not claim_rows:
                warnings.append("claim-register.csv has no claims")
        except (OSError, csv.Error) as exc:
            errors.append(f"cannot read claim-register.csv: {exc}")

    paper_source_ids = {
        row.get("source_id", "")
        for row in manifest_rows
        if row.get("kind") == "paper_pdf"
    }
    matrix_ids = {row.get("paper_id", "") for row in matrix_rows}
    if paper_source_ids and matrix_ids:
        source_stems = {Path(source_id).stem for source_id in paper_source_ids}
        missing = sorted(source_stems - matrix_ids)
        if missing and not draft:
            errors.append(f"paper-matrix.csv is missing paper IDs: {', '.join(missing)}")
        elif missing:
            warnings.append(f"draft matrix is missing paper IDs: {', '.join(missing)}")

    if not draft and matrix_rows:
        pending = [
            row.get("paper_id", "")
            for row in matrix_rows
            if row.get("review_status", "") in {"", "draft", "pending_deep_read"}
        ]
        metadata_only = [
            row.get("paper_id", "")
            for row in matrix_rows
            if row.get("evidence_level", "") in {"", "metadata_only"}
        ]
        index_only = [
            row.get("paper_id", "")
            for row in matrix_rows
            if row.get("locators", "").strip() in {"", "papers/00-INDEX.md"}
        ]
        if pending:
            errors.append("strict package has papers without completed review_status: " + ", ".join(pending))
        if metadata_only:
            errors.append("strict package has metadata-only paper rows: " + ", ".join(metadata_only))
        if index_only:
            errors.append("strict package has paper rows with index-only locators: " + ", ".join(index_only))

        missing_notes = []
        unfinished_notes = []
        for paper_id in sorted(matrix_ids):
            note = package / "paper-notes" / f"{paper_id}.md"
            if not note.exists():
                missing_notes.append(paper_id)
                continue
            note_text = note.read_text(encoding="utf-8")
            if "review_status: pending_deep_read" in note_text or "待深读" in note_text:
                unfinished_notes.append(paper_id)
        if missing_notes:
            errors.append("strict package is missing paper notes: " + ", ".join(missing_notes))
        if unfinished_notes:
            errors.append("strict package has unfinished paper notes: " + ", ".join(unfinished_notes))

    if not draft:
        unresolved = []
        for path in package.rglob("*.md"):
            text = path.read_text(encoding="utf-8")
            if "[[SOURCE NEEDED" in text or "TODO" in text:
                unresolved.append(str(path.relative_to(package)))
        if unresolved:
            errors.append("strict package contains unresolved placeholders: " + ", ".join(unresolved))

    summary = {
        "package": str(package),
        "manifest_sources": len(manifest_rows),
        "paper_rows": len(matrix_rows),
        "claim_rows": len(claim_rows),
        "draft": draft,
        "errors": errors,
        "warnings": warnings,
    }
    return not errors, summary


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("package", type=Path)
    parser.add_argument("--draft", action="store_true", help="allow incomplete paper and claim rows")
    parser.add_argument("--strict", action="store_true", help="require all 28 paper rows and no placeholders")
    args = parser.parse_args()
    if args.draft and args.strict:
        parser.error("choose either --draft or --strict")
    package = args.package.expanduser().resolve()
    if not package.is_dir():
        parser.error(f"package directory does not exist: {package}")
    ok, summary = validate(package, draft=not args.strict)
    print(json.dumps(summary, ensure_ascii=False, indent=2))
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
