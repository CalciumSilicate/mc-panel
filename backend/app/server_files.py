"""Existing instance files on a trusted host, not a hostile-filesystem sandbox.

Checks reject links and special files, but cannot defeat concurrent hostile link
swaps. Revisions catch ordinary external edits on a best-effort basis. Atomic
replacement preserves POSIX mode, not native ACLs or other extended metadata.
"""
from __future__ import annotations

import hashlib
import os
import re
import stat
import tempfile
import threading
import unicodedata
from datetime import datetime, timezone
from functools import wraps
from pathlib import Path

from fastapi import HTTPException

from .config import SERVERS_ROOT
from .mcdr import manager

MAX_BYTES = 1024 * 1024
_locks: dict[str, threading.Lock] = {}
_locks_guard = threading.Lock()
_RESERVED = re.compile(r"^(CON|PRN|AUX|NUL|CONIN\$|CONOUT\$|COM[1-9¹²³]|LPT[1-9¹²³])$", re.I)


def _error(status: int, message: str):
    raise HTTPException(status_code=status, detail=message)


def _io_errors(fn):
    @wraps(fn)
    def wrapped(*args, **kwargs):
        try:
            return fn(*args, **kwargs)
        except FileNotFoundError:
            _error(404, "文件或目录不存在")
        except PermissionError:
            _error(403, "文件访问被拒绝")
        except OSError:
            _error(400, "无法访问或保存文件")
    return wrapped


def _parts(path: str, allow_root: bool = False) -> list[str]:
    if path == "" and allow_root:
        return []
    parts = path.split("/")
    for part in parts:
        if (not part or part in {".", ".."} or part.endswith((" ", "."))
                or any(c in '\\:<>"|?*' or unicodedata.category(c) == "Cc" for c in part)
                or _RESERVED.fullmatch(part.split(".", 1)[0].rstrip(" "))):
            _error(400, "不合法的相对路径")
    return parts


def _check(st: os.stat_result) -> str:
    if stat.S_ISLNK(st.st_mode) or getattr(st, "st_file_attributes", 0) & 0x400:
        _error(400, "不允许访问链接或重解析点")
    if stat.S_ISDIR(st.st_mode):
        return "directory"
    if not stat.S_ISREG(st.st_mode):
        _error(400, "不允许访问特殊文件")
    if st.st_nlink != 1:
        _error(400, "不允许访问硬链接文件")
    return "file"


def _root(server) -> Path:
    parts = _parts(server.dir_name)
    if len(parts) != 1:
        _error(400, "实例目录不合法")
    base = Path(os.path.abspath(SERVERS_ROOT))
    root = Path(os.path.abspath(manager.instance_dir(server)))
    if root != base / parts[0]:
        _error(400, "实例目录不合法")
    # lstat every component, including the configured root and its ancestors.
    for node in reversed((root, *root.parents)):
        if _check(node.lstat()) != "directory":
            _error(400, "实例目录不合法")
    if root.resolve().parent != base.resolve():
        _error(400, "实例目录不合法")
    return root


def _target(server, path: str, kind: str) -> tuple[Path, os.stat_result]:
    parts = _parts(path, allow_root=kind == "directory")
    root = _root(server)
    target = root
    for i, part in enumerate(parts):
        target = target / part
        found = _check(target.lstat())
        if i < len(parts) - 1 and found != "directory":
            _error(400, "路径组件不是目录")
    st = target.lstat()
    if _check(st) != kind:
        _error(400, "文件类型不匹配")
    if not target.resolve().is_relative_to(root.resolve()):
        _error(400, "路径超出实例目录")
    return target, st


def _timestamp(st: os.stat_result) -> str:
    return datetime.fromtimestamp(st.st_mtime, timezone.utc).isoformat()


@_io_errors
def list_directory(server, path: str = "") -> dict:
    directory, _ = _target(server, path, "directory")
    entries = []
    for child in directory.iterdir():
        entry = {"name": child.name, "path": f"{path}/{child.name}" if path else child.name,
                 "kind": "blocked", "size_bytes": None, "modified_at": None}
        try:
            _parts(child.name)
            st = child.lstat()
            entry.update(kind=_check(st), size_bytes=st.st_size, modified_at=_timestamp(st))
        except HTTPException as exc:
            entry["reason"] = exc.detail
        except OSError:
            entry["reason"] = "无法访问此条目"
        entries.append(entry)
    entries.sort(key=lambda e: (e["kind"] != "directory", e["name"].casefold(), e["name"]))
    return {"path": path, "entries": entries}


def _validate_text(text: str):
    if any(unicodedata.category(c) == "Cc" and c not in "\t\r\n" for c in text):
        _error(415, "文件包含二进制或控制字符")


def _content(path: str, raw: bytes, st: os.stat_result) -> dict:
    try:
        text = raw.decode("utf-8-sig")
    except UnicodeDecodeError:
        _error(415, "文件不是有效的 UTF-8 文本")
    _validate_text(text)
    endings = set(re.findall(r"\r\n|\r|\n", text))
    newline = "mixed" if len(endings) > 1 else {"\r\n": "CRLF", "\r": "CR", "\n": "LF"}.get(next(iter(endings), "\n"))
    result = {"path": path, "text": text.replace("\r\n", "\n").replace("\r", "\n"),
              "revision": hashlib.sha256(raw).hexdigest(), "editable": newline != "mixed",
              "bom": raw.startswith(b"\xef\xbb\xbf"), "newline": newline,
              "size_bytes": len(raw), "modified_at": _timestamp(st)}
    if newline == "mixed":
        result["reason"] = "混合换行符文件仅支持查看"
    return result


def _read(server, path: str):
    target, _ = _target(server, path, "file")
    fd = os.open(target, os.O_RDONLY | getattr(os, "O_BINARY", 0) | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_NONBLOCK", 0))
    with os.fdopen(fd, "rb") as stream:
        st = os.fstat(stream.fileno())
        if _check(st) != "file":
            _error(400, "不是普通文件")
        if st.st_size > MAX_BYTES:
            _error(413, "文件超过 1 MiB 限制")
        raw = stream.read(MAX_BYTES + 1)
        if len(raw) > MAX_BYTES:
            _error(413, "文件超过 1 MiB 限制")
        after = os.fstat(stream.fileno())
        if (st.st_size, st.st_mtime_ns, st.st_ctime_ns) != (after.st_size, after.st_mtime_ns, after.st_ctime_ns):
            _error(409, "文件在读取时发生变化，请重试")
    _, latest = _target(server, path, "file")
    if (st.st_dev, st.st_ino, st.st_size, st.st_mtime_ns) != (latest.st_dev, latest.st_ino, latest.st_size, latest.st_mtime_ns):
        _error(409, "文件在读取时发生变化，请重试")
    return target, st, _content(path, raw, st)


@_io_errors
def read_content(server, path: str) -> dict:
    return _read(server, path)[2]


@_io_errors
def save_content(server, path: str, text: str, revision: str) -> dict:
    key = str(_root(server))
    with _locks_guard:
        lock = _locks.setdefault(key, threading.Lock())
    with lock:
        target, st, current = _read(server, path)
        if current["revision"] != revision:
            _error(409, "文件已被修改，请重新加载后再保存")
        if not current["editable"]:
            _error(409, current["reason"])
        _validate_text(text)
        text = text.replace("\r\n", "\n").replace("\r", "\n")
        ending = {"LF": "\n", "CRLF": "\r\n", "CR": "\r"}[current["newline"]]
        try:
            raw = (b"\xef\xbb\xbf" if current["bom"] else b"") + text.replace("\n", ending).encode("utf-8")
        except UnicodeEncodeError:
            _error(415, "内容不是有效的 UTF-8 文本")
        if len(raw) > MAX_BYTES:
            _error(413, "文件超过 1 MiB 限制")
        temporary = None
        try:
            fd, temporary = tempfile.mkstemp(prefix=".mc-panel-edit-", dir=target.parent)
            with os.fdopen(fd, "wb") as stream:
                stream.write(raw)
                stream.flush()
                if os.name != "nt":
                    os.fchmod(stream.fileno(), stat.S_IMODE(st.st_mode))
                os.fsync(stream.fileno())
            # Revalidate the complete path and content immediately before replace.
            checked_target, latest_st, latest = _read(server, path)
            if latest["revision"] != revision or (st.st_dev, st.st_ino, st.st_mode) != (latest_st.st_dev, latest_st.st_ino, latest_st.st_mode):
                _error(409, "文件已被修改，请重新加载后再保存")
            os.replace(temporary, checked_target)
            temporary = None
            return _content(path, raw, checked_target.stat())
        finally:
            if temporary is not None:
                os.unlink(temporary)
