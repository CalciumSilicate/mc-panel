"""Export a stopped instance to a portable ZIP, without executing its files."""
import json
import os
from pathlib import Path
import shutil
import threading
import zipfile

from fastapi import HTTPException

from .server_files import _check, _parts, _root
from .server_import import MAX_ENTRIES, MAX_EXPANDED
from .server_transfer import walk_error


def export_server(server, target: Path, report):
    from . import server_files
    key=str(_root(server))
    with server_files._locks_guard:
        lock=server_files._locks.setdefault(key,threading.Lock())
    with lock:
        _export_server(server,target,report)


def _export_server(server, target: Path, report):
    root=_root(server)
    entries=[]
    total=0
    for directory, dirs, files in os.walk(root,followlinks=False,onerror=walk_error):
        for name in dirs+files:
            path=Path(directory)/name
            kind=_check(path.lstat())
            relative=path.relative_to(root).as_posix()
            _parts(relative)
            if relative in ('.installing','.install_failed','mc-panel-export.json'):continue
            info=path.stat()
            size=info.st_size if kind=='file' else 0
            total+=size
            entries.append((path,relative,kind,size,info.st_mtime_ns))
            if len(entries)>MAX_ENTRIES or total>MAX_EXPANDED:
                raise HTTPException(413,'实例超过导出限制（80 GiB / 100000 个文件）')
    if total>shutil.disk_usage(target.parent).free-8*1024**2:
        raise HTTPException(413,'磁盘空间不足，无法生成导出包')
    done=0
    with zipfile.ZipFile(target,'w',compression=zipfile.ZIP_DEFLATED,compresslevel=1,allowZip64=True) as archive:
        for path,relative,kind,size,modified in entries:
            if _check(path.lstat())!=kind:raise HTTPException(409,'导出时文件发生变化，请重试')
            if kind=='directory':
                archive.write(path,relative+'/')
                continue
            info=zipfile.ZipInfo.from_file(path,relative)
            info.compress_type=zipfile.ZIP_DEFLATED
            with path.open('rb') as source, archive.open(info,'w',force_zip64=True) as output:
                shutil.copyfileobj(source,output,length=1024*1024)
            if path.stat().st_size!=size or path.stat().st_mtime_ns!=modified:
                raise HTTPException(409,'导出时文件发生变化，请停止外部程序后重试')
            done+=size;report('打包服务器',done,total)
        metadata={k:getattr(server,k) for k in ('name','server_type','mc_version','loader_version','min_memory','max_memory','port','extra_jvm_args','startup_commands')}
        archive.writestr('mc-panel-export.json',json.dumps(metadata,ensure_ascii=False))
