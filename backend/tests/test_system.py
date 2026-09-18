"""Dashboard aggregates use database metadata, never scan instance/world files."""
from datetime import datetime, timedelta
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from sqlalchemy import create_engine
from sqlalchemy.orm import Session

from app.database import Base
from app.models import Archive, Server, ServerGroup
from app.routers import system


class DashboardTests(unittest.TestCase):
    def setUp(self):
        self.engine = create_engine("sqlite://")
        Base.metadata.create_all(self.engine)
        self.db = Session(self.engine)
        self.addCleanup(self.engine.dispose)
        self.addCleanup(self.db.close)
        gb = 1024 ** 3
        patches = [
            patch.object(system.psutil, "virtual_memory", return_value=SimpleNamespace(
                used=4 * gb, total=16 * gb, available=10 * gb, percent=37.5)),
            patch.object(system.psutil, "disk_usage", return_value=SimpleNamespace(
                used=30 * gb, total=100 * gb, free=70 * gb, percent=30)),
        ]
        for item in patches:
            mock = item.start()
            self.addCleanup(item.stop)
        self.disk_usage = mock

    def test_empty_dashboard_and_data_volume(self):
        result = system.overview(db=self.db)
        self.assertEqual(result.total_servers, 0)
        self.assertEqual(result.archive_count, 0)
        self.assertEqual(result.archive_bytes, 0)
        self.assertEqual(result.recent_archives, [])
        self.assertEqual(result.history, [])
        self.assertEqual(result.available_memory_gb, 10)
        self.assertEqual(result.free_disk_gb, 70)
        self.assertIsNotNone(result.sampled_at.tzinfo)
        self.disk_usage.assert_called_once_with(str(system.DATA_DIR))

    def test_aggregates_recent_order_and_runtime_status(self):
        group = ServerGroup(name="测试分组")
        self.db.add(group)
        self.db.flush()
        for i in range(1, 4):
            self.db.add(Server(id=i, name=f"server-{i}", dir_name=f"server-{i}",
                               mc_version="1.21", port=25564 + i, group_id=group.id))
        for i in range(7):
            self.db.add(Archive(name=f"archive-{i}", filename=f"{i}.zip", size=100 + i,
                                created_at=datetime(2026, 1, 1) + timedelta(days=i)))
        self.db.commit()
        with patch.object(system.manager, "get_status", side_effect=lambda s: {
            1: "running", 2: "installing", 3: "error"}[s.id]), patch.object(
                system.manager, "needs_restart", side_effect=lambda sid: sid == 1
            ), patch.object(system.manager, "install_progress", return_value=(50, 100)):
            result = system.overview(db=self.db)
        self.assertEqual(result.total_servers, 3)
        self.assertEqual(result.running_servers, 1)
        self.assertTrue(result.servers[0].needs_restart)
        self.assertEqual(result.servers[0].group_name, "测试分组")
        self.assertEqual(result.servers[1].install.percent, 50)
        self.assertEqual(result.archive_count, 7)
        self.assertEqual(result.archive_bytes, sum(100 + i for i in range(7)))
        self.assertEqual([a.name for a in result.recent_archives],
                         [f"archive-{i}" for i in range(6, 1, -1)])


if __name__ == "__main__":
    unittest.main()
