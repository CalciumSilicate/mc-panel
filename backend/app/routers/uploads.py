import asyncio
from typing import Literal

from fastapi import APIRouter, BackgroundTasks, Depends, Header, HTTPException, Request
from pydantic import BaseModel, Field, model_validator

from .. import uploads
from ..deps import require_admin
from ..models import User

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
        if self.kind == "package" and self.options is None:
            raise ValueError("缺少导入参数")
        return self


@router.post("", status_code=201)
def create(body: CreateUpload, user: User = Depends(require_admin)):
    return uploads.create(body.model_dump(), user.id)


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
