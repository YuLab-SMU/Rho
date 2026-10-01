#!/usr/bin/env python3
"""Executable wire/fault check using only public JSON and disposable files."""
import copy
import hashlib
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
        self.identity = dict(instance="files-wire", plugin="org.rho.files",
                             revision="sha256:" + "a" * 64, artifact="sha256:" + "b" * 64)
        self.sequence = 0
        self.received = 0
        self.request = 0
        self.path_reads = 0
        self.errors = tempfile.TemporaryFile()
        self.process = subprocess.Popen([binary], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=self.errors)
        try:
            self.send("initialize", dict(instance=dict(identity=self.identity, project="project-wire", principal="principal-wire", alias="files", configuration={}, state="preparing", diagnostic=None),
                                        grants=[dict(capability=dict(id="workspace.paths", version=1), scopes=["project.read"])],
                                        environment=dict(project_root=self.root, data_root=self.root)))
            ready = self.receive()
            assert ready and ready["body"]["type"] == "ready", ready
            assert self.path_reads == 0  # Initialization never fabricates a parent query.
        except BaseException:
            self.cleanup()
            raise

    def send(self, kind, data=None, request=None):
        self.sequence += 1
        self.request += 1
        request = request or f"host-{self.request}"
        body = dict(type=kind)
        if data is not None:
            body["data"] = data
        frame = dict(protocol_version=1, connection="wire-connection", instance="files-wire",
                     sequence=self.sequence, request=request, body=body)
        encoded = json.dumps(frame, ensure_ascii=False).encode()
        self.process.stdin.write(struct.pack(">I", len(encoded)) + encoded)
        self.process.stdin.flush()
        return request

    def exact(self, size):
        deadline = time.monotonic() + 60
        result = bytearray()
        while len(result) < size:
            remaining = deadline - time.monotonic()
            assert remaining > 0, "Backend response did not arrive within 60 seconds"
            ready, _, _ = select.select([self.process.stdout], [], [], remaining)
            assert ready, "Backend response timed out"
            chunk = os.read(self.process.stdout.fileno(), size - len(result))
            if not chunk:
                assert not result, "Truncated control frame"
                return None
            result.extend(chunk)
        return bytes(result)

    def receive(self):
        header = self.exact(4)
        if header is None:
            return None
        size = struct.unpack(">I", header)[0]
        assert 0 < size <= 1024 * 1024
        frame = json.loads(self.exact(size))
        self.received += 1
        assert (frame["sequence"], frame["connection"], frame["instance"]) == (self.received, "wire-connection", "files-wire")
        return frame

    def reply(self, request):
        frame = self.receive()
        if frame and frame["body"]["type"] == "host_call":
            data = frame["body"]["data"]
            assert data == dict(parent_request=request, capability=dict(id="workspace.paths", version=1), arguments={}), data
            self.path_reads += 1
            self.send("host_result", dict(result=dict(status="ready", completeness="complete", data=dict(project_root=self.root, protected_paths=[self.root + "/private", self.root + "/future-wal"]))), frame["request"])
            frame = self.receive()
        assert frame and frame["request"] == request, frame
        return frame["body"]

    def call(self, capability, arguments, operation=None, preconditions=None):
        self.request += 1
        request = f"call-{self.request}"
        binding = dict(capability=dict(id=capability, version=1), provider=self.identity, project="project-wire", target=self.root)
        return dict(request=request, binding=binding, principal="principal-wire", scopes=["project.read", "project.write"], arguments=arguments,
                    preconditions=preconditions, owner_context=dict(project_root=self.root) if operation else None, operation_id=operation)

    def query(self, capability, arguments):
        call = self.call(capability, arguments)
        self.send("query", call, call["request"])
        return self.reply(call["request"])

    def invoke(self, patch, operation, preconditions=None):
        call = self.call("files.apply_patch", dict(patch=patch), operation, preconditions)
        self.send("invoke", call, call["request"])
        return call

    def settle(self, call, outcome):
        data = dict(operation_id=call["operation_id"], binding=call["binding"], outcome=outcome)
        request = self.send("operation_settled", data)
        assert self.reply(request) == dict(type="settlement_acknowledged", data=data)

    def end(self, expected=0):
        if not self.process.stdin.closed:
            self.process.stdin.close()
        assert self.process.wait(timeout=10) == expected
        self.process.stdout.close()
        self.errors.seek(0)
        errors = self.errors.read().decode(errors="replace")
        self.errors.close()
        return errors

    def cleanup(self):
        if self.process.poll() is None:
            self.process.kill()
            self.process.wait(timeout=10)
        for handle in [self.process.stdin, self.process.stdout, self.errors]:
            handle.close()


def patch(before, after):
    return f"diff --git a/note.txt b/note.txt\n--- a/note.txt\n+++ b/note.txt\n@@ -1 +1 @@\n-{before}\n+{after}\n"


def run(binary):
    with tempfile.TemporaryDirectory(prefix="rho-files-wire-") as directory:
        root = Path(directory)
        (root / "note.txt").write_text("before\n")
        (root / "private").write_text("protected")
        backend = Backend(binary, root)
        try:
            listing = backend.query("files.list_directory", {})
            assert [entry["name"] for entry in listing["data"]["data"]["entries"]] == ["note.txt"]
            assert backend.path_reads == 1
            (root / "future-wal").write_text("protected later")
            for path in ["private", "future-wal", "../escape"]:
                assert backend.query("files.read_file", dict(path=path))["type"] == "error"
            original = backend.invoke(patch("before", "after"), "original")
            result = backend.reply(original["request"])
            assert result["type"] == "commit_plan" and result["data"]["outcome"] == "succeeded", result
            assert result["data"]["facts"][0]["key"] == "original"
            assert backend.query("files.snapshot", {})["data"]["code"] == "busy"
            release = backend.send("release")
            assert backend.reply(release)["data"]["code"] == "busy"
            pending = backend.invoke(patch("after", "not-written"), "pending")
            cancel = backend.send("cancel", dict(operation_id="pending"))
            responses = {frame["request"]: frame["body"] for frame in [backend.receive(), backend.receive()]}
            assert responses[cancel] == dict(type="cancel_acknowledged", data=dict(operation_id="pending", confirmed=False))
            assert responses[pending["request"]]["data"]["outcome"] == "cancelled"
            wrong = dict(operation_id="original", binding=copy.deepcopy(original["binding"]), outcome="succeeded")
            wrong["binding"]["target"] = "/other"
            request = backend.send("operation_settled", wrong)
            assert backend.reply(request)["type"] == "error"
            backend.settle(pending, "cancelled")
            backend.settle(original, "succeeded")
            backend.settle(original, "succeeded")
            stale = backend.invoke(patch("after", "not-written"), "stale", [dict(kind="file.sha256", subject="note.txt", expected="sha256:" + hashlib.sha256(b"before\n").hexdigest())])
            assert backend.reply(stale["request"])["data"]["outcome"] == "failed"
            backend.settle(stale, "failed")
            assert (root / "note.txt").read_text() == "after\n"
            release = backend.send("release")
            assert backend.reply(release) == dict(type="released")
            backend.end()
        finally:
            backend.cleanup()
    for fault in ["foreign_principal", "duplicate_operation", "disconnect_while_waiting"]:
        with tempfile.TemporaryDirectory(prefix="rho-files-fault-") as directory:
            root = Path(directory)
            (root / "note.txt").write_text("before\n")
            backend = Backend(binary, root)
            try:
                if fault == "foreign_principal":
                    call = backend.call("files.read_file", dict(path="note.txt"))
                    call["principal"] = "foreign"
                    backend.send("query", call, call["request"])
                    assert backend.receive() is None
                    backend.end(expected=1)
                    assert (root / "note.txt").read_text() == "before\n"
                else:
                    backend.query("files.snapshot", {})
                    original = backend.invoke(patch("before", "after"), "original")
                    assert backend.reply(original["request"])["data"]["outcome"] == "succeeded"
                    if fault == "duplicate_operation":
                        backend.invoke(patch("after", "must-not-repeat"), "original")
                        assert backend.receive() is None
                        backend.end(expected=1)
                    else:
                        backend.invoke(patch("after", "must-not-start"), "waiting")
                        backend.end()
                    assert (root / "note.txt").read_text() == "after\n"
            finally:
                backend.cleanup()
    print("Files executable protocol passed: protected paths, settlement fences, cancellation truth, duplicate refusal, foreign identity and disconnected pending work.")


if __name__ == "__main__":
    run(str(Path(sys.argv[1]).resolve()))
