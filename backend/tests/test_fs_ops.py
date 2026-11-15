import errno
import json
import os
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
import tempfile
import threading
import unittest
from unittest.mock import patch

from app import fs_ops


def locked_file(code=5):
    error = PermissionError(errno.EACCES, 'file temporarily held open')
    error.winerror = code
    return error


class AtomicStateTests(unittest.TestCase):
    def test_transient_windows_conflict_preserves_old_state_until_publish(self):
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / 'state.json'
            target.write_text('{"old": true}', encoding='utf-8')
            replace = os.replace
            attempts = []

            def intermittently_locked(source, destination):
                attempts.append(source)
                self.assertEqual(json.loads(target.read_text()), {'old': True})
                self.assertEqual(json.loads(source.read_text(encoding='utf-8')), {'stage': '解压中'})
                if len(attempts) < 4:
                    raise locked_file([5, 32, 33][len(attempts) - 1])
                replace(source, destination)

            with patch.object(fs_ops.os, 'replace', side_effect=intermittently_locked), patch.object(fs_ops.time, 'sleep'):
                fs_ops.write_json_atomic(target, {'stage': '解压中'})
            self.assertEqual(len(attempts), 4)
            self.assertEqual(json.loads(target.read_text(encoding='utf-8')), {'stage': '解压中'})
            self.assertEqual(list(target.parent.iterdir()), [target])

    def test_persistent_lock_is_bounded_and_does_not_destroy_previous_state(self):
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / 'state.json'
            target.write_text('{"old": true}', encoding='utf-8')
            with patch.object(fs_ops.os, 'replace', side_effect=locked_file()) as replace, patch.object(fs_ops.time, 'sleep'):
                with self.assertRaises(PermissionError):
                    fs_ops.write_json_atomic(target, {'new': True})
                self.assertEqual(replace.call_count, len(fs_ops._RETRY_DELAYS) + 1)
            self.assertEqual(json.loads(target.read_text()), {'old': True})
            self.assertEqual(list(target.parent.iterdir()), [target])

    def test_non_lock_errors_are_not_retried(self):
        with patch.object(fs_ops.os, 'replace', side_effect=OSError(errno.ENOSPC, 'full')) as replace, patch.object(fs_ops.time, 'sleep') as sleep:
            with self.assertRaises(OSError):
                fs_ops.replace_path(Path('source'), Path('target'))
            replace.assert_called_once()
            sleep.assert_not_called()

    def test_concurrent_writers_use_different_temporary_files(self):
        with tempfile.TemporaryDirectory() as directory, ThreadPoolExecutor(max_workers=2) as pool:
            target = Path(directory) / 'state.json'
            barrier = threading.Barrier(2)
            paths = set()
            mutex = threading.Lock()
            replace = os.replace

            def synchronize(source, destination):
                with mutex:
                    first_attempt = source not in paths
                    paths.add(source)
                if first_attempt:
                    barrier.wait(timeout=3)
                replace(source, destination)

            with patch.object(fs_ops.os, 'replace', side_effect=synchronize):
                futures = [pool.submit(fs_ops.write_json_atomic, target, {'writer': n}) for n in range(2)]
                for future in futures:
                    future.result(timeout=5)
            self.assertEqual(len(paths), 2)
            self.assertIn(json.loads(target.read_text())['writer'], (0, 1))
            self.assertEqual(list(target.parent.iterdir()), [target])

    @unittest.skipUnless(os.name == 'nt', 'Windows file sharing semantics')
    def test_real_windows_reader_temporarily_blocks_replacement(self):
        import ctypes
        from ctypes import wintypes

        kernel = ctypes.WinDLL('kernel32', use_last_error=True)
        kernel.CreateFileW.argtypes = [wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD,
                                      ctypes.c_void_p, wintypes.DWORD, wintypes.DWORD, wintypes.HANDLE]
        kernel.CreateFileW.restype = wintypes.HANDLE
        kernel.CloseHandle.argtypes = [wintypes.HANDLE]
        kernel.CloseHandle.restype = wintypes.BOOL
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / 'state.json'
            target.write_text('{"old": true}', encoding='utf-8')
            # Allow readers/writers but not FILE_SHARE_DELETE, as with a scanner
            # or another process opening this file without delete-sharing.
            handle = kernel.CreateFileW(str(target), 0x80000000, 3, None, 3, 0x80, None)
            self.assertNotEqual(handle, ctypes.c_void_p(-1).value)
            blocked = threading.Event()
            replace = os.replace
            observed_errors = []

            def observe(source, destination):
                try:
                    replace(source, destination)
                except OSError as exc:
                    observed_errors.append(exc.winerror)
                    blocked.set()
                    raise

            try:
                with ThreadPoolExecutor(max_workers=1) as pool, patch.object(fs_ops.os, 'replace', side_effect=observe):
                    future = pool.submit(fs_ops.write_json_atomic, target, {'new': True})
                    try:
                        self.assertTrue(blocked.wait(2))
                        self.assertEqual(json.loads(target.read_text()), {'old': True})
                    finally:
                        kernel.CloseHandle(handle)
                        handle = None
                    future.result(timeout=3)
            finally:
                if handle is not None:
                    kernel.CloseHandle(handle)
            self.assertTrue(observed_errors)
            self.assertTrue(set(observed_errors) <= {5, 32, 33})
            self.assertEqual(json.loads(target.read_text()), {'new': True})
