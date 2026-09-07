import asyncio
import os
import tempfile
import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

with tempfile.TemporaryDirectory() as data, patch.dict(os.environ, {"MCPANEL_DATA_DIR": data}):
    from app.mcdr import MCDRManager


class ShutdownTests(unittest.IsolatedAsyncioTestCase):
    async def test_graceful_wait_and_install_cancellation(self):
        manager = MCDRManager()
        server = SimpleNamespace(id=1)
        proc = SimpleNamespace(returncode=None, wait=AsyncMock())
        manager._procs[1] = proc
        install = asyncio.create_task(asyncio.sleep(100))
        manager._install_tasks[1] = install
        with patch.object(manager, "stop", new_callable=AsyncMock) as stop, patch.object(manager, "force_stop", new_callable=AsyncMock) as force:
            await manager.shutdown([server, SimpleNamespace(id=2)])
            stop.assert_awaited_once_with(server)
            proc.wait.assert_awaited_once()
            force.assert_not_awaited()
            self.assertTrue(install.cancelled())

    async def test_timeout_escalates_and_reaps(self):
        manager = MCDRManager()
        server = SimpleNamespace(id=1)
        proc = SimpleNamespace(returncode=None, wait=AsyncMock(side_effect=[TimeoutError, 0]))
        manager._procs[1] = proc
        with patch.object(manager, "stop", new_callable=AsyncMock), patch.object(manager, "force_stop", new_callable=AsyncMock) as force:
            await manager.shutdown([server], timeout=0.1)
            force.assert_awaited_once_with(server)
            self.assertEqual(proc.wait.await_count, 2)

    async def test_instances_stop_in_parallel(self):
        manager = MCDRManager()
        ready = asyncio.Event()
        calls = []

        async def stop(server):
            calls.append(server.id)
            if len(calls) == 2:
                ready.set()
            await ready.wait()

        for i in (1, 2):
            manager._procs[i] = SimpleNamespace(returncode=None, wait=AsyncMock())
        with patch.object(manager, "stop", side_effect=stop):
            await asyncio.wait_for(manager.shutdown([SimpleNamespace(id=1), SimpleNamespace(id=2)]), 1)
        self.assertEqual(set(calls), {1, 2})
