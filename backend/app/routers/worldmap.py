"""世界地图接口。"""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import FileResponse
from sqlalchemy import select
from sqlalchemy.orm import Session

from .. import basemap, worldmap
from ..database import get_db
from ..deps import require_admin, require_auth
from ..mcdr import manager
from ..models import MapMarker, Server
from ..schemas import MarkerCreate, MarkerOut, MarkerUpdate

router = APIRouter(prefix="/map", tags=["worldmap"])


def _server(db: Session, server_id: int) -> Server:
    s = db.get(Server, server_id)
    if s is None:
        raise HTTPException(status_code=404, detail="服务器不存在")
    return s


@router.get("/{server_id}/players")
def map_players(server_id: int, _: object = Depends(require_auth), db: Session = Depends(get_db)) -> dict:
    s = _server(db, server_id)
    return {
        "players": worldmap.players(db, server_id),
        "scanned_at": worldmap.scanned_at(server_id),
        "rcon_enabled": bool(s.rcon_enabled),
        "running": manager.is_running(server_id),
    }


@router.get("/{server_id}/positions")
def map_positions(
    server_id: int,
    uuids: str = Query("", description="逗号分隔的 uuid;空=全部"),
    dim: str = Query("minecraft:overworld"),
    hours: int = Query(168),
    _: object = Depends(require_auth),
    db: Session = Depends(get_db),
) -> dict:
    _server(db, server_id)
    ids = [u for u in uuids.split(",") if u]
    return {"tracks": worldmap.positions(db, server_id, ids, dim, hours)}


@router.post("/{server_id}/refresh")
async def refresh(server_id: int, _: object = Depends(require_auth), db: Session = Depends(get_db)) -> dict:
    server = _server(db, server_id)
    if not server.rcon_enabled:
        raise HTTPException(status_code=400, detail="该实例未启用 RCON,无法采集位置")
    await worldmap.scan_server_async(server)
    return {"scanned_at": worldmap.scanned_at(server_id)}


# ---------- 自定义地标 POI ----------
def _get_marker(db: Session, server_id: int, marker_id: int) -> MapMarker:
    m = db.get(MapMarker, marker_id)
    if m is None or m.server_id != server_id:
        raise HTTPException(status_code=404, detail="地标不存在")
    return m


@router.get("/{server_id}/markers")
def list_markers(
    server_id: int,
    dim: str = Query("", description="按维度过滤;空=全部"),
    _: object = Depends(require_auth),
    db: Session = Depends(get_db),
) -> dict:
    _server(db, server_id)
    q = select(MapMarker).where(MapMarker.server_id == server_id)
    if dim:
        q = q.where(MapMarker.dim == dim)
    rows = db.scalars(q.order_by(MapMarker.id)).all()
    return {"markers": [MarkerOut.model_validate(m) for m in rows]}


@router.post("/{server_id}/markers", response_model=MarkerOut)
def create_marker(
    server_id: int,
    payload: MarkerCreate,
    _: str = Depends(require_admin),
    db: Session = Depends(get_db),
) -> MarkerOut:
    _server(db, server_id)
    m = MapMarker(
        server_id=server_id, dim=payload.dim, name=payload.name,
        x=payload.x, y=payload.y, z=payload.z, icon=payload.icon, color=payload.color,
    )
    db.add(m)
    db.commit()
    db.refresh(m)
    return MarkerOut.model_validate(m)


@router.patch("/{server_id}/markers/{marker_id}", response_model=MarkerOut)
def update_marker(
    server_id: int,
    marker_id: int,
    payload: MarkerUpdate,
    _: str = Depends(require_admin),
    db: Session = Depends(get_db),
) -> MarkerOut:
    _server(db, server_id)
    m = _get_marker(db, server_id, marker_id)
    for field in ("name", "x", "y", "z", "icon", "color"):
        value = getattr(payload, field)
        if value is not None:
            setattr(m, field, value)
    db.commit()
    db.refresh(m)
    return MarkerOut.model_validate(m)


@router.delete("/{server_id}/markers/{marker_id}")
def delete_marker(
    server_id: int,
    marker_id: int,
    _: str = Depends(require_admin),
    db: Session = Depends(get_db),
) -> dict:
    _server(db, server_id)
    m = _get_marker(db, server_id, marker_id)
    db.delete(m)
    db.commit()
    return {"ok": True}


# ---------- 真实地形底图(unmined 渲染 → 前端 canvas 底图)----------
_MC_TYPES = ("vanilla", "fabric", "forge")
_DIM_IDS = ("overworld", "nether", "the_end")


@router.post("/{server_id}/basemap/render")
async def basemap_render(
    server_id: int,
    _: str = Depends(require_admin),
    db: Session = Depends(get_db),
) -> dict:
    server = _server(db, server_id)
    if server.server_type not in _MC_TYPES:
        raise HTTPException(status_code=400, detail="仅 Minecraft 实例支持底图渲染")
    basemap.render_bg(server_id)
    return basemap.status(server_id)


@router.get("/{server_id}/basemap/status")
def basemap_status(
    server_id: int,
    _: object = Depends(require_auth),
    db: Session = Depends(get_db),
) -> dict:
    _server(db, server_id)
    return basemap.status(server_id)


@router.get("/{server_id}/basemap/{dim}/meta")
def basemap_meta(
    server_id: int,
    dim: str,
    _: object = Depends(require_auth),
    db: Session = Depends(get_db),
) -> dict:
    if dim not in _DIM_IDS:
        raise HTTPException(status_code=404, detail="维度不存在")
    server = _server(db, server_id)
    mp = basemap.meta_path(server, dim)
    if not mp.is_file():
        return {"available": False}
    import json as _json

    data = _json.loads(mp.read_text(encoding="utf-8"))
    data["available"] = True
    return data


@router.get("/{server_id}/basemap/{dim}/image.png")
def basemap_image(server_id: int, dim: str, db: Session = Depends(get_db)):
    """托管底图 PNG 供 <img> 加载(不鉴权:img 请求不带 token;仅只读地形图)。"""
    if dim not in _DIM_IDS:
        raise HTTPException(status_code=404, detail="维度不存在")
    server = _server(db, server_id)
    p = basemap.png_path(server, dim)
    if not p.is_file():
        raise HTTPException(status_code=404, detail="尚未渲染")
    return FileResponse(p, media_type="image/png")
