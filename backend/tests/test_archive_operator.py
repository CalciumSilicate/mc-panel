import asyncio
import io
import tempfile
import unittest
import zipfile
from pathlib import Path
from unittest.mock import patch
from fastapi import UploadFile
from sqlalchemy import create_engine, text, select
from sqlalchemy.orm import Session, sessionmaker
from sqlalchemy.pool import StaticPool
from app import database
from app.models import Archive, User, Server
from app.routers import archives


class ArchiveOperatorTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.engine = create_engine('sqlite://', connect_args={'check_same_thread':False}, poolclass=StaticPool)
        database.Base.metadata.create_all(self.engine)
        self.addCleanup(self.engine.dispose)
        self.db = Session(self.engine)
        self.addCleanup(self.db.close)
        self.user = User(username='uploader', hashed_password='x', role='helper')
        self.server = Server(name='survival', dir_name='survival')
        self.db.add_all([self.user, self.server]); self.db.commit()
        for target, value in [('ARCHIVES_DIR', Path(self.temp.name))]:
            p = patch.object(archives.am, target, value); p.start(); self.addCleanup(p.stop)

    def test_upload_snapshots_operator(self):
        data = io.BytesIO()
        with zipfile.ZipFile(data, 'w') as archive:
            archive.writestr('world/readme.txt', 'world')
        data.seek(0)
        result = asyncio.run(archives.upload_archive(UploadFile(filename='world.zip', file=data), '', self.user, self.db))
        self.assertEqual(result.operator_name, 'uploader')
        self.user.username = 'renamed'; self.db.commit()
        self.db.refresh(result)
        self.assertEqual(result.operator_name, 'uploader')

    def test_server_creation_records_initiator(self):
        job = archives.jobstore.create()
        with patch.object(archives, 'SessionLocal', sessionmaker(bind=self.engine)), patch.object(archives.am, 'create_zip', return_value=42), patch.object(archives.am, 'data_version_from_world', return_value=None):
            asyncio.run(archives._do_create(self.server.id, 'new.zip', job, self.user.id, self.user.username))
        record = self.db.scalar(select(Archive))
        self.assertEqual(record.operator_name, 'uploader')
        self.assertEqual(record.source, 'server')

    def test_migration_backfills_and_preserves_snapshot(self):
        with self.engine.begin() as conn:
            conn.execute(text('ALTER TABLE archives DROP COLUMN operator_name'))
            conn.execute(text("INSERT INTO archives (name,filename,owner_user_id,size,source,mc_version,created_at) VALUES ('old','old.zip',:uid,0,'server','',CURRENT_TIMESTAMP)"), {'uid':self.user.id})
        with patch.object(database, 'engine', self.engine):
            database._migrate_columns()
            with self.engine.begin() as conn:
                self.assertEqual(conn.scalar(text('SELECT operator_name FROM archives')), 'uploader')
                conn.execute(text("UPDATE users SET username='renamed'"))
            database._migrate_columns()
            with self.engine.connect() as conn:
                self.assertEqual(conn.scalar(text('SELECT operator_name FROM archives')), 'uploader')
