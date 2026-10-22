"""Exercise the assembled application without sharing its import-time database."""
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import textwrap
import unittest


class HttpBoundaryTests(unittest.TestCase):
    def run_app_check(self, code):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            dist = root / "web" / "dist"
            (dist / "assets").mkdir(parents=True)
            (dist / "index.html").write_text("AUDIT_INDEX", encoding="utf-8")
            (dist / "favicon.txt").write_text("PUBLIC_ASSET", encoding="utf-8")
            (root / "private.txt").write_text("PRIVATE_CANARY", encoding="utf-8")
            env = {**os.environ, "MCPANEL_DATA_DIR": str(root / "data"),
                   "MCPANEL_WEB_DIST": str(dist),
                   "PYTHONPATH": str(Path(__file__).resolve().parents[1])}
            result = subprocess.run(
                [sys.executable, "-c", textwrap.dedent("""
                    from fastapi.testclient import TestClient
                    from app.main import app
                    from app.database import engine
                    client = TestClient(app, raise_server_exceptions=False)
                """) + textwrap.dedent(code) + "\nclient.close()\nengine.dispose()\n"],
                env=env, capture_output=True, text=True, encoding="utf-8", timeout=45,
            )
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_spa_and_assets_cannot_escape_public_directory(self):
        self.run_app_check("""
            assert client.get('/').text == 'AUDIT_INDEX'
            assert client.get('/servers/42').text == 'AUDIT_INDEX'
            assert client.get('/favicon.txt').text == 'PUBLIC_ASSET'
            assert client.get('/api/not-a-route').status_code == 404
            for path in ['/%2e%2e/%2e%2e/private.txt',
                         '/..%2f..%2fprivate.txt', '/..%5c..%5cprivate.txt']:
                response = client.get(path)
                assert 'PRIVATE_CANARY' not in response.text, path
                if '%5c' not in path or __import__('os').name == 'nt':
                    assert response.status_code == 404, (path, response.text)
            # A symlink inside dist must not turn an external file into a public asset.
            import os
            from pathlib import Path
            dist = Path(os.environ['MCPANEL_WEB_DIST'])
            try:
                (dist / 'external.txt').symlink_to(dist.parent.parent / 'private.txt')
            except OSError:
                pass  # Windows may not grant the test account symlink privileges.
            else:
                assert client.get('/external.txt').status_code == 404
        """)

    def test_custom_validation_returns_422_without_echoing_input(self):
        self.run_app_check("""
            from types import SimpleNamespace
            from app.deps import get_current_user
            app.dependency_overrides[get_current_user] = lambda: SimpleNamespace(id=1, role='owner')
            body = {'kind': 'package', 'name': 'test.zip', 'size': 0,
                    'options': {'name': 'test', 'port': 25565,
                                'min_memory': '4G', 'max_memory': '1G'}}
            response = client.post('/api/uploads', json=body)
            assert response.status_code == 422, response.text
            errors = response.json()['detail']
            assert errors and errors[0]['loc'] == ['body', 'options'], errors
            assert all('input' not in error and 'ctx' not in error for error in errors)
            body['options']['max_memory'] = '4G'
            assert client.post('/api/uploads', json=body).status_code == 201
        """)

    def test_revoked_sessions_close_existing_websockets_and_reject_reconnect(self):
        self.run_app_check("""
            from app.database import SessionLocal
            from app.models import Server, ServerGroup
            from starlette.websockets import WebSocketDisconnect
            with SessionLocal() as db:
                db.add(Server(id=1, name='test', dir_name='test', port=25565))
                db.add(ServerGroup(id=1, name='test'))
                db.commit()
            client.post('/api/auth/setup', json={'username': 'owner', 'password': 'original'})
            for endpoint in ['/api/chat/ws/1', '/api/servers/1/console']:
                token = client.post('/api/auth/login', json={
                    'username': 'owner', 'password': 'original'}).json()['token']
                url = endpoint + '?token=' + token
                with client.websocket_connect(url) as ws:
                    response = client.post('/api/auth/logout', headers={
                        'Authorization': 'Bearer ' + token})
                    assert response.status_code == 200, response.text
                    message = ws.receive()
                    assert message['type'] == 'websocket.close', message
                    assert message['code'] == 4401, message
                try:
                    with client.websocket_connect(url):
                        raise AssertionError('Revoked token accepted by ' + endpoint)
                except WebSocketDisconnect as exc:
                    assert exc.code == 4401, exc.code
        """)


if __name__ == "__main__":
    unittest.main()
