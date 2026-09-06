import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

async function deadline(promise, milliseconds, message) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), milliseconds);
    })]);
  } finally { clearTimeout(timer); }
}

export async function verifyEnvironmentRecovery(binary, rscript, fixture) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "rho-crash-recovery-"));
  const project = path.join(directory, "project");
  const database = path.join(directory, "state/next.sqlite");
  const recoveryRoot = path.join(directory, "state/environment/recovery");
  fs.mkdirSync(project);
  fs.cpSync(fixture, path.join(project, "pkg"), { recursive: true });
  const common = ["--database", database, "--project", project, "--rscript", rscript];
  const run = (args, input) => {
    const result = spawnSync(binary, args, { encoding: "utf8", input, timeout: 60_000 });
    assert.equal(result.status, 0, result.error?.message || result.stderr || result.signal);
    return result.stdout;
  };
  const invocation = (id, capability, args, prefix = common) => [...prefix, "invoke",
    "--client-request-id", id, "--capability", capability, "--arguments", JSON.stringify(args)];
  const invoke = (...args) => JSON.parse(run(invocation(...args))).operation;
  const get = (id) => JSON.parse(run(["--database", database, "get-operation", id])).operation;
  const markerPath = (id) => path.join(recoveryRoot, `${createHash("sha256").update(id).digest("hex")}.json`);
  const server = net.createServer();
  let child, ended, socket, socketClosed;
  let childError = "";
  try {
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const started = new Promise((resolve, reject) => server.once("connection", (connection) => {
      socket = connection;
      socketClosed = new Promise((done) => socket.once("close", done));
      socket.on("error", () => {}); // abrupt native termination may reset the socket
      let buffer = "";
      socket.on("data", (data) => {
        buffer += data.toString("utf8");
        if (buffer.length > 256) reject(new Error("invalid installer signal"));
        if (buffer.includes("\n")) resolve(buffer.split("\n")[0]);
      });
    }));
    fs.writeFileSync(path.join(project, "pkg/R/load.R"), `
.onLoad <- function(libname, pkgname) {
  con <- socketConnection("127.0.0.1", port = ${server.address().port}, open = "w", blocking = TRUE)
  writeLines(Sys.getenv("RHO_OPERATION_ID"), con)
  flush(con)
  Sys.sleep(90)
  close(con)
}
`);
    const plan = invoke("plan", "environment.plan", { manager: "pak", packages: ["local::pkg"] });
    assert.equal(plan.status, "succeeded", JSON.stringify(plan));
    const planId = plan.operation.operation_id;
    const args = { plan_operation_id: planId };
    child = spawn(binary, invocation("crashed-install", "environment.realize", args), { stdio: ["ignore", "ignore", "pipe"] });
    child.stderr.on("data", (chunk) => { childError = (childError + chunk).slice(-8000); });
    ended = once(child, "exit");
    const id = await deadline(Promise.race([started, ended.then(() => {
      throw new Error(`installer exited before its native signal: ${childError}`);
    })]), 45_000, "installer did not start");
    assert.match(id, /^op_[a-f0-9]{32}$/u);
    assert.equal(get(id).status, "running");
    const file = markerPath(id);
    const savedMarker = fs.readFileSync(file);
    const native = JSON.parse(savedMarker);
    assert.equal(native.operation_id, id);
    assert.equal(native.project_root, fs.realpathSync(project));
    const assertTreeAlive = () => {
      if (process.platform === "win32") return; // Job Object may stop it on Host death
      const result = spawnSync(rscript, ["--vanilla", "-e", `
p <- ps::ps_find_tree(commandArgs(TRUE)[[1L]])
cat(sum(vapply(p, function(h) ps::ps_is_running(h) && !ps::ps_status(h) %in% c("zombie", "dead"), logical(1))))
`, native.marker], { encoding: "utf8", timeout: 10_000 });
      assert.equal(result.status, 0, result.stderr);
      assert.ok(Number(result.stdout.trim()) > 0, "native tree is not alive");
    };

    child.kill("SIGKILL");
    await ended;
    // A read-only edge neither recovers the journal nor launches cleanup.
    const beforeRead = fs.readFileSync(database);
    assert.equal(get(id).status, "running");
    assert.deepEqual(fs.readFileSync(database), beforeRead);
    assert.deepEqual(fs.readFileSync(file), savedMarker);
    assertTreeAlive();

    // Opening another project can reconcile journal uncertainty, but its owner
    // is not allowed to stop this project's runtime.
    const other = path.join(directory, "other-project");
    fs.mkdirSync(other);
    const wrongProject = invoke("wrong-project", "environment.reconcile", { operation_id: id },
      ["--database", database, "--project", other, "--rscript", rscript]);
    assert.equal(wrongProject.status, "failed");
    const uncertain = get(id);
    assert.equal(uncertain.status, "uncertain");
    if (process.platform !== "win32") assert.equal(socket.destroyed, false, "read or rejected reconciliation stopped installer");
    assertTreeAlive();

    // A copied native marker must not authorize killing another Operation's tree.
    const planFile = markerPath(planId);
    const originalPlanMarker = fs.readFileSync(planFile);
    try {
      fs.writeFileSync(planFile, JSON.stringify({ ...native, operation_id: planId }));
      const wrongTag = invoke("wrong-marker-owner", "environment.reconcile", { operation_id: planId });
      if (process.platform !== "win32") {
        assert.equal(wrongTag.status, "uncertain");
        assert.match(wrongTag.error, /operation identity mismatch/u);
        assert.equal(socket.destroyed, false);
        assertTreeAlive();
      }
    } finally { fs.writeFileSync(planFile, originalPlanMarker); }

    const restored = invoke("recover-install", "environment.reconcile", { operation_id: id });
    assert.equal(restored.status, "succeeded", JSON.stringify(restored));
    assert.equal(restored.output.cleanup_confirmed, true);
    assert.equal(restored.output.source_operation_id, id);
    if (process.platform !== "win32") assert.ok(restored.output.stopped_pids.length > 0);
    assert.ok(restored.output.retained_stage_paths.length > 0);
    for (const stage of restored.output.retained_stage_paths) assert.ok(fs.statSync(stage).isDirectory());
    await deadline(socketClosed, 5_000, "installer survived owner reconciliation");
    assert.deepEqual(get(id), uncertain, "reconciliation rewrote original uncertainty");
    assert.deepEqual(invoke("recover-install", "environment.reconcile", { operation_id: id }), restored);
    assert.deepEqual(invoke("crashed-install", "environment.realize", args), uncertain, "old invocation was replayed");

    const backup = `${file}.saved`;
    fs.renameSync(file, backup);
    try {
      const missing = invoke("missing-reference", "environment.reconcile", { operation_id: id });
      assert.equal(missing.status, "uncertain");
      assert.equal(missing.output.cleanup_confirmed, false);
    } finally { fs.renameSync(backup, file); }
    const repeated = invoke("observe-cleaned-tree", "environment.reconcile", { operation_id: id });
    assert.equal(repeated.status, "succeeded");
    assert.deepEqual(repeated.output.stopped_pids, []);
    console.log("Verified real CLI Host crash, durable native markers, read-only recovery boundary, scoped cleanup, retained staging and immutable uncertainty without replay.");
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) { child.kill("SIGKILL"); await ended; }
    // Only this test's private recovery files are eligible for failure cleanup.
    if (fs.existsSync(recoveryRoot)) for (const name of fs.readdirSync(recoveryRoot)) {
      if (!name.endsWith(".json")) continue;
      const material = JSON.parse(fs.readFileSync(path.join(recoveryRoot, name), "utf8"));
      if (material.project_root !== fs.realpathSync(project)) continue;
      const cleanup = spawnSync(rscript, ["--vanilla", "-e", "ps::ps_kill_tree(commandArgs(TRUE)[[1L]])", material.marker], { timeout: 10_000, stdio: "ignore" });
      assert.equal(cleanup.status, 0, "test-owned process-tree cleanup failed");
    }
    socket?.destroy();
    server.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
}
