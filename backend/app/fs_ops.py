"""Atomic file operations that tolerate brief Windows sharing/access conflicts."""
from __future__ import annotations

import json
import os
from pathlib import Path
import tempfile
import time
from collections.abc import Callable
from typing import TypeVar


T = TypeVar('T')
_RETRY_DELAYS = (.01, .02, .04, .08, .16, .32, .5)
_WINDOWS_LOCK_ERRORS = {5, 32, 33}  # access denied, sharing violation, lock violation


def retry_windows_lock(operation: Callable[[], T]) -> T:
    """Retry only Windows lock-like errors, for at most 1.13 seconds in total.

    Access denied can also mean permanent permissions, so retries are bounded.
    Other failures (missing files, disk full, cross-device moves) fail immediately.
    """
    for attempt in range(len(_RETRY_DELAYS) + 1):
        try:
            return operation()
        except OSError as exc:
            if getattr(exc, 'winerror', None) not in _WINDOWS_LOCK_ERRORS or attempt == len(_RETRY_DELAYS):
                raise
            time.sleep(_RETRY_DELAYS[attempt])
    raise AssertionError('unreachable')


def replace_path(source: Path, target: Path) -> None:
    retry_windows_lock(lambda: os.replace(source, target))


def write_json_atomic(path: Path, value: dict) -> None:
    """Publish a closed, complete snapshot; never truncate the previous state."""
    data = json.dumps(value, ensure_ascii=False)
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(mode='w', encoding='utf-8',
                                         dir=path.parent, prefix=f'.{path.name}.',
                                         suffix='.tmp', delete=False) as stream:
            temporary = Path(stream.name)
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        replace_path(temporary, path)
    finally:
        if temporary is not None:
            try:
                retry_windows_lock(lambda: temporary.unlink(missing_ok=True))
            except OSError:
                # A scanner may also temporarily hold this abandoned temp file.
                # Session cleanup removes it later; preserve the original error.
                pass
