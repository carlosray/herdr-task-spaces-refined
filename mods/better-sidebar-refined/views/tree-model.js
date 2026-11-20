// Pure tree rules: a visual repository group never creates a core space or terminal.
// Task ownership is explicit and host-local; Git identity never reparents a row.
export function taskRows(rows, hosts, folded) {
  const qualify=(machine,id)=>machine?`${machine}/${id}`:id;
  const byID=new Map(rows.map(r=>[r.w.id,r]));
  const assignments=new Map(), mainSpaces=new Map(), mainAliases=new Set(), tasks=new Map();
  for(const [host,state] of Object.entries(hosts??{})) {
    const machine=host==='local'?null:host;
    for(const [id,task] of Object.entries(state.tasks??{})){
      tasks.set(qualify(machine,id),task);
      if(task.main!==false||!task.main_space?.space)continue;
      const alias=qualify(machine,task.main_space.space);
      mainSpaces.set(qualify(machine,id),alias);
      if(byID.has(qualify(machine,id)))mainAliases.add(alias);
    }
    for(const r of Object.values(state.checkouts??{})) {
      if(r.space!==r.task)assignments.set(qualify(machine,r.space),{parent:qualify(machine,r.task),folder:r.folder});
    }
  }
  const out=[];
  const children=new Map();
  for(const row of rows){
    const parent=assignments.get(row.w.id)?.parent;
    if(!parent)continue;
    if(!children.has(parent))children.set(parent,[]);
    children.get(parent).push(row);
  }
  const missing=new Map();
  for(const [id,kids] of children) {
    const task=tasks.get(id);
    if(byID.has(id)||!task)continue;
    const alias=byID.get(mainSpaces.get(id));
    if(alias)mainAliases.add(alias.w.id);
    const first=kids[0],rootID=alias?.w.id??'task-view:'+id;
    const folder=task.main===false?(task.main_space?.folder||task.repo?.replace(/\/\.git\/?$/,'')||task.folder):task.folder;
    const root={i:alias?.i??first.i,g:alias?.g??null,w:{id:rootID,contextSpace:id,name:task.name,folder,
      machine:first.w.machine,tabs:alias?.w.tabs??[],active:alias?.w.active??false},tree:null,
      virtual:!alias,presentationRoot:true,kids:kids.length,members:[...(alias?[rootID]:[]),...kids.map(r=>r.w.id)]};
    const entries=[root];
    if(!folded.has(rootID))kids.forEach((r,i)=>entries.push({...r,
      w:{...r.w,name:assignments.get(r.w.id)?.folder?.replace(/\/+$/,'').split('/').pop()||r.w.name},
      tree:i===kids.length-1?'└─':'├─',taskParent:rootID,kids:0,members:[r.w.id]}));
    missing.set(id,{first:first.w.id,entries});
  }
  for(const row of rows) {
    const parent=assignments.get(row.w.id)?.parent;
    const group=missing.get(parent);
    if(group){if(row.w.id===group.first)out.push(...group.entries);continue;}
    if(parent&&byID.has(parent)||mainAliases.has(row.w.id))continue;
    const kids=children.get(row.w.id)??[];
    const hostState=hosts?.[row.w.machine||'local'];
    const nativeID=row.w.machine?row.w.id.slice(row.w.machine.length+1):row.w.id;
    const record=hostState?.tasks?.[nativeID];
    let main=record?.main_space?.folder||record?.repo?.replace(/\/\.git\/?$/,'');
    if(!main&&row.g?.repo)try{main=JSON.parse(row.g.repo)[1].replace(/\/\.git\/?$/,'');}catch{}
    const legacy=main&&record?.main===false;
    if(legacy){
      const alias=byID.get(mainSpaces.get(row.w.id));
      const rootID=alias?.w.id??'task-view:'+row.w.id;
      const root=alias??row;
      out.push({...root,w:{...root.w,id:rootID,name:row.w.name,contextSpace:row.w.id,folder:main,tabs:alias?.w.tabs??[],active:alias?.w.active??false},g:alias?.g??{...row.g,linked:false,branch:null},tree:null,virtual:!alias,presentationRoot:true,kids:1+kids.length,members:[...(alias?[rootID]:[]),row.w.id,...kids.map(r=>r.w.id)]});
      if(!folded.has(rootID))out.push({...row,w:{...row.w,name:record.folder?.replace(/\/+$/,'').split('/').pop()||row.w.name,folder:record.folder||row.w.folder},tree:kids.length?'├─':'└─',taskParent:rootID,kids:0,members:[row.w.id]});
      if(!folded.has(rootID))kids.forEach((r,i)=>out.push({...r,w:{...r.w,name:assignments.get(r.w.id)?.folder?.replace(/\/+$/,'').split('/').pop()||r.w.name},tree:i===kids.length-1?'└─':'├─',taskParent:rootID,kids:0,members:[r.w.id]}));
      continue;
    }
    out.push({...row,tree:null,kids:kids.length,members:[row.w.id,...kids.map(r=>r.w.id)]});
    if(!folded.has(row.w.id))kids.forEach((r,i)=>{
      const name=assignments.get(r.w.id)?.folder?.replace(/\/+$/,'').split('/').pop()||r.w.name;
      out.push({...r,w:{...r.w,name},tree:i===kids.length-1?'└─':'├─',taskParent:row.w.id,kids:0,members:[r.w.id]});
    });
  }
  return out;
}
export function requestSpaceTree(spaces, hosts) {
  return taskRows(spaces.map((w, i) => ({ w, i })), hosts, new Set())
    .map(({ w, tree, members }) => ({
      id: w.id, name: w.name, machine: w.machine,
      worktree: Boolean(tree), spaceIds: members ?? [w.id],
    }));
}

export function agentCounts(all, ids) {
  const spaces = new Set(ids), seen = new Set(), counts = {working:0, blocked:0, done:0};
  for (const a of all) {
    if (!spaces.has(a.space) || seen.has(a.address)) continue;
    seen.add(a.address);
    if (a.status in counts) counts[a.status]++;
  }
  return counts;
}
export function visibleTabs(space, all, showSingleShell = false) {
  const tabs = space.tabs ?? [];
  if (!showSingleShell && tabs.length === 1 && !all.some(a => a.tab === tabs[0].id)) return [];
  return tabs;
}
export function repositoryRows(rows, grouped, folded) {
  const emitted = new Set(), out = [];
  for (const row of rows) {
    const repo = row.g?.repo;
    if (!repo || !grouped.has(repo)) {out.push(row);continue;}
    if (emitted.has(repo)) continue;
    emitted.add(repo);
    const members = rows.filter(r => r.g?.repo === repo);
    const main = members.find(r => !r.g?.linked) ?? members[0];
    const id = `repo-group:${repo}`;
    let name=main.w.name;
    try { name=JSON.parse(repo)[1].replace(/\/\.git\/?$/, "").split("/").pop() || name; } catch {}
    const w = {...main.w, id, active:members.some(r => r.w.active), tabs:[], name, status:null};
    out.push({w, i:-1, g:null, tree:null, virtual:true, repo, members:members.map(r => r.w.id), kids:members.length});
    if (!folded.has(id)) members.forEach((r,i) => out.push({...r,tree:i===members.length-1?'└─':'├─',kids:0,repoGroup:id}));
  }
  return out;
}

// Presentation only. An idle branch never establishes checkout availability.
export function spaceContext(w, g, hosts) {
  const machine=w.machine||'local',state=hosts?.[machine];
  const realID=w.contextSpace||w.id;
  const id=w.machine&&realID.startsWith(w.machine+'/')?realID.slice(w.machine.length+1):realID;
  const claim=Object.values(state?.checkouts??{}).find(c=>c.space===id);
  const task=state?.tasks?.[id];
  const alias=claim||task?undefined:mainBinding(state,id);
  const folder=w.contextSpace?w.folder:claim?.folder||task?.folder||alias?.folder||w.folder||'';
  const main=w.contextSpace||alias?true:claim?.main??task?.main??(typeof g?.linked === "boolean" ? !g.linked : null);
  const kind=main===true?'main':main===false?'linked':'folder';
  const short=folder.replace(/^\/(?:Users|home)\/[^/]+(?=\/|$)/,'~');
  const observed=Object.values(state?.observed??{}).some(c=>c.folder===folder);
  return {folder,location:short, machine, kind,
    availability:main===true?null:claim?'Assigned':observed?'In use':'Unknown'};
}

function mainBinding(state, id) {
  return Object.values(state?.tasks??{}).find(task=>task.main_space?.space===id)?.main_space;
}

// Repository groups are visual only. They never claim a checkout or own agents.
export function repositoryGroups(rows, hosts) {
  const groups=new Map();let current=null;
  for(const row of rows) {
    if(row.tree&&current){current.rows.push(row);continue;}
    const w=row.w,machine=w.machine||'local',state=hosts?.[machine];
    const realID=w.contextSpace||w.id;
  const id=w.machine&&realID.startsWith(w.machine+'/')?realID.slice(w.machine.length+1):realID;
    let repo=state?.tasks?.[id]?.repo;
    const claim=Object.values(state?.checkouts??{}).find(c=>c.space===id);
    repo??=claim?.repo;
    if(!repo&&row.g?.repo)try{repo=JSON.parse(row.g.repo)[1];}catch{}
    const folder=state?.tasks?.[id]?.main_space?.folder||repo?.replace(/\/\.git\/?$/,'')||w.folder||w.id;
    const key=JSON.stringify([machine,folder]);
    if(!groups.has(key))groups.set(key,{id:'repository:'+key,folder,name:folder.replace(/\/+$/,'').split('/').pop()||folder,machine:w.machine,rows:[]});
    current=groups.get(key);current.rows.push(row);
  }
  return [...groups.values()];
}

export function directoryForSpace(w,hosts,paneList=[],parents={}) {
  const machine=w?.machine||null,realID=w?.contextSpace||w?.id;
  const id=machine&&realID?.startsWith(machine+'/')?realID.slice(machine.length+1):realID;
  const state=hosts?.[machine||'local'];
  const claim=Object.values(state?.checkouts??{}).find(c=>c.space===id);
  const task=state?.tasks?.[claim?.task??id];
  const tabs=new Set((w?.tabs??[]).map(t=>t.id));
  let gitFolder;try{const [on,path]=JSON.parse(parents[realID]?.key);if((on||null)===machine)gitFolder=path?.replace(/\/\.git\/?$/,'');}catch{}
  return (task?.repo||claim?.repo)?.replace(/\/\.git\/?$/,'')||task?.folder||mainBinding(state,id)?.folder||gitFolder||paneList.find(p=>tabs.has(p.tab)&&p.cwd)?.cwd||w?.folder||'';
}
