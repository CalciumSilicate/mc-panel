"""Admin-only existing instance file browsing and editing."""
from typing import Literal

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from .. import jobs, server_files
from ..database import get_db
from ..deps import ensure_not_protected, require_admin
from ..models import Server

router = APIRouter(prefix="/servers/{server_id}/files", tags=["server-files"],
                   dependencies=[Depends(require_admin)])


def _server(server_id: int, db: Session = Depends(get_db)) -> Server:
    server = db.get(Server, server_id)
    if server is None:
        raise HTTPException(status_code=404, detail="服务器不存在")
    return server


class SaveBody(BaseModel):
    path: str
    text: str = Field(max_length=server_files.MAX_BYTES)
    revision: str = Field(pattern=r"^[0-9a-f]{64}$")


class EntryBody(BaseModel):
    path: str = Field(min_length=1, max_length=2048)
    revision: str = Field(pattern=r"^[0-9a-f]{64}$")


class RenameBody(EntryBody):
    name: str = Field(min_length=1, max_length=240)


class CreateBody(BaseModel):
    directory: str = Field(default="", max_length=2048)
    name: str = Field(min_length=1, max_length=240)
    kind: Literal["file", "directory"]


@router.post("/entry", status_code=201)
def create_entry(body: CreateBody, server: Server = Depends(_server)) -> dict:
    return server_files.create_entry(server, body.directory, body.name, body.kind)


@router.get("")
def list_files(path: str = "", server: Server = Depends(_server)) -> dict:
    return server_files.list_directory(server, path)


@router.get("/content")
def get_content(path: str, server: Server = Depends(_server)) -> dict:
    return server_files.read_content(server, path)


@router.put("/content")
def put_content(body: SaveBody, server: Server = Depends(_server)) -> dict:
    ensure_not_protected(server)
    return server_files.save_content(server, body.path, body.text, body.revision)


@router.patch("/entry")
def rename_entry(body: RenameBody, server: Server = Depends(_server)) -> dict:
    return server_files.rename_entry(server, body.path, body.name, body.revision)


@router.delete("/entry", status_code=202)
def delete_entry(body: EntryBody, background: BackgroundTasks, server: Server = Depends(_server)) -> dict:
    ensure_not_protected(server)
    job_id = jobs.create()
    try:
        target = server_files.detach_entry(server, body.path, body.revision, job_id)
    except Exception:
        jobs.fail(job_id, "删除未执行")
        raise
    background.add_task(server_files.clean_detached, target, job_id)
    return {"job_id": job_id}
