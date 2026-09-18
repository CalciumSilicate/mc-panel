"""Import an existing server ZIP without running scripts or downloading cores."""
from __future__ import annotations

import json
import os
import shutil
import stat
import uuid
import zipfile
from pathlib import Path

import yaml
from fastapi import HTTPException
from sqlalchemy import func, select

from .config import SERVERS_ROOT
from .database import SessionLocal
from .deps import get_settings_row
from .mcdr import _eula_text, _mcdr_config, _permission_text, _resolve_launch
from .models import Server
from .server_files import _parts

MAX_ENTRIES = 100_000
MAX_EXPANDED = 80 * 1024 ** 3


def extract(source: Path, target: Path, report) -> None:
    with zipfile.ZipFile(source) as archive:
        infos = archive.infolist()
        if len(infos) > MAX_ENTRIES:
            raise HTTPException(400, "服务器包文件数量过多")
        total = sum(i.file_size for i in infos)
        if total > MAX_EXPANDED or total > shutil.disk_usage(source.parent).free - 8 * 1024 ** 2:
            raise HTTPException(413, "解压空间不足或服务器包超过 80 GiB")
        entries = []
        seen = set()
        for info in infos:
            name = info.filename.rstrip("/") if info.is_dir() else info.filename
            parts = _parts(name)
            if parts[0] == "__MACOSX" or parts[-1] == ".DS_Store":
                continue
            mode = info.external_attr >> 16
            kind = stat.S_IFMT(mode)
            if kind not in (0, stat.S_IFREG, stat.S_IFDIR) or info.flag_bits & 1:
                raise HTTPException(400, "服务器包包含链接、特殊文件或加密文件")
            key = "/".join(parts).casefold()
            if key in seen:
                raise HTTPException(400, "服务器包存在重名路径")
            seen.add(key)
            entries.append((info, parts))
        target.mkdir()
        processed = 0
        for info, parts in entries:
            dest = target.joinpath(*parts)
            if not dest.resolve().is_relative_to(target.resolve()):
                raise HTTPException(400, "服务器包路径越界")
            if info.is_dir():
                dest.mkdir(parents=True, exist_ok=True)
                continue
            dest.parent.mkdir(parents=True, exist_ok=True)
            with archive.open(info) as src, dest.open("xb") as out:
                file_size = 0
                while chunk := src.read(1024 * 1024):
                    file_size += len(chunk)
                    if file_size > info.file_size:
                        raise HTTPException(400, "服务器包文件大小不匹配")
                    out.write(chunk)
                    processed += len(chunk)
                    report("解压中", processed, total)
            if file_size != info.file_size:
                raise HTTPException(400, "服务器包不完整")
            # Retain executability for native helpers, never special permission bits.
            if os.name != "nt" and mode:
                dest.chmod((info.external_attr >> 16) & 0o777)


def package_root(extracted: Path) -> Path:
    root = extracted
    for _ in range(10):
        children = list(root.iterdir())
        if len(children) == 1 and children[0].is_dir() and children[0].name not in {"mods", "plugins", "world", "config", "libraries"}:
            root = children[0]
        else:
            break
    return root


def prepare(root: Path, staging: Path, options: dict, java: str) -> str:
    """Normalize raw server and MCDR layouts into a panel instance."""
    if (root / "server").is_dir() and (root / "config.yml").is_file():
        os.replace(root, staging)
    else:
        staging.mkdir()
        os.replace(root, staging / "server")
    sd = staging / "server"
    launch_jar = options.get("launch_jar", "").strip()
    if launch_jar:
        candidate = sd.joinpath(*_parts(launch_jar))
        if not candidate.is_file() or candidate.suffix.lower() != ".jar":
            raise HTTPException(400, "指定的启动 JAR 不存在")
    elif (sd / "server.jar").is_file():
        candidate = sd / "server.jar"
    else:
        jars = [p for p in sd.glob("*.jar") if not any(s in p.name.lower() for s in ("installer", "sources", "javadoc"))]
        preferred = [p for p in jars if "fabric-server-launch" in p.name.lower()]
        if len(preferred) == 1:
            candidate = preferred[0]
        elif len(jars) == 1:
            candidate = jars[0]
        else:
            candidate = None
    forge_args = sd / "libraries/net/minecraftforge/forge"
    has_forge_args = any(forge_args.glob("*/win_args.txt")) or any(forge_args.glob("*/unix_args.txt"))
    if candidate is None and not (options["server_type"] == "forge" and has_forge_args):
        raise HTTPException(400, "未找到唯一服务端 JAR，请填写启动 JAR 路径；仅支持已安装的服务端包")
    if candidate and candidate.name != "server.jar" and options["server_type"] != "forge":
        shutil.copy2(candidate, sd / "server.jar")
    if options["server_type"] == "forge":
        native_args = "win_args.txt" if os.name == "nt" else "unix_args.txt"
        if has_forge_args and not any(forge_args.glob(f"*/{native_args}")):
            raise HTTPException(400, f"Forge 包缺少当前系统所需的 {native_args}")
        if not has_forge_args and not any(p for p in sd.glob("forge-*.jar") if "installer" not in p.name):
            raise HTTPException(400, "Forge 包缺少已安装的核心文件")

    version = options.get("mc_version", "").strip()
    if not version and candidate:
        try:
            with zipfile.ZipFile(candidate) as jar:
                info = jar.getinfo("version.json")
                if info.file_size <= 1024 * 1024:
                    version = str(json.loads(jar.read(info)).get("id", ""))[:64]
        except (KeyError, ValueError, OSError, zipfile.BadZipFile):
            pass
    for sub in ("plugins", "config", "logs"):
        (staging / sub).mkdir(exist_ok=True)
    cfg = staging / "config.yml"
    original = yaml.safe_load(cfg.read_text(encoding="utf-8")) if cfg.exists() else {}
    if not isinstance(original, dict):
        original = {}
    # Preserve language/plugin settings, but bind all runtime paths and launch
    # commands to this newly imported instance instead of the source machine.
    defaults = _mcdr_config(java, options["min_memory"], options["max_memory"],
                            server_type=options["server_type"],
                            launch=_resolve_launch(staging, options["server_type"]))
    original.update({key: defaults[key] for key in (
        "working_directory", "start_command", "handler", "plugin_directories",
        "advanced_console", "telemetry", "check_update",
    )})
    for key, value in defaults.items():
        original.setdefault(key, value)
    cfg.write_text(yaml.safe_dump(original, allow_unicode=True, sort_keys=False), encoding="utf-8")
    if not (staging / "permission.yml").exists():
        (staging / "permission.yml").write_text(_permission_text(), encoding="utf-8")
    if options["server_type"] == "velocity":
        from .mcdr import _velocity_toml
        path = sd / "velocity.toml"
        import re
        text = path.read_text(encoding="utf-8") if path.exists() else _velocity_toml(options["port"])
        bind = f'bind = "0.0.0.0:{options["port"]}"'
        if re.search(r"(?m)^\s*bind\s*=", text):
            text = re.sub(r"(?m)^\s*bind\s*=.*$", bind, text, count=1)
        else:
            text = bind + "\n" + text
        path.write_text(text, encoding="utf-8")
    else:
        path = sd / "server.properties"
        lines = path.read_text(encoding="utf-8-sig").splitlines() if path.exists() else []
        lines = [line for line in lines if not line.strip().startswith("server-port=")]
        lines.append(f'server-port={options["port"]}')
        path.write_text("\n".join(lines) + "\n", encoding="utf-8")
        if not (sd / "eula.txt").exists():
            (sd / "eula.txt").write_text(_eula_text(), encoding="utf-8")
    for name in (".installing", ".install_failed"):
        (staging / name).unlink(missing_ok=True)
    return version


def import_package(state: dict, session_dir: Path, report) -> int:
    options = state["options"]
    work = session_dir / "work"
    if work.exists():
        if work.resolve().parent != session_dir.resolve():
            raise HTTPException(400, "导入目录不合法")
        shutil.rmtree(work)
    work.mkdir()
    final = None
    published = False
    committed = False
    try:
        report("校验服务器包")
        extract(session_dir / "data.part", work / "extracted", report)
        report("初始化实例")
        with SessionLocal() as db:
            java = get_settings_row(db).java_command
        version = prepare(package_root(work / "extracted"), work / "instance", options, java)
        with SessionLocal() as db:
            # Serialize competing import/create transactions before choosing a
            # name/port. The resulting directory is unique and never replaces an instance.
            from sqlalchemy import text
            db.execute(text("BEGIN IMMEDIATE"))
            if db.scalar(select(Server.id).where(Server.name == options["name"])):
                raise HTTPException(409, "同名服务器已存在")
            if db.scalar(select(Server.id).where(Server.port == options["port"])):
                raise HTTPException(409, "端口已被其它实例使用")
            from .ports import is_port_free
            if not is_port_free(options["port"]):
                raise HTTPException(409, "端口已被其它程序占用")
            server = Server(name=options["name"], dir_name=uuid.uuid4().hex,
                            server_type=options["server_type"], mc_version=version,
                            port=options["port"], min_memory=options["min_memory"],
                            max_memory=options["max_memory"], auto_start=False,
                            sort_order=(db.scalar(select(func.max(Server.sort_order))) or 0) + 1)
            db.add(server)
            db.flush()
            SERVERS_ROOT.mkdir(parents=True, exist_ok=True)
            final = SERVERS_ROOT / server.dir_name
            if final.exists() or final.resolve().parent != SERVERS_ROOT.resolve():
                raise HTTPException(409, "实例目录冲突")
            os.replace(work / "instance", final)
            published = True
            db.commit()
            committed = True
            return server.id
    finally:
        if not committed and published and final and final.exists() and final.resolve().parent == SERVERS_ROOT.resolve():
            shutil.rmtree(final)
        if work.exists() and work.resolve().parent == session_dir.resolve():
            shutil.rmtree(work)
