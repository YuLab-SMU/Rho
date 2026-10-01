#!/usr/bin/env python3
"""Language-independent fault-injection plugin; no Rho imports or databases."""
import json
import os
import struct
import sys
import socket
import hashlib

sequence = 0
identity = None
connection = None
configuration = {}
pending = {}
pending_controls = set()
pending_queries = set()
reverse = {}
settlements = {}
settlement_requests = {}
invocations = 0
preparations = {}
preparation_requests = {}
cancel_signals = []
deferred_preparations = {}


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


def commit(request, cancelled=False, invalid=False, call=None):
    args = call["arguments"] if call else {}
    facts = [{"schema": "fixture.fact", "key": "" if args.get("action") == "badfact" else "same-native-key",
              "value": args}] if call else []
    output = {"label": configuration.get("label")}
    if call:
        output.update({"operation_id":call["operation_id"], "arguments":args,
                       "owner_context":call.get("owner_context"), "preconditions":call["preconditions"]})
    evidence = [{"owner":identity, "resource":"unverified", "digest":"sha256:" + "0" * 64,
                 "media_type":"text/plain", "bytes":1}] if args.get("action") == "evidence" else []
    send(request, "commit_plan", {"outcome": "cancelled" if cancelled else "succeeded",
         "output": None if cancelled or invalid else output,
         "error": None, "recovery": None, "facts": facts, "evidence": evidence, "cancellation_confirmed": cancelled})


def retain_resource(request, args):
    size = args.get("bytes", 2100003)
    payload = (bytes(range(251)) * ((size + 250) // 251))[:size]
    header = {"version": 1, "token": resource_channel["token"], "parent_request": request,
              "transfer": {"type": "put", "data": {"bytes": len(payload),
                  "digest": "sha256:" + hashlib.sha256(payload).hexdigest(),
                  "media_type": "application/octet-stream"}}}
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as transfer:
        transfer.connect(resource_channel["socket"])
        encoded = json.dumps(header).encode()
        transfer.sendall(struct.pack(">I", len(encoded)) + encoded)
        transfer.sendall(payload)
        transfer.shutdown(socket.SHUT_WR)
        with transfer.makefile("rb") as response:
            size = struct.unpack(">I", response.read(4))[0]
            result = json.loads(response.read(size))
    if result["type"] != "stored":
        raise RuntimeError(result)
    return result["data"]


frame = read()
identity = frame["body"]["data"]["instance"]["identity"]
connection = frame["connection"]
configuration = frame["body"]["data"]["instance"]["configuration"]
environment = frame["body"]["data"].get("environment")
resource_channel = frame["body"]["data"].get("resource_channel")
def retain_count(name):
    if configuration.get("retained_counts"):
        path = os.path.join(environment["data_root"], name)
        try:
            with open(path) as source:
                count = int(source.read())
        except FileNotFoundError:
            count = 0
        with open(path, "w") as output:
            output.write(str(count + 1))
            output.flush()
            os.fsync(output.fileno())

retain_count("starts")
if configuration.get("mode") == "init_hang":
    import time
    time.sleep(60)
if configuration.get("mode") == "init_fail":
    send(frame["request"], "error", {"code": "fixture_failed", "message": "Owner initialization failed", "recovery": None})
    sys.exit(0)
send(frame["request"], "ready", {"revision": identity["revision"], "artifact":
    "sha256:" + "0" * 64 if configuration.get("mode") == "bad_ready" else identity["artifact"],
    "features": ["pending_cancellation_v1"] if configuration.get("pending_cancellation") else []})

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
    elif kind == "prepare_pending_cancellation":
        assert configuration.get("pending_cancellation"), "Host must not probe unsupported RPC extensions"
        operation = data["operation_id"]
        original = next((call for call in pending.values() if call["operation_id"] == operation), None)
        assert original and original["binding"] == data["binding"]
        requests = preparation_requests.setdefault(operation, [])
        requests.append(request)
        prepared = original["arguments"].get("action") != "running"
        if prepared:
            preparations[operation] = data
        if configuration.get("pending_cancellation") == "lose_first" and len(requests) == 1:
            continue
        if configuration.get("pending_cancellation") == "wrong_identity":
            data = {**data, "operation_id": "wrong-operation"}
        answer = {"cancellation": data, "prepared": prepared}
        if configuration.get("pending_cancellation") == "gate":
            deferred_preparations[request] = answer
            continue
        send(request, "pending_cancellation_prepared", answer)
        if configuration.get("pending_cancellation") == "lose_first":
            send(requests[0], "pending_cancellation_prepared", answer)
    elif kind == "operation_settled":
        operation = data["operation_id"]
        assert data["binding"]["provider"] == identity
        previous = settlements.get(operation)
        assert previous is None or previous == data
        settlements[operation] = data
        requests = settlement_requests.setdefault(operation, [])
        requests.append(request)
        if configuration.get("settlement") == "lose_first" and len(requests) == 1:
            continue
        if configuration.get("settlement") == "wrong_identity":
            data = {**data, "operation_id": "another-original-operation"}
        send(request, "settlement_acknowledged", data)
        if configuration.get("settlement") == "lose_first":
            # The delayed first reply has the same request; transport must accept
            # this exact duplicate without affecting a later native operation.
            send(requests[0], "settlement_acknowledged", data)
    elif kind == "query":
        args = data["arguments"]
        if data["binding"]["capability"]["id"] == "fixture.prepare":
            query_result(request, {"arguments": {**args["arguments"], "normalized":True},
                "target": "different" if configuration.get("retarget") else args["target"] or "native-selected",
                "owner_context":{"native_session":"fixed-session"}})
            continue
        action = args.get("action", "echo")
        if action == "confirm_preparation":
            for original_request, answer in deferred_preparations.items():
                send(original_request, "pending_cancellation_prepared", answer)
            deferred_preparations.clear()
            query_result(request, {})
        elif action == "cancellation_state":
            query_result(request, {"preparations": preparations, "requests": preparation_requests,
                "signals": cancel_signals, "invocations": invocations})
        elif action == "settlement_state":
            query_result(request, {"settlements": settlements, "requests": settlement_requests, "invocations": invocations})
        elif action == "pending_count":
            query_result(request, {"operations": len(pending), "queries": len(pending_queries), "controls": len(pending_controls)})
        elif action == "hold_read":
            pending_queries.add(request)
        elif action == "control_pending":
            query_result(request, {"pending": len(pending_controls)})
        elif action == "environment":
            query_result(request, {"environment": environment, "cwd": os.getcwd()})
        elif action == "resource_put":
            reference = retain_resource(request, args)
            send(request, "query_result", {"data": {"reference": reference}, "completeness": "complete", "source": reference})
        elif action == "spoof":
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
    elif kind == "control":
        assert data["operation_id"] is None
        args = data["arguments"]
        action = args.get("action", "answer")
        if action == "hold":
            pending_controls.add(request)
        elif action == "finish":
            for original in pending_queries:
                query_result(original, {"finished": True})
            pending_queries.clear()
            for original in pending_controls:
                send(original, "control_result", {"data":{"submitted":True}})
            pending_controls.clear()
            send(request, "control_result", {"data":{"submitted":True}})
        elif action == "controls_pending":
            send(request, "control_result", {"data":{"submitted":len(pending_controls) == 1}})
        elif action == "reads_full":
            send(request, "control_result", {"data":{"submitted":len(pending_queries) == 16}})
        elif action == "reject":
            send(request, "error", {"code":"rejected", "message":args["value"], "recovery":{"secret":args["value"]}})
        elif action == "bad_output":
            send(request, "control_result", {"data":{"submitted":args["value"]}})
        elif action == "resource_put":
            try:
                retain_resource(request, {"bytes":8})
                send(request, "control_result", {"data":{"submitted":False}})
            except RuntimeError:
                send(request, "control_result", {"data":{"submitted":True}})
        else:
            send(request, "control_result", {"data":{"submitted":True}})
    elif kind == "invoke":
        invocations += 1
        retain_count("invocations")
        action = data["arguments"].get("action", "hold")
        if action == "crash":
            with open(data["arguments"]["marker"], "a") as marker:
                marker.write("executed\n")
            os._exit(17)
        elif action == "resource_commit":
            reference = retain_resource(request, data["arguments"])
            evidence = dict(reference)
            if data["arguments"].get("forged"):
                evidence["digest"] = "sha256:" + "0" * 64
            send(request, "commit_plan", {"outcome": "succeeded", "output": {"reference": reference}, "error": None,
                "recovery": None, "facts": [{"schema": "fixture.resource", "key": "original", "value": reference}],
                "evidence": [evidence], "cancellation_confirmed": False})
        elif action == "badcommit":
            commit(request, invalid=True)
        elif action in ("commit", "badfact", "evidence"):
            commit(request, call=data)
        else:
            pending[request] = data
    elif kind == "cancel":
        cancel_signals.append(data["operation_id"])
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
