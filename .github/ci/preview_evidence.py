"""Require the PR author to attach before and after screenshots to the description."""
import json
from pathlib import Path
import re
import sys


ATTACHMENT = r'https://github\.com/user-attachments/assets/[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}'
PINNED_PNG = r'https://raw\.githubusercontent\.com/[\w.-]+/[\w.-]+/[0-9a-f]{40}/(?:[\w-][\w.-]*/)*[\w-][\w.-]*\.png'
URL = rf'(?:{ATTACHMENT}|{PINNED_PNG})'
IMAGE = re.compile(r'!\[[^\]\n]*\]\((' + URL + r')\)|<img\b[^>]*\ssrc\s*=\s*["\'](' + URL + r')["\'][^>]*>', re.I)


def missing_evidence(body):
    body = re.sub(r'<!--.*?-->|(?m:^`{3,}[^\n]*\n).*?(?m:^`{3,}[ \t]*\r?$)', '', body or '', flags=re.S)
    section = re.search(r'^##[ \t]+Screenshots[ \t]*\r?\n(.*?)(?=^#{1,2}[ \t]|\Z)', body, re.I | re.M | re.S)
    images = {}
    for name in ('Before', 'After'):
        part = re.search(rf'^###[ \t]+{name}[ \t]*\r?\n(.*?)(?=^###[ \t]|\Z)',
                         section[1] if section else '', re.I | re.M | re.S)
        images[name] = {a or b for a, b in IMAGE.findall(part[1] if part else '')}
    missing = [side for side, urls in images.items() if not urls]
    if not missing and images['Before'] & images['After']:
        return ['distinct Before and After attachments']
    return missing


if __name__ == '__main__':
    event = json.loads(Path(sys.argv[1]).read_text())
    missing = missing_evidence(event['pull_request'].get('body'))
    if missing:
        raise SystemExit('Attach images under ## Screenshots → ### Before and ### After. Missing: ' + ', '.join(missing))
    print('PR description contains distinct before/after attachments.')
