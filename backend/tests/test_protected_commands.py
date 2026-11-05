import unittest
from unittest.mock import patch
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import Session
from sqlalchemy.pool import StaticPool
from app.database import Base, get_db
from app.deps import get_current_user
from app.models import Server, User
from app.routers import servers


class ProtectedCommandsTests(unittest.TestCase):
    def setUp(self):
        engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
        Base.metadata.create_all(engine)
        self.addCleanup(engine.dispose)
        self.db = Session(engine)
        self.addCleanup(self.db.close)
        self.server = Server(name="protected", dir_name="protected", protected=True, port=25565)
        self.actor = User(username="admin", role="admin", hashed_password="x")
        self.db.add_all([self.server, self.actor])
        self.db.commit()
        app = FastAPI()
        app.include_router(servers.router)
        app.dependency_overrides[get_db] = lambda: self.db
        app.dependency_overrides[get_current_user] = lambda: self.actor
        self.client = TestClient(app)
        self.addCleanup(self.client.close)
        for name, value in [("get_status", "stopped"), ("needs_restart", False), ("mark_needs_restart", None)]:
            mock = patch.object(servers.manager, name, return_value=value)
            mock.start()
            self.addCleanup(mock.stop)

    def update(self, body):
        return self.client.patch(f"/servers/{self.server.id}", json=body)

    def test_edit_and_clear_preserve_protection(self):
        for commands in (["say ready"], []):
            response = self.update({"startup_commands": commands})
            self.assertEqual(response.status_code, 200, response.text)
            self.assertEqual(response.json()["startup_commands"], commands)
            self.assertTrue(response.json()["protected"])

    def test_mixed_configuration_is_rejected(self):
        response = self.update({"startup_commands": ["say ready"], "port": 25566})
        self.assertEqual(response.status_code, 409)
        self.db.refresh(self.server)
        self.assertEqual(self.server.port, 25565)
        self.assertTrue(self.server.protected)

    def test_user_cannot_edit_commands(self):
        self.actor.role = "user"
        self.db.commit()
        self.assertEqual(self.update({"startup_commands": ["say ready"]}).status_code, 403)
