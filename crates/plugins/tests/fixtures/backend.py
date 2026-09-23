#!/usr/bin/env python3
"""Language-independent fault-injection plugin; no Rho imports or databases."""
import json
import os
import struct
import sys

sequence = 0
identity = None
connection = None
configuration = {}
pending = {}
reverse = {}


def read():
    length = sys.stdin.buffer.read(4)
    if not length:
        return None
    return json.loads(sys.stdin.buffer.read(struct.unpack(">I", length)[0]))


def send(request, kind, data=None, spoof=False, disorder=False):
    global sequence
    sequence += 1
    body = {"type": kind}
    if data is not None:
        body["data"] = data
    frame = {"protocol_version": 1, "connection": connection,
             "instance": "forged-instance" if spoof else identity["instance"],
             "sequence": sequence + (1 if disorder else 0), "request": request, "body": body}
    encoded = json.dumps(frame).encode()
    sys.stdout.buffer.write(struct.pack(">I", len(encoded)) + encoded)
    sys.stdout.buffer.flush()


def query_result(request, data, **kwargs):
    send(request, "query_result", {"data": data, "completeness": "complete", "source": None}, **kwargs)


def commit(request, cancelled=False, invalid=False):
    send(request, "commit_plan", {"outcome": "cancelled" if cancelled else "succeeded",
         "output": None if cancelled or invalid else {"label": configuration.get("label")},
         "error": None, "recovery": None, "facts": [], "evidence": [], "cancellation_confirmed": cancelled})


frame = read()
identity = frame["body"]["data"]["instance"]["identity"]
connection = frame["connection"]
configuration = frame["body"]["data"]["instance"]["configuration"]
if configuration.get("mode") == "init_hang":
    import time
    time.sleep(60)
if configuration.get("mode") == "init_fail":
    send(frame["request"], "error", {"code": "fixture_failed", "message": "Owner initialization failed", "recovery": None})
    sys.exit(0)
send(frame["request"], "ready", {"revision": identity["revision"], "artifact":
    "sha256:" + "0" * 64 if configuration.get("mode") == "bad_ready" else identity["artifact"]})

while True:
    frame = read()
    if frame is None:
        break
    request = frame["request"]
    kind = frame["body"]["type"]
    data = frame["body"].get("data", {})
    if kind == "release":
        if configuration.get("mode") != "cleanup_fail":
            send(request, "released")
            break
    elif kind == "query":
        args = data["arguments"]
        action = args.get("action", "echo")
        if action == "spoof":
            query_result(request, {}, spoof=True)
        elif action == "disorder":
            query_result(request, {}, disorder=True)
        elif action == "oversize":
            sys.stdout.buffer.write(struct.pack(">I", 1048577))
            sys.stdout.buffer.flush()
        elif action == "logs":
            sys.stderr.buffer.write(b"diagnostic " * 9000)
            sys.stderr.buffer.flush()
            query_result(request, {})
        elif action == "finish":
            for old_request in pending:
                commit(old_request)
            pending.clear()
            query_result(request, {})
        elif action.startswith("delegate"):
            host_request = "backend-" + request
            reverse[host_request] = request
            send(host_request, "host_call", {
                "parent_request": "missing-parent" if action == "delegate_bad_parent" else request,
                "capability": {"id": "undeclared" if action == "delegate_bad_grant" else "host.echo", "version": 1},
                "arguments": args})
        else:
            query_result(request, {"label": configuration.get("label"), "pid": os.getpid(),
                         "instance": identity["instance"], "arguments": args,
                         "host_credential": os.environ.get("RHO_PRIVATE_TEST_CREDENTIAL")})
    elif kind == "invoke":
        action = data["arguments"].get("action", "hold")
        if action == "crash":
            with open(data["arguments"]["marker"], "a") as marker:
                marker.write("executed\n")
            os._exit(17)
        elif action == "badcommit":
            commit(request, invalid=True)
        else:
            pending[request] = data
    elif kind == "cancel":
        confirmed = configuration.get("cancel_confirmed", False)
        send(request, "cancel_acknowledged", {"operation_id": data["operation_id"], "confirmed": confirmed})
        if confirmed:
            for old_request in list(pending):
                if pending[old_request]["operation_id"] == data["operation_id"]:
                    commit(old_request, cancelled=True)
                    del pending[old_request]
    elif kind in ("host_result", "error") and request in reverse:
        original = reverse.pop(request)
        query_result(original, {"delegated": data})
