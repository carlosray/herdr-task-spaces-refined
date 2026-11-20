#!/usr/bin/env python3
"""Install only Herdr session metadata hooks, preserving other hook providers."""
from pathlib import Path
import datetime,json,os,shutil
root=Path(__file__).resolve().parent
home=Path.home()
backup=home/'.config/herdr-core/setup-backups'/datetime.datetime.now().strftime('%Y%m%d-%H%M%S-%f-session-hub')

def private_backup(path):
 if not path.exists():return
 backup.mkdir(parents=True,exist_ok=True,mode=0o700)
 target=backup/path.relative_to(home)
 target.parent.mkdir(parents=True,exist_ok=True,mode=0o700)
 shutil.copy2(path,target);target.chmod(0o600)

def save_json(path,data):
 path.parent.mkdir(parents=True,exist_ok=True,mode=0o700)
 private_backup(path)
 tmp=path.with_name(path.name+'.herdr-native-session.tmp')
 fd=os.open(tmp,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
 with os.fdopen(fd,'w') as f:json.dump(data,f,indent=2);f.write('\n')
 os.replace(tmp,path)

binary=home/'.local/bin/herdr-session-probe';binary.parent.mkdir(parents=True,exist_ok=True)
private_backup(binary);shutil.copy2(root/'session_probe.py',binary);binary.chmod(0o700)
for path,tool in [(home/'.codex/hooks.json','codex'),(home/'.claude/settings.json','claude')]:
 data=json.loads(path.read_text()) if path.exists() else {}
 before=json.dumps(data,sort_keys=True)
 hooks=data.setdefault('hooks',{})
 if tool=='codex':
  # codex-cli 0.169.0 HooksFile denies unknown fields and requires nested hooks.
  # Preserve legacy AoE event groups by moving them into the supported wrapper.
  events={'PreModelRequest','PostModelRequest','PreToolUse','PermissionRequest','PostToolUse','PreCompact','PostCompact','SessionStart','SessionEnd','UserPromptSubmit','SubagentStart','SubagentStop','Stop','Interrupt'}
  for event in list(data):
   if event in events:
    existing=hooks.setdefault(event,[])
    for group in data.pop(event):
     if group not in existing:existing.append(group)
  if set(data)-{'hooks','description'}:raise ValueError('Unsupported Codex hooks.json fields; original file was not changed')
 command=f'"$HOME/.local/bin/herdr-session-probe" --hook {tool}'
 entries=hooks.setdefault('SessionStart',[])
 # Idempotence only for this hook; do not edit AoE backup or user hooks.
 if not any(h.get('command')==command for e in entries for h in e.get('hooks',[])):
  entries.append({'hooks':[{'type':'command','command':command}]})
 if json.dumps(data,sort_keys=True)!=before:save_json(path,data)
extension=home/'.pi/agent/extensions/herdr-native-session.ts';extension.parent.mkdir(parents=True,exist_ok=True,mode=0o700)
private_backup(extension);shutil.copy2(root/'herdr-native-session.ts',extension);extension.chmod(0o600)
print('Installed metadata-only Codex, Claude and Pi session hooks; existing hooks preserved')
