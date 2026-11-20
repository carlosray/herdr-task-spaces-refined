#!/usr/bin/env python3
"""Install Task Spaces Refined next to the stock layout."""
import argparse
import base64
import io
import json
import os
import re
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import time
import zipfile

ROOT = Path(__file__).resolve().parent
LAYOUT = 'task-spaces-refined'
START = '<!-- task-spaces-refined:agents -->'
END = '<!-- /task-spaces-refined:agents -->'
HOST_FILES = {
    'host/herdr_task.py': '.local/bin/herdr-task',
    'host/herdr-agent.sh': '.local/bin/herdr-agent',
    'host/herdr-session.py': '.config/agent-dev/herdr-session.py',
    'host/shell.sh': '.config/agent-dev/herdr-shell.sh',
    'host/opencode-model.py': '.config/agent-dev/opencode-model.py',
}


def run(argv, **kwargs):
    return subprocess.run(argv, check=True, **kwargs)


def replace(path, content, mode=0o600):
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(dir=path.parent, delete=False) as output:
        stage = Path(output.name)
        output.write(content)
    try:
        stage.chmod(mode)
        stage.replace(path)
    finally:
        stage.unlink(missing_ok=True)


def install_file(source, dest, backup, mode=0o644):
    content = source.read_bytes()
    if dest.is_file() and dest.read_bytes() == content:
        return
    if dest.exists() or dest.is_symlink():
        saved = backup / str(dest.absolute()).lstrip('/')
        saved.parent.mkdir(parents=True, exist_ok=True)
        if dest.is_symlink():
            saved.symlink_to(os.readlink(dest))
        else:
            shutil.copy2(dest, saved)
    replace(dest, content, mode)


def ensure_dependencies(names):
    missing = [name for name in names if not shutil.which(name)]
    if missing:
        raise SystemExit('Install required commands first: ' + ', '.join(missing))


def install_instructions(home, backup):
    skill = ROOT/'skills/task-spaces-agents/SKILL.md'
    for directory, filename in [('.codex', 'AGENTS.md'), ('.claude', 'CLAUDE.md')]:
        install_file(skill, home/directory/'skills/task-spaces-agents/SKILL.md', backup)
        path = home/directory/filename
        old = path.read_text() if path.exists() else ''
        block = (START + '\nWhen launching, messaging, or managing other agents, read '
                 + f'`~/{directory}/skills/task-spaces-agents/SKILL.md` and use native Herdr hc.\n' + END)
        if START in old and END in old:
            a, b = old.index(START), old.index(END) + len(END)
            new = old[:a] + block + old[b:]
        elif START in old or END in old:
            raise SystemExit(f'Unpaired Task Spaces instruction markers in {path}')
        else:
            new = old.rstrip() + ('\n\n' if old.strip() else '') + block + '\n'
        if new != old:
            with tempfile.TemporaryDirectory() as temp:
                staged = Path(temp)/filename
                staged.write_text(new)
                install_file(staged, path, backup, 0o600)


def host_install(home, backup, opts):
    ensure_dependencies(['git', 'hc', *([] if opts.no_wrapper else ['bash', 'jq', 'fzf'])])
    for source, dest in HOST_FILES.items():
        if opts.no_wrapper and source != 'host/herdr_task.py':
            continue
        install_file(ROOT/source, home/dest, backup, 0o755)
    if not opts.no_instructions:
        install_instructions(home, backup)
    if not opts.no_hooks:
        run([sys.executable, str(ROOT/'host/session-hub/install-hooks.py')])
    elif not (home/'.local/bin/herdr-session-probe').exists():
        install_file(ROOT/'host/session-hub/session_probe.py', home/'.local/bin/herdr-session-probe', backup, 0o755)


def host_bundle(path):
    with zipfile.ZipFile(path, 'w', zipfile.ZIP_DEFLATED) as bundle:
        for path in [ROOT/'install.py', *[ROOT/name for name in HOST_FILES],
                     *sorted((ROOT/'host/session-hub').glob('*.*')), ROOT/'skills/task-spaces-agents/SKILL.md']:
            bundle.write(path, path.relative_to(ROOT))


def remote_install(name, opts):
    payload = ROOT/'host-bundle.zip'
    if not payload.exists():
        data = io.BytesIO()
        host_bundle(data)
        raw = data.getvalue()
    else:
        raw = payload.read_bytes()
    bootstrap = """
import base64,io,pathlib,subprocess,sys,tempfile,zipfile
with tempfile.TemporaryDirectory(prefix='herdr-layout-host-') as folder:
    archive=zipfile.ZipFile(io.BytesIO(base64.b64decode(sys.stdin.buffer.read(),validate=True)))
    for entry in archive.namelist():
        path=pathlib.PurePosixPath(entry)
        if path.is_absolute() or '..' in path.parts: raise SystemExit('Invalid host payload path')
    archive.extractall(folder)
    subprocess.run([sys.executable, str(pathlib.Path(folder)/'install.py'), '--host-only', *sys.argv[1:]],check=True)
"""
    flags = [flag for flag in ['no-wrapper', 'no-instructions', 'no-hooks'] if getattr(opts, flag.replace('-', '_'))]
    run(['hc', 'exec', '--on', name, '-i', '--', 'python3', '-B', '-c', bootstrap,
         *['--'+flag for flag in flags]], input=base64.b64encode(raw))


def desktop_install(home, backup, opts):
    ensure_dependencies(['herdr-app', *([] if opts.no_automations else ['go'])])
    app_home = Path(os.environ.get('HERDR_APP_HOME', home/'.config/herdr-app'))
    layout = ROOT/f'layouts/{LAYOUT}.json'
    install_file(layout, app_home/layout.relative_to(ROOT), backup)
    for tree in ('mods', 'icons'):
        for source in sorted((ROOT/tree).rglob('*')):
            if source.is_file():
                dest = app_home/source.relative_to(ROOT)
                # Preserve any local mod settings when refreshing a mod.
                if dest.name == 'mod.json' and dest.is_file():
                    config = json.loads(source.read_text())
                    old = json.loads(dest.read_text())
                    if 'settings' in old:
                        config['settings'] = old['settings']
                        with tempfile.TemporaryDirectory() as temp:
                            stage = Path(temp)/dest.name
                            stage.write_text(json.dumps(config, indent=2)+'\n')
                            install_file(stage, dest, backup)
                        continue
                install_file(source, dest, backup, 0o755 if source.suffix == '.py' else 0o644)
    keys = app_home/'keys.json'
    additions = json.loads((ROOT/'keys.json').read_text())
    current = json.loads(keys.read_text()) if keys.exists() else {}
    previous = json.dumps(current)
    for scope, mapping in additions.items():
        current[scope] = {**mapping, **current.get(scope, {})}
    if json.dumps(current) != previous:
        with tempfile.TemporaryDirectory() as temp:
            content = Path(temp)/'keys.json'
            content.write_text(json.dumps(current, indent=2)+'\n')
            install_file(content, keys, backup)
    share = home/'.local/share/herdr-task-spaces-refined'
    install_file(ROOT/'install.py', share/'install.py', backup)
    with tempfile.TemporaryDirectory() as temp:
        payload = Path(temp)/'host-bundle.zip'
        host_bundle(payload)
        preferences = Path(temp)/'host-options.json'
        preferences.write_text(json.dumps([flag for flag in ['no_wrapper', 'no_instructions', 'no_hooks'] if getattr(opts, flag)]))
        install_file(preferences, share/'host-options.json', backup)
        install_file(payload, share/'host-bundle.zip', backup)
    print(f'Choose {LAYOUT} in Herdr’s layout switcher.')


def record_installation(home, backup, opts):
    app_home = Path(os.environ.get('HERDR_APP_HOME', home/'.config/herdr-app'))
    flags = ['--'+name for name in ('no-wrapper', 'no-instructions', 'no-hooks', 'no-automations')
             if getattr(opts, name.replace('-', '_'))]
    with tempfile.TemporaryDirectory() as temp:
        state = Path(temp)/'installation.json'
        state.write_text(json.dumps({'release': opts.release_tag, 'flags': flags})+'\n')
        install_file(state, app_home/'data/task-spaces-refined-install.json', backup, 0o600)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument('--host', metavar='NAME', help='Install host tools on a connected Herdr machine')
    mode.add_argument('--host-only', action='store_true', help='Install host tools without any desktop files')
    for flag in ['no-wrapper', 'no-instructions', 'no-hooks', 'no-automations']:
        parser.add_argument('--'+flag, action='store_true')
    parser.add_argument('--release-tag', help='Record the GitHub Release version being installed')
    opts = parser.parse_args()
    if opts.release_tag and not re.fullmatch(r'v\d+\.\d+\.\d+', opts.release_tag):
        parser.error('--release-tag must have the format vMAJOR.MINOR.PATCH')
    if opts.host:
        preferences = ROOT/'host-options.json'
        if preferences.exists():
            for flag in json.loads(preferences.read_text()):
                setattr(opts, flag, True)
        remote_install(opts.host, opts)
        return
    home = Path.home()
    backup = home/'.local/state/herdr-task-spaces-refined/backups'/str(time.time_ns())
    backup.mkdir(parents=True, mode=0o700)
    if not opts.host_only:
        ensure_dependencies(['herdr-app', *([] if opts.no_automations else ['go'])])
    with tempfile.TemporaryDirectory(prefix='herdr-layout-build-') as temp:
        binary = None
        if not opts.host_only and not opts.no_automations:
            binary = Path(temp)/'herdr-automations'
            run(['go', '-C', str(ROOT/'host/automations'), 'build', '-o', str(binary), '.'])
        host_install(home, backup, opts)
        if not opts.host_only:
            desktop_install(home, backup, opts)
        if binary:
            install_file(binary, home/'.local/bin/herdr-automations', backup, 0o755)
        if not opts.host_only:
            record_installation(home, backup, opts)
    print(f'Installed. Rollback copies: {backup}')


if __name__ == '__main__':
    main()
