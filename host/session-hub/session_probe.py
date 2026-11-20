#!/usr/bin/env python3
"""Read exact native session metadata; never inspect environment values; title mode returns only a capped UI label.

--hook TOOL accepts a SessionStart JSON on stdin and labels this HC terminal.
--verify ADDRESS resolves current foreground authority, ignoring cached IDs.
--probe ADDRESS prints tool/nativeId discovered from exact launch args, hook record,
labels or process-owned open session files. No cwd/title/mtime matching is used.
"""
import argparse,json,os,re,subprocess,sys
from pathlib import Path

TOOLS={'codex','claude','nclaude','pi','opencode'}
UUID=re.compile(r'[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}')
def valid_id(value):
 return isinstance(value,str) and bool(re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.:-]{5,160}',value))
def exact_cli_id(tool,value):
 return valid_id(value) and (bool(UUID.fullmatch(value)) if tool in {'codex','claude','nclaude','pi'} else value.startswith('ses_'))
def unique_id(ids):
 values={x for x in ids if valid_id(x)}
 return next(iter(values)) if len(values)==1 else None

def from_argv(argv):
 tool=None;start=0
 for i,item in enumerate(argv):
  name=Path(item).name.lower()
  if name in TOOLS or name=='nclaude': tool=name;start=i+1;break
 if not tool:return None,None
 if start>=2 and Path(argv[start-2]).name in {'herdr-agent','herdr-agent.sh'}:
  # The adapter consumes these option/value pairs before passing native arguments.
  while start<len(argv) and argv[start] in {'--herdr-title','--herdr-task','--herdr-new-task','--herdr-model'}:
   start+=2
 rest=argv[start:]
 for i,item in enumerate(rest):
  key,sep,value=item.partition('=')
  if key in {'--resume','--session','--session-id','-r','-s'}:
   candidate=value if sep else rest[i+1] if i+1<len(rest) else None
   if exact_cli_id(tool,candidate):return tool,candidate
  if tool=='codex' and item=='resume' and i+1<len(rest) and exact_cli_id(tool,rest[i+1]):return tool,rest[i+1]
 return tool,None

def header_id(path):
 try:
  with open(path,encoding='utf-8') as f: row=json.loads(f.readline(65536))
  if row.get('type')=='session_meta': row=row.get('payload',{})
  value=row.get('id') or row.get('session_id')
  return value if valid_id(value) else None
 except (OSError,ValueError,AttributeError):return None

def codex_main_id(path):
 try:
  with open(path,encoding='utf-8') as f: row=json.loads(f.readline(65536))
  payload=row.get('payload',{})
  value=payload.get('id')
  return value if row.get('type')=='session_meta' and payload.get('source') in ('cli','vscode') and valid_id(value) else None
 except (OSError,ValueError,AttributeError):return None

def process_start_identity(pid):
 try:
  if sys.platform.startswith('linux'):
   return Path(f'/proc/{int(pid)}/stat').read_text().rsplit(')',1)[1].split()[19]
  if sys.platform=='darwin':
   r=subprocess.run(['ps','-p',str(int(pid)),'-o','lstart='],capture_output=True,text=True,timeout=3,check=False,env={'PATH':os.defpath,'LC_ALL':'C','TZ':'UTC'})
   return r.stdout.strip() or None
 except (OSError,ValueError,IndexError,subprocess.TimeoutExpired):pass
 return None

def claude_pid_id(pid,root=None):
 if not isinstance(pid,int) or pid<=0:return None
 path=(root or Path.home()/'.claude/sessions')/f'{pid}.json'
 try:
  with path.open() as f: data=json.loads(f.read(65536))
  value=data.get('sessionId')
  birth=process_start_identity(pid)
  return value if data.get('pid')==pid and valid_id(value) and birth and data.get('procStart')==birth else None
 except (OSError,ValueError,AttributeError):return None

def hook_record(payload,tool,terminal):
 value=next((payload.get(k) for k in ['session_id','session-id','sessionId','thread_id','threadId'] if valid_id(payload.get(k))),None)
 return {'version':1,'terminal':terminal,'tool':tool,'nativeId':value}

def run(args):
 return subprocess.run(args,capture_output=True,text=True,timeout=8,check=False)

def record_path(address):
 if not re.fullmatch(r'[A-Za-z0-9_-]+',address):raise ValueError('invalid terminal address')
 return Path.home()/'.config/herdr-core/native-sessions'/f'{address}.json'

def process_table():
 rows={}
 for line in run(['ps','-axo','pid=,ppid=,comm=']).stdout.splitlines():
  fields=line.strip().split(None,2)
  if len(fields)==3 and fields[0].isdigit() and fields[1].isdigit():rows[int(fields[0])]=(int(fields[1]),fields[2])
 return rows

def owns_hook_process(owner,parent,tool,rows):
 """Only the owning agent may report. Shells do not hide a nested agent boundary."""
 if owner not in rows:return False
 owner_exe=rows[owner][1];chain=[];seen=set();at=parent
 while at in rows and at not in seen:
  seen.add(at);chain.append(at)
  if at==owner:break
  at=rows[at][0]
 if not chain or chain[-1]!=owner:return False
 def is_agent(pid):
  exe=rows[pid][1];name=Path(exe).name.lower()
  return pid==owner or exe==owner_exe or name in TOOLS or name in {'nclaude','claude-code'} or bool(re.search(r'/claude/versions/[^/]+$',exe)) or (tool=='pi' and name in {'node','nodejs','bun'})
 boundary=next((pid for pid in chain if is_agent(pid)),None)
 if boundary==owner:return True
 # Official Codex npm launcher stays as a Node shim while its native child runs.
 # Accept that one boundary, but reject codex exec/fork children below the native owner.
 if tool=='codex' and Path(owner_exe).name.lower() in {'node','nodejs'} and boundary is not None and Path(rows[boundary][1]).name.lower()=='codex':
  between=chain[chain.index(boundary)+1:-1]
  return not any(is_agent(pid) for pid in between)
 return False

def verified_hook_owner(tool,address):
 if not address or not re.fullmatch(r'[A-Za-z0-9_-]+',address):return None
 try:
  data=json.loads(run([os.environ.get('HERDR_HC_BIN','hc'),'get',address,'--json']).stdout)
  labels=data.get('labels',{});owner=int(labels.get('agent.pid') or 0)
  inherited=int(os.environ.get('HERDR_AGENT_PID') or 0)
  owner_tool=labels.get('agent.tool')
  same=tool==owner_tool or {tool,owner_tool}=={'claude','nclaude'}
  if owner<=0 or (inherited and owner!=inherited) or not same:return None
  if not owns_hook_process(owner,os.getppid(),owner_tool,process_table()):return None
  return owner_tool
 except (OSError,ValueError,TypeError,subprocess.TimeoutExpired):return None

def save_hook(payload,tool,address):
 if not address or tool not in TOOLS:return
 owner_tool=verified_hook_owner(tool,address)
 if not owner_tool:return
 tool=owner_tool
 record=hook_record(payload,tool,address)
 metadata=json.loads(run([os.environ.get('HERDR_HC_BIN','hc'),'get',address,'--json']).stdout)
 labels=metadata.get('labels',{});owner_pid=int(labels.get('agent.pid') or 0)
 owner_birth=process_start_identity(owner_pid)
 if owner_pid<=0 or not owner_birth:return
 if verified_hook_owner(tool,address)!=owner_tool:return
 record.update({'version':2,'ownerPid':owner_pid,'ownerBirth':owner_birth,'generation':labels.get('agent.launch')})
 if not record['nativeId']:return
 path=record_path(address);path.parent.mkdir(parents=True,exist_ok=True,mode=0o700)
 temp=path.with_suffix('.tmp-'+str(os.getpid()))
 fd=os.open(temp,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
 with os.fdopen(fd,'w') as f:json.dump(record,f)
 os.replace(temp,path)
 hc=os.environ.get('HERDR_HC_BIN','hc')
 run([hc,'label',address,'native.session='+record['nativeId'],'agent.tool='+tool])

def descendants(pid):
 if not pid:return []
 rows=run(['ps','-axo','pid=,ppid=']).stdout.splitlines();children={}
 for row in rows:
  fields=row.split()
  if len(fields)==2:children.setdefault(int(fields[1]),[]).append(int(fields[0]))
 found={int(pid)};pending=[int(pid)]
 while pending:
  for child in children.get(pending.pop(),[]):
   if child not in found:found.add(child);pending.append(child)
 return sorted(found)

def owned_open_ids(pid,tool):
 pids=descendants(pid)
 if not pids:return []
 try: raw=run(['lsof','-Fn','-p',','.join(map(str,pids))]).stdout
 except (FileNotFoundError,subprocess.TimeoutExpired):return []
 roots={'codex':Path.home()/'.codex/sessions','claude':Path.home()/'.claude/projects','nclaude':Path.home()/'.claude/projects','pi':Path.home()/'.pi/agent/sessions'}
 root=roots.get(tool)
 if not root:return []
 ids=[]
 for row in raw.splitlines():
  if not row.startswith('n'):continue
  path=Path(row[1:])
  if path.suffix!='.jsonl' or not path.is_relative_to(root):continue
  value=codex_main_id(path) if tool=='codex' else (path.stem if tool in {'claude','nclaude'} and UUID.fullmatch(path.stem) else header_id(path))
  if value:ids.append(value)
 return ids

def owned_pi_id(address,pid,labels):
 """Trust only a native Pi event attested by this exact live owning process."""
 try:
  saved=json.loads(record_path(address).read_text())
  if saved.get('version')!=2 or saved.get('tool')!='pi' or saved.get('ownerPid')!=pid:return None
  if str(labels.get('agent.pid') or '')!=str(pid) or saved.get('generation')!=labels.get('agent.launch'):return None
  birth=process_start_identity(pid)
  value=saved.get('nativeId')
  return value if birth and saved.get('ownerBirth')==birth and valid_id(value) else None
 except (OSError,ValueError,AttributeError):return None

def probe(address,verify=False):
 data=json.loads(run(['hc','get',address,'--json']).stdout)
 launch_tool,launch_id=from_argv(data.get('argv',[]));labels=data.get('labels',{})
 foreground=data.get('foreground') or {}
 current_tool,current_id=from_argv(foreground.get('argv',[]))
 tool=labels.get('agent.tool') or ('nclaude' if launch_tool=='nclaude' and current_tool=='claude' else current_tool or launch_tool)
 same_tool=current_tool is None or current_tool==launch_tool or {current_tool,launch_tool}=={'claude','nclaude'}
 explicit=current_id or (launch_id if same_tool else None)
 pid=foreground.get('pid') or data.get('pid')
 if verify:
  # Current foreground authority only: launch args may reference a conversation
  # that /new has since replaced, and inherited hooks may have poisoned labels.
  tool=('nclaude' if current_tool=='claude' and launch_tool=='nclaude' else current_tool)
  if tool not in TOOLS:return {'tool':None,'nativeId':None,'source':'unavailable'}
  value=claude_pid_id(pid) if tool in {'claude','nclaude'} else owned_pi_id(address,pid,labels) if tool=='pi' else unique_id(owned_open_ids(pid,tool))
  return {'tool':tool,'nativeId':value,'source':('pid-index' if tool in {'claude','nclaude'} else 'owned-native-event' if tool=='pi' else 'open-file') if value else 'unavailable'}
 if tool not in TOOLS:return {'tool':None,'nativeId':None,'source':'unavailable'}
 # SessionStart labels are authoritative after a native /new or /resume.
 if valid_id(labels.get('native.session')):return {'tool':tool,'nativeId':labels['native.session'],'source':'label'}
 try:
  saved=json.loads(record_path(address).read_text())
  if saved.get('generation') and saved.get('generation')==labels.get('agent.launch') and saved.get('tool')==tool and valid_id(saved.get('nativeId')):return {'tool':tool,'nativeId':saved['nativeId'],'source':'hook'}
 except (OSError,ValueError):pass
 if explicit:return {'tool':tool,'nativeId':explicit,'source':'argv'}
 if tool in {'claude','nclaude'}:
  value=claude_pid_id(pid)
  if value:return {'tool':tool,'nativeId':value,'source':'pid-index'}
 value=unique_id(owned_open_ids(pid,tool))
 return {'tool':tool,'nativeId':value,'source':'open-file' if value else 'unavailable'}

def compact_title(value):
 """A small UI label only, never a dump of native messages or harness text."""
 if not isinstance(value,str):return None
 text=re.sub(r'<environment_context\b[^>]*>[\s\S]*?</environment_context>','',value,flags=re.I).strip()
 if not text or re.match(r'(?:#\s*(?:AGENTS\.md|Instructions)|<[^>]+>|Caveat:|The user provided the following instructions|You are (?:Codex|Claude)|/\w)',text,re.I):return None
 if re.search(r'\b(?:sk-[A-Za-z0-9_-]{10,}|[A-Za-z_]*(?:api[_ -]?key|token|password|secret)\s*[:=])',text,re.I):return None
 if re.match(r'^(?:new|untitled)\s+(?:session|chat)(?:\s*[-·:]|$)',text,re.I):return None
 text=' '.join(re.sub(r'[\x00-\x1f\x7f]',' ',text).split())
 if not text:return None
 words=text.split();selected=[]
 for word in words[:5]:
  if selected and len(' '.join(selected+[word]))>32:break
  selected.append(word[:32])
 short=' '.join(selected);clipped=len(selected)<len(words) or len(text)>32
 return short[:31].rstrip(' ,;:-')+'…' if clipped else short

def title_rows(path):
 """Bounded reads only inside the already-identified native session."""
 try:
  with path.open(encoding='utf-8') as stream:
   consumed=0
   for _ in range(20000):
    line=stream.readline(262145)
    if not line:return
    consumed+=len(line)
    if len(line)>262144 or consumed>8*1024*1024:return
    try:row=json.loads(line)
    except ValueError:continue
    if isinstance(row,dict):yield row
 except OSError:return

def content_text(content):
 if isinstance(content,str):return content
 if isinstance(content,list):return '\n'.join(x.get('text','') for x in content if isinstance(x,dict) and x.get('type') in ('text','input_text') and isinstance(x.get('text'),str))
 return ''

def sqlite_title(path,query,params):
 import sqlite3
 try:
  if not path.is_file():return None
  with sqlite3.connect(path.resolve().as_uri()+'?mode=ro',uri=True,timeout=1) as connection:
   row=connection.execute(query,params).fetchone()
   return row
 except (OSError,sqlite3.Error):return None

def native_title(tool,native_id,home=None):
 """Use exact native identity only. Never infer identity from cwd/title/newest."""
 result={'title':None,'source':'unavailable'}
 if tool not in TOOLS or not exact_cli_id(tool,native_id):return result
 home=home or Path.home();root=home/'.codex' if tool=='codex' else home/'.claude/projects' if tool in ('claude','nclaude') else home/'.pi/agent/sessions'
 def found(value,source):
  title=compact_title(value)
  return {'title':title,'source':source} if title else None
 if tool=='codex':
  # This exact installed schema separates real user activity from startup context.
  for db in sorted(root.glob('state_*.sqlite'),reverse=True):
   row=sqlite_title(db,'SELECT name,title,first_user_message,has_user_event FROM threads WHERE id=?',(native_id,))
   if row and row[3]:
    for value,source in [(row[0],'native-name'),(row[1],'native-title'),(row[2],'first-user')]:
     value=found(value,source)
     if value:return value
  for path in root.glob(f'sessions/**/rollout-*{native_id}.jsonl'):
   if codex_main_id(path)!=native_id:continue
   for row in title_rows(path):
    payload=row.get('payload',{})
    if row.get('type')=='event_msg' and payload.get('type')=='user_message':
     value=found(payload.get('message'),'first-user')
     if value:return value
 elif tool in ('claude','nclaude'):
  # Exact filename + row sessionId for native title entries; no sibling inference.
  first=None;title=None
  for path in root.glob(f'*/{native_id}.jsonl'):
   if not path.resolve().is_relative_to(root.resolve()):continue
   for row in title_rows(path):
    if row.get('sessionId') not in (None,native_id) or row.get('isSidechain'):continue
    if row.get('type')=='custom-title':title=found(row.get('customTitle'),'native-title') or title
    message=row.get('message',{})
    if not first and row.get('type')=='user' and message.get('role')=='user' and not row.get('isMeta'):
     first=found(content_text(message.get('content')),'first-user')
  if title:return title
  if first:return first
 elif tool=='pi':
  first=None;title=None
  for path in root.glob(f'**/*_{native_id}.jsonl'):
   if not path.resolve().is_relative_to(root.resolve()) or header_id(path)!=native_id:continue
   for row in title_rows(path):
    if row.get('type')=='session_info':title=found(row.get('name'),'native-name') or title
    message=row.get('message',{})
    if not first and row.get('type')=='message' and message.get('role')=='user':first=found(content_text(message.get('content')),'first-user')
  if title:return title
  if first:return first
 elif tool=='opencode':
  row=sqlite_title(home/'.local/share/opencode/opencode.db','SELECT title FROM session WHERE id=?',(native_id,))
  if row:
   value=found(row[0],'native-title')
   if value:return value
 return result


def main():
 ap=argparse.ArgumentParser(description=__doc__);mode=ap.add_mutually_exclusive_group(required=True)
 mode.add_argument('--hook',choices=sorted(TOOLS));mode.add_argument('--probe');mode.add_argument('--verify');mode.add_argument('--pi-session');mode.add_argument('--title',choices=sorted(TOOLS));ap.add_argument('--id');args=ap.parse_args()
 if args.hook or args.pi_session:
  # Hooks must never print, block the harness, or leak their untrusted payload.
  try:
   payload={'session_id':args.pi_session} if args.pi_session else json.loads(sys.stdin.read(1048576))
   save_hook(payload,'pi' if args.pi_session else args.hook,os.environ.get('HC_TERMINAL_ID'))
  except Exception:pass
 else:
  try: result=native_title(args.title,args.id) if args.title else probe(args.verify or args.probe,verify=bool(args.verify))
  except Exception:result={'tool':None,'nativeId':None,'source':'unavailable'}
  print(json.dumps(result))
if __name__=='__main__':main()
