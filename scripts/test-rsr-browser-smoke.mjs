import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outputRoot = join(repositoryRoot, "desktop", "rsr-dist");
const browsers = [
  process.env.RHO_RSR_BROWSER,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/usr/bin/microsoft-edge",
].filter(Boolean);
const browser = browsers.find((candidate) => {
  try {
    return statSync(candidate).isFile();
  } catch {
    return false;
  }
});
if (browser == null) throw new Error("No supported local Chromium browser was found for RSR smoke testing");

const contentTypes = new Map([
  [".css", "text/css; charset=utf-8"],
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
]);

const server = createServer((request, response) => {
  const requestPath = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
  const relativePath = requestPath === "/" ? "index.html" : requestPath.replace(/^\/+/, "");
  const candidate = normalize(join(outputRoot, relativePath));
  if (!candidate.startsWith(`${outputRoot}${sep}`)) {
    response.writeHead(403).end();
    return;
  }
  try {
    const bytes = readFileSync(candidate);
    response.writeHead(200, {
      "Content-Type": contentTypes.get(extname(candidate)) ?? "application/octet-stream",
      "Cache-Control": "no-store",
    });
    response.end(bytes);
  } catch {
    response.writeHead(404).end();
  }
});

await new Promise((resolveListen, rejectListen) => {
  server.once("error", rejectListen);
  server.listen(0, "127.0.0.1", resolveListen);
});

const address = server.address();
if (address == null || typeof address === "string") throw new Error("RSR smoke server did not expose a local port");
const profile = mkdtempSync(join(tmpdir(), "rho-rsr-browser-"));
const project = encodeURIComponent("/tmp/Rho 科学 Project");
const url = `http://127.0.0.1:${address.port}/?preview=bootstrap&project=${project}&health=ready`;

let stdout = "";
let stderr = "";
try {
  const child = spawn(browser, [
    "--headless=new",
    "--disable-background-networking",
    "--disable-component-update",
    "--disable-default-apps",
    "--disable-gpu",
    "--disable-sync",
    "--metrics-recording-only",
    "--no-default-browser-check",
    "--no-first-run",
    `--user-data-dir=${profile}`,
    "--virtual-time-budget=2000",
    "--dump-dom",
    url,
  ], { stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  let resolveDomComplete;
  const domComplete = new Promise((resolveReady) => { resolveDomComplete = resolveReady; });
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
    if (stdout.includes("</html>")) resolveDomComplete();
  });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const exitResult = new Promise((resolveExit, rejectExit) => {
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      rejectExit(new Error(`RSR browser smoke timed out: ${stderr.slice(-2000)}`));
    }, 45_000);
    child.once("error", rejectExit);
    child.once("exit", (code) => {
      clearTimeout(timeout);
      resolveExit(code);
    });
  });
  const result = await Promise.race([
    exitResult.then((exitCode) => ({ kind: "exit", exitCode })),
    domComplete.then(() => ({ kind: "dom", exitCode: null })),
  ]);
  if (result.kind === "dom") {
    // Chrome 151 on macOS can finish --dump-dom but keep its allocator process alive.
    // A complete closing tag is deterministic evidence that dump-dom finished; terminate
    // the now-idle browser so this local gate does not turn into a 45-second false failure.
    child.kill("SIGTERM");
    await Promise.race([
      exitResult.catch(() => null),
      new Promise((resolveKill) => setTimeout(() => {
        child.kill("SIGKILL");
        resolveKill(null);
      }, 2_000)),
    ]);
  } else if (result.exitCode !== 0) {
    throw new Error(`Chromium exited with ${result.exitCode}: ${stderr.slice(-2000)}`);
  }
  if (!stdout.includes('data-rsr-ready="true"')) throw new Error("RSR browser did not reach the ready state");
  if (!stdout.includes("Rho Surface Runtime") || !stdout.includes("Rho 科学 Project")) {
    throw new Error("RSR browser smoke did not render project identity and foundation shell");
  }
  if (!stdout.includes('id="rsrPreviewEvidence"')) throw new Error("RSR browser preview evidence hook is missing");
  process.stdout.write(`RSR browser smoke passed in ${browser}\n`);
} finally {
  await new Promise((resolveClose) => server.close(resolveClose));
  rmSync(profile, { recursive: true, force: true });
}
