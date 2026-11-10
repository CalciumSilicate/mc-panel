import asyncio
from typing import Literal

from fastapi import APIRouter, BackgroundTasks, Depends, Header, HTTPException, Request
from fastapi.responses import FileResponse
from sqlalchemy.orm import Session
from pydantic import BaseModel, Field, model_validator

from .. import uploads
from ..deps import require_admin
from ..models import User, Server
from ..database import get_db

router = APIRouter(prefix="/uploads", tags=["uploads"])


class ImportOptions(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    server_type: Literal["vanilla", "fabric", "forge", "velocity"] = "vanilla"
    mc_version: str = Field(default="", max_length=64)
    port: int = Field(ge=1, le=65535)
    min_memory: str = Field(default="1G", pattern=r"^[1-9][0-9]*[MGmg]$")
    max_memory: str = Field(default="2G", pattern=r"^[1-9][0-9]*[MGmg]$")
    launch_jar: str = Field(default="", max_length=512)

    @model_validator(mode="after")
    def validate_options(self):
        self.name = self.name.strip()
        if not self.name:
            raise ValueError("请输入实例名称")
        def mb(value):
            return int(value[:-1]) * (1024 if value[-1].lower() == "g" else 1)
        if mb(self.min_memory) > mb(self.max_memory):
            raise ValueError("最小内存不能大于最大内存")
        return self


class CreateUpload(BaseModel):
    kind: Literal["file", "package"]
    name: str = Field(min_length=1, max_length=240)
    size: int = Field(ge=0, le=uploads.MAX_BYTES)
    server_id: int | None = None
    directory: str = Field(default="", max_length=2048)
    overwrite: bool = False
    options: ImportOptions | None = None

    @model_validator(mode="after")
    def required_target(self):
        if self.kind == "file" and self.server_id is None:
            raise ValueError("缺少目标实例")
        return self


@router.post("", status_code=201)
def create(body: CreateUpload, user: User = Depends(require_admin)):
    return uploads.create(body.model_dump(), user.id)


class ImportSource(BaseModel):
    source: Literal['url', 'local']
    path: str = Field(default='',max_length=4096)
    url: str = Field(default='',max_length=8192)


@router.get('/local-directories')
def local_directories(path: str = '', _: User = Depends(require_admin)):
    from ..server_transfer import browse
    return browse(path)


@router.post('/import',status_code=202)
async def import_source(body: ImportSource, user: User = Depends(require_admin)):
    from ..server_transfer import local_directory, url_name
    if body.source=='local':
        root=await asyncio.to_thread(local_directory,body.path.strip())
        name='server.zip'
        path=str(root)
    else:
        name=url_name(body.url.strip())
        path=''
    state=uploads.create(dict(kind='package',name=name,size=0,options=None,source=body.source,source_path=path,source_url=body.url.strip()),user.id)
    return uploads.complete(state['id'],user.id)


@router.post('/export/{server_id}',status_code=202)
async def export_server(server_id: int,user: User = Depends(require_admin),db: Session = Depends(get_db)):
    from ..mcdr import manager
    server=db.get(Server,server_id)
    if server is None:raise HTTPException(404,'服务器不存在')
    if manager.get_status(server) not in ('stopped','error','new_setup') or manager.is_running(server_id) or manager.lifecycle_lock(server_id).locked():
        raise HTTPException(409,'请先停止服务器再整包导出')
    db.expunge(server)
    return uploads.export(server,user.id)


@router.post('/{uid}/download-link')
def download_link(uid: str,user: User = Depends(require_admin)):
    import secrets
    import time
    with uploads._guard:
        state=uploads.owned(uid,user.id)
        if state['kind']!='export' or state['status']!='done':raise HTTPException(409,'导出尚未完成')
        ticket=secrets.token_urlsafe(32)
        state.update(download_ticket=ticket,download_expires=time.time()+120)
        uploads.save(state)
    return {'url':f'/api/uploads/{uid}/download?ticket={ticket}'}


@router.get('/{uid}/download')
def download_export(uid: str,ticket: str):
    import hmac
    import time
    state=uploads.read(uid)
    if state.get('kind')!='export' or state['status']!='done' or time.time()>state.get('download_expires',0) or not hmac.compare_digest(ticket,state.get('download_ticket','')):
        raise HTTPException(403,'下载链接已失效，请重新下载')
    return FileResponse(uploads.folder(uid)/'export.zip',filename=state['name'],media_type='application/zip')


@router.get("/{uid}")
def status(uid: str, user: User = Depends(require_admin)):
    return uploads.public(uploads.owned(uid, user.id))


@router.put("/{uid}/chunks")
async def chunk(uid: str, offset: int, request: Request,
                x_chunk_sha256: str = Header(default="", pattern=r"^([0-9a-f]{64})?$"),
                user: User = Depends(require_admin)):
    uploads.owned(uid, user.id)
    content = bytearray()
    async for part in request.stream():
        content.extend(part)
        if len(content) > uploads.CHUNK_BYTES:
            raise HTTPException(413, "分片超过 4 MiB")
    return await asyncio.to_thread(uploads.append, uid, user.id, offset, bytes(content), x_chunk_sha256)


@router.post("/{uid}/complete", status_code=202)
async def complete(uid: str, user: User = Depends(require_admin)):
    return uploads.complete(uid, user.id)


@router.delete("/{uid}")
def discard(uid: str, background: BackgroundTasks, user: User = Depends(require_admin)):
    trash = uploads.discard(uid, user.id)
    background.add_task(uploads.delete_trash, trash)
    return {"ok": True}
