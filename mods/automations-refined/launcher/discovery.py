#!/usr/bin/env python3
"""Return only public model identifiers/names from this host's configured agents.

Executed locally or through Herdr's remote exec. Never return raw configuration,
CLI errors, environment values, auth objects, provider headers or model prompts.
"""
import json
import re
import subprocess
import sys
from pathlib import Path


def read_json(path):
    try:
        return json.loads(path.read_text())
    except (OSError, ValueError):
        return {}


def safe_id(value):
    return isinstance(value, str) and 0 < len(value) <= 512 and not re.search(r'[\x00-\x20\x7f]', value) and not value.startswith('-')


def discover(tool, root=None, command=subprocess.run):
    root = root or Path.home()
    rows = []
    seen = set()
    note = ''

    def add(ident, label=None):
        if safe_id(ident) and ident not in seen:
            seen.add(ident)
            # The catalog label is presentation text, not arbitrary config fields.
            name = label if isinstance(label, str) else ident
            name = re.sub(r'[\x00-\x1f\x7f]', '', name)[:250]
            rows.append({'id': ident, 'label': name})

    executables = read_json(root / '.config/herdr-core/agents.json').get('tools', {})
    executable = executables.get(tool, {}).get('executable') or tool
    if tool == 'codex':
        data = read_json(root / '.codex/models_cache.json')
        for model in data.get('models', []):
            if model.get('visibility') != 'hide':
                add(model.get('slug'), model.get('display_name'))
        note = 'From this host’s Codex model cache.' if rows else 'Codex has no cached catalog yet; Default still works.'
    elif tool in ('claude', 'nclaude'):
        for alias in ('sonnet', 'opus', 'haiku'):
            add(alias, alias.capitalize() + ' (Claude alias)')
        for path in (root / '.claude/settings.json', root / '.claude/settings.local.json'):
            settings = read_json(path)
            add(settings.get('model'))
            env = settings.get('env', {})
            for key in ('ANTHROPIC_MODEL', 'ANTHROPIC_DEFAULT_SONNET_MODEL', 'ANTHROPIC_DEFAULT_OPUS_MODEL', 'ANTHROPIC_DEFAULT_HAIKU_MODEL'):
                add(env.get(key))
        note = 'Default uses this agent’s configured model.'
    elif tool == 'pi':
        directory = root / '.pi/agent'
        providers = read_json(directory / 'models.json').get('providers', {})
        allowed = set(providers) | set(read_json(directory / 'auth.json'))
        for provider, settings in providers.items():
            for model in settings.get('models', []):
                ident = model.get('id')
                if ident:
                    add(provider + '/' + ident, model.get('name') or ident)
        try:
            result = command([executable, '--list-models'], capture_output=True, text=True, timeout=20, check=False)
            if result.returncode == 0:
                for line in result.stdout.splitlines():
                    parts = line.split()
                    if len(parts) >= 2 and parts[0] != 'provider' and (not allowed or parts[0] in allowed):
                        add(parts[0] + '/' + parts[1])
        except (OSError, subprocess.SubprocessError):
            pass
        note = 'Configured/authenticated Pi provider catalogs on this host.'
    elif tool == 'opencode':
        try:
            result = command([executable, 'models'], capture_output=True, text=True, timeout=20, check=False)
            if result.returncode == 0:
                for line in result.stdout.splitlines():
                    ident = line.strip()
                    if '/' in ident:
                        add(ident)
        except (OSError, subprocess.SubprocessError):
            pass
        note = 'OpenCode catalog on this host.' if rows else 'OpenCode catalog is unavailable; Default still works.'
    else:
        note = 'This agent has no supported model catalog; use its configured default.'
    return {'models': rows[:3000], 'note': note}


if __name__ == '__main__':
    try:
        result = discover(sys.argv[1] if len(sys.argv) > 1 else '')
    except Exception:
        result = {'models': [], 'note': 'Model discovery is unavailable; use Default or a known custom ID.'}
    print(json.dumps(result, ensure_ascii=False))
