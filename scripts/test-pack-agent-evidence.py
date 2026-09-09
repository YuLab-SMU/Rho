#!/usr/bin/env python3
"""Isolated synthetic evidence tests: no user config, model, runtime or network."""
import base64
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import stat
import sys
import subprocess
import tempfile
import unittest
import warnings
from unittest.mock import patch
import zipfile

sys.dont_write_bytecode = True

SPEC = importlib.util.spec_from_file_location('packer', Path(__file__).with_name('pack-agent-evidence.py'))
PACK = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(PACK)
PNG = base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aAvsAAAAASUVORK5CYII=')
SECRET = 'synthetic-launch-credential-42'
BRIDGE = 'synthetic-bridge-credential-99'


def zipped(entries):
    buffer = io.BytesIO()
    with warnings.catch_warnings():
        warnings.simplefilter('ignore', UserWarning)
        with zipfile.ZipFile(buffer, 'w', compression=zipfile.ZIP_DEFLATED) as archive:
            for name, value in entries:
                archive.writestr(name, value)
    return buffer.getvalue()


class EvidenceTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.repo = self.root / 'repo'
        self.repo.mkdir()
        self.evidence = self.repo / 'evidence'
        self.evidence.mkdir()
        self.visual = self.repo / 'visuals'
        self.visual.mkdir()
        self.binary = self.repo / 'rho'
        self.binary.write_bytes(b'synthetic-binary\x00')
        self.asset = self.repo / 'app.js'
        self.asset.write_text('export const synthetic = true;\n')
        env = dict(os.environ, GIT_CONFIG_NOSYSTEM='1', GIT_CONFIG_GLOBAL=os.devnull,
                   GIT_CONFIG_COUNT='0', GIT_TERMINAL_PROMPT='0')
        for args in (['init', '-q'], ['add', 'rho', 'app.js'],
                     ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
                      '-c', 'commit.gpgsign=false', 'commit', '-qm', 'fixture']):
            subprocess.run(['git', *args], cwd=self.repo, env=env, check=True, capture_output=True)
        self.output = self.root / 'bundle.zip'

    def tearDown(self):
        self.temp.cleanup()

    def pack(self):
        return PACK.pack(self.repo, self.evidence, [self.visual], [self.binary], [self.asset], self.output)

    def test_complete_snapshot_redacts_nested_credentials_preserves_images_and_usage(self):
        self.evidence.joinpath('first-failed.log').write_text('Failed attempt; echoed ' + SECRET + '\n')
        self.evidence.joinpath('launch.log').write_text('http://127.0.0.1:9999/#token=' + SECRET + '\n')
        self.evidence.joinpath('auth.json').write_bytes(b'NEVER_READ_CONFIG_SECRET\xff')
        self.evidence.joinpath('all-metrics.json').write_text(
            '{"input_tokens":9007199254740993,"output_tokens":23,"token_usage":1.20e+3,'
            '"auth":{"bridge_token":"' + BRIDGE + '"},"token":123}')
        self.evidence.joinpath('mcp.jsonl').write_text(json.dumps({
            'content': [{'type': 'image', 'mimeType': 'image/png', 'data': base64.b64encode(PNG).decode()},
                        {'type': 'text', 'text': json.dumps({'bridge_token': BRIDGE, 'total_tokens': 456})}]
        }) + '\n' + json.dumps({'usage': {'output_tokens': 78}, 'message': SECRET}) + '\n')
        inner = zipped([('trace.network', json.dumps({'headers': [
            {'name': 'Authorization', 'value': 'Bearer ' + SECRET},
            {'name': 'bridge_token', 'value': BRIDGE}], 'input_tokens': 9})),
                        ('resources/shot.png', PNG), ('config.toml', 'DO_NOT_READ_NESTED_SECRET')])
        self.evidence.joinpath('trace.zip').write_bytes(zipped([('inner.zip', inner), ('trace.trace',
            json.dumps({'url': 'http://localhost/#token=' + SECRET}) + '\n')]))
        self.visual.joinpath('current.png').write_bytes(PNG)
        self.evidence.joinpath('failed.png').write_bytes(PNG)
        self.evidence.joinpath('case').mkdir()
        self.evidence.joinpath('case/manifest.json').write_text(json.dumps({
            'commit': 'a' * 40, 'tree': 'b' * 40, 'acceptance': False,
            'cases': [{'passed': False}], 'binaries': {'rho': {'sha256': 'sha256:old'}}}))
        originals = {p: p.read_bytes() for p in self.evidence.rglob('*') if p.is_file()}
        original_reader = PACK.read_stable
        def guarded(path):
            self.assertNotEqual(path.name, 'auth.json')
            return original_reader(path)
        with patch.object(PACK, 'read_stable', side_effect=guarded):
            result = self.pack()
        self.assertEqual(result['sha256'], PACK.digest(self.output.read_bytes()))
        self.assertTrue(self.output.with_name('bundle.zip.sha256').read_text().startswith(result['sha256'][7:]))
        for path, original in originals.items():
            self.assertEqual(path.read_bytes(), original)
        with zipfile.ZipFile(self.output) as archive:
            manifest = json.loads(archive.read('MANIFEST.json'))
            self.assertEqual(manifest['acceptance_manifests'][0]['commit'], 'a' * 40)
            self.assertNotEqual(manifest['packaging_checkout']['commit'], 'a' * 40)
            self.assertEqual(manifest['current_artifacts']['binaries'][0]['sha256'], PACK.digest(self.binary.read_bytes()))
            self.assertEqual(manifest['current_artifacts']['assets'][0]['sha256'], PACK.digest(self.asset.read_bytes()))
            self.assertIn('evidence/first-failed.log', archive.namelist())
            self.assertEqual(archive.read('evidence/failed.png'), PNG)
            self.assertEqual(archive.read('visuals-1/current.png'), PNG)
            metrics = archive.read('evidence/all-metrics.json').decode()
            self.assertIn('9007199254740993', metrics)
            self.assertIn('1.20e+3', metrics)
            self.assertEqual(json.loads(metrics)['token'], 123)
            messages = [json.loads(line) for line in archive.read('evidence/mcp.jsonl').splitlines()]
            self.assertEqual(base64.b64decode(messages[0]['content'][0]['data']), PNG)
            self.assertEqual(json.loads(messages[0]['content'][1]['text'])['total_tokens'], 456)
            self.assertEqual(messages[1]['usage']['output_tokens'], 78)
            with zipfile.ZipFile(io.BytesIO(archive.read('evidence/trace.zip'))) as outer:
                with zipfile.ZipFile(io.BytesIO(outer.read('inner.zip'))) as nested:
                    self.assertEqual(nested.read('resources/shot.png'), PNG)
                    self.assertNotIn('config.toml', nested.namelist())
                    network = nested.read('trace.network').decode()
                    self.assertNotIn(SECRET, network)
                    self.assertNotIn(BRIDGE, network)
            for item in manifest['files']:
                if '!/' not in item['path']:
                    self.assertEqual(PACK.digest(archive.read(item['path'])), item['sanitized_sha256'])
            self.assertEqual(len(manifest['exclusions']), 2)
            self.assertTrue(all(x['source_sha256'] is None for x in manifest['exclusions']))
            for name in archive.namelist():
                if name.endswith(('.json', '.jsonl', '.log', '.trace')):
                    self.assertNotIn(SECRET.encode(), archive.read(name))
                    self.assertNotIn(BRIDGE.encode(), archive.read(name))

    def test_corrupt_or_unsafe_zip_never_publishes(self):
        cases = [b'not-a-zip', zipped([('../escape.json', '{}')]),
                 zipped([('/absolute.json', '{}')]), zipped([('a\\b', '{}')]),
                 zipped([('inner.zip', b'corrupt')]), zipped([('same', 'a'), ('same', 'b')])]
        symlink = zipfile.ZipInfo('link')
        symlink.create_system = 3
        symlink.external_attr = (stat.S_IFLNK | 0o777) << 16
        cases.append(zipped([(symlink, 'outside')]))
        for data in cases:
            with self.subTest(size=len(data)):
                self.evidence.joinpath('trace.zip').write_bytes(data)
                with self.assertRaises(PACK.PackError):
                    self.pack()
                self.assertFalse(self.output.exists())
                self.assertFalse(self.output.with_name('bundle.zip.sha256').exists())

    def test_output_inside_input_and_input_symlinks_rejected(self):
        self.output = self.evidence / 'recursive.zip'
        with self.assertRaisesRegex(PACK.PackError, 'outside'):
            self.pack()
        self.output = self.root / 'bundle.zip'
        self.evidence.joinpath('escape').symlink_to(self.binary)
        with self.assertRaisesRegex(PACK.PackError, 'regular'):
            self.pack()
        self.evidence.joinpath('escape').unlink()
        self.evidence.joinpath('directory').symlink_to(self.visual, target_is_directory=True)
        with self.assertRaisesRegex(PACK.PackError, 'symlink directory'):
            self.pack()

    def test_limits_and_changed_tree_fail_without_partial_archive(self):
        self.evidence.joinpath('log.txt').write_text('abcdef')
        with patch.object(PACK, 'MAX_TOTAL', 2):
            with self.assertRaisesRegex(PACK.PackError, 'budget'):
                self.pack()
        real_transform = PACK.Sanitizer.transform
        def mutate(owner, name, data, depth=0):
            self.evidence.joinpath('new.log').write_text('concurrent producer')
            return real_transform(owner, name, data, depth)
        with patch.object(PACK.Sanitizer, 'transform', new=mutate):
            with self.assertRaisesRegex(PACK.PackError, 'changed'):
                self.pack()
        self.assertFalse(self.output.exists())

    def test_gzip_scientific_artifact_and_image_data_stay_exact(self):
        import gzip
        content = gzip.compress(b'synthetic recorded plot, no native execution')
        self.evidence.joinpath('recorded.rds').write_bytes(content)
        self.evidence.joinpath('image.json').write_text(json.dumps({'type': 'image',
            'mimeType': 'image/png', 'data': SECRET, 'usage': {'input_tokens': 19}}))
        self.evidence.joinpath('auth.log').write_text('Bearer ' + SECRET)
        self.pack()
        with zipfile.ZipFile(self.output) as archive:
            self.assertEqual(archive.read('evidence/recorded.rds'), content)
            self.assertEqual(json.loads(archive.read('evidence/image.json'))['data'], SECRET)

    def test_encoded_json_keys_and_plain_assignments_are_sanitized(self):
        self.evidence.joinpath('headers.log').write_text(
            'Authorization: Bearer ' + SECRET + '\nbridge_token="' + BRIDGE + '"\ninput_tokens=432\n')
        self.evidence.joinpath('keyed.json').write_text(json.dumps({SECRET: BRIDGE, 'total_tokens': 654}))
        self.pack()
        with zipfile.ZipFile(self.output) as archive:
            text = archive.read('evidence/headers.log').decode()
            self.assertNotIn(SECRET, text)
            self.assertNotIn(BRIDGE, text)
            self.assertIn('input_tokens=432', text)
            keyed = json.loads(archive.read('evidence/keyed.json'))
            self.assertEqual(keyed[PACK.REDACTED], PACK.REDACTED)
            self.assertEqual(keyed['total_tokens'], 654)

    def test_existing_output_not_overwritten(self):
        self.output.write_bytes(b'original')
        with self.assertRaisesRegex(PACK.PackError, 'overwrite'):
            self.pack()
        self.assertEqual(self.output.read_bytes(), b'original')


if __name__ == '__main__':
    unittest.main()
