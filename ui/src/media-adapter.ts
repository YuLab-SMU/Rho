import type { MediaAdapter } from "./output-ports";
export const browserMedia: MediaAdapter = {
  async sha256(bytes) {
    const digest = await crypto.subtle.digest("SHA-256", new Uint8Array(bytes).buffer);
    return "sha256:" + [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
  },
  createUrl(bytes, type) { return URL.createObjectURL(new Blob([new Uint8Array(bytes).buffer], { type })); },
  revokeUrl(url) { URL.revokeObjectURL(url); },
};
