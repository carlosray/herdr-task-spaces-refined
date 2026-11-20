import importlib.util
from pathlib import Path
import subprocess
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

path = Path(__file__).resolve().parents[1] / 'host/herdr_task.py'
spec = importlib.util.spec_from_file_location('task_backend', path)
backend = importlib.util.module_from_spec(spec)
spec.loader.exec_module(backend)


class CloseTests(unittest.TestCase):
    def git(self, cwd, *args):
        return subprocess.check_output(['git', '-C', str(cwd), *args], stderr=subprocess.PIPE, text=True).strip()

    def test_close_actions_preserve_branches_and_hold_pending_claims(self):
        with tempfile.TemporaryDirectory() as root:
            top = Path(root)
            main, work = top/'main', top/'work'
            main.mkdir()
            self.git(main, 'init', '-b', 'main')
            self.git(main, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--allow-empty', '-m', 'Base')
            self.git(main, 'branch', 'work-idle')
            self.git(main, 'worktree', 'add', '-b', 'feature', str(work))
            with backend.Registry(top/'state.json') as store, patch.object(backend, 'closure_activity') as activity:
                store.add_task('root', 'Example', str(main))
                claim = store.claim(str(work), 'root', 'child')
                args = SimpleNamespace(space='child', folder=str(work), request_id='one', action='return', branch='{worktree}-idle', command='')
                backend.prepare_close(store, args)
                self.assertFalse(store.retire_checkout(claim, (set(), set())))
                activity.return_value = ({'child'}, {work})
                with self.assertRaises(backend.TaskError):
                    backend.finish_close(store, args)
                activity.return_value = (set(), set())
                backend.finish_close(store, args)
                self.assertEqual(self.git(work, 'branch', '--show-current'), 'work-idle')
                self.assertEqual(self.git(main, 'branch', '--list', 'feature').strip(), 'feature')
                self.assertIsNone(store.assignment('child'))
                store.claim(str(work), 'root', 'child')
                args.action = 'delete'
                (work/'untracked').write_text('keep')
                with self.assertRaises(backend.TaskError):
                    backend.prepare_close(store, args)
                (work/'untracked').unlink()
                backend.prepare_close(store, args)
                backend.finish_close(store, args)
                self.assertFalse(work.exists())
                self.assertTrue(self.git(main, 'branch', '--list', 'work-idle'))


if __name__ == '__main__':
    unittest.main()
