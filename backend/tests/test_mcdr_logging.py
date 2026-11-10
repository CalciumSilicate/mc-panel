"""Regression tests for invalid stdout handles and unbounded MCDR logs."""
import asyncio
import errno
import io
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

import psutil
import yaml

from app import mcdr_bootstrap as bootstrap
from app.mcdr import MCDRManager, _CONSOLE_LINE_BYTES
from test_shutdown import ManagedProcess


class BrokenOutput:
    def __init__(self, error, fail_flush=False):
        self.error = error
        self.fail_flush = fail_flush
        self.calls = 0

    def write(self, text):
        self.calls += 1
        if not self.fail_flush:
            raise self.error
        return len(text)

    def flush(self):
        raise self.error


class ConsoleGuardTests(unittest.TestCase):
    def test_legacy_config_uses_pipe_console_and_preserves_custom_command(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            path = root / 'config.yml'
            config = dict(encoding='utf8', decoding=['utf8', 'gbk'], advanced_console=True,
                          start_command=['custom-java', '-jar', 'custom.jar'], plugin_directories=['custom-plugins'])
            path.write_text(yaml.safe_dump(config), encoding='utf-8')
            MCDRManager()._reconcile_config(root)
            result = yaml.safe_load(path.read_text(encoding='utf-8'))
            self.assertIs(result.pop('advanced_console'), False)
            config.pop('advanced_console')
            self.assertEqual(result, config)

    def test_unmanaged_instance_process_is_rejected_but_unrelated_process_is_allowed(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            process = SimpleNamespace(pid=1234, info={'name': 'python.exe'}, cwd=Mock(return_value=str(root / 'server')))
            with patch('psutil.process_iter', return_value=[process]):
                with self.assertRaisesRegex(RuntimeError, '未托管进程 PID 1234'):
                    MCDRManager._check_unmanaged_processes(root)
                MCDRManager._check_unmanaged_processes(root / 'other')

    def test_invalid_handle_and_broken_pipe_switch_once(self):
        for error in [OSError(errno.EINVAL, 'Invalid argument'), BrokenPipeError(),
                      OSError(errno.EBADF, 'Bad file descriptor'), ValueError('closed stream')]:
            for fail_flush in (False, True):
                with self.subTest(error=error, fail_flush=fail_flush):
                    source = BrokenOutput(error, fail_flush)
                    fallback = io.StringIO()
                    stream = bootstrap.ResilientConsole(source, fallback, 'stdout')
                    for i in range(1000):
                        self.assertEqual(stream.write(f'line {i}\n'), len(f'line {i}\n'))
                        stream.flush()
                    self.assertEqual(source.calls, 1)
                    self.assertEqual(fallback.getvalue().count('disconnected'), 1)
                    self.assertIn('line 999\n', fallback.getvalue())
                    self.assertNotIn('Traceback', fallback.getvalue())

    def test_healthy_console_preserves_unicode(self):
        source, fallback = io.StringIO(), io.StringIO()
        stream = bootstrap.ResilientConsole(source, fallback, 'stdout')
        stream.write('服务器已启动\n')
        stream.flush()
        self.assertEqual(source.getvalue(), '服务器已启动\n')
        self.assertEqual(fallback.getvalue(), '')


class LogRetentionTests(unittest.TestCase):
    def test_unicode_direct_writes_and_huge_records_stay_bounded(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'MCDR.log'
            stream = bootstrap.BoundedLogStream(path, max_bytes=512, backups=3)
            try:
                for _ in range(500):
                    stream.write('测试日志\n' * 20)
                stream.write('超长' * 100000)
                stream.write('final line\n')
            finally:
                stream.close()
            files = list(Path(directory).iterdir())
            self.assertEqual(len(files), 4)
            for file in files:
                self.assertLessEqual(file.stat().st_size, 512)
                file.read_text(encoding='utf-8')  # no split UTF-8 sequences
            self.assertIn('final line', path.read_text(encoding='utf-8'))
            self.assertTrue(any('truncated' in file.read_text(encoding='utf-8') for file in files))

    def test_existing_oversized_log_is_preserved_without_compression(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'MCDR.log'
            path.write_bytes(b'old log\n' * 1000)
            notices = []
            stream = bootstrap.BoundedLogStream(path, max_bytes=512, on_error=notices.append)
            stream.write('new log\n')
            stream.close()
            preserved, = path.parent.glob('MCDR.log.oversized-*')
            self.assertEqual(preserved.read_bytes(), b'old log\n' * 1000)
            self.assertEqual(path.read_text(), 'new log\n')
            self.assertEqual(len(notices), 1)

    def test_disk_failure_is_throttled_and_recovers(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'MCDR.log'
            notices = []
            stream = bootstrap.BoundedLogStream(path, max_bytes=512, on_error=notices.append)
            try:
                with patch.object(stream, '_open', side_effect=OSError(errno.ENOSPC, 'No space')) as opening:
                    for _ in range(1000):
                        stream.write('lost line\n')
                    self.assertEqual(opening.call_count, 1)
                    self.assertEqual(len(notices), 1)
                with patch.object(bootstrap.time, 'monotonic', return_value=time.monotonic() + 31):
                    stream.write('recovered\n')
            finally:
                stream.close()
            self.assertIn('1000 writes lost', path.read_text())
            self.assertIn('recovered', path.read_text())

    def test_real_mcdr_direct_output_and_tracebacks_both_rotate(self):
        from mcdreforged.logging import logger
        from mcdreforged.logging.stream_handler import SyncStdoutStreamHandler

        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'MCDR.log'
            fallback = io.StringIO()
            source = BrokenOutput(OSError(errno.EINVAL, 'Invalid argument'))
            stream = bootstrap.ResilientConsole(source, fallback, 'stdout')
            with patch.object(logger, 'ZippingDayRotatingFileHandler'), patch.object(bootstrap, 'LOG_BYTES', 1024):
                bootstrap.install_log_rotation()
                SyncStdoutStreamHandler.update_stdout(stream)
                mcdr_logger = logger.MCDReforgedLogger()
                try:
                    mcdr_logger.set_file(str(path))
                    output = logger.ServerOutputLogger('Server', mcdr_logger)
                    for i in range(500):
                        output.info(f'direct game output {i}', write_to_mcdr_log_file=True)
                    self.assertTrue(path.with_name('MCDR.log.1').exists())
                    for _ in range(20):
                        try:
                            raise RuntimeError('plugin failure')
                        except RuntimeError:
                            mcdr_logger.exception('example plugin error')
                    output.info('still receiving output', write_to_mcdr_log_file=True)
                finally:
                    mcdr_logger.unset_file()
                    SyncStdoutStreamHandler.update_stdout(sys.stdout)
            self.assertEqual(source.calls, 1)
            self.assertIn('still receiving output', path.read_text())
            for file in path.parent.iterdir():
                self.assertLessEqual(file.stat().st_size, 1024)

    def test_locked_rotation_does_not_keep_appending_to_full_log(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'MCDR.log'
            notices = []
            stream = bootstrap.BoundedLogStream(path, max_bytes=128, on_error=notices.append)
            try:
                stream.write('x' * 100)
                with patch.object(Path, 'replace', side_effect=PermissionError('file locked')) as rename:
                    for _ in range(500):
                        stream.write('y' * 100)
                    self.assertEqual(rename.call_count, 1)
                    self.assertEqual(path.stat().st_size, 100)
                    self.assertEqual(len(notices), 1)
                with patch.object(bootstrap.time, 'monotonic', return_value=time.monotonic() + 31):
                    stream.write('recovered\n')
                self.assertIn('recovered', path.read_text())
            finally:
                stream.close()

    def test_broken_console_and_full_fallback_disk_do_not_recurse(self):
        with tempfile.TemporaryDirectory() as directory:
            fallback = bootstrap.BoundedLogStream(Path(directory) / 'fallback.log')
            source = BrokenOutput(OSError(errno.EINVAL, 'Invalid argument'))
            console = bootstrap.ResilientConsole(source, fallback, 'stdout')
            with patch.object(fallback, '_open', side_effect=OSError(errno.ENOSPC, 'No space')) as opening:
                for _ in range(1000):
                    console.write('test line\n')
                self.assertEqual(source.calls, 1)
                self.assertEqual(opening.call_count, 1)
            fallback.close()


class OutputReaderTests(unittest.IsolatedAsyncioTestCase):
    async def test_multimegabyte_line_does_not_break_following_output(self):
        manager = MCDRManager()
        proc = ManagedProcess()
        manager._procs[1] = proc
        # This exceeds asyncio.StreamReader's default 64 KiB readline limit.
        proc.stdout.feed_data(b'x' * (2 * 1024 * 1024) + b'\nDone (0.1s)!\n')
        proc.stdout.feed_data('中文'.encode('utf-8')[:2])
        task = asyncio.create_task(manager._read_output(1, proc))
        await asyncio.sleep(0)
        proc.stdout.feed_data('中文'.encode('utf-8')[2:] + b'\r\nlast line')
        await asyncio.sleep(0)
        self.assertIn(1, manager._ready)
        proc.finish()
        await asyncio.wait_for(task, 2)
        lines = manager.recent_lines(1)
        self.assertEqual(len(lines), 5)
        self.assertIn('超长日志已截断', lines[0])
        self.assertLess(len(lines[0]), _CONSOLE_LINE_BYTES + 100)
        self.assertEqual(lines[2:4], ['中文', 'last line'])

    async def test_output_error_does_not_report_live_process_as_exited(self):
        manager = MCDRManager()
        proc = ManagedProcess()
        manager._procs[1] = proc
        manager._ready.add(1)
        proc.stdout.set_exception(OSError(errno.EINVAL, 'Invalid argument'))
        task = asyncio.create_task(manager._read_output(1, proc))
        await asyncio.sleep(0)
        self.assertFalse(task.done())
        self.assertIn(1, manager._ready)
        self.assertIn('控制台读取失败', manager.recent_lines(1)[0])
        proc.finish()
        await asyncio.wait_for(task, 2)
        self.assertNotIn(1, manager._ready)


class RealMCDRProcessTests(unittest.TestCase):
    def test_closed_stdout_pipe_preserves_commands_and_clean_shutdown(self):
        self.run_disconnection()

    def test_closed_stdin_stops_gracefully_instead_of_spamming_empty_commands(self):
        self.run_disconnection(close_input=True)

    def run_disconnection(self, close_input=False):
        # Real installed MCDR, with a tiny Python server instead of Minecraft.
        # Closing the reading end reproduces losing the old parent console.
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'server').mkdir()
            (root / 'plugins').mkdir()
            (root / 'permission.yml').write_text('default_level: user\n', encoding='utf-8')
            config = dict(language='en_us', working_directory='server', handler='vanilla_handler',
                          start_command=[sys.executable, '-u', 'fake_server.py'], encoding='utf8',
                          decoding='utf8', plugin_directories=['plugins'], check_update=False,
                          advanced_console=True, telemetry=False, write_server_output_to_log_file=True)
            (root / 'config.yml').write_text(yaml.safe_dump(config), encoding='utf-8')
            MCDRManager()._reconcile_config(root)
            (root / 'server/fake_server.py').write_text('''import sys
from pathlib import Path
print('[12:00:00] [Server thread/INFO]: Done (0.1s)! For help, type help', flush=True)
Path('ready').touch()
for line in sys.stdin:
    command = line.strip()
    print('[12:00:00] [Server thread/INFO]: received ' + command, flush=True)
    if command == 'after-disconnect':
        for i in range(1000):
            print('[12:00:00] [Server thread/INFO]: test output ' + str(i), flush=True)
        Path('command-received').touch()
    if command == 'stop': break
''', encoding='utf-8')
            # This also checks that plugins still receive server info after a
            # broken output handle, rather than aborting in echo_to_console().
            (root / 'plugins/probe.py').write_text('''from pathlib import Path
def on_info(server, info):
    if info.is_from_server and info.content == 'test output 999':
        Path('plugin-received').touch()
''', encoding='utf-8')
            proc = subprocess.Popen([sys.executable, '-u', str(Path(bootstrap.__file__).resolve())],
                                    cwd=root, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                    stderr=subprocess.STDOUT,
                                    env={**os.environ, 'PYTHONUTF8': '1'})

            def await_file(path):
                deadline = time.monotonic() + 15
                while time.monotonic() < deadline:
                    if path.exists():
                        return
                    if proc.poll() is not None:
                        break
                    time.sleep(.05)
                logs = root / 'logs/MCDR.log'
                self.fail(f'{path.name} missing, exit={proc.poll()}, log='
                          + (logs.read_text(encoding='utf-8')[-6000:] if logs.exists() else 'absent'))

            try:
                await_file(root / 'server/ready')
                if close_input:
                    proc.stdin.close()
                    proc.stdin = None
                    output, _ = proc.communicate(timeout=15)
                    self.assertEqual(proc.returncode, 0)
                    self.assertIn(b'Standard input closed; stopping MCDR gracefully.', output)
                    self.assertIn(b'received stop', output)
                    self.assertNotIn(b'received \r\n', output)
                    self.assertNotIn(b'received \n', output)
                    self.assertLess(len(output), 32 * 1024)
                    return
                proc.stdout.close()
                proc.stdin.write(b'after-disconnect\n')
                proc.stdin.flush()
                await_file(root / 'server/command-received')
                await_file(root / 'plugin-received')
                proc.stdin.write(b'stop\n')
                proc.stdin.flush()
                self.assertEqual(proc.wait(timeout=15), 0)
                fallback = (root / 'logs/console-fallback.log').read_text(encoding='utf-8')
                self.assertEqual(fallback.count('disconnected ('), 1)
                self.assertIn('test output 999', fallback)
                log = (root / 'logs/MCDR.log').read_text(encoding='utf-8')
                self.assertNotIn('OSError', log)
                self.assertNotIn('Traceback', log)
            finally:
                if proc.poll() is None:
                    process = psutil.Process(proc.pid)
                    children = process.children(recursive=True)
                    for child in reversed(children):
                        try:
                            child.kill()
                        except psutil.NoSuchProcess:
                            pass
                    process.kill()
                    proc.wait(timeout=5)
                    psutil.wait_procs(children, timeout=5)
                if proc.stdin is not None:
                    proc.stdin.close()
                proc.stdout.close()


if __name__ == '__main__':
    unittest.main()
