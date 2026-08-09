import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  MAX_NOTARY_LOG_BYTES,
  MAX_NOTARY_RECEIPT_BYTES,
  createAppleJwt,
  createPendingRecord,
  decodePrivateKeySecret,
  validateAcceptedRecord,
  validatePendingRecord,
  verifyFinalizerInputs,
  waitForAccepted,
} from "./macos-notary.mjs";

const identity = {
  repository: "YuLab-SMU/Rho_for_mac",
  buildMode: "rehearsal",
  version: "0.4.0-dev.25",
  releaseTag: "v0.4.0-dev.25",
  commit: "a".repeat(40),
  runId: "31000000000",
  runAttempt: "1",
};
const submissionId = "12345678-1234-4abc-8def-1234567890ab";
const issuer = "87654321-4321-4abc-8def-ba0987654321";
const keyId = "ABCDE12345";
const { privateKey, publicKey } = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
const privatePem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const privateSecret = Buffer.from(privatePem, "utf8").toString("base64");

function response(status, value, headers = {}) {
  const body = Buffer.isBuffer(value) ? value : Buffer.from(JSON.stringify(value));
  return { status, headers, body };
}

function statusBody(pending, status = "Accepted", overrides = {}) {
  return {
    data: {
      attributes: {
        createdDate: "2026-08-07T12:00:00.000Z",
        name: pending.submission.artifact_name,
        status,
        ...overrides.attributes,
      },
      id: pending.submission.id,
      type: "submissions",
      ...overrides.data,
    },
    meta: {},
  };
}

function logUrlBody(pending, developerLogUrl) {
  return {
    data: {
      attributes: { developerLogUrl },
      id: pending.submission.id,
      type: "submissionsLog",
    },
    meta: {},
  };
}

function developerLog(pending, overrides = {}) {
  return {
    logFormatVersion: 1,
    jobId: pending.submission.id,
    status: "Accepted",
    statusSummary: "Ready for distribution",
    statusCode: 0,
    archiveFilename: pending.submission.artifact_name,
    uploadDate: "2026-08-07T12:00:00.000Z",
    sha256: pending.submission.sha256,
    ticketContents: null,
    issues: null,
    ...overrides,
  };
}

function pollingHarness(pending, {
  statusResponses = [response(200, statusBody(pending))],
  logUrlResponse,
  developerLogResponse,
  developerLogUrl = "https://osxapps-ssl.itunes.apple.com/notary/developer-log.json?token=bounded-test",
} = {}) {
  const statusQueue = [...statusResponses];
  const calls = [];
  const request = async (options) => {
    calls.push(options);
    if (options.url === `https://appstoreconnect.apple.com/notary/v2/submissions/${pending.submission.id}`) {
      const next = statusQueue.shift();
      if (next instanceof Error) throw next;
      if (!next) throw new Error("Unexpected extra status request");
      return next;
    }
    if (options.url === `https://appstoreconnect.apple.com/notary/v2/submissions/${pending.submission.id}/logs`) {
      return logUrlResponse || response(200, logUrlBody(pending, developerLogUrl));
    }
    if (options.url === developerLogUrl) {
      return developerLogResponse || response(200, developerLog(pending));
    }
    throw new Error(`Unexpected test URL ${new URL(options.url).origin}`);
  };
  let clock = 1_700_000_000_000;
  const sleeps = [];
  return {
    calls,
    sleeps,
    request,
    now: () => clock,
    sleep: async (delay) => {
      sleeps.push(delay);
      clock += delay;
    },
  };
}

async function expectReject(action, pattern) {
  await assert.rejects(action, pattern);
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), "rho-notary-contract-"));
try {
  const dmgPath = path.join(root, "Rho_0.4.0-dev.25_aarch64.dmg");
  const receiptPath = path.join(root, "notary-submit.json");
  fs.writeFileSync(dmgPath, Buffer.from("signed candidate dmg fixture\n"));
  fs.writeFileSync(receiptPath, `${JSON.stringify({
    id: submissionId,
    message: "Successfully uploaded file",
    path: dmgPath,
  })}\n`);

  const pending = createPendingRecord({ receiptPath, dmgPath, ...identity });
  assert.equal(pending.type, "rho_macos_notary_pending");
  assert.equal(pending.status, "pending");
  assert.equal(pending.submission.id, submissionId);
  assert.equal(pending.submission.artifact_name, path.basename(dmgPath));
  assert.equal(pending.submission.size_bytes, fs.statSync(dmgPath).size);
  assert.match(pending.submission.sha256, /^[0-9a-f]{64}$/);
  assert.deepEqual(validatePendingRecord(structuredClone(pending), identity), pending);
  assert.throws(
    () => validatePendingRecord({ ...structuredClone(pending), run_id: "31000000001" }, identity),
    /workflow identity/,
  );
  assert.throws(
    () => validatePendingRecord({ ...structuredClone(pending), extra: true }),
    /keys are invalid/,
  );
  assert.throws(
    () => createPendingRecord({ receiptPath, dmgPath, ...identity, buildMode: "candidate" }),
    /not authorized/,
  );

  const cliPendingPath = path.join(root, "cli", `rho-${identity.version}-macos-notary-pending.json`);
  const cliSubmissionArgs = [
    path.resolve("scripts/macos-notary.mjs"),
    "submission",
    "--receipt", receiptPath,
    "--dmg", dmgPath,
    "--repository", identity.repository,
    "--build-mode", identity.buildMode,
    "--version", identity.version,
    "--tag", identity.releaseTag,
    "--commit", identity.commit,
    "--run-id", identity.runId,
    "--run-attempt", identity.runAttempt,
    "--output", cliPendingPath,
  ];
  const cliSubmission = spawnSync(process.execPath, cliSubmissionArgs, { encoding: "utf8" });
  assert.equal(cliSubmission.status, 0, cliSubmission.stderr);
  assert.match(cliSubmission.stdout, /Recorded pending Apple notarization/);
  assert.deepEqual(JSON.parse(fs.readFileSync(cliPendingPath, "utf8")), pending);
  const duplicateCliSubmission = spawnSync(process.execPath, cliSubmissionArgs, { encoding: "utf8" });
  assert.notEqual(duplicateCliSubmission.status, 0, "Pending evidence must be immutable");

  const oversizedReceipt = path.join(root, "oversized-receipt.json");
  fs.writeFileSync(oversizedReceipt, "x".repeat(MAX_NOTARY_RECEIPT_BYTES + 1));
  assert.throws(
    () => createPendingRecord({ receiptPath: oversizedReceipt, dmgPath, ...identity }),
    /oversized/,
  );

  const symlinkDmg = path.join(root, "linked.dmg");
  try {
    fs.symlinkSync(dmgPath, symlinkDmg, "file");
    assert.throws(
      () => createPendingRecord({ receiptPath, dmgPath: symlinkDmg, ...identity }),
      /name does not match|symlink/,
    );
  } catch (error) {
    if (process.platform !== "win32" || !["EPERM", "EACCES"].includes(error.code)) throw error;
  }

  assert.equal(decodePrivateKeySecret(privateSecret), privatePem);
  assert.throws(() => decodePrivateKeySecret("not-base64"), /invalid|base64/);
  const token = createAppleJwt({ issuer, keyId, privateKey: privatePem, nowSeconds: 1_700_000_000 });
  const [encodedHeader, encodedPayload, encodedSignature] = token.split(".");
  const header = JSON.parse(Buffer.from(encodedHeader, "base64url").toString("utf8"));
  const payload = JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf8"));
  assert.deepEqual(header, { alg: "ES256", kid: keyId, typ: "JWT" });
  assert.deepEqual(payload, {
    iss: issuer,
    iat: 1_700_000_000,
    exp: 1_700_000_120,
    aud: "appstoreconnect-v1",
  });
  assert.equal(
    crypto.verify(
      "sha256",
      Buffer.from(`${encodedHeader}.${encodedPayload}`),
      { key: publicKey, dsaEncoding: "ieee-p1363" },
      Buffer.from(encodedSignature, "base64url"),
    ),
    true,
  );
  assert.throws(
    () => createAppleJwt({ issuer, keyId, privateKey: privatePem, nowSeconds: 1, lifetimeSeconds: 1200 }),
    /time bounds/,
  );

  const successHarness = pollingHarness(pending, {
    statusResponses: [
      response(200, statusBody(pending, "In Progress")),
      response(200, statusBody(pending, "Accepted")),
    ],
  });
  const success = await waitForAccepted(pending, {
    issuer,
    keyId,
    privateKey: privatePem,
    request: successHarness.request,
    sleep: successHarness.sleep,
    now: successHarness.now,
    pollIntervalMs: 1000,
    maxWaitMs: 20_000,
  });
  assert.equal(success.accepted.type, "rho_macos_notary_accepted");
  assert.equal(success.accepted.submission.apple_status, "Accepted");
  assert.equal(success.accepted.submission.log.issue_count, 0);
  assert.deepEqual(validateAcceptedRecord(structuredClone(success.accepted), pending, identity), success.accepted);
  assert.deepEqual(successHarness.sleeps, [1000]);
  const apiCalls = successHarness.calls.filter((call) => call.url.startsWith("https://appstoreconnect.apple.com/"));
  assert.ok(apiCalls.every((call) => /^Bearer [^.]+\.[^.]+\.[^.]+$/.test(call.headers.Authorization)));
  const developerCall = successHarness.calls.find((call) => call.url.includes("osxapps-ssl.itunes.apple.com"));
  assert.ok(developerCall);
  assert.equal(developerCall.headers.Authorization, undefined, "Bearer token must not be sent to the developer-log host");
  assert.ok(successHarness.calls.filter((call) => call.url.endsWith(submissionId)).every((call) => call.url.endsWith(pending.submission.id)));

  const transientHarness = pollingHarness(pending, {
    statusResponses: [
      response(429, { errors: [] }, { "retry-after": "1" }),
      response(503, { errors: [] }),
      response(200, statusBody(pending, "Accepted")),
    ],
  });
  const recovered = await waitForAccepted(pending, {
    issuer,
    keyId,
    privateKey: privatePem,
    request: transientHarness.request,
    sleep: transientHarness.sleep,
    now: transientHarness.now,
    pollIntervalMs: 1000,
    maxWaitMs: 20_000,
  });
  assert.equal(recovered.accepted.status, "accepted");
  assert.deepEqual(transientHarness.sleeps, [1000, 1000]);

  const networkHarness = pollingHarness(pending, {
    statusResponses: [new Error("temporary route failure"), response(200, statusBody(pending, "Accepted"))],
  });
  assert.equal((await waitForAccepted(pending, {
    issuer,
    keyId,
    privateKey: privatePem,
    request: networkHarness.request,
    sleep: networkHarness.sleep,
    now: networkHarness.now,
    pollIntervalMs: 1000,
    maxWaitMs: 20_000,
  })).accepted.status, "accepted");

  for (const status of [401, 403, 404]) {
    const harness = pollingHarness(pending, { statusResponses: [response(status, { errors: [] })] });
    await expectReject(() => waitForAccepted(pending, {
      issuer,
      keyId,
      privateKey: privatePem,
      request: harness.request,
      sleep: harness.sleep,
      now: harness.now,
      pollIntervalMs: 1000,
      maxWaitMs: 20_000,
    }), new RegExp(`HTTP ${status}`));
  }

  for (const status of ["Invalid", "Rejected"]) {
    const harness = pollingHarness(pending, { statusResponses: [response(200, statusBody(pending, status))] });
    await expectReject(() => waitForAccepted(pending, {
      issuer,
      keyId,
      privateKey: privatePem,
      request: harness.request,
      sleep: harness.sleep,
      now: harness.now,
      pollIntervalMs: 1000,
      maxWaitMs: 20_000,
    }), new RegExp(status));
  }

  const unknownHarness = pollingHarness(pending, {
    statusResponses: [response(200, statusBody(pending, "Almost Done"))],
  });
  await expectReject(() => waitForAccepted(pending, {
    issuer,
    keyId,
    privateKey: privatePem,
    request: unknownHarness.request,
    sleep: unknownHarness.sleep,
    now: unknownHarness.now,
    pollIntervalMs: 1000,
    maxWaitMs: 20_000,
  }), /unknown notary status/);

  for (const overrides of [
    { data: { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" } },
    { attributes: { name: "another-candidate.dmg" } },
  ]) {
    const identityMismatchHarness = pollingHarness(pending, {
      statusResponses: [response(200, statusBody(pending, "Accepted", overrides))],
    });
    await expectReject(() => waitForAccepted(pending, {
      issuer,
      keyId,
      privateKey: privatePem,
      request: identityMismatchHarness.request,
      sleep: identityMismatchHarness.sleep,
      now: identityMismatchHarness.now,
      pollIntervalMs: 1000,
      maxWaitMs: 20_000,
    }), /identity|does not match/);
  }

  const malformedHarness = pollingHarness(pending, {
    statusResponses: [response(200, Buffer.from("{broken"))],
  });
  await expectReject(() => waitForAccepted(pending, {
    issuer,
    keyId,
    privateKey: privatePem,
    request: malformedHarness.request,
    sleep: malformedHarness.sleep,
    now: malformedHarness.now,
    pollIntervalMs: 1000,
    maxWaitMs: 20_000,
  }), /not valid JSON/);

  const invalidUtf8Body = Buffer.from(JSON.stringify({ ...statusBody(pending), meta: { note: "MARKER" } }));
  invalidUtf8Body[invalidUtf8Body.indexOf("MARKER")] = 0xff;
  const invalidUtf8Harness = pollingHarness(pending, {
    statusResponses: [response(200, invalidUtf8Body)],
  });
  await expectReject(() => waitForAccepted(pending, {
    issuer,
    keyId,
    privateKey: privatePem,
    request: invalidUtf8Harness.request,
    sleep: invalidUtf8Harness.sleep,
    now: invalidUtf8Harness.now,
    pollIntervalMs: 1000,
    maxWaitMs: 20_000,
  }), /not valid UTF-8 JSON/);

  const oversizedHarness = pollingHarness(pending, {
    statusResponses: [response(200, Buffer.alloc(64 * 1024 + 1, 32))],
  });
  await expectReject(() => waitForAccepted(pending, {
    issuer,
    keyId,
    privateKey: privatePem,
    request: oversizedHarness.request,
    sleep: oversizedHarness.sleep,
    now: oversizedHarness.now,
    pollIntervalMs: 1000,
    maxWaitMs: 20_000,
  }), /byte budget/);

  const timeoutHarness = pollingHarness(pending, {
    statusResponses: [
      response(200, statusBody(pending, "In Progress")),
      response(200, statusBody(pending, "In Progress")),
    ],
  });
  await expectReject(() => waitForAccepted(pending, {
    issuer,
    keyId,
    privateKey: privatePem,
    request: timeoutHarness.request,
    sleep: timeoutHarness.sleep,
    now: timeoutHarness.now,
    pollIntervalMs: 1000,
    maxWaitMs: 1500,
  }), /Timed out/);

  const retryExhaustionHarness = pollingHarness(pending, {
    statusResponses: [response(500, {}), response(500, {}), response(500, {})],
  });
  await expectReject(() => waitForAccepted(pending, {
    issuer,
    keyId,
    privateKey: privatePem,
    request: retryExhaustionHarness.request,
    sleep: retryExhaustionHarness.sleep,
    now: retryExhaustionHarness.now,
    pollIntervalMs: 1000,
    maxWaitMs: 20_000,
    maxTransientErrors: 2,
  }), /exhausted/);

  const untrustedLogHarness = pollingHarness(pending, {
    logUrlResponse: response(200, logUrlBody(pending, "https://example.com/notary-log.json")),
  });
  await expectReject(() => waitForAccepted(pending, {
    issuer,
    keyId,
    privateKey: privatePem,
    request: untrustedLogHarness.request,
    sleep: untrustedLogHarness.sleep,
    now: untrustedLogHarness.now,
    pollIntervalMs: 1000,
    maxWaitMs: 20_000,
  }), /not an allowed HTTPS URL/);

  const exactS3LogHarness = pollingHarness(pending, {
    developerLogUrl: "https://notary-artifacts-prod.s3.amazonaws.com/notary/developer-log.json?X-Amz-Signature=bounded-test",
  });
  assert.equal((await waitForAccepted(pending, {
    issuer,
    keyId,
    privateKey: privatePem,
    request: exactS3LogHarness.request,
    sleep: exactS3LogHarness.sleep,
    now: exactS3LogHarness.now,
    pollIntervalMs: 1000,
    maxWaitMs: 20_000,
  })).accepted.status, "accepted");

  for (const developerLogUrl of [
    "https://another-bucket.s3.amazonaws.com/notary-log.json",
    "https://notary-artifacts-prod.s3.us-west-2.amazonaws.com/notary-log.json",
    "https://notary-artifacts-prod.s3.amazonaws.com.evil.example/notary-log.json",
    "http://notary-artifacts-prod.s3.amazonaws.com/notary-log.json",
    "https://bounded-user@notary-artifacts-prod.s3.amazonaws.com/notary-log.json",
    "https://notary-artifacts-prod.s3.amazonaws.com:444/notary-log.json",
  ]) {
    const arbitraryS3Harness = pollingHarness(pending, {
      logUrlResponse: response(200, logUrlBody(pending, developerLogUrl)),
    });
    await expectReject(() => waitForAccepted(pending, {
      issuer,
      keyId,
      privateKey: privatePem,
      request: arbitraryS3Harness.request,
      sleep: arbitraryS3Harness.sleep,
      now: arbitraryS3Harness.now,
      pollIntervalMs: 1000,
      maxWaitMs: 20_000,
    }), /not an allowed HTTPS URL/);
  }

  const redirectLogHarness = pollingHarness(pending, {
    developerLogResponse: response(302, Buffer.alloc(0), { location: "https://notary-artifacts-prod.s3.amazonaws.com/redirected.json" }),
  });
  await expectReject(() => waitForAccepted(pending, {
    issuer,
    keyId,
    privateKey: privatePem,
    request: redirectLogHarness.request,
    sleep: redirectLogHarness.sleep,
    now: redirectLogHarness.now,
    pollIntervalMs: 1000,
    maxWaitMs: 20_000,
  }), /developer log request failed with HTTP 302/);

  const badLogHarness = pollingHarness(pending, {
    developerLogResponse: response(200, developerLog(pending, { sha256: "b".repeat(64) })),
  });
  await expectReject(() => waitForAccepted(pending, {
    issuer,
    keyId,
    privateKey: privatePem,
    request: badLogHarness.request,
    sleep: badLogHarness.sleep,
    now: badLogHarness.now,
    pollIntervalMs: 1000,
    maxWaitMs: 20_000,
  }), /SHA-256/);

  for (const [overrides, pattern] of [
    [{ jobId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" }, /job ID/],
    [{ status: "Invalid" }, /does not report Accepted/],
    [{ archiveFilename: "another-candidate.dmg" }, /archive name/],
  ]) {
    const logMismatchHarness = pollingHarness(pending, {
      developerLogResponse: response(200, developerLog(pending, overrides)),
    });
    await expectReject(() => waitForAccepted(pending, {
      issuer,
      keyId,
      privateKey: privatePem,
      request: logMismatchHarness.request,
      sleep: logMismatchHarness.sleep,
      now: logMismatchHarness.now,
      pollIntervalMs: 1000,
      maxWaitMs: 20_000,
    }), pattern);
  }

  const oversizedLogHarness = pollingHarness(pending, {
    developerLogResponse: response(200, Buffer.alloc(MAX_NOTARY_LOG_BYTES + 1, 32)),
  });
  await expectReject(() => waitForAccepted(pending, {
    issuer,
    keyId,
    privateKey: privatePem,
    request: oversizedLogHarness.request,
    sleep: oversizedLogHarness.sleep,
    now: oversizedLogHarness.now,
    pollIntervalMs: 1000,
    maxWaitMs: 20_000,
  }), /byte budget/);

  const pendingPath = path.join(root, `rho-${identity.version}-macos-notary-pending.json`);
  const acceptedPath = path.join(root, `rho-${identity.version}-macos-notary-accepted.json`);
  const logPath = path.join(root, success.accepted.submission.log.name);
  fs.writeFileSync(pendingPath, `${JSON.stringify(pending, null, 2)}\n`);
  fs.writeFileSync(acceptedPath, `${JSON.stringify(success.accepted, null, 2)}\n`);
  fs.writeFileSync(logPath, success.logBytes);
  const verified = verifyFinalizerInputs({ pendingPath, acceptedPath, logPath, dmgPath, expected: identity });
  assert.equal(verified.pending.submission.id, submissionId);

  const cliVerify = spawnSync(process.execPath, [
    path.resolve("scripts/macos-notary.mjs"),
    "verify",
    "--pending", pendingPath,
    "--accepted", acceptedPath,
    "--log", logPath,
    "--dmg", dmgPath,
    "--repository", identity.repository,
    "--build-mode", identity.buildMode,
    "--version", identity.version,
    "--tag", identity.releaseTag,
    "--commit", identity.commit,
    "--run-id", identity.runId,
  ], { encoding: "utf8" });
  assert.equal(cliVerify.status, 0, cliVerify.stderr);
  assert.match(cliVerify.stdout, /Verified immutable notarization inputs/);

  const staleAccepted = structuredClone(success.accepted);
  staleAccepted.run_id = "31000000001";
  const staleAcceptedPath = path.join(root, "stale-accepted.json");
  fs.writeFileSync(staleAcceptedPath, `${JSON.stringify(staleAccepted)}\n`);
  assert.throws(
    () => verifyFinalizerInputs({ pendingPath, acceptedPath: staleAcceptedPath, logPath, dmgPath, expected: identity }),
    /workflow identity|does not match/,
  );

  fs.appendFileSync(dmgPath, "tampered");
  assert.throws(
    () => verifyFinalizerInputs({ pendingPath, acceptedPath, logPath, dmgPath, expected: identity }),
    /Submitted DMG does not match/,
  );
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

console.log("macOS asynchronous notarization contract tests passed.");
