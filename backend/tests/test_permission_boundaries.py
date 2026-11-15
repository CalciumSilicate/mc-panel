"""Role, verification and ownership checks through HTTP and live WebSockets."""
import asyncio
from contextlib import contextmanager
from pathlib import Path
import tempfile
from threading import Event
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock, Mock, patch

from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from starlette.websockets import WebSocketDisconnect

from app import database, security
from app.models import Archive, Server, ServerGroup, User
from app.routers import archives, chat, groups, servers, system


class PermissionBoundaryTests(unittest.TestCase):
    def setUp(self):
        temp = self.enterContext(tempfile.TemporaryDirectory())
        self.root = Path(temp)
        engine = create_engine(f"sqlite:///{self.root / 'test.sqlite'}")
        self.addCleanup(engine.dispose)
        database.Base.metadata.create_all(engine)
        self.sessions = sessionmaker(engine)
        self.enterContext(patch.object(security, 'get_secret_key', return_value='permission-test-key-' * 4))
        self.tokens = {}
        self.ids = {}
        with self.sessions() as db:
            for name in ('unverified', 'user', 'helper', 'admin', 'owner'):
                actor = User(username=name, hashed_password='unused',
                             role='user' if name == 'unverified' else name, verified=name == 'user')
                db.add(actor)
                db.flush()
                self.ids[name] = actor.id
                self.tokens[name] = security.create_access_token(
                    actor.id, actor.role, 10, session_id=actor.session_id)
            db.add(ServerGroup(id=1, name='玩家大厅', bridge_enabled=True, qq_group_ids='[123456]'))
            db.add_all([
                Server(id=1, name='ordinary', dir_name='ordinary', port=25565, group_id=1, auto_start=True),
                Server(id=2, name='protected', dir_name='protected', port=25566, protected=True),
            ])
            for aid, owner in ((1, 'unverified'), (2, 'user'), (3, 'admin')):
                db.add(Archive(id=aid, name=f'world-{aid}', filename=f'{aid}.zip',
                               owner_user_id=self.ids[owner], size=4))
                (self.root / f'{aid}.zip').write_bytes(b'test')
            db.commit()

        def get_db():
            with self.sessions() as db:
                yield db

        app = FastAPI()
        for module in (archives, chat, groups, servers, system):
            app.include_router(module.router)
        app.dependency_overrides[database.get_db] = get_db
        self.enterContext(patch.object(servers, 'SessionLocal', self.sessions))
        self.enterContext(patch.object(chat, 'SessionLocal', self.sessions))
        self.enterContext(patch.object(archives.am, 'archive_path', side_effect=lambda name: self.root / name))
        self.enterContext(patch.object(servers.manager, 'get_status', return_value='stopped'))
        self.enterContext(patch.object(servers.manager, 'needs_restart', return_value=True))
        self.enterContext(patch.object(servers.manager, 'is_running', return_value=False))
        self.enterContext(patch.object(servers.manager, 'lifecycle_lock', return_value=Mock(locked=lambda: False)))
        self.enterContext(patch.object(servers.manager, 'recent_lines', return_value=['test log']))
        self.queues = {}
        self.disconnected = Event()

        def subscribe(sid):
            self.queues[sid] = asyncio.Queue()
            return self.queues[sid]

        async def send(server, command):
            self.queues[server.id].put_nowait(f'accepted: {command}')

        self.enterContext(patch.object(servers.manager, 'subscribe', side_effect=subscribe))
        self.enterContext(patch.object(servers.manager, 'unsubscribe', side_effect=lambda *_: self.disconnected.set()))
        self.send = self.enterContext(patch.object(servers.manager, 'send_command', new=AsyncMock(side_effect=send)))
        self.restore = self.enterContext(patch.object(archives, '_do_restore', new=AsyncMock()))
        self.prepare = self.enterContext(patch.object(archives, '_prepare_server', new=AsyncMock()))
        self.enterContext(patch.object(archives.jobstore, 'create', return_value='test-job'))
        # Close the unused install coroutine instead of starting any real install.
        self.install = self.enterContext(patch.object(servers, '_launch_install', side_effect=lambda sid, coro: coro.close()))
        resource = SimpleNamespace(used=1, total=10, available=9, free=9, percent=10)
        for name in ('virtual_memory', 'disk_usage'):
            self.enterContext(patch.object(system.psutil, name, return_value=resource))
        self.enterContext(patch.object(system.psutil, 'cpu_percent', return_value=10))
        self.enterContext(patch.object(system.host_metrics, 'history', return_value=([], 5)))
        self.client = self.enterContext(TestClient(app))

    def headers(self, role):
        return {'Authorization': f'Bearer {self.tokens[role]}'}

    @contextmanager
    def console(self, role, sid=1):
        self.disconnected.clear()
        with self.client.websocket_connect(f'/servers/{sid}/console?token={self.tokens[role]}') as ws:
            try:
                yield ws
            finally:
                ws.close()
                # Let server cleanup finish before TestClient cancels its task.
                self.assertTrue(self.disconnected.wait(5), 'console did not unsubscribe')

    def test_chat_rooms_are_authenticated_and_do_not_expose_group_configuration(self):
        self.assertEqual(self.client.get('/chat/rooms').status_code, 401)
        for role in self.tokens:
            with self.subTest(role=role):
                result = self.client.get('/chat/rooms', headers=self.headers(role))
                self.assertEqual(result.status_code, 200, result.text)
                self.assertEqual(result.json(), [{'id': 1, 'name': '玩家大厅'}])
                result = self.client.get('/groups', headers=self.headers(role))
                self.assertEqual(result.status_code, 403 if role in ('unverified', 'user') else 200)

    def test_user_chat_is_readable_and_verification_gates_sending(self):
        with patch.object(chat.chat, 'recent', return_value=[{'text': 'hello'}]):
            with self.client.websocket_connect(f'/chat/ws/1?token={self.tokens["unverified"]}') as ws:
                self.assertEqual(ws.receive_json(), {'text': 'hello'})
        with patch.object(chat.chat, 'publish') as publish, patch.object(
            chat.onebot, 'client', SimpleNamespace(connected=False)
        ):
            for role, status in (('unverified', 403), ('user', 200)):
                result = self.client.post('/chat/1/send', json={'text': 'hello'}, headers=self.headers(role))
                self.assertEqual(result.status_code, status, result.text)
            publish.assert_called_once()

    def test_console_read_and_write_roles_on_both_protected_and_ordinary_servers(self):
        for sid in (1, 2):
            for role in ('unverified', 'user'):
                with self.subTest(sid=sid, role=role), self.assertRaises(WebSocketDisconnect) as error:
                    with self.console(role, sid):
                        self.fail('user was allowed into console')
                self.assertEqual(error.exception.code, 4403)
            with self.console('helper', sid) as ws:
                self.assertEqual(ws.receive_json(), {'type': 'log', 'line': 'test log'})
                for command in ('op Alice', 'stop', 'say hello\nban Alice'):
                    ws.send_json({'command': command})
                    self.assertEqual(ws.receive_json(), {'type': 'error', 'message': '仅管理员可发送控制台命令'})
                self.send.assert_not_awaited()
            for role in ('admin', 'owner'):
                with self.console(role, sid) as ws:
                    ws.receive_json()
                    ws.send_json({'command': 'say hello'})
                    self.assertEqual(ws.receive_json(), {'type': 'log', 'line': 'accepted: say hello'})
                self.assertEqual(self.send.await_args.args[0].id, sid)
                self.send.reset_mock()

    def test_console_rechecks_role_after_connect(self):
        with self.console('admin') as ws:
            ws.receive_json()
            with self.sessions() as db:
                db.get(User, self.ids['admin']).role = 'helper'
                db.commit()
            ws.send_json({'command': 'op Alice'})
            self.assertEqual(ws.receive_json()['type'], 'error')
            self.send.assert_not_awaited()

    def test_unverified_archive_owner_can_read_but_cannot_mutate(self):
        headers = self.headers('unverified')
        self.assertEqual(self.client.get('/archives', headers=headers).status_code, 200)
        self.assertEqual(self.client.get('/archives/1/download', headers=headers).content, b'test')
        result = self.client.patch('/archives/1', json={'notes': 'unauthorized'}, headers=headers)
        self.assertEqual(result.status_code, 403)
        self.assertEqual(self.client.delete('/archives/1', headers=headers).status_code, 403)
        self.assertEqual(self.client.post('/archives/1/restore/1', headers=headers).status_code, 403)
        with self.sessions() as db:
            self.assertEqual(db.get(Archive, 1).notes, '')
        self.assertTrue((self.root / '1.zip').exists())
        self.prepare.assert_not_awaited()
        self.restore.assert_not_awaited()

    def test_archive_ownership_applies_to_restore_before_any_stop_or_job(self):
        headers = self.headers('user')
        for aid in (1, 3):
            result = self.client.post(f'/archives/{aid}/restore/1', json={'force': True}, headers=headers)
            self.assertEqual(result.status_code, 403, result.text)
        self.prepare.assert_not_awaited()
        self.restore.assert_not_awaited()
        result = self.client.post('/archives/2/restore/1', headers=headers)
        self.assertEqual(result.status_code, 200, result.text)
        for role in ('helper', 'admin', 'owner'):
            result = self.client.post('/archives/2/restore/1', headers=self.headers(role))
            self.assertEqual(result.status_code, 200, result.text)
            result = self.client.post('/archives/2/restore/2', headers=self.headers(role))
            self.assertEqual(result.status_code, 409, result.text)

    def test_archive_mutations_still_work_for_verified_owner_and_staff(self):
        for role, aid in (('user', 2), ('helper', 3), ('admin', 3), ('owner', 3)):
            result = self.client.patch(f'/archives/{aid}', json={'notes': role}, headers=self.headers(role))
            self.assertEqual(result.status_code, 200, result.text)
            self.assertEqual(result.json()['notes'], role)
        self.assertEqual(self.client.patch('/archives/3', json={'notes': 'no'}, headers=self.headers('user')).status_code, 403)
        self.assertEqual(self.client.delete('/archives/3', headers=self.headers('user')).status_code, 403)
        self.assertEqual(self.client.delete('/archives/2', headers=self.headers('user')).status_code, 200)
        self.assertEqual(self.client.delete('/archives/3', headers=self.headers('helper')).status_code, 200)

    def test_protected_reinstall_is_denied_before_scheduling(self):
        for role in self.tokens:
            for sid in (1, 2):
                with self.subTest(role=role, sid=sid):
                    self.install.reset_mock()
                    result = self.client.post(f'/servers/{sid}/reinstall', headers=self.headers(role))
                    expected = 403 if role not in ('admin', 'owner') else 409 if sid == 2 else 200
                    self.assertEqual(result.status_code, expected, result.text)
                    self.assertEqual(self.install.call_count, int(expected == 200))

    def test_dashboard_hides_management_data_but_preserves_player_resources(self):
        for role in self.tokens:
            result = self.client.get('/system/overview', headers=self.headers(role))
            self.assertEqual(result.status_code, 200, result.text)
            payload = result.json()
            for field in ('cpu_percent', 'memory', 'disk', 'history', 'total_servers', 'running_servers'):
                self.assertIn(field, payload)
            player = role in ('unverified', 'user')
            for field in ('host_uptime_seconds', 'archive_count', 'archive_bytes', 'recent_archives'):
                self.assertEqual(field in payload, not player, field)
            for field in ('port', 'auto_start', 'group_id', 'group_name', 'needs_restart'):
                self.assertEqual(field in payload['servers'][0], not player, field)
            self.assertEqual(payload['servers'][0]['max_memory'], '2G')
