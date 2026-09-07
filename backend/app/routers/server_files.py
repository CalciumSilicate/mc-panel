"""Admin-only existing instance file browsing and editing."""
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from .. import server_files
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
