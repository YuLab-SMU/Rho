#!/usr/bin/env python3
"""Create a deterministic manifest for the Rho research corpus.

The index records source identity and availability. It does not copy, execute or
rewrite source material.
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import json
import re
import shutil
import subprocess
from pathlib import Path


FIELDS = [
    "source_id",
    "kind",
    "title",
    "relative_path",
    "sha256",
    "bytes",
    "pages",
    "role",
    "status",
    "index_locator",
]

PAPER_ROW = re.compile(
    r"^\|\s*(\d{1,2})\s*\|\s*`([^`]+\.pdf)`\s*\|\s*([^|]+?)\s*\|"
)


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def pdf_pages(path: Path) -> str:
    pdfinfo = shutil.which("pdfinfo")
    if not pdfinfo:
        return "unknown"
    try:
        result = subprocess.run(
            [pdfinfo, str(path)],
            check=True,
            capture_output=True,
            text=True,
        )
    except (OSError, subprocess.CalledProcessError):
        return "unknown"
    match = re.search(r"^Pages:\s+(\d+)\s*$", result.stdout, re.MULTILINE)
    return match.group(1) if match else "unknown"


def frontmatter_value(path: Path, key: str) -> str:
    try:
        text = path.read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError):
        return ""
    if not text.startswith("---"):
        return ""
    header = text.split("---", 2)[1]
    match = re.search(rf"^{re.escape(key)}:\s*(.+?)\s*$", header, re.MULTILINE)
    if not match:
        return ""
    return match.group(1).strip().strip('"').strip("'")


def first_heading(path: Path) -> str:
    try:
        for line in path.read_text(encoding="utf-8").splitlines():
            if line.startswith("# "):
                return line[2:].strip()
    except (OSError, UnicodeDecodeError):
        pass
    return path.stem


def paper_titles(index_path: Path) -> dict[str, str]:
    titles: dict[str, str] = {}
    if not index_path.exists():
        return titles
    for line in index_path.read_text(encoding="utf-8").splitlines():
        match = PAPER_ROW.match(line)
        if match:
            titles[match.group(2)] = match.group(3).strip()
    return titles


def source_row(
    corpus_root: Path,
    path: Path,
    *,
    source_id: str,
    kind: str,
    title: str,
    role: str,
    index_locator: str,
) -> dict[str, str]:
    relative = path.relative_to(corpus_root).as_posix()
    try:
        size = path.stat().st_size
    except OSError:
        return {
            "source_id": source_id,
            "kind": kind,
            "title": title,
            "relative_path": relative,
            "sha256": "",
            "bytes": "",
            "pages": "unknown",
            "role": role,
            "status": "unreadable",
            "index_locator": index_locator,
        }
    if size == 0:
        status = "unreadable"
    else:
        status = "available"
    return {
        "source_id": source_id,
        "kind": kind,
        "title": title,
        "relative_path": relative,
        "sha256": sha256(path),
        "bytes": str(size),
        "pages": pdf_pages(path) if kind in {"paper_pdf", "support_pdf"} else "",
        "role": role,
        "status": status,
        "index_locator": index_locator,
    }


def build_rows(corpus_root: Path) -> tuple[list[dict[str, str]], dict[str, int]]:
    papers_dir = corpus_root / "papers"
    notes_dir = corpus_root / "notes"
    paper_index = papers_dir / "00-INDEX.md"
    titles = paper_titles(paper_index)
    rows: list[dict[str, str]] = []

    paper_paths = sorted(papers_dir.glob("*.pdf"))
    for path in paper_paths:
        rows.append(
            source_row(
                corpus_root,
                path,
                source_id=path.name,
                kind="paper_pdf",
                title=titles.get(path.name, path.stem),
                role="primary_paper",
                index_locator="papers/00-INDEX.md",
            )
        )

    support_specs = {
        "fpo.pdf": ("author_slides", "答辩 slides"),
        "Dissertation-finalized.pdf": ("author_dissertation", "学位论文"),
    }
    for filename, (role, title) in support_specs.items():
        path = corpus_root / filename
        if path.exists():
            rows.append(
                source_row(
                    corpus_root,
                    path,
                    source_id=filename,
                    kind="support_pdf",
                    title=title,
                    role=role,
                    index_locator="notes/README.md",
                )
            )

    note_paths = sorted(notes_dir.rglob("*.md")) if notes_dir.exists() else []
    for path in note_paths:
        relative = path.relative_to(corpus_root).as_posix()
        source_id = relative
        title = frontmatter_value(path, "title") or first_heading(path)
        rows.append(
            source_row(
                corpus_root,
                path,
                source_id=source_id,
                kind="note_markdown",
                title=title,
                role="author_notes",
                index_locator="notes/INDEX.md" if path.name != "INDEX.md" else relative,
            )
        )

    for relative, title, role in [
        ("papers/00-INDEX.md", "论文 PDF 索引", "author_notes"),
        ("notes/README.md", "答辩笔记总入口", "author_notes"),
        ("notes/INDEX.md", "全站索引", "author_notes"),
    ]:
        path = corpus_root / relative
        if path.exists() and not any(row["relative_path"] == relative for row in rows):
            rows.append(
                source_row(
                    corpus_root,
                    path,
                    source_id=relative,
                    kind="index",
                    title=title,
                    role=role,
                    index_locator=relative,
                )
            )

    counts = {
        "papers": sum(row["kind"] == "paper_pdf" for row in rows),
        "notes": sum(row["kind"] == "note_markdown" for row in rows),
        "support_pdfs": sum(row["kind"] == "support_pdf" for row in rows),
    }
    return rows, counts


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--corpus", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument(
        "--expected-papers",
        type=int,
        default=28,
        help="Expected paper PDF count. Use 0 to disable the count check.",
    )
    args = parser.parse_args()
    corpus_root = args.corpus.expanduser().resolve()
    if not corpus_root.is_dir():
        parser.error(f"corpus directory does not exist: {corpus_root}")

    rows, counts = build_rows(corpus_root)
    if args.expected_papers and counts["papers"] != args.expected_papers:
        raise SystemExit(
            f"expected {args.expected_papers} paper PDFs, found {counts['papers']}"
        )

    output = args.output.expanduser().resolve()
    output.parent.mkdir(parents=True, exist_ok=True)
    with output.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=FIELDS, lineterminator="\n")
        writer.writeheader()
        writer.writerows(rows)

    print(
        json.dumps(
            {
                "output": str(output),
                "corpus": str(corpus_root),
                **counts,
                "sources": len(rows),
            },
            ensure_ascii=False,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
