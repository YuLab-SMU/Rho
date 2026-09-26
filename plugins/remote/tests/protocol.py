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


class Backend:
    def __init__(self, binary, root, target, configured=True, instance="wire-remote"):
        self.target = target
        self.root = str(root.resolve())
        self.identity = dict(plugin="org.rho.remote", instance=instance,
                             revision="sha256:" + "a" * 64, artifact="sha256:" + "b" * 64)
        self.sequence = 0
        self.received = 0
        self.errors = tempfile.TemporaryFile()
        self.process = subprocess.Popen([binary], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=self.errors)
        try:
            self.send("initialize", "initialize", dict(
                instance=dict(identity=self.identity, project="project", principal="principal", alias="remote",
                              configuration=dict(target=target if configured else None), state="preparing", diagnostic=None),
                grants=[dict(capability=dict(id="operation.get", version=1), scopes=["operation.read"])],
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

    def call(self, request, capability="remote.status", arguments=None, operation=None, prepared=None):
        return dict(request=request, binding=dict(capability=dict(id=capability, version=1 if capability == "remote.status" else 2),
                    provider=self.identity, project="project", target=prepared["target"] if prepared else None), principal="principal",
                    scopes=["project.read", "remote.execute", "slurm.read", "slurm.write", "operation.read"],
                    arguments=prepared["arguments"] if prepared else (arguments or {}), preconditions=None,
                    owner_context=prepared["owner_context"] if prepared else None, operation_id=operation)

    def prepare(self, request, operation, arguments):
        names = {"process.run_remote":"process.prepare_remote", "slurm.submit":"slurm.prepare_submit", "slurm.reconcile":"slurm.prepare_reconcile", "slurm.request_cancel":"slurm.prepare_cancel"}
        call = self.call(request, names[operation], dict(capability=dict(id=operation, version=2), arguments=arguments, target=None, preconditions=None))
        self.send(request, "query", call)
        return self.read(request, "query_result")["data"]

    def start_source(self, request, source, operation="slurm.reconcile"):
        arguments = dict(submission_operation_id=source)
        if operation == "slurm.snapshot":
            call = self.call(request, operation, arguments)
        else:
            name = "slurm.prepare_reconcile" if operation == "slurm.reconcile" else "slurm.prepare_cancel"
            call = self.call(request, name, dict(capability=dict(id=operation, version=2), arguments=arguments, target=None, preconditions=None))
        self.send(request, "query", call)
        reverse = self.receive()
        assert reverse["body"]["type"] == "host_call", reverse
        assert reverse["body"]["data"] == dict(parent_request=request, capability=dict(id="operation.get", version=1), arguments=dict(operation_id=source)), reverse
        return reverse["request"]

    def original(self, call, status="uncertain"):
        return dict(status="ready", completeness="complete", data=dict(record=dict(status=status, operation=dict(
            operation_id=call["operation_id"], idempotency_scope=self.root, capability=call["binding"]["capability"],
            normalized_arguments=dict(binding=call["binding"], arguments=call["arguments"]),
            admission=dict(owner_context=dict(binding=call["binding"], qualification=call["owner_context"]))))))

    def source(self, request, call, operation="slurm.reconcile"):
        reverse = self.start_source(request, call["operation_id"], operation)
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
        self.errors.close()

binary, directory, encoded_target = sys.argv[1:]
root = Path(directory)
target = json.loads(encoded_target)
assert shutil.which("ssh") == str(root.parent / "bin/ssh"), "Only the local fake SSH fixture is allowed"
assert target["host_alias"] == "fixture" and Path(target["project_root"]).parent == root.parent
state_file = Path(os.environ["RHO_TEST_REMOTE_STATE"])
def state(): return json.loads(state_file.read_text())
def save(value): state_file.write_text(json.dumps(value))
backend = Backend(binary, root, target, configured=False)
try:
    backend.send("status", "query", backend.call("status"))
    assert backend.read("status", "query_result")["data"]["target"] is None
    assert not Path(os.environ["RHO_TEST_REMOTE_LOG"]).exists()
    backend.send("release", "release"); backend.read("release", "released")
    assert backend.process.wait(timeout=10) == 0
finally: backend.close()
backend = Backend(binary, root, target)
try:
    prepared = backend.prepare("prepare-first", "process.run_remote", dict(program="printf", args=["wire evidence"]))
    first, plan = backend.invoke("first", "process.run_remote", prepared)
    assert plan["outcome"] == "uncertain" and not plan["cancellation_confirmed"], plan
    assert plan["recovery"]["native_outcome"] == "succeeded"
    assert bytes(plan["recovery"]["stdout"]["bytes"]) == b"wire evidence"
    assert not plan["recovery"]["report_transfer_confirmed"] and not plan["recovery"]["automatic_reexecution"]
    backend.send("release-early", "release"); assert backend.read("release-early", "error")["code"] == "busy"
    assert backend.settle("promoted", first, "succeeded", "error")["code"] == "settlement"
    prepared = backend.prepare("prepare-second", "process.run_remote", dict(program="touch", args=["forbidden"]))
    second = backend.call("second", "process.run_remote", operation="operation-second", prepared=prepared)
    backend.send("second", "invoke", second)
    backend.send("status", "query", backend.call("status"))
    phases = {value["operation"]:value["phase"] for value in backend.read("status", "query_result")["data"]["activities"]}
    assert phases == {first["operation_id"]:"awaiting_settlement",second["operation_id"]:"waiting"}, phases
    backend.send("cancel", "cancel", dict(operation_id=second["operation_id"]))
    assert not backend.read("cancel", "cancel_acknowledged")["confirmed"]
    cancelled = backend.read("second", "commit_plan")
    assert cancelled["outcome"] == "cancelled" and cancelled["cancellation_confirmed"]
    assert not (Path(target["project_root"]) / "forbidden").exists()
    backend.settle("second-settled", second, "cancelled"); backend.settle("first-settled", first, "uncertain")
    backend.settle("settlement-retry", first, "uncertain")
    pending = [(f"source-{i}", backend.start_source(f"source-{i}",f"original-{i}")) for i in range(16)]
    overflow = backend.call("overflow", "slurm.prepare_reconcile", {})
    backend.send("overflow", "query", overflow); assert backend.read("overflow", "error")["code"] == "busy"
    backend.send("release-reading", "release"); assert backend.read("release-reading", "error")["code"] == "busy"
    for parent, reverse in reversed(pending):
        backend.send(reverse, "error", dict(code="not_visible",message="Original is unavailable",recovery=None))
        assert backend.read(parent,"error")["code"] == "not_visible"
    prepared = backend.prepare("prepare-submit", "slurm.submit", dict(body="#SBATCH --array=1-100\nprintf hello"))
    submit, plan = backend.invoke("submit", "slurm.submit", prepared)
    assert plan["outcome"] == "uncertain" and plan["recovery"]["source_operation_id"] == submit["operation_id"], plan
    assert state()["submissions"] == 1
    busy = backend.source("busy-snapshot", submit, "slurm.snapshot")
    assert busy["status"] == "busy" and busy["lookup"] is None, busy
    backend.settle("submit-settled", submit, "uncertain")
    snapshot = backend.source("snapshot", submit, "slurm.snapshot")
    assert snapshot["status"] == "ready" and snapshot["lookup"]["jobs"][0]["state"] == "RUNNING", snapshot
    prepared = backend.source("prepare-reconcile", submit)
    reconcile, plan = backend.invoke("reconcile", "slurm.reconcile", prepared)
    assert plan["outcome"] == "succeeded" and plan["output"]["jobs"][0]["job"]["job_id"] == "4201", plan
    backend.settle("reconcile-settled", reconcile, "succeeded")
    prepared = backend.source("prepare-cancel", submit, "slurm.request_cancel")
    cancel, plan = backend.invoke("cancel-job", "slurm.request_cancel", prepared)
    assert plan["outcome"] == "succeeded" and not plan["cancellation_confirmed"], plan
    assert plan["output"]["request_sent"] and plan["output"]["after"]["state"] == "RUNNING", plan
    backend.settle("cancel-settled", cancel, "succeeded")
    native = state(); native["jobs"].append(dict(native["jobs"][0], id="4202")); save(native)
    prepared = backend.source("prepare-ambiguous", submit, "slurm.request_cancel")
    ambiguous, plan = backend.invoke("ambiguous", "slurm.request_cancel", prepared)
    assert plan["outcome"] == "uncertain" and len(plan["recovery"]["lookup"]["jobs"]) == 2
    assert state()["cancel_requests"] == 1 and state()["submissions"] == 1
    backend.settle("ambiguous-settled", ambiguous, "uncertain")
    # Native start is established by a TCP handshake, not an arbitrary delay.
    listener = socket.socket(); listener.bind(("127.0.0.1",0)); listener.listen(); listener.settimeout(15)
    code = f"const s=require('node:net').connect({listener.getsockname()[1]},'127.0.0.1',()=>s.write('started'));s.on('end',()=>process.exit(0));setInterval(()=>{{}},1000)"
    prepared = backend.prepare("prepare-active", "process.run_remote", dict(program=os.environ["RHO_TEST_NODE"],args=["-e",code]))
    active = backend.call("active", "process.run_remote", operation="operation-active", prepared=prepared)
    backend.send("active","invoke",active)
    peer,_ = listener.accept(); peer.settimeout(15)
    started = b""
    while len(started) < 7:
        chunk = peer.recv(7 - len(started)); assert chunk
        started += chunk
    assert started == b"started"
    backend.send("cancel-active","cancel",dict(operation_id=active["operation_id"]))
    assert not backend.read("cancel-active","cancel_acknowledged")["confirmed"]
    plan = backend.read("active","commit_plan")
    assert plan["outcome"] == "uncertain" and plan["recovery"]["native_outcome"] == "uncertain" and not plan["cancellation_confirmed"], plan
    assert peer.recv(1) == b""; peer.close(); listener.close()
    backend.settle("active-settled",active,"uncertain")
    backend.send("release","release"); backend.read("release","released"); assert backend.process.wait(timeout=10) == 0
finally: backend.close()
# A replacement instance reads the original exact binding; it never replaces it.
backend = Backend(binary, root, target, instance="replacement-remote")
try:
    prepared = backend.source("replacement-source", submit)
    assert prepared["owner_context"]["source"]["binding"] == submit["binding"]
    held, plan = backend.invoke("held", "process.run_remote", backend.prepare("prepare-held", "process.run_remote", dict(program="printf",args=["retained"])))
    assert plan["outcome"] == "uncertain"
    prepared = backend.prepare("prepare-queued", "slurm.submit", dict(body="touch forbidden-submit"))
    queued = backend.call("queued", "slurm.submit", operation="operation-queued", prepared=prepared)
    backend.send("queued","invoke",queued)
    backend.send("unsupported-cancel","cancel",dict(operation_id=queued["operation_id"]))
    assert not backend.read("unsupported-cancel","cancel_acknowledged")["confirmed"]
    backend.send("status","query",backend.call("status")); backend.read("status","query_result")
    backend.process.stdin.close(); assert backend.process.wait(timeout=15) == 0
    assert state()["submissions"] == 1 and not (Path(target["project_root"]) / "forbidden-submit").exists()
finally: backend.close()
backend = Backend(binary, root, target)
try:
    forged = backend.call("forged"); forged["binding"]["provider"]["instance"] = "foreign"
    backend.send("forged","query",forged)
    assert backend.process.wait(timeout=10) != 0
finally: backend.close()
print("Remote framed RPC passed resource-loss uncertainty, original scopes, bounded/reordered reads, native Slurm recovery, cancellation observations, settlement, replacement, EOF and forged-provider refusal. LOCAL ONLY.")
