"""任务进度查询。"""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException

from .. import jobs as jobstore
from ..deps import require_auth

router = APIRouter(prefix="/jobs", tags=["jobs"])


@router.get("/{job_id}")
def get_job(job_id: str, _: str = Depends(require_auth)) -> dict:
    job = jobstore.get(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="任务不存在")
    return job
