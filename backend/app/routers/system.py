"""仪表盘:宿主机资源占用 + 服务器概览。"""
from __future__ import annotations

import psutil
from fastapi import APIRouter, Depends
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..database import get_db
from ..deps import require_auth
from ..mcdr import STATUS_RUNNING, manager
from ..models import Server
from ..schemas import DashboardOverview, ResourceUsage, ServerSummary

router = APIRouter(prefix="/system", tags=["system"])

_GB = 1024 ** 3


@router.get("/overview", response_model=DashboardOverview)
def overview(
    _: str = Depends(require_auth), db: Session = Depends(get_db)
) -> DashboardOverview:
    vm = psutil.virtual_memory()
    du = psutil.disk_usage("/")

    servers = db.scalars(select(Server).order_by(Server.id)).all()
    summaries: list[ServerSummary] = []
    running = 0
    for s in servers:
        summary = ServerSummary.model_validate(s)
        summary.status = manager.get_status(s)
        if summary.status == STATUS_RUNNING:
            running += 1
        summaries.append(summary)

    return DashboardOverview(
        cpu_percent=psutil.cpu_percent(interval=None),
        memory=ResourceUsage(
            used_gb=round(vm.used / _GB, 2),
            total_gb=round(vm.total / _GB, 2),
            percent=vm.percent,
        ),
        disk=ResourceUsage(
            used_gb=round(du.used / _GB, 2),
            total_gb=round(du.total / _GB, 2),
            percent=du.percent,
        ),
        total_servers=len(summaries),
        running_servers=running,
        servers=summaries,
    )
