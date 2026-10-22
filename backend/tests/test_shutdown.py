import asyncio
import os
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock, patch

with tempfile.TemporaryDirectory() as data, patch.dict(os.environ, {"MCPANEL_DATA_DIR": data}):
    from app.mcdr import MCDRManager


class ManagedProcess:
    """A process which exits only when explicitly released (or killed)."""
    def __init__(self):
        self.pid = 2**30
        self.returncode = None
        self.exited = asyncio.Event()
        self.stopped = asyncio.Event()
        self.stdout = asyncio.StreamReader()
        self.stdin = SimpleNamespace(write=Mock(side_effect=lambda _: self.stopped.set()), drain=AsyncMock())
        self.kill = Mock(side_effect=self.finish)
        self.terminate = self.kill

    def finish(self):
        self.returncode = 0
        self.exited.set()
        self.stdout.feed_eof()

    async def wait(self):
        await self.exited.wait()
        return self.returncode

    async def communicate(self):
        await self.wait()
        return b"", None


class ShutdownTests(unittest.IsolatedAsyncioTestCase):
    async def test_graceful_wait_and_install_cancellation(self):
        manager = MCDRManager()
        proc = ManagedProcess()
        manager._procs[1] = proc
        install = asyncio.create_task(asyncio.sleep(100))
        manager.set_install_task(2, install)
        with tempfile.TemporaryDirectory() as root, patch.object(manager, "instance_dir", return_value=Path(root)):
            shutdown = asyncio.create_task(manager.shutdown([SimpleNamespace(id=1), SimpleNamespace(id=2)]))
            await proc.stopped.wait()
            self.assertFalse(shutdown.done())
            proc.finish()
            await asyncio.wait_for(shutdown, 2)
            proc.kill.assert_not_called()
            self.assertTrue(install.cancelled())
            self.assertFalse(manager.is_running(1))

    async def test_timeout_escalates_and_reaps(self):
        manager = MCDRManager()
        proc = ManagedProcess()
        manager._procs[1] = proc
        await asyncio.wait_for(manager.shutdown([SimpleNamespace(id=1)], timeout=0.01), 2)
        proc.kill.assert_called_once()
        self.assertTrue(proc.exited.is_set())
        self.assertFalse(manager.is_running(1))

    async def test_instances_stop_in_parallel(self):
        manager = MCDRManager()
        processes = [ManagedProcess(), ManagedProcess()]
        for i, proc in enumerate(processes, 1):
            manager._procs[i] = proc
        shutdown = asyncio.create_task(manager.shutdown([SimpleNamespace(id=1), SimpleNamespace(id=2)]))
        await asyncio.wait_for(asyncio.gather(*(p.stopped.wait() for p in processes)), 2)
        self.assertFalse(shutdown.done())
        for proc in processes:
            proc.finish()
        await asyncio.wait_for(shutdown, 2)
