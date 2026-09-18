import hashlib
import io
import json
import stat
import tempfile
import threading
import time
import unittest
import zipfile
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, select
from sqlalchemy.orm import sessionmaker

from app import server_files, server_import, uploads
from app.database import Base
from app.deps import get_current_user
from app.models import Server
from app.routers import uploads as routes


class UploadTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name)
        self.servers = self.root / "servers"
        (self.servers / "existing" / "server").mkdir(parents=True)
        self.engine = create_engine(f"sqlite:///{self.root / 'test.db'}", connect_args={"check_same_thread": False})
        Base.metadata.create_all(self.engine)
        self.addCleanup(self.engine.dispose)
        self.sessions = sessionmaker(self.engine)
        with self.sessions() as db:
            db.add(Server(id=1, name="existing", dir_name="existing", port=25499))
            db.commit()
        for item in (
            patch.object(uploads, "ROOT", self.root / "uploads"),
            patch.object(uploads, "SessionLocal", self.sessions),
            patch.object(server_import, "SessionLocal", self.sessions),
            patch.object(server_import, "SERVERS_ROOT", self.servers),
            patch.object(server_files, "SERVERS_ROOT", self.servers),
            patch.object(server_files.manager, "instance_dir", side_effect=lambda s: self.servers / s.dir_name),
            patch("app.ports.is_port_free", return_value=True),
        ):
            item.start()
            self.addCleanup(item.stop)
        app = FastAPI()
        app.include_router(routes.router)
        self.user = SimpleNamespace(id=10, role="admin")
        app.dependency_overrides[get_current_user] = lambda: self.user
        self.client = self.enterContext(TestClient(app))

    def create(self, name="test.bin", size=6, **kwargs):
        response = self.client.post("/uploads", json={"kind": "file", "server_id": 1,
                                    "directory": "server", "name": name, "size": size, **kwargs})
        self.assertEqual(response.status_code, 201, response.text)
        return response.json()["id"]

    def chunk(self, uid, data, offset=0):
        return self.client.put(f"/uploads/{uid}/chunks?offset={offset}", content=data,
                               headers={"x-chunk-sha256": hashlib.sha256(data).hexdigest()})

    def finish(self, uid):
        response = self.client.post(f"/uploads/{uid}/complete")
        self.assertEqual(response.status_code, 202, response.text)
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            state = self.client.get(f"/uploads/{uid}").json()
            if state["status"] != "processing":
                return state
            time.sleep(0.01)
        self.fail("background finalization timed out")

    def test_chunk_retry_resume_and_atomic_publish(self):
        uid = self.create()
        self.assertEqual(self.chunk(uid, b"abc").status_code, 200)
        self.assertEqual(self.chunk(uid, b"abc").json()["received"], 3)
        self.assertEqual(self.chunk(uid, b"zzz").status_code, 409)
        self.assertEqual(self.chunk(uid, b"z", 5).status_code, 409)
        self.assertEqual(self.client.post(f"/uploads/{uid}/complete").status_code, 409)
        # Simulate bytes written before metadata was committed at a restart.
        with (uploads.folder(uid) / "data.part").open("ab") as stream:
            stream.write(b"uncommitted")
        uploads.recover()
        self.assertEqual(self.chunk(uid, b"def", 3).json()["received"], 6)
        self.assertFalse((self.servers / "existing/server/test.bin").exists())
        self.assertEqual(self.finish(uid)["status"], "done")
        self.assertEqual((self.servers / "existing/server/test.bin").read_bytes(), b"abcdef")

    def test_auth_protection_paths_limits_and_zero_file(self):
        uid = self.create(size=0)
        self.user.id = 11
        self.assertEqual(self.client.get(f"/uploads/{uid}").status_code, 404)
        self.user.role = "user"
        self.assertEqual(self.client.get(f"/uploads/{uid}").status_code, 403)
        self.user.id, self.user.role = 10, "admin"
        self.assertEqual(self.finish(uid)["status"], "done")
        for path in ("../escape", "/absolute", "NUL", "a\\b"):
            response = self.client.post("/uploads", json={"kind": "file", "server_id": 1, "name": path, "size": 1})
            self.assertEqual(response.status_code, 400)
        uid = self.create(name="big.bin", size=uploads.CHUNK_BYTES + 1)
        self.assertEqual(self.chunk(uid, b"x" * (uploads.CHUNK_BYTES + 1)).status_code, 413)
        self.assertEqual(self.client.put(f"/uploads/{uid}/chunks?offset=0", content=b"x", headers={"x-chunk-sha256": "0" * 64}).status_code, 400)
        with self.sessions() as db:
            db.get(Server, 1).protected = True
            db.commit()
        response = self.client.post("/uploads", json={"kind": "file", "server_id": 1, "name": "a", "size": 1})
        self.assertEqual(response.status_code, 409)

    def test_conflict_and_protection_rechecked_on_publish(self):
        target = self.servers / "existing/server/test.bin"
        target.write_bytes(b"old")
        response = self.client.post("/uploads", json={"kind": "file", "server_id": 1, "directory": "server", "name": "test.bin", "size": 3})
        self.assertEqual(response.status_code, 409)
        uid = self.create(size=3, overwrite=True)
        self.chunk(uid, b"new")
        target.write_bytes(b"external change")
        self.assertEqual(self.finish(uid)["status"], "error")
        self.assertEqual(target.read_bytes(), b"external change")
        uid = self.create(name="new.bin", size=3)
        self.chunk(uid, b"new")
        with self.sessions() as db:
            db.get(Server, 1).protected = True
            db.commit()
        self.assertEqual(self.finish(uid)["status"], "error")
        self.assertFalse((target.parent / "new.bin").exists())

    def test_complete_returns_before_slow_work(self):
        uid = self.create(size=3)
        self.chunk(uid, b"abc")
        release = threading.Event()
        original = uploads.process
        def slow(task):
            release.wait(3)
            original(task)
        with patch.object(uploads, "process", side_effect=slow):
            try:
                before = time.monotonic()
                result = self.client.post(f"/uploads/{uid}/complete")
                self.assertLess(time.monotonic() - before, 1)
                self.assertEqual(result.json()["status"], "processing")
                self.assertEqual(self.client.delete(f"/uploads/{uid}").status_code, 409)
            finally:
                release.set()
            self.assertEqual(self.finish(uid)["status"], "done")

    def make_package(self, extra=None):
        jar = io.BytesIO()
        with zipfile.ZipFile(jar, "w") as z:
            z.writestr("version.json", json.dumps({"id": "1.21.1"}))
        data = io.BytesIO()
        with zipfile.ZipFile(data, "w") as z:
            z.writestr("pack/server.jar", jar.getvalue())
            z.writestr("pack/world/level.dat", b"world-data")
            z.writestr("pack/mods/mod.jar", b"mod-data")
            z.writestr("pack/server.properties", "motd=existing\nserver-port=25565\n")
            if extra:
                z.writestr(*extra)
        return data.getvalue()

    def test_package_import_preserves_data_and_creates_new_instance(self):
        data = self.make_package()
        uid = self.create(name="pack.zip", size=len(data), kind="package", server_id=None,
                          options={"name": "imported", "port": 25571})
        self.chunk(uid, data)
        result = self.finish(uid)
        self.assertEqual(result["status"], "done", result)
        with self.sessions() as db:
            server = db.get(Server, result["server_id"])
            self.assertEqual(server.name, "imported")
            self.assertEqual(server.mc_version, "1.21.1")
            self.assertFalse(server.auto_start)
            root = self.servers / server.dir_name
        self.assertEqual((root / "server/world/level.dat").read_bytes(), b"world-data")
        self.assertEqual((root / "server/mods/mod.jar").read_bytes(), b"mod-data")
        self.assertIn("motd=existing", (root / "server/server.properties").read_text())
        self.assertIn("server-port=25571", (root / "server/server.properties").read_text())
        self.assertTrue((root / "config.yml").exists())
        self.assertTrue((self.servers / "existing").exists())

    def test_bad_archives_do_not_create_instance_or_escape(self):
        symlink = zipfile.ZipInfo("pack/link")
        symlink.create_system = 3
        symlink.external_attr = (stat.S_IFLNK | 0o777) << 16
        for entry in (("../escape", "bad"), ("/absolute", "bad"), (symlink, "../../escape"), ("pack/SERVER.jar", "duplicate")):
            data = self.make_package(entry)
            uid = self.create(name="bad.zip", size=len(data), kind="package", server_id=None,
                              options={"name": "bad", "port": 25572})
            self.chunk(uid, data)
            self.assertEqual(self.finish(uid)["status"], "error")
        with self.sessions() as db:
            self.assertEqual(len(db.scalars(select(Server)).all()), 1)
        self.assertFalse((self.root / "escape").exists())
        self.assertEqual([p.name for p in self.servers.iterdir()], ["existing"])

    def test_mcdr_layout_rebinds_paths_and_preserves_configuration(self):
        import yaml
        root = self.root / "mcdr-source"
        (root / "server/world").mkdir(parents=True)
        (root / "plugins").mkdir()
        (root / "server/server.jar").write_bytes(b"existing core")
        (root / "server/world/level.dat").write_bytes(b"world")
        (root / "plugins/test.mcdr").write_bytes(b"plugin")
        (root / "config.yml").write_text(yaml.safe_dump({
            "language": "en_us", "working_directory": "/old/path",
            "start_command": "old-launch", "plugin_directories": ["/old/plugins"],
        }))
        (root / "permission.yml").write_text("default_level: 1\n")
        dest = self.root / "imported"
        server_import.prepare(root, dest, {"server_type": "vanilla", "min_memory": "1G",
                              "max_memory": "2G", "port": 25573, "mc_version": "1.21"}, "java")
        cfg = yaml.safe_load((dest / "config.yml").read_text())
        self.assertEqual(cfg["working_directory"], "server")
        self.assertEqual(cfg["plugin_directories"], ["plugins"])
        self.assertEqual(cfg["language"], "en_us")
        self.assertEqual(cfg["start_command"][0], "java")
        self.assertEqual((dest / "permission.yml").read_text(), "default_level: 1\n")
        self.assertEqual((dest / "server/world/level.dat").read_bytes(), b"world")
        self.assertEqual((dest / "plugins/test.mcdr").read_bytes(), b"plugin")
