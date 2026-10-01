/** Host journals scope an explicit invocation request to its originating view.
 * Use this id for original-operation comparisons and bounded request lookup;
 * invoke() itself always receives the unchanged, unscoped request id. */
export async function operationRequestId(view: string, request: string): Promise<string> {
  const bytes = new TextEncoder().encode(`${view}:${request}`);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return `sha256:${Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("")}`;
}
