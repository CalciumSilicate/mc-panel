from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock, patch

from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, text
from sqlalchemy.orm import Session, sessionmaker
from sqlalchemy.pool import StaticPool

from app import database
from app.deps import get_current_user
from app.models import Archive
from app.routers import archives


class ArchiveMetadataTests(unittest.TestCase):
    def setUp(self):
        self.engine = create_engine('sqlite://', connect_args={'check_same_thread': False}, poolclass=StaticPool)
        database.Base.metadata.create_all(self.engine)
        self.addCleanup(self.engine.dispose)
        self.sessions = sessionmaker(self.engine)
        with self.sessions() as db:
            db.add(Archive(id=1, name='world', filename='world.zip', mc_version='old-custom', owner_user_id=7))
            db.commit()
        self.user = SimpleNamespace(id=7, role='user', verified=True)
        app = FastAPI()
        app.include_router(archives.router)

        def session():
            with self.sessions() as db:
                yield db

        app.dependency_overrides[database.get_db] = session
        app.dependency_overrides[get_current_user] = lambda: self.user
        self.client = self.enterContext(TestClient(app))

    def test_notes_and_custom_versions_roundtrip_partial_update_and_clear(self):
        self.assertEqual(self.client.get('/archives').json()[0]['notes'], '')
        result = self.client.patch('/archives/1', json={'notes': '  地图一\n测试世界  ', 'mc_version': '  custom-26.3  '})
        self.assertEqual(result.status_code, 200, result.text)
        self.assertEqual((result.json()['notes'], result.json()['mc_version']), ('地图一\n测试世界', 'custom-26.3'))
        self.client.patch('/archives/1', json={'name': 'renamed'})
        with self.sessions() as db:
            record = db.get(Archive, 1)
            self.assertEqual(record.notes, '地图一\n测试世界')
            self.assertEqual(record.mc_version, 'custom-26.3')
        self.assertEqual(self.client.get('/archives').json()[0]['notes'], '地图一\n测试世界')
        result = self.client.patch('/archives/1', json={'notes': '', 'mc_version': ''})
        self.assertEqual((result.json()['notes'], result.json()['mc_version']), ('', ''))

    def test_only_owner_or_helper_can_change_metadata(self):
        self.user.id = 8
        result = self.client.patch('/archives/1', json={'notes': 'not mine', 'mc_version': '26.3'})
        self.assertEqual(result.status_code, 403)
        with self.sessions() as db:
            self.assertEqual(db.get(Archive, 1).notes, '')
        self.user.role = 'helper'
        self.assertEqual(self.client.patch('/archives/1', json={'notes': 'helper note'}).status_code, 200)

    def test_metadata_limits(self):
        for value in ({'notes': 'a' * 2001}, {'mc_version': 'a' * 65}):
            self.assertEqual(self.client.patch('/archives/1', json=value).status_code, 422)
        self.assertEqual(self.client.patch('/archives/1', json={'notes': 'a' * 2000}).status_code, 200)

    def test_authenticated_user_can_read_version_catalog(self):
        with patch.object(archives.versions_mod, 'list_mc_versions', new=AsyncMock(return_value=['test-snapshot'])) as catalog:
            result = self.client.get('/archives/versions?channel=snapshot&refresh=true')
            self.assertEqual(result.status_code, 200, result.text)
            self.assertEqual(result.json(), {'versions': ['test-snapshot']})
            catalog.assert_awaited_once_with('snapshot', force=True)
        self.assertEqual(self.client.get('/archives/versions?channel=invalid').status_code, 422)
        self.client.app.dependency_overrides.pop(get_current_user)
        self.assertEqual(self.client.get('/archives/versions').status_code, 401)

    def test_catalog_failure_does_not_prevent_custom_metadata(self):
        with patch.object(archives.versions_mod, 'list_mc_versions', new=AsyncMock(side_effect=RuntimeError('offline'))):
            self.assertEqual(self.client.get('/archives/versions').status_code, 502)
        result = self.client.patch('/archives/1', json={'mc_version': 'custom-offline', 'notes': '离线编辑'})
        self.assertEqual(result.status_code, 200)

    def test_existing_database_gets_empty_notes_without_losing_data(self):
        with self.engine.begin() as conn:
            conn.execute(text('ALTER TABLE archives DROP COLUMN notes'))
        with patch.object(database, 'engine', self.engine):
            database._migrate_columns()
            with Session(self.engine) as db:
                record = db.get(Archive, 1)
                self.assertEqual((record.notes, record.name, record.mc_version), ('', 'world', 'old-custom'))
                record.notes = '保留的备注'
                db.commit()
            database._migrate_columns()
        with Session(self.engine) as db:
            self.assertEqual(db.get(Archive, 1).notes, '保留的备注')
