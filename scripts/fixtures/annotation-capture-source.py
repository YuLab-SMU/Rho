#!/usr/bin/env python3
"""Disposable public resource producer; no Rho code, database or scientific owner."""
import hashlib
import json
import socket
import struct
import sys
import zlib


def read(stream):
    size = stream.read(4)
    return json.loads(stream.read(struct.unpack('>I', size)[0])) if size else None


def chunk(kind, payload):
    return struct.pack('>I', len(payload)) + kind + payload + struct.pack('>I', zlib.crc32(kind + payload))


# An actual 256 x 256 RGB PNG large enough to exercise multiple resource reads.
raw = b''.join(b'\0' + bytes((x * 71 + y * 137 + c * 53) % 256 for x in range(256) for c in range(3)) for y in range(256))
payload = b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', 256, 256, 8, 2, 0, 0, 0)) + chunk(b'IDAT', zlib.compress(raw, 0)) + chunk(b'IEND', b'')
initial = read(sys.stdin.buffer)
identity = initial['body']['data']['instance']['identity']
instance = identity['instance']
connection = initial['connection']
channel = initial['body']['data']['resource_channel']
sequence = 0


def send(request, kind, data=None):
    global sequence
    sequence += 1
    frame = dict(protocol_version=1, instance=instance, connection=connection, sequence=sequence, request=request,
                 body=dict(type=kind, **({'data': data} if data is not None else {})))
    encoded = json.dumps(frame).encode()
    sys.stdout.buffer.write(struct.pack('>I', len(encoded)) + encoded)
    sys.stdout.buffer.flush()


send(initial['request'], 'ready', {'revision': identity['revision'], 'artifact': identity['artifact'], 'features': []})
while (frame := read(sys.stdin.buffer)) is not None:
    kind = frame['body']['type']
    request = frame['request']
    if kind == 'query':
        data = payload
        if frame['body']['data']['arguments'].get('damaged', False):
            data = data[:len(data)//2]
        header = dict(version=1, token=channel['token'], parent_request=request, transfer=dict(type='put', data=dict(
            bytes=len(data), digest='sha256:' + hashlib.sha256(data).hexdigest(), media_type='image/png')))
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as stream:
            stream.connect(channel['socket'])
            encoded = json.dumps(header).encode()
            stream.sendall(struct.pack('>I', len(encoded)) + encoded + data)
            stream.shutdown(socket.SHUT_WR)
            with stream.makefile('rb') as response:
                stored = read(response)
        assert stored['type'] == 'stored', stored
        send(request, 'query_result', dict(data={'reference': stored['data']}, completeness='complete', source=stored['data']))
    elif kind == 'release':
        send(request, 'released')
        break
    else:
        send(request, 'error', dict(code='unsupported', message='Capture fixture supports only resource queries', recovery=None))
