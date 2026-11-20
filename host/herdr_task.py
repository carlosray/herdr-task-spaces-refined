#!/usr/bin/env python3
"""Cooperative Herdr task/worktree ownership. No core changes or background process."""
import argparse
import contextlib
import fcntl
import json
import os
import re
import shlex
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import uuid


class TaskError(Exception):
    def __init__(self, message, **context):
        super().__init__(message)
        self.context = context


def command(argv, cwd=None, timeout=30, input=None, env=None):
    try:
        if env is None and argv[0] == 'git':
            excluded={'GIT_DIR','GIT_WORK_TREE','GIT_COMMON_DIR','GIT_INDEX_FILE','GIT_OBJECT_DIRECTORY','GIT_PREFIX'}
            env={k:v for k,v in os.environ.items() if k not in excluded}
        r = subprocess.run(argv, cwd=cwd, input=input, capture_output=True, text=True, timeout=timeout, env=env)
    except (OSError, subprocess.TimeoutExpired) as e:
        raise TaskError(f'{argv[0]} unavailable or timed out; inspect before retrying') from e
    if r.returncode:
        raise TaskError(f'{argv[0]} failed (exit {r.returncode}): {r.stderr.strip()[:300]}', definite=True)
    return r.stdout


def checkout(folder):
    p = str(Path(folder).expanduser().resolve(strict=True))
    top = str(Path(command(['git', '-C', p, 'rev-parse', '--show-toplevel']).removesuffix('\n')).resolve())
    common = str(Path(command(['git', '-C', top, 'rev-parse', '--path-format=absolute', '--git-common-dir']).removesuffix('\n')).resolve())
    gitdir = str(Path(command(['git', '-C', top, 'rev-parse', '--absolute-git-dir']).removesuffix('\n')).resolve())
    return {'folder': top, 'repo': common, 'gitdir': gitdir, 'main': common == gitdir}


def plain_directory(path):
    return {'folder': str(path), 'repo': None, 'gitdir': None, 'main': None}


def resolve_directory(folder, claims=()):
    try:
        path = Path(folder).expanduser()
    except RuntimeError as error:
        raise TaskError('Use an absolute path or an existing home directory') from error
    if not path.is_absolute():
        raise TaskError('Use an absolute directory path')
    try:
        path = path.resolve(strict=True)
    except (OSError, ValueError, RuntimeError) as error:
        raise TaskError('Choose an existing, accessible directory on this host') from error
    if not path.is_dir() or not os.access(path, os.X_OK):
        raise TaskError('Choose an existing, accessible directory on this host')

    env = {key: value for key, value in os.environ.items() if not key.startswith('GIT_')}
    selected = None
    # Inspect all physical ancestors, even when the closest repository is standalone.
    for ancestor in (path, *path.parents):
        try:
            (ancestor / '.git').lstat()
        except FileNotFoundError:
            continue
        try:
            raw = command(['git', '--no-optional-locks', '-C', str(ancestor), '-c', 'core.fsmonitor=false',
                           'rev-parse', '--path-format=absolute', '--show-toplevel', '--absolute-git-dir', '--git-common-dir'],
                          env=env, timeout=4)
            top, gitdir, common = (Path(line).resolve(strict=True) for line in raw.removesuffix('\n').split('\n'))
        except (TaskError, OSError, ValueError, RuntimeError) as error:
            raise TaskError('Could not verify the Git directory. Choose a main checkout or an existing Space.') from error
        if gitdir != common:
            raise TaskError('This directory is inside a linked worktree. Open its existing Space or add it from a task.')
        if not path.is_relative_to(top):
            raise TaskError('This directory does not belong to the detected Git checkout')
        if selected is None:
            selected = {'folder': str(top), 'repo': str(common), 'gitdir': str(gitdir), 'main': True}
    for claim in claims:
        if path.is_relative_to(Path(claim['folder']).resolve()):
            raise TaskError('This directory is reserved by a task. Open its existing Space.')
    return selected or plain_directory(path)


def matches_checkout(folder, saved):
    if not folder:
        return False
    try:
        current = checkout(folder)
    except (TaskError, OSError):
        return False
    return current['folder'] == saved['folder'] and current['gitdir'] == saved['gitdir']


def repository_main(repo, known=()):
    raw = command(['git', '--git-dir', repo, 'worktree', 'list', '--porcelain', '-z'])
    first = raw.split('\0', 1)[0]
    folders = ([first[9:]] if first.startswith('worktree ') else []) + list(known)
    if folders and Path(folders[0]).resolve() == Path(repo):
        # Separate Git metadata can lack a backlink to the primary checkout.
        with contextlib.suppress(TaskError):
            configured = command(['git', '--git-dir', repo, 'config', '--local', '--path', '--get', 'core.worktree']).removesuffix('\n')
            if configured:
                folders.append(str(Path(repo) / configured))
    for folder in folders:
        with contextlib.suppress(TaskError, OSError):
            main = checkout(folder)
            if main['main'] and main['repo'] == repo:
                return main
    raise TaskError('Git has no accessible main checkout for this repository')


class Registry:
    def __init__(self, path=None):
        self.path = Path(path or os.environ.get('HERDR_TASK_STATE', Path.home() / '.local/state/herdr-tasks/state.json'))

    def __enter__(self):
        self.path.parent.mkdir(parents=True, mode=0o700, exist_ok=True)
        self.lock = open(self.path.with_suffix('.lock'), 'a+')
        os.chmod(self.lock.name, 0o600)
        deadline = time.monotonic() + 25
        while True:
            try:
                fcntl.flock(self.lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except BlockingIOError:
                if time.monotonic() > deadline:
                    self.lock.close()
                    raise TaskError('Task registry busy; try again')
                time.sleep(.025)
        try:
            self.data = json.loads(self.path.read_text()) if self.path.exists() else {'version': 1, 'tasks': {}, 'checkouts': {}}
            if self.data.get('version') != 1 or not isinstance(self.data.get('tasks'), dict) or not isinstance(self.data.get('checkouts'), dict):
                raise TaskError('Unsupported or invalid registry; preserve it and inspect manually')
            self.before = json.dumps(self.data, sort_keys=True)
            return self
        except Exception:
            self.lock.close()
            raise

    def save(self):
        fd, tmp = tempfile.mkstemp(prefix='.state-', dir=self.path.parent)
        try:
            with os.fdopen(fd, 'w') as f:
                json.dump(self.data, f, indent=2)
                f.write('\n')
                f.flush()
                os.fsync(f.fileno())
            os.replace(tmp, self.path)
        finally:
            with contextlib.suppress(FileNotFoundError):
                os.unlink(tmp)
        self.before = json.dumps(self.data, sort_keys=True)

    def __exit__(self, kind, value, tb):
        try:
            if kind is None and json.dumps(self.data, sort_keys=True) != self.before:
                self.save()
        finally:
            self.lock.close()

    def task(self, ident):
        if ident not in self.data['tasks']:
            raise TaskError('Unknown task ID; use herdr-task snapshot')
        return self.data['tasks'][ident]

    def main_owner(self, space):
        return next((task for task in self.data['tasks'].values()
                     if task.get('main_space', {}).get('space') == space), None)

    def protect_main_binding(self, task):
        alias = task.get('main_space')
        if not alias:
            return
        sid = alias['space']
        if alias['phase'] != 'ready':
            raise TaskError('Main Space is pending; retry ensure-main before changing ownership', space=sid)
        if (any(row['space'] == sid for row in self.data.get('observed', {}).values())
                or any(live_space_details(sid))
                or has_task_root(read_app_layout()[1]['spaces'], {'id': sid, 'folder': alias['folder']})):
            raise TaskError('The task Main Space still exists; close it before changing ownership', space=sid)

    def ensure_main(self, ident):
        task = self.task(ident)
        if task.get('main') is not False or not task.get('repo'):
            raise TaskError('This task already uses its own directory or main checkout')
        if task.get('launch', {}).get('phase') not in (None, 'ready'):
            raise TaskError('Resolve the existing task launch before opening Main')
        alias = task.get('main_space')
        records = (*self.data['tasks'].values(), *self.data.get('observed', {}).values())
        known = [row['folder'] for row in records if row.get('repo') == task['repo'] and row.get('main') is True]
        if alias:
            known.insert(0, alias['folder'])
        folder = repository_main(task['repo'], known)['folder']
        retrying = alias is not None
        if alias is None:
            alias = {'space': 'sp-task-' + uuid.uuid4().hex, 'folder': folder, 'phase': 'pending'}
            task['main_space'] = alias
            self.save()
        elif alias['folder'] != folder:
            raise TaskError('Git main checkout moved; inspect the saved Main Space before changing its folder',
                            task=ident, space=alias['space'], folder=alias['folder'])
        root = {'id': alias['space'], 'name': 'Main', 'folder': folder}
        try:
            materialize_root(root, alias, 'Retry ensure-main with the same --task', guard_live=retrying)
        except TaskError as e:
            raise TaskError(str(e), **{**e.context, 'task': ident}) from e
        alias['phase'] = 'ready'
        return {'task': ident, **alias}

    def observe(self, rows, complete=False):
        """GUI reports exact visible Spaces, including kept shells with no agent."""
        old = self.data.get('observed', {})
        observed = {} if complete else dict(old)
        cache = {}
        for row in rows:
            if not isinstance(row,dict) or not isinstance(row.get('folder'),str):
                raise TaskError('Observe requires a list of {space,folder} string pairs')
            sid = row.get('space')
            if not isinstance(sid, str) or not sid or '/' in sid:
                raise TaskError('Observe requires local native Space IDs')
            try:
                task = self.data['tasks'].get(sid)
                if task and task.get('repo') is None:
                    current = Path(row['folder']).resolve()
                    if current != Path(task['folder']):
                        continue
                    c = plain_directory(current)
                else:
                    if row['folder'] not in cache:
                        try:
                            cache[row['folder']] = checkout(row['folder'])
                        except TaskError:
                            if not row.get('declared'):
                                raise
                            cache[row['folder']] = resolve_directory(row['folder'])
                    c=cache[row['folder']]
                observed[sid+'|'+c['folder']] = {'space': sid, **c, 'terminals': []}
            except (TaskError, OSError):
                observed.update({k:v for k,v in old.items() if v['space']==sid})
        self.data['observed'] = observed
        if complete:
            self.retire_disappeared(old, {row['space'] for row in rows})

    def retire_disappeared(self, previous, visible):
        candidates = set(self.data.get('closing', []))
        candidates.update(row['space'] for row in previous.values())
        protected = json.loads(os.environ.get('HERDR_PROTECTED_WORKTREES', '[]'))
        claims = {row['space']: row for row in self.data['checkouts'].values() if row['folder'] not in protected}
        closing = (candidates - visible) & claims.keys()
        if closing:
            # Keep candidates across polls if close is still in flight, the
            # host loses its document, or a terminal is still using the checkout.
            with contextlib.suppress(TaskError, OSError, ValueError, KeyError, TypeError, AttributeError):
                activity = closure_activity()
                for sid in sorted(closing):
                    if self.retire_checkout(claims[sid], activity):
                        closing.remove(sid)
        if closing:
            self.data['closing'] = sorted(closing)
        else:
            self.data.pop('closing', None)

    def retire_checkout(self, claim, activity, allow_missing=False, check_only=False, finishing=False):
        """Forget a confirmed closed linked assignment, without touching Git or Herdr."""
        sid, folder = claim['space'], claim['folder']
        task = self.task(claim['task'])
        root = task['id'] == sid
        records = (claim, task) if root else (claim,)
        if any((record.get('launch') or {}).get('phase') not in (None, 'ready', 'not-found') for record in records):
            return False
        if claim.get('detach_to') or (claim.get('close_action') and not finishing):
            return False
        if not (matches_checkout(folder, claim) or (allow_missing and not Path(folder).exists())):
            return False
        space_ids, paths = activity
        if root:
            alias = task.get('main_space')
            if alias and (alias['phase'] != 'ready' or alias['space'] in space_ids):
                return False
            if any(row['task'] == sid and row['space'] != sid for row in self.data['checkouts'].values()):
                return False
        if sid in space_ids or any(path.is_relative_to(folder) for path in paths):
            return False
        if check_only:
            return True
        del self.data['checkouts'][folder]
        if root:
            del self.data['tasks'][sid]
        return True

    def native(self, repo):
        rows = native_spaces(repo)
        known = {(r['space'],r['folder']) for r in rows}
        return rows + [r for r in self.data.get('observed', {}).values() if r['repo'] == repo and (r['space'],r['folder']) not in known]

    def add_task(self, ident, name, folder, metadata=None):
        if self.main_owner(ident):
            raise TaskError('This Space is already the Main destination of a registered task', space=ident)
        c = metadata if metadata is not None else checkout(folder)
        if ident in self.data['tasks']:
            old = self.task(ident)
            if old['folder'] != c['folder']:
                raise TaskError('Task ID already belongs to a different checkout')
            old['name'] = name
            return old
        if c['main'] is False:
            raise TaskError('Create or register a task in the main checkout, then use attach --task TASK --folder LINKED --space SPACE to adopt this linked Space')
        if self.assignment(ident):
            raise TaskError('Space is already assigned; use transfer')
        row = {**c, 'id': ident, 'name': name, 'created': int(time.time())}
        self.data['tasks'][ident] = row
        return row

    def assignment(self, space):
        return next((r for r in self.data['checkouts'].values() if r['space'] == space), None)

    def check_free(self, folder, gitdir=None):
        old = self.data['checkouts'].get(folder) or next((r for r in self.data['checkouts'].values() if gitdir and r.get('gitdir')==gitdir),None)
        if old:
            phase = old.get('launch', {}).get('phase')
            if phase == 'creating-root':
                owner = self.task(old['task'])
                raise TaskError('Checkout has an unfinished task root; retry create with the original --request-id',
                                task=owner['id'], space=old['space'], folder=old['folder'], request_id=owner['request_id'])
            if phase not in [None, 'ready']:
                raise TaskError('Checkout has an unfinished intent; use reconcile/release-checkout before retrying',space=old['space'],folder=old['folder'])
            raise TaskError(f'Checkout belongs to task {old["task"]}; transfer it explicitly')

    def claim(self, folder, task, space):
        owner = self.task(task)
        if self.main_owner(space):
            raise TaskError('This Space is already the Main destination of a registered task', space=space)
        c = checkout(folder)
        if c['main'] or c['repo'] != owner['repo']:
            raise TaskError('Attach a linked worktree of this task repository')
        old = self.data['checkouts'].get(c['folder'])
        if old and old['task'] == task and old['space'] == space:
            return old
        self.check_free(c['folder'],c.get('gitdir'))
        if space in self.data['tasks'] or self.assignment(space):
            raise TaskError('Space is already assigned; use transfer')
        row = {**c, 'task': task, 'space': space}
        self.data['checkouts'][c['folder']] = row
        return row

    def transfer(self, space, task):
        target = self.task(task)
        row = self.assignment(space)
        if row and row.get('close_action'):
            raise TaskError('Finish or cancel the pending worktree close action first')
        if not row or row['repo'] != target['repo']:
            raise TaskError('No matching worktree assignment for this task repository')
        phases=[row.get('launch',{}).get('phase'),self.data['tasks'].get(space,{}).get('launch',{}).get('phase')]
        if any(phase not in [None,'ready'] for phase in phases):
            raise TaskError('Uncertain checkout launch; reconcile before transferring',space=space,folder=row['folder'])
        if row.get('detach_to'):
            raise TaskError('Unfinished detach; retry detach before transferring', space=space, folder=row['folder'])
        if space == task:
            return row
        if space in self.data['tasks']:
            if any(r['task'] == space and r['space'] != space for r in self.data['checkouts'].values()):
                raise TaskError('Task has attached worktrees; move them separately first')
            self.protect_main_binding(self.task(space))
            del self.data['tasks'][space]
        row['task'] = task
        return row

    def detach(self, space):
        row = self.assignment(space)
        if not row:
            raise TaskError('Unknown checkout space')
        if row.get('close_action'):
            raise TaskError('Finish or cancel the pending worktree close action first')
        if space in self.data['tasks']:
            raise TaskError('Already a standalone task; reservation retained')
        owner = self.task(row['task'])
        if owner.get('detached_space') == space:
            return task_result(owner, row)
        phase = row.get('launch', {}).get('phase')
        if phase not in [None, 'ready']:
            raise TaskError('Unfinished checkout launch; resolve it before detaching', space=space, folder=row['folder'])
        anchor = repository_main(row['repo'])
        if 'detach_to' not in row:
            row['detach_to'] = 'sp-task-' + uuid.uuid4().hex
            self.save()
        root = self.add_task(row['detach_to'], owner['name'], anchor['folder'])
        root['detached_space'] = space
        materialize_root(root, row, 'Retry detach with the same --space')
        row['task'] = row.pop('detach_to')
        return task_result(root, row)


def native_spaces(repo=None):
    """Read only required public terminal metadata; do not expose argv/transcripts."""
    fleet = json.loads(command(['hc', 'ls', '--json']))
    found = {}
    for t in fleet.get('terminals', []):
        address = t.get('address', '')
        if '/' in address or t.get('state') != 'live' or not t.get('cwd'):
            continue
        try:
            c = checkout(t['cwd'])
        except (TaskError, OSError):
            continue
        if repo and c['repo'] != repo:
            continue
        detail = json.loads(command(['hc', 'get', address, '--json']))
        sid = (detail.get('labels') or {}).get('herdr.space')
        if sid:
            found.setdefault((sid,c['folder']), {'space': sid, **c, 'terminals': []})['terminals'].append(address)
        elif not c['main']:
            found.setdefault('unassigned:' + address, {'space': None, **c, 'terminals': [address]})
    return list(found.values())


def live_space_details(space):
    for terminal in json.loads(command(['hc', 'ls', '--json'])).get('terminals', []):
        address = terminal['address']
        if '/' in address or terminal.get('state') != 'live':
            continue
        detail = json.loads(command(['hc', 'get', address, '--json']))
        if (detail.get('labels') or {}).get('herdr.space') == space:
            yield address, detail


def assert_available(c, existing, allowed=None):
    if not c['main']:
        others = [r for r in existing if r['folder'] == c['folder'] and (allowed is None or r['space'] != allowed)]
        if others:
            raise TaskError('Checkout already has a native Space or unmanaged live terminal; explicitly adopt/transfer it')


def app_document(method, **params):
    req = {'jsonrpc': '2.0', 'id': 1, 'method': method, 'params': {'name': 'herdr-app', **params}}
    reply = command(['hc', 'connect'], input=json.dumps(req) + '\n', timeout=20)
    for line in reply.splitlines():
        msg = json.loads(line)
        if msg.get('id') != req['id']:
            continue
        if 'error' in msg:
            raise TaskError(f'{method} rejected: {msg["error"].get("message", "native protocol error")}')
        return msg['result']
    raise TaskError(f'{method} returned no matching reply')


def read_app_layout(require_initialized=False):
    doc = app_document('doc.get')
    version, value = doc['version'], doc['value']
    if value is None and not require_initialized:
        value = {'spaces': []}
    if type(version) is not int or not isinstance(value, dict) or not isinstance(value.get('spaces'), list):
        raise TaskError('Unexpected native app document shape')
    return version, value


def closure_activity():
    """Get authoritative host-local blockers before releasing an assignment."""
    space_ids, paths = set(), set()

    def add_folder(folder):
        if folder and Path(folder).is_absolute():
            paths.add(Path(folder).resolve())

    for terminal in json.loads(command(['hc', 'ls', '--json']))['terminals']:
        address = terminal['address']
        if '/' in address or terminal.get('state') == 'exited':
            continue
        detail = json.loads(command(['hc', 'get', address, '--json']))
        space_ids.add((detail.get('labels') or {}).get('herdr.space'))
        add_folder(detail.get('cwd'))
        add_folder((detail.get('foreground') or {}).get('cwd'))

    _, layout = read_app_layout(require_initialized=True)
    for space in layout['spaces']:
        space_ids.add(space['id'])
        add_folder(space.get('folder'))
    return space_ids, paths


def has_task_root(spaces, root):
    matches = [space for space in spaces if space['id'] == root['id']]
    if not matches:
        return False
    found = matches[0]
    folder = found.get('folder')
    if (len(matches) != 1 or not isinstance(found.get('tabs'), list)
            or not isinstance(folder, str) or not Path(folder).is_absolute()
            or Path(folder).resolve() != Path(root['folder']).resolve()):
        raise TaskError('Saved native root does not match the main checkout')
    return True


def materialize_root(root, child, retry, guard_live=False):
    """Append an empty Space with CAS. A lost reply can be retried using the same ID."""
    try:
        version, value = read_app_layout()
        if has_task_root(value['spaces'], root):
            return
        if guard_live and any(live_space_details(root['id'])):
            raise TaskError('A live Main terminal still has this ID; inspect the native Space before retrying')
        space = {k: root[k] for k in ('id', 'name', 'folder')}
        app_document('doc.set', value={**value, 'spaces': [*value['spaces'], {**space, 'tabs': []}]}, version=version)
        _, confirmed = read_app_layout()
        if not has_task_root(confirmed['spaces'], root):
            raise TaskError('Saved native root is missing after the document write')
    except (TaskError, OSError, ValueError, KeyError, TypeError, AttributeError) as e:
        context = {'task': root['id'], 'space': child['space'], 'folder': child['folder']}
        if root.get('request_id'):
            context['request_id'] = root['request_id']
        raise TaskError(f'Could not confirm the native task root. {retry}: {e}', **context) from e


def start_shell(store, sid, folder, name, record):
    """Persist intent first. An uncertain launch remains reserved for recovery."""
    record['launch'] = {'phase': 'pending', 'at': int(time.time())}
    store.save()
    try:
        result = json.loads(command(['hc', 'run', '--bg', '--json', '--keep', '--no-parent', '--outlive-parent',
            '--name', 'task-' + uuid.uuid4().hex[:12], '--cwd', folder,
            '--label', 'herdr.space=' + sid, '--label', 'herdr.tab=tb-task-' + uuid.uuid4().hex,
            '--label', 'task.space=' + sid, '--label', 'session.title=' + name]))
        address = result.get('address')
        if not isinstance(address, str) or not address.startswith('t') or '/' in address:
            raise TaskError('hc run returned no local terminal address')
        detail = json.loads(command(['hc', 'get', address, '--json']))
        if (detail.get('labels') or {}).get('herdr.space') != sid or Path(detail.get('cwd') or '').resolve() != Path(folder).resolve():
            raise TaskError('Native launch identity does not match its saved intent')
        record['launch']['phase'] = 'ready'
        store.save()
        return address
    except (TaskError, ValueError, TypeError, AttributeError) as e:
        record['launch']['phase'] = 'unknown'
        store.save()
        raise TaskError('Launch outcome uncertain; run reconcile before retrying: ' + str(e), space=sid, folder=folder) from e


def request_record(store, request_id):
    if request_id:
        records = [*store.data['tasks'].values(), *store.data['checkouts'].values()]
        return next((r for r in records if r.get('request_id') == request_id), None)


def require_ready(row, space):
    if row.get('launch', {}).get('phase') != 'ready':
        raise TaskError('Existing request has an uncertain result; reconcile it, do not relaunch', space=space, folder=row['folder'])


def request_result(store, request_id, folder, task):
    row = request_record(store, request_id)
    if row:
        if row['folder'] != folder or row.get('task') != task:
            raise TaskError('Request ID was already used with another operation')
        require_ready(row, row['space'])
        return dict(row)


def task_result(root, child=None):
    if child:
        return {**root, 'space': child['space'], 'checkout': child}
    return {**root, 'space': root['id']}


def ensure_root(store, ident):
    """Restore only a registered main/plain task's exact root; never start a shell."""
    task = store.task(ident)
    if task.get('main') is False:
        raise TaskError('Legacy linked-root task requires its existing Space or ensure-main, not ensure-root')
    launch = task.get('launch')
    if launch is not None and (not isinstance(launch, dict) or launch.get('phase') not in (None, 'ready')):
        raise TaskError('Registered task launch is pending/unknown; reconcile it before restoring its root', space=ident)
    current = resolve_directory(task['folder']) if task.get('repo') is None else checkout(task['folder'])
    if any(current.get(key) != task.get(key) for key in ('folder', 'repo', 'gitdir', 'main')):
        raise TaskError('The registered task directory identity changed; inspect before restoring its root')
    materialize_root(task, {'space': ident, 'folder': task['folder']},
                     'Retry ensure-root with the same --task', guard_live=True)
    return {'task': ident, 'space': ident, 'folder': task['folder']}


def suggest_worktree(store, repo):
    """Read-only next-slot suggestion, using the highest known slot number plus one."""
    selected = checkout(repo)
    main = repository_main(selected['repo'])
    root = Path(main['folder']); prefix = root.name
    names = [p.name for p in root.parent.iterdir()]
    listed = command(['git', '--git-dir', main['repo'], 'worktree', 'list', '--porcelain', '-z'])
    names.extend(Path(x[9:]).name for x in listed.split('\0') if x.startswith('worktree '))
    names.extend(Path(r['folder']).name for r in (*store.data['tasks'].values(), *store.data['checkouts'].values())
                 if r.get('repo') == main['repo'])
    refs = command(['git', '--git-dir', main['repo'], 'for-each-ref', '--format=%(refname)', 'refs/heads/'])
    branches = {r.removeprefix('refs/heads/') for r in refs.splitlines()}
    names.extend(branches)
    pattern = re.compile(re.escape(prefix) + r'(\d+)(?:-|$)')
    numbers = [int(match.group(1)) for name in names if (match := pattern.match(name))]
    number = max([1, *numbers]) + 1
    while True:
        name = prefix + str(number); folder = root.parent / name; branch = name + '-idle'
        if not folder.exists() and not folder.is_symlink() and branch not in branches:
            command(['git', 'check-ref-format', '--branch', branch])
            return {'folder': str(folder), 'branch': branch}
        number += 1


def create_empty_task(store, folder, name, request_id, directory=False):
    """Reserve/materialize exact empty Spaces, with no implicit terminal launch."""
    c = resolve_directory(folder, store.data['checkouts'].values()) if directory else checkout(folder)
    root = request_record(store, request_id)
    child = None
    if root:
        if not root.get('empty') or 'id' not in root:
            raise TaskError('Request ID was already used with another operation')
        if root.get('launch_space'):
            child = store.assignment(root['launch_space'])
            if not child or child['task'] != root['id']:
                raise TaskError('The original checkout assignment has changed; inspect the saved task')
        target = child or root
        if target['folder'] != c['folder'] or target['gitdir'] != c['gitdir']:
            raise TaskError('Request ID was already used with another directory')
        if target.get('launch', {}).get('phase') not in ('ready', 'creating-root'):
            raise TaskError('Unexpected empty task state; inspect its saved intent')
    else:
        if not directory:
            assert_available(c, store.native(c['repo']))
        anchor = repository_main(c['repo']) if c['main'] is False else c
        root = store.add_task('sp-task-' + uuid.uuid4().hex, name.strip() or 'Unsorted',
                              anchor['folder'], metadata=anchor if directory else None)
        root.update(empty=True, request_id=request_id or uuid.uuid4().hex,
                    launch={'phase': 'creating-root', 'at': int(time.time())})
        if c['main'] is False:
            child = store.claim(c['folder'], root['id'], 'sp-task-' + uuid.uuid4().hex)
            root['launch_space'] = child['space']
            child['launch'] = {'phase': 'creating-root', 'at': int(time.time())}
        store.save()
    retry = 'Retry create --empty with the same --request-id'
    target = child or {'space': root['id'], 'folder': root['folder']}
    materialize_root(root, target, retry)
    if child:
        materialize_root({'id': child['space'], 'name': Path(child['folder']).name,
                          'folder': child['folder']}, child, retry)
        child['launch']['phase'] = 'ready'
    root['launch']['phase'] = 'ready'
    store.save()
    return task_result(root, child)


def attach_empty(store, task, folder, request_id):
    parent = store.task(task)
    c = checkout(folder)
    if not parent.get('repo') or parent['repo'] != c['repo'] or c['main']:
        raise TaskError('Attach an existing linked checkout from the selected repository')
    row = request_record(store, request_id)
    if row:
        if ('id' in row or not row.get('empty') or row['task'] != task
                or row['folder'] != c['folder'] or row['gitdir'] != c['gitdir']):
            raise TaskError('Request ID was already used with another operation')
        if row.get('launch', {}).get('phase') == 'ready':
            return dict(row)
        if row.get('launch', {}).get('phase') != 'creating-root':
            raise TaskError('Unexpected empty checkout state; inspect the saved intent')
    else:
        assert_available(c, store.native(c['repo']))
        row = store.claim(c['folder'], task, 'sp-task-' + uuid.uuid4().hex)
        row.update(empty=True, request_id=request_id or uuid.uuid4().hex,
                   launch={'phase': 'creating-root', 'at': int(time.time())})
        store.save()
    retry = 'Retry attach --empty with the same --request-id'
    materialize_root(parent, row, retry)
    materialize_root({'id': row['space'], 'name': Path(c['folder']).name,
                      'folder': c['folder']}, row, retry)
    row['launch']['phase'] = 'ready'
    store.save()
    return dict(row)


def create_task(store, folder, name, request_id, directory=False, empty=False):
    if empty:
        return create_empty_task(store, folder, name, request_id, directory)
    c = resolve_directory(folder, store.data['checkouts'].values()) if directory else checkout(folder)
    root = request_record(store, request_id)
    child = None
    if root:
        if root.get('empty'):
            raise TaskError('Request ID belongs to an empty task; retry with --empty')
        if 'id' not in root:
            raise TaskError('Request ID was already used with another operation')
        if root.get('launch_space'):
            child = store.assignment(root['launch_space'])
            if not child or child['task'] != root['id']:
                raise TaskError('The original checkout assignment has changed; inspect the saved task')
        launch = child or root
        if launch['folder'] != c['folder'] or launch['gitdir'] != c['gitdir']:
            raise TaskError('Request ID was already used with another operation')
        if not child or child['launch']['phase'] != 'creating-root':
            require_ready(launch, launch.get('space') or root['id'])
            return task_result(root, child)
        assert_available(c, store.native(c['repo']))
    else:
        if not directory:
            assert_available(c, store.native(c['repo']))
        anchor = repository_main(c['repo']) if c['main'] is False else c
        root = store.add_task('sp-task-' + uuid.uuid4().hex, name.strip() or Path(c['folder']).name,
                              anchor['folder'], metadata=anchor if directory else None)
        root['request_id'] = request_id or uuid.uuid4().hex
        if c['main'] is False:
            child = store.claim(c['folder'], root['id'], 'sp-task-' + uuid.uuid4().hex)
            root['launch_space'] = child['space']
            child['launch'] = {'phase': 'creating-root', 'at': int(time.time())}
            store.save()

    if child:
        materialize_root(root, child, 'Retry create with the same --request-id')
    sid = child['space'] if child else root['id']
    title = Path(c['folder']).name if child else root['name']
    terminal = start_shell(store, sid, c['folder'], title, child or root)
    return {**task_result(root, child), 'terminal': terminal}


def inventory(store, repo):
    c = checkout(repo)
    live = store.native(c['repo'])
    raw = command(['git', '-C', c['folder'], 'worktree', 'list', '--porcelain', '-z'])
    rows = []
    for record in raw.split('\0\0'):
        fields = record.strip('\0').split('\0')
        path = next((s[9:] for s in fields if s.startswith('worktree ')), None)
        if not path:
            continue
        try:
            item = checkout(path)
        except (OSError, TaskError):
            continue
        claim = store.data['checkouts'].get(item['folder']) or next((r for r in store.data['checkouts'].values() if r.get('gitdir')==item['gitdir']),None)
        owners = [r for r in live if r['folder'] == item['folder']]
        rows.append({**item, **({'moved_from':claim['folder']} if claim and claim['folder']!=item['folder'] else {}), 'branch': next((s[7:].removeprefix('refs/heads/') for s in fields if s.startswith('branch ')), ''),
            'owner': claim, 'spaces': owners,
            'available': item['main'] or (not claim and not owners)})
    present = {r['folder'] for r in rows}|{r['moved_from'] for r in rows if r.get('moved_from')}
    for path, row in store.data['checkouts'].items():
        if row['repo'] == c['repo'] and path not in present:
            rows.append({**row, 'owner': row, 'spaces': [r for r in live if r['folder']==path],
                'available': False, 'missing': not Path(path).exists(), 'branch': ''})
    return {'checkouts': rows}



def repository_default_ref(task):
    main = repository_main(task['repo'])
    try:
        return command(['git', '-C', main['folder'], 'symbolic-ref', 'refs/remotes/origin/HEAD']).strip()
    except TaskError:
        # A local-only repository may not have a cached origin default.
        return command(['git', '-C', main['folder'], 'rev-parse', 'HEAD']).strip()


def close_git(claim, args):
    return command(['git', '--no-optional-locks', '-C', claim['folder'], '-c', 'core.fsmonitor=false', *args])


def close_preflight(claim, action):
    if not matches_checkout(claim['folder'], claim) or claim.get('main') is not False:
        raise TaskError('The linked checkout identity changed')
    if claim.get('detach_to') or (claim.get('launch') or {}).get('phase') not in (None, 'ready'):
        raise TaskError('The worktree has an unresolved operation')
    gitdir = Path(claim['gitdir'])
    operations = ('rebase-apply','rebase-merge','MERGE_HEAD','CHERRY_PICK_HEAD','REVERT_HEAD','sequencer','index.lock')
    if any((gitdir / item).exists() for item in operations):
        raise TaskError('A Git operation is in progress; finish it before closing the worktree')
    status = ['status', '--porcelain=v1', '--untracked-files=all']
    if action == 'delete':
        status.append('--ignored=matching')
    if close_git(claim, status):
        raise TaskError('The worktree contains changes or untracked files. Close and keep it, or clean it first.')
    branch = close_git(claim, ['symbolic-ref', '--short', 'HEAD']).strip()
    head = close_git(claim, ['rev-parse', 'HEAD']).strip()
    return branch, head


def prepare_close(store, args):
    claim = store.assignment(args.space)
    if not claim or claim['folder'] != args.folder:
        raise TaskError('The saved worktree assignment changed')
    branch, head = close_preflight(claim, args.action)
    intent = {'id': args.request_id, 'action': args.action, 'branch': branch, 'head': head}
    if args.action == 'return':
        target = args.branch.replace('{worktree}', Path(claim['folder']).name)
        close_git(claim, ['check-ref-format', '--branch', target])
        argv = shlex.split(args.command)
        if not argv:
            close_git(claim, ['show-ref', '--verify', 'refs/heads/' + target])
        intent.update(target=target, argv=argv)
    if existing := claim.get('close_action'):
        if existing != intent:
            raise TaskError('A different close action is already pending; use cancel-close-worktree first')
    claim['close_action'] = intent
    return {'prepared': intent['id']}


def finish_close(store, args):
    claim = store.assignment(args.space)
    intent = (claim or {}).get('close_action')
    if not intent or intent['id'] != args.request_id:
        raise TaskError('No matching pending worktree action')
    if not store.retire_checkout(claim, closure_activity(), check_only=True, finishing=True):
        raise TaskError('The Space or checkout is still in use; worktree action remains pending', waiting=True)
    branch, head = close_preflight(claim, intent['action'])
    if (branch, head) != (intent['branch'], intent['head']):
        raise TaskError('The worktree branch or HEAD changed after confirmation; reservation retained')
    if intent['action'] == 'return':
        if intent['argv']:
            command(intent['argv'], cwd=claim['folder'], timeout=60)
        else:
            close_git(claim, ['switch', '--no-guess', intent['target']])
        if close_preflight(claim, 'return')[0] != intent['target']:
            raise TaskError('Return command did not leave the worktree on the configured branch; reservation retained')
    else:
        main = repository_main(claim['repo'])
        # No --force: Git retains its own file, submodule and worktree locks.
        command(['git', '-C', main['folder'], 'worktree', 'remove', '--', claim['folder']])
    folder = claim['folder']
    del store.data['checkouts'][folder]
    if claim['task'] == claim['space']:
        del store.data['tasks'][claim['task']]
    return {'action': intent['action'], 'folder': folder, 'branch': intent.get('target')}


def cancel_close(store, args):
    claim = store.assignment(args.space)
    intent = (claim or {}).get('close_action')
    if not intent or intent['id'] != args.request_id:
        raise TaskError('No matching pending worktree action')
    del claim['close_action']
    return {'cancelled': args.request_id}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest='verb', required=True)
    sub.add_parser('snapshot', help='Read persistent assignments; never infer release from live status')
    p = sub.add_parser('observe', help='Sync visible host-local Spaces and verify closed linked assignments')
    p.add_argument('--json', required=True)
    p.add_argument('--complete',action='store_true',help='Replace observations only from a fully ready host document; default merges')
    p = sub.add_parser('inventory', help='List checkouts, assignment and native occupancy on this host')
    p.add_argument('--repo', required=True)
    p = sub.add_parser('resolve-directory', help='Resolve a plain directory or main checkout on this host')
    path = p.add_mutually_exclusive_group(required=True)
    path.add_argument('--folder')
    path.add_argument('--repo', help='Resolve main using its registered Git common directory')
    p = sub.add_parser('ensure-root', help='Restore the exact registered main/plain task root without a shell')
    p.add_argument('--task', required=True)
    p = sub.add_parser('suggest-worktree', help='Suggest a new sibling/idle branch, without reserving or creating')
    p.add_argument('--repo', required=True)
    p = sub.add_parser('ensure-main', help='Open an empty Main destination for an existing linked-root task')
    p.add_argument('--task', required=True)
    for verb in ['create', 'register']:
        p = sub.add_parser(verb, help='Create a task shell' if verb == 'create' else 'Adopt an exact existing native Space as a task')
        p.add_argument('--folder', required=True)
        p.add_argument('--name', required=True)
        if verb == 'create':
            p.add_argument('--request-id', help='Stable caller operation ID; prevents duplicate launches on retry')
            p.add_argument('--empty', action='store_true', help='Materialize empty task/child Spaces without a shell')
            p.add_argument('--directory', action='store_true', help='Create in an existing plain directory or Git main checkout')
        if verb == 'register': p.add_argument('--space', required=True)
    p = sub.add_parser('attach', help='Attach a free checkout, or explicitly adopt its existing native Space')
    p.add_argument('--task', required=True); p.add_argument('--folder', required=True); p.add_argument('--space'); p.add_argument('--request-id')
    p.add_argument('--empty', action='store_true', help='Assign/materialize the checkout without a shell')
    p = sub.add_parser('transfer', help='Transfer an assigned checkout Space, preserving all native sessions')
    p.add_argument('--space', required=True); p.add_argument('--to', required=True)
    p = sub.add_parser('detach', help='Turn attached checkout into a standalone task; it stays reserved')
    p.add_argument('--space', required=True)
    p = sub.add_parser('release', help='Forget a closed task with no live terminals or attached worktrees')
    p.add_argument('--task', required=True)
    p = sub.add_parser('new-worktree', help='Create a new Git worktree and attach it; does not fetch/reset')
    p.add_argument('--task', required=True); p.add_argument('--folder', required=True); p.add_argument('--branch', required=True)
    p.add_argument('--start-point'); p.add_argument('--request-id')
    p = sub.add_parser('reconcile', help='Resolve a saved launch intent without starting another process')
    p.add_argument('--space', required=True)
    p = sub.add_parser('release-checkout', help='Explicitly forget a missing/closed child assignment after checking native identity')
    p.add_argument('--space', required=True)
    p = sub.add_parser('prepare-close-worktree', help='Record an explicitly selected close action before closing the Space')
    p.add_argument('--space', required=True); p.add_argument('--folder', required=True); p.add_argument('--request-id', required=True)
    p.add_argument('--action', required=True, choices=['return', 'delete'])
    p.add_argument('--branch', default='{worktree}-idle'); p.add_argument('--command', default='')
    for verb in ('finish-close-worktree', 'cancel-close-worktree'):
        p = sub.add_parser(verb)
        p.add_argument('--space', required=True); p.add_argument('--request-id', required=True)
    args = parser.parse_args(argv)
    try:
        if args.verb == 'resolve-directory':
            resolved = repository_main(str(Path(args.repo).resolve())) if args.repo else resolve_directory(args.folder)
            print(json.dumps(resolved, ensure_ascii=False))
            return 0
        with Registry() as s:
            if args.verb == 'prepare-close-worktree':
                result = prepare_close(s, args)
            elif args.verb == 'finish-close-worktree':
                result = finish_close(s, args)
            elif args.verb == 'cancel-close-worktree':
                result = cancel_close(s, args)
            elif args.verb == 'snapshot':
                result = s.data
            elif args.verb == 'observe':
                rows = json.loads(args.json)
                if not isinstance(rows, list):
                    raise TaskError('Expected a JSON list of {space,folder}')
                s.observe(rows,complete=args.complete)
                result = s.data
            elif args.verb == 'inventory':
                result = inventory(s, args.repo)
            elif args.verb == 'create':
                result = create_task(s, args.folder, args.name, args.request_id, directory=args.directory, empty=args.empty)
            elif args.verb == 'ensure-root':
                result = ensure_root(s, args.task)
            elif args.verb == 'suggest-worktree':
                result = suggest_worktree(s, args.repo)
            elif args.verb == 'ensure-main':
                result = s.ensure_main(args.task)
            elif args.verb == 'register':
                c = checkout(args.folder)
                sid = args.space
                row = s.add_task(sid, args.name.strip() or Path(c['folder']).name, c['folder'])
                current = s.native(c['repo'])
                if not any(r['space'] == sid and r['folder'] == c['folder'] for r in current):
                    raise TaskError('Existing native Space does not match this checkout')
                assert_available(c, current, sid)
                result = dict(row)
            elif args.verb in ['attach', 'new-worktree']:
                if getattr(args, 'empty', False):
                    if args.space:
                        raise TaskError('Use --empty for a new native child, or --space to adopt an existing one')
                    result = attach_empty(s, args.task, args.folder, args.request_id)
                    print(json.dumps(result));return 0
                task = s.task(args.task)
                if not task.get('repo'):
                    raise TaskError('This task has a directory instead of a Git repository')
                intended = checkout(args.folder)['folder'] if args.verb=='attach' else str(Path(args.folder).expanduser().resolve())
                repeated = request_result(s, args.request_id, intended, args.task)
                if repeated:
                    print(json.dumps(repeated));return 0
                sid = getattr(args, 'space', None) or 'sp-task-' + uuid.uuid4().hex
                if args.verb == 'new-worktree':
                    if checkout(task['folder'])['repo'] != task['repo']:
                        raise TaskError('The task folder no longer belongs to its saved Git repository')
                    if Path(args.folder).expanduser().exists() or args.branch.startswith('-'):
                        raise TaskError('Use a new folder and a valid new branch name')
                    command(['git', '-C', task['folder'], 'check-ref-format', '--branch', args.branch])
                    if command(['git','-C',task['folder'],'branch','--list','--format=%(refname)',args.branch]).strip():
                        raise TaskError('Branch already exists; choose a new branch or attach its existing worktree')
                    start=command(['git', '-C', task['folder'], 'rev-parse', '--verify', '--end-of-options', (args.start_point or repository_default_ref(task)) + '^{commit}']).strip()
                    existing=command(['git','-C',task['folder'],'worktree','list','--porcelain','-z'])
                    if any(Path(intended).is_relative_to(Path(x[9:]).resolve()) for x in existing.split('\0') if x.startswith('worktree ')):
                        raise TaskError('Create a worktree outside existing checkout directories')
                    s.check_free(intended)
                    # Reserve before Git or hc mutations; retain intent on any failure.
                    pending={'folder':intended,'repo':task['repo'],'main':False,'task':args.task,'space':sid,
                        'request_id':args.request_id or uuid.uuid4().hex,'launch':{'phase':'creating-checkout','at':int(time.time())}}
                    s.data['checkouts'][intended]=pending;s.save()
                    try:
                        command(['git', '-C', task['folder'], 'worktree', 'add', '-b', args.branch, intended, start])
                    except TaskError as e:
                        if e.context.get('definite') and not Path(intended).exists():
                            listed=command(['git','-C',task['folder'],'worktree','list','--porcelain','-z'])
                            if ('worktree '+intended+'\0') not in listed:
                                del s.data['checkouts'][intended];s.save()
                        raise TaskError(str(e), space=sid,folder=intended) from e
                    pending.update(checkout(intended));pending['start_point_commit']=start
                    pending['launch']['phase']='checkout-created';s.save()
                c = checkout(args.folder)
                current = s.native(c['repo'])
                existing_sid = getattr(args, 'space', None)
                if existing_sid and not any(r['space'] == existing_sid and r['folder'] == c['folder'] for r in current):
                    raise TaskError('Exact native Space does not match this checkout')
                assert_available(c, current, existing_sid)
                row = s.claim(c['folder'], args.task, sid)
                if not existing_sid:
                    row['request_id'] = args.request_id or row.get('request_id') or uuid.uuid4().hex
                    terminal = start_shell(s, sid, c['folder'], Path(c['folder']).name, row)
                    result = {**row, 'terminal': terminal}
                else: result=dict(row)
            elif args.verb == 'transfer':
                result=dict(s.transfer(args.space, args.to))
            elif args.verb == 'detach':
                result = s.detach(args.space)
            elif args.verb == 'release':
                task = s.task(args.task)
                direct = s.assignment(args.task)
                s.protect_main_binding(task)
                if any(r['task'] == args.task and r['space'] != args.task for r in s.data['checkouts'].values()):
                    raise TaskError('Detach/transfer attached worktrees before release')
                if task['repo'] is None:
                    visible = any(r['space'] == args.task for r in s.data.get('observed', {}).values())
                    occupied = visible or any(live_space_details(args.task))
                else:
                    occupied = any(r['space'] == args.task for r in s.native(task['repo']))
                if occupied:
                    raise TaskError('The task Space still exists; close it before release')
                if direct and direct['task'] == args.task:
                    if not s.retire_checkout(direct, closure_activity(), allow_missing=True):
                        raise TaskError('The linked task closure could not be confirmed; reservation retained')
                else:
                    s.data['tasks'].pop(args.task)
                result = {'released': args.task}
            elif args.verb in ['reconcile', 'release-checkout']:
                row=s.data['tasks'].get(args.space) or s.assignment(args.space)
                if not row:raise TaskError('Unknown saved Space')
                if row.get('close_action'):
                    raise TaskError('Finish or cancel the pending worktree close action first')
                if row.get('detach_to'):
                    raise TaskError('Unfinished detach; retry detach with the same --space', space=args.space, folder=row['folder'])
                if args.verb == 'reconcile':
                    if row.get('launch_space') or row.get('detached_space'):
                        raise TaskError('This task root has no saved shell launch; use its checkout Space to reconcile',
                                        space=args.space, folder=row['folder'])
                    if row.get('launch', {}).get('phase') == 'creating-root':
                        raise TaskError('Native shell launch has not started; retry create with the original --request-id',
                                        space=args.space, folder=row['folder'])
                if args.verb=='reconcile' and row.get('gitdir'):
                    raw=command(['git','--git-dir',row['repo'],'worktree','list','--porcelain','-z'])
                    for entry in raw.split('\0'):
                        if not entry.startswith('worktree '):continue
                        try:c=checkout(entry[9:])
                        except (TaskError,OSError):continue
                        if c['gitdir']==row['gitdir'] and c['folder']!=row['folder']:
                            old=row['folder']
                            if old in s.data['checkouts']:
                                claim=s.data['checkouts'].pop(old);claim.update(c);s.data['checkouts'][c['folder']]=claim
                            row.update(c)
                            break
                # Release guards on the exact label even if its recorded cwd disappeared.
                matches = []
                wrong_cwd = False
                owner = s.data['tasks'].get(row.get('task'), {})
                check_cwd = args.verb == 'reconcile' and owner.get('launch_space') == args.space
                for address, detail in live_space_details(args.space):
                    cwd = detail.get('cwd')
                    plain_mismatch = (args.verb == 'reconcile' and row.get('repo') is None
                                      and not (cwd and Path(cwd).resolve().is_relative_to(row['folder'])))
                    if plain_mismatch or (check_cwd and not matches_checkout(cwd, row)):
                        wrong_cwd = True
                    else:
                        matches.append(address)
                if args.verb=='reconcile':
                    if wrong_cwd and not matches:
                        raise TaskError('The native Space is live in a different checkout; reservation retained',
                                        space=args.space, folder=row['folder'])
                    row['launch']={'phase':'ready' if matches else 'not-found','at':int(time.time())}
                    result={**row,'terminals':matches}
                else:
                    if matches or any(r['space']==args.space for r in s.data.get('observed',{}).values()):raise TaskError('Native Space still exists; close it or transfer it')
                    if args.space in s.data['tasks']:raise TaskError('Use release for a task root')
                    result=s.data['checkouts'].pop(row['folder'])
        print(json.dumps(result, ensure_ascii=False))
        return 0
    except (TaskError, OSError, ValueError, KeyError, TypeError, AttributeError) as e:
        print(json.dumps({'error': str(e), **getattr(e,'context',{})}, ensure_ascii=False))
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
