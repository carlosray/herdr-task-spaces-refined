"""Render the real Herdr desktop with a disposable core, workspace, and app home."""
import argparse
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import time

from preview_scenarios import SCREENS


LAYOUT = 'task-spaces-refined'
PANELS = {'files', 'changes', 'merge-requests', 'automations'}
DIALOGS = {'new-task': 'task-spaces-refined', 'launcher': 'agent-launcher-refined',
           'recent': 'session-recent-refined', 'settings': 'better-config-refined',
           'worktree-settings': 'worktree-close-refined'}
FROZEN_SERVICES = {'task-spaces-service', 'merge-requests-service'}
CONTROL = """
import { View, div } from 'gpui-kit';
import { appHome, closeOverlay, openOverlay, props, readTextFile, setShared } from 'herdr';
export default class Preview extends View {
  init(_, cx) {
    const id = props().overlay;
    cx.spawn(async () => {
      const step = JSON.parse(await readTextFile(appHome() + '/mods/preview-control/step.json'));
      for (const [key, value] of Object.entries(step.shared ?? {})) setShared(key, value);
      closeOverlay(id);
      if (step.overlay) openOverlay(step.overlay);
    });
  }
  render() { return div().size(0); }
}
"""


def write_json(path, data):
    path.write_text(json.dumps(data))


def fixture_layout(node):
    if isinstance(node, dict):
        if 'children' in node:
            node['children'] = [child for child in node['children'] if child.get('id') not in FROZEN_SERVICES]
        for value in node.values():
            fixture_layout(value)
    elif isinstance(node, list):
        for value in node:
            fixture_layout(value)


def wait_for(predicate, timeout=25):
    end = time.monotonic() + timeout
    last_error = None
    while time.monotonic() < end:
        try:
            if result := predicate():
                return result
        except (OSError, ValueError, subprocess.SubprocessError) as error:
            last_error = error
        time.sleep(0.15)
    raise RuntimeError('Herdr did not reach the expected fixture state') from last_error


def capture(source, output, names, scratch, session):
    home, app = scratch / 'demo', scratch / 'app'
    repo, checkout = home / 'Projects/orbit', home / 'Projects/orbit-recovery'
    control = app / 'mods/preview-control'
    for path in (app / 'layouts', repo, checkout, home / '.local/bin', scratch / 'runtime'):
        path.mkdir(parents=True)
    (scratch / 'runtime').chmod(0o700)
    output.mkdir(parents=True, exist_ok=True)
    herdr, hc = (shutil.which(tool) for tool in ('herdr-app', 'hc'))
    if not herdr or not hc:
        raise RuntimeError('herdr-app and hc are required on PATH')
    # Give the demo neither live Herdr state nor automation/provider credentials.
    env = {key: os.environ[key] for key in ('PATH', 'DISPLAY', 'XAUTHORITY',
           'VK_DRIVER_FILES', 'VK_ICD_FILENAMES', 'LIBGL_ALWAYS_SOFTWARE') if key in os.environ}
    env.update(HOME=str(home), SHELL='/bin/sh', USER='demo', LANG='C.UTF-8', TZ='UTC',
               HERDR_APP_HOME=str(app), HC_SESSION=session, HERDR_TELEMETRY='0', HERDR_APP_NO_SOUND='1',
               GIT_CONFIG_NOSYSTEM='1', GIT_CONFIG_GLOBAL='/dev/null', XDG_RUNTIME_DIR=str(scratch / 'runtime'),
               **{f'XDG_{key}_HOME': str(scratch / key.lower()) for key in ('CONFIG', 'STATE', 'DATA', 'CACHE')})
    env['PATH'] = str(home / '.local/bin') + os.pathsep + env['PATH']

    def call(*args, check=True):
        return subprocess.run(args, env=env, cwd=home, capture_output=True, text=True, timeout=12, check=check)

    def get(*args):
        return json.loads(call(*args).stdout)

    def action(command, **kwargs):
        call(herdr, 'do', command, json.dumps(kwargs))

    def status():
        return get(herdr, 'status')

    def close_overlays():
        for _ in status()['overlays']:
            action('overlay.close')
        wait_for(lambda: not status()['overlays'])

    def fixture_control(**step):
        write_json(control / 'step.json', step)
        action('mod.open', name='preview-control')

    for tree in ('mods', 'icons'):
        shutil.copytree(source / tree, app / tree)
    shutil.copy2(source / 'keys.json', app / 'keys.json')
    layout = json.loads((source / f'layouts/{LAYOUT}.json').read_text())
    fixture_layout(layout)
    write_json(app / f'layouts/{LAYOUT}.json', layout)
    # Treat this as a settled workspace rather than showing a first-launch update pill.
    write_json(app / 'update-notes.json', {'last_run': call(herdr, '--version').stdout.split()[-1]})
    write_json(app / 'settings.json', {'appearance': 'dark', 'zoom': 1, 'telemetry': False})
    write_json(app / 'window.json', {'state': 'normal', 'bounds': [30, 45, 1280, 800]})
    write_json(app / 'shared.json', {'frame.welcomed': 'skipped'})
    write_json(app / 'seen.json', ['frame-welcome', 'frame-whatsnew'])
    control.mkdir()
    write_json(control / 'mod.json', {'place': 'none', 'title': 'Preview control',
                                    'overlay': {'kind': 'popup', 'width': 120, 'height': 50}})
    (control / 'main.js').write_text(CONTROL)

    for folder, branch in ((repo, 'main'), (checkout, 'feature/session-recovery')):
        call('git', 'init', '-q', '-b', branch, str(folder))
        (folder / 'README.md').write_text('# Orbit\n\nA notebook for field research.\n')
        (folder / 'sessions.py').write_text('def restore(store, session_id):\n    return store.get(session_id)\n')
        call('git', '-C', str(folder), 'add', 'README.md', 'sessions.py')
        call('git', '-C', str(folder), '-c', 'user.name=Demo', '-c', 'user.email=demo@example.test',
             'commit', '-qm', 'Fixture baseline')
    (repo / 'sessions.py').write_text('def restore(store, session_id):\n    return store.resume(session_id)\n')
    for tool in ('codex', 'claude', 'pi', 'opencode'):
        stub = home / '.local/bin' / tool
        stub.write_text('#!/bin/sh\nprintf "%s\\n" "Fixture agent"\n')
        stub.chmod(0o755)
    automation_rows = {'automations': [{'name': 'Check notebooks', 'manual': True, 'agent': 'codex',
                                        'prompt': 'Run the fixture checks'}], 'scheduler': True}
    stub = home / '.local/bin/herdr-automations'
    stub.write_text("#!/bin/sh\ncase \"$1\" in\n"
                    f"ls) printf '%s\\n' '{json.dumps(automation_rows)}';;\n"
                    "history) printf '%s\\n' '[]';;\n*) exit 1;;\nesac\n")
    stub.chmod(0o755)

    def demo_argv(tool, state):
        program = 'claude-code' if tool == 'claude' else tool
        text = (f'\x1b]7501;state={state}:app={program}\x1b\\'
                '\x1b[1;36mOrbit\x1b[0m  /  Engineering workspace\n\n'
                'Session recovery\n\n'
                '  ✓ Preserve the session ID and working directory\n'
                '  ✓ Reuse the checkout when it is still open\n\n'
                '$ python -m unittest\n  Ran 8 tests · OK\n\n'
                '› Review the recovery path with a fresh session.\n')
        return ['python3', '-I', '-c', 'import sys,time; print(sys.argv[1],flush=True); time.sleep(240)', text]

    def find_tab(space_name, tab_name):
        return next(((space['id'], tab) for space in get(herdr, 'ls')['spaces'] if space['name'] == space_name
                     for tab in space['tabs'] if tab['name'] == tab_name and tab['terminals']), None)

    def register(space_name, tab_name, tool):
        space, tab = wait_for(lambda: find_tab(space_name, tab_name))
        call(hc, 'label', tab['terminals'][0]['terminal'], f'agent.tool={tool}', f'session.title={tab_name}')
        return space, tab['id']

    log = scratch / 'window.log'
    get(hc, 'server', '--json', 'status')
    window = None
    try:
        with log.open('w') as stream:
            window = subprocess.Popen([herdr], env=env, cwd=home, stdin=subprocess.DEVNULL, stdout=stream, stderr=stream)
            wait_for(status)
            action('layout.switch', name=LAYOUT)
            wait_for(lambda: status()['layout'] == LAYOUT)
            close_overlays()
            for space_name, folder, title, tool, state in (
                ('Session recovery', repo, 'Coordinator', 'codex', 'idle'),
                ('orbit-recovery', checkout, 'Review recovery', 'claude', 'done'),
                ('Notebook search', repo, 'Search index', 'pi', 'blocked'),
            ):
                action('space.new', name=space_name, folder=str(folder), tab=title, argv=demo_argv(tool, state))
                register(space_name, title, tool)
            main_space, _ = wait_for(lambda: find_tab('Session recovery', 'Coordinator'))
            tree, _ = wait_for(lambda: find_tab('orbit-recovery', 'Review recovery'))
            second, _ = wait_for(lambda: find_tab('Notebook search', 'Search index'))
            action('tab.new', space=main_space, folder=str(repo), name='Recovery tests',
                   argv=demo_argv('codex', 'working'))
            _, tests_tab = register('Session recovery', 'Recovery tests', 'codex')
            tasks = {key: {'id': key, 'name': title, 'repo': str(repo / '.git'), 'folder': str(repo), 'main': True}
                     for key, title in ((main_space, 'Session recovery'), (second, 'Notebook search'))}
            claim = {'task': main_space, 'space': tree, 'folder': str(checkout), 'main': False, 'repo': str(repo / '.git')}
            request_space = {'id': tree, 'name': 'orbit-recovery', 'machine': None}
            request = {'number': 42, 'id': 'preview-42', 'title': 'Keep the saved session ID',
                       'repository': 'demo/orbit', 'provider': 'github', 'state': 'OPEN',
                       'url': 'https://github.com/demo/orbit/pull/42', 'headRefName': 'feature/session-recovery',
                       'baseRefName': 'main', 'spaces': [request_space], 'isDraft': False}
            fixture_control(shared={
                'task-spaces.hosts': {'local': {'tasks': tasks, 'checkouts': {str(checkout): claim}}},
                'better-sidebar.merge-requests': {'requests': [request], 'spaces': [request_space],
                                                 'loading': [], 'unavailable': [], 'open': {tree: 1}},
            })
            action('tab.select', id=tests_tab)
            wait_for(lambda: not status()['overlays'] and status()['tab'] == tests_tab)
            time.sleep(1.3)
            action('layout.resize', id='sidebar', px=296)
            action('layout.resize', id='panel', px=364)
            for name in names:
                if name in PANELS:
                    action('layout.select', stack='panel-body', child=name)
                    action('layout.show', id='panel')
                else:
                    action('layout.hide', id='panel')
                if name in DIALOGS:
                    mod = DIALOGS[name]
                    if name in ('launcher', 'worktree-settings'):
                        args = ({'space': main_space, 'strictSpace': True, 'fixedSpace': True}
                                if name == 'launcher' else
                                {'mode': 'settings', 'folder': str(repo), 'repo': str(repo / '.git')})
                        fixture_control(overlay={'mod': mod, 'kind': 'dialog', 'width': 500, 'height': 370, 'props': args})
                    else:
                        action('mod.open', name=mod)
                    wait_for(lambda: len(status()['overlays']) == 1 and mod in status()['overlays'])
                time.sleep(1.1)
                errors = status()['errors']
                if errors:
                    raise RuntimeError(f'{name}: {errors}')
                call(herdr, 'shot', str(output / f'{name}.png'))
                if name in DIALOGS:
                    close_overlays()
                print(f'Captured {name}: {output / f"{name}.png"}', flush=True)
    except Exception:
        if log.exists():
            print(log.read_text(errors='replace')[-5000:])
        if window and window.poll() is None:
            print(call(herdr, 'status', check=False).stdout)
        raise
    finally:
        if window and window.poll() is None:
            window.terminate()
            try:
                window.wait(timeout=8)
            except subprocess.TimeoutExpired:
                window.kill()
                window.wait(timeout=3)
        call(hc, 'server', 'stop', check=False)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('before', type=Path)
    parser.add_argument('after', type=Path)
    parser.add_argument('output', type=Path)
    parser.add_argument('screens', choices=tuple(SCREENS), nargs='+')
    args = parser.parse_args()
    with tempfile.TemporaryDirectory(prefix='herdr-preview-') as temp:
        fixture = Path(temp) / 'fixture'
        for side, source in (('before', args.before), ('after', args.after)):
            capture(source.resolve(), (args.output / side).resolve(), args.screens, fixture,
                    f'{Path(temp).name}-{side}')
            shutil.rmtree(fixture)
