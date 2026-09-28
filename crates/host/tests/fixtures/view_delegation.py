#!/usr/bin/env python3
"""Independent public-RPC fixture for inherited native view restrictions."""
import json
import struct
import sys

sequence = 0
pending = {}
held = {}

def read():
    size = sys.stdin.buffer.read(4)
    return json.loads(sys.stdin.buffer.read(struct.unpack('>I', size)[0])) if size else None

def send(request, kind, data=None):
    global sequence
    sequence += 1
    body = {'type': kind}
    if data is not None:
        body['data'] = data
    frame = {'protocol_version': 1, 'connection': connection, 'instance': identity['instance'],
             'sequence': sequence, 'request': request, 'body': body}
    encoded = json.dumps(frame).encode()
    sys.stdout.buffer.write(struct.pack('>I', len(encoded)) + encoded)
    sys.stdout.buffer.flush()

def query(request, value):
    send(request, 'query_result', {'data': value, 'completeness': 'complete', 'source': None})

def delegate(frame):
    call = frame['body']['data']
    args = call['arguments']
    if call['binding']['capability']['id'] == 'fixture.prepare':
        args = args['arguments']
    key = 'reverse-' + frame['request']
    pending[key] = frame
    send(key, 'host_call', {'parent_request': frame['request'],
         'capability': args.get('capability', {'id': 'documents.list', 'version': 1}),
         'arguments': args['host_arguments']})

frame = read()
connection = frame['connection']
instance = frame['body']['data']['instance']
identity = instance['identity']
send(frame['request'], 'ready', {'revision': identity['revision'], 'artifact': identity['artifact'], 'features': []})
while (frame := read()) is not None:
    request, body = frame['request'], frame['body']
    kind, data = body['type'], body.get('data')
    if kind in ('query', 'control', 'invoke'):
        # Native restrictions are deliberately absent from the public wire.
        assert 'view_scope' not in data
        action = data['arguments'].get('action')
        if kind == 'invoke' and action == 'hold':
            held[request] = frame
        elif action == 'crash':
            sys.exit(4)
        elif action == 'held':
            query(request, {'held': len(held)})
        elif action == 'release_held':
            for original in held.values():
                delegate(original)
            held.clear()
            query(request, {})
        else:
            delegate(frame)
    elif kind in ('host_result', 'error') and request in pending:
        original = pending.pop(request)
        call = original['body']['data']
        if call['binding']['capability']['id'] == 'fixture.prepare':
            if kind == 'error':
                send(original['request'], 'error', data)
            else:
                query(original['request'], {'arguments': call['arguments']['arguments'],
                    'target': call['arguments']['target'], 'owner_context': {}})
        elif original['body']['type'] == 'query':
            query(original['request'], {'delegated': body})
        elif original['body']['type'] == 'control':
            send(original['request'], 'control_result', {'data': {'delegated': body}})
        else:
            send(original['request'], 'commit_plan', {'outcome': 'succeeded', 'output': {'delegated': body},
                'error': None, 'recovery': None, 'facts': [], 'evidence': [], 'cancellation_confirmed': False})
    elif kind == 'operation_settled':
        send(request, 'settlement_acknowledged', data)
    elif kind == 'release':
        send(request, 'released')
        break
