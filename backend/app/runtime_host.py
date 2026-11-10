"""Long-lived MCDR host. Independent of HTTP, Vite and panel reloads."""
from __future__ import annotations

import asyncio
from collections import deque
import hmac
import json
import os
from pathlib import Path
import secrets
import signal
import uuid

import psutil

from .config import DATA_DIR
from .mcdr import MCDRManager
from .models import Server
from .runtime_client import HostLock, MAX_MESSAGE, PROTOCOL, RuntimeUnavailable


def atomic_json(path: Path, value):
    tmp = path.with_suffix('.tmp')
    tmp.write_text(json.dumps(value), encoding='utf-8')
    tmp.chmod(0o600)
    tmp.replace(path)


class RuntimeHost:
    def __init__(self, root: Path):
        self.root = root
        self.manager = MCDRManager()
        self.manager.line_hook = self.on_line
        self.token = secrets.token_hex(32)
        self.epoch = uuid.uuid4().hex
        self.sequence = 0
        self.events = deque(maxlen=4000)
        self.servers: dict[int, Server] = {}
        self.generations: dict[int, str] = {}
        self.exited: dict[str, dict] = {}
        self.stop_event = asyncio.Event()
        self.stopping = False
        self.launching = set()
        self.starts = set()

    def on_line(self, sid, line):
        self.sequence += 1
        self.events.append([self.sequence, sid, line[:16384]])

    def check_orphans(self):
        path = self.root / 'processes.json'
        if not path.exists():
            return
        old = json.loads(path.read_text(encoding='utf-8'))
        for record in old:
            if record.get('launching'):
                raise RuntimeError('上次托管在启动实例时异常退出，请确认实例已停止后清理 runtime/processes.json')
            try:
                proc = psutil.Process(record['pid'])
                if abs(proc.create_time() - record['created']) < .01 and proc.is_running():
                    raise RuntimeError(f'检测到尚存的托管进程 PID {proc.pid}，拒绝重复启动。请先停止遗留实例。')
            except psutil.NoSuchProcess:
                pass

    def persist(self, launching=None):
        records = []
        for proc in self.manager._procs.values():
            # Keep child identities even if MCDR exited before Java.
            for process in self.manager._remember_tree(proc):
                try:
                    if process.is_running():
                        records.append(dict(pid=process.pid, created=process.create_time()))
                except psutil.NoSuchProcess:
                    pass
        for directory in self.launching | ({launching} if launching else set()):
            records.append(dict(launching=directory))
        atomic_json(self.root / 'processes.json', records)

    def state(self, sid):
        proc = self.manager._procs.get(sid)
        if proc is None:
            return None
        return dict(id=sid, dir_name=self.servers[sid].dir_name, pid=proc.pid,
                    generation=self.generations[sid], returncode=proc.returncode,
                    ready=sid in self.manager._ready, needs_restart=sid in self.manager._needs_restart)

    def snapshot(self):
        return dict(epoch=self.epoch, sequence=self.sequence,
                    processes=[self.state(sid) for sid in self.manager._procs],
                    queued=list(self.manager._queued), stopping=self.stopping)

    def get_server(self, request):
        sid = int(request['server_id'])
        if sid not in self.servers:
            raise RuntimeError('托管实例不存在')
        if request.get('generation') and request['generation'] != self.generations[sid]:
            raise RuntimeError('实例已重新启动，拒绝操作旧进程')
        return self.servers[sid]

    async def dispatch(self, request):
        action = request['action']
        if action == 'snapshot':
            return self.snapshot()
        if action == 'bootstrap':
            return dict(**self.snapshot(), history={str(sid): list(lines) for sid, lines in self.manager._buffers.items()})
        if action == 'events':
            after = int(request.get('after', 0))
            return dict(**self.snapshot(), events=[e for e in self.events if e[0] > after][:500],
                        oldest=self.events[0][0] if self.events else self.sequence + 1)
        if action == 'history':
            return {str(sid): list(lines) for sid, lines in self.manager._buffers.items()}
        if action == 'process':
            generation = request.get('generation')
            if generation in self.exited:
                return self.exited[generation]
            server = self.get_server(request)
            return self.state(server.id)
        if action == 'shutdown':
            if not request.get('stop_instances') and (self.starts or any(p.returncode is None for p in self.manager._procs.values())):
                raise RuntimeError('仍有运行实例；停止托管服务需显式使用 --stop-instances')
            self.stopping = True
            self.stop_event.set()
            return True
        if self.stopping:
            raise RuntimeError('托管服务正在停止')
        if action == 'start':
            values = request['server']
            columns = {column.name for column in Server.__table__.columns}
            server = Server(**{key: value for key, value in values.items() if key in columns})
            path = self.manager.instance_dir(server).resolve()
            if path.parent != (DATA_DIR / 'servers').resolve() or not path.is_dir():
                raise RuntimeError('实例目录无效')
            # Lock wraps identity bookkeeping as well as MCDRManager's own lock.
            async with self.manager._control_locks.setdefault(server.id, asyncio.Lock()):
                if self.stopping:
                    raise RuntimeError('托管服务正在停止')
                old = self.state(server.id)
                if old and old['returncode'] is None:
                    if old['dir_name'] != server.dir_name:
                        raise RuntimeError('实例编号与正在运行的目录不一致')
                    return old
                if old:
                    self.exited[old['generation']] = old
                self.launching.add(server.dir_name)
                self.starts.add(asyncio.current_task())
                self.servers[server.id] = server
                self.generations[server.id] = uuid.uuid4().hex
                self.persist()
                try:
                    await self.manager.start(server, request['python'], request.get('java'))
                finally:
                    self.launching.discard(server.dir_name)
                    self.starts.discard(asyncio.current_task())
                    self.persist()
                return self.state(server.id)
        server = self.get_server(request)
        if action == 'command':
            await self.manager.send_raw(server.id, str(request['command']))
        elif action == 'stop':
            async with self.manager.lifecycle_lock(server.id):
                server = self.get_server(request)
                await self.manager._stop(server)
        elif action in ('kill', 'drain', 'reap'):
            async with self.manager.lifecycle_lock(server.id):
                server = self.get_server(request)
                old = self.state(server.id)
                proc = self.manager._procs[server.id]
                if action == 'reap' and old['returncode'] is None:
                    raise RuntimeError('实例正在运行，无法清理')
                if action == 'drain':
                    await self.manager._drain(server, min(float(request.get('grace', 60)), 120))
                else:
                    await self.manager._force_stop(server)
                old['returncode'] = proc.returncode
                self.exited[old['generation']] = old
                self.persist()
        elif action == 'mark_restart':
            self.manager.mark_needs_restart(server.id)
        else:
            raise RuntimeError('未知托管操作')
        return True

    async def connection(self, reader, writer):
        try:
            raw = await asyncio.wait_for(reader.readline(), 5)
            request = json.loads(raw)
            if request.get('protocol') != PROTOCOL or not hmac.compare_digest(str(request.get('token', '')), self.token):
                raise RuntimeError('托管服务认证失败或协议不兼容')
            result = await self.dispatch(request)
            response = dict(protocol=PROTOCOL, ok=True, result=result)
        except Exception as exc:
            response = dict(protocol=PROTOCOL, ok=False, error=str(exc))
        try:
            writer.write(json.dumps(response, ensure_ascii=False).encode() + b'\n')
            await writer.drain()
        except ConnectionError:
            pass  # Client reconnects must not cancel an already accepted operation.
        finally:
            writer.close()
            try:
                await writer.wait_closed()
            except ConnectionError:
                pass

    async def monitor(self):
        while True:
            self.persist()
            await asyncio.sleep(1)

    async def autostart(self):
        if os.environ.get('MCPANEL_RUNTIME_AUTOSTART', '1') == '0':
            return
        from .autostart import autostart
        from .database import init_db
        init_db()
        async def start(server, python, java):
            values = {c.name: getattr(server, c.name) for c in Server.__table__.columns}
            values = {k: v for k, v in values.items() if v is None or isinstance(v, (str, int, float, bool))}
            await self.dispatch(dict(action='start', server=values, python=python, java=java))
        await autostart(self.manager, start)

    async def run(self):
        self.check_orphans()
        listener = await asyncio.start_server(self.connection, '127.0.0.1', 0, limit=MAX_MESSAGE)
        atomic_json(self.root / 'endpoint.json', dict(protocol=PROTOCOL, port=listener.sockets[0].getsockname()[1],
                                                    token=self.token, pid=os.getpid(), epoch=self.epoch))
        loop = asyncio.get_running_loop()
        for sig in (signal.SIGINT, signal.SIGTERM):
            signal.signal(sig, lambda *_: loop.call_soon_threadsafe(self.stop_event.set))
        monitor = asyncio.create_task(self.monitor())
        boot = asyncio.create_task(self.autostart())
        print(f'[runtime] started PID={os.getpid()}', flush=True)
        try:
            async with listener:
                await self.stop_event.wait()
                self.stopping = True
                boot.cancel()
                await asyncio.gather(boot, return_exceptions=True)
                if self.starts:
                    await asyncio.gather(*list(self.starts), return_exceptions=True)
                await self.manager.shutdown(list(self.servers.values()))
                self.persist()
        finally:
            monitor.cancel()
            boot.cancel()
            await asyncio.gather(monitor, boot, return_exceptions=True)
            (self.root / 'endpoint.json').unlink(missing_ok=True)
            print('[runtime] stopped', flush=True)


def main():
    root = DATA_DIR.resolve() / 'runtime'
    try:
        lock = HostLock(root)
    except RuntimeUnavailable:
        return
    try:
        asyncio.run(RuntimeHost(root).run())
    finally:
        lock.close()


if __name__ == '__main__':
    main()
