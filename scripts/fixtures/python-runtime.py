#!/usr/bin/env python3
"""Acceptance runtime using only Python's standard library and public wire v1.

This executes explicitly supplied code as trusted local code, without a sandbox.
Sessions are in memory; only the Host commits Operation records. No Rho imports,
private databases, model, subprocess simulation or canned execution responses.
"""
import contextlib
import io
import json
import os
import struct
import sys
import uuid

wire_in, wire_out = sys.stdin.buffer, sys.stdout.buffer
identity = connection = session = None
namespace = {}
sequence = received = starts = executions = 0


def exact(size):
    result = bytearray()
    while len(result) < size:
        part = wire_in.read(size - len(result))
        if not part:
            if not result:
                raise EOFError()
            raise ValueError("truncated frame")
        result.extend(part)
    return result


def read():
    global received
    size = struct.unpack(">I", exact(4))[0]
    if not 0 < size <= 1048576:
        raise ValueError("invalid frame size")
    frame = json.loads(exact(size))
    assert frame["protocol_version"] == 1
    assert frame["sequence"] == received + 1
    received += 1
    if identity:
        assert frame["instance"] == identity["instance"]
        assert frame["connection"] == connection
    return frame


def send(request, kind, data=None):
    global sequence
    sequence += 1
    body = {"type": kind}
    if data is not None:
        body["data"] = data
    encoded = json.dumps({"protocol_version": 1, "connection": connection,
                          "instance": identity["instance"], "sequence": sequence,
                          "request": request, "body": body}, allow_nan=False).encode()
    assert len(encoded) <= 1048576
    wire_out.write(struct.pack(">I", len(encoded)) + encoded)
    wire_out.flush()


def commit(request, output=None, error=None):
    send(request, "commit_plan", {"outcome": "failed" if error else "succeeded",
         "output": output, "error": error, "recovery": None, "facts": [],
         "evidence": [], "cancellation_confirmed": False})


frame = read()
assert frame["body"]["type"] == "initialize"
identity = frame["body"]["data"]["instance"]["identity"]
connection = frame["connection"]
send(frame["request"], "ready", {"revision": identity["revision"],
     "artifact": identity["artifact"], "features": []})
while True:
    try:
        frame = read()
    except EOFError:
        break
    request, kind = frame["request"], frame["body"]["type"]
    data = frame["body"].get("data", {})
    if kind == "release":
        send(request, "released")
        break
    if kind == "operation_settled":
        assert data["binding"]["provider"] == identity
        send(request, "settlement_acknowledged", data)
        continue
    if kind not in ("query", "invoke"):
        send(request, "error", {"code": "unsupported", "message": kind, "recovery": None})
        continue
    assert data["binding"]["provider"] == identity
    capability, args = data["binding"]["capability"]["id"], data["arguments"]
    if kind == "query" and capability == "example.python.inspect":
        # Bounded observation only: inspecting an inactive session never starts it.
        send(request, "query_result", {"data": {"owner": identity, "pid": os.getpid(),
             "session": session, "starts": starts, "executions": executions, "python": sys.version},
             "completeness": "complete", "source": None})
    elif kind == "invoke" and capability == "example.python.start":
        if session is not None:
            commit(request, error="This instance already has a session")
            continue
        session, namespace = str(uuid.uuid4()), {"__name__": "__rho_external_runtime__"}
        starts += 1
        commit(request, {"owner": identity, "session": session, "pid": os.getpid()})
    elif kind == "invoke" and capability == "example.python.execute":
        if session is None or args["session"] != session:
            commit(request, error="The exact native session is unavailable")
            continue
        executions += 1
        output, errors = io.StringIO(), io.StringIO()
        try:
            with contextlib.redirect_stdout(output), contextlib.redirect_stderr(errors):
                exec(compile(args["source"], "<authorized-plugin-input>", "exec"), namespace)
            result = {"owner": identity, "session": session, "executions": executions,
                      "operation": data["operation_id"], "value": namespace.get("result"),
                      "stdout": output.getvalue(), "stderr": errors.getvalue()}
            json.dumps(result, allow_nan=False)
            commit(request, result)
        except Exception as error:
            # Partial namespace changes remain in the session; no rollback claim.
            commit(request, error=f"{type(error).__name__}: {error}")
    else:
        send(request, "error", {"code": "unsupported", "message": capability, "recovery": None})
