"""工具:超平坦世界生成器(生成 level.dat,格式按服务器 MC 版本决定)。"""
from __future__ import annotations

import shutil

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from .. import archive_manager as am
from .. import superflat
from ..database import get_db
from ..deps import require_auth
from ..mcdr import manager as mcdr_manager
from ..models import Server

router = APIRouter(prefix="/tools", tags=["tools"])


class Layer(BaseModel):
    block: str = Field(min_length=1)
    height: int = Field(ge=1)


class SuperflatApply(BaseModel):
    server_id: int
    layers: list[Layer]
    biome: str = "minecraft:plains"
    structures: list[str] = []
    overwrite: bool = False


@router.post("/superflat/apply")
def superflat_apply(
    body: SuperflatApply, _: str = Depends(require_auth), db: Session = Depends(get_db)
) -> dict:
    server = db.get(Server, body.server_id)
    if server is None:
        raise HTTPException(status_code=404, detail="服务器不存在")
    if not body.layers:
        raise HTTPException(status_code=400, detail="至少需要一层")

    inst = mcdr_manager.instance_dir(server)
    wdir = am.world_dir(inst)
    world_exists = wdir.exists()
    if world_exists and not body.overwrite:
        raise HTTPException(status_code=400, detail="世界已存在,勾选「重置世界」以覆盖")
    if body.overwrite and mcdr_manager.get_status(server) in ("running", "installing"):
        raise HTTPException(status_code=400, detail="重置世界需先停止实例")

    try:
        data = superflat.build_level_dat(
            server.mc_version,
            [ly.model_dump() for ly in body.layers],
            body.biome,
            body.structures,
        )
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=400, detail=f"生成 level.dat 失败: {exc}")

    if world_exists and body.overwrite:
        shutil.rmtree(wdir, ignore_errors=True)
    wdir.mkdir(parents=True, exist_ok=True)
    (wdir / "level.dat").write_bytes(data)

    return {
        "data_version": superflat.data_version_for(server.mc_version),
        "format": superflat.format_name(server.mc_version),
        "mc_version": server.mc_version,
    }
