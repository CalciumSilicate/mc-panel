"""Detect and import existing server packages/directories without executing them."""
from __future__ import annotations

import json
import os
import re
import shlex
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
PACKAGE_EXTENSIONS = ('.zip', '.rar', '.7z', '.tar.gz', '.tar')


def archive_library():
    # Windows ships libarchive with bsdtar; an explicit LIBARCHIVE takes priority.
    if os.name == 'nt' and 'LIBARCHIVE' not in os.environ:
        dll = Path(os.environ.get('SystemRoot', 'C:/Windows')) / 'System32/archiveint.dll'
        if dll.exists():
            os.environ['LIBARCHIVE'] = str(dll)
    try:
        import libarchive
        return libarchive
    except (ImportError, OSError) as exc:
        raise HTTPException(400, '缺少解压组件，请安装 libarchive（Linux: libarchive13；Windows: 系统组件或设置 LIBARCHIVE）') from exc


def extract_other(source: Path, target: Path, report):
    library = archive_library()
    target.mkdir()
    seen, count, total = set(), 0, 0
    available = min(MAX_EXPANDED, shutil.disk_usage(source.parent).free - 8 * 1024 ** 2)
    try:
        with library.file_reader(str(source)) as archive:
            for entry in archive:
                count += 1
                if count > MAX_ENTRIES:
                    raise HTTPException(413, '服务器包文件数量过多')
                name = str(entry.pathname).rstrip('/')
                while name.startswith('./'):
                    name = name[2:]
                if name in ('', '.') and entry.isdir:
                    continue
                parts = _parts(name)
                if '__MACOSX' == parts[0] or '.DS_Store' == parts[-1]:
                    continue
                if entry.issym or entry.islnk or not (entry.isfile or entry.isdir):
                    raise HTTPException(400, '服务器包包含链接或特殊文件')
                key = '/'.join(parts).casefold()
                if key in seen:
                    raise HTTPException(400, '服务器包存在重名路径')
                seen.add(key)
                if total + (entry.size or 0) > available:
                    raise HTTPException(413, '解压空间不足或服务器包超过 80 GiB')
                dest = target.joinpath(*parts)
                if entry.isdir:
                    dest.mkdir(parents=True, exist_ok=True)
                    continue
                dest.parent.mkdir(parents=True, exist_ok=True)
                size = 0
                with dest.open('xb') as out:
                    for block in entry.get_blocks():
                        size += len(block)
                        total += len(block)
                        if total > available or size > entry.size:
                            raise HTTPException(413, '解压数据超过限制')
                        out.write(block)
                        report('解压中', total, 0)
                if size != entry.size:
                    raise HTTPException(400, '服务器包不完整')
                if os.name != 'nt':
                    dest.chmod(entry.perm & 0o777)
    except library.exception.ArchiveError as exc:
        raise HTTPException(400, '无法解压服务器包：格式损坏、加密或压缩算法不受支持') from exc


def extract(source: Path, target: Path, report) -> None:
    # is_zipfile also accepts a ZIP embedded inside an uncompressed TAR (the
    # server.jar itself). Inspect the outer header before choosing the decoder.
    with source.open('rb') as stream:
        signature=stream.read(4)
    if signature not in (b'PK\x03\x04', b'PK\x05\x06', b'PK\x07\x08'):
        return extract_other(source, target, report)
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


def read_small(path: Path, limit=1024*1024) -> str:
    return path.read_text(encoding='utf-8-sig', errors='replace') if path.is_file() and path.stat().st_size <= limit else ''


def layout(root: Path):
    cfg = yaml.safe_load(read_small(root / 'config.yml')) or {}
    if isinstance(cfg, dict) and ('working_directory' in cfg or (root / 'server').is_dir()) and ('start_command' in cfg or (root / 'permission.yml').exists()):
        working = str(cfg.get('working_directory', 'server')).replace('\\', '/')
        if (root / 'server').is_dir():
            sd = root / 'server'
        else:
            sd = root.joinpath(*_parts(working.removeprefix('./')))
        if not sd.is_dir() or not sd.resolve().is_relative_to(root.resolve()):
            raise HTTPException(400, 'MCDR 的工作目录不在导入文件夹内')
        return sd, cfg
    return root, {}


def detect(root: Path, fallback_name: str, defaults: dict) -> dict:
    sd, cfg = layout(root)
    command = cfg.get('start_command', '')
    command = ' '.join(map(str, command)) if isinstance(command, list) else str(command)
    for path in [sd/'start.sh', sd/'start.bat', sd/'run.sh', sd/'run.bat', sd/'user_jvm_args.txt']:
        command += '\n' + read_small(path)
    options = dict(defaults, name=fallback_name[:120] or '导入服务器', server_type='vanilla', mc_version='', loader_version='', launch_jar='', extra_jvm_args='', startup_commands='[]')
    manifest = {}
    try:
        manifest = json.loads(read_small(root/'mc-panel-export.json') or '{}')
    except ValueError:
        pass
    if isinstance(manifest, dict):
        for key in ('name', 'mc_version', 'loader_version'):
            if isinstance(manifest.get(key), str):
                options[key] = manifest[key][:120 if key == 'name' else 64]
        if isinstance(manifest.get('startup_commands'),str):
            try:
                commands=json.loads(manifest['startup_commands'])
                if isinstance(commands,list) and len(commands)<=100 and all(isinstance(c,str) and len(c)<=2048 for c in commands):
                    options['startup_commands']=json.dumps(commands,ensure_ascii=False)
            except ValueError: pass
    # Retain JVM switches, but never execute imported shell scripts during detection.
    try:
        launch_line=next((line for line in command.splitlines() if '-jar' in line or '-Xmx' in line), '')
        tokens=shlex.split(launch_line)
        flags=[t for t in tokens if t.startswith(('-D','-XX:','--add-opens=','--add-exports='))]
        options['extra_jvm_args']=' '.join(shlex.quote(t) for t in flags)[:1024]
    except ValueError:pass
    for key, flag in [('min_memory','Xms'), ('max_memory','Xmx')]:
        match = re.search(r'-'+flag+r'([1-9]\d*[MGmg])\b', command)
        if match:
            options[key] = match[1].upper()
    jars = [p for p in sd.glob('*.jar') if not any(s in p.name.lower() for s in ('installer','sources','javadoc'))]
    launch = re.search(r'-jar\s+(?:"([^"]+)"|\x27([^\x27]+)\x27|([^\s]+))', command)
    candidate = None
    if launch:
        relative = next(s for s in launch.groups() if s).replace('\\','/').removeprefix('./')
        try:
            possible = sd.joinpath(*_parts(relative))
            if possible.is_file(): candidate = possible
        except HTTPException:
            pass
    if candidate is None:
        preferred = [p for p in jars if 'fabric-server-launch' in p.name.lower()]
        candidate = preferred[0] if len(preferred)==1 else sd/'server.jar' if (sd/'server.jar').is_file() else jars[0] if len(jars)==1 else None
    if candidate:
        options['launch_jar'] = candidate.relative_to(sd).as_posix()
        try:
            with zipfile.ZipFile(candidate) as jar:
                def read(name):
                    return jar.read(name).decode('utf-8', errors='replace') if name in jar.namelist() and jar.getinfo(name).file_size < 1024*1024 else ''
                version = json.loads(read('version.json') or '{}')
                options['mc_version'] = str(version.get('id', options['mc_version']))[:64]
                info = read('META-INF/MANIFEST.MF')
                if 'fabric' in info.lower() or 'fabric' in candidate.name.lower(): options['server_type']='fabric'
                if 'velocity' in info.lower() or 'velocity' in candidate.name.lower(): options['server_type']='velocity'
                versions = read('META-INF/versions.list').splitlines()
                if not options['mc_version'] and versions:
                    fields = versions[0].split('\t')
                    if len(fields)>1: options['mc_version']=fields[1][:64]
        except (ValueError, OSError, zipfile.BadZipFile):
            pass
    forge = sd/'libraries/net/minecraftforge/forge'
    if forge.is_dir():
        builds = sorted(p.name for p in forge.iterdir() if p.is_dir())
        if builds:
            options['server_type']='forge'
            version, _, loader = builds[-1].partition('-')
            options['mc_version'], options['loader_version'] = version[:64],loader[:64]
    fabric = sd/'libraries/net/fabricmc/fabric-loader'
    if fabric.is_dir():
        options['server_type']='fabric'
        builds = sorted(p.name for p in fabric.iterdir() if p.is_dir())
        if builds: options['loader_version']=builds[-1][:64]
    props = read_small(sd/'server.properties')
    port = re.search(r'^\s*server-port\s*=\s*(\d+)', props, re.M)
    if (sd/'velocity.toml').exists():
        options['server_type']='velocity'
        port = re.search(r'^\s*bind\s*=\s*"[^"\n]*:(\d+)"',read_small(sd/'velocity.toml'),re.M)
    options['port'] = int(port[1]) if port and 0<int(port[1])<65536 else 25565
    if not options['mc_version']:
        match = re.search(r'(?i)(?:minecraft|server)[-_ ](\d+\.\d+(?:\.\d+)?)',candidate.name if candidate else '')
        if match: options['mc_version']=match[1]
    if not options['mc_version']:
        # Older jars and some launchers have no version.json. Saved worlds carry
        # the last game version, so use it as the final available hint.
        import gzip
        import io
        import nbtlib
        level=re.search(r'^\s*level-name\s*=\s*(.+)$',props,re.M)
        try:
            world=sd.joinpath(*_parts(level[1].strip() if level else 'world'))
            path=world/'level.dat'
            if path.is_file() and path.stat().st_size<=4*1024**2:
                with gzip.open(path,'rb') as stream:
                    data=stream.read(16*1024**2+1)
                if len(data)<=16*1024**2:
                    nbt=nbtlib.File.parse(io.BytesIO(data))
                    options['mc_version']=str(nbt.get('Data',{}).get('Version',{}).get('Name',''))[:64]
        except (OSError, ValueError, KeyError, EOFError, HTTPException):
            pass
    def mb(value): return int(value[:-1])*(1024 if value[-1]=='G' else 1)
    if mb(options['min_memory'])>mb(options['max_memory']):options['max_memory']=options['min_memory']
    return options


def prepare(root: Path, staging: Path, options: dict, java: str) -> str:
    """Normalize raw server and MCDR layouts into a panel instance."""
    working, config = layout(root)
    if config:
        plugin_dirs=config.get('plugin_directories',[])
        if not isinstance(plugin_dirs,list):raise HTTPException(400,'MCDR plugin_directories 格式无效')
        for plugin_dir in plugin_dirs:
            relative_plugin=str(plugin_dir).replace('\\','/').removeprefix('./')
            if relative_plugin=='plugins':continue
            try:
                path=root.joinpath(*_parts(relative_plugin))
            except HTTPException:continue
            if path.is_dir() and not path.resolve().is_relative_to(working.resolve()) and not (root/'plugins').resolve().is_relative_to(path.resolve()):
                destination=root/'plugins'
                destination.mkdir(exist_ok=True)
                for plugin in path.iterdir():
                    if (destination/plugin.name).exists():raise HTTPException(400,'多个插件目录包含同名文件，请整理后导入')
                    os.replace(plugin,destination/plugin.name)
        relative = working.relative_to(root)
        os.replace(root, staging)
        if relative.as_posix() != 'server':
            os.replace(staging/relative, staging/'server')
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
        raise HTTPException(400, "无法识别唯一服务端核心，请在目录内保留服务端 JAR 和对应启动脚本后重新导入")
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
    if options.get('extra_jvm_args'):
        flags=shlex.split(options['extra_jvm_args'])
        defaults['start_command'][3:3]=flags
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
    options = state.get('options')
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
        if state.get('source')=='local':
            from .server_transfer import copy_local
            copy_local(state['source_path'],work/'extracted',report)
        else:
            if state.get('source')=='url':
                from .server_transfer import download
                with SessionLocal() as db:
                    get_settings_row(db)  # Apply configured outbound proxy.
                download(state['source_url'],session_dir/'data.part',report)
            extract(session_dir / "data.part", work / "extracted", report)
        report("初始化实例")
        root = package_root(work/'extracted')
        with SessionLocal() as db:
            settings=get_settings_row(db)
            java = settings.java_command
            defaults = dict(min_memory=settings.default_min_memory.upper(),max_memory=settings.default_max_memory.upper())
        automatic=not options
        if automatic:
            fallback=Path(state.get('source_path') or state['name']).name
            for extension in PACKAGE_EXTENSIONS:
                if fallback.lower().endswith(extension):fallback=fallback[:-len(extension)];break
            if root.name!='extracted':fallback=root.name
            options=detect(root,fallback,defaults)
        version = prepare(root, work / "instance", options, java)
        with SessionLocal() as db:
            # Serialize competing import/create transactions before choosing a
            # name/port. The resulting directory is unique and never replaces an instance.
            from sqlalchemy import text
            db.execute(text("BEGIN IMMEDIATE"))
            if automatic:
                from .ports import find_free_port, is_port_free
                base=options['name'].strip() or '导入服务器'
                name=base
                suffix=2
                while db.scalar(select(Server.id).where(Server.name==name)):
                    name=f'{base[:110]} ({suffix})';suffix+=1
                options['name']=name
                taken=set(db.scalars(select(Server.port)))
                if options['port'] in taken or not is_port_free(options['port']):
                    settings=get_settings_row(db)
                    options['port']=find_free_port(taken,settings.port_min,settings.port_max)
                    if not options['port']:raise HTTPException(409,'没有可用端口')
                    # Rebind only the copied instance, never the local source.
                    from .mcdr import MCDRManager
                    temp=MCDRManager()
                    temp.instance_dir=lambda server: work/'instance'
                    temp.apply_port(Server(port=options['port'],server_type=options['server_type']))
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
                            loader_version=options.get('loader_version',''),
                            extra_jvm_args=options.get('extra_jvm_args',''),
                            startup_commands=options.get('startup_commands','[]'),
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
