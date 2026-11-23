"""Select a fixed set of screenshot scenarios by changed path."""
import subprocess
import sys


SCREENS = {
    'workspace': ('mods/better-sidebar-refined/', 'mods/better-tabs-refined/', 'mods/linked-pane-refined/',
                  'icons/', 'host/herdr_task.py'),
    'files': ('mods/linked-files-refined/',),
    'changes': ('mods/linked-changes-refined/',),
    'merge-requests': ('mods/better-sidebar-refined/',),
    'automations': ('mods/automations-refined/', 'host/automations/'),
    'new-task': ('mods/task-spaces-refined/', 'host/herdr_task.py'),
    'launcher': ('mods/agent-launcher-refined/', 'mods/agent-settings-refined/', 'host/herdr-agent.sh'),
    'recent': ('mods/session-hub-refined/', 'mods/session-recent-refined/', 'host/session-hub/'),
    'settings': ('mods/better-config-refined/', 'mods/agent-settings-refined/', 'install.py'),
    'worktree-settings': ('mods/worktree-close-refined/', 'host/herdr_task.py'),
    'worktree-resume': ('mods/task-spaces-refined/', 'host/herdr_task.py'),
    'worktree-return': ('mods/worktree-close-refined/', 'host/herdr_task.py'),
}


def scenarios_for(paths):
    if any(path.startswith(('layouts/', '.github/ci/preview_'))
           or path in ('keys.json', '.github/workflows/ui-previews.yml') for path in paths):
        return list(SCREENS)
    return [name for name, prefixes in SCREENS.items() if any(path.startswith(prefixes) for path in paths)]


if __name__ == '__main__':
    base, head = sys.argv[1:]
    # Disable rename detection so paths on both sides of a moved file participate.
    raw = subprocess.check_output(['git', 'diff', '--no-renames', '--name-only', '-z', base, head, '--'])
    print(' '.join(scenarios_for(raw.decode(errors='replace').split('\0'))))
