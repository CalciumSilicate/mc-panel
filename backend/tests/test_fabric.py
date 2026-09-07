import asyncio
import hashlib
import io
import tempfile
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch
from zipfile import ZipFile

import httpx

from app import fabric, jar_cache


class FabricInstallTests(unittest.IsolatedAsyncioTestCase):
    async def test_prepared_launcher_cache_progress_and_legacy(self):
        for loader in ('0.19.5', '0.12.5'):
            with self.subTest(loader=loader), tempfile.TemporaryDirectory() as tmp:
                root = Path(tmp)
                buf = io.BytesIO()
                with ZipFile(buf, 'w') as z:
                    z.writestr('META-INF/MANIFEST.MF', 'Manifest-Version: 1.0\r\nMain-Class: example.\r\n Launcher\r\n\r\n')
                    z.writestr('example/Launcher.class', b'class')
                    z.writestr('META-INF/TEST.SF', b'signature')
                    z.writestr('META-INF/services/example.Service', 'one # comment\none\ntwo\n')
                payloads = {'/core': b'minecraft', '/bootstrap': b'bootstrap'}
                library = f'net/fabricmc/fabric-loader/{loader}/fabric-loader-{loader}.jar'
                payloads['/' + library] = buf.getvalue()
                profile = {'mainClass': 'example.KnotServer', 'libraries': [{
                    'name': f'net.fabricmc:fabric-loader:{loader}', 'url': 'https://test/',
                    'sha256': hashlib.sha256(buf.getvalue()).hexdigest(), 'size': len(buf.getvalue()),
                }]}
                calls = []
                def handle(request):
                    calls.append(request.url.path)
                    return httpx.Response(200, content=payloads[request.url.path])
                with patch.object(fabric.versions, '_cached_json', AsyncMock(return_value=profile)), \
                     patch.object(fabric.versions, 'get_server_download', AsyncMock(return_value={
                         'url': 'https://test/core', 'sha1': hashlib.sha1(b'minecraft').hexdigest(), 'size': 9,
                     })), \
                     patch.object(fabric.versions, 'get_fabric_download', AsyncMock(return_value={'url': 'https://test/bootstrap'})), \
                     patch.object(jar_cache, 'CACHE_DIR', root / 'cache'), \
                     patch.object(jar_cache, 'INDEX_PATH', root / 'cache/index.json'), \
                     patch.object(jar_cache.net, 'client', side_effect=lambda **kw: httpx.AsyncClient(transport=httpx.MockTransport(handle), **kw)):
                    for name in ('first', 'second'):
                        progress = []
                        dest = root / name
                        await fabric.install(dest, '26.2', loader, lambda d, t: progress.append((d, t)))
                        self.assertEqual((dest / '.fabric/server/26.2-server.jar').read_bytes(), b'minecraft')
                        self.assertEqual(progress[-1][0], progress[-1][1])
                        self.assertEqual(sorted(d for d, _ in progress), [d for d, _ in progress])
                        with ZipFile(dest / f'.fabric/server/fabric-loader-server-{loader}-minecraft-26.2.jar') as z:
                            manifest = z.read('META-INF/MANIFEST.MF')
                            self.assertTrue(all(len(line) <= 72 for line in manifest.split(b'\r\n')))
                            unfolded = manifest.replace(b'\r\n ', b'')
                            self.assertIn(b'Main-Class: example.Launcher\r\n', unfolded)
                            self.assertEqual(z.read('fabric-server-launch.properties'), b'launch.mainClass=example.KnotServer\n')
                            if loader == '0.12.5':
                                self.assertIn('example/Launcher.class', z.namelist())
                                self.assertNotIn('META-INF/TEST.SF', z.namelist())
                                self.assertEqual(z.read('META-INF/services/example.Service'), b'one\ntwo\n')
                            else:
                                self.assertIn(('../../libraries/' + library).encode(), unfolded)
                    self.assertEqual(calls.count('/core'), 1)
                    self.assertEqual(calls.count('/' + library), 1)

    async def test_failed_or_cancelled_download_does_not_publish(self):
        for error in (RuntimeError('network'), asyncio.CancelledError(), None):
            with self.subTest(error=error), tempfile.TemporaryDirectory() as tmp:
                root = Path(tmp)
                async def download(url, dest, **kw):
                    dest.write_bytes(b'corrupt')
                    if error is not None:
                        raise error
                with patch.object(fabric.versions, '_cached_json', AsyncMock(return_value={'libraries': []})), \
                     patch.object(fabric.versions, 'get_server_download', AsyncMock(return_value={
                         'url': 'https://test/core', 'sha1': hashlib.sha1(b'valid').hexdigest(),
                     })), \
                     patch.object(fabric.versions, 'get_fabric_download', AsyncMock(return_value={'url': 'https://test/bootstrap'})), \
                     patch.object(jar_cache, 'cached_download', side_effect=download):
                    with self.assertRaises(type(error) if error is not None else RuntimeError):
                        await fabric.install(root, '26.2', '0.19.5')
                self.assertFalse(list(root.rglob('*.panel-download')))
                self.assertFalse(list(root.rglob('*.jar')))
