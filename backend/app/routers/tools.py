"""工具:超平坦世界生成器(写入 server.properties)。"""
from __future__ import annotations

import json
import shutil

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from .. import archive_manager as am
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


def build_generator_settings(layers: list[Layer], biome: str, structures: list[str]) -> str:
    settings: dict = {
        "layers": [{"block": ly.block, "height": ly.height} for ly in layers],
        "biome": biome,
    }
    if structures:
        settings["structure_overrides"] = structures
    return json.dumps(settings, separators=(",", ":"), ensure_ascii=False)


@router.post("/superflat/apply")
def superflat_apply(
    body: SuperflatApply, _: str = Depends(require_auth), db: Session = Depends(get_db)
) -> dict:
    server = db.get(Server, body.server_id)
    if server is None:
        raise HTTPException(status_code=404, detail="服务器不存在")
    if not body.layers:
        raise HTTPException(status_code=400, detail="至少需要一层")
    if body.overwrite and mcdr_manager.get_status(server) in ("running", "installing"):
        raise HTTPException(status_code=400, detail="重置世界需先停止实例")

    gen = build_generator_settings(body.layers, body.biome, body.structures)
    mcdr_manager.write_properties(
        server, {"level-type": "minecraft:flat", "generator-settings": gen}
    )
    if body.overwrite:
        wdir = am.world_dir(mcdr_manager.instance_dir(server))
        if wdir.exists():
            shutil.rmtree(wdir, ignore_errors=True)
    return {"generator_settings": gen, "overwritten": body.overwrite}
