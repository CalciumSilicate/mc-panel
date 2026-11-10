"""Authenticated loopback IPC to the independent MCDR host (protocol version 1)."""
from __future__ import annotations

import asyncio
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import threading
import time

from .config import DATA_DIR, PROJECT_ROOT

PROTOCOL = 1
MAX_MESSAGE = 8 * 1024 * 1024


class RuntimeUnavailable(RuntimeError):
    pass


class RuntimeIncompatible(RuntimeUnavailable):
    pass


class HostLock:
    """OS-owned lock: automatically released on crash, never a stale PID lock."""
    def __init__(self, root: Path):
        root.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.file = (root / 'host.lock').open('a+b')
        try:
            if os.fstat(self.file.fileno()).st_size == 0:
                self.file.write(b'0')
                self.file.flush()
            self.file.seek(0)
            if os.name == 'nt':
                import msvcrt
                msvcrt.locking(self.file.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl
                fcntl.flock(self.file.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            self.file.close()
            raise RuntimeUnavailable('托管服务已运行或正在启动') from None

    def close(self):
        self.file.close()


class RuntimeClient:
    def __init__(self, data_dir: Path = DATA_DIR):
        self.root = data_dir.resolve() / 'runtime'
        self.data_dir = data_dir.resolve()

    def request(self, action: str, *, timeout: float = 3, **payload):
        try:
            endpoint = json.loads((self.root / 'endpoint.json').read_text(encoding='utf-8'))
            if endpoint.get('protocol') != PROTOCOL:
                raise RuntimeIncompatible('托管协议版本不兼容，请安排实例停服后升级托管服务')
            message = json.dumps(dict(protocol=PROTOCOL, token=endpoint['token'], action=action, **payload)).encode() + b'\n'
            if len(message) > MAX_MESSAGE:
                raise RuntimeError('托管请求过大')
            with socket.create_connection(('127.0.0.1', int(endpoint['port'])), timeout=timeout) as sock:
                sock.sendall(message)
                with sock.makefile('rb') as stream:
                    raw = stream.readline(MAX_MESSAGE + 1)
            if not raw.endswith(b'\n') or len(raw) > MAX_MESSAGE:
                raise RuntimeUnavailable('托管服务返回无效响应')
            result = json.loads(raw)
            if result.get('protocol') != PROTOCOL:
                raise RuntimeIncompatible('托管协议版本不兼容')
            if not result.get('ok'):
                raise RuntimeError(result.get('error', '托管操作失败'))
            return result['result']
        except (OSError, ValueError, KeyError) as exc:
            raise RuntimeUnavailable('MCDR 托管服务连接失败；实例状态未知，已阻止操作') from exc

    async def call(self, action: str, **payload):
        return await asyncio.to_thread(self.request, action, **payload)

    async def ensure_started(self, *, autostart: bool = True):
        try:
            return await self.call('snapshot')
        except RuntimeIncompatible:
            raise
        except RuntimeUnavailable:
            pass
        self.root.mkdir(parents=True, exist_ok=True, mode=0o700)
        # Each candidate acquires the OS lock before touching endpoint/state files.
        env = {**os.environ, 'MCPANEL_DATA_DIR': str(self.data_dir),
               'PYTHONPATH': str(PROJECT_ROOT / 'backend'), 'PYTHONUTF8': '1',
               'MCPANEL_RUNTIME_AUTOSTART': '1' if autostart else '0'}
        options = {'start_new_session': True} if os.name != 'nt' else {
            'creationflags': subprocess.DETACHED_PROCESS | subprocess.CREATE_NEW_PROCESS_GROUP,
        }
        with (self.root / 'host.log').open('ab') as log:
            child = subprocess.Popen([sys.executable, '-m', 'app.runtime_host'],
                                     cwd=PROJECT_ROOT, env=env, stdin=subprocess.DEVNULL,
                                     stdout=log, stderr=log, close_fds=True, **options)
        # Reap on POSIX and retain the handle without tying the host lifetime to us.
        threading.Thread(target=child.wait, daemon=True, name='runtime-launcher-reaper').start()
        deadline = time.monotonic() + 20
        while time.monotonic() < deadline:
            try:
                return await self.call('snapshot')
            except RuntimeIncompatible:
                raise
            except RuntimeUnavailable:
                if child.poll() not in (None, 0):
                    raise RuntimeUnavailable(f'托管服务启动失败，查看 {self.root / "host.log"}') from None
                await asyncio.sleep(.2)
        raise RuntimeUnavailable(f'托管服务启动超时，查看 {self.root / "host.log"}')


class RemoteProcess:
    """Read-only process identity for existing wait/snapshot callers; no OS kill."""
    def __init__(self, client: RuntimeClient, state: dict):
        self.client = client
        self.state = state
        self.pid = state['pid']
        self.server_id = state['id']
        self.generation = state['generation']

    @property
    def returncode(self):
        return self.state['returncode']

    async def wait(self):
        while True:
            state = await self.client.call('process', server_id=self.server_id, generation=self.generation)
            self.state = state
            if state['returncode'] is not None:
                return state['returncode']
            await asyncio.sleep(.1)
