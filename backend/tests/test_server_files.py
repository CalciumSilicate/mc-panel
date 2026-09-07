"""Run: python -m unittest discover -s tests -v (no app.main import)."""
import hashlib
import os
import stat
import subprocess
import tempfile
import threading
import unittest
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient

# database imports create directories; isolate even these import-time effects.
_import_data = tempfile.TemporaryDirectory()
with patch.dict(os.environ, {"MCPANEL_DATA_DIR": _import_data.name}):
    from app import server_files as files
    from app.deps import get_current_user
    from app.routers import server_files as routes


def tearDownModule():
    from app.database import engine
    engine.dispose()
    _import_data.cleanup()


class ServerFilesTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.base = Path(temp.name) / "servers"
        self.root = self.base / "one"
        self.root.mkdir(parents=True)
        (self.base / "two").mkdir()
        (self.base / "two" / "secret").write_bytes(b"secret")
        self.server = SimpleNamespace(id=1, dir_name="one", protected=False)
        self.file = self.root / "config.txt"
        self.file.write_bytes(b"hello\n")
        for patcher in (patch.object(files, "SERVERS_ROOT", self.base),
                        patch.object(files.manager, "instance_dir", side_effect=lambda s: self.base / s.dir_name)):
            patcher.start()
            self.addCleanup(patcher.stop)

    def error(self, code, fn, *args):
        with self.assertRaises(HTTPException) as caught:
            fn(*args)
        self.assertEqual(caught.exception.status_code, code)
        self.assertNotIn(str(self.base), caught.exception.detail)

    def read(self):
        return files.read_content(self.server, "config.txt")

    def save(self, text, revision=None):
        return files.save_content(self.server, "config.txt", text, revision or self.read()["revision"])

    def test_paths_and_instance_root(self):
        for path in ("", "/config.txt", "../two/secret", "a/../../two/secret", "./config.txt",
                     "a//b", "a/", "C:/x", "C:x", "\\\\host\\share", "a\\b", "a:stream",
                     "a\x00", "a\x7f", "NUL.txt", "COM1", "lpt9.log", "COM¹.txt", "a.", "a "):
            with self.subTest(path=path):
                self.error(400, files.read_content, self.server, path)
        for name in ("../two", "one/../two", "", "C:\\x", "one/child"):
            self.error(400, files.list_directory, SimpleNamespace(dir_name=name))
        with patch.object(files.manager, "instance_dir", return_value=self.base / "two"):
            self.error(400, files.list_directory, self.server)
        self.error(404, files.read_content, self.server, "missing")
        self.error(404, files.save_content, self.server, "missing", "x", "0" * 64)
        self.assertFalse((self.root / "missing").exists())

    def test_listing_and_types(self):
        (self.root / "z-dir").mkdir()
        (self.root / "z-dir" / "中文.txt").write_bytes(b"ok")
        listing = files.list_directory(self.server)
        self.assertEqual(listing["path"], "")
        self.assertEqual(listing["entries"][0]["kind"], "directory")
        self.assertEqual(files.list_directory(self.server, "z-dir")["entries"][0]["path"], "z-dir/中文.txt")
        self.assertIsNotNone(datetime.fromisoformat(listing["entries"][0]["modified_at"]).tzinfo)
        self.error(400, files.read_content, self.server, "z-dir")
        self.error(400, files.list_directory, self.server, "config.txt")

    def test_formats_and_roundtrip(self):
        for bom in (b"", b"\xef\xbb\xbf"):
            for ending, label in ((b"\n", "LF"), (b"\r\n", "CRLF"), (b"\r", "CR")):
                with self.subTest(bom=bom, ending=ending):
                    original = bom + b"one" + ending + b"two" + ending
                    self.file.write_bytes(original)
                    content = self.read()
                    self.assertEqual(content["text"], "one\ntwo\n")
                    self.assertEqual(content["newline"], label)
                    self.assertEqual(content["bom"], bool(bom))
                    self.assertEqual(content["revision"], hashlib.sha256(original).hexdigest())
                    result = self.save("new\r\nline\r")
                    self.assertEqual(self.file.read_bytes(), bom + b"new" + ending + b"line" + ending)
                    self.assertEqual(result, self.read())
        self.file.write_bytes(b"")
        self.assertEqual(self.read()["newline"], "LF")
        self.assertEqual(self.save("中文\t文本")["text"], "中文\t文本")

    def test_mixed_binary_and_size(self):
        self.file.write_bytes(b"a\r\nb\nc\r")
        self.assertFalse(self.read()["editable"])
        self.assertEqual(self.read()["newline"], "mixed")
        self.error(409, self.save, "new")
        for raw in (b"\xff", b"\x00", b"abc\x01", b"\x7f", b"\xc2\x85", b"\xff\xfea\x00"):
            self.file.write_bytes(raw)
            self.error(415, self.read)
        self.file.write_bytes(b"a" * files.MAX_BYTES)
        self.assertEqual(self.read()["size_bytes"], files.MAX_BYTES)
        self.file.write_bytes(b"a" * (files.MAX_BYTES + 1))
        self.error(413, self.read)
        self.file.write_bytes(b"ok")
        self.error(413, self.save, "中" * (files.MAX_BYTES // 3 + 1))
        self.error(415, self.save, "a\x00")
        self.error(415, self.save, "\ud800")

    def test_hardlinks(self):
        os.link(self.file, self.root / "hard")
        self.error(400, self.read)
        self.error(400, files.save_content, self.server, "hard", "x", "0" * 64)
        entries = files.list_directory(self.server)["entries"]
        self.assertTrue(all(e["kind"] == "blocked" and e["reason"] for e in entries))

    def test_symlinks_and_linked_root(self):
        link = self.root / "link"
        try:
            link.symlink_to(self.base / "two", target_is_directory=True)
        except OSError as exc:
            self.skipTest(f"symlink privilege unavailable: {exc.winerror if os.name == 'nt' else exc.errno}")
        self.error(400, files.read_content, self.server, "link/secret")
        self.error(400, files.list_directory, self.server, "link")
        self.assertEqual(next(e for e in files.list_directory(self.server)["entries"] if e["name"] == "link")["kind"], "blocked")
        (self.base / "linked").symlink_to(self.root, target_is_directory=True)
        self.error(400, files.list_directory, SimpleNamespace(dir_name="linked"))
        (self.root / "dangling").symlink_to(self.root / "absent")
        self.error(400, files.read_content, self.server, "dangling")

    @unittest.skipUnless(os.name == "nt", "Windows junctions")
    def test_windows_junction(self):
        junction = self.root / "junction"
        result = subprocess.run(["cmd", "/c", "mklink", "/J", str(junction), str(self.base / "two")], capture_output=True)
        if result.returncode:
            self.skipTest("junction creation unavailable")
        self.addCleanup(lambda: os.rmdir(junction))
        self.error(400, files.read_content, self.server, "junction/secret")
        self.error(400, files.list_directory, self.server, "junction")
        self.assertEqual(next(e for e in files.list_directory(self.server)["entries"] if e["name"] == "junction")["kind"], "blocked")
        root_link = self.base / "linked"
        subprocess.run(["cmd", "/c", "mklink", "/J", str(root_link), str(self.root)], check=True, capture_output=True)
        self.addCleanup(lambda: os.rmdir(root_link))
        self.error(400, files.list_directory, SimpleNamespace(dir_name="linked"))

    @unittest.skipIf(os.name == "nt", "POSIX special files and modes")
    def test_fifo_and_mode(self):
        os.mkfifo(self.root / "pipe")
        self.error(400, files.read_content, self.server, "pipe")
        self.assertEqual(next(e for e in files.list_directory(self.server)["entries"] if e["name"] == "pipe")["kind"], "blocked")
        self.file.chmod(0o640)
        self.save("new")
        self.assertEqual(stat.S_IMODE(self.file.stat().st_mode), 0o640)

    def test_opened_fstat_revalidated(self):
        with patch.object(files.os, "fstat", return_value=SimpleNamespace(st_mode=stat.S_IFREG, st_nlink=2)):
            self.error(400, self.read)
        with patch.object(files.os, "fstat", return_value=SimpleNamespace(st_mode=stat.S_IFREG, st_nlink=1, st_file_attributes=0x400)):
            self.error(400, self.read)

    def test_change_during_read(self):
        before = self.file.stat()
        changed = SimpleNamespace(st_size=before.st_size, st_mtime_ns=before.st_mtime_ns + 1, st_ctime_ns=before.st_ctime_ns)
        with patch.object(files.os, "fstat", side_effect=[before, changed]):
            self.error(409, self.read)

    def test_conflict_and_concurrent_saves(self):
        revision = self.read()["revision"]
        self.file.write_bytes(b"external")
        self.error(409, self.save, "new", revision)
        revision = self.read()["revision"]
        barrier = threading.Barrier(2)

        def worker(text):
            barrier.wait()
            try:
                self.save(text, revision)
                return 200
            except HTTPException as exc:
                return exc.status_code

        with ThreadPoolExecutor(2) as pool:
            self.assertEqual(sorted(pool.map(worker, ("first", "second"))), [200, 409])
        self.assertIn(self.file.read_bytes(), (b"first", b"second"))

    def test_replace_failure_and_final_recheck_cleanup(self):
        revision = self.read()["revision"]
        for operation in ("replace", "fsync"):
            with patch.object(files.os, operation, side_effect=OSError("absolute host secret")):
                self.error(400, self.save, "new", revision)
            self.assertEqual(self.file.read_bytes(), b"hello\n")
            self.assertEqual(list(self.root.glob(".mc-panel-edit-*")), [])
        real_fsync = os.fsync

        def external_edit(fd):
            real_fsync(fd)
            self.file.write_bytes(b"external edit")

        with patch.object(files.os, "fsync", side_effect=external_edit):
            self.error(409, self.save, "new", revision)
        self.assertEqual(self.file.read_bytes(), b"external edit")
        self.assertEqual(list(self.root.glob(".mc-panel-edit-*")), [])

    def test_router_authorization_protection_and_contract(self):
        app = FastAPI()
        app.include_router(routes.router, prefix="/api")
        db = Mock()
        db.get.return_value = self.server
        app.dependency_overrides[routes.get_db] = lambda: db
        base = "/api/servers/1/files"
        body = {"path": "config.txt", "text": "new\n", "revision": self.read()["revision"]}
        with TestClient(app) as client:
            for role, expected in ((None, 401), ("user", 403), ("helper", 403), ("admin", 200), ("owner", 200)):
                if role:
                    app.dependency_overrides[get_current_user] = lambda role=role: SimpleNamespace(role=role)
                for endpoint in (base, base + "/content?path=config.txt"):
                    self.assertEqual(client.get(endpoint).status_code, expected)
                if expected != 200:
                    self.assertEqual(client.put(base + "/content", json=body).status_code, expected)
            self.server.protected = True
            self.assertEqual(client.get(base).status_code, 200)
            self.assertEqual(client.get(base + "/content", params={"path": "config.txt"}).status_code, 200)
            self.assertEqual(client.put(base + "/content", json=body).status_code, 409)
            self.assertEqual(self.file.read_bytes(), b"hello\n")
            self.server.protected = False
            response = client.put(base + "/content", json=body)
            self.assertEqual(response.status_code, 200)
            self.assertEqual(response.json(), self.read())
            self.assertEqual(client.put(base + "/content", json=body).status_code, 409)
            self.assertEqual(client.put(base + "/content", json={**body, "revision": "invalid"}).status_code, 422)
            db.get.return_value = None
            self.assertEqual(client.get(base).status_code, 404)


if __name__ == "__main__":
    unittest.main()
