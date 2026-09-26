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
import socket
import shutil
import time
import shlex


class Backend:
    def __init__(self, binary, root, configured=True, instance="wire-environment"):
        self.root = str(root.resolve())
        executable = root / "fixture-rscript"
        if not executable.exists():
            executable.write_text("#!/bin/sh\nprintf 'unexpected native start\\n' >> " + shlex.quote(str(root / "native-starts")) + "\nexit 1\n")
            executable.chmod(0o700)
        self.identity = dict(plugin="org.rho.environment", instance=instance,
                             revision="sha256:" + "a" * 64, artifact="sha256:" + "b" * 64)
        self.sequence = 0
        self.received = 0
        self.errors = tempfile.TemporaryFile()
        self.process = subprocess.Popen([binary], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=self.errors)
        try:
            self.send("initialize", "initialize", dict(
                instance=dict(identity=self.identity, project="project", principal="principal", alias="environment",
                              configuration=dict(rscript=str(executable) if configured else None,storage_root=None,timeout_seconds=30), state="preparing", diagnostic=None),
                grants=[dict(capability=dict(id="operation.get", version=1), scopes=["operation.read"]),dict(capability=dict(id="resources.read",version=1),scopes=["resources.read"])],
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

    def receive(self):
        size = struct.unpack(">I", self.exact(4))[0]
        assert 0 < size <= 1024 * 1024
        frame = json.loads(self.exact(size))
        self.received += 1
        assert (frame["protocol_version"], frame["connection"], frame["instance"], frame["sequence"]) == (
            1, "wire-connection", self.identity["instance"], self.received), frame
        return frame

    def read(self, request, kind):
        frame = self.receive()
        assert frame["request"] == request and frame["body"]["type"] == kind, frame
        return frame["body"].get("data")

    def call(self, request, capability="environment.status", arguments=None, operation=None, prepared=None):
        return dict(request=request, binding=dict(capability=dict(id=capability, version=1 if capability == "environment.status" else 2),
                    provider=self.identity, project="project", target=prepared["target"] if prepared else None), principal="principal",
                    scopes=["project.read", "environment.read", "environment.write", "operation.read", "resources.read"],
                    arguments=prepared["arguments"] if prepared else (arguments or {}), preconditions=None,
                    owner_context=prepared["owner_context"] if prepared else None, operation_id=operation)

    def prepare(self, request, operation, arguments):
        names = {"environment."+name:"environment.prepare_"+name for name in ["plan","realize","verify","reconcile","refresh"]}
        call = self.call(request, names[operation], dict(capability=dict(id=operation, version=2), arguments=arguments, target=None, preconditions=None))
        self.send(request, "query", call)
        return self.read(request, "query_result")["data"]

    def start_source(self, request, source):
        call = self.call(request, "environment.prepare_reconcile", dict(capability=dict(id="environment.reconcile",version=2),arguments=dict(operation_id=source),target=None,preconditions=None))
        self.send(request, "query", call)
        reverse = self.receive()
        assert reverse["body"]["type"] == "host_call", reverse
        assert reverse["body"]["data"] == dict(parent_request=request,capability=dict(id="operation.get",version=1),arguments=dict(operation_id=source)), reverse
        return reverse["request"]

    def original(self, call, status="uncertain"):
        return dict(status="ready", completeness="complete", data=dict(record=dict(status=status, operation=dict(
            operation_id=call["operation_id"], idempotency_scope=self.root, capability=call["binding"]["capability"],
            normalized_arguments=dict(binding=call["binding"], arguments=call["arguments"]),
            admission=dict(owner_context=dict(binding=call["binding"], qualification=call["owner_context"]))))))

    def source(self, request, call, operation="environment.reconcile"):
        reverse = self.start_source(request, call["operation_id"])
        self.send(reverse, "host_result", dict(result=self.original(call)))
        return self.read(request, "query_result")["data"]

    def invoke(self, request, operation, prepared):
        call = self.call(request, operation, operation="operation-" + request, prepared=prepared)
        self.send(request, "invoke", call)
        return call, self.read(request, "commit_plan")

    def settle(self, request, call, outcome, expected="settlement_acknowledged"):
        self.send(request, "operation_settled", dict(operation_id=call["operation_id"], binding=call["binding"], outcome=outcome))
        return self.read(request, expected)

    def close(self):
        if self.process.poll() is None:
            self.process.kill()
            self.process.wait(timeout=10)
        if not self.process.stdin.closed:
            self.process.stdin.close()
        self.process.stdout.close()
        self.errors.seek(0)
        diagnostics = self.errors.read()
        if diagnostics:
            (Path(self.root) / f"backend-{self.process.pid}.stderr").write_bytes(diagnostics)
        self.errors.close()


binary = str(Path(sys.argv[1]).resolve())
directory = tempfile.mkdtemp(prefix="rho-environment-wire-")
root = Path(directory).resolve()
complete = False
try:
    backend = Backend(binary, root, configured=False)
    try:
        backend.send("status", "query", backend.call("status"))
        assert backend.read("status", "query_result")["data"]["rscript"] is None
        backend.send("release", "release"); backend.read("release", "released")
        assert backend.process.wait(timeout=10) == 0
    finally: backend.close()
    backend = Backend(binary, root)
    try:
        original = backend.call("original-plan", "environment.plan", operation="original-plan", prepared=backend.prepare("prepare-original", "environment.plan",dict(manager="pak",packages=["local::pkg"])))
        prepared = backend.source("recover-source", original)
        first, result = backend.invoke("recover", "environment.reconcile", prepared)
        assert result["outcome"] == "uncertain" and not result["cancellation_confirmed"], result
        assert result["output"] is None and not result["recovery"]["automatic_reexecution"]
        backend.send("release-early", "release"); assert backend.read("release-early", "error")["code"] == "busy"
        backend.settle("promoted", first, "succeeded", "error")
        prepared = backend.prepare("prepare-second", "environment.plan",dict(manager="pak",packages=["local::must-not-run"]))
        second = backend.call("second", "environment.plan", operation="operation-second", prepared=prepared)
        backend.send("second", "invoke", second)
        backend.send("status", "query", backend.call("status"))
        phases = {item["operation"]:item["phase"] for item in backend.read("status", "query_result")["data"]["activities"]}
        assert phases == {first["operation_id"]:"awaiting_settlement",second["operation_id"]:"waiting"}, phases
        backend.send("cancel", "cancel", dict(operation_id=second["operation_id"]))
        assert not backend.read("cancel", "cancel_acknowledged")["confirmed"]
        cancelled = backend.read("second", "commit_plan")
        assert cancelled["outcome"] == "cancelled" and cancelled["cancellation_confirmed"], cancelled
        assert not (root / "plans").exists() and not (root / "recovery").exists()
        backend.settle("second-settled", second, "cancelled"); backend.settle("first-settled", first, "uncertain")
        backend.settle("settlement-retry", first, "uncertain")
        pending = [(f"source-{i}",backend.start_source(f"source-{i}",f"original-{i}")) for i in range(16)]
        backend.send("overflow", "query", backend.call("overflow","environment.prepare_reconcile",{}))
        assert backend.read("overflow", "error")["code"] == "busy"
        backend.send("release-reading", "release"); assert backend.read("release-reading", "error")["code"] == "busy"
        for parent, reverse in reversed(pending):
            backend.send(reverse, "error", dict(code="not_visible",message="Original unavailable",recovery=None))
            assert "not_visible" in backend.read(parent,"error")["message"]
        reverse = backend.start_source("changed-source", "not-the-original")
        backend.send(reverse,"host_result",dict(result=backend.original(original)))
        backend.read("changed-source","error")
        backend.send("release","release");backend.read("release","released")
        assert backend.process.wait(timeout=10) == 0
    finally: backend.close()
    backend = Backend(binary, root)
    try:
        original = backend.call("original-plan", "environment.plan", operation="original-plan", prepared=backend.prepare("prepare-original", "environment.plan",dict(manager="pak",packages=["local::pkg"])))
        prepared = backend.source("first-source", original)
        first, result = backend.invoke("hold-lane", "environment.reconcile", prepared)
        assert result["outcome"] == "uncertain"
        import hashlib
        recovery = root / "recovery"
        recovery.mkdir()
        marker = recovery / (hashlib.sha256(b"original-plan").hexdigest() + ".json")
        marker_bytes = json.dumps(dict(schema_version=1,operation_id="original-plan",project_root=str(root),marker="PSwirefixture_1700000000",host_process_session_id=None)).encode()
        marker.write_bytes(marker_bytes)
        prepared = backend.source("queued-source", original)
        queued = backend.call("queued", "environment.reconcile", operation="queued-operation", prepared=prepared)
        backend.send("queued","invoke",queued)
        backend.start_source("pending-read","unanswered-original")
        backend.process.stdin.close()
        assert backend.process.wait(timeout=10) == 0
        assert not (root / "native-starts").exists(), "EOF started queued native recovery"
        assert marker.read_bytes() == marker_bytes
    finally: backend.close()
    backend = Backend(binary, root)
    try:
        forged = backend.call("forged"); forged["principal"]="another-principal"
        backend.send("forged","query",forged)
        assert backend.process.wait(timeout=10) != 0
    finally: backend.close()
    complete = True
    print("Standalone Environment wire checks passed: resource failure, settlement fencing, queued cancellation, bounded/reordered source reads, identity refusal and release; no R was launched.")
finally:
    if complete: shutil.rmtree(root)
    else: print(f"Environment wire evidence retained at {root}",file=sys.stderr)
