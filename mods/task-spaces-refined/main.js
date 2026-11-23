import {View,div,svg} from 'gpui-kit';
import {v_flex,h_flex,InputState,ScrollHandle} from 'gpui-base';
import {spaces,panes,machines,focused,props,theme,exec,checking,shared,setShared,run,openOverlay,closeOverlay} from 'herdr';
import {button as control,dialogHeader,dialogInput,loadingSpinner,trackInputFocus} from './ui.js';
import {TYPE,HEIGHT,RADIUS,SPACE,ICON_SIZE,controlState} from './ui-kit.js';

const HOSTS='task-spaces.hosts';
const host=m=>m||'local';
const hostLabel=m=>m==='ivm'?'IVM':m??'Local';
const localId=(id,m)=>m&&id?.startsWith(m+'/')?id.slice(m.length+1):id;
const qualify=(id,m)=>m?m+'/'+id:id;
const folder=(s,paneList=panes())=>{const tabs=new Set((s?.tabs??[]).map(t=>t.id));return paneList.find(p=>tabs.has(p.tab)&&p.cwd)?.cwd||s?.folder||'';};
const basename=path=>path?.replace(/\/+$/,'').split('/').pop()||path;
const mainFolder=r=>r?.main===true?r.folder:(r?.repo?.endsWith('/.git')?r.repo.slice(0,-5):r?.folder);
const claimFor=(state,id)=>Object.values(state?.checkouts??{}).find(row=>row.space===id);
const taskFor=(state,id)=>state?.tasks?.[id]??state?.tasks?.[claimFor(state,id)?.task]??
  Object.values(state?.tasks??{}).find(task=>task.main_space?.space===id);
const ready=(machine,list=machines())=>list.some(m=>(m.name??null)===(machine??null)&&m.layout==='ready');
const recoverableWorktree=(row,task)=>{
  const owner=row?.owner,phase=owner?.launch?.phase;
  return Boolean(task&&owner?.task===task.id&&!owner.close_action&&!owner.detach_to&&
    (['creating-checkout','checkout-created'].includes(phase)||
     ((owner.creation||owner.start_point_commit)&&['pending','unknown','not-found'].includes(phase))));
};
const button=(id,text,fn,disabled=false,primary=false)=>control(id,text,fn,{disabled,solid:primary,height:HEIGHT.header});
const listIds={destination:'wizard-directories',checkout:'wizard-checkouts',add:'wizard-available-worktrees'};
const branchIcon='mods/better-sidebar-refined/icons/branch.svg';
const directoryIcon='mods/better-sidebar-refined/icons/folder.svg';
const branchLabel=branch=>branch?.replace(/^users\/[^/]+\//,'');
const shortPath=path=>path?.length>38&&path.split('/').length>3?'…/'+path.split('/').slice(-2).join('/'):path;

export default class TaskSpaces extends View {
  init(given,cx) {
    this.p=props()??given??{};this.service=this.p.view==='service';this.loading=false;this.busy=false;this.error=null;this.observed={};
    if(checking())return;
    if(this.service) {
      this.rootRetries=new Map();
      this.closeRetryAfter={};
      this.knownHosts = new Set(machines().map(row => row.name).filter(Boolean));
      this.sync(cx);cx.timer.every(2500,cx=>this.sync(cx));return;
    }
    this.action=this.p.action??'create';this.inventory=[];this.assignable=[];this.unavailable=[];
    const scoped=Boolean(this.p.entry)||this.p.machine!==undefined;
    this.focusedSpace=focused()?.space;
    const current=this.p.space!==undefined?spaces().find(s=>s.id===this.p.space&&(this.p.machine===undefined||(s.machine??null)===this.p.machine)):scoped?undefined:spaces().find(s=>s.id===this.focusedSpace);
    const machineHint=this.p.space?.includes('/')?this.p.space.split('/')[0]:null;
    this.machine=this.p.machine!==undefined?this.p.machine:current?.machine??machineHint;
    this.space=this.p.space??current?.id;
    this.step='destination';
    this.sessionFolder=InputState.new({placeholder:'/path/to/working/directory',value:this.p.folder??''});
    this.name=InputState.new({placeholder:'Task name'});
    this.base=InputState.new({placeholder:'Repository or worktree path',value:this.action==='manage'?this.p.folder??'':''});
    this.path=InputState.new({placeholder:'Absolute path for a new worktree'});
    this.branch=InputState.new({placeholder:'New branch name'});
    for(const input of [this.name,this.base,this.path,this.branch,this.sessionFolder]) {
      trackInputFocus(input);
      input.on('change',(_e,cx)=>cx.notify());
    }
    this.name.on('submit',(event,cx)=>{if(!event.shift)this.create(cx,Boolean(event.secondary));});
    this.sessionFolder.on('change',(_e,cx)=>{this.error=null;cx.notify();});
    this.sessionFolder.on('submit',(_e,cx)=>this.continueDirectory(cx));
    this.base.on('submit',(_e,cx)=>this.load(cx));
    this.handle=cx.focus_handle();this.handle.focus?.();
    if(this.action==='manage'){this.load(cx);return;}
    this.navigation=Object.fromEntries(Object.keys(listIds).map(step=>[step,{focus:cx.focus_handle(),scroll:ScrollHandle.new()}]));
    const {entry,step,mode}=this.p;
    if(entry==='worktree') {
      this.openExisting(this.space,{step:'destination'},cx);
    } else if(step==='checkout'||entry==='task'||(mode==='session'&&this.p.space&&!this.p.newSpace)) {
      this.chooseTask(this.p.taskSpace??this.space,this.machine,cx);
    } else if(this.p.folder&&(step==='task'||entry==='repository'||entry==='directory'||mode==='task'||(!step&&!mode&&!entry))) {
      this.beginTask({folder:this.p.folder,machine:this.machine},cx);
    } else if(step==='directory'||entry==='host'||mode==='session') {
      this.beginDirectory(cx);
    } else {
      this.focusList('destination',cx);
      this.loadRoots(cx);
    }
  }
  async call(args,machine=this.machine,timeout=90000) {
    const r=await exec('herdr-task',args,{on:machine,timeout});
    let result;try{result=JSON.parse(r.stdout);}catch{throw new Error(r.stderr?.trim()||'herdr-task returned no valid response');}
    if(r.code!==0||result.error)throw new Error((result.error||'Task operation failed')+(result.space?` · Space ${result.space}`:''));
    if(['snapshot','observe'].includes(args[0])&&result.version!==1)throw new Error('Update herdr-task on this host: unsupported registry version');
    return result;
  }
  sync(cx) {
    if(this.loading)return;
    this.loading=true;
    cx.spawn(async cx=>{
      try {
      const previous=shared(HOSTS)??{},states={...previous};
      const allSpaces=spaces(),allPanes=panes();
      const hosts=machines().filter(m=>m.layout==='ready').map(m=>m.name??null);
      for (const name of hosts) {
        if (!name || this.knownHosts.has(name)) continue;
        this.knownHosts.add(name);
        openOverlay({mod:'worktree-close-refined',kind:'popup',width:500,height:260,
          props:{mode:'host',machine:name}});
      }
      await Promise.all(hosts.map(async m=>{
        try{
          const rows=allSpaces.filter(s=>(s.machine??null)===m).flatMap(s=>{
            const tabs=new Set((s.tabs??[]).map(t=>t.id));
            const dirs=[...new Set([s.folder,folder(s,allPanes),...allPanes.filter(p=>tabs.has(p.tab)&&p.cwd).map(p=>p.cwd)].filter(Boolean))];
            return dirs.map(f=>({space:localId(s.id,m),folder:f,...(f===s.folder?{declared:true}:{})}));
          });
          const signature=JSON.stringify(rows);
          const key=host(m);
          const closeRetry=previous[key]?.closing?.length&&Date.now()>=(this.closeRetryAfter[key]??0);
          const observe=this.observed[key]!==signature||closeRetry;
          if(observe)this.closeRetryAfter[key]=Date.now()+15000;
          states[key]=await this.call(observe?['observe','--complete','--json',signature]:['snapshot'],m,10000);
          this.observed[key]=signature;
        }catch(e){/* Keep previous ownership across unavailable hosts. */}
      }));
      if(JSON.stringify(previous)!==JSON.stringify(states))setShared(HOSTS,states);
      const currentSpaces=spaces();
      this.restoreMissingRoots(currentSpaces,states,hosts,cx);
      for(const s of currentSpaces) {
        const record=states[host(s.machine)]?.tasks?.[localId(s.id,s.machine)];
        if(record&&!s.named)run('space.rename',{id:s.id,name:record.name});
      }
      const target=shared('task-spaces.open');
      if(target&&currentSpaces.some(s=>s.id===target.id&&(!target.tab||s.tabs?.some(t=>t.id===target.tab)))) {
        setShared('task-spaces.open',null);run('space.select',{id:target.id});if(target.tab)run('tab.select',{id:target.tab});
      }
      } finally {
        // The service is invisible. Shared changes and native commands already
        // invalidate their consumers, so a completed poll needs no redraw.
        this.loading=false;
      }
    });
  }
  restoreMissingRoots(allSpaces,states,hosts,cx) {
    const visible=new Set(allSpaces.map(s=>s.id));
    const missing=new Map();
    for(const machine of hosts) {
      const state=states[host(machine)];
      for(const child of Object.values(state?.checkouts??{})) {
        const task=state.tasks?.[child.task],id=qualify(child.task,machine);
        if(task?.main===true&&child.task!==child.space&&!visible.has(id)&&visible.has(qualify(child.space,machine)))
          missing.set(id,{task,machine});
      }
    }
    for(const id of this.rootRetries.keys())if(!missing.has(id))this.rootRetries.delete(id);
    const now=Date.now();
    for(const [id,{task,machine}] of missing) {
      if((this.rootRetries.get(id)??0)>now)continue;
      this.rootRetries.set(id,now+30000);
      cx.spawn(async ()=>{
        try {await this.call(['ensure-root','--task',task.id],machine,25000);}
        catch {/* The child stays under its registry task while the root is missing. */}
      });
    }
  }
  state(){return (shared(HOSTS)??{})[host(this.machine)]??{tasks:{},checkouts:{}};}
  task(s=this.state()){return taskFor(s,localId(this.space,this.machine));}
  saveState(machine,state){setShared(HOSTS,{...(shared(HOSTS)??{}),[host(machine)]:state});}
  loadRoots(cx) {
    const known=shared(HOSTS)??{};
    for(const m of machines()) {
      if(m.temporary||m.layout!=='ready'||known[host(m.name)])continue;
      cx.spawn(async cx=>{
        try {
          const state=await this.call(['snapshot'],m.name??null,10000);
          if(!(shared(HOSTS)??{})[host(m.name)])this.saveState(m.name,state);
        } catch {/* A host can reconnect independently of the picker. */}
        if(this.step==='destination')this.scrollSelection();
        cx.notify();
      });
    }
  }
  load(cx) {
    if(this.loading||this.action!=='manage')return;
    this.loading=true;this.error=null;this.selected=null;
    cx.spawn(async cx=>{
      try {
        const state=await this.call(['snapshot']);this.saveState(this.machine,state);
        if(this.task(state)?.repo===null){this.inventory=[];return;}
        if(!this.base.value().trim()) {
          const id=localId(this.space,this.machine);
          const record=this.task(state)??Object.values(state.observed??{}).find(r=>r.space===id);
          const native=spaces().find(s=>s.id===this.space&&(s.machine??null)===this.machine);
          this.base.set_value(mainFolder(record)??(this.action==='manage'?this.directory(native):''));
        }
        if(!this.base.value().trim()){this.inventory=[];return;}
        this.inventory=(await this.call(['inventory','--repo',this.base.value().trim()])).checkouts;
        const source=localId(this.p.sourceSpace,this.machine);
        this.selected=this.inventory.find(r=>source&&(r.owner?.space===source||r.spaces.some(s=>s.space===source)))??this.inventory.find(r=>r.main)??this.inventory[0];
      }catch(e){this.error=/not a git repository/i.test(e.message)?'Choose a Git repository, or start a directory session.':e.message;this.inventory=[];}
      finally {this.loading=false;cx.notify();}
    });
  }
  mutate(args,cx,done) {
    if(this.busy)return;this.busy=true;this.error=null;cx.notify();
    const requestKey=JSON.stringify([host(this.machine),...args]);
    if(['create','attach','new-worktree'].includes(args[0])) {
      const pending={...(shared('task-spaces.requests')??{})};
      pending[requestKey]??=`ui-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
      setShared('task-spaces.requests',pending);args=[...args,'--request-id',pending[requestKey]];
    }
    cx.spawn(async cx=>{
      try {
        const result=await this.call(args);
        const state=await this.call(['snapshot']);setShared(HOSTS,{...(shared(HOSTS)??{}),[host(this.machine)]:state});
        await done?.(result,cx);
        const pending={...(shared('task-spaces.requests')??{})};delete pending[requestKey];setShared('task-spaces.requests',pending);
      }catch(e){this.error=e.message;}
      this.busy=false;cx.notify();
    });
  }
  create(cx,withSession=false) {
    const name=this.name.value().trim();
    if(this.step!=='task'||this.busy||this.awaitingSpace||this.launcherOpening||!ready(this.machine)||
       !this.selectedDirectory||(!this.creationIntent&&!name))return;
    if(this.createdTask){this.openCreatedTask(cx);return;}
    if(!this.creationIntent) {
      const args=['create','--directory','--folder',this.selectedDirectory.folder,'--name',name];
      if(withSession)args.push('--empty');
      this.creationIntent={args,withSession,title:name};
    }
    const intent=this.creationIntent;
    this.mutate(intent.args,cx,(result,cx)=>{
      if(!intent.withSession){this.focusResult(result.space??result.id);return;}
      if(typeof result.space!=='string'||!result.space||result.space.includes('/')||result.space!==result.id||
         !result.folder?.startsWith('/'))throw new Error('The task backend did not return the exact new Space.');
      this.createdTask={space:result.space,folder:result.folder,title:result.name||intent.title};
      this.openCreatedTask(cx);
    });
  }
  openCreatedTask(cx) {
    const task=this.createdTask;
    this.waitForSpace(task,(space,cx)=>this.showAgentLauncher({space:space.id,fixedSpace:true,taskSessionTitle:task.title},cx),
      'The new task is still syncing. Retry to open the agent picker.',cx);
  }
  register(cx) {
    const sp=spaces().find(s=>s.id===this.space);
    if(!sp)return;
    this.mutate(['register','--space',localId(this.space,this.machine),'--folder',folder(sp),'--name',sp.name],cx,()=>this.load(cx));
  }
  attach(cx) {
    const task=this.task(),r=this.selected;if(!task||!r||r.main)return;
    let args;
    if(r.owner)args=['transfer','--space',r.owner.space,'--to',task.id];
    else {
      args=['attach','--task',task.id,'--folder',r.folder];
      if(r.spaces.length===1&&r.spaces[0].space)args.push('--space',r.spaces[0].space);
      else if(r.spaces.length)return;
    }
    this.mutate(args,cx,()=>this.load(cx));
  }
  directory(s,paneList=panes(),states=shared(HOSTS)??{}) {
    if(!s)return '';
    const state=states[host(s.machine)],id=localId(s.id,s.machine);
    const claim=Object.values(state?.checkouts??{}).find(r=>r.space===id);
    return claim?.folder||state?.tasks?.[id]?.folder||folder(s,paneList);
  }
  directories(states=shared(HOSTS)??{}) {
    const rows=new Map();
    for(const [key,state] of Object.entries(states)) {
      const machine=key==='local'?null:key;
      const records=[...Object.values(state.tasks??{}),...Object.values(state.observed??{}).filter(r=>r.main===true||r.repo===null)];
      for(const record of records) {
        if(record.main===false&&!record.repo?.endsWith('/.git'))continue;
        const folder=mainFolder(record);
        if(!folder?.startsWith('/'))continue;
        const id=JSON.stringify([machine,folder]);
        if(!rows.has(id))rows.set(id,{id,machine,folder});
      }
    }
    return [...rows.values()];
  }
  preferredDirectory(rows,allSpaces,states) {
    const source=allSpaces.find(s=>s.id===(this.p.space??this.focusedSpace));
    if(!source)return;
    const state=states[host(source.machine)],id=localId(source.id,source.machine);
    const record=taskFor(state,id)??Object.values(state?.observed??{}).find(row=>row.space===id&&row.main);
    const path=mainFolder(record)??source.folder;
    return rows.find(row=>row.folder===path&&row.machine===(source.machine??null));
  }
  wizardTask() {
    return this.state().tasks?.[localId(this.taskSpace,this.machine)];
  }
  mainPath(task) {
    if(task.main!==false)return task.folder;
    const state=this.state();
    return this.resolvedMain?.repo===task.repo?this.resolvedMain.folder:
      task.main_space?.folder??Object.values(state.tasks).find(row=>row.repo===task.repo&&row.main===true)?.folder??
      Object.values(state.observed??{}).find(row=>row.repo===task.repo&&row.main===true)?.folder;
  }
  resolveMainPath(task,cx) {
    if(task.main!==false||!task.repo||this.mainPath(task)||!ready(this.machine))return;
    const machine=this.machine;
    cx.spawn(async cx=>{
      try {
        const result=await this.call(['resolve-directory','--repo',task.repo],machine,15000);
        if(this.machine===machine&&this.wizardTask()?.id===task.id&&result.repo===task.repo&&result.main===true)
          this.resolvedMain=result;
      }catch {/* The explicit Main action reports lookup errors. */}
      cx.notify();
    });
  }
  checkouts(allSpaces=spaces()) {
    const root=this.wizardTask();
    if(!root)return [];
    const assignments=Object.values(this.state().checkouts??{}).filter(row=>row.task===root.id&&row.space!==root.id);
    const rows=[{...root,space:root.id},...assignments].map((row,index)=>{
      const id=qualify(row.space,this.machine);
      const native=allSpaces.find(s=>s.id===id&&(s.machine??null)===this.machine);
      const main=index===0&&row.main!==false;
      const missingRoot=main&&!native&&assignments.some(child=>allSpaces.some(s=>s.id===qualify(child.space,this.machine)));
      return {id,folder:row.folder,main,missingRoot,directory:row.repo===null,branch:native?.branch||row.branch,native};
    });
    if(root.main===false&&root.repo) {
      const binding=root.main_space,id=binding?qualify(binding.space,this.machine):undefined;
      const native=binding?.phase==='ready'?this.publishedSpace(binding,allSpaces):undefined;
      rows.unshift({id,folder:this.mainPath(root),native,main:true,legacyMain:true});
    }
    return rows;
  }
  publishedSpace(binding,allSpaces=spaces()) {
    return allSpaces.find(s=>s.id===qualify(binding.space,this.machine)&&(s.machine??null)===this.machine&&s.folder===binding.folder);
  }
  preferredCheckout(rows) {
    const actual=rows.filter(row=>row.native);
    if(this.p.step==='checkout'&&this.p.space&&(!this.p.taskSpace||this.p.taskSpace===this.taskSpace))
      return actual.find(row=>row.id===this.p.space);
    return actual.find(row=>row.id===this.focusedSpace)??actual.find(row=>row.id===this.p.space)??(actual.length===1?actual[0]:undefined);
  }
  chooseTask(space,machine,cx) {
    this.focusList('checkout',cx);this.taskSpace=space;this.machine=machine;this.error=null;
    const finish=cx=>{
      const owner=taskFor(this.state(),localId(space,machine));
      if(owner){this.taskSpace=qualify(owner.id,machine);this.resolveMainPath(owner,cx);}
      else this.error='This registered task is unavailable.';
      cx.notify();
    };
    if((shared(HOSTS)??{})[host(machine)]||!ready(machine)){finish(cx);return;}
    this.loading=true;
    cx.spawn(async cx=>{
      try {this.saveState(machine,await this.call(['snapshot'],machine,10000));finish(cx);}
      catch(e){this.error=e.message;}
      finally {this.loading=false;if(this.step==='checkout')this.scrollSelection();cx.notify();}
    });
  }
  beginTask(target,cx,back='destination') {
    this.selectedDirectory=target;this.machine=target.machine;this.step='task';this.taskBack=back;
    this.error=null;this.name.focus();cx.notify();
  }
  beginDirectory(cx) {
    this.step='directory';this.error=null;this.sessionFolder.focus();cx.notify();
  }
  chooseMachine(machine,cx) {
    if(this.step!=='directory'||this.loading||this.machine===machine)return;
    this.machine=machine;this.sessionFolder.set_value('');this.error=null;cx.notify();
  }
  continueDirectory(cx) {
    if(this.step!=='directory'||this.loading||!ready(this.machine))return;
    const input=this.sessionFolder.value().trim();
    if(!input)return;
    const machine=this.machine;
    this.loading=true;this.error=null;
    cx.spawn(async cx=>{
      try {
        const result=await this.call(['resolve-directory','--folder',input],machine,15000);
        if(!result.folder?.startsWith('/')||!ready(machine))throw new Error('The selected directory or host is unavailable.');
        const known=this.directories().find(row=>row.machine===machine&&row.folder===result.folder);
        this.beginTask(known??{machine,folder:result.folder},cx,'directory');
      }catch(e){this.error=e.message;}
      finally {this.loading=false;cx.notify();}
    });
  }
  openExisting(id,context,cx) {
    if(this.launcherOpening)return;
    const space=spaces().find(s=>s.id===id&&(s.machine??null)===this.machine);
    if(!space||!ready(this.machine)) {
      this.error='This Space is not available yet. Choose another destination or try again.';cx.notify();return;
    }
    const owner=taskFor(this.state(),localId(id,this.machine));
    if(context.step==='destination'&&owner)context={step:'checkout',taskSpace:qualify(owner.id,this.machine)};
    const preferences={agent:this.p.agent,model:this.p.model,title:this.p.title??''};
    this.showAgentLauncher({space:id,fixedSpace:true,...preferences,
      returnContext:{action:'create',machine:this.machine,space:id,...context,...preferences}},cx);
  }
  showAgentLauncher(props,cx) {
    this.launcherOpening=true;
    try {
      openOverlay({mod:'agent-launcher-refined',kind:'popup',width:480,height:.85,props});
      closeOverlay(this.p.overlay);
    } catch(e){this.launcherOpening=false;this.error=e.message;cx.notify();}
  }
  openMissingMain(row,cx) {
    const task=this.wizardTask();
    if(this.step!=='checkout'||!task||this.busy||this.awaitingSpace||this.launcherOpening||!ready(this.machine))return;
    const context={step:'checkout',taskSpace:this.taskSpace};
    const current=task.main_space?.phase==='ready'?this.publishedSpace(task.main_space):undefined;
    if(current&&current.id===row.id){this.openExisting(current.id,context,cx);return;}
    this.mutate([row.legacyMain?'ensure-main':'ensure-root','--task',task.id],cx,(result,cx)=>{
      if(result.task!==task.id||typeof result.space!=='string'||!result.space||result.space.includes('/')||
        !result.folder?.startsWith('/')||(row.legacyMain?result.phase!=='ready':result.space!==task.id))
        throw new Error('The task backend did not return an exact Main Space.');
      this.waitForSpace(result,(space,cx)=>this.openExisting(space.id,context,cx),
        'Main is still loading. Select Main again to retry the same Space.',cx);
    });
  }
  waitForSpace(binding,open,timeoutMessage,cx) {
    const tryOpen=cx=>{
      const native=this.publishedSpace(binding);
      if(!native||!ready(this.machine))return false;
      open(native,cx);
      return true;
    };
    this.error=null;
    if(tryOpen(cx))return;
    this.awaitingSpace=true;
    const deadline=Date.now()+15000;
    const timer=cx.timer.every(150,cx=>{
      const found=tryOpen(cx);
      if(found||Date.now()>=deadline) {
        timer.cancel();this.awaitingSpace=false;
        if(!found)this.error=timeoutMessage;
        cx.notify();
      }
    });
    cx.notify();
  }
  focusResult(id) {
    if(typeof id!=='string'||!id||id.includes('/'))throw new Error('The task backend did not return a host-local Space ID.');
    setShared('task-spaces.open',{id:qualify(id,this.machine)});
    closeOverlay(this.p.overlay);
  }
  loadAssignable(cx) {
    const task=this.wizardTask();
    if(!['checkout','add'].includes(this.step)||!task?.repo||this.loading||this.busy||!ready(this.machine))return;
    const machine=this.machine;
    this.navigation.add.selected=null;
    this.focusList('add',cx);this.loading=true;this.error=null;this.assignable=[];this.unavailable=[];cx.notify();
    cx.spawn(async cx=>{
      try {
        const result=await this.call(['inventory','--repo',this.mainPath(task)??task.folder],machine);
        if(!result.checkouts.some(row=>row.main&&row.repo===task.repo))
          throw new Error('The selected task no longer points to its saved Git repository.');
        for(const row of result.checkouts.filter(row=>row.repo===task.repo&&!row.main)) {
          const available=row.available&&!row.owner&&!row.missing&&!row.spaces?.length;
          (available?this.assignable:this.unavailable).push(row);
        }
      }catch(e){this.error=e.message;}
      finally {this.loading=false;if(this.step==='add')this.scrollSelection();cx.notify();}
    });
  }
  assign(row,cx) {
    const task=this.wizardTask();
    if(this.step!=='add'||!task?.repo||this.loading||!ready(this.machine)||!this.assignable.includes(row))return;
    this.mutate(['attach','--task',task.id,'--folder',row.folder],cx,result=>this.focusResult(result.space));
  }
  beginNewWorktree(cx) {
    const task=this.wizardTask();
    if(this.step!=='add'||this.loading||this.busy||!task?.repo)return;
    this.step='new-worktree';this.suggestWorktree(task,cx);
  }
  suggestWorktree(task,cx) {
    this.path.set_value('');this.branch.set_value('');this.loading=true;this.error=null;cx.notify();
    cx.spawn(async cx=>{
      try {
        const result=await this.call(['suggest-worktree','--repo',this.mainPath(task)??task.folder],this.machine,15000);
        if(!result.folder?.startsWith('/')||!result.branch)throw new Error('Worktree defaults are unavailable.');
        this.path.set_value(result.folder);this.branch.set_value(result.branch);
      }catch(e){this.error=e.message;}
      finally {this.loading=false;this.path.focus();cx.notify();}
    });
  }
  unavailableWorktree(row,state,task) {
    if(recoverableWorktree(row,task))return 'Finish the saved worktree setup';
    if(row.missing)return 'Checkout is missing';
    if(row.owner?.task===task?.id)return 'Attached to this task';
    if(row.owner)return `Assigned to ${state.tasks?.[row.owner.task]?.name??'another task'}`;
    if(row.spaces?.length)return 'Open in another Space';
    return 'Unavailable';
  }
  createWorktree(cx) {
    const task=this.wizardTask(),path=this.path.value().trim(),branch=this.branch.value().trim();
    if(this.step!=='new-worktree'||this.loading||!task?.repo||!path.startsWith('/')||!branch||!ready(this.machine))return;
    this.mutate(['new-worktree','--task',task.id,'--folder',path,'--branch',branch],cx,result=>this.focusResult(result.space));
  }
  resumeWorktree(row,cx,done) {
    if(this.loading||!recoverableWorktree(row,this.action==='manage'?this.task():this.wizardTask())||!ready(this.machine))return;
    this.mutate(['resume-worktree','--space',row.owner.space],cx,done);
  }
  back(cx) {
    if(this.busy||this.loading||this.awaitingSpace||this.creationIntent||this.launcherOpening)return;
    if(this.step==='new-worktree')this.focusList('add',cx);
    else if(this.step==='add')this.focusList('checkout',cx);
    else if(this.step==='task'&&this.taskBack==='directory'){this.beginDirectory(cx);return;}
    else {this.focusList('destination',cx);this.loadRoots(cx);}
    this.error=null;cx.notify();
  }
  focusList(step,cx) {
    this.step=step;
    const nav=this.navigation[step];
    nav.focus.focus();
    cx.timer.after(0,cx=>{
      if(this.step!==step)return;
      nav.focus.focus();
      this.scrollSelection();
      cx.notify();
    });
  }
  scrollSelection() {
    const rows=this.navigationRows(),index=rows.indexOf(this.selectedRow(rows));
    if(index>=0)this.navigation[this.step].scroll.scroll_to_item(index);
  }
  navigationRows(allSpaces=spaces(),states=shared(HOSTS)??{},allMachines=machines()) {
    if(this.step==='destination') {
      const dirs=this.directories(states),current=this.preferredDirectory(dirs,allSpaces,states);
      return [...dirs.map(row=>({id:'wizard-directory-'+row.id,label:basename(row.folder),
        detail:[hostLabel(row.machine),shortPath(row.folder)].join(' · '),tooltip:row.folder,
        preferred:row.id===current?.id,disabled:!ready(row.machine,allMachines),open:cx=>this.beginTask(row,cx)})),
        {id:'wizard-new-directory',label:'Use another directory…',open:cx=>this.beginDirectory(cx)}];
    }
    const blocked=this.loading||this.busy||this.awaitingSpace||this.launcherOpening||!ready(this.machine,allMachines);
    if(this.step==='checkout') {
      const checkouts=this.checkouts(allSpaces),current=this.preferredCheckout(checkouts);
      const rows=checkouts.map(row=>({id:'wizard-checkout-'+(row.legacyMain?'legacy-main':row.id),
        label:row.main?(row.directory?'Task directory':'Main checkout'):basename(row.folder)||row.native?.name||'Worktree',
        detail:row.legacyMain&&!row.native?'Set up Main for this task':branchLabel(row.branch)||shortPath(row.folder)||'Repository main checkout',
        tooltip:row.folder,icon:row.main?directoryIcon:branchIcon,
        preferred:row===current,disabled:blocked||(!row.native&&!row.legacyMain&&!row.missingRoot),
        open:cx=>row.legacyMain||row.missingRoot?this.openMissingMain(row,cx):this.openExisting(row.id,{step:'checkout',taskSpace:this.taskSpace},cx)}));
      if(this.wizardTask()?.repo)rows.push({id:'wizard-add-worktree',label:'Add a worktree…',disabled:blocked,open:cx=>this.loadAssignable(cx)});
      return rows;
    }
    const task=this.wizardTask();
    return [...this.assignable.map(row=>({id:'wizard-attach-'+row.folder,label:'Attach '+basename(row.folder),
      detail:branchLabel(row.branch)||shortPath(row.folder),tooltip:row.folder,icon:branchIcon,disabled:blocked,open:cx=>this.assign(row,cx)})),
      ...this.unavailable.map(row=>{
        const resume=recoverableWorktree(row,task);
        return {id:'wizard-attach-'+row.folder,label:(resume?'Resume setup for ':'')+basename(row.folder),
          detail:this.unavailableWorktree(row,this.state(),task),tooltip:[row.folder,row.branch].filter(Boolean).join('\n'),
          icon:branchIcon,disabled:blocked||!resume,open:cx=>this.resumeWorktree(row,cx,result=>this.focusResult(result.space))};
      }),
      {id:'wizard-new-worktree',label:'Create a new worktree…',disabled:blocked||Boolean(this.error&&!this.assignable.length),
        open:cx=>this.beginNewWorktree(cx)}];
  }
  selectedRow(rows) {
    const enabled=rows.filter(row=>!row.disabled);
    const prior=enabled.find(row=>row.id===this.navigation[this.step].selected)??enabled.find(row=>row.preferred);
    // A missing explicit return target must not silently redirect Enter.
    if(this.step==='add')return prior;
    if(this.step==='checkout'&&this.p.step==='checkout'&&this.p.space&&
      (!this.p.taskSpace||this.p.taskSpace===this.taskSpace)&&!prior)return;
    return prior??enabled[0];
  }
  creationKey(event,cx) {
    if(event.key==='escape'){cx.stop_propagation();closeOverlay(this.p.overlay);return;}
    const key=event.keystroke,nav=this.navigation[this.step];
    if(this.step==='task'&&key==='cmd-enter') {
      cx.stop_propagation();if(!event.is_held)this.create(cx,true);return;
    }
    if(!nav||!['enter','up','down'].includes(key))return;
    cx.stop_propagation();
    if(this.busy||this.loading||this.awaitingSpace||this.creationIntent||this.launcherOpening)return;
    const rows=this.navigationRows(),selected=this.selectedRow(rows);
    if(key==='enter'){if(!event.is_held&&selected)this.activateRow(selected,cx);return;}
    const enabled=rows.filter(row=>!row.disabled);
    if(!enabled.length)return;
    const index=enabled.indexOf(selected),next=key==='down'?(index+1)%enabled.length:
      (index<0?enabled.length-1:(index+enabled.length-1)%enabled.length);
    nav.selected=enabled[next].id;
    nav.scroll.scroll_to_item(rows.indexOf(enabled[next]));
    cx.notify();
  }
  activateRow(row,cx) {
    this.navigation[this.step].selected=row.id;
    row.open(cx);
  }
  renderNavigation(rows) {
    const selected=this.selectedRow(rows),nav=this.navigation[this.step];
    const contentHeight=rows.reduce((height,row)=>height+(row.detail===undefined?HEIGHT.control:HEIGHT.rowTwo),0)
      +Math.max(0,rows.length-1)*SPACE.small;
    const list=v_flex().id(listIds[this.step]).h(Math.max(HEIGHT.control,Math.min(265,contentHeight)))
      .flex_none().overflow_y_scrollbar().track_scroll(nav.scroll).mode('always').gap(SPACE.small);
    for(const row of rows) {
      const active=row===selected||(row.disabled&&row.id===nav.selected);
      const open=cx=>this.activateRow(row,cx);
      const element=row.detail!==undefined?
        this.entryRow(row.id,row.label,row.detail,open,{...row,selected:active}):
        control(row.id,row.label,open,{disabled:row.disabled,selected:active,variant:'ghost'});
      list.child(element);
    }
    return list;
  }
  status(label) {
    const t=theme();
    return h_flex().id('wizard-loading').gap(SPACE.icon).items_center().text_size(TYPE.meta).text_color(t.muted)
      .child(loadingSpinner(t)).child(label);
  }
  entryRow(id,label,detail,fn,{disabled=false,selected=false,icon,tooltip}={}) {
    const t=theme();
    const row=h_flex().id(id).h(HEIGHT.rowTwo).flex_none().items_center().px(SPACE.row).gap(SPACE.row)
      .rounded(RADIUS.control).text_color(disabled?t.dim:t.foreground)
      .role('list_box_option').aria_selected(selected)
      .when(disabled,e=>e.tooltip(detail))
      .when(!disabled,e=>e.cursor_pointer().on_click((_e,cx)=>fn(cx)))
      .when(Boolean(icon),e=>e.child(svg(icon).size(ICON_SIZE.control).flex_none()))
      .child(v_flex().flex_1().min_w(0)
        .child(div().text_size(TYPE.body).truncate().child(label))
        .child(div().text_size(TYPE.meta).text_color(disabled?t.dim:t.muted).truncate()
          .when(Boolean(tooltip),e=>e.tooltip(tooltip)).child(detail)));
    return controlState(row,t,{selected,disabled});
  }
  renderDirectory(allMachines) {
    return v_flex().gap(SPACE.row).child(h_flex().gap(SPACE.small).flex_wrap().children(allMachines.filter(m=>!m.temporary).map(m=>
      control('create-host-'+host(m.name),hostLabel(m.name),cx=>this.chooseMachine(m.name??null,cx),{
        height:HEIGHT.header,selected:(m.name??null)===this.machine,disabled:this.loading||m.layout!=='ready',
        reason:this.loading?'Checking the directory…':`${hostLabel(m.name)} is offline`,
      }))))
      .child(this.field('directory-path','Directory path',this.sessionFolder))
      .when(Boolean(this.error),el=>el.child(this.errorMessage()))
      .child(h_flex().justify_end().child(button('directory-continue',this.loading?'Checking directory…':'Continue',cx=>this.continueDirectory(cx),
        this.loading||!ready(this.machine,allMachines)||!this.sessionFolder.value().trim(),true)));
  }
  renderTask(allMachines) {
    const {machine,folder}=this.selectedDirectory;
    const mode=this.creationIntent?.withSession;
    const disabled=this.busy||this.awaitingSpace||this.launcherOpening||!ready(machine,allMachines)||
      (!this.creationIntent&&!this.name.value().trim());
    const sessionLabel=this.awaitingSpace?'Opening agent picker…':this.busy&&mode?'Creating task…':
      this.createdTask?'Retry agent selection':mode?'Retry task creation':'Create task with a session ⌘↵';
    return v_flex().gap(SPACE.row)
      .child(div().id('task-directory-context').text_size(TYPE.meta).text_color(theme().muted).truncate().tooltip(folder)
        .child([hostLabel(machine),shortPath(folder)].join(' · ')))
      .child(this.field('task-name','Task name',this.name))
      .when(Boolean(this.error),el=>el.child(this.errorMessage()))
      .child(h_flex().justify_end().gap(SPACE.row)
        .child(button('task-create',mode===false?(this.busy?'Creating task…':'Retry task creation'):'Create task',
          cx=>this.create(cx),disabled||mode===true))
        .child(button('task-create-with-session',sessionLabel,cx=>this.create(cx,true),disabled||mode===false,true)));
  }
  renderNewWorktree(allMachines) {
    return v_flex().gap(SPACE.row)
      .when(this.loading,e=>e.child(this.status('Finding the next worktree name…')))
      .child(this.field('wizard-worktree-path','New worktree path',this.path))
      .child(this.field('wizard-worktree-branch','New branch from the cached default branch',this.branch))
      .when(Boolean(this.error),el=>el.child(this.errorMessage()))
      .child(h_flex().justify_end().child(button('wizard-confirm-worktree',this.busy?'Creating worktree…':'Create and attach worktree',cx=>this.createWorktree(cx),
        this.loading||this.busy||!ready(this.machine,allMachines)||!this.path.value().trim().startsWith('/')||!this.branch.value().trim(),true)));
  }
  renderCreation() {
    const t=theme(),allMachines=machines();
    const titles={destination:'Choose a directory',directory:'Choose an existing directory',task:'New task',checkout:'Choose a checkout',
      add:'Add a worktree','new-worktree':'Create worktree'};
    const back=this.step==='destination'||this.loading||this.busy||this.awaitingSpace||this.creationIntent?null:cx=>this.back(cx);
    const root=v_flex().id('task-spaces-dialog').w_full().max_h(540).min_h(0).p(SPACE.card).gap(SPACE.row)
      .bg(t.popover).text_color(t.foreground).text_size(TYPE.body)
      .key_context('task-spaces').track_focus(this.navigation[this.step]?.focus??this.handle).on_key_down((e,cx)=>this.creationKey(e,cx))
      .child(dialogHeader(titles[this.step],()=>closeOverlay(this.p.overlay),back));
    if(this.step==='directory')root.child(this.renderDirectory(allMachines));
    if(this.step==='task')root.child(this.renderTask(allMachines));
    if(this.step==='checkout'||this.step==='add'||this.step==='new-worktree') {
      const task=this.wizardTask();
      if(task) {
        const path=this.mainPath(task);
        root.child(div().id('checkout-directory-context').text_size(TYPE.meta).text_color(t.muted).truncate()
          .when(Boolean(path),e=>e.tooltip(path))
          .child([task.name,hostLabel(this.machine),shortPath(path)].filter(Boolean).join(' · ')));
      }
      if(this.step==='new-worktree')root.child(this.renderNewWorktree(allMachines));
    }
    if(this.step==='checkout'&&this.loading)root.child(this.status('Loading task destinations…'));
    else if(this.step==='checkout'&&(this.busy||this.awaitingSpace))root.child(this.status('Opening Main checkout…'));
    if(this.step==='add') {
      if(this.loading)root.child(this.status('Checking for available worktrees…'));
      else if(this.busy)root.child(this.status('Attaching worktree…'));
      else if(this.error)root.child(button('wizard-retry-inventory','Retry worktree check',cx=>this.loadAssignable(cx),!ready(this.machine,allMachines)));
      else if(this.assignable.length||this.unavailable.some(row=>recoverableWorktree(row,this.wizardTask())))
        root.child(div().text_size(TYPE.meta).text_color(t.muted).child('Attach a worktree or resume setup'));
      else if(!this.assignable.length)root.child(div().text_color(t.muted).child(this.unavailable.length?'All linked worktrees are in use or unavailable.':'No linked worktrees in this repository.'));
    }
    if(this.navigation[this.step]) {
      const rows=this.navigationRows(spaces(),shared(HOSTS)??{},allMachines);
      if(rows.length)root.child(this.renderNavigation(rows));
    }
    if(this.error&&this.navigation[this.step])root.child(this.errorMessage());
    return root;
  }
  errorMessage() {
    return div().text_size(TYPE.meta).text_color(theme().ansi1).whitespace_normal().child(this.error);
  }
  field(id,label,state) {
    return v_flex().gap(SPACE.small).child(div().text_size(TYPE.meta).text_color(theme().muted).child(label))
      .child(dialogInput(state,id,{label,disabled:Boolean(this.creationIntent||this.busy||this.loading)}));
  }
  render() {
    if(checking()||this.service)return div();
    if(this.action==='create')return this.renderCreation();
    const t=theme(),state=this.state(),task=this.task(state),r=this.selected;
    const allSpaces=spaces(),disabled=this.busy||this.loading;
    const taskName=id=>{
      const s=allSpaces.find(s=>s.id===qualify(id,this.machine));return s?.name??state.tasks[id]?.name??id;
    };
    const available=this.inventory.filter(x=>!x.main);
    const canAttach=r&&!r.main&&r.owner?.task!==task?.id&&(r.owner||!r.spaces.length||(r.spaces.length===1&&r.spaces[0].space));
    const moving=Boolean(r?.owner&&r.owner.task!==task?.id);
    const root=v_flex().id('task-spaces-dialog').w_full().max_h(700).min_h(0).p(SPACE.card).gap(SPACE.row).bg(t.popover).text_color(t.foreground).text_size(TYPE.body)
      .key_context('task-spaces').track_focus(this.handle).on_key_down((e,cx)=>{if(e.key==='escape'){cx.stop_propagation();closeOverlay(this.p.overlay);}})
      .child(dialogHeader('Task & worktrees',()=>closeOverlay(this.p.overlay)))
      .child(div().font_medium().child(task?taskName(task.id):'This Space has not been registered as a task.'));
    if(task?.repo===null)return root.child(div().text_color(t.muted).child(task.folder));
    if(!task)root.child(button('task-register','Use this Space as a task',cx=>this.register(cx),disabled,true));
    root.child(div().text_size(TYPE.meta).text_color(t.muted).whitespace_normal().child('Worktrees belong to one task. Moving keeps their running sessions.'));
    root.child(h_flex().gap(SPACE.row).items_end().child(this.field('task-base','Repository',this.base).flex_1())
      .child(button('task-load','Load',cx=>this.load(cx),disabled)));
    const list=v_flex().id('task-checkouts').h(Math.max(HEIGHT.rowTwo,Math.min(230,available.length*(HEIGHT.rowTwo+SPACE.small)-SPACE.small))).flex_none().overflow_y_scrollbar().mode('always').gap(SPACE.small);
    if(this.loading)list.child(div().py(SPACE.row).text_color(t.muted).child('Checking worktrees and ownership…'));
    else if(!available.length)list.child(div().py(SPACE.row).text_color(t.muted).child('No linked worktrees in this repository.'));
    else for(const row of available) {
      const isSelected=row.folder===r?.folder;
      const detail=recoverableWorktree(row,task)?'Setup unfinished':
        row.owner?`Assigned · ${taskName(row.owner.task)}`:row.spaces.length?'Existing Space · explicit adoption required':'Available';
      const element=v_flex().id('checkout-'+row.folder).h(HEIGHT.rowTwo).flex_none().px(SPACE.row)
        .justify_center().rounded(RADIUS.control).role('list_box_option').aria_selected(isSelected)
        .when(!disabled,e=>e.cursor_pointer().on_click((_event,cx)=>{this.selected=row;cx.notify();}))
        .child(h_flex().gap(SPACE.icon)
          .child(div().flex_1().min_w(0).truncate().text_size(TYPE.body).child(basename(row.folder)))
          .child(div().text_size(TYPE.meta).text_color(row.available?t.ansi2:t.muted).child(detail)))
        .child(div().text_size(TYPE.meta).text_color(t.muted).truncate().tooltip(row.folder).child(row.folder));
      list.child(controlState(element,t,{selected:isSelected,disabled}));
    }
    if(!this.showNew)root.child(list);
    if(this.error&&!this.showNew)root.child(this.errorMessage());
    if(task) {
      if(!this.showNew)root.child(recoverableWorktree(r,task)
        ?button('task-attach','Resume worktree setup',cx=>this.resumeWorktree(r,cx,()=>this.load(cx)),disabled,true)
        :button('task-attach',moving?`Move from ${taskName(r.owner.task)} to this task`:r?.spaces.length?'Attach existing Space':'Attach worktree',cx=>this.attach(cx),disabled||!canAttach,true));
      const child=Object.values(state.checkouts).find(x=>qualify(x.space,this.machine)===this.space&&x.space!==x.task);
      if(child)root.child(button('task-detach','Move into a new task',cx=>this.mutate(['detach','--space',child.space],cx,()=>closeOverlay(this.p.overlay)),disabled));
      root.child(button('task-new-toggle',this.showNew?'Cancel new worktree':'Create a new worktree…',cx=>{
        this.showNew=!this.showNew;if(this.showNew)this.suggestWorktree(task,cx);else cx.notify();
      },disabled));
      if(this.showNew)root.when(this.loading,e=>e.child(this.status('Finding the next worktree name…')))
        .child(this.field('task-new-path','New worktree path',this.path)).child(this.field('task-new-branch','New branch (from the cached default branch; no fetch)',this.branch))
        .when(Boolean(this.error),el=>el.child(this.errorMessage()))
        .child(button('task-new-create','Create & attach',cx=>this.mutate(['new-worktree','--task',task.id,'--folder',this.path.value().trim(),'--branch',this.branch.value().trim()],cx,()=>{this.showNew=false;this.load(cx);}),disabled||!this.path.value().trim()||!this.branch.value().trim(),true));
    }
    return root;
  }
}
