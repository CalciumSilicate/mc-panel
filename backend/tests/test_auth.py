"""Public auth/user API regressions; all databases and signing keys are temporary."""
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import bcrypt
from fastapi import FastAPI
from fastapi.testclient import TestClient
import jwt
from sqlalchemy import create_engine, text
from sqlalchemy.orm import Session
from sqlalchemy.pool import StaticPool

_import_data = tempfile.TemporaryDirectory()
with patch.dict(os.environ, {"MCPANEL_DATA_DIR": _import_data.name}):
    from app import config, database, security
    from app.models import SystemSettings
    from app.routers import auth, users


def tearDownModule():
    # This module never opens the application engine; release it if another test did.
    if config.DATA_DIR == Path(_import_data.name):
        database.engine.dispose()
    _import_data.cleanup()


class AuthTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        root = Path(temp.name)
        for name, value in (("DATA_DIR", root), ("SERVERS_ROOT", root / "servers"),
                            ("SECRET_KEY_PATH", root / "secret.key")):
            p = patch.object(config, name, value)
            p.start()
            self.addCleanup(p.stop)
        self.engine = create_engine(
            "sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool
        )
        self.addCleanup(self.engine.dispose)
        database.Base.metadata.create_all(self.engine)

        def get_db():
            with Session(self.engine) as db:
                yield db

        app = FastAPI()
        app.include_router(auth.router)
        app.include_router(users.router)
        app.dependency_overrides[database.get_db] = get_db
        self.client = TestClient(app)
        self.addCleanup(self.client.close)
        self.owner = self.post_token("/auth/setup", "owner", "original")

    def post_token(self, path, username, password):
        r = self.client.post(path, json={"username": username, "password": password})
        self.assertEqual(r.status_code, 200, r.text)
        return r.json()["token"]

    def headers(self, token):
        return {"Authorization": f"Bearer {token}"}

    def assert_token(self, token, status=200):
        for endpoint in ("/auth/me", "/auth/status"):
            r = self.client.get(endpoint, headers=self.headers(token))
            self.assertEqual(r.status_code, status, r.text)

    def create_user(self, name="member", password="original"):
        r = self.client.post("/users", headers=self.headers(self.owner), json={
            "username": name, "password": password,
        })
        self.assertEqual(r.status_code, 200, r.text)
        self.assertNotIn("session_id", r.json())
        return r.json()["id"]

    def test_change_password_revokes_all_sessions(self):
        other = self.post_token("/auth/login", "owner", "original")
        r = self.client.post("/auth/change-password", headers=self.headers(self.owner),
                             json={"old_password": "wrong", "new_password": "changed"})
        self.assertEqual(r.status_code, 400)
        self.assert_token(other)
        r = self.client.post("/auth/change-password", headers=self.headers(self.owner),
                             json={"old_password": "original", "new_password": "changed"})
        self.assertEqual(r.status_code, 200, r.text)
        self.assert_token(self.owner, 401)
        self.assert_token(other, 401)
        r = self.client.post("/auth/login", json={"username": "owner", "password": "original"})
        self.assertEqual(r.status_code, 401)
        self.assert_token(self.post_token("/auth/login", "owner", "changed"))

    def test_logout_revokes_all_sessions_not_other_accounts(self):
        self.create_user()
        member = self.post_token("/auth/login", "member", "original")
        other = self.post_token("/auth/login", "owner", "original")
        r = self.client.post("/auth/logout", headers=self.headers(self.owner))
        self.assertEqual(r.status_code, 200, r.text)
        self.assert_token(self.owner, 401)
        self.assert_token(other, 401)
        self.assert_token(member)
        self.assert_token(self.post_token("/auth/login", "owner", "original"))

    def test_admin_password_reset_revokes_target_sessions(self):
        uid = self.create_user()
        token = self.post_token("/auth/login", "member", "original")
        r = self.client.patch(f"/users/{uid}", headers=self.headers(self.owner),
                              json={"new_password": "reset"})
        self.assertEqual(r.status_code, 200, r.text)
        self.assert_token(token, 401)
        self.assert_token(self.owner)
        self.assert_token(self.post_token("/auth/login", "member", "reset"))

    def test_deleted_id_reuse_cannot_reuse_token(self):
        uid = self.create_user()
        token = self.post_token("/auth/login", "member", "original")
        self.assertEqual(self.client.delete(f"/users/{uid}",
                         headers=self.headers(self.owner)).status_code, 200)
        self.assert_token(token, 401)
        self.assertEqual(self.create_user("replacement"), uid)  # Exercise real SQLite ID reuse.
        self.assert_token(token, 401)
        self.assert_token(self.post_token("/auth/login", "replacement", "original"))

    def test_legacy_and_invalid_tokens_fail_closed(self):
        payload = security.decode_token(self.owner)
        for change in ({"sid": None}, {"sid": ""}, {"sid": "wrong"},
                       {"sid": "密" * 64}, {"sid": "f" * 64},
                       {"sub": "invalid"}, {"exp": 1}):
            invalid = jwt.encode(payload | change, config.get_secret_key(), algorithm="HS256")
            self.assert_token(invalid, 401)
        del payload["sid"]
        legacy = jwt.encode(payload, config.get_secret_key(), algorithm="HS256")
        self.assert_token(legacy, 401)
        self.assert_token(self.owner + "invalid", 401)
        self.assert_token(self.owner)

    def test_utf8_password_boundaries_on_all_write_paths(self):
        uid = self.create_user()
        for password in ("", "a" * 73, "密" * 25, "😀" * 19):
            with self.subTest(bytes=len(password.encode("utf-8"))):
                for endpoint in ("/auth/setup", "/auth/login", "/auth/register", "/users"):
                    r = self.client.post(endpoint, headers=self.headers(self.owner),
                                         json={"username": "boundary", "password": password})
                    self.assertEqual(r.status_code, 422, r.text)
                r = self.client.patch(f"/users/{uid}", headers=self.headers(self.owner),
                                      json={"new_password": password})
                self.assertEqual(r.status_code, 422, r.text)
                for field in ("old_password", "new_password"):
                    body = {"old_password": "original", "new_password": "changed", field: password}
                    r = self.client.post("/auth/change-password", headers=self.headers(self.owner), json=body)
                    self.assertEqual(r.status_code, 422, r.text)
        for i, password in enumerate(("a" * 72, "密" * 24, "😀" * 18, "密" * 23 + "ab")):
            name = f"boundary{i}"
            self.create_user(name, password)
            self.assert_token(self.post_token("/auth/login", name, password))
        self.assert_token(self.owner)  # Rejected changes must not revoke valid sessions.

    def test_migration_preserves_legacy_bcrypt_and_is_idempotent(self):
        # Simulate the previous schema and a bcrypt hash created before this change.
        self.create_user()
        with self.engine.begin() as conn:
            conn.execute(text("ALTER TABLE users DROP COLUMN session_id"))
            conn.execute(text("UPDATE users SET hashed_password=:hash WHERE username='member'"), {
                "hash": bcrypt.hashpw("密".encode(), bcrypt.gensalt()).decode(),
            })
        with patch.object(database, "engine", self.engine):
            database.init_db()
            with self.engine.connect() as conn:
                first = conn.execute(text("SELECT session_id FROM users ORDER BY id")).scalars().all()
            self.assertEqual(len(set(first)), 2)
            self.assertTrue(all(len(sid) == 64 for sid in first))
            token = self.post_token("/auth/login", "member", "密")
            self.assert_token(token)
            database.init_db()
            with self.engine.connect() as conn:
                second = conn.execute(text("SELECT session_id FROM users ORDER BY id")).scalars().all()
            self.assertEqual(first, second)
            self.assert_token(token)

    def test_register_issues_current_session(self):
        with Session(self.engine) as db:
            settings = db.get(SystemSettings, 1)
            settings.allow_register = True
            db.commit()
        self.assert_token(self.post_token("/auth/register", "registered", "密" * 24))


if __name__ == "__main__":
    unittest.main()
