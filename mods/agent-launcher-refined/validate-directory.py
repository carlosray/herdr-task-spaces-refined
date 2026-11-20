"""Read-only destination validation for the standalone Herdr launcher."""

import json
import os
from pathlib import Path
import subprocess
import sys


LINKED = 'This directory is inside a linked Git worktree. Use Task to assign it or open its existing Space.'
VERIFY_GIT = 'Could not verify Git checkout ownership. Use Task or open an existing Space.'
VERIFY_REGISTRY = 'Could not read Task Spaces checkout assignments. Retry or open an existing Space.'


class InvalidDirectory(Exception):
    pass


def check_git(folder):
    env = {key: value for key, value in os.environ.items() if not key.startswith('GIT_')}
    # A nested standalone repository can hide a linked checkout from ordinary Git discovery.
    for ancestor in (folder, *folder.parents):
        try:
            (ancestor / '.git').lstat()
        except FileNotFoundError:
            continue
        except OSError as error:
            raise InvalidDirectory(VERIFY_GIT) from error

        try:
            output = subprocess.run(
                ['git', '--no-optional-locks', '-C', str(ancestor), '-c', 'core.fsmonitor=false',
                 'rev-parse', '--path-format=absolute', '--absolute-git-dir', '--git-common-dir'],
                env=env, capture_output=True, text=True, check=True, timeout=4,
            )
            gitdir, common = (Path(line).resolve(strict=True) for line in output.stdout.splitlines())
        except (OSError, RuntimeError, ValueError, subprocess.SubprocessError) as error:
            raise InvalidDirectory(VERIFY_GIT) from error
        if gitdir != common:
            raise InvalidDirectory(LINKED)


def check_reservations(folder):
    registry = Path(os.environ.get('HERDR_TASK_STATE') or Path.home() / '.local/state/herdr-tasks/state.json')
    try:
        try:
            content = registry.read_text()
        except FileNotFoundError:
            return
        state = json.loads(content)
        if state.get('version') != 1 or not isinstance(state.get('checkouts'), dict):
            raise ValueError('Unexpected registry shape')
        for key, claim in state['checkouts'].items():
            path = Path(claim.get('folder', key))
            if not path.is_absolute():
                raise ValueError('Invalid checkout path')
            if folder.is_relative_to(path.resolve()):
                raise InvalidDirectory('This directory is reserved by a task. Use Task or open its existing Space.')
    except (OSError, RuntimeError, TypeError, ValueError, AttributeError) as error:
        raise InvalidDirectory(VERIFY_REGISTRY) from error


def validate(path):
    folder = Path(path)
    if not folder.is_absolute():
        raise InvalidDirectory('Choose an absolute directory for the new Space.')
    try:
        folder = folder.resolve(strict=True)
        valid = folder.is_dir() and os.access(folder, os.X_OK)
    except (OSError, RuntimeError, ValueError):
        valid = False
    if not valid:
        raise InvalidDirectory('Choose an existing, accessible directory on the selected host.')
    check_git(folder)
    check_reservations(folder)
    return {'ok': True, 'folder': str(folder)}


if __name__ == '__main__':
    try:
        result = validate(sys.argv[1] if len(sys.argv) == 2 else '')
    except InvalidDirectory as error:
        result = {'error': str(error)}
    print(json.dumps(result))
