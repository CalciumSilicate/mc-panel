"""轻量任务进度注册表:供插件/模组在线安装上报实时下载进度,前端轮询读取。"""
from __future__ import annotations

import uuid

_jobs: dict[str, dict] = {}
_order: list[str] = []
_MAX = 200


def create() -> str:
    jid = uuid.uuid4().hex
    _jobs[jid] = {
        "downloaded": 0,
        "total": 0,
        "status": "running",
        "message": "",
        "file_name": "",
    }
    _order.append(jid)
    while len(_order) > _MAX:
        _jobs.pop(_order.pop(0), None)
    return jid


def update(jid: str, downloaded: int, total: int) -> None:
    job = _jobs.get(jid)
    if job is not None:
        job["downloaded"] = downloaded
        job["total"] = total


def finish(jid: str, file_name: str = "", message: str = "") -> None:
    job = _jobs.get(jid)
    if job is not None:
        job.update(status="done", file_name=file_name, message=message)


def fail(jid: str, message: str) -> None:
    job = _jobs.get(jid)
    if job is not None:
        job.update(status="error", message=message)


def get(jid: str) -> dict | None:
    return _jobs.get(jid)
