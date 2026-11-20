import io
import os
from pathlib import Path
import struct
import sys
from unittest import TestCase
from unittest.mock import patch
import zipfile

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / '.github/ci'))
from preview_scenarios import scenarios_for
from preview_evidence import missing_evidence
import review
from review import image_pairs, matching_pull


class PRChecksTests(TestCase):
    def test_pr_has_distinct_author_images_in_each_section(self):
        before = 'https://github.com/user-attachments/assets/3bba3fee-22d0-4da0-941b-915ae64fbe07'
        after = 'https://github.com/user-attachments/assets/41312004-020a-4ed9-a52b-1b4a8cb61f3f'
        body = f'## Screenshots\n### Before\n![Workspace]({before})\n### After\n<img src="{after}" alt="Workspace">\n'
        self.assertEqual(missing_evidence(body), [])
        self.assertEqual(missing_evidence(body.replace(after, before)), ['distinct Before and After attachments'])
        self.assertEqual(missing_evidence(body.replace(f'![Workspace]({before})', f'[link]({before})')), ['Before'])
        self.assertEqual(missing_evidence(body.replace(f'![Workspace]({before})', f'<!-- ![x]({before}) -->')), ['Before'])
        self.assertEqual(missing_evidence(body.replace('### After', '## Unrelated notes')), ['After'])

    def test_screens_follow_changed_surfaces(self):
        self.assertEqual(scenarios_for(['README.md', 'tests/test_close.py']), [])
        self.assertEqual(scenarios_for(['mods/linked-changes-refined/main.js']), ['changes'])
        self.assertEqual(scenarios_for(['host/herdr_task.py']), ['workspace', 'new-task', 'worktree-settings'])
        self.assertIn('launcher', scenarios_for(['layouts/task-spaces-refined.json']))

    def test_fork_artifact_resolves_only_to_the_current_pr(self):
        source = {'id': 11, 'owner': {'login': 'fork'}}
        run = {'head_repository': source, 'head_branch': 'fix/window', 'head_sha': 'new'}
        pr = {'number': 8, 'head': {'sha': 'new', 'ref': 'fix/window', 'repo': source},
              'base': {'ref': 'main'}, 'state': 'open'}
        inc = {**pr, 'head': {**pr['head'], 'sha': 'old'}}
        different = {**pr, 'head': {**pr['head'], 'repo': {**source, 'id': 31}}}
        self.assertIs(matching_pull(run, [inc, different, pr]), pr)
        self.assertIsNone(matching_pull(run, [inc, different]))
        self.assertIsNone(matching_pull(run, [pr, {**pr, 'number': 9}]))

    def test_reads_only_valid_matched_pngs_and_does_not_extract(self):
        png_header = b'\x89PNG\r\n\x1a\n' + struct.pack('!I4sII', 13, b'IHDR', 1280, 800)
        buffer = io.BytesIO()
        with zipfile.ZipFile(buffer, 'w') as files:
            files.writestr('revision.json', '{"base":"original","head":"new"}')
            files.writestr('before/files.png', png_header)
            files.writestr('after/files.png', png_header)
            files.writestr('after/changes.png', png_header)
            files.writestr('after/launcher.png', png_header)
            files.writestr('before/launcher.png', b'not a PNG')
            files.writestr('../error.png', png_header)
        self.assertEqual(image_pairs(buffer.getvalue(), {'base': 'original', 'head': 'new'}),
                         [('files', png_header, png_header)])
        with self.assertRaisesRegex(ValueError, 'different revision'):
            image_pairs(buffer.getvalue(), {'base': 'original', 'head': 'stale'})

    def test_visual_run_submits_matching_pair_and_links_its_artifact(self):
        png = b'\x89PNG\r\n\x1a\n' + struct.pack('!I4sII', 13, b'IHDR', 1280, 800)
        archive = io.BytesIO()
        with zipfile.ZipFile(archive, 'w') as files:
            files.writestr('revision.json', '{"base":"original","head":"new"}')
            files.writestr('before/files.png', png + b'before')
            files.writestr('after/files.png', png + b'after')
        source = {'id': 11, 'owner': {'login': 'fork'}}
        run = {'id': 16, 'run_attempt': 3, 'event': 'pull_request', 'head_sha': 'new',
               'head_branch': 'fix/window', 'head_repository': source}
        pr = {'number': 8, 'head': {'sha': 'new', 'ref': 'fix/window', 'repo': source},
              'base': {'ref': 'main', 'sha': 'original'}, 'state': 'open',
              'labels': [{'name': 'ui-preview'}]}
        artifact = {'artifacts': [{'id': 24, 'expired': False, 'size_in_bytes': 1200}]}
        with (patch.dict(os.environ, {'NEBIUS_API_KEY': 'fixture', 'NEBIUS_VISUAL_MODEL': 'cheap-model',
                                      'GITHUB_REPOSITORY': 'owner/repo'}),
              patch.object(review, 'github_json', side_effect=[[pr], artifact]) as github_json,
              patch.object(review, 'github', return_value=archive.getvalue()),
              patch.object(review, 'complete', return_value='The label is clipped.') as complete,
              patch.object(review, 'comment') as comment):
            review.visual_review({'workflow_run': run})
        self.assertIn('name=herdr-ui-previews-3', github_json.call_args.args[0])
        model, _, messages = complete.call_args.args
        self.assertEqual(model, 'cheap-model')
        self.assertEqual([m['type'] for m in messages], ['text', 'image_url', 'image_url'])
        self.assertTrue(all(m['image_url']['url'].startswith('data:image/png;base64,') for m in messages[1:]))
        self.assertEqual(comment.call_args.args[:2], (pr, 'visual'))
        body = comment.call_args.args[2]
        self.assertIn('/actions/runs/16/artifacts/24', body)
        self.assertIn('The label is clipped.', body)
