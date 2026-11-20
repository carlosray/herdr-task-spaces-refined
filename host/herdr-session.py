#!/usr/bin/env python3
"""Resolve a console agent's host-local task/Space; never run an agent or choose a first Space."""
import argparse
import hashlib
import json
import os
import shutil
from pathlib import Path
import subprocess
import sys
import tempfile
import uuid


class ContextError(RuntimeError):
    pass


def session_title(value):
    value=value.strip()
    if not value or len(value)>160 or any(ord(c)<32 or ord(c)==127 for c in value):
        raise ContextError('Supply a session name (1–160 characters, without control characters).')
    return value


def ready(row):
    launch=row.get('launch')
    if launch is not None and (not isinstance(launch,dict) or launch.get('phase') not in (None,'ready')):
        raise ContextError('Saved task/checkout launch is unresolved; reconcile its existing intent first.')


def plan_context(state, info, selected_task=None, current_space=None):
    tasks=state['tasks'];claims=list(state['checkouts'].values())
    matches=[r for r in claims if r['folder']==info['folder'] or
             (r.get('gitdir') and r['gitdir']==info.get('gitdir'))]
    if len(matches)>1:
        raise ContextError('Multiple saved owners match this checkout; inspect the registry.')
    if matches:
        row=matches[0]
        ready(row)
        if not row.get('gitdir') or row['gitdir']!=info.get('gitdir'):
            raise ContextError('Assigned checkout identity is unresolved; inspect its saved launch first.')
        if row['folder']!=info['folder']:
            raise ContextError('Assigned checkout moved; reconcile its saved path before launching.')
        if selected_task and selected_task!=row['task']:
            raise ContextError('This checkout already belongs to another task; no transfer was performed.')
        if row['task'] not in tasks:
            raise ContextError('Assigned checkout has no registered task; inspect the saved owner.')
        ready(row);ready(tasks[row['task']])
        return {'task':row['task'],'space':row['space'],'task_name':tasks[row['task']]['name']}
    candidates=[]
    for task in tasks.values():
        same=task['folder']==info['folder'] and task.get('repo')==info.get('repo')
        alias=(task.get('main_space') or {})
        main_alias=alias.get('folder')==info['folder'] and task.get('repo')==info.get('repo')
        if same or main_alias or (info.get('main') is False and task.get('repo')==info.get('repo')):
            candidates.append(task)
    candidates.sort(key=lambda r:(r['name'].casefold(),r['id']))
    if not selected_task and current_space:
        selected_task=next((t['id'] for t in candidates if current_space in
                           (t['id'],(t.get('main_space') or {}).get('space'))),None)
    if selected_task:
        task=next((t for t in candidates if t['id']==selected_task),None)
        if task is None:
            raise ContextError('Selected task does not belong to this working directory/repository.')
        ready(task)
        if info.get('main') is False:
            return {'task':task['id'],'task_name':task['name'],'attach':True}
        alias=(task.get('main_space') or {}) if task['folder']!=info['folder'] else {}
        if alias and alias.get('phase')!='ready':
            raise ContextError('The selected Main destination is unresolved; retry ensure-main first.')
        return {'task':task['id'],'space':alias.get('space',task['id']),'task_name':task['name']}
    return {'candidates':candidates}


def call(argv, stdin=None):
    try:
        r=subprocess.run(argv,input=stdin,text=True,capture_output=True,timeout=45)
    except (OSError,subprocess.TimeoutExpired) as e:
        raise ContextError(f'{argv[0]} unavailable or outcome uncertain; inspect the saved intent before retrying.') from e
    if r.returncode:
        raise ContextError((r.stderr.strip() or r.stdout.strip() or f'{argv[0]} failed')[:1500])
    try:return json.loads(r.stdout)
    except ValueError as e:raise ContextError(f'{argv[0]} returned invalid metadata; no agent was started.') from e


def identity(cwd):
    env={k:v for k,v in os.environ.items() if not k.startswith('GIT_')}
    r=subprocess.run(['git','--no-optional-locks','-C',cwd,'-c','core.fsmonitor=false','rev-parse',
                      '--path-format=absolute','--show-toplevel','--absolute-git-dir','--git-common-dir'],
                     text=True,capture_output=True,env=env,timeout=5)
    if r.returncode:
        if any((p/'.git').exists() for p in (Path(cwd),*Path(cwd).parents)):
            raise ContextError('Could not verify the enclosing Git checkout; no fallback assignment was made.')
        return {'folder':cwd,'repo':None,'gitdir':None,'main':None}
    try:top,gitdir,common=[str(Path(x).resolve(strict=True)) for x in r.stdout.removesuffix('\n').split('\n')]
    except (ValueError,OSError) as e:raise ContextError('Unexpected Git checkout identity.') from e
    return {'folder':top,'repo':common,'gitdir':gitdir,'main':gitdir==common}


def label(value):
    return ''.join(c if ord(c)>=32 and ord(c)!=127 else '?' for c in value)


TOOLS={'claude-code':'claude','claude':'claude','nclaude':'nclaude','codex':'codex','opencode':'opencode','pi':'pi'}


def session_record(detail, state, info, route, tool):
    if detail.get('state')!='live':return None
    foreground=detail.get('foreground') or {};labels=detail.get('labels') or {}
    program=Path(foreground.get('name') or '').name
    if program in ('zsh','bash','sh','fish','hc','herdr-core'):return None
    status=detail.get('status') or {}
    app=status.get('app') if isinstance(status,dict) else None
    actual=TOOLS.get(labels.get('agent.tool') or app or program)
    if actual!=tool:return None
    cwd=foreground.get('cwd') or detail.get('cwd')
    if not cwd or not Path(cwd).is_absolute() or not Path(cwd).is_relative_to(Path(info['folder'])):return None
    try:current=identity(cwd)
    except (ContextError,OSError):return None
    if any(current.get(k)!=info.get(k) for k in ('folder','repo','gitdir')):return None
    space=labels.get('herdr.space')
    if route.get('space') and space!=route['space']:return None
    task_id=labels.get('orchestration.task')
    if not task_id:
        task_id=next((r['task'] for r in state['checkouts'].values() if r['space']==space),None)
    if not task_id:
        task_id=next((t['id'] for t in state['tasks'].values() if space in
                     (t['id'],(t.get('main_space') or {}).get('space'))),None)
    title=labels.get('session.title') or detail.get('title') or detail.get('name') or tool
    return {'kind':'attach','address':detail['address'],'title':label(title),
            'task_name':(state['tasks'].get(task_id) or {}).get('name',''),
            'space':space,'pid':detail.get('pid') or foreground.get('pid'),
            'native':labels.get('native.session'),'created':detail.get('created_ms') or 0}


def local_terminals():
    rows=[]
    for raw in call(['hc','ls','--json']).get('terminals',[]):
        address=raw.get('address') or ''
        if not address or '/' in address or address.startswith('-'):continue
        if raw.get('state') not in (None,'live'):continue
        try:detail=call(['hc','get',address,'--json'])
        except ContextError as error:
            if 'not_found' in str(error) or 'finished' in str(error):continue
            raise
        if detail.get('address')!=address:continue
        rows.append(detail)
    return rows


def open_space_ids():
    request={'jsonrpc':'2.0','id':1,'method':'doc.get','params':{'name':'herdr-app'}}
    reply=call(['hc','connect'],stdin=json.dumps(request)+'\n')
    if not isinstance(reply.get('result'),dict):
        raise ContextError('Could not read open Herdr Spaces; no saved history was offered as active.')
    value=reply['result'].get('value')
    if value is None:return set()
    if not isinstance(value,dict) or not isinstance(value.get('spaces'),list):
        raise ContextError('Unexpected native Herdr Space document.')
    ids=set()
    for row in value['spaces']:
        ident=row.get('id') if isinstance(row,dict) else None
        if not isinstance(ident,str) or not ident or '/' in ident:
            raise ContextError('Unexpected host-local Herdr Space identity.')
        ids.add(ident)
    return ids


def active_task_candidates(state, candidates, open_spaces, terminals):
    active=set(open_spaces)
    active.update((row.get('labels') or {}).get('herdr.space') for row in terminals if row.get('state')=='live')
    visible=[]
    for task in candidates:
        destinations={task['id'],(task.get('main_space') or {}).get('space')}
        destinations.update(row['space'] for row in state['checkouts'].values() if row['task']==task['id'])
        if (destinations-{None}) & active:visible.append(task)
    return visible


def live_sessions(state, info, route, tool, current_terminal=None, terminals=None):
    rows=[]
    for detail in local_terminals() if terminals is None else terminals:
        if detail.get('address')==current_terminal:continue
        row=session_record(detail,state,info,route,tool)
        if row:rows.append(row)
    return sorted(rows,key=lambda r:(-r['created'],r['title'].casefold(),r['address']))


def verify_attach(chosen, info, route, tool):
    fresh=call(['hc','get',chosen['address'],'--json'])
    record=session_record(fresh,{'tasks':{},'checkouts':{}},info,route,tool)
    if (not record or record['address']!=chosen['address']
            or (chosen.get('pid') is not None and chosen['pid']!=record['pid'])
            or (chosen.get('native') and chosen['native']!=record['native'])
            or chosen.get('space')!=record['space']):
        raise ContextError('That session changed or ended while selecting; open the picker again.')
    return {'attach':record['address'],'title':record['title']}


def parse_picker(output, selected, choices):
    lines=output.splitlines()
    if not lines:raise ContextError('Session selection cancelled.')
    query=lines[0].strip()
    if selected=='new':return {'kind':'new','title':query}
    if selected=='quick':return {'kind':'quick'}
    choice=choices.get(selected)
    if choice and choice['kind']=='attach':return dict(choice)
    if choice and choice['kind']=='task':return {**choice,'title':query}
    raise ContextError('Invalid selector destination; no session was started.')


def fuzzy_pick(state, info, route, tool, sessions):
    binary=shutil.which('fzf')
    if not binary:raise ContextError('fzf is required for the console picker; use explicit --herdr-task/--herdr-title meanwhile.')
    choices={};lines=[]
    for index,row in enumerate(sessions):
        key='a'+str(index);choices[key]=row
        suffix='  · '+label(row['task_name']) if row.get('task_name') else ''
        lines.append(key+'\t'+row['title']+suffix)
    lines+=['new\t+ Create new…','quick\t+ Quick session' if route.get('task') else 'quick\t+ Unsorted']
    if not route.get('task'):
        for index,task in enumerate(route.get('candidates',[])):
            key='t'+str(index);choices[key]={'kind':'task','task':task['id']}
            lines.append(key+'\t+ Session in '+label(task['name']))
    # Row placeholders contain generated keys. fzf quotes {q}; the no-op enables
    # dispatch even with zero matches, without inserting query text into actions.
    name_mode='disable-search+reload-sync(true)+change-header(Enter creates · Esc cancels)'
    name_enter=name_mode+'+clear-query+change-prompt(Name > )'
    select=(": {q}; case {1} in "
            +"new) printf new > \"$HERDR_PICKER_CHOICE\"; printf '%s' '"+name_enter+"';; "
            +"quick) printf quick > \"$HERDR_PICKER_CHOICE\"; printf accept;; "
            +"a*) printf '%s' {1} > \"$HERDR_PICKER_CHOICE\"; printf accept;; "
            +"t*) printf '%s' {1} > \"$HERDR_PICKER_CHOICE\"; printf '%s' '"+name_enter+"';; "
            +"*) printf new > \"$HERDR_PICKER_CHOICE\"; printf accept-or-print-query;; esac")
    ctrl_new=("if [ \"$FZF_PROMPT\" != 'Name > ' ]; then printf new > \"$HERDR_PICKER_CHOICE\"; "
              +"printf '%s' '"+name_mode+"+change-prompt(Name > )'; fi")
    context=route.get('task_name') or Path(info['folder']).name
    argv=[binary,'--height=~45%','--min-height=5','--layout=reverse','--border=rounded','--info=hidden',
          '--no-multi','--no-preview','--no-expect','--sync','--delimiter=\t','--with-nth=2..',
          '--tiebreak=index','--print-query','--prompt=Herdr > ','--border-label='+label(tool+' · '+context),
          '--header=Enter select · Ctrl+N new · Alt+U quick · Esc cancel','--with-shell=sh -c',
          '--bind=ctrl-n:transform:'+ctrl_new,
          '--bind=alt-u:transform:printf quick > \"$HERDR_PICKER_CHOICE\"; printf accept']
    env=dict(os.environ,FZF_DEFAULT_OPTS='');env.pop('FZF_DEFAULT_OPTS_FILE',None)
    with tempfile.TemporaryDirectory(prefix='herdr-picker-') as folder:
        entries=Path(folder)/'entries';entries.write_text('\n'.join(lines)+'\n')
        choice=Path(folder)/'choice'
        env.update(HERDR_PICKER_ENTRIES=str(entries),HERDR_PICKER_PENDING=str(Path(folder)/'enter'),
                   HERDR_PICKER_CHOICE=str(choice))
        # Enter waits for the completed current query, including paste+Enter.
        # Tracking preserves an arrow-selected row on refresh. The generated
        # choice is saved separately, so list reloads cannot lose its identity.
        enter=("if [ \"$FZF_PROMPT\" = 'Name > ' ]; then printf accept-or-print-query; "
               +"else : > \"$HERDR_PICKER_PENDING\"; printf '%s' 'reload-sync(cat \"$HERDR_PICKER_ENTRIES\")'; fi")
        settled='if [ -f "$HERDR_PICKER_PENDING" ]; then rm -f "$HERDR_PICKER_PENDING"; '+select+'; fi'
        with entries.open() as source:
            result=subprocess.run(argv+['--track','--bind=enter:transform:'+enter,'--bind=result:transform:'+settled],
                                  stdin=source,text=True,stdout=subprocess.PIPE,env=env)
        selected=choice.read_text() if choice.exists() else ''
    if result.returncode in (1,130):raise ContextError('Session selection cancelled; nothing was created.')
    if result.returncode:raise ContextError('fzf could not open the picker; nothing was created.')
    return parse_picker(result.stdout,selected,choices)


def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--cwd',required=True);p.add_argument('--tool',required=True)
    p.add_argument('--current-space');p.add_argument('--title');p.add_argument('--task');p.add_argument('--new-task')
    p.add_argument('--interactive',action='store_true')
    p.add_argument('--allow-attach',action='store_true');p.add_argument('--current-terminal')
    a=p.parse_args()
    if a.task and a.new_task:raise ContextError('Choose --herdr-task OR --herdr-new-task.')
    cwd=str(Path(a.cwd).resolve(strict=True));info=identity(cwd)
    state=call(['herdr-task','snapshot']);route=plan_context(state,info,a.task,None if a.new_task else a.current_space)
    if route.get('task') and a.new_task:
        raise ContextError('This checkout/current Space already has a task; no new owner was created.')
    new_name=a.new_task;unsorted=False;launch=uuid.uuid4().hex
    title=a.title
    if a.interactive and not any((a.task,a.new_task,a.title)):
        terminals=local_terminals()
        if not route.get('task'):
            route['candidates']=active_task_candidates(state,route['candidates'],open_space_ids(),terminals)
        sessions=live_sessions(state,info,route,a.tool,a.current_terminal or os.environ.get('HC_TERMINAL_ID'),terminals) if a.allow_attach else []
        picked=fuzzy_pick(state,info,route,a.tool,sessions)
        if picked['kind']=='attach':
            print(json.dumps(verify_attach(picked,info,route,a.tool)));return
        title=picked.get('title') or None
        if picked['kind']=='task':route=plan_context(state,info,picked['task'])
        elif not route.get('task'):
            new_name=title or 'Unsorted';unsorted=not bool(title) or picked['kind']=='quick'
    if not route.get('task') and not new_name:new_name='Unsorted';unsorted=True
    title=session_title(title or (new_name if new_name and not unsorted else launch[:8]))
    # Validate the title before creating any task, reservation or native Space.
    intent_dir=Path.home()/'.local/state/herdr-agent-launches'
    intent_dir.mkdir(parents=True,exist_ok=True,mode=0o700)
    intent_path=intent_dir/(launch+'.json')
    intent={'cwd':cwd,'title':title,'tool':a.tool,'launch':launch,'phase':'resolving'}
    def save():
        fd=os.open(intent_path,os.O_WRONLY|os.O_CREAT|os.O_TRUNC,0o600)
        with os.fdopen(fd,'w') as f:json.dump(intent,f,indent=2)
    if new_name:
        # A fallback is execution-host + canonical checkout/directory scoped, never global.
        key=hashlib.sha256(json.dumps(info,sort_keys=True).encode()).hexdigest()[:24]
        request='cli-unsorted-v1-'+key if unsorted else 'cli-task-'+launch
        intent.update(request_id=request,new_task=new_name);save()
        argv=['herdr-task','create','--empty','--folder',info['folder'],'--name',session_title(new_name),'--request-id',request]
        if info['main'] is not False:argv.append('--directory')
        result=call(argv);route={'task':result['id'],'space':result['space'],'task_name':result['name']}
    else:
        # Recheck ownership after prompts; assignment races must never be bypassed.
        current_state=call(['herdr-task','snapshot'])
        route=plan_context(current_state,info,route['task'])
        if current_state['tasks'][route['task']].get('main') is not False:
            call(['herdr-task','ensure-root','--task',route['task']])
        if route.get('attach'):
            request='cli-attach-'+launch;intent.update(request_id=request,task=route['task']);save()
            result=call(['herdr-task','attach','--empty','--task',route['task'],'--folder',info['folder'],'--request-id',request])
            route['space']=result['space']
    intent.update(task=route['task'],space=route['space'],tab='tb-cli-'+launch,phase='resolved');save()
    print(json.dumps({**intent,'task_name':route['task_name'],'intent':str(intent_path)}))


if __name__=='__main__':
    try:main()
    except (ContextError,OSError,subprocess.TimeoutExpired,ValueError,KeyError) as e:
        print('herdr-agent: '+str(e),file=sys.stderr);sys.exit(2)
