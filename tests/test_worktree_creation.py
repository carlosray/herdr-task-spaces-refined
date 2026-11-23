from pathlib import Path
import subprocess
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from test_close import backend


class WorktreeCreationTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.top = Path(temp.name).resolve()
        self.main = self.top / 'main'
        self.main.mkdir()
        self.git('init', '-b', 'main')
        self.git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
                 'commit', '--allow-empty', '-m', 'Base')
        self.registry = self.top / 'state.json'
        with backend.Registry(self.registry) as store:
            self.task = store.add_task('root', 'Example', str(self.main))
        self.calls = []
        self.patch(backend, 'native_spaces', return_value=[])
        self.patch(backend, 'read_app_layout', return_value=(1, {'spaces': []}))
        self.patch(backend, 'live_space_details', return_value=[])
        self.patch(backend, 'start_shell', side_effect=self.start_shell)

    def patch(self, target, name, **options):
        context = patch.object(target, name, **options)
        self.addCleanup(context.stop)
        return context.start()

    def start_shell(self, store, sid, folder, name, row):
        self.calls.append(sid)
        row['launch']['phase'] = 'ready'
        store.save()
        return 't42'

    def git(self, *args):
        return subprocess.check_output(['git', '-C', str(self.main), *args],
                                       stderr=subprocess.PIPE, text=True).strip()

    def args(self, name='work'):
        return SimpleNamespace(task='root', folder=str(self.top / name), branch=name + '-idle',
                               start_point=None, request_id=name)

    def test_lost_git_reply_reuses_a_completed_worktree(self):
        call = backend.command
        adds = []

        def interrupted(argv, *args, **kwargs):
            result = call(argv, *args, **kwargs)
            if argv[3:5] == ['worktree', 'add']:
                adds.append(argv)
                raise backend.TaskError('git timed out')
            return result

        with patch.object(backend, 'command', side_effect=interrupted):
            with backend.Registry(self.registry) as store:
                row = backend.new_worktree(store, self.args())
            with backend.Registry(self.registry) as store:
                self.assertEqual(backend.new_worktree(store, self.args())['space'], row['space'])
        self.assertEqual(len(adds), 1)
        self.assertEqual(self.calls, [row['space']])
        self.assertEqual(row['launch']['phase'], 'ready')

    def test_retry_keeps_the_reserved_identity_and_other_worktrees_work(self):
        call = backend.command

        def unavailable(argv, *args, **kwargs):
            if argv[3:5] == ['worktree', 'add']:
                raise backend.TaskError('git timed out')
            return call(argv, *args, **kwargs)

        with patch.object(backend, 'command', side_effect=unavailable):
            with self.assertRaisesRegex(backend.TaskError, 'git timed out'):
                with backend.Registry(self.registry) as store:
                    backend.new_worktree(store, self.args())
        with backend.Registry(self.registry) as store:
            saved = store.data['checkouts'][str(self.top / 'work')]
            self.assertEqual(saved['creation']['branch'], 'work-idle')
            self.assertEqual(saved['creation']['start'], self.git('rev-parse', 'HEAD'))
            other = backend.new_worktree(store, self.args('other'))
            row = backend.resume_worktree(store, saved['space'])
            self.assertEqual(row['space'], saved['space'])
            self.assertNotEqual(other['space'], row['space'])
        self.assertEqual(len(self.calls), 2)

    def test_legacy_pending_checkout_is_recovered_without_recreating_it(self):
        folder = str(self.top / 'work')
        self.git('worktree', 'add', '-b', 'work-idle', folder)
        with backend.Registry(self.registry) as store:
            store.data['checkouts'][folder] = {'folder': folder, 'repo': self.task['repo'],
                'main': False, 'task': 'root', 'space': 'child', 'request_id': 'old',
                'launch': {'phase': 'creating-checkout'}}
            row = backend.resume_worktree(store, 'child')
            self.assertEqual(row['space'], 'child')
            self.assertEqual(row['gitdir'], backend.checkout(folder)['gitdir'])
            self.assertEqual(row['launch']['phase'], 'ready')
        self.assertEqual(self.calls, ['child'])

    def test_legacy_pending_checkout_with_an_existing_native_space_is_not_relaunched(self):
        folder = str(self.top / 'work')
        self.git('worktree', 'add', '-b', 'work-idle', folder)
        with backend.Registry(self.registry) as store:
            store.data['checkouts'][folder] = {**backend.checkout(folder), 'task': 'root', 'space': 'child',
                'start_point_commit': self.git('rev-parse', 'HEAD'), 'launch': {'phase': 'unknown'}}
            with patch.object(backend, 'read_app_layout', return_value=(1, {'spaces': [
                {'id': 'child', 'folder': folder, 'tabs': [{'id': 'already-there'}]},
            ]})):
                row = backend.resume_worktree(store, 'child')
            self.assertEqual(row['launch']['phase'], 'ready')
        self.assertEqual(self.calls, [])

    def test_interrupted_checkout_with_local_changes_is_preserved(self):
        folder = self.top / 'work'
        self.git('worktree', 'add', '-b', 'work-idle', str(folder))
        (folder / 'user-file').write_text('preserve')
        with backend.Registry(self.registry) as store:
            store.data['checkouts'][str(folder)] = {'folder': str(folder), 'repo': self.task['repo'],
                'main': False, 'task': 'root', 'space': 'child', 'launch': {'phase': 'creating-checkout'}}
            with self.assertRaisesRegex(backend.TaskError, 'incomplete or has local changes'):
                backend.resume_worktree(store, 'child')
            self.assertEqual(store.assignment('child')['launch']['phase'], 'creating-checkout')
        self.assertEqual((folder / 'user-file').read_text(), 'preserve')
        self.assertEqual(self.calls, [])

    def test_retry_handles_a_saved_branch_without_a_checkout(self):
        call = backend.command

        def interrupted(argv, *args, **kwargs):
            if argv[3:5] == ['worktree', 'add']:
                self.git('branch', 'work-idle')
                raise backend.TaskError('git timed out after writing the branch')
            return call(argv, *args, **kwargs)

        with patch.object(backend, 'command', side_effect=interrupted):
            with self.assertRaisesRegex(backend.TaskError, 'git timed out'):
                with backend.Registry(self.registry) as store:
                    backend.new_worktree(store, self.args())
        with backend.Registry(self.registry) as store:
            row = backend.new_worktree(store, self.args())
        self.assertFalse(row['main'])
        self.assertEqual(self.calls, [row['space']])
