#!/usr/bin/env python3
"""Run the standalone Editor executable using only the published framed RPC."""
import json
import struct
import subprocess
import sys

process = subprocess.Popen([sys.argv[1]], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
sequence = 0
received = 0
identity = {'plugin': 'org.rho.editor', 'instance': 'independent-editor', 'revision': 'sha256:' + 'a' * 64, 'artifact': 'sha256:' + 'b' * 64}
connection = 'independent-connection'

def send(request, kind, data=None):
    global sequence
    sequence += 1
    body = {'type': kind}
    if data is not None:
        body['data'] = data
    encoded = json.dumps({'protocol_version': 1, 'connection': connection, 'instance': identity['instance'],
                          'sequence': sequence, 'request': request, 'body': body}).encode()
    process.stdin.write(struct.pack('>I', len(encoded)) + encoded)
    process.stdin.flush()

def read(kind):
    global received
    header = process.stdout.read(4)
    assert len(header) == 4, 'Backend ended before its reply'
    size = struct.unpack('>I', header)[0]
    assert 0 < size <= 1024 * 1024
    frame = json.loads(process.stdout.read(size))
    received += 1
    assert frame['protocol_version'] == 1 and frame['connection'] == connection and frame['instance'] == identity['instance']
    assert frame['sequence'] == received and frame['body']['type'] == kind, frame
    return frame

def search(request):
    send(request, 'query', {'request': request, 'binding': {'capability': {'id': 'editor.context.search', 'version': 1},
        'provider': identity, 'project': 'project', 'target': None}, 'principal': 'principal', 'scopes': ['documents.read'],
        'arguments': {'window': 'window', 'text': '', 'after': None, 'limit': 20},
        'preconditions': None, 'owner_context': None, 'operation_id': None})

try:
    send('initialize', 'initialize', {'instance': {'identity': identity, 'project': 'project', 'principal': 'principal',
        'alias': 'editor', 'configuration': {}, 'state': 'preparing', 'diagnostic': None},
        'grants': [{'capability': {'id': name, 'version': 1}, 'scopes': ['documents.read']}
                   for name in ('documents.list', 'documents.inspect', 'documents.read')],
        'environment': None, 'resource_channel': None})
    ready = read('ready')
    assert ready['request'] == 'initialize' and ready['body']['data']['revision'] == identity['revision']
    pending = []
    for index in range(16):
        parent = f'query-{index}'
        search(parent)
        reverse = read('host_call')
        args = reverse['body']['data']
        assert args['parent_request'] == parent and args['capability'] == {'id': 'documents.list', 'version': 1}
        assert args['arguments'] == {'window': 'window', 'source': {'revision': identity['revision'], 'contribution': 'editor'}, 'after': None, 'limit': 20}
        pending.append((parent, reverse['request']))
    search('overflow')
    assert read('error')['body']['data']['code'] == 'busy'
    send('release-early', 'release')
    assert read('error')['body']['data']['code'] == 'busy'
    # Reply in reverse order: every observation must complete its own parent.
    for parent, reverse in reversed(pending):
        send(reverse, 'host_result', {'result': {'status': 'ready', 'completeness': 'complete', 'data': {'drafts': [], 'next': None}}})
        result = read('query_result')
        assert result['request'] == parent
        assert result['body']['data']['data'] == {'items': [], 'next': None, 'notices': []}
    search('denied')
    reverse = read('host_call')
    send(reverse['request'], 'error', {'code': 'access_denied', 'message': 'Original window restriction', 'recovery': None})
    result = read('error')
    assert result['request'] == 'denied' and result['body']['data']['code'] == 'access_denied'
    send('release', 'release')
    assert read('released')['request'] == 'release'
    process.wait(timeout=10)
    assert process.returncode == 0
    print('Independent Editor RPC passed initialization, bounded reads, reverse correlation, scope errors and release.')
finally:
    if process.poll() is None:
        process.kill()
        process.wait()
    process.stdin.close()
    process.stdout.close()
    process.stderr.close()
