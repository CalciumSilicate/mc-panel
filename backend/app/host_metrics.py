"""Five-second host sampling with 24-hour SQLite retention."""
from __future__ import annotations

import asyncio
import logging
import time

import psutil
from sqlalchemy import Integer, cast, delete, func, select
from sqlalchemy.orm import Session

from .database import SessionLocal
from .models import HostResourceSample

SAMPLE_SECONDS = 5
RETENTION_SECONDS = 24 * 60 * 60
logger = logging.getLogger(__name__)


def collect() -> None:
    # Sampling in one to_thread call avoids psutil's per-thread first-call zero.
    cpu = psutil.cpu_percent(interval=0.1)
    memory = psutil.virtual_memory().percent
    now = time.time()
    with SessionLocal() as db:
        db.add(HostResourceSample(recorded_at=now, cpu_percent=cpu, memory_percent=memory))
        db.execute(delete(HostResourceSample).where(
            HostResourceSample.recorded_at < now - RETENTION_SECONDS
        ))
        db.commit()


def history(db: Session, minutes: int) -> tuple[list[dict], int]:
    # At most ~360 buckets for any range; aggregate inside SQLite.
    interval = max(SAMPLE_SECONDS, minutes * 60 // 360)
    bucket = cast(HostResourceSample.recorded_at / interval, Integer)
    rows = db.execute(select(
        func.max(HostResourceSample.recorded_at).label("time"),
        func.avg(HostResourceSample.cpu_percent).label("cpu"),
        func.avg(HostResourceSample.memory_percent).label("memory"),
    ).where(
        HostResourceSample.recorded_at >= time.time() - minutes * 60
    ).group_by(bucket).order_by(bucket)).mappings().all()
    return [dict(row) for row in rows], interval


async def worker() -> None:
    while True:
        started = time.monotonic()
        try:
            await asyncio.to_thread(collect)
        except Exception:
            logger.exception("Host resource sampling failed")
        await asyncio.sleep(max(0, SAMPLE_SECONDS - (time.monotonic() - started)))
