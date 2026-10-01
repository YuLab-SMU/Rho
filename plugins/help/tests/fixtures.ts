import type { PackageFileIdentity, PackageHelpPage, PackageIndexPage, RInspection } from "../public/r-protocol/index.js";
import type { HelpCopy } from "../src/help.js";
export const copy: HelpCopy = { nativeSession: "session-a", observation: "packages_a", package: "demo", libraryPath: "/lib one", version: "1.2.3" };
export const indexFiles: PackageFileIdentity[] = ["DESCRIPTION", "NAMESPACE", "help/AnIndex", "INDEX"].map(path => ({ path, digest: `digest-${path}` }));
export const helpFiles: PackageFileIdentity[] = ["DESCRIPTION", "help/AnIndex", "help/demo.rdb", "help/demo.rdx"].map(path => ({ path, digest: `digest-${path}` }));
export const index: PackageIndexPage = { index_ref: "index-a", observation_id: copy.observation, package: copy.package,
  library_path: copy.libraryPath, version: copy.version, files: indexFiles, description: [],
  entries: [{ kind: "topic", name: "demo", topic: "demo", title: "Demonstration", declaration: null, resolved: true }],
  total: 1, offset: 0, next_offset: null, observed_at_ms: 5, complete: true, notices: [] };
export const page: PackageHelpPage = { observation_id: copy.observation, package: copy.package, library_path: copy.libraryPath,
  version: copy.version, topic: "demo", format: "html", found: true, text: "<p>中文</p>", offset_utf8: 0,
  next_offset_utf8: null, total_bytes: 13, complete: true, help_files: helpFiles };
export function ready<T>(data: T): RInspection<T> { return { session_id: copy.nativeSession, status: "ready", source: "native",
  observed_at_ms: 5, completeness: "complete", data: structuredClone(data), notices: [], diagnostic: null }; }
