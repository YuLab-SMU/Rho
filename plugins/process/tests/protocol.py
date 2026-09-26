#!/usr/bin/env python3
"""Standalone executable fault/settlement checks using only public framed RPC."""
import copy
import json
import os
from pathlib import Path
import select
import struct
import subprocess
import sys
import tempfile
import time


class Backend:
    def __init__(self, binary, root):
        self.root = str(root.resolve())
        self.identity = dict(plugin="org.rho.process", instance="wire-process",
                             revision="sha256:" + "a" * 64, artifact="sha256:" + "b" * 64)
        self.sequence = 0
        self.received = 0
        self.errors = tempfile.TemporaryFile()
        self.process = subprocess.Popen([binary], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=self.errors)
        try:
            self.send("initialize", "initialize", dict(
                instance=dict(identity=self.identity, project="project", principal="principal", alias="process",
                              configuration={}, state="preparing", diagnostic=None), grants=[],
                environment=dict(project_root=self.root, data_root=self.root),
                resource_channel=dict(version=1, socket=self.root + "/missing.sock", token="a" * 64)))
            self.read("initialize", "ready")
        except BaseException:
            self.close()
            raise

    def send(self, request, kind, data=None):
        self.sequence += 1
        body = dict(type=kind)
        if data is not None:
            body["data"] = data
        frame = dict(protocol_version=1, connection="wire-connection", instance=self.identity["instance"],
                     sequence=self.sequence, request=request, body=body)
        encoded = json.dumps(frame).encode()
        self.process.stdin.write(struct.pack(">I", len(encoded)) + encoded)
        self.process.stdin.flush()

    def exact(self, size):
        deadline = time.monotonic() + 60
        result = bytearray()
        while len(result) < size:
            remaining = deadline - time.monotonic()
            assert remaining > 0, "Backend reply exceeded 60 seconds"
            ready, _, _ = select.select([self.process.stdout], [], [], remaining)
            assert ready, "Backend reply timed out"
            chunk = os.read(self.process.stdout.fileno(), size - len(result))
            assert chunk, "Backend ended before its complete reply"
            result.extend(chunk)
        return bytes(result)

    def read(self, request, kind):
        size = struct.unpack(">I", self.exact(4))[0]
        assert 0 < size <= 1024 * 1024
        frame = json.loads(self.exact(size))
        self.received += 1
        assert (frame["protocol_version"], frame["connection"], frame["instance"], frame["sequence"]) == (
            1, "wire-connection", self.identity["instance"], self.received), frame
        assert frame["request"] == request and frame["body"]["type"] == kind, frame
        return frame["body"].get("data")

    def call(self, request, operation=None, arguments=None):
        return dict(request=request, binding=dict(capability=dict(id="process.run_local" if operation else "process.status", version=2 if operation else 1),
                    provider=self.identity, project="project", target=self.root), principal="principal",
                    scopes=["project.read", "process.run_local"], arguments=arguments or {}, preconditions=None,
                    owner_context=dict(project_root=self.root) if operation else None, operation_id=operation)

    def settle(self, request, call, outcome, expected="settlement_acknowledged"):
        self.send(request, "operation_settled", dict(operation_id=call["operation_id"], binding=call["binding"], outcome=outcome))
        return self.read(request, expected)

    def close(self):
        if self.process.poll() is None:
            self.process.kill()
            self.process.wait(timeout=10)
        self.process.stdin.close()
        self.process.stdout.close()
        self.errors.close()


with tempfile.TemporaryDirectory(prefix="rho-proc-wire-", dir="/tmp") as directory:
    root = Path(directory)
    backend = Backend(sys.argv[1], root)
    try:
        first = backend.call("first", "original-first", dict(program="/usr/bin/printf", args=["wire evidence"]))
        backend.send("first", "invoke", first)
        plan = backend.read("first", "commit_plan")
        assert plan["outcome"] == "uncertain" and not plan["cancellation_confirmed"], plan
        assert bytes(plan["recovery"]["stdout"]["bytes"]) == b"wire evidence"
        assert not plan["recovery"]["report_transfer_confirmed"] and not plan["recovery"]["automatic_reexecution"]
        backend.send("release-early", "release")
        assert backend.read("release-early", "error")["code"] == "busy"
        assert backend.settle("false-success", first, "succeeded", "error")["code"] == "settlement"
        second = backend.call("second", "original-second", dict(program="/usr/bin/touch", args=[str(root / "forbidden")]))
        backend.send("second", "invoke", second)
        backend.send("status", "query", backend.call("status"))
        status = backend.read("status", "query_result")["data"]
        assert {item["operation"]: item["phase"] for item in status["activities"]} == {
            "original-first": "awaiting_settlement", "original-second": "waiting"}, status
        backend.send("cancel", "cancel", dict(operation_id="original-second"))
        assert backend.read("cancel", "cancel_acknowledged") == dict(operation_id="original-second", confirmed=False)
        cancelled = backend.read("second", "commit_plan")
        assert cancelled["outcome"] == "cancelled" and cancelled["cancellation_confirmed"], cancelled
        assert not (root / "forbidden").exists()
        backend.settle("settle-second", second, "cancelled")
        backend.settle("settle-first", first, "uncertain")
        # Settlement acknowledgement retries must not recreate or re-execute work.
        backend.settle("repeat-settlement", first, "uncertain")
        backend.send("release", "release")
        backend.read("release", "released")
        backend.process.wait(timeout=10)
        assert backend.process.returncode == 0
    finally:
        backend.close()
    backend = Backend(sys.argv[1], root)
    try:
        forged = copy.deepcopy(backend.call("forged"))
        forged["binding"]["provider"]["instance"] = "another-instance"
        backend.send("forged", "query", forged)
        backend.process.wait(timeout=10)
        assert backend.process.returncode != 0, "Forged provider must disconnect without a result"
    finally:
        backend.close()
print("Independent Process RPC passed transfer uncertainty, settlement fencing, queued cancellation, release and identity refusal.")
