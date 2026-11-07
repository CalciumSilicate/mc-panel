"""Real subprocess integration: no Minecraft download or Java needed."""
import asyncio
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

import psutil

from app.runtime_client import HostLock, RuntimeClient, RuntimeUnavailable, RuntimeIncompatible, PROTOCOL
from app.mcdr import MCDRManager
from app.models import Server

ROOT = Path(__file__).resolve().parents[2]


class RuntimeHostTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.data = Path(self.temp.name)
        self.inst = self.data / 'servers' / 'fixture'
        (self.inst / 'server').mkdir(parents=True)
        (self.inst / 'server' / 'server.jar').touch()
        (self.inst / 'config.yml').write_text('start_command: [java, -jar, server.jar]\n', encoding='utf-8')
        # Simulate MCDR owning a Java child, stdout and a command input pipe.
        (self.inst / 'mcdreforged.py').write_text('''import subprocess, sys, time
child = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(300)'])
print('CHILD ' + str(child.pid), flush=True)
time.sleep(.3)
print('Done (0.1s)! For help, type help', flush=True)
try:
    for line in sys.stdin:
        command = line.strip()
        print('ECHO ' + command, flush=True)
        if command == 'stop': break
finally:
    child.terminate()
    child.wait()
''', encoding='utf-8')
        self.client = RuntimeClient(self.data)
        await self.client.ensure_started()
        endpoint = json.loads((self.client.root / 'endpoint.json').read_text())
        self.host_process = psutil.Process(endpoint['pid'])
        self.server = Server(id=1, name='fixture', dir_name='fixture', server_type='vanilla',
                             mc_version='1.21.1', min_memory='1G', max_memory='2G', extra_jvm_args='',
                             startup_commands='["startup-once"]')

    async def asyncTearDown(self):
        try:
            await self.client.call('shutdown', stop_instances=True)
        except (RuntimeError, OSError):
            pass
        try:
            await asyncio.to_thread(self.host_process.wait, 15)
        except psutil.NoSuchProcess:
            pass
        # Windows venv's launcher closes its inherited log handle just after the
        # actual Python host exits.
        for attempt in range(30):
            try:
                self.temp.cleanup()
                break
            except PermissionError:
                if attempt == 29: raise
                await asyncio.sleep(.1)

    async def wait_for(self, predicate):
        for _ in range(200):
            value = await predicate()
            if value: return value
            await asyncio.sleep(.03)
        self.fail('condition timed out')

    async def panel(self):
        manager = MCDRManager()
        await manager.connect_runtime(self.client)
        return manager

    async def test_panel_disconnect_reconnect_keeps_pid_commands_and_history(self):
        first = await self.panel()
        await first.start(self.server, sys.executable)
        pid = first._procs[1].pid
        async def ready():
            return (await self.client.call('snapshot'))['processes'][0]['ready']
        await self.wait_for(ready)
        await first.shutdown([self.server])
        self.assertTrue(psutil.pid_exists(pid))
        await asyncio.sleep(1.2)  # startup commands belong to the host, even without panel
        second = await self.panel()
        try:
            with patch.object(second, 'instance_dir', return_value=self.inst):
                self.assertEqual(second.get_status(self.server), 'running')
            self.assertEqual(second._procs[1].pid, pid)
            await second.start(self.server, sys.executable)
            self.assertEqual(second._procs[1].pid, pid)
            self.assertEqual(sum('ECHO startup-once' in line for line in second.recent_lines(1)), 1)
            await second.send_raw(1, 'still-connected')
            async def echoed():
                return any('ECHO still-connected' in line for line in (await self.client.call('history'))['1'])
            await self.wait_for(echoed)
            handle = second._procs[1]
            await second.stop(self.server)
            await asyncio.wait_for(handle.wait(), 5)
            self.assertFalse(second.is_running(1))
        finally:
            await second.shutdown([self.server])

    async def test_force_stop_reaps_children_and_stale_handle_cannot_stop_replacement(self):
        manager = await self.panel()
        try:
            await manager.start(self.server, sys.executable)
            old = manager._procs[1]
            async def child():
                lines = (await self.client.call('history')).get('1', [])
                return next((int(line.split()[1]) for line in lines if line.startswith('CHILD ')), None)
            child_pid = await self.wait_for(child)
            await manager.force_stop(self.server)
            await old.wait()
            self.assertFalse(psutil.pid_exists(child_pid))
            await manager.start(self.server, sys.executable)
            with self.assertRaisesRegex(RuntimeError, '旧进程'):
                await self.client.call('stop', server_id=1, generation=old.generation)
            self.assertTrue(manager.is_running(1))
        finally:
            await manager.shutdown([self.server])

    async def test_singleton_authentication_and_explicit_shutdown(self):
        with self.assertRaises(RuntimeUnavailable):
            HostLock(self.client.root)
        initial = await self.client.call('snapshot')
        again = await RuntimeClient(self.data).ensure_started()
        self.assertEqual(initial['epoch'], again['epoch'])
        endpoint = json.loads((self.client.root / 'endpoint.json').read_text())
        def bad_auth():
            with socket.create_connection(('127.0.0.1', endpoint['port']), timeout=3) as sock:
                sock.sendall(json.dumps(dict(protocol=PROTOCOL, action='shutdown', token='wrong')).encode()+b'\n')
                return json.loads(sock.makefile('rb').readline())
        self.assertFalse((await asyncio.to_thread(bad_auth))['ok'])
        manager = await self.panel()
        try:
            await asyncio.gather(manager.start(self.server, sys.executable), manager.start(self.server, sys.executable))
            self.assertEqual(len((await self.client.call('snapshot'))['processes']), 1)
            with self.assertRaisesRegex(RuntimeError, 'stop-instances'):
                await self.client.call('shutdown')
            with patch.object(self.client, 'request', side_effect=RuntimeUnavailable('offline')):
                with self.assertRaises(RuntimeUnavailable):
                    manager.get_status(self.server)
        finally:
            await manager.shutdown([self.server])

    async def test_killed_website_process_does_not_stop_hosted_process(self):
        code = '''import asyncio, sys, os
from pathlib import Path
from app.mcdr import MCDRManager
from app.models import Server
from app.runtime_client import RuntimeClient
async def main():
    manager = MCDRManager()
    await manager.connect_runtime(RuntimeClient(Path(sys.argv[1])))
    server = Server(id=1, name='fixture', dir_name='fixture', server_type='vanilla', mc_version='1.21.1', min_memory='1G', max_memory='2G', extra_jvm_args='', startup_commands='[]')
    await manager.start(server, sys.executable)
    print(os.getpid(), manager._procs[1].pid, flush=True)
    await asyncio.sleep(300)
asyncio.run(main())
'''
        env = {**os.environ, 'PYTHONPATH': str(ROOT / 'backend')}
        panel = subprocess.Popen([sys.executable, '-c', code, str(self.data)], env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        try:
            line = await asyncio.wait_for(asyncio.to_thread(panel.stdout.readline), 10)
            panel_pid, pid = map(int, line.split())
            psutil.Process(panel_pid).kill()
            await asyncio.to_thread(panel.wait, 5)
            manager = await self.panel()
            try:
                self.assertEqual(manager._procs[1].pid, pid)
                await manager.send_raw(1, 'after-crash')
                async def echo():
                    return any('ECHO after-crash' in line for line in (await self.client.call('history'))['1'])
                await self.wait_for(echo)
            finally:
                await manager.shutdown([self.server])
        finally:
            if panel.poll() is None:
                panel.kill()
                await asyncio.to_thread(panel.wait, 5)
            panel.stdout.close()
            panel.stderr.close()

    async def test_protocol_mismatch_does_not_spawn_a_replacement(self):
        with patch.object(self.client, 'request', side_effect=RuntimeIncompatible('version mismatch')):
            with patch('app.runtime_client.subprocess.Popen') as spawn:
                with self.assertRaises(RuntimeIncompatible):
                    await self.client.ensure_started()
                spawn.assert_not_called()

    async def test_orphan_records_prevent_duplicate_hosting(self):
        from app.runtime_host import RuntimeHost
        current = psutil.Process()
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            record = root / 'processes.json'
            record.write_text(json.dumps([{'pid':current.pid, 'created':current.create_time()}]))
            host = RuntimeHost(root)
            with self.assertRaisesRegex(RuntimeError, 'PID'):
                host.check_orphans()
            # A reused numeric PID alone must not identify the old process.
            record.write_text(json.dumps([{'pid':current.pid, 'created':current.create_time()-100}]))
            host.check_orphans()
