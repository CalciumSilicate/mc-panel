"""仪表盘:宿主机资源占用 + 服务器概览。"""
from __future__ import annotations

from datetime import datetime, timezone
import time
from typing import Annotated

import psutil
from fastapi import APIRouter, Depends, Query
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from .. import host_metrics
from ..config import DATA_DIR
from ..database import get_db
from ..deps import require_auth
from ..mcdr import STATUS_RUNNING, manager
from ..models import Archive, Server, ServerGroup
from ..schemas import DashboardArchive, DashboardOverview, InstallProgress, ResourceUsage, ServerSummary

router = APIRouter(prefix="/system", tags=["system"])

_GB = 1024 ** 3


@router.get("/overview", response_model=DashboardOverview)
def overview(
    _: str = Depends(require_auth), db: Session = Depends(get_db),
    history_minutes: Annotated[int, Query(ge=1, le=1440)] = 5,
) -> DashboardOverview:
    vm = psutil.virtual_memory()
    du = psutil.disk_usage(str(DATA_DIR))

    servers = db.scalars(select(Server).order_by(Server.id)).all()
    group_names = {g.id: g.name for g in db.scalars(select(ServerGroup)).all()}
    summaries: list[ServerSummary] = []
    running = 0
    for s in servers:
        summary = ServerSummary.model_validate(s)
        summary.group_name = group_names.get(s.group_id, "")
        summary.status = manager.get_status(s)
        summary.needs_restart = manager.needs_restart(s.id)
        if summary.status == STATUS_RUNNING:
            running += 1
        if summary.status == "installing":
            prog = manager.install_progress(s.id)
            if prog is not None:
                downloaded, total = prog
                summary.install = InstallProgress(
                    downloaded=downloaded,
                    total=total,
                    percent=round(downloaded / total * 100, 1) if total else 0.0,
                )
        summaries.append(summary)

    archive_count, archive_bytes = db.execute(
        select(func.count(Archive.id), func.coalesce(func.sum(Archive.size), 0))
    ).one()
    recent_archives = db.scalars(
        select(Archive).order_by(Archive.created_at.desc(), Archive.id.desc()).limit(5)
    ).all()
    history, history_interval = host_metrics.history(db, history_minutes)

    return DashboardOverview(
        # A short sample avoids the first-call zero when the request moves to a
        # different FastAPI worker thread. This endpoint runs in the thread pool.
        cpu_percent=psutil.cpu_percent(interval=0.1),
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
        sampled_at=datetime.now(timezone.utc),
        cpu_threads=psutil.cpu_count() or 1,
        host_uptime_seconds=max(0, int(time.time() - psutil.boot_time())),
        available_memory_gb=round(vm.available / _GB, 2),
        free_disk_gb=round(du.free / _GB, 2),
        archive_count=archive_count,
        archive_bytes=archive_bytes,
        recent_archives=[DashboardArchive.model_validate(a) for a in recent_archives],
        history=history,
        history_interval_seconds=history_interval,
    )
