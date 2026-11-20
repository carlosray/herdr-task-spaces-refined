#!/usr/bin/env python3
"""Update an installer-managed Task Spaces Refined copy from GitHub Releases."""
import argparse
import fcntl
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import stat
import subprocess
import sys
import tempfile
import time
import urllib.parse
import urllib.request
import zipfile

REPOSITORY = "carlosray/herdr-task-spaces-refined"
ASSET = "task-spaces-refined.zip"
INSTALLATION = "task-spaces-refined-install.json"
STATUS = "task-spaces-refined-update.json"
OPTIONS = {"--no-wrapper", "--no-instructions", "--no-hooks", "--no-automations"}
DOWNLOAD_HOSTS = {"github.com", "api.github.com", "release-assets.githubusercontent.com",
                  "objects.githubusercontent.com"}
VERSION = re.compile(r"v(\d+)\.(\d+)\.(\d+)")


class UpdateError(Exception):
    pass


def version(tag):
    match = VERSION.fullmatch(tag) if isinstance(tag, str) else None
    if not match:
        raise UpdateError("The release has an unsupported version tag.")
    return tuple(map(int, match.groups()))


def install_options(app_home):
    try:
        manifest = json.loads((app_home / "data" / INSTALLATION).read_text())
    except (OSError, ValueError) as error:
        raise UpdateError("This copy uses an unmanaged installation. See the release install instructions.") from error
    flags = manifest.get("flags") if isinstance(manifest, dict) else None
    if not isinstance(flags, list) or any(not isinstance(flag, str) or flag not in OPTIONS for flag in flags):
        raise UpdateError("The saved install options are invalid.")
    return manifest


def fetch(url, limit):
    request = urllib.request.Request(url, headers={"User-Agent": "Task-Spaces-Refined-Updater"})
    with urllib.request.urlopen(request, timeout=24) as response:
        destination = urllib.parse.urlparse(response.geturl())
        if destination.scheme != "https" or destination.hostname not in DOWNLOAD_HOSTS:
            raise UpdateError("GitHub returned an unexpected download address.")
        data = response.read(limit + 1)
    if len(data) > limit:
        raise UpdateError("The release download exceeds the size limit.")
    return data


def download(destination, installed):
    release = json.loads(fetch(f"https://api.github.com/repos/{REPOSITORY}/releases/latest", 256_000))
    tag = release.get("tag_name")
    new_version = version(tag)
    if installed and new_version <= version(installed):
        return None
    if release.get("draft") or release.get("prerelease"):
        raise UpdateError("The published release is not a stable release.")
    assets = {row.get("name") for row in release.get("assets", [])}
    if not {ASSET, ASSET + ".sha256"} <= assets:
        raise UpdateError("The release is missing the installer bundle or its checksum.")
    base = f"https://github.com/{REPOSITORY}/releases/download/{tag}"
    checksum = fetch(f"{base}/{ASSET}.sha256", 512).decode("ascii").split()
    if len(checksum) != 2 or checksum[1].lstrip("*") != ASSET or not re.fullmatch("[a-fA-F0-9]{64}", checksum[0]):
        raise UpdateError("The release checksum is invalid.")
    payload = fetch(f"{base}/{ASSET}", 32 * 1024 * 1024)
    if hashlib.sha256(payload).hexdigest() != checksum[0].lower():
        raise UpdateError("The release bundle did not match its checksum.")
    destination.write_bytes(payload)
    return tag


def unpack_bundle(bundle, destination):
    with zipfile.ZipFile(bundle) as archive:
        entries = archive.infolist()
        if len(entries) > 10000 or sum(row.file_size for row in entries) > 128 * 1024 * 1024:
            raise UpdateError("The installer bundle exceeds the extraction limit.")
        seen = set()
        for row in entries:
            name = PurePosixPath(row.filename)
            file_type = stat.S_IFMT(row.external_attr >> 16)
            if (not name.parts or name.is_absolute() or ".." in name.parts or "\\" in row.filename
                    or name in seen or file_type not in {0, stat.S_IFREG, stat.S_IFDIR}):
                raise UpdateError("The installer bundle contains an unsafe path.")
            seen.add(name)
        archive.extractall(destination)
    for folder in (destination, *destination.iterdir()):
        if (folder / "install.py").is_file() and (folder / "layouts/task-spaces-refined.json").is_file():
            return folder / "install.py"
    raise UpdateError("The installer bundle does not contain Task Spaces Refined.")


def write_status(data, state, message):
    with tempfile.NamedTemporaryFile(dir=data, mode="w", delete=False) as stream:
        pending = Path(stream.name)
        try:
            json.dump({"state": state, "message": message, "at": int(time.time() * 1000)}, stream)
            stream.flush()
            pending.replace(data / STATUS)
        finally:
            pending.unlink(missing_ok=True)


def update(app_home):
    data = app_home / "data"
    data.mkdir(parents=True, exist_ok=True)
    with (data / "task-spaces-refined-update.lock").open("a") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return
        try:
            installation = install_options(app_home)
            write_status(data, "working", "Checking for updates…")
            with tempfile.TemporaryDirectory(prefix="herdr-layout-update-") as scratch:
                root = Path(scratch)
                bundle = root / ASSET
                tag = download(bundle, installation.get("release"))
                if tag is None:
                    write_status(data, "done", "Task Spaces Refined is up to date.")
                    return
                installer = unpack_bundle(bundle, root / "release")
                write_status(data, "working", f"Installing {tag}…")
                env = {**os.environ, "HERDR_APP_HOME": str(app_home)}
                with (data / "task-spaces-refined-update.log").open("w") as log:
                    result = subprocess.run(
                        [sys.executable, "-B", str(installer), "--release-tag", tag, *installation["flags"]],
                        stdin=subprocess.DEVNULL, stdout=log, stderr=subprocess.STDOUT,
                        env=env, timeout=900,
                    )
                if result.returncode:
                    raise UpdateError("Installation failed. See data/task-spaces-refined-update.log.")
            write_status(data, "done", f"Installed Task Spaces Refined {tag}.")
        except (UpdateError, OSError, ValueError, subprocess.SubprocessError, zipfile.BadZipFile) as error:
            write_status(data, "error", str(error))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--app-home", type=Path, required=True)
    parser.add_argument("--run", action="store_true", help=argparse.SUPPRESS)
    args = parser.parse_args()
    if args.run:
        update(args.app_home)
        return 0
    try:
        install_options(args.app_home)
        subprocess.Popen([sys.executable, "-B", __file__, "--app-home", str(args.app_home), "--run"],
                         stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                         start_new_session=True)
        return 0
    except (UpdateError, OSError) as error:
        print(error, file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
