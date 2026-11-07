"""Host-owned boot autostart; panel reconnects never replay it."""
from sqlalchemy import select
from .database import SessionLocal
from .deps import get_settings_row
from .java import choose_java, detect_installs, get_java_paths
from .models import Server


async def autostart(manager, start=None) -> None:
    """托管服务启动时按优先级拉起 auto_start 实例，等待本组就绪再启动下组。"""
    import asyncio
    from collections import defaultdict

    db = SessionLocal()
    try:
        servers_to_start = list(db.scalars(select(Server).where(Server.auto_start.is_(True))).all())
        if not servers_to_start:
            return
        sys_settings = get_settings_row(db)
        installs = detect_installs(get_java_paths(sys_settings))
        python = sys_settings.python_executable
        java_cmd = sys_settings.java_command
    finally:
        db.close()

    groups: dict[int, list] = defaultdict(list)
    for s in servers_to_start:
        groups[getattr(s, "autostart_priority", 0) or 0].append(s)
    # 全部先标记为「队列中」
    for s in servers_to_start:
        manager._queued.add(s.id)

    async def _wait_ready(started: list, timeout: float = 300.0) -> None:
        deadline = asyncio.get_event_loop().time() + timeout
        while asyncio.get_event_loop().time() < deadline:
            pending = [s for s in started if manager.is_running(s.id) and s.id not in manager._ready]
            if not pending:
                return
            await asyncio.sleep(2)

    print("[autostart] groups: " + ", ".join(f"prio{p}={[s.name for s in groups[p]]}" for p in sorted(groups)), flush=True)
    try:
        for prio in sorted(groups):
            print(f"[autostart] starting prio {prio}: {[s.name for s in groups[prio]]}", flush=True)
            started = []
            for s in groups[prio]:
                manager._queued.discard(s.id)
                if manager.get_status(s) != "stopped":
                    continue
                if s.java_path_override:
                    java_path = s.java_path_override
                else:
                    java_path, err = choose_java(s.mc_version, installs, java_cmd)
                    if err:
                        continue
                try:
                    await (start or manager.start)(s, python, java_path)
                    started.append(s)
                except Exception as exc:  # 单实例失败不影响其它
                    print(f'[autostart] {s.name}: {exc}', flush=True)
            await _wait_ready(started)
            print(f"[autostart] prio {prio} all ready", flush=True)
    finally:
        for s in servers_to_start:
            manager._queued.discard(s.id)
