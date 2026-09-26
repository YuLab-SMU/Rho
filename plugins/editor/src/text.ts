/** Editor-owned byte encoding and bounded Git patch construction. */
import { createTwoFilesPatch, FILE_HEADERS_ONLY } from "diff";

export const MAX_EDIT_BYTES = 512 * 1024;
export const normalizeText = (raw: string) => raw.replace(/\r\n|\r/g, "\n");
export const bytes = (text: string) => new TextEncoder().encode(text);
export async function sha256(text: string) {
  return (
    "sha256:" +
    Array.from(
      new Uint8Array(await crypto.subtle.digest("SHA-256", bytes(text))),
    )
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("")
  );
}
export function validatePath(path: string) {
  if (
    !path ||
    bytes(path).length > 1024 ||
    /[\\\x00-\x1f\x7f:]/u.test(path) ||
    path.startsWith("/") ||
    path
      .split("/")
      .some((p) => !p || p === "." || p === ".." || p.toLowerCase() === ".git")
  )
    throw new Error("Use a project-relative path without .git or ..");
}
const quotePath = (path: string) => `"${path.replace(/"/g, '\\"')}"`;
export function filePatch(
  path: string,
  before: string | null,
  after: string,
): string {
  validatePath(path);
  if (after.includes("\0"))
    throw new Error("Text contains NUL. The file was not written.");
  const a = quotePath("a/" + path),
    b = quotePath("b/" + path);
  const hunks = createTwoFilesPatch(
    before === null ? "/dev/null" : "a/" + path,
    "b/" + path,
    before ?? "",
    after,
    "",
    "",
    {
      context: 3,
      stripTrailingCr: false,
      timeout: 1000,
      maxEditLength: 20000,
      headerOptions: FILE_HEADERS_ONLY,
    },
  );
  if (hunks === undefined)
    throw new Error("The diff is too large. Your draft is retained.");
  const patch = `diff --git ${a} ${b}\n${before === null ? "new file mode 100644\n" : ""}${hunks}`;
  if (bytes(patch).length > 200 * 1024)
    throw new Error(
      "The save patch exceeds 200 KiB. Your draft is retained; the file was not written.",
    );
  return patch;
}
export function rawOffset(raw: string, offset: number) {
  if (!raw.includes("\r")) return Math.min(offset, raw.length);
  let position = 0;
  for (
    let count = 0;
    count < offset && position < raw.length;
    count++, position++
  ) {
    if (raw[position] === "\r" && raw[position + 1] === "\n") position++;
  }
  return position;
}
