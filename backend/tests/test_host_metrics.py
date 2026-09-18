import tempfile
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from sqlalchemy import create_engine, func, select
from sqlalchemy.orm import Session, sessionmaker

from app import host_metrics
from app.models import HostResourceSample


class HostMetricsTests(unittest.TestCase):
    def test_collection_survives_new_engine_and_prunes_old_samples(self):
        with tempfile.TemporaryDirectory() as temp:
            url = f"sqlite:///{Path(temp) / 'metrics.db'}"
            engine = create_engine(url)
            HostResourceSample.__table__.create(engine)
            try:
                with Session(engine) as db:
                    db.add_all([
                        HostResourceSample(recorded_at=1, cpu_percent=99, memory_percent=99),
                        HostResourceSample(recorded_at=99995, cpu_percent=20, memory_percent=40),
                    ])
                    db.commit()
                with patch.object(host_metrics, "SessionLocal", sessionmaker(engine)), patch.object(
                    host_metrics.time, "time", return_value=100000
                ), patch.object(host_metrics.psutil, "cpu_percent", return_value=25), patch.object(
                    host_metrics.psutil, "virtual_memory", return_value=SimpleNamespace(percent=45)
                ):
                    host_metrics.collect()
            finally:
                engine.dispose()
            # Reopen the database as after a panel restart; no browser request or
            # process-local cache is needed to recover previous points.
            restarted = create_engine(url)
            try:
                with Session(restarted) as db, patch.object(host_metrics.time, "time", return_value=100001):
                    points, interval = host_metrics.history(db, 5)
                    self.assertEqual(interval, 5)
                    self.assertEqual([p["time"] for p in points], [99995, 100000])
                    self.assertEqual(points[-1]["cpu"], 25)
                    self.assertEqual(points[-1]["memory"], 45)
                    self.assertEqual(db.scalar(select(func.count()).select_from(HostResourceSample)), 2)
            finally:
                restarted.dispose()

    def test_day_range_is_bounded_and_averages_samples(self):
        engine = create_engine("sqlite://")
        HostResourceSample.__table__.create(engine)
        try:
            with Session(engine) as db:
                db.add_all(HostResourceSample(recorded_at=t, cpu_percent=20, memory_percent=40)
                           for t in range(0, 86401, 5))
                db.commit()
                with patch.object(host_metrics.time, "time", return_value=86400):
                    points, interval = host_metrics.history(db, 1440)
                self.assertEqual(interval, 240)
                self.assertLessEqual(len(points), 361)
                self.assertTrue(all(p["cpu"] == 20 and p["memory"] == 40 for p in points))
                self.assertEqual(points, sorted(points, key=lambda p: p["time"]))
        finally:
            engine.dispose()


if __name__ == "__main__":
    unittest.main()
