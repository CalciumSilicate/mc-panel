import asyncio
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch

import psutil
from fastapi import HTTPException
from sqlalchemy import create_engine
from sqlalchemy.orm import Session

with tempfile.TemporaryDirectory() as data, patch.dict(os.environ, {"MCPANEL_DATA_DIR": data}):
    from app.database import Base
    from app.mcdr import MCDRManager
    from app.models import Server
    from app.routers import servers as routes

from test_shutdown import ManagedProcess


class LifecycleTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name) / "instance"
        (self.root / "server").mkdir(parents=True)
        (self.root / "server/server.jar").touch()
        self.manager = MCDRManager()
        p = patch.object(self.manager, "instance_dir", return_value=self.root)
        p.start()
        self.addCleanup(p.stop)
        p = patch.object(routes, "manager", self.manager)
        p.start()
        self.addCleanup(p.stop)
        self.engine = create_engine("sqlite://")
        Base.metadata.create_all(self.engine)
        self.addCleanup(self.engine.dispose)
        self.db = Session(self.engine)
        self.addCleanup(self.db.close)
        self.server = Server(name="test", dir_name="test", server_type="vanilla", mc_version="1.21.1")
        self.db.add(self.server)
        self.db.commit()

    async def test_concurrent_start_spawns_exactly_one_process(self):
        entered, release = asyncio.Event(), asyncio.Event()
        proc = ManagedProcess()

        async def spawn(*args, **kwargs):
            entered.set()
            await release.wait()
            return proc

        with patch("asyncio.create_subprocess_exec", side_effect=spawn) as factory:
            first = asyncio.create_task(self.manager.start(self.server, sys.executable))
            await entered.wait()
            second = asyncio.create_task(self.manager.start(self.server, sys.executable))
            await asyncio.sleep(0)
            release.set()
            await asyncio.gather(first, second)
            self.assertEqual(factory.call_count, 1)
            self.assertEqual(self.manager.get_status(self.server), "starting")
            await self.manager.force_stop(self.server)
            self.assertTrue(proc.exited.is_set())

    async def test_reinstall_during_spawn_is_rejected_before_handle_registration(self):
        entered, release = asyncio.Event(), asyncio.Event()
        proc = ManagedProcess()

        async def spawn(*args, **kwargs):
            entered.set()
            await release.wait()
            return proc

        with patch("asyncio.create_subprocess_exec", side_effect=spawn):
            start = asyncio.create_task(self.manager.start(self.server, sys.executable))
            await entered.wait()
            try:
                with self.assertRaises(HTTPException) as caught:
                    await routes.reinstall_server(self.server.id, db=self.db)
                self.assertEqual(caught.exception.status_code, 400)
            finally:
                release.set()
                await start
                await self.manager.force_stop(self.server)

    async def test_delete_waits_for_exit_before_directory_and_database_removal(self):
        proc = ManagedProcess()
        self.manager._procs[self.server.id] = proc
        delete = asyncio.create_task(routes.delete_server(self.server.id, db=self.db))
        await asyncio.wait_for(proc.stopped.wait(), 2)
        self.assertFalse(delete.done())
        self.assertTrue(self.root.exists())
        self.assertIsNotNone(self.db.get(Server, self.server.id))
        proc.finish()
        await asyncio.wait_for(delete, 2)
        self.assertFalse(self.root.exists())
        self.assertIsNone(self.db.get(Server, self.server.id))

    async def test_delete_blocks_queued_start_but_not_new_instance_with_reused_id(self):
        proc = ManagedProcess()
        self.manager._procs[self.server.id] = proc
        delete = asyncio.create_task(routes.delete_server(self.server.id, db=self.db))
        await proc.stopped.wait()
        start = asyncio.create_task(self.manager.start(self.server, sys.executable))
        proc.finish()
        await delete
        with self.assertRaises(RuntimeError):
            await start
        replacement = Server(id=self.server.id, name="replacement", dir_name="new-uuid", server_type="vanilla")
        self.db.add(replacement)
        self.db.commit()
        with patch.object(self.manager, "_install_core", new_callable=AsyncMock):
            install = asyncio.create_task(self.manager.create_instance(replacement, "java"))
            self.manager.set_install_task(replacement.id, install)
            await install
        self.assertTrue(self.root.exists())

    async def test_directory_failure_preserves_database_and_can_retry(self):
        server_id = self.server.id
        with patch("app.mcdr.shutil.rmtree", side_effect=PermissionError("locked")):
            with self.assertRaises(PermissionError):
                await routes.delete_server(server_id, db=self.db)
        self.assertIsNotNone(self.db.get(Server, server_id))
        self.assertTrue(self.root.exists())
        await routes.delete_server(server_id, db=self.db)
        self.assertIsNone(self.db.get(Server, server_id))

    async def test_process_exit_failure_preserves_directory_database_and_handle(self):
        proc = ManagedProcess()
        proc.wait = AsyncMock(side_effect=TimeoutError)
        self.manager._procs[self.server.id] = proc
        with self.assertRaises(TimeoutError):
            await routes.delete_server(self.server.id, db=self.db)
        self.assertTrue(self.root.exists())
        self.assertIsNotNone(self.db.get(Server, self.server.id))
        self.assertIs(self.manager._procs[self.server.id], proc)

    async def test_starting_instance_cannot_be_reinstalled(self):
        proc = ManagedProcess()
        self.manager._procs[self.server.id] = proc
        self.assertEqual(self.manager.get_status(self.server), "starting")
        with self.assertRaises(HTTPException) as caught:
            await routes.reinstall_server(self.server.id, db=self.db)
        self.assertEqual(caught.exception.status_code, 400)
        with self.assertRaises(RuntimeError):
            await self.manager.redownload_jar(self.server)
        self.assertTrue(self.manager.is_running(self.server.id))
        self.assertFalse((self.root / ".installing").exists())
        proc.finish()

    async def test_registered_install_is_visible_before_task_runs_and_cancellable(self):
        task = asyncio.create_task(self.manager.redownload_jar(self.server))
        self.manager.set_install_task(self.server.id, task)
        self.assertEqual(self.manager.get_status(self.server), "installing")
        with self.assertRaises(HTTPException):
            await routes.reinstall_server(self.server.id, db=self.db)
        await self.manager.cancel_install(self.server)
        self.assertTrue(task.cancelled())
        self.assertEqual(self.manager.get_status(self.server), "error")
        with patch.object(self.manager, "_install_core", new_callable=AsyncMock):
            await self.manager.redownload_jar(self.server)
        self.assertEqual(self.manager.get_status(self.server), "stopped")

    async def test_cancel_waits_for_cleanup_before_marking_failed_or_allowing_retry(self):
        entered, cleaning, release = asyncio.Event(), asyncio.Event(), asyncio.Event()

        async def install(*args):
            entered.set()
            try:
                await asyncio.sleep(100)
            finally:
                cleaning.set()
                await release.wait()

        with patch.object(self.manager, "_install_core", side_effect=install):
            task = asyncio.create_task(self.manager.redownload_jar(self.server))
            self.manager.set_install_task(self.server.id, task)
            await entered.wait()
            cancel = asyncio.create_task(self.manager.cancel_install(self.server))
            await cleaning.wait()
            try:
                self.assertFalse(cancel.done())
                self.assertEqual(self.manager.get_status(self.server), "installing")
                self.assertFalse((self.root / ".install_failed").exists())
                with self.assertRaises(HTTPException):
                    await routes.reinstall_server(self.server.id, db=self.db)
            finally:
                release.set()
                await cancel
            self.assertTrue(task.done())
            self.assertEqual(self.manager.get_status(self.server), "error")

    async def test_cancellation_during_spawn_reaps_process_before_return(self):
        entered, release = asyncio.Event(), asyncio.Event()
        proc = ManagedProcess()

        async def spawn(*args, **kwargs):
            entered.set()
            await release.wait()
            return proc

        with patch("asyncio.create_subprocess_exec", side_effect=spawn):
            start = asyncio.create_task(self.manager.start(self.server, sys.executable))
            await entered.wait()
            start.cancel()
            await asyncio.sleep(0)
            self.assertFalse(start.done())
            release.set()
            with self.assertRaises(asyncio.CancelledError):
                await start
            self.assertTrue(proc.exited.is_set())
            self.assertFalse(self.manager.is_running(self.server.id))

    async def test_forge_cancel_reaps_real_installer_and_child_then_allows_retry(self):
        self.server.server_type = "forge"
        self.server.loader_version = "test"
        real_spawn = asyncio.create_subprocess_exec
        spawned = asyncio.Event()
        processes = []
        child_pid = None
        # Stand-in for Java: a Python installer with its own long-lived child.
        code = (
            "import subprocess,sys,time; "
            "p=subprocess.Popen([sys.executable,'-c','import time; time.sleep(120)']); "
            "print(p.pid,flush=True); time.sleep(120)"
        )

        async def spawn(*args, **kwargs):
            nonlocal child_pid
            proc = await real_spawn(sys.executable, "-u", "-c", code, **kwargs)
            processes.append(proc)
            child_pid = int(await proc.stdout.readline())
            spawned.set()
            return proc

        try:
            with patch("app.versions.get_forge_installer", new=AsyncMock(return_value={"name": "installer.jar", "url": "unused"})), \
                    patch("app.versions.download_file", new_callable=AsyncMock), \
                    patch("asyncio.create_subprocess_exec", side_effect=spawn):
                task = asyncio.create_task(self.manager.redownload_jar(self.server))
                self.manager.set_install_task(self.server.id, task)
                await asyncio.wait_for(spawned.wait(), 10)
                self.assertTrue(psutil.pid_exists(child_pid))
                await asyncio.wait_for(self.manager.cancel_install(self.server), 15)
                self.assertTrue(task.done())
                self.assertIsNotNone(processes[0].returncode)
                self.assertFalse(psutil.pid_exists(child_pid))
                self.assertFalse((self.root / ".installing").exists())
                self.assertEqual(self.manager.get_status(self.server), "error")
            with patch.object(self.manager, "_install_core", new_callable=AsyncMock):
                await self.manager.redownload_jar(self.server)
            self.assertFalse((self.root / ".install_failed").exists())
        finally:
            for pid in [child_pid, *(p.pid for p in processes)]:
                if pid is not None:
                    try:
                        psutil.Process(pid).kill()
                    except psutil.NoSuchProcess:
                        pass
            await asyncio.gather(*(p.wait() for p in processes))
