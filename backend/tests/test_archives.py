import io
import tarfile
import tempfile
import unittest
import zipfile
from pathlib import Path
from unittest.mock import patch

from app import archive_manager as archives


class ArchiveRestoreTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name)
        self.instance = self.root / "instance"
        self.server = self.instance / "server"
        self.target = self.server / "world"
        self.backup = self.server / "world_backup"
        self.write_world(self.target, b"current valid world")
        self.write_world(self.backup, b"previous valid world")
        self.archive = self.make_archive("new.zip", b"restored world")

    def write_world(self, path, value):
        path.mkdir(parents=True)
        (path / "level.dat").write_bytes(value)
        (path / "region").mkdir()
        (path / "region" / "r.0.0.mca").write_bytes(value + b" region")

    def make_archive(self, name, value):
        path = self.root / name
        files = {"uploaded/level.dat": value,
                 "uploaded/region/r.0.0.mca": value + b" region"}
        if name.endswith(".zip"):
            with zipfile.ZipFile(path, "w") as stream:
                for filename, data in files.items():
                    stream.writestr(filename, data)
        else:
            with tarfile.open(path, "w:gz") as stream:
                for filename, data in files.items():
                    entry = tarfile.TarInfo(filename)
                    entry.size = len(data)
                    stream.addfile(entry, io.BytesIO(data))
        return path

    def assert_world(self, path, value):
        self.assertEqual((path / "level.dat").read_bytes(), value)
        self.assertEqual((path / "region" / "r.0.0.mca").read_bytes(), value + b" region")
        self.assertEqual(sorted(p.relative_to(path).as_posix() for p in path.rglob("*") if p.is_file()),
                         ["level.dat", "region/r.0.0.mca"])

    def assert_clean(self):
        self.assertEqual(list(self.instance.rglob(".restore_*")), [])

    def test_copy_failure_and_retry_never_replace_valid_world_or_backup(self):
        def partial_copy(src, dest):
            Path(dest).mkdir()
            (Path(dest) / "level.dat").write_bytes(b"incomplete")
            raise OSError("injected copy failure")

        with patch.object(archives.shutil, "copytree", side_effect=partial_copy):
            for _ in range(2):
                with self.assertRaisesRegex(OSError, "copy failure"):
                    archives.restore_archive(self.archive, self.instance)
                self.assert_world(self.target, b"current valid world")
                self.assert_world(self.backup, b"previous valid world")
                self.assert_clean()
        archives.restore_archive(self.archive, self.instance)
        self.assert_world(self.target, b"restored world")
        self.assert_world(self.backup, b"current valid world")
        self.assert_clean()

    def test_switch_failures_roll_back_both_world_and_previous_backup(self):
        rename = Path.rename
        for failure_step in (1, 2, 3):
            with self.subTest(failure_step=failure_step):
                calls = 0

                def fail_once(path, dest):
                    nonlocal calls
                    calls += 1
                    if calls == failure_step:
                        raise PermissionError("injected switch failure")
                    return rename(path, dest)

                with patch.object(Path, "rename", fail_once):
                    with self.assertRaisesRegex(PermissionError, "switch failure"):
                        archives.restore_archive(self.archive, self.instance)
                self.assert_world(self.target, b"current valid world")
                self.assert_world(self.backup, b"previous valid world")
                self.assert_clean()
        archives.restore_archive(self.archive, self.instance)
        self.assert_world(self.backup, b"current valid world")
        self.assert_clean()

    def test_success_and_repeated_restore_rotate_only_complete_worlds(self):
        progress = []
        archives.restore_archive(self.archive, self.instance,
                                 lambda done, total: progress.append((done, total)))
        self.assertEqual(progress, [(0, 100), (50, 100), (100, 100)])
        self.assert_world(self.target, b"restored world")
        self.assert_world(self.backup, b"current valid world")
        second = self.make_archive("second.tar.gz", b"second restored world")
        archives.restore_archive(second, self.instance)
        self.assert_world(self.target, b"second restored world")
        self.assert_world(self.backup, b"restored world")
        archives.restore_archive(second, self.instance)
        self.assert_world(self.target, b"second restored world")
        self.assert_world(self.backup, b"second restored world")
        self.assert_clean()

    def test_missing_world_preserves_existing_backup(self):
        archives.shutil.rmtree(self.target)
        archives.restore_archive(self.archive, self.instance)
        self.assert_world(self.target, b"restored world")
        self.assert_world(self.backup, b"previous valid world")
        self.assert_clean()

    def test_switch_failure_without_previous_backup_restores_current_world(self):
        archives.shutil.rmtree(self.backup)
        rename = Path.rename

        def fail_install(path, dest):
            if path.name.startswith(".restore_world_"):
                raise PermissionError("injected switch failure")
            return rename(path, dest)

        with patch.object(Path, "rename", fail_install):
            with self.assertRaises(PermissionError):
                archives.restore_archive(self.archive, self.instance)
        self.assert_world(self.target, b"current valid world")
        self.assertFalse(self.backup.exists())
        self.assert_clean()
        archives.restore_archive(self.archive, self.instance)
        self.assert_world(self.target, b"restored world")
        self.assert_world(self.backup, b"current valid world")
        self.assert_clean()

    def test_archive_without_world_preserves_existing_worlds(self):
        with zipfile.ZipFile(self.archive, "w") as stream:
            stream.writestr("not-a-world.txt", b"invalid world")
        with self.assertRaisesRegex(ValueError, "level.dat"):
            archives.restore_archive(self.archive, self.instance)
        self.assert_world(self.target, b"current valid world")
        self.assert_world(self.backup, b"previous valid world")
        self.assert_clean()

    def test_failed_rollback_retains_recoverable_worlds_even_after_retry(self):
        rename = Path.rename

        def fail_install_and_rollback(path, dest):
            if Path(dest) == self.target:
                raise PermissionError("injected locked target")
            return rename(path, dest)

        with patch.object(Path, "rename", fail_install_and_rollback):
            with self.assertRaises(PermissionError):
                archives.restore_archive(self.archive, self.instance)
        self.assertFalse(self.target.exists())
        self.assert_world(self.backup, b"current valid world")
        retained = list(self.server.glob(".restore_backup_*"))
        self.assertEqual(len(retained), 1)
        self.assert_world(retained[0], b"previous valid world")
        archives.restore_archive(self.archive, self.instance)
        self.assert_world(self.target, b"restored world")
        self.assert_world(self.backup, b"current valid world")
        self.assert_world(retained[0], b"previous valid world")
        self.assertEqual(list(self.instance.glob(".restore_*")), [])
        self.assertEqual(list(self.server.glob(".restore_world_*")), [])

    def test_invalid_world_names_do_not_touch_worlds(self):
        for name in (".", "..", "../outside", "nested/../../outside", "/outside",
                     "C:\\outside", "C:outside", "\\\\host\\share\\world", "..\\outside"):
            with self.subTest(name=name):
                (self.server / "server.properties").write_text(f"level-name={name}\n", encoding="utf-8")
                with self.assertRaises(ValueError):
                    archives.restore_archive(self.archive, self.instance)
                self.assert_world(self.target, b"current valid world")
                self.assert_world(self.backup, b"previous valid world")
                self.assert_clean()

    def test_nested_world_path_is_supported(self):
        (self.server / "server.properties").write_text("level-name=maps/custom\n", encoding="utf-8")
        archives.restore_archive(self.archive, self.instance)
        self.assert_world(self.server / "maps" / "custom", b"restored world")
        self.assert_world(self.target, b"current valid world")
        self.assert_clean()


if __name__ == "__main__":
    unittest.main()
