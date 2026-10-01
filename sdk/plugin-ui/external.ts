/** Public, bounded URL validation. No relative, credential-bearing or executable
 * destination is accepted, and neither query nor fragment is rewritten. */
export function externalUrl(value: string): string {
  if (typeof value !== "string" || new TextEncoder().encode(value).length > 8192 || /[\s\u0000-\u001f\u007f\\]/u.test(value) || !/^https?:\/\//i.test(value))
    throw new Error("External links require a bounded HTTP(S) URL.");
  let url: URL;
  try { url = new URL(value); } catch { throw new Error("The external URL is invalid."); }
  if (!["https:", "http:"].includes(url.protocol) || !url.hostname || url.username || url.password)
    throw new Error("External links cannot contain credentials or another URL scheme.");
  return url.href;
}
