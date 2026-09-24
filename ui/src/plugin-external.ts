// Independently validate at the containing-browser boundary; the remote view's
// optional SDK validation is not a precondition for receiving a wire request.
function externalUrl(value: string): string {
  if (typeof value !== "string" || new TextEncoder().encode(value).length > 8192 || /[\s\u0000-\u001f\u007f\\]/u.test(value) || !/^https?:\/\//i.test(value))
    throw new Error("External links require a bounded HTTP(S) URL.");
  let url: URL;
  try { url = new URL(value); } catch { throw new Error("The external URL is invalid."); }
  if (!["http:", "https:"].includes(url.protocol) || !url.hostname || url.username || url.password)
    throw new Error("External links cannot contain credentials or another URL scheme.");
  return url.href;
}

/** Called synchronously after Host authorization and a current focused gesture.
 * Only a fresh blank tab is used: never target a named/user browsing context. */
export function requestExternalNavigation(value: string, open: () => Window | null = () => window.open("about:blank", "_blank")) {
  const url = externalUrl(value);
  const target = open();
  if (!target) throw new Error("The browser blocked the new tab. Allow this link and try again.");
  try {
    // There is no asynchronous gap before severing the opener. Navigate with a
    // no-referrer link in the blank document so no containing workbench address
    // is sent. The external document never receives a window/credential handle.
    target.opener = null;
    const link = target.document.createElement("a");
    link.href = url; link.rel = "noreferrer noopener"; link.referrerPolicy = "no-referrer"; link.target = "_self";
    target.document.body.append(link); link.click();
    return { navigation_requested: true };
  } catch (error) {
    target.close(); throw new Error(`The browser could not request external navigation: ${error instanceof Error ? error.message : String(error)}`);
  }
}
