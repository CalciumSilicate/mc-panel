import asyncio
import json
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import Session
from sqlalchemy.pool import StaticPool

from app import proxy
from app.database import Base, get_db
from app.deps import get_current_user
from app.models import ProxyCustomBackend, Server, User
from app.routers import servers


class JoinMotdTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.a = Server(id=2, name='Survival One', dir_name='a', server_type='fabric', protected=False)
        self.b = Server(id=3, name='创造服', dir_name='b', server_type='forge', protected=False)
        self.network = Server(id=1, name='Network', dir_name='proxy', server_type='velocity')
        self.custom = SimpleNamespace(name='Remote-Hub')
        for name, value in [
            ('instance_dir', lambda s: self.root / s.dir_name),
            ('get_status', lambda s: 'running' if s.id == 2 else 'stopped'),
            ('send_command', AsyncMock()),
        ]:
            p = patch.object(proxy.manager, name, value)
            p.start()
            self.addCleanup(p.stop)
        p = patch.object(proxy.plugins, 'install_from_catalogue', new_callable=AsyncMock)
        self.install = p.start()
        self.install.return_value = {'file_name': 'joinMOTD-v1.4.0.mcdr'}
        self.addCleanup(p.stop)

    def config(self, server):
        return self.root / server.dir_name / 'config/joinMOTD.json'

    def write(self, server, content):
        target = self.config(server)
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(content, encoding='utf-8')

    def run_config(self):
        return asyncio.run(proxy.configure_join_motd(self.network, [self.a, self.b], [self.custom], 'python'))

    def test_topology_names_preservation_and_running_vs_stopped(self):
        self.write(self.a, json.dumps({'start_day': '2020-01-02', 'auto_reload_interval': 17, 'extra': True}))
        result = self.run_config()
        self.assertEqual([r['status'] for r in result], ['ok', 'ok', 'skipped'])
        a = json.loads(self.config(self.a).read_text(encoding='utf-8'))
        b = json.loads(self.config(self.b).read_text(encoding='utf-8'))
        self.assertEqual(a['serverName'], 'Survival One')
        self.assertEqual(b['serverName'], '创造服')
        self.assertEqual(a['mainServerName'], 'Network')
        expected = [
            {'name': 'survival_one', 'display': 'Survival One'},
            {'name': 'server', 'display': '创造服'},
            {'name': 'remote_hub', 'display': 'Remote-Hub'},
        ]
        self.assertEqual(a['serverList'], expected)
        self.assertEqual(b['serverList'], expected)
        self.assertEqual((a['start_day'], a['auto_reload_interval'], a['extra']), ('2020-01-02', 17, True))
        self.assertEqual(self.install.await_count, 2)
        self.assertEqual([c.args for c in proxy.manager.send_command.await_args_list], [
            (self.a, '!!MCDR plugin load "joinMOTD-v1.4.0.mcdr"'),
        ])

    def test_protected_and_invalid_configs_do_not_write_but_continue(self):
        for content in ['broken json', '[]', '{"commonJsonDataPath":"shared.json"}']:
            with self.subTest(content=content):
                self.write(self.a, content)
                result = self.run_config()
                self.assertEqual([r['status'] for r in result], ['error', 'ok', 'skipped'])
                self.assertEqual(self.config(self.a).read_text(encoding='utf-8'), content)
        self.a.protected = True
        self.assertIn('受保护', self.run_config()[0]['detail'])

    def test_existing_enabled_plugin_not_downloaded_and_disabled_not_changed(self):
        with patch.object(proxy.plugins, 'list_plugins', return_value=[{'id': 'join_motd', 'enabled': True}]):
            self.run_config()
            self.install.assert_not_awaited()
            proxy.manager.send_command.assert_awaited_once_with(self.a, '!!MCDR plugin reload join_motd')
        before = self.config(self.a).read_bytes()
        with patch.object(proxy.plugins, 'list_plugins', return_value=[{'id': 'join_motd', 'enabled': False}]):
            self.assertIn('已禁用', self.run_config()[0]['detail'])
        self.assertEqual(self.config(self.a).read_bytes(), before)

    def test_download_and_reload_failures_are_per_server(self):
        self.install.side_effect = [RuntimeError('offline'), {'file_name': 'joinMOTD-v1.4.0.mcdr'}]
        self.assertEqual([r['status'] for r in self.run_config()], ['error', 'ok', 'skipped'])
        self.assertFalse(self.config(self.a).exists())
        self.install.side_effect = None
        proxy.manager.send_command.side_effect = RuntimeError('pipe closed')
        result = self.run_config()
        self.assertIn('配置已保存', result[0]['detail'])
        self.assertTrue(self.config(self.a).exists())
        self.assertEqual(result[1]['status'], 'ok')


class JoinMotdRouteTests(unittest.TestCase):
    def test_authorization_network_scope_and_collision_preflight(self):
        engine = create_engine('sqlite://', connect_args={'check_same_thread': False}, poolclass=StaticPool)
        self.addCleanup(engine.dispose)
        Base.metadata.create_all(engine)
        with Session(engine) as db:
            def server(id, name, kind, proxy_id=None):
                return Server(id=id, name=name, dir_name=str(id), server_type=kind, port=25560+id, proxy_id=proxy_id)
            network = server(1, 'Network', 'velocity')
            backend = server(2, 'Survival One', 'fabric', 1)
            db.add_all([network, backend, server(3, 'Unrelated', 'forge')])
            custom = ProxyCustomBackend(proxy_id=1, name='Remote', host='example.test', port=25565)
            db.add(custom)
            db.commit()
            actor = User(username='test', role='helper', hashed_password='x')
            app = FastAPI()
            app.include_router(servers.router)
            app.dependency_overrides[get_db] = lambda: db
            app.dependency_overrides[get_current_user] = lambda: actor
            with TestClient(app) as client, patch.object(proxy, 'configure_join_motd', new_callable=AsyncMock, return_value=[]) as configure:
                path = '/servers/proxy/1/join-motd'
                self.assertEqual(client.post(path).status_code, 403)
                actor.role = 'admin'
                self.assertEqual(client.post(path).status_code, 200)
                self.assertEqual([s.id for s in configure.await_args.args[1]], [2])
                self.assertEqual([s.name for s in configure.await_args.args[2]], ['Remote'])
                configure.reset_mock()
                custom.name = 'survival-one'
                db.commit()
                self.assertEqual(client.post(path).status_code, 400)
                configure.assert_not_awaited()
                custom.name = 'try'
                db.commit()
                self.assertEqual(client.post(path).status_code, 400)
                network.protected = True
                db.commit()
                self.assertEqual(client.post(path).status_code, 409)
                self.assertEqual(client.post('/servers/proxy/2/join-motd').status_code, 400)
                self.assertEqual(client.post('/servers/proxy/999/join-motd').status_code, 404)
