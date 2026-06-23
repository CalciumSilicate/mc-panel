"""PCRC 录像机:把 PCRC(模拟客户端)作为受管子进程,连进服务器录制 .mcpr。

每个实例一个目录:config.json + recordings/。以 ``python -m pcrc`` 在目录内启动,
stdout 收进环形缓冲(前端轮询查看;microsoft 设备码会出现在这里),stdin 收 start/stop。
"""
from __future__ import annotations

import json
import subprocess
import sys
import threading
from collections import deque
from pathlib import Path

from .config import PCRC_ROOT
from .models import PcrcInstance


def instance_dir(inst: PcrcInstance) -> Path:
    return PCRC_ROOT / inst.dir_name


def recordings_dir(inst: PcrcInstance) -> Path:
    return instance_dir(inst) / "recordings"


def write_config(inst: PcrcInstance) -> None:
    d = instance_dir(inst)
    d.mkdir(parents=True, exist_ok=True)
    recordings_dir(inst).mkdir(parents=True, exist_ok=True)
    cfg_path = d / "config.json"
    cfg = {}
    if cfg_path.exists():
        try:
            cfg = json.loads(cfg_path.read_text(encoding="utf-8"))
        except Exception:  # noqa: BLE001
            cfg = {}
    cfg.update({
        "address": inst.address,
        "port": inst.port,
        "authenticate_type": inst.authenticate_type,
        "username": inst.username,
        "recording_storage_directory": "recordings/",
    })
    cfg_path.write_text(json.dumps(cfg, ensure_ascii=False, indent=4), encoding="utf-8")


class _Proc:
    def __init__(self) -> None:
        self.proc: subprocess.Popen | None = None
        self.lines: deque[str] = deque(maxlen=500)


class PcrcManager:
    def __init__(self) -> None:
        self._procs: dict[int, _Proc] = {}

    def is_running(self, inst_id: int) -> bool:
        p = self._procs.get(inst_id)
        return bool(p and p.proc and p.proc.poll() is None)

    def console(self, inst_id: int) -> list[str]:
        p = self._procs.get(inst_id)
        return list(p.lines) if p else []

    def start(self, inst: PcrcInstance) -> None:
        if self.is_running(inst.id):
            return
        write_config(inst)
        d = instance_dir(inst)
        slot = self._procs.get(inst.id)
        if slot is None:
            slot = _Proc()
            self._procs[inst.id] = slot
        proc = subprocess.Popen(
            [sys.executable, "-m", "pcrc"],
            cwd=str(d),
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            bufsize=1,
            encoding="utf-8",
            errors="ignore",
        )
        slot.proc = proc

        def reader() -> None:
            assert proc.stdout is not None
            for line in proc.stdout:
                slot.lines.append(line.rstrip("\n"))
            slot.lines.append("[panel] PCRC 进程已退出")

        threading.Thread(target=reader, daemon=True).start()
        slot.lines.append("[panel] PCRC 已启动")

    def send(self, inst_id: int, text: str) -> None:
        p = self._procs.get(inst_id)
        if p and p.proc and p.proc.poll() is None and p.proc.stdin:
            p.proc.stdin.write(text + "\n")
            p.proc.stdin.flush()
            p.lines.append(f"> {text}")

    def stop(self, inst_id: int) -> None:
        p = self._procs.get(inst_id)
        if not p or not p.proc:
            return
        try:
            if p.proc.poll() is None and p.proc.stdin:
                # 先停录像再退出,尽量保住录像文件
                p.proc.stdin.write("stop\n")
                p.proc.stdin.flush()
                p.proc.stdin.write("exit\n")
                p.proc.stdin.flush()
        except Exception:  # noqa: BLE001
            pass
        try:
            p.proc.wait(timeout=15)
        except Exception:  # noqa: BLE001
            p.proc.kill()


manager = PcrcManager()


def pcrc_available() -> bool:
    try:
        import importlib.util

        return importlib.util.find_spec("pcrc") is not None
    except Exception:  # noqa: BLE001
        return False
