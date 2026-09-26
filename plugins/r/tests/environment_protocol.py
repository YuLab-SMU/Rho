#!/usr/bin/env python3
"""Independent R executable: delegated reads, failed creation and EOF without R."""
import copy
import hashlib
import json
import os
from pathlib import Path
import select
import shlex
import shutil
import struct
import subprocess
import sys
import tempfile
import time


SCOPES = ["workspace.run_r", "project.read", "environment.read", "environment.write", "operation.read", "resources.read"]


class Backend:
    def __init__(self, binary, root, granted=True):
        self.root = root
        self.identity = dict(plugin="org.rho.r", instance="wire-r", revision="sha256:" + "a" * 64, artifact="sha256:" + "b" * 64)
        self.sequence = self.received = 0
        self.errors = tempfile.TemporaryFile()
        self.process = subprocess.Popen([binary], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=self.errors)
        try:
            self.send("initialize", "initialize", dict(
                instance=dict(identity=self.identity, project="project", principal="principal", alias="r", state="preparing", diagnostic=None,
                              configuration=dict(ark=str(root / "ark"), r_home=str(root / "R"), execution_timeout_seconds=30)),
                grants=[dict(capability=dict(id=name, version=version), scopes=scopes) for name, version, scopes in [
                    ("environment.library", 2, ["project.read", "environment.read", "operation.read", "resources.read"]),
                    ("environment.verify", 2, ["project.read", "environment.write", "operation.read", "resources.read"]),
                    ("resources.read", 1, ["resources.read"])]] if granted else [],
                environment=dict(project_root=str(root), data_root=str(root)),
                resource_channel=dict(version=1, socket=str(root / "missing.sock"), token="a" * 64)))
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
            assert select.select([self.process.stdout], [], [], remaining)[0], "Backend reply timed out"
            chunk = os.read(self.process.stdout.fileno(), size - len(result))
            assert chunk, "Backend ended before its complete reply"
            result.extend(chunk)
        return bytes(result)

    def receive(self):
        size = struct.unpack(">I", self.exact(4))[0]
        assert 0 < size <= 1024 * 1024
        frame = json.loads(self.exact(size))
        self.received += 1
        assert (frame["protocol_version"], frame["connection"], frame["instance"], frame["sequence"]) == (1, "wire-connection", "wire-r", self.received), frame
        return frame

    def read(self, request, kind):
        frame = self.receive()
        assert frame["request"] == request and frame["body"]["type"] == kind, frame
        return frame["body"].get("data")

    def call(self, request, capability="r.session", arguments=None, prepared=None, operation=None):
        return dict(request=request, binding=dict(capability=dict(id=capability, version=1 if capability == "r.session" else 2),
                    provider=self.identity, project="project", target=prepared["target"] if prepared else None), principal="principal", scopes=SCOPES,
                    arguments=prepared["arguments"] if prepared else (arguments or {}), preconditions=None,
                    owner_context=prepared["owner_context"] if prepared else None, operation_id=operation)

    def library(self, original):
        provider = dict(plugin="org.rho.environment", instance="selected-env", revision="sha256:" + "c" * 64, artifact="sha256:" + "d" * 64)
        binding = dict(capability=dict(id="environment.library", version=2), provider=provider, project="project", target="environment-target")
        source = copy.deepcopy(binding)
        source["capability"]["id"] = "environment.realize"
        source["provider"]["instance"] = "previous-env"
        return dict(binding=binding, realization=original, source=source,
                    report=dict(owner=source["provider"], resource="original-report", digest="sha256:" + "e" * 64, bytes=100, media_type="application/json"),
                    project_root=str(self.root), storage_root=str(self.root / "materials"), rscript=str(self.root / "R/bin/Rscript"),
                    library_path=str(self.root / "materials/library"), library_digest="sha256:" + "f" * 64, r_version="4.5", platform="fixture")

    def start_prepare(self, request):
        library = self.library("realization-" + request)
        args = dict(capability=dict(id="r.create_session", version=2), target=None, preconditions=None,
                    arguments=dict(environment=dict(binding=library["binding"], realization=library["realization"])))
        self.send(request, "query", self.call(request, "r.prepare_environment", args))
        return library

    def reverse(self, parent, capability):
        frame = self.receive()
        assert frame["body"]["type"] == "host_call", frame
        call = frame["body"]["data"]
        assert call["parent_request"] == parent and call["capability"] == dict(id=capability, version=2), frame
        return frame

    def prepared(self, request):
        library = self.start_prepare(request)
        reverse = self.reverse(request, "environment.library")
        self.send(reverse["request"], "host_result", dict(result=dict(status="ready", completeness="complete", data=library)))
        return self.read(request, "query_result")["data"]

    def release(self):
        self.send("release", "release")
        self.read("release", "released")
        assert self.process.wait(timeout=10) == 0

    def state(self):
        self.send("session", "query", self.call("session"))
        data = self.read("session", "query_result")["data"]
        assert data["session_id"] is None, data
        return data["state"]

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
            (self.root / f"backend-{self.process.pid}.stderr").write_bytes(diagnostics)
        self.errors.close()


binary = str(Path(sys.argv[1]).resolve())
root = Path(tempfile.mkdtemp(prefix="rho-r-environment-wire-")).resolve()
(root / "R/bin").mkdir(parents=True)
for executable in [root / "ark", root / "R/bin/Rscript"]:
    executable.write_text("#!/bin/sh\nprintf 'unexpected native start\\n' >> " + shlex.quote(str(root / "native-starts")) + "\nexit 1\n")
    executable.chmod(0o700)
complete = False
try:
    backend = Backend(binary, root, granted=False)
    try:
        backend.start_prepare("ungranted")
        assert "selected" in backend.read("ungranted", "error")["message"]
        assert backend.state() == "unstarted"
        backend.release()
    finally:
        backend.close()
    backend = Backend(binary, root)
    try:
        pending = []
        for i in range(16):
            request = f"prepare-{i}"
            library = backend.start_prepare(request)
            reverse = backend.reverse(request, "environment.library")
            assert reverse["body"]["data"]["arguments"]["arguments"]["realization_operation_id"] == library["realization"]
            pending.append((request, reverse["request"], library))
        backend.start_prepare("overflow")
        assert backend.read("overflow", "error")["code"] == "busy"
        backend.send("release-reading", "release")
        assert backend.read("release-reading", "error")["code"] == "busy"
        for parent, request, library in reversed(pending):
            backend.send(request, "host_result", dict(result=dict(status="ready", completeness="complete", data=library)))
            result = backend.read(parent, "query_result")["data"]
            assert result["owner_context"]["environment"] == library
        backend.start_prepare("unavailable")
        reverse = backend.reverse("unavailable", "environment.library")
        backend.send(reverse["request"], "error", dict(code="not_visible", message="Original unavailable", recovery=None))
        assert "not_visible" in backend.read("unavailable", "error")["message"]
        assert backend.state() == "unstarted"
        backend.release()
    finally:
        backend.close()
    for fault in ["lost", "failed", "eof"]:
        backend = Backend(binary, root)
        try:
            prepared = backend.prepared("prepare")
            call = backend.call("create", "r.create_session", prepared=prepared, operation="original-session")
            backend.send("create", "invoke", call)
            reverse = backend.reverse("create", "environment.verify")
            assert reverse["request"] == "r-environment-verify-" + hashlib.sha256(b"original-session").hexdigest()
            if fault == "eof":
                backend.process.stdin.close()
                assert backend.process.wait(timeout=10) == 0, "Pending delegation prevented EOF cleanup"
                continue
            if fault == "lost":
                backend.send(reverse["request"], "error", dict(code="lost_ack", message="Unconfirmed delegated operation", recovery=None))
            else:
                arguments = reverse["body"]["data"]["arguments"]
                record = dict(status="failed", operation=dict(operation_id="verification-operation", causation_id="original-session", idempotency_scope=str(root),
                              capability=dict(id="environment.verify", version=2), normalized_arguments=arguments, admission=dict(owner_context=dict(binding=arguments["binding"]))))
                backend.send(reverse["request"], "host_result", dict(result=record))
            result = backend.read("create", "commit_plan")
            outcome = "uncertain" if fault == "lost" else "failed"
            assert result["outcome"] == outcome and not result["cancellation_confirmed"], result
            assert not result["recovery"]["automatic_reexecution"]
            assert result["recovery"]["verification_operation"] == (None if fault == "lost" else "verification-operation")
            assert backend.state() == ("environment_unconfirmed" if fault == "lost" else "environment_failed")
            backend.send("settled", "operation_settled", dict(operation_id="original-session", binding=call["binding"], outcome=outcome))
            backend.read("settled", "settlement_acknowledged")
            backend.start_prepare("retry")
            assert "already owns" in backend.read("retry", "error")["message"]
            backend.release()
        finally:
            backend.close()
    for fault in ["principal", "reply_kind"]:
        backend = Backend(binary, root)
        try:
            if fault == "principal":
                call = backend.call("forged")
                call["principal"] = "another-principal"
                backend.send("forged", "query", call)
            else:
                backend.start_prepare("wrong-reply")
                reverse = backend.reverse("wrong-reply", "environment.library")
                backend.send(reverse["request"], "release")
            assert backend.process.wait(timeout=10) != 0, "Invalid delegated transport was accepted"
        finally:
            backend.close()
    assert not (root / "native-starts").exists(), "Observation, failed verification or EOF launched native R"
    complete = True
    print("Independent R wire checks passed selected grants, bounded/reversed reads, failed/lost verification, exact child request identity, no replay, settlement, release, forged identity/reply refusal and pending-delegation EOF; no R started.")
finally:
    if complete:
        shutil.rmtree(root)
    else:
        print(f"R wire evidence retained at {root}", file=sys.stderr)
