"""Local directory copies and bounded remote package downloads for admins."""
from __future__ import annotations

import os
from pathlib import Path
import shutil
from urllib.parse import unquote, urlsplit

import httpx
import psutil
from fastapi import HTTPException

from .config import DATA_DIR, SERVERS_ROOT
from .server_files import _check, _parts
from .server_import import MAX_ENTRIES, MAX_EXPANDED, PACKAGE_EXTENSIONS


def walk_error(error):
    raise HTTPException(403, '存在无法读取的子目录，未完成复制或打包') from error


def local_directory(path: str) -> Path:
    if not Path(path).is_absolute():
        raise HTTPException(400, '请选择绝对路径')
    root = Path(os.path.abspath(path))
    try:
        for part in reversed((root, *root.parents)):
            if _check(part.lstat()) != 'directory':
                raise HTTPException(400, '路径不是目录')
    except OSError as exc:
        raise HTTPException(400, '目录不存在或没有访问权限') from exc
    return root


def browse(path: str = '') -> dict:
    if not path:
        roots = [Path(f'{chr(i)}:/') for i in range(65,91)] if os.name=='nt' else [Path('/')]
        return dict(path='', parent=None, directories=[dict(name=str(p), path=str(p)) for p in roots if p.is_dir()])
    root = local_directory(path)
    entries = []
    try:
        for child in root.iterdir():
            try:
                if _check(child.lstat())=='directory': entries.append(dict(name=child.name, path=str(child)))
            except (OSError, HTTPException):
                continue
            if len(entries)>5000: raise HTTPException(400, '目录过多，请输入更具体的路径')
    except PermissionError as exc:
        raise HTTPException(403, '没有访问此目录的权限') from exc
    return dict(path=str(root), parent=str(root.parent) if root.parent!=root else '', directories=sorted(entries,key=lambda d:d['name'].casefold()))


def copy_local(path: str, target: Path, report):
    root = local_directory(path)
    resolved = root.resolve()
    # Do not recursively ingest panel data/staging or another managed instance.
    if DATA_DIR.resolve().is_relative_to(resolved) or resolved.is_relative_to((DATA_DIR/'uploads').resolve()) or resolved.is_relative_to(SERVERS_ROOT.resolve()):
        raise HTTPException(400, '请选择面板数据目录以外的服务器文件夹')
    for process in psutil.process_iter(['name']):
        if any(name in (process.info['name'] or '').lower() for name in ('java','python','mcdreforged')):
            try:
                if Path(process.cwd()).resolve().is_relative_to(resolved):
                    raise HTTPException(409, '源目录中仍有服务器进程，请停止后再导入')
            except (psutil.Error, OSError): pass
    files, total = [], 0
    for directory, dirs, names in os.walk(root, followlinks=False, onerror=walk_error):
        for name in dirs+names:
            source = Path(directory)/name
            kind = _check(source.lstat())
            relative = source.relative_to(root)
            _parts(relative.as_posix())
            size = source.stat().st_size if kind=='file' else 0
            total += size
            files.append((source,relative,kind,size,source.stat().st_mtime_ns))
            if len(files)>MAX_ENTRIES or total>MAX_EXPANDED:
                raise HTTPException(413,'服务器文件夹超过大小或文件数量限制')
    if total > shutil.disk_usage(target.parent).free - 8*1024**2:
        raise HTTPException(413,'磁盘空间不足')
    target.mkdir()
    done=0
    for source,relative,kind,size,modified in files:
        dest=target/relative
        if _check(source.lstat())!=kind:raise HTTPException(409,'源文件夹正在变化，请停止服务器后重试')
        if kind=='directory':dest.mkdir(parents=True,exist_ok=True);continue
        dest.parent.mkdir(parents=True,exist_ok=True)
        shutil.copy2(source,dest)
        if source.stat().st_size!=size or source.stat().st_mtime_ns!=modified or dest.stat().st_size!=size:
            raise HTTPException(409,'源文件正在变化，请停止服务器后重试')
        done+=size;report('复制服务器文件',done,total)


def url_name(url: str) -> str:
    parsed=urlsplit(url)
    if parsed.scheme not in ('http','https') or not parsed.hostname or parsed.username or parsed.password:
        raise HTTPException(400,'请输入 HTTP 或 HTTPS 下载直链')
    name=unquote(parsed.path.rsplit('/',1)[-1])
    if not any(name.lower().endswith(ext) for ext in PACKAGE_EXTENSIONS):
        name='server.zip'  # Signed/API downloads may not have a filename; detect by content.
    _parts(name)
    return name


def download(url: str, target: Path, report) -> None:
    from .uploads import MAX_BYTES
    from .net import get_proxy
    url_name(url)
    done=0
    with httpx.Client(proxy=get_proxy(),timeout=httpx.Timeout(30,read=60),follow_redirects=True,max_redirects=5) as client:
        with client.stream('GET',url,headers={'Accept-Encoding':'identity'}) as response:
            response.raise_for_status()
            total=int(response.headers.get('content-length','0'))
            if total>MAX_BYTES:raise HTTPException(413,'下载包超过 20 GiB')
            with target.open('wb') as out:
                for chunk in response.iter_bytes(1024*1024):
                    done+=len(chunk)
                    if done>MAX_BYTES or len(chunk)>shutil.disk_usage(target.parent).free-8*1024**2:
                        raise HTTPException(413,'下载超过限制或磁盘空间不足')
                    out.write(chunk);report('下载服务器包',done,total)
            if total and total!=done:raise HTTPException(400,'下载不完整，请重试')
