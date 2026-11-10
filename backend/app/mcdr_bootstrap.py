"""MCDR entrypoint with bounded logs and failure-tolerant console output.

Executed by the instance's selected Python, so keep this file stdlib-only.
Install the guards before importing MCDR: its stdout handler captures the stream
at import time and ServerOutputLogger writes directly to file_handler.stream.
"""
from __future__ import annotations

import io
import logging
import os
from pathlib import Path
import runpy
import sys
import threading
import time
import uuid
import warnings


LOG_BYTES = 32 * 1024 * 1024
LOG_BACKUPS = 3
FALLBACK_BYTES = 4 * 1024 * 1024
MAX_RECORD_BYTES = 64 * 1024
_TRUNCATED = b"\n[mc-panel] Oversized log record truncated.\n"


class BoundedLogStream:
    """Rotate on *every* write, including MCDR's direct server-output writes.

    Disk errors suspend writes for 30 seconds instead of recursively logging a
    traceback for every incoming line. A successful retry reports lost writes.
    Existing oversized logs are renamed once, never read/compressed at startup.
    """

    encoding = "utf-8"

    def __init__(self, path, max_bytes=LOG_BYTES, backups=LOG_BACKUPS, on_error=None):
        if max_bytes < 128 or backups < 1:
            raise ValueError('Log retention needs at least 128 bytes and one backup')
        self.path = Path(path).absolute()
        self.max_bytes = max_bytes
        self.backups = backups
        self.on_error = on_error
        self._file = None
        self._size = 0
        self._lock = threading.RLock()
        self._retry_at = 0.0
        self._lost = 0
        self.closed = False

    def _open(self):
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._size = self.path.stat().st_size if self.path.exists() else 0
        if self._size > self.max_bytes:
            preserved = self.path.with_name(self.path.name + '.oversized-' + uuid.uuid4().hex)
            self.path.rename(preserved)
            self._size = 0
            if self.on_error:
                self.on_error(f'[mc-panel] Preserved oversized log: {preserved}\n')
        self._file = self.path.open('ab', buffering=0)

    def _rotate(self):
        self._close_file()
        for index in range(self.backups, 0, -1):
            source = self.path if index == 1 else self.path.with_name(f'{self.path.name}.{index - 1}')
            target = self.path.with_name(f'{self.path.name}.{index}')
            if source.exists():
                source.replace(target)
        self._open()

    def _close_file(self):
        file, self._file = self._file, None
        if file is not None:
            file.close()

    def _write(self, data):
        if self._file is None:
            self._open()
        if self._size + len(data) > self.max_bytes:
            self._rotate()
        remaining = memoryview(data)
        while remaining:
            written = self._file.write(remaining)
            if not written:
                raise OSError('Log write made no progress')
            self._size += written
            remaining = remaining[written:]

    def write(self, text):
        if not text:
            return 0
        with self._lock:
            if self.closed:
                return len(text)
            if time.monotonic() < self._retry_at:
                self._lost += 1
                return len(text)
            limit = min(MAX_RECORD_BYTES, self.max_bytes)
            data = text[:limit].encode('utf-8', errors='replace')
            if len(text) > limit or len(data) > limit:
                # Cut at a UTF-8 boundary; even a single huge write stays bounded.
                data = data[:limit - len(_TRUNCATED)].decode('utf-8', errors='ignore').encode('utf-8') + _TRUNCATED
            try:
                if self._lost:
                    self._write(f'[mc-panel] Log storage recovered; {self._lost} writes lost.\n'.encode())
                self._write(data)
                self._lost = 0
                self._retry_at = 0.0
            except OSError as exc:
                try:
                    self._close_file()
                except OSError:
                    pass
                self._lost += 1
                self._retry_at = time.monotonic() + 30
                if self.on_error:
                    self.on_error(f'[mc-panel] Cannot write {self.path}: {exc}; retry in 30s.\n')
        return len(text)

    def flush(self):
        # Writes use an unbuffered binary file; there is no deferred I/O here.
        pass

    def close(self):
        with self._lock:
            self.closed = True
            try:
                self._close_file()
            except OSError:
                pass


class ResilientConsole(io.TextIOBase):
    """Detach from an invalid output handle once; never retry a broken pipe."""

    encoding = 'utf-8'
    errors = 'replace'

    def __init__(self, stream, fallback, name):
        self._stream = stream
        self._fallback = fallback
        self._name = name
        self._lock = threading.RLock()
        self._failed = False

    def _fail(self, exc):
        self._failed = True
        self._fallback.write(
            f'[mc-panel] {self._name} disconnected ({exc}); '
            'console output redirected to console-fallback.log.\n'
        )

    def write(self, text):
        with self._lock:
            if not self._failed:
                try:
                    self._stream.write(text)
                    # Catch errors here instead of leaving buffered writes for
                    # a later flush or Python interpreter shutdown.
                    self._stream.flush()
                    return len(text)
                except (OSError, ValueError) as exc:
                    self._fail(exc)
            self._fallback.write(text)
            return len(text)

    def flush(self):
        with self._lock:
            if not self._failed:
                try:
                    self._stream.flush()
                except (OSError, ValueError) as exc:
                    self._fail(exc)

    def writable(self):
        return True

    def isatty(self):
        # Hosted instances always use pipes, not an interactive terminal.
        return False

    def fileno(self):
        return self._stream.fileno()


class BoundedMCDRFileHandler(logging.StreamHandler):
    def __init__(self, file_path, rotate_day_count):
        # Match MCDR's constructor, replacing time-only retention with a size cap.
        super().__init__(BoundedLogStream(file_path, max_bytes=LOG_BYTES, backups=LOG_BACKUPS,
                                         on_error=lambda msg: sys.stderr.write(msg)))

    def close(self):
        self.acquire()
        try:
            self.stream.close()
            super().close()
        finally:
            self.release()


def install_log_rotation():
    from mcdreforged.logging import logger

    # This is a private MCDR integration point, covered using the real installed
    # MCDR in tests. Fail visibly if a future version removes this integration.
    if not hasattr(logger, 'ZippingDayRotatingFileHandler'):
        raise RuntimeError('Unsupported MCDR log handler; cannot install log size protection')
    logger.ZippingDayRotatingFileHandler = BoundedMCDRFileHandler


def install_input_guard():
    from mcdreforged.executor.console_handler import ConsoleHandler

    original_loop = ConsoleHandler.loop

    def loop(console):
        original_input = console.console_kit.get_input

        def get_input():
            if console.console_kit.pt_enabled:
                return original_input()
            try:
                line = sys.stdin.readline()
            except (OSError, ValueError):
                line = ''
            if line == '':
                # MCDR's basic input strips EOF into an empty command and loops
                # forever. Stop this reader BEFORE requesting a single graceful
                # interrupt: repeated interrupts would force-kill the game.
                console.stop()
                server = console.mcdr_server
                if not server.is_interrupt() and not server.is_mcdr_about_to_exit():
                    sys.stderr.write('[mc-panel] Standard input closed; stopping MCDR gracefully.\n')
                    server.interrupt()
                return []
            command = line.rstrip('\r\n')
            return [command] if command else []

        console.console_kit.get_input = get_input
        try:
            original_loop(console)
        finally:
            console.console_kit.get_input = original_input

    ConsoleHandler.loop = loop


def main():
    # Preserve `python -m mcdreforged` module/plugin lookup from the instance cwd.
    sys.path.insert(0, os.getcwd())
    fallback = BoundedLogStream(Path('logs/console-fallback.log'), FALLBACK_BYTES, 1)
    sys.stdout = ResilientConsole(sys.stdout, fallback, 'stdout')
    sys.stderr = ResilientConsole(sys.stderr, fallback, 'stderr')
    install_log_rotation()
    install_input_guard()
    # MCDR warns that non-TextIOWrapper streams cannot enable line buffering.
    # Our wrapper flushes every write, so this warning does not apply.
    with warnings.catch_warnings():
        warnings.filterwarnings('ignore', message='.*is not a io.TextIOWrapper, cannot invoke reconfigure',
                                category=UserWarning, module=r'mcdreforged\.mcdr_boostrap')
        runpy.run_module('mcdreforged', run_name='__main__')


if __name__ == '__main__':
    main()
