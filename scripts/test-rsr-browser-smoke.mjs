import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outputRoot = join(repositoryRoot, "desktop", "dist");
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
const project = encodeURIComponent("/tmp/Rho 科学 Project");
async function dumpDom(url, virtualTimeBudget = 2000, browserArguments = []) {
  const profile = mkdtempSync(join(tmpdir(), "rho-rsr-browser-"));
  let stdout = "";
  let stderr = "";
  const started = Date.now();
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
      ...browserArguments,
      `--user-data-dir=${profile}`,
      `--virtual-time-budget=${virtualTimeBudget}`,
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
    return { stdout, elapsedMs: Date.now() - started };
  } finally {
    rmSync(profile, { recursive: true, force: true });
  }
}

try {
  const standardUrl = `http://127.0.0.1:${address.port}/?preview=bootstrap&project=${project}&health=ready&plugin=surface`;
  const standard = await dumpDom(standardUrl, 2000, ["--window-size=1440,900"]);
  if (!standard.stdout.includes('data-rsr-ready="true"')) throw new Error("RSR browser did not reach the ready state");
  if (!standard.stdout.includes("Rho Surface Runtime") || !standard.stdout.includes("Rho 科学 Project")) {
    throw new Error("RSR browser smoke did not render project identity and foundation shell");
  }
  if (!standard.stdout.includes("Differential expression explorer") || !standard.stdout.includes("Workspace plugin")) {
    throw new Error("RSR browser smoke did not render the declarative workspace-plugin Surface");
  }
  if (!standard.stdout.includes('data-editor-ready="true"')) {
    throw new Error("RSR browser smoke did not activate the lazy Monaco source editor");
  }
  if (!standard.stdout.includes('role="separator"') || !standard.stdout.includes('aria-valuemin="56"')) {
    throw new Error("Studio resize boundaries did not expose their keyboard-accessible separator contract");
  }
  if (!standard.stdout.includes('id="rsrPreviewEvidence"')) throw new Error("RSR browser preview evidence hook is missing");

  const stressUrl = `http://127.0.0.1:${address.port}/?preview=bootstrap&project=${project}&health=ready&mode=vibe&stress=large`;
  const stress = await dumpDom(stressUrl, 3000, [
    "--force-device-scale-factor=2",
    "--window-size=1024,768",
  ]);
  if (!stress.stdout.includes('data-rsr-ready="true"')) throw new Error("large RSR fixture did not reach ready state");
  if (!stress.stdout.includes('"surfaceInstanceCount":') || !stress.stdout.includes('"activePageBlockCount":')) {
    throw new Error("large RSR fixture did not expose bounded scale evidence");
  }
  const evidenceMatch = stress.stdout.match(/<pre id="rsrPreviewEvidence"[^>]*>([^<]+)<\/pre>/u);
  const evidence = evidenceMatch == null ? null : JSON.parse(evidenceMatch[1]);
  if (evidence?.surfaceInstanceCount < 100 || evidence?.activePageBlockCount < 184) {
    throw new Error(`large RSR fixture is undersized: ${JSON.stringify(evidence)}`);
  }
  if (!stress.stdout.includes("مرحبا بالعالم") || !stress.stdout.includes("שלום עולם")) {
    throw new Error("large RSR fixture lost multilingual Page text");
  }
  const mounted = (stress.stdout.match(/data-instance-id=/g) ?? []).length;
  const released = (stress.stdout.match(/data-viewport-state="released"/g) ?? []).length;
  if (mounted > 12 || released < 20) {
    throw new Error(`viewport reclamation budget failed: mounted=${mounted}, released=${released}`);
  }
  if (stress.elapsedMs > 12_000) {
    throw new Error(`large RSR fixture exceeded the local 12s readiness budget: ${stress.elapsedMs}ms`);
  }
  process.stdout.write(`RSR browser smoke passed in ${browser}; large fixture ${stress.elapsedMs}ms, mounted ${mounted}, released ${released}\n`);
} finally {
  await new Promise((resolveClose) => server.close(resolveClose));
}
