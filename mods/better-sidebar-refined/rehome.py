#!/usr/bin/env python3
"""Move a single-terminal native tab without starting/stopping any process."""
import argparse
import copy
import json
from pathlib import Path
import subprocess
import sys

class MoveError(Exception):
    pass

def destination(source, target, tab, terminal):
    def split(value):
        parts=value.split('/')
        if len(parts)==1:return None,parts[0]
        if len(parts)==2 and all(parts):return tuple(parts)
        raise MoveError('Invalid native address')
    parsed=[split(value) for value in [source,target,tab,terminal]]
    if len({machine for machine,_ in parsed})!=1:raise MoveError('Move requires the same machine')
    return parsed[0][0],*(value for _,value in parsed)

def terminal_ids(node):
    if not isinstance(node,dict):return []
    own=node.get('content',{}).get('terminal')
    return ([own] if isinstance(own,str) else [])+[t for c in node.get('children',[]) for t in terminal_ids(c)]

def identity(t):
    return t.get('pid'),t.get('created_ms'),t.get('labels',{}).get('native.session')

def cwd(t):
    return (t.get('foreground') or {}).get('cwd') or t.get('cwd')

def move(api, source, target, tab, terminal, dry_run=False):
    if source==target:raise MoveError('Choose another Space')
    current=api.doc();doc=current.get('value')
    if not isinstance(doc,dict) or not isinstance(doc.get('spaces'),list):
        raise MoveError('Native layout document unavailable; refresh before retrying')
    if any(not isinstance(s,dict) or not isinstance(s.get('tabs'),list) for s in doc['spaces']):
        raise MoveError('Unexpected native document shape; refresh before retrying')
    positions=[(s,t) for s in doc.get('spaces',[]) for t in s.get('tabs',[]) if t.get('id')==tab]
    if len(positions)!=1:raise MoveError('Tab missing or ambiguous; refresh the sidebar')
    owner,moving=positions[0]
    if owner['id'] not in [source,target]:raise MoveError('Tab has moved elsewhere; refresh the sidebar')
    targets=[s for s in doc['spaces'] if s['id']==target]
    if len(targets)!=1:raise MoveError('Destination Space no longer exists')
    dest=targets[0]
    if terminal_ids(moving['root'])!=[terminal]:raise MoveError('Drag supports tabs with one terminal; split tabs stay together')
    original=api.get(terminal)
    if original.get('state')!='live':raise MoveError('Session is no longer live')
    state=api.state()
    if state.get('version')!=1:raise MoveError('Task registry unavailable; update herdr-task')
    claim=next((r for r in state.get('checkouts',{}).values() if r.get('space')==target),None)
    task=state.get('tasks',{}).get(target)
    alias_owner=next((r for r in state.get('tasks',{}).values() if r.get('main_space',{}).get('space')==target),None)
    binding=(alias_owner or {}).get('main_space')
    target_folder=(claim or task or binding or {}).get('folder')
    if not target_folder:
        dest_terminals=[t for dt in dest.get('tabs',[]) for t in terminal_ids(dt['root'])]
        target_folder=cwd(api.get(dest_terminals[0])) if dest_terminals else dest.get('folder')
    if not cwd(original) or not target_folder:raise MoveError('Cannot verify the current directory')
    actual,expected=api.canonical(cwd(original),target_folder)
    if actual!=expected:raise MoveError('Both sessions and Space must use the same directory')
    target_task=(claim or {}).get('task') or (alias_owner or {}).get('id') or target
    physical=api.checkout(actual)
    claimed=False
    for c in state.get('checkouts',{}).values():
        same_checkout=physical and (c.get('gitdir')==physical['gitdir'] or c.get('folder')==physical['folder'])
        # A nested Git repository still sits inside its enclosing checkout.
        folder=c.get('folder','').rstrip('/')
        same_checkout=same_checkout or (folder and (actual==folder or actual.startswith(folder+'/')))
        if same_checkout:claimed=True
        if same_checkout and c.get('task')!=target_task:
            raise MoveError('Checkout belongs to another task; use Task & worktrees to transfer ownership first')
    if physical and not physical['main'] and not claimed:
        raise MoveError('Linked checkout ownership is unknown; use Task & worktrees first')
    preview={'moved':owner['id']!=target,'source':source,'target':target,'tab':tab,'terminal':terminal}
    if dry_run:return {**preview,'checked':True}
    fresh=api.get(terminal)
    if identity(fresh)!=identity(original) or cwd(fresh)!=cwd(original) or fresh.get('state')!='live':
        raise MoveError('Session identity or directory changed; refresh before retrying')
    if owner['id']!=target:
        value=copy.deepcopy(doc)
        old=next(s for s in value['spaces'] if s['id']==owner['id'])
        new=next(s for s in value['spaces'] if s['id']==target)
        old['tabs']=[t for t in old['tabs'] if t['id']!=tab]
        new['tabs'].append(copy.deepcopy(moving))
        # An empty source remains a valid task/resource Space. Nothing is released.
        before=sorted(t for s in doc['spaces'] for dt in s['tabs'] for t in terminal_ids(dt['root']))
        after=sorted(t for s in value['spaces'] for dt in s['tabs'] for t in terminal_ids(dt['root']))
        if before!=after:raise MoveError('Terminal preservation check failed')
        api.put(value,current['version'])  # Fresh CAS only; never replay a stale document.
    try:
        if identity(api.get(terminal))!=identity(original):raise MoveError('Session identity changed')
        labels={'herdr.space':target,'herdr.tab':tab,'orchestration.task':target_task}
        api.label(terminal,labels)
        verified=api.doc()['value']
        found=[s['id'] for s in verified['spaces'] for dt in s['tabs'] if terminal in terminal_ids(dt['root'])]
        after=api.get(terminal)
        if found!=[target] or identity(after)!=identity(original) or any(after.get('labels',{}).get(k)!=v for k,v in labels.items()):
            raise MoveError('Move verification failed')
    except (MoveError,subprocess.SubprocessError,TypeError,ValueError,KeyError) as e:
        raise MoveError('Placement may already be applied. Retry the SAME move to verify/repair labels; no new session is needed.') from e
    return preview

class Native:
    def __init__(self,machine):self.machine=machine
    def command(self,argv):
        try:r=subprocess.run(argv,capture_output=True,text=True,timeout=25)
        except (OSError,subprocess.SubprocessError) as e:raise MoveError('Herdr unavailable or timed out; reconcile this same tab before retrying') from e
        if r.returncode:raise MoveError(f'Herdr operation refused (exit {r.returncode}); refresh and retry the same tab')
        return r.stdout
    def rpc(self,method,params):
        if self.machine:params={**params,'on':self.machine}
        request=json.dumps({'jsonrpc':'2.0','id':1,'method':method,'params':params})+'\n'
        try:r=subprocess.run(['hc','connect'],input=request,capture_output=True,text=True,timeout=25,check=True)
        except (OSError,subprocess.SubprocessError) as e:raise MoveError('Herdr response uncertain; reconcile this same tab before retrying') from e
        for line in r.stdout.splitlines():
            x=json.loads(line)
            if x.get('id')==1:
                if 'error' in x:raise MoveError('Concurrent edit or native document refusal; refresh and retry the same tab')
                return x['result']
        raise MoveError('Missing native response; reconcile the same tab')
    def doc(self):return self.rpc('doc.get',{'name':'herdr-app'})
    def put(self,value,version):return self.rpc('doc.set',{'name':'herdr-app','value':value,'version':version})
    def address(self,terminal):return f'{self.machine}/{terminal}' if self.machine else terminal
    def get(self,terminal):return json.loads(self.command(['hc','get',self.address(terminal),'--json']))
    def on_host(self,argv):return self.command(['hc','exec',*(['--on',self.machine] if self.machine else []),'--',*argv])
    def state(self):return json.loads(self.on_host(['herdr-task','snapshot']))
    def checkout(self,folder):
        # Execute Git on the checkout's host; never infer ownership from a cwd
        # string or a branch name. Clear caller Git overrides just like herdr-task.
        script='''import json,os,pathlib,subprocess,sys
env={k:v for k,v in os.environ.items() if k not in {'GIT_DIR','GIT_WORK_TREE','GIT_COMMON_DIR','GIT_INDEX_FILE','GIT_PREFIX'}}
r=subprocess.run(['git','--no-optional-locks','-C',sys.argv[1],'-c','core.fsmonitor=false','rev-parse','--show-toplevel','--absolute-git-dir','--path-format=absolute','--git-common-dir'],capture_output=True,text=True,env=env,timeout=15)
if r.returncode:
 if 'not a git repository' not in r.stderr.lower():sys.exit(1)
 print('null')
else:
 rows=r.stdout.splitlines()
 if len(rows)!=3:sys.exit(1)
 top,gitdir,common=[str(pathlib.Path(p).resolve(strict=True)) for p in rows]
 print(json.dumps({'folder':top,'gitdir':gitdir,'repo':common,'main':gitdir==common}))
'''
        return json.loads(self.on_host(['python3','-c',script,folder]))
    def canonical(self,*paths):
        if not self.machine:return [str(Path(p).resolve(strict=True)) for p in paths]
        return json.loads(self.on_host(['python3','-c','import json,sys,pathlib;print(json.dumps([str(pathlib.Path(p).resolve(strict=True)) for p in sys.argv[1:]]))',*paths]))
    def label(self,terminal,labels):self.command(['hc','label',self.address(terminal),*[k+'='+v for k,v in labels.items()]])

def main():
    p=argparse.ArgumentParser(description=__doc__)
    for key in ['source','target','tab','terminal']:p.add_argument('--'+key,required=True)
    p.add_argument('--check',action='store_true');a=p.parse_args()
    try:
        machine,source,target,tab,terminal=destination(a.source,a.target,a.tab,a.terminal)
        print(json.dumps(move(Native(machine),source,target,tab,terminal,a.check)))
    except (MoveError,OSError,ValueError,KeyError,TypeError,AttributeError) as e:
        print(json.dumps({'error':str(e)}));return 1
    return 0
if __name__=='__main__':sys.exit(main())
