"""Resumable bounded requests; expensive finalization runs outside HTTP requests."""
from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import os
import re
import shutil
import threading
import time
import uuid
from pathlib import Path

from fastapi import HTTPException

from .config import DATA_DIR
from .database import SessionLocal
from .deps import ensure_not_protected
from .models import Server
from . import server_files

ROOT = DATA_DIR / "uploads"
CHUNK_BYTES = 4 * 1024 * 1024
MAX_BYTES = 20 * 1024 ** 3
TTL = 24 * 3600
_guard = threading.RLock()
_tasks: dict[str, asyncio.Task] = {}
logger = logging.getLogger(__name__)


def folder(uid: str) -> Path:
    if not re.fullmatch(r"[0-9a-f]{32}", uid):
        raise HTTPException(404, "上传任务不存在")
    return ROOT / uid


def read(uid: str) -> dict:
    # Writers replace state.json under the same guard. On Windows, even opening
    # the old file during that replacement can fail with a sharing violation.
    with _guard:
        try:
            return json.loads((folder(uid) / "state.json").read_text(encoding="utf-8"))
        except FileNotFoundError:
            raise HTTPException(404, "上传任务不存在") from None


def save(state: dict) -> None:
    state["updated_at"] = time.time()
    temp = folder(state["id"]) / "state.tmp"
    temp.write_text(json.dumps(state, ensure_ascii=False), encoding="utf-8")
    os.replace(temp, temp.with_name("state.json"))


def public(state: dict) -> dict:
    keys = ("id", "name", "size", "received", "status", "stage", "processed", "total", "message", "server_id")
    return {**{k: state.get(k) for k in keys}, "chunk_bytes": CHUNK_BYTES}


def owned(uid: str, user_id: int) -> dict:
    state = read(uid)
    if state["owner_id"] != user_id:
        raise HTTPException(404, "上传任务不存在")
    return state


def create(payload: dict, user_id: int) -> dict:
    ROOT.mkdir(parents=True, exist_ok=True)
    server_files._parts(payload["name"])
    if "/" in payload["name"]:
        raise HTTPException(400, "文件名不能包含目录")
    if not 0 <= payload["size"] <= MAX_BYTES:
        raise HTTPException(413, "文件超过 20 GiB 限制")
    if payload["size"] > shutil.disk_usage(ROOT).free - CHUNK_BYTES:
        raise HTTPException(413, "磁盘空间不足")
    expected = None
    if payload["kind"] == "file":
        with SessionLocal() as db:
            server = db.get(Server, payload.get("server_id"))
            if server is None:
                raise HTTPException(404, "服务器不存在")
            ensure_not_protected(server)
            _, expected = server_files.upload_target(server, payload["directory"], payload["name"])
            if expected is not None and not payload.get("overwrite"):
                raise HTTPException(409, "已存在同名文件，请勾选替换同名文件")
    elif not payload["name"].lower().endswith(".zip"):
        raise HTTPException(400, "服务器包仅支持 ZIP")
    with _guard:
        # Bound abandoned sessions and disk usage; expired sessions are cleaned
        # by the lifecycle worker, not while accepting a request.
        if sum(1 for p in ROOT.iterdir() if p.is_dir()) >= 100:
            raise HTTPException(429, "上传任务过多，请清理已完成或放弃的任务")
        uid = uuid.uuid4().hex
        folder(uid).mkdir()
        state = {**payload, "id": uid, "owner_id": user_id, "expected": expected,
                 "received": 0, "status": "uploading", "stage": "上传中",
                 "processed": 0, "total": 0, "message": "", "created_at": time.time()}
        (folder(uid) / "data.part").touch()
        save(state)
    return public(state)


def append(uid: str, user_id: int, offset: int, data: bytes, digest: str) -> dict:
    if not data or len(data) > CHUNK_BYTES:
        raise HTTPException(413, "分片大小不合法")
    if digest and hashlib.sha256(data).hexdigest() != digest:
        raise HTTPException(400, "分片校验失败")
    with _guard:
        state = owned(uid, user_id)
        if state["status"] != "uploading":
            raise HTTPException(409, "任务不在上传状态")
        if offset < 0 or offset > state["received"] or offset + len(data) > state["size"]:
            raise HTTPException(409, "分片位置不匹配")
        path = folder(uid) / "data.part"
        with path.open("r+b") as stream:
            if offset < state["received"]:
                stream.seek(offset)
                if offset + len(data) <= state["received"] and stream.read(len(data)) == data:
                    return public(state)  # Retry after an HTTP response was lost.
                raise HTTPException(409, "已上传分片内容不一致")
            stream.truncate(state["received"])
            stream.seek(offset)
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        state["received"] += len(data)
        save(state)
        return public(state)


def progress(uid: str, stage: str, processed: int = 0, total: int = 0) -> None:
    with _guard:
        state = read(uid)
        state.update(stage=stage, processed=processed, total=total)
        save(state)


def process(uid: str) -> None:
    try:
        state = read(uid)
        if state["kind"] == "file":
            progress(uid, "写入文件")
            with SessionLocal() as db:
                server = db.get(Server, state["server_id"])
                if server is None:
                    raise HTTPException(404, "服务器不存在")
                server_files.publish_upload(server, state["directory"], state["name"],
                                            folder(uid) / "data.part", state["expected"])
            server_id = state["server_id"]
        else:
            from .server_import import import_package
            server_id = import_package(state, folder(uid), lambda *args: progress(uid, *args))
        with _guard:
            state = read(uid)
            state.update(status="done", stage="完成", server_id=server_id)
            save(state)
        (folder(uid) / "data.part").unlink(missing_ok=True)
    except Exception as exc:
        logger.exception("Upload finalization failed: %s", uid)
        with _guard:
            state = read(uid)
            message = str(exc.detail) if isinstance(exc, HTTPException) else str(exc)
            state.update(status="error", stage="失败", message=message or "处理失败")
            save(state)


async def _run(uid: str) -> None:
    try:
        await asyncio.to_thread(process, uid)
    finally:
        _tasks.pop(uid, None)


def complete(uid: str, user_id: int) -> dict:
    with _guard:
        state = owned(uid, user_id)
        if state["status"] in ("processing", "done", "error"):
            return public(state)
        if state["received"] != state["size"]:
            raise HTTPException(409, "文件尚未上传完成")
        state.update(status="processing", stage="等待处理")
        save(state)
        _tasks[uid] = asyncio.create_task(_run(uid))
        return public(state)


def discard(uid: str, user_id: int) -> Path:
    with _guard:
        state = owned(uid, user_id)
        if state["status"] == "processing":
            raise HTTPException(409, "后台处理尚未结束")
        target = folder(uid).resolve()
        if target.parent != ROOT.resolve():
            raise HTTPException(400, "上传目录不合法")
        trash = target.with_name(f"trash-{uid}")
        os.replace(target, trash)
        return trash


def delete_trash(path: Path) -> None:
    if path.resolve().parent != ROOT.resolve() or not re.fullmatch(r"trash-[0-9a-f]{32}", path.name):
        raise HTTPException(400, "上传目录不合法")
    shutil.rmtree(path, ignore_errors=True)


def recover() -> None:
    ROOT.mkdir(parents=True, exist_ok=True)
    for path in ROOT.iterdir():
        if re.fullmatch(r"trash-[0-9a-f]{32}", path.name) and not path.is_symlink():
            delete_trash(path)
            continue
        if not re.fullmatch(r"[0-9a-f]{32}", path.name) or not path.is_dir() or path.is_symlink():
            continue
        trash = None
        with _guard:
            state = read(path.name)
            if state["status"] == "processing" and path.name not in _tasks:
                state.update(status="error", stage="失败", message="面板重启中断了处理，请重新导入")
                save(state)
            if state["status"] != "processing" and time.time() - state["updated_at"] > TTL:
                trash = discard(path.name, state["owner_id"])
        if trash is not None:
            delete_trash(trash)


async def maintenance() -> None:
    while True:
        try:
            await asyncio.to_thread(recover)
        except Exception:
            logger.exception("Upload cleanup failed")
        await asyncio.sleep(3600)


async def shutdown() -> None:
    # Do not abandon a thread halfway through publishing an instance.
    await asyncio.gather(*list(_tasks.values()), return_exceptions=True)
