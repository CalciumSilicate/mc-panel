import asyncio
import json
import os
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import yaml
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import Session
from sqlalchemy.pool import StaticPool

_data = tempfile.TemporaryDirectory()
with patch.dict(os.environ, {'MCPANEL_DATA_DIR': _data.name}):
    from app import players
    from app.database import Base, get_db
    from app.deps import get_current_user
    from app.models import Server, User
    from app.routers import players as player_routes, users as user_routes


def tearDownModule():
    from app.database import engine
    engine.dispose()
    _data.cleanup()


class ManagementTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        (self.root/'server').mkdir()
        (self.root/'server/usercache.json').write_text(json.dumps([
            {'name': 'Alice', 'uuid': '00000000-0000-0000-0000-000000000001'},
            {'name': 'Other', 'uuid': '00000000-0000-0000-0000-000000000002'},
        ]))
        (self.root/'permission.yml').write_text('default_level: user\nowner: [Other]\nadmin: [Alice]\n')
        self.engine = create_engine('sqlite://', connect_args={'check_same_thread': False}, poolclass=StaticPool)
        Base.metadata.create_all(self.engine)
        self.addCleanup(self.engine.dispose)
        self.db = Session(self.engine)
        self.addCleanup(self.db.close)
        self.server = Server(id=1, name='Test', dir_name='test', server_type='vanilla', mc_version='1.21.1', port=25565)
        self.owner = User(id=1, username='owner', role='owner', hashed_password='x')
        self.admin = User(id=2, username='admin', role='admin', hashed_password='x')
        self.target = User(id=3, username='target', role='user', hashed_password='x', verified=True, player_id='Alice')
        self.db.add_all([self.server, self.owner, self.admin, self.target]); self.db.commit()
        self.actor = self.admin
        self.app = FastAPI()
        self.app.include_router(player_routes.router)
        self.app.include_router(user_routes.router)
        self.app.dependency_overrides[get_db] = lambda: self.db
        self.app.dependency_overrides[get_current_user] = lambda: self.actor
        self.client = TestClient(self.app)
        self.addCleanup(self.client.close)
        for name, replacement in [('instance_dir', lambda _: self.root), ('is_running', lambda _: False)]:
            p = patch.object(players.manager, name, replacement); p.start(); self.addCleanup(p.stop)
        p = patch('app.bridge.online_players', return_value={'Alice'}); p.start(); self.addCleanup(p.stop)

    def update(self, patch):
        return self.client.patch('/players/1/Alice', json=patch)

    def test_offline_op_and_bans_preserve_others(self):
        (self.root/'server/ops.json').write_text(json.dumps([{'name':'Other','uuid':'other','level':2,'bypassesPlayerLimit':True}]))
        self.assertEqual(self.update({'op': True}).json()['op_level'],4)
        self.assertEqual(self.update({'op': False}).json()['op_level'],None)
        self.assertEqual(json.loads((self.root/'server/ops.json').read_text())[0]['level'],2)
        row = self.update({'banned': True, 'ban_reason': '破坏建筑'}).json()
        self.assertEqual(row['ban_reason'], '破坏建筑')
        self.assertTrue(row['banned'])
        self.assertFalse(self.update({'banned': False}).json()['banned'])

    def test_permission_moves_player_and_preserves_default(self):
        self.assertEqual(self.update({'mcdr_perm':'helper'}).json()['mcdr_perm'],'helper')
        value=yaml.safe_load((self.root/'permission.yml').read_text())
        self.assertEqual(value['owner'],['Other'])
        self.assertEqual(value['admin'],[])
        self.assertEqual(value['default_level'],'user')
        self.assertEqual(self.update({'mcdr_perm':''}).json()['mcdr_perm'],'')

    def test_ban_without_usercache_retains_uuid(self):
        (self.root/'server/usercache.json').write_text('[]')
        (self.root/'server/banned-players.json').write_text(json.dumps([
            {'name':'Alice','uuid':'00000000-0000-0000-0000-000000000001','reason':'old'},
        ]))
        response = self.update({'banned':True,'ban_reason':'updated'})
        self.assertEqual(response.status_code,200,response.text)
        self.assertEqual(response.json()['uuid'],'00000000-0000-0000-0000-000000000001')

    def test_authorization_protection_and_validation(self):
        self.actor = self.target
        self.assertEqual(self.update({'op':True}).status_code,403)
        self.actor = self.admin
        self.server.protected=True; self.db.commit()
        self.assertEqual(self.update({'op':True}).status_code,409)
        self.server.protected=False; self.db.commit()
        self.assertEqual(self.update({'banned':True,'ban_reason':'bad\nop Other'}).status_code,422)
        self.assertEqual(self.update({'mcdr_perm':'root'}).status_code,422)
        self.assertEqual(self.update({'op':True,'banned':True}).status_code,400)
        self.assertEqual(self.client.patch('/players/1/Bad%20name',json={'op':True}).status_code,400)

    def test_running_command_acknowledges_persisted_result(self):
        async def send(sid, command):
            self.assertEqual(command, 'op Alice')
            (self.root/'server/ops.json').write_text('[{"name":"Alice","level":4}]')
        with patch.object(players.manager, 'is_running', return_value=True), patch.object(players.manager,'send_raw',side_effect=send):
            self.assertEqual(self.update({'op':True}).json()['op_level'],4)

    def test_running_permission_uses_mcdr_command(self):
        async def send(sid, command):
            self.assertEqual(command, '!!MCDR permission set Alice helper')
            (self.root/'permission.yml').write_text('default_level: user\nhelper: [Alice]\n')
        with patch.object(players.manager, 'is_running', return_value=True), patch.object(players.manager,'send_raw',side_effect=send):
            self.assertEqual(self.update({'mcdr_perm':'helper'}).json()['mcdr_perm'],'helper')

    def test_running_failure_does_not_claim_success(self):
        with patch.object(players.manager,'is_running',return_value=True), patch.object(players.manager,'send_raw',new=AsyncMock(side_effect=RuntimeError('实例未在运行'))):
            self.assertEqual(self.update({'op':True}).status_code,409)
        self.assertFalse((self.root/'server/ops.json').exists())

    def test_user_inline_fields_and_hierarchy(self):
        r=self.client.patch('/users/3',json={'username':'renamed','role':'helper','player_id':'Other'})
        self.assertEqual(r.status_code,200,r.text)
        self.assertEqual(r.json()['username'],'renamed')
        self.assertEqual(self.client.patch('/users/3',json={'role':'owner'}).status_code,400)
        self.assertEqual(self.client.patch('/users/1',json={'username':'steal'}).status_code,403)
        self.assertEqual(self.client.patch('/users/2',json={'username':'self'}).status_code,403)
        self.assertEqual(self.client.patch('/users/3',json={'username':'owner'}).status_code,409)
        self.assertEqual(self.client.patch('/users/3',json={'username':'   '}).status_code,400)
        r=self.client.patch('/users/3',json={'verified':False})
        self.assertEqual(r.json()['player_id'],'')

    def test_new_database_has_no_removed_models(self):
        from app.database import _COLUMN_MIGRATIONS
        for table in ['player_stats','player_metrics','stat_metrics','stat_json_reads','player_positions','map_markers','pcrc_instances']:
            self.assertNotIn(table,Base.metadata.tables)
            self.assertNotIn(table,_COLUMN_MIGRATIONS)


if __name__ == '__main__':
    unittest.main()
