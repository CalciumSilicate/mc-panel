"""mc-panel 数据存档 —— 整个 data/ 的备份与恢复(像游戏存档一样)。

create 把 data/ 打成一个可携带的 .zip;换电脑时把这个 .zip 拷过去,用 restore 还原。
打包内容 = data/ 里的全部运行时状态(实例 servers/、存档 archives/、数据库 panel.db、
密钥 secret.key 等),默认排除可重新下载的 jar 缓存(data/jar_cache)。

用法:
    uv run python backup.py create   [--out DIR] [--name NAME] [--include-cache]
    uv run python backup.py list     [--out DIR]
    uv run python backup.py restore  ARCHIVE.zip [--yes] [--no-backup-old]

备份目录优先级:--out 参数 > 环境变量 MCPANEL_BACKUP_DIR > 仓库同级的 ../mc-panel-backups。
把 MCPANEL_BACKUP_DIR 指向网盘 / 移动硬盘目录,备份就直接落到能带走的地方。
"""
from __future__ import annotations

import argparse
import json
import os
import platform
import shutil
import socket
import sys
import time
import zipfile
from datetime import datetime
from pathlib import Path

# Windows 控制台 / 管道默认可能是 GBK,统一用 UTF-8 输出,避免 ✓ ✗ → 等字符报错。
for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8")
    except (AttributeError, ValueError):
        pass

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT / "backend"))
from app import config  # noqa: E402  (依赖 backend 在 sys.path 上)

# 相对 DATA_DIR 的顶层目录:默认不打包(可重新下载的缓存)
DEFAULT_EXCLUDES = {"jar_cache"}
MANIFEST_NAME = "backup-info.json"
ARCHIVE_PREFIX = "mcpanel-backup-"
DATA_ARCNAME = "data"  # 归档内 data/ 的前缀


def _human(n: float) -> str:
    for unit in ("B", "KB", "MB", "GB", "TB"):
        if n < 1024:
            return f"{n:.0f}{unit}" if unit == "B" else f"{n:.1f}{unit}"
        n /= 1024
    return f"{n:.1f}PB"


def _progress(label: str, done: int, total: int, t0: float) -> None:
    pct = (done / total * 100) if total else 100.0
    elapsed = time.time() - t0
    speed = done / elapsed if elapsed > 0 else 0
    sys.stdout.write(f"\r  {label} {pct:5.1f}%  {_human(done)}/{_human(total)}  {_human(speed)}/s   ")
    sys.stdout.flush()


def resolve_backup_dir(arg_out: str | None) -> Path:
    if arg_out:
        return Path(arg_out).expanduser().resolve()
    env = os.environ.get("MCPANEL_BACKUP_DIR")
    if env:
        return Path(env).expanduser().resolve()
    return (config.PROJECT_ROOT.parent / "mc-panel-backups").resolve()


def _read_manifest(zip_path: Path) -> dict | None:
    try:
        with zipfile.ZipFile(zip_path) as zf:
            with zf.open(MANIFEST_NAME) as f:
                return json.load(f)
    except (KeyError, zipfile.BadZipFile, OSError, json.JSONDecodeError):
        return None


def _port_in_use(port: int) -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.settimeout(0.3)
        try:
            return s.connect_ex(("127.0.0.1", port)) == 0
        except OSError:
            return False


def _iter_files(data_dir: Path, excludes: set[str]):
    """产出 (绝对路径, 相对 data_dir 的 posix 路径, 字节数),跳过排除的顶层目录。"""
    for p in data_dir.rglob("*"):
        if not p.is_file():
            continue
        rel = p.relative_to(data_dir)
        if rel.parts and rel.parts[0] in excludes:
            continue
        try:
            size = p.stat().st_size
        except OSError:
            continue
        yield p, rel.as_posix(), size


# ----------------------------------------------------------------------------- create
def cmd_create(args) -> int:
    data_dir = config.DATA_DIR
    if not data_dir.exists():
        print(f"✗ 数据目录不存在:{data_dir}")
        return 1

    excludes: set[str] = set() if args.include_cache else set(DEFAULT_EXCLUDES)
    out_dir = resolve_backup_dir(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)

    ts = datetime.now()
    name = args.name or f"{ARCHIVE_PREFIX}{ts.strftime('%Y%m%d-%H%M%S')}.zip"
    if not name.endswith(".zip"):
        name += ".zip"
    out_path = out_dir / name

    print(f"→ 扫描 {data_dir} …")
    files = list(_iter_files(data_dir, excludes))
    total = sum(sz for _, _, sz in files)
    servers = (
        sorted(d.name for d in config.SERVERS_ROOT.glob("*") if d.is_dir())
        if config.SERVERS_ROOT.exists()
        else []
    )
    excl_note = f"(已排除:{', '.join(sorted(excludes))})" if excludes else ""
    print(f"  {len(files)} 个文件,共 {_human(total)} {excl_note}")
    if not files:
        print("✗ 没有可备份的内容,已中止。")
        return 1

    manifest = {
        "tool": "mcpanel-backup",
        "version": 1,
        "created_at": ts.isoformat(timespec="seconds"),
        "created_ts": int(ts.timestamp()),
        "hostname": platform.node() or socket.gethostname(),
        "platform": platform.platform(),
        "data_dir": str(data_dir),
        "excluded": sorted(excludes),
        "servers": servers,
        "file_count": len(files),
        "total_bytes": total,
    }

    tmp_path = out_path.with_name(out_path.name + ".part")
    done = 0
    t0 = time.time()
    try:
        with zipfile.ZipFile(
            tmp_path, "w", zipfile.ZIP_DEFLATED, compresslevel=1, allowZip64=True
        ) as zf:
            zf.writestr(MANIFEST_NAME, json.dumps(manifest, ensure_ascii=False, indent=2))
            for p, rel, sz in files:
                zf.write(p, f"{DATA_ARCNAME}/{rel}")
                done += sz
                _progress("打包中", done, total, t0)
        sys.stdout.write("\n")
        tmp_path.replace(out_path)
    except BaseException:
        tmp_path.unlink(missing_ok=True)
        raise

    size = out_path.stat().st_size
    print(f"✓ 备份完成:{out_path}")
    print(f"  压缩后 {_human(size)} | 实例 {len(servers)} 个 | 用时 {time.time() - t0:.0f}s")
    print(f'  换电脑:把这个 .zip 拷到新机器,跑  uv run python backup.py restore "{out_path.name}"')
    return 0


# ------------------------------------------------------------------------------- list
def cmd_list(args) -> int:
    out_dir = resolve_backup_dir(args.out)
    if not out_dir.exists():
        print(f"(备份目录不存在:{out_dir})")
        return 0
    zips = sorted(out_dir.glob("*.zip"))
    if not zips:
        print(f"(还没有备份:{out_dir})")
        return 0

    print(f"备份目录:{out_dir}\n")
    for z in zips:
        info = _read_manifest(z)
        size = _human(z.stat().st_size)
        if info:
            excl = info.get("excluded") or []
            print(f"  {z.name}")
            print(
                f"    时间 {info.get('created_at', '?')} | 大小 {size} | "
                f"实例 {len(info.get('servers', []))} 个 | 来源 {info.get('hostname', '?')}"
                + (f" | 已排除 {','.join(excl)}" if excl else "")
            )
        else:
            print(f"  {z.name}  (大小 {size};非本工具备份或缺 {MANIFEST_NAME})")
    return 0


# ---------------------------------------------------------------------------- restore
def cmd_restore(args) -> int:
    archive = Path(args.archive).expanduser()
    # 给的路径不存在时,把它当文件名,到备份目录里找
    if not archive.exists():
        cand = resolve_backup_dir(args.out) / archive.name
        if cand.exists():
            archive = cand
    archive = archive.resolve()
    if not archive.exists():
        print(f"✗ 找不到备份文件:{archive}")
        return 1

    info = _read_manifest(archive)
    if info is None:
        print(f"✗ 这不是 mc-panel 备份(缺 {MANIFEST_NAME}),拒绝恢复:{archive}")
        return 1

    data_dir = config.DATA_DIR
    print(f"准备恢复:{archive.name}")
    print(
        f"  备份时间 {info.get('created_at', '?')} | 实例 {len(info.get('servers', []))} 个 | "
        f"来源 {info.get('hostname', '?')}"
    )
    print(f"  目标数据目录:{data_dir}")

    # 面板可能在跑 —— 占用 db/secret 会导致恢复失败或脏数据
    if _port_in_use(config.API_PORT):
        print(f"⚠ 端口 {config.API_PORT} 被占用,面板可能正在运行。请先停止面板与所有实例再恢复。")
        if not args.yes:
            return 1

    data_nonempty = data_dir.exists() and any(data_dir.iterdir())
    if data_nonempty:
        print("⚠ 目标 data/ 非空,恢复会用备份内容替换它。")
        if not args.yes:
            ans = input("  确认继续?[y/N] ").strip().lower()
            if ans not in ("y", "yes"):
                print("已取消。")
                return 1

    # 先把旧 data 原子改名留底
    if data_nonempty and not args.no_backup_old:
        bak = data_dir.with_name(data_dir.name + ".bak-" + datetime.now().strftime("%Y%m%d-%H%M%S"))
        data_dir.replace(bak)
        print(f"  旧 data/ 已留底为:{bak}")
    elif data_nonempty and args.no_backup_old:
        shutil.rmtree(data_dir)
    data_dir.mkdir(parents=True, exist_ok=True)

    data_root = data_dir.resolve()
    prefix = f"{DATA_ARCNAME}/"
    with zipfile.ZipFile(archive) as zf:
        members = [m for m in zf.infolist() if m.filename.startswith(prefix) and not m.is_dir()]
        total = sum(m.file_size for m in members)
        done = 0
        t0 = time.time()
        for m in members:
            rel = m.filename[len(prefix):]
            dest = (data_dir / rel).resolve()
            # 防 zip-slip:解包目标必须仍在 data_dir 内
            if dest != data_root and data_root not in dest.parents:
                raise ValueError(f"非法的归档路径:{m.filename}")
            dest.parent.mkdir(parents=True, exist_ok=True)
            with zf.open(m) as src, open(dest, "wb") as out:
                shutil.copyfileobj(src, out)
            done += m.file_size
            _progress("解包中", done, total, t0)
    sys.stdout.write("\n")
    print(f"✓ 恢复完成 → {data_dir}")
    print("  现在可以启动面板:uv run python run.py")
    return 0


def main() -> None:
    ap = argparse.ArgumentParser(prog="backup.py", description="mc-panel data/ 备份与恢复")
    sub = ap.add_subparsers(dest="cmd", required=True)

    c = sub.add_parser("create", help="创建一个 data/ 备份")
    c.add_argument("--out", help="备份输出目录(默认 ../mc-panel-backups 或 $MCPANEL_BACKUP_DIR)")
    c.add_argument("--name", help="备份文件名(默认按时间生成)")
    c.add_argument("--include-cache", action="store_true", help="连 jar 缓存(data/jar_cache)一起打包")
    c.set_defaults(func=cmd_create)

    ls = sub.add_parser("list", help="列出已有备份")
    ls.add_argument("--out", help="备份目录(同 create)")
    ls.set_defaults(func=cmd_list)

    r = sub.add_parser("restore", help="从备份恢复 data/")
    r.add_argument("archive", help="备份文件路径,或只给文件名(到备份目录里找)")
    r.add_argument("--out", help="只给文件名时,从该目录里找备份")
    r.add_argument("-y", "--yes", action="store_true", help="跳过所有确认")
    r.add_argument("--no-backup-old", action="store_true", help="恢复前不保留旧 data 的副本(直接删)")
    r.set_defaults(func=cmd_restore)

    args = ap.parse_args()
    raise SystemExit(args.func(args))


if __name__ == "__main__":
    main()
