#!/usr/bin/env python3
"""Snapshot every Agent evidence attempt into a sanitized, hash-indexed ZIP.

No model, network, user configuration, or scientific runtime is accessed. Inputs
are explicit. Run only after evidence producers stop. Originals are never changed.
The packaging checkout and the acceptance manifests' tested versions are separate.
"""
import argparse
import hashlib
import io
import json
import os
from pathlib import Path, PurePosixPath
import re
import stat
import subprocess
import tempfile
import zipfile

REDACTED = '[REDACTED]'
MAX_FILE = 256 * 1024 * 1024
MAX_TOTAL = 4 * 1024 * 1024 * 1024
MAX_EXPANDED = 8 * 1024 * 1024 * 1024
MAX_ENTRIES = 100000
MAX_DEPTH = 4
SECRET_KEYS = {'auth', 'authorization', 'proxyauthorization', 'bridgetoken',
               'token', 'accesstoken', 'refreshtoken', 'idtoken', 'apikey',
               'clientsecret', 'password', 'secret', 'cookie', 'setcookie'}
KEY_PATTERN = r'(?<![\w-])(?:authorization|proxy-authorization|bridge[_-]token|access[_-]token|refresh[_-]token|id[_-]token|api[_-]key|client[_-]secret|password|auth|secret|token)(?![\w-])'
BEARER = re.compile(r'(?i)\bBearer[ \t]+([^\s"\'<>\\,;]+)')
URL_TOKEN = re.compile(r'(?i)([#?&](?:token|bridge_token|access_token|auth)=)([^\s"\'<>\\&#]+)')
ASSIGNMENT = re.compile(r'(?i)(' + KEY_PATTERN + r'["\']?\s*[:=]\s*)(?:"([^"\n]*)"|\'([^\'\n]*)\'|([^\s,;}\]<>]+))')


class PackError(Exception):
    pass


class Number(str):
    """Preserve JSON number spelling and large integer precision exactly."""


def digest(data):
    return 'sha256:' + hashlib.sha256(data).hexdigest()


def normalized(key):
    return re.sub(r'[-_ ]', '', key).lower()


def dumps(value):
    if isinstance(value, Number):
        return str(value)
    if isinstance(value, dict):
        return '{' + ','.join(json.dumps(k, ensure_ascii=False) + ':' + dumps(v)
                              for k, v in value.items()) + '}'
    if isinstance(value, list):
        return '[' + ','.join(map(dumps, value)) + ']'
    return json.dumps(value, ensure_ascii=False, allow_nan=False)


def loads(text):
    return json.loads(text, parse_int=Number, parse_float=Number,
                      parse_constant=lambda _: (_ for _ in ()).throw(ValueError('non-JSON number')))


def secret_file(name):
    p = PurePosixPath(name)
    base = p.name.lower()
    if base in {'auth.json', 'credentials.json', 'credentials', 'config.toml',
                '.netrc', '.npmrc', 'id_rsa', 'id_ed25519', '.env',
                'launch-url', 'launch-url.txt', 'private-url.txt', 'auth.toml',
                'credentials.toml', 'credentials.yaml', 'credentials.yml'}:
        return True
    return (base.startswith('.env.') or base.endswith(('.pem', '.key')) or
            any(part.lower() in {'.ssh', '.aws'} for part in p.parts))


def safe_name(name):
    p = PurePosixPath(name)
    if (not name or name.startswith('/') or '\\' in name or any(ord(c) < 32 for c in name) or
            any(part in {'.', '..'} for part in name.split('/')) or
            re.match(r'^[A-Za-z]:', name)):
        raise PackError('unsafe archive/input path')
    return str(p)


def is_image(name, data):
    return (data.startswith((b'\x89PNG\r\n\x1a\n', b'\xff\xd8\xff', b'GIF87a', b'GIF89a')) or
            (data.startswith(b'RIFF') and data[8:12] == b'WEBP') or
            Path(name).suffix.lower() in {'.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg'})


class Sanitizer:
    def __init__(self):
        self.secrets = set()
        self.records = []
        self.exclusions = []
        self.tested_runs = []
        self.expanded = 0
        self.output_bytes = 0
        self.entries = 0
        self.redactions = 0
        self.collecting = True

    def reset_budget(self):
        self.expanded = self.entries = self.output_bytes = 0

    def learn(self, value):
        if (not isinstance(value, str) or isinstance(value, Number) or
                REDACTED in value or value in {'Bearer', '[REDACTED'}):
            return
        if value.startswith('Bearer '):
            value = value[7:]
        if len(value) >= 4:
            self.secrets.add(value)

    def replacement(self, value):
        self.learn(value)
        self.redactions += not self.collecting
        return REDACTED

    def text(self, text, depth=0):
        # Encoded JSON in MCP text and Playwright payloads retains its own fields.
        if depth < 16 and text.lstrip().startswith(('{', '[')):
            try:
                value = loads(text)
            except (ValueError, RecursionError):
                pass
            else:
                return dumps(self.value(value, depth + 1))
        def bearer(match):
            return 'Bearer ' + self.replacement(match.group(1))
        text = BEARER.sub(bearer, text)
        text = URL_TOKEN.sub(lambda m: m.group(1) + self.replacement(m.group(2)), text)
        def assignment(match):
            value = next(v for v in match.groups()[1:] if v is not None)
            # Numeric metrics such as token=123 are evidence, never credentials.
            if re.fullmatch(r'-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?', value):
                return match.group(0)
            quote = '"' if match.group(2) is not None else "'" if match.group(3) is not None else ''
            return match.group(1) + quote + self.replacement(value) + quote
        text = ASSIGNMENT.sub(assignment, text)
        if not self.collecting:
            for secret in sorted(self.secrets, key=len, reverse=True):
                if secret in text:
                    self.redactions += text.count(secret)
                    text = text.replace(secret, REDACTED)
        return text

    def value(self, value, depth=0, image=False):
        if depth > 64:
            raise PackError('structured text nesting exceeds limit')
        if isinstance(value, Number):
            return value
        if isinstance(value, str):
            if image or value.startswith('data:image/'):
                return value
            return self.text(value, depth)
        if isinstance(value, list):
            return [self.value(v, depth + 1) for v in value]
        if not isinstance(value, dict):
            return value
        image = (value.get('type') == 'image' or
                 any(isinstance(value.get(k), str) and value[k].startswith('image/')
                     for k in ('mimeType', 'mime_type', 'preview_mime_type')))
        header = next((value[k] for k in ('name', 'key', 'header')
                       if isinstance(value.get(k), str)), '')
        result = {}
        for key, item in value.items():
            original_key = key
            key = self.text(key, depth + 1)
            if key in result:
                raise PackError('redaction would collide JSON keys')
            if ((normalized(original_key) in SECRET_KEYS or
                 (key == 'value' and normalized(header) in SECRET_KEYS)) and
                    isinstance(item, str) and not isinstance(item, Number)):
                result[key] = self.replacement(item)
            else:
                protected = image and key in {'data', 'blob', 'preview_base64'}
                result[key] = self.value(item, depth + 1, protected)
        return result

    def transform(self, name, data, depth=0):
        if not self.collecting and self.text(name) != name:
            raise PackError('credential in archive path; rename evidence before packaging')
        self.entries += 1
        self.expanded += len(data)
        if self.entries > MAX_ENTRIES or self.expanded > MAX_EXPANDED or len(data) > MAX_FILE:
            raise PackError('evidence expansion budget exceeded')
        if is_image(name, data):
            result, kind = data, 'image_unchanged'
        elif name.lower().endswith('.zip') or data.startswith(b'PK\x03\x04'):
            result, kind = self.archive(name, data, depth), 'zip'
        elif name.lower().endswith('.rds'):
            # Recorded plots are evidence, not a log/credential serialization.
            # Do not invoke R or deserialize arbitrary native scientific objects.
            if any(secret.encode() in data for secret in self.secrets):
                raise PackError('identified credential in opaque scientific artifact')
            result, kind = data, 'scientific_binary_unchanged'
        else:
            try:
                text = data.decode('utf-8')
            except UnicodeDecodeError as error:
                raise PackError('unsupported binary evidence; no archive produced') from error
            if '\x00' in text:
                raise PackError('unsupported binary evidence; no archive produced')
            try:
                value = loads(text)
            except (ValueError, RecursionError):
                # JSONL, .trace and .network are independently structured lines.
                result = ''.join(self.text(line) + ending for line, ending in
                                 ((line.rstrip('\r\n'), line[len(line.rstrip('\r\n')):])
                                  for line in text.splitlines(keepends=True))).encode('utf-8')
            else:
                result = (dumps(self.value(value)) + ('\n' if text.endswith('\n') else '')).encode('utf-8')
                if (not self.collecting and name.endswith('/manifest.json') and
                        isinstance(value, dict) and 'cases' in value and 'commit' in value):
                    self.tested_runs.append({'manifest': name, **{k: value[k] for k in
                        ('commit', 'tree', 'acceptance', 'fixed_tree', 'binaries', 'assets',
                         'model', 'reasoning_effort') if k in value}})
            kind = 'text'
        if not self.collecting:
            self.output_bytes += len(result)
            if len(result) > MAX_FILE or self.output_bytes > MAX_EXPANDED:
                raise PackError('sanitized evidence byte budget exceeded')
            self.records.append({'path': name, 'kind': kind,
                                 'source_sha256': digest(data), 'source_bytes': len(data),
                                 'sanitized_sha256': digest(result), 'sanitized_bytes': len(result)})
        return result

    def archive(self, name, data, depth):
        if depth >= MAX_DEPTH:
            raise PackError('nested ZIP depth exceeds limit')
        out = io.BytesIO()
        try:
            with zipfile.ZipFile(io.BytesIO(data)) as source, zipfile.ZipFile(
                    out, 'w', compression=zipfile.ZIP_DEFLATED) as target:
                seen = set()
                if len(source.infolist()) > MAX_ENTRIES - self.entries:
                    raise PackError('ZIP entry budget exceeded')
                for item in source.infolist():
                    member = safe_name(item.filename.rstrip('/'))
                    if member in seen:
                        raise PackError('duplicate ZIP entry')
                    seen.add(member)
                    mode = item.external_attr >> 16
                    if stat.S_ISLNK(mode) or (stat.S_IFMT(mode) not in (0, stat.S_IFREG, stat.S_IFDIR)):
                        raise PackError('non-regular ZIP entry')
                    if item.flag_bits & 1:
                        raise PackError('encrypted ZIP entry')
                    if item.is_dir():
                        continue
                    logical = name + '!/' + member
                    if secret_file(member):
                        if not self.collecting:
                            self.exclusions.append({'path': logical, 'source_bytes': item.file_size,
                                                    'source_sha256': None, 'reason': 'credential/config file; body not read'})
                        continue
                    if (item.file_size > MAX_FILE or item.file_size > MAX_EXPANDED - self.expanded or
                            item.file_size > max(1024 * 1024, item.compress_size * 1000)):
                        raise PackError('ZIP expansion budget exceeded')
                    content = source.read(item)  # Verifies CRC before publishing anything.
                    sanitized = self.transform(logical, content, depth + 1)
                    target.writestr(member, sanitized)
        except (zipfile.BadZipFile, RuntimeError, NotImplementedError, OSError) as error:
            raise PackError('invalid/unsupported ZIP; no archive produced') from error
        return out.getvalue()


def fingerprint(info):
    return info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns, info.st_ctime_ns


def read_stable(path):
    before = path.lstat()
    if not stat.S_ISREG(before.st_mode):
        raise PackError('input must be a regular file, not a symlink/device')
    if before.st_size > MAX_FILE:
        raise PackError('individual evidence file budget exceeded')
    with path.open('rb') as source:
        opened = os.fstat(source.fileno())
        data = source.read(MAX_FILE + 1)
        after = os.fstat(source.fileno())
    if (len(data) > MAX_FILE or fingerprint(before) != fingerprint(opened) or
            fingerprint(before) != fingerprint(after) or fingerprint(before) != fingerprint(path.lstat())):
        raise PackError('input changed while snapshotting')
    return data


def artifact(path):
    path = path.absolute()
    # Explicit binaries may be launcher symlinks; hash the named resolved artifact.
    resolved = path.resolve(strict=True)
    before = resolved.stat()
    h = hashlib.sha256()
    with resolved.open('rb') as source:
        if not stat.S_ISREG(os.fstat(source.fileno()).st_mode):
            raise PackError('artifact must be a regular file')
        for chunk in iter(lambda: source.read(1024 * 1024), b''):
            h.update(chunk)
    if fingerprint(before) != fingerprint(resolved.stat()):
        raise PackError('artifact changed while hashing')
    return {'path': str(path), 'resolved_path': str(resolved),
            'bytes': before.st_size, 'sha256': 'sha256:' + h.hexdigest()}


def git_identity(repo):
    env = dict(os.environ, GIT_CONFIG_NOSYSTEM='1', GIT_CONFIG_GLOBAL=os.devnull,
               GIT_OPTIONAL_LOCKS='0', GIT_TERMINAL_PROMPT='0', GIT_CONFIG_COUNT='0')
    def git(*args):
        return subprocess.check_output(['git', '-c', 'core.fsmonitor=false', '-c',
            'core.hooksPath=/dev/null', '-c', 'core.attributesFile=/dev/null', '-c',
            'core.excludesFile=/dev/null', *args], cwd=repo, env=env).decode().strip()
    return {'commit': git('rev-parse', 'HEAD'), 'tree': git('rev-parse', 'HEAD^{tree}'),
            'tracked_status': git('status', '--porcelain', '--untracked-files=no'),
            'meaning': 'Packaging checkout identity; tested versions remain in acceptance_manifests.'}


def enumerate_inputs(roots):
    result = []
    for prefix, root, images_only in roots:
        if root.is_symlink() or not root.is_dir():
            raise PackError('input root must be a real directory')
        for directory, dirs, files in os.walk(root, followlinks=False):
            dirs.sort()
            for entry in dirs:
                if (Path(directory) / entry).is_symlink():
                    raise PackError('symlink directory in input tree')
            for filename in sorted(files):
                path = Path(directory) / filename
                if images_only and path.suffix.lower() != '.png':
                    continue
                relative = path.relative_to(root).as_posix()
                result.append((safe_name(prefix + '/' + relative), path, path.lstat()))
                if len(result) > MAX_ENTRIES:
                    raise PackError('input entry budget exceeded')
    return result


def pack(repo, evidence, visuals, binaries, assets, output):
    roots = [('evidence', evidence.absolute(), False)] + [
        (f'visuals-{i + 1}', p.absolute(), True) for i, p in enumerate(visuals)]
    output = output.absolute()
    for _, root, _ in roots:
        if output.resolve().is_relative_to(root.resolve()):
            raise PackError('output must be outside every input tree')
    sidecar = output.with_name(output.name + '.sha256')
    if output.exists() or sidecar.exists():
        raise PackError('output/sidecar exists; refusing overwrite')
    if not output.parent.is_dir():
        raise PackError('output parent must already exist')
    identity = git_identity(repo)
    identities = {'binaries': [artifact(p) for p in binaries], 'assets': [artifact(p) for p in assets]}
    entries = enumerate_inputs(roots)
    sanitizer = Sanitizer()
    total = 0
    # Private staging is outside inputs, and contains a finite immutable snapshot.
    with tempfile.TemporaryDirectory(prefix='.rho-evidence-', dir=output.parent) as temp:
        temp = Path(temp)
        staged = []
        for index, (name, path, info) in enumerate(entries):
            if secret_file(name):
                sanitizer.exclusions.append({'path': name, 'source_bytes': info.st_size,
                    'source_sha256': None, 'reason': 'credential/config file; body not read'})
                continue
            data = read_stable(path)
            total += len(data)
            if total > MAX_TOTAL:
                raise PackError('total source byte budget exceeded')
            copy = temp / str(index)
            copy.write_bytes(data)
            staged.append((name, copy))
            sanitizer.transform(name, data)
        # Detect added/removed/replaced evidence, including producers still writing.
        after = enumerate_inputs(roots)
        if ([(n, fingerprint(s)) for n, _, s in entries] !=
                [(n, fingerprint(s)) for n, _, s in after]):
            raise PackError('input tree changed during snapshot; stop producers and retry')
        sanitizer.collecting = False
        sanitizer.reset_budget()
        archive = temp / 'archive.zip'
        with zipfile.ZipFile(archive, 'w', compression=zipfile.ZIP_DEFLATED) as target:
            for name, path in staged:
                target.writestr(name, sanitizer.transform(name, path.read_bytes()))
            manifest = {'schema_version': 1, 'packaging_checkout': identity,
                'current_artifacts': identities, 'acceptance_manifests': sanitizer.tested_runs,
                'sources': [{'archive_prefix': p, 'path': str(r),
                             'selection': 'all PNG files' if images else 'every file, all attempts'}
                            for p, r, images in roots],
                'files': sanitizer.records, 'exclusions': sanitizer.exclusions,
                'redactions': sanitizer.redactions,
                'limits': {'file_bytes': MAX_FILE, 'source_bytes': MAX_TOTAL,
                           'expanded_bytes': MAX_EXPANDED, 'entries': MAX_ENTRIES,
                           'nested_zip_depth': MAX_DEPTH},
                'notes': ['Images and RDS scientific artifacts retain original bytes.',
                          'Credential/config bodies are excluded without reading; their digest is null.',
                          'ZIP container metadata is normalized; nested entries have separate hashes.',
                          'All acceptance attempts are included; this archive does not assert they passed.']}
            target.writestr('MANIFEST.json', dumps(sanitizer.value(manifest)).encode() + b'\n')
        if (git_identity(repo) != identity or
                {'binaries': [artifact(p) for p in binaries],
                 'assets': [artifact(p) for p in assets]} != identities):
            raise PackError('packaging checkout or artifacts changed during snapshot')
        final_hash = artifact(archive)['sha256']
        # Do not replace even if another process created the destination meantime.
        os.link(archive, output)
        try:
            with sidecar.open('x') as stream:
                stream.write(final_hash.removeprefix('sha256:') + '  ' + output.name + '\n')
        except BaseException:
            output.unlink()
            raise
    return {'archive': str(output), 'sha256': final_hash, 'bytes': output.stat().st_size,
            'files': len(sanitizer.records), 'excluded': len(sanitizer.exclusions)}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--repo', type=Path, required=True)
    parser.add_argument('--evidence-root', type=Path, required=True)
    parser.add_argument('--visual-dir', type=Path, action='append', default=[])
    parser.add_argument('--binary', type=Path, action='append', required=True)
    parser.add_argument('--asset', type=Path, action='append', required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    try:
        result = pack(args.repo, args.evidence_root, args.visual_dir, args.binary, args.asset, args.output)
    except (PackError, OSError, subprocess.SubprocessError) as error:
        # Errors describe classes, never dump log bodies or authorization values.
        parser.exit(1, f'evidence pack failed: {type(error).__name__}: {error}\n')
    print(json.dumps(result))


if __name__ == '__main__':
    main()
