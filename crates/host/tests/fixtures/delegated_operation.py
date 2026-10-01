#!/usr/bin/env python3
"""Language-neutral fixture: retain original parent until explicitly finished."""
import json
import struct
import sys

sequence = 0
held = {}
parents = {}
lookups = {}
controls = {}

def read():
    size = sys.stdin.buffer.read(4)
    return json.loads(sys.stdin.buffer.read(struct.unpack('>I', size)[0])) if size else None

def send(request, kind, data=None):
    global sequence
    sequence += 1
    body = {'type': kind}
    if data is not None:
        body['data'] = data
    encoded = json.dumps({'protocol_version': 1, 'connection': connection,
        'instance': identity['instance'], 'sequence': sequence,
        'request': request, 'body': body}).encode()
    sys.stdout.buffer.write(struct.pack('>I', len(encoded)) + encoded)
    sys.stdout.buffer.flush()

def query(request, value):
    send(request, 'query_result', {'data': value, 'completeness': 'complete', 'source': None})

def commit(request, output=None):
    send(request, 'commit_plan', {'outcome': 'succeeded', 'output': output or {}, 'error': None,
        'recovery': None, 'facts': [], 'evidence': [], 'cancellation_confirmed': False})

frame = read()
connection = frame['connection']
identity = frame['body']['data']['instance']['identity']
send(frame['request'], 'ready', {'revision': identity['revision'], 'artifact': identity['artifact']})
while (frame := read()) is not None:
    request, body = frame['request'], frame['body']
    kind, data = body['type'], body.get('data')
    if kind in ('invoke', 'query') and data['arguments'].get('action') == 'stage':
        reverse = 'stage-' + request
        controls[reverse] = (request, kind)
        send(reverse, 'host_call', {'parent_request': request,
            'capability': {'id': 'documents.stage', 'version': 1}, 'arguments': data['arguments']['stage']})
    elif kind == 'invoke':
        args = data['arguments']
        held[request] = data
        if args['action'] == 'delegate':
            reverse = 'child-' + request
            parents[data['operation_id']] = {'parent_operation': data['operation_id'], 'request': reverse}
            send(reverse, 'host_call', {'parent_request': request,
                'capability': {'id': 'fixture.run', 'version': 1}, 'arguments': args['child']})
    elif kind == 'query':
        args = data['arguments']
        if args['action'] == 'lookup':
            reverse = 'lookup-' + request
            lookups[reverse] = request
            send(reverse, 'host_call', {'parent_request': request,
                'capability': {'id': 'plugins.delegated_operation', 'version': 1}, 'arguments': args['lookup']})
        elif args['action'] == 'state':
            query(request, {'parents': parents, 'held': len(held)})
        elif args['action'] == 'finish':
            for original in held:
                commit(original)
            held.clear()
            query(request, {})
    elif kind in ('host_result', 'error'):
        if request in controls:
            original, parent_kind = controls.pop(request)
            if parent_kind == 'invoke':
                commit(original, {'reply': body})
            else:
                query(original, {'reply': body})
        if request in lookups:
            query(lookups.pop(request), {'reply': body})
        # Deliberately discard child completion replies; only the native journal
        # can establish their state for recovery.
    elif kind == 'operation_settled':
        send(request, 'settlement_acknowledged', data)
    elif kind == 'release':
        send(request, 'released')
        break
