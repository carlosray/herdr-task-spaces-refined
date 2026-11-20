#!/usr/bin/env python3
"""Prepare one native OpenCode session, optionally with a model; output only its ID.

The installed interactive CLI has --session but no --model. Its public API uses
Model.Ref {providerID,id,variant?}; it is distinct from upstream CLI releases.
"""
import json
import os
import re
import subprocess
import sys


def model_ref(model):
    if not isinstance(model, str) or len(model) > 512 or re.search(r'[\x00-\x20\x7f]', model) or model.startswith('-'):
        raise ValueError('Invalid model identifier')
    name, marker, variant = model.partition('#')
    provider, slash, ident = name.partition('/')
    if not slash or not provider or not ident or (marker and not variant):
        raise ValueError('OpenCode models require provider/model')
    result = {'providerID': provider, 'id': ident}
    if marker:
        result['variant'] = variant
    return result


def prepare(executable, model, cwd, command=subprocess.run):
    body = {'location': {'directory': cwd}}
    if model is not None:
        body['model'] = model_ref(model)
    result = command([executable, 'api', 'POST', '/api/session', '--data', json.dumps(body)],
                     capture_output=True, text=True, timeout=30, check=False)
    if result.returncode != 0:
        raise ValueError('OpenCode did not accept the selected model session')
    value = json.loads(result.stdout)
    session = value.get('data', value).get('id')
    if not isinstance(session, str) or not re.fullmatch(r'ses[A-Za-z0-9_-]{1,180}', session):
        raise ValueError('OpenCode returned no valid native session ID')
    return session


def main():
    if len(sys.argv) not in (2, 3):
        raise ValueError('Expected the OpenCode executable and optional provider/model')
    print(prepare(sys.argv[1], sys.argv[2] if len(sys.argv) == 3 else None, os.getcwd()))


if __name__ == '__main__':
    try:
        main()
    except Exception:
        # API/server error payloads can contain private configuration; never echo them.
        print('Could not prepare the OpenCode session. Check its server and selected model.', file=sys.stderr)
        sys.exit(2)
