import hashlib
import importlib.util
import io
import json
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest import TestCase, main
from unittest.mock import patch
import zipfile

source = Path(__file__).parents[1] / "mods/better-config-refined/update.py"
spec = importlib.util.spec_from_file_location("layout_updater", source)
updater = importlib.util.module_from_spec(spec)
spec.loader.exec_module(updater)


def archive(members):
    payload = io.BytesIO()
    with zipfile.ZipFile(payload, "w") as bundle:
        for name, value in members.items():
            bundle.writestr(name, value)
    return payload.getvalue()


class UpdateTests(TestCase):
    def test_rejects_a_corrupt_bundle_without_writing_it(self):
        release = json.dumps({"tag_name": "v0.1.9", "assets": [
            {"name": updater.ASSET}, {"name": updater.ASSET + ".sha256"},
        ]}).encode()
        checksum = f'{hashlib.sha256(b"trusted").hexdigest()}  {updater.ASSET}\n'.encode()
        with TemporaryDirectory() as folder, patch.object(updater, "fetch", side_effect=[release, checksum, b"other"]):
            destination = Path(folder) / updater.ASSET
            with self.assertRaisesRegex(updater.UpdateError, "checksum"):
                updater.download(destination, "v0.1.8")
            self.assertFalse(destination.exists())

    def test_archive_validation_precedes_any_extraction(self):
        with TemporaryDirectory() as folder:
            root = Path(folder)
            bundle = root / updater.ASSET
            bundle.write_bytes(archive({"install.py": "pass", "../escaped": "unsafe"}))
            with self.assertRaisesRegex(updater.UpdateError, "unsafe path"):
                updater.unpack_bundle(bundle, root / "release")
            self.assertFalse((root / "release").exists())

    def test_running_the_verified_release_retains_the_install_options(self):
        payload = archive({
            "source/install.py": "pass",
            "source/layouts/task-spaces-refined.json": "{}",
        })
        release = json.dumps({"tag_name": "v0.1.9", "assets": [
            {"name": updater.ASSET}, {"name": updater.ASSET + ".sha256"},
        ]}).encode()
        checksum = f"{hashlib.sha256(payload).hexdigest()}  {updater.ASSET}\n".encode()
        with TemporaryDirectory() as folder, patch.object(updater, "fetch", side_effect=[release, checksum, payload]), \
             patch.object(updater.subprocess, "run") as install:
            root = Path(folder)
            data = root / "data"
            data.mkdir()
            (data / updater.INSTALLATION).write_text(json.dumps({"flags": ["--no-automations", "--keep-local-code"], "release": "v0.1.8"}))
            install.return_value.returncode = 0
            updater.update(root)
            args, kwargs = install.call_args
            self.assertEqual(args[0][-4:], ["--release-tag", "v0.1.9", "--no-automations", "--keep-local-code"])
            self.assertEqual(kwargs["env"]["HERDR_APP_HOME"], str(root))
            self.assertEqual(json.loads((data / updater.STATUS).read_text())["state"], "done")

    def test_no_install_options_means_no_network_or_execution(self):
        with TemporaryDirectory() as folder, patch.object(updater, "fetch") as fetch:
            root = Path(folder)
            updater.update(root)
            fetch.assert_not_called()
            self.assertIn("unmanaged", json.loads((root / "data" / updater.STATUS).read_text())["message"])


if __name__ == "__main__":
    main()
