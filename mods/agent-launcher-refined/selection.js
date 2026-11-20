// Shared Space/agent/model controls. Automations imports this exact component.
import { div } from 'gpui-kit';
import { v_flex, h_flex, InputState, Popover, ScrollHandle } from 'gpui-base';
import { spaces, panes, machines, shared, knownAgents, theme, appHome, readTextFile, exec, checking } from 'herdr';
import { button, dialogIcon, dialogInput, loadingSpinner, trackInputFocus } from './ui.js';
import { TYPE, HEIGHT, RADIUS, SPACE, ICON_SIZE, controlState } from './ui-kit.js';
import { enabledAgents, launchArgv, normalizeModels, selectInitialSpace, supportsModel, validModel } from './model.js';

export { button };

function spaceFolder(space, hosts, allPanes) {
  const prefix=space.machine?`${space.machine}/`:'';
  const id=prefix&&space.id.startsWith(prefix)?space.id.slice(prefix.length):space.id;
  const state=hosts?.[space.machine||'local'];
  const claim=Object.values(state?.checkouts??{}).find(row=>row.space===id);
  const main=Object.values(state?.tasks??{}).find(task=>task.main_space?.space===id)?.main_space;
  const registered=claim?.folder||state?.tasks?.[id]?.folder||main?.folder;
  if(registered)return registered;
  const tabs=new Set((space.tabs??[]).map(tab=>tab.id));
  return allPanes.find(pane=>tabs.has(pane.tab)&&pane.cwd)?.cwd||space.folder;
}

export class Selection {
  init(given = {}, cx) {
    this.onChange = given.onChange;
    this.allowedAgents = Array.isArray(given.allowedAgents) ? new Set(given.allowedAgents) : null;
    this.allowTerminal = given.allowTerminal === true;
    this.explicitAgent = Boolean(given.agent);
    this.newDestination = given.newSpace === true ? { machine:given.machine, folder:given.folder } : null;
    this.spaceId = '';
    if (!this.newDestination) {
      this.spaceId = given.strictSpace || given.space === '__choose_space__'
        ? (given.space === '__choose_space__' ? '' : given.space ?? '')
        : selectInitialSpace(spaces(), given.space);
    }
    this.agentId = given.agent ?? '';
    this.model = given.model ?? '';
    this.agents = [];
    this.defaultModel = '';
    this.models = normalizeModels([],this.model);
    this.generation = 0;
    this.modelGeneration = 0;
    this.filter = InputState.new({placeholder:'Filter choices…'});
    trackInputFocus(this.filter);
    this.filter.on('change',(_e,cx) => {this.menuIndex=0;cx.notify();});
    this.filter.on('submit',(event,cx) => {if(!event.secondary&&!event.shift)this.chooseHighlighted(cx);});
    this.menuScroll=ScrollHandle.new();
    this.custom = InputState.new({placeholder:'Exact model ID, e.g. provider/model',value:this.model});
    trackInputFocus(this.custom);
    this.custom.on('change',(_e,cx) => {this.model=this.custom.value().trim();this.changed(cx);});
    this.menuHandle = cx.focus_handle();
    this.customModel = false;
    if (!checking()) this.loadAgents(cx);
  }

  changed(cx) { this.onChange?.(cx); cx.notify(); }

  allows(key) { return !this.allowedAgents || this.allowedAgents.has(key); }

  destination() {
    if(this.newDestination)return this.newDestination;
    const space=spaces().find(s=>s.id===this.spaceId);
    if(!space)return;
    const folder=spaceFolder(space,shared('task-spaces.hosts'),panes());
    return folder===space.folder?space:{...space,folder};
  }

  destinationError(target = this.destination()) {
    if (this.newDestination) {
      if (target.machine !== null && (typeof target.machine !== 'string' || !target.machine))
        return 'Choose a host for the new Space.';
      if (typeof target.folder !== 'string' || !target.folder.startsWith('/') || target.folder.includes('\0'))
        return 'Choose an absolute directory for the new Space.';
    }
    return this.unavailable(target);
  }

  unavailable(space, allMachines) {
    if (!space) return '';
    const machine = (allMachines??machines()).find(m => (m.name ?? null) === (space.machine ?? null));
    if (machine?.layout === 'loading') return `Connecting to ${space.machine ?? 'Local'}…`;
    if (machine?.layout === 'unavailable' || (!machine && space.machine)) return `Machine ${space.machine ?? 'Local'} is offline.`;
    return '';
  }

  spaceChoices() {
    const allSpaces=spaces(),allPanes=panes(),allMachines=machines(),hosts=shared('task-spaces.hosts');
    return allSpaces.map(s=>{
      const reason=this.unavailable(s,allMachines),folder=spaceFolder(s,hosts,allPanes);
      return {id:s.id,label:s.name,detail:`${s.machine??'Local'} · ${folder??''}${reason?` · ${reason}`:''}`,disabled:Boolean(reason),reason};
    });
  }

  modelDisabledReason() {
    const problem=this.destinationError();
    if(problem) return problem;
    if(this.loading || !this.agents.some(a=>a.key===this.agentId)) return 'Choose an agent first.';
    if(!this.allows(this.agentId)) return 'Scheduled prompts unsupported for this agent.';
    if(!supportsModel(this.agents.find(a=>a.key===this.agentId))) return 'This launch command uses the agent’s default model.';
    return '';
  }

  chooseSpace(id, cx) {
    if(this.newDestination) return;
    if(this.unavailable(spaces().find(s=>s.id===id))) return;
    const before = spaces().find(s => s.id === this.spaceId);
    const after = spaces().find(s => s.id === id);
    this.spaceId = id;
    this.open = null;
    if ((before?.machine ?? null) !== (after?.machine ?? null)) {
      this.model = ''; this.custom.set_value(''); this.customModel = false;
    }
    this.modelGeneration++;
    this.models = normalizeModels([],this.model);
    this.loadAgents(cx);
    this.changed(cx);
  }

  loadAgents(cx) {
    const generation = ++this.generation;
    const target = this.destination();
    this.agents = [];
    this.agentError = null;
    this.loading = Boolean(target);
    if (!target || this.destinationError(target)) {this.loading = false;return;}
    cx.spawn(async cx => {
      try {
        const [known, raw] = await Promise.all([
          knownAgents({on:target.machine}),
          readTextFile(`${appHome()}/programs.json`).catch(()=>null),
        ]);
        if (generation !== this.generation) return;
        let config;
        try { config = JSON.parse(raw); } catch { /* Herdr keeps the last valid program table. */ }
        this.agents = enabledAgents(known,config);
        const terminal = this.allowTerminal && this.agentId === 'terminal';
        if (!terminal && !this.agents.some(a => a.key === this.agentId) && !(this.allowedAgents && this.explicitAgent))
          this.agentId = this.agents.find(a => this.allows(a.key))?.key ?? '';
        this.loadModels(cx);
      } catch {
        if (generation !== this.generation) return;
        this.agentError = 'Could not check installed agents on this machine.';
      } finally {
        if (generation === this.generation) {this.loading = false;this.changed(cx);}
      }
    });
  }

  chooseAgent(key,cx) {
    if (!this.allows(key)) return;
    this.explicitAgent = true;
    this.agentId = key;
    this.model = ''; this.custom.set_value(''); this.customModel = false;
    this.open = null;
    this.loadModels(cx);
    this.changed(cx);
  }

  loadModels(cx) {
    const generation = ++this.modelGeneration;
    const target = this.destination();
    const key = this.agentId;
    this.defaultModel = '';
    this.models = normalizeModels([],this.model);
    this.modelNote = '';
    this.modelsLoading = Boolean(target && supportsModel(this.agents.find(agent=>agent.key===key)));
    if (!this.modelsLoading) return;
    cx.spawn(async cx => {
      try {
        const script = await readTextFile(`${appHome()}/mods/agent-launcher-refined/discovery.py`);
        if (!script) throw new Error('No discovery helper');
        const result = await exec('python3',['-c',script,key],{on:target.machine,cwd:target.folder,timeout:25000});
        if (generation !== this.modelGeneration) return;
        if (result.code !== 0) throw new Error('Discovery failed');
        const data = JSON.parse(result.stdout);
        const resolved=data.defaultModel ?? data.default_model ?? '';
        this.defaultModel=typeof resolved==='string'&&validModel(resolved)?resolved:'';
        this.models = normalizeModels(data.models,this.model,this.defaultModel);
        this.modelNote = data.note || '';
      } catch {
        if (generation !== this.modelGeneration) return;
        this.modelNote = 'Catalog unavailable. Default still works; or enter an exact custom model ID.';
      } finally {
        if (generation === this.modelGeneration) {this.modelsLoading = false;cx.notify();}
      }
    });
  }

  value() {
    const target = this.destination();
    const space = this.newDestination ? null : target ?? null;
    const agent = this.agents.find(a => a.key === this.agentId) ?? null;
    const model = this.model;
    let error = null,argv = [];
    const problem = this.destinationError(target);
    if (!target) error = 'Choose a Space.';
    else if (problem) error = problem;
    else if (this.loading) error = 'Checking installed agents…';
    else if (this.agentId && !this.allows(this.agentId)) error = 'Scheduled prompts are not supported for this agent. Choose a supported agent.';
    else if (!agent) error = this.agentError || 'Choose an installed agent.';
    else {
      try {argv = launchArgv(agent,model);} catch(e) {error = e.message;}
    }
    return {space,agent,model,argv,folder:target?.folder ?? '',machine:this.newDestination?target.machine:target?.machine??null,error};
  }

  menuItems() {
    if(!this.activeMenu || this.activeMenu.id!==this.open) return [];
    const search=this.filter.value().toLowerCase();
    return this.activeMenu.choices.filter(c=>!search||`${c.label} ${c.detail??''}`.toLowerCase().includes(search)).slice(0,100);
  }

  chooseHighlighted(cx) {
    const options=this.menuItems().filter(c=>!c.disabled);
    const choice=options[Math.min(this.menuIndex??0,options.length-1)];
    if(!choice) return;
    const choose=this.activeMenu.choose;
    this.open=null;this.activeMenu=null;
    choose(choice.id,cx);cx.notify();
  }

  menuKey(event,cx) {
    if(!this.open || this.activeMenu?.id!==this.open) return;
    if(event.key==='escape') {
      cx.stop_propagation();this.open=null;this.activeMenu=null;cx.notify();return;
    }
    const rows=this.menuItems(),enabled=rows.filter(c=>!c.disabled);
    if((event.key==='down'||event.key==='up')&&enabled.length) {
      cx.stop_propagation();
      this.menuIndex=((this.menuIndex??0)+(event.key==='down'?1:enabled.length-1))%enabled.length;
      this.menuScroll.scroll_to_item(rows.findIndex(c=>c.id===enabled[this.menuIndex].id));
      cx.notify();
    } else if(event.key==='enter'&&!event.modifiers?.platform&&!event.modifiers?.shift) {
      cx.stop_propagation();this.chooseHighlighted(cx);
    }
  }

  select(id,label,choices,value,onChoose,options={}) {
    const t = theme(),open = this.open === id && !options.disabled;
    const search = this.filter.value().toLowerCase();
    const shown = choices.filter(c => !search || `${c.label} ${c.detail ?? ''}`.toLowerCase().includes(search));
    const visible=shown.slice(0,100),enabled=visible.filter(c=>!c.disabled);
    if(open) {
      if(this.activeMenu?.id!==id)this.menuIndex=Math.max(0,enabled.findIndex(c=>c.id===value));
      this.activeMenu={id,choices,choose:onChoose};
    }
    const highlighted=enabled[Math.min(this.menuIndex??0,enabled.length-1)]?.id;
    const rowHeight=choice=>choice.detail?HEIGHT.rowTwo:HEIGHT.control;
    const viewportHeight=Math.min(250,Math.max(HEIGHT.header,visible.reduce((height,choice)=>height+rowHeight(choice),0)));
    const rows=visible.map(choice=>{
      const disabled=Boolean(choice.disabled);
      const row=v_flex().id(`${id}-option-${choice.id}`).h(rowHeight(choice)).px(SPACE.row).justify_center()
        .flex_none().rounded(RADIUS.control).text_size(choice.detail?TYPE.body:TYPE.control)
        .text_color(disabled?t.dim:t.foreground).role('list_box_option').aria_selected(choice.id===value)
        .when(disabled||Boolean(choice.reason),el=>el.tooltip(choice.reason||choice.detail||'Unavailable'))
        .when(!disabled,el=>el.cursor_pointer()
          .on_click((_e,cx)=>{this.open=null;this.activeMenu=null;onChoose(choice.id,cx);cx.notify();}))
        .child(div().truncate().child(choice.label))
        .when(Boolean(choice.detail),el=>el.child(div().text_size(TYPE.meta).text_color(disabled?t.dim:t.muted).truncate().child(choice.detail)));
      return controlState(row,t,{selected:choice.id===highlighted,disabled});
    });
    const hasMore=shown.length>100,filterHeight=HEIGHT.header+SPACE.small*3;
    const menu=v_flex().w(480).h(viewportHeight+filterHeight+(hasMore?HEIGHT.mini+SPACE.small:0)).max_h(320)
      .p(SPACE.small).gap(SPACE.small).bg(t.popover).rounded(RADIUS.surface).border_1().border_color(t.border)
      .on_key_down((event,cx)=>this.menuKey(event,cx))
      .child(div().id(`${id}-search`).h(HEIGHT.header).on_key_down((event,cx)=>this.menuKey(event,cx))
        .child(dialogInput(this.filter,`${id}-filter`,{label:'Filter choices'})))
      .child(v_flex().id(`${id}-options`).h(viewportHeight).flex_none().role('list_box').overflow_y_scrollbar().track_scroll(this.menuScroll)
        .children(rows.length?rows:[div().h(HEIGHT.header).px(SPACE.row).flex().items_center().text_size(TYPE.control)
          .text_color(t.muted).child(choices.length?'No matching choices.':'No choices available.')]))
      .when(hasMore,el=>el.child(div().h(HEIGHT.mini).px(SPACE.row).text_size(TYPE.meta).text_color(t.muted).child('Type to narrow the model list.')));
    const trigger=h_flex().id(`${id}-trigger`).w_full().h(HEIGHT.header).flex_none().px(SPACE.row).gap(SPACE.icon).items_center()
      .rounded(RADIUS.control).border_1().border_color(t.input).bg(t.background).text_size(TYPE.control)
      .text_color(options.disabled?t.dim:t.foreground).accessibility_label(label)
      .when(Boolean(options.disabled),el=>el.tooltip(options.reason||'Unavailable'))
      .when(!options.disabled,el=>el.cursor_pointer())
      .when(Boolean(options.loading),el=>el.child(loadingSpinner(t)))
      .child(div().min_w(0).when(Boolean(options.detail),el=>el.flex_none().max_w(220)).when(!options.detail,el=>el.flex_1()).truncate().child(label))
      .when(Boolean(options.detail),el=>el.child(div().flex_1().min_w(0).truncate().text_size(TYPE.meta).text_color(t.muted).child(options.detail)))
      .child(dialogIcon('chevron-down',ICON_SIZE.mini).text_color(t.muted));
    controlState(trigger,t,{disabled:Boolean(options.disabled)});
    if(options.disabled) return trigger;
    return Popover.new(id).open(open).anchor('top_left')
      .on_open_change((next,cx) => {this.open=next?id:null;this.activeMenu=null;this.menuIndex=0;this.filter.set_value('');if(next)this.filter.focus();cx.notify();})
      .trigger(trigger).when(open,el => el.content(menu));
  }

  render(options = {}) {
    const t = theme(),id = options.id ?? 'agent-selection';
    const space = this.newDestination ? null : this.destination();
    const agent = this.agents.find(a => a.key === this.agentId);
    const label=text=>div().text_size(TYPE.meta).text_color(t.muted).child(text);
    const spaceOptions = this.spaceChoices();
    const agentOptions = this.agents.map(a=>({id:a.key,label:a.name,disabled:!this.allows(a.key),detail:!this.allows(a.key)?'Scheduled prompts unsupported':a.key==='nclaude'?'API gateway':''}));
    const models = normalizeModels(this.models,this.model,this.defaultModel);
    const modelReason=this.modelDisabledReason();
    if (supportsModel(this.agents.find(agent=>agent.key===this.agentId))) models.push({id:'__custom__',label:'Custom model…',detail:'Enter an exact model identifier'});
    return v_flex().gap(SPACE.row).min_w(0)
      .child(label('Space'))
      .child(this.select(`${id}-space`,space?`${space.name} · ${space.machine ?? 'Local'}`:'Choose a Space…',spaceOptions,this.spaceId,(key,cx)=>this.chooseSpace(key,cx),{detail:space?.folder}))
      .child(label('Agent'))
      .child(this.select(`${id}-agent`,this.loading?'Checking…':agent?.name??(this.agentId?`${this.agentId} (unavailable)`:'Choose an agent…'),agentOptions,this.agentId,(key,cx)=>this.chooseAgent(key,cx),{disabled:this.loading||!space||Boolean(this.unavailable(space)),reason:this.unavailable(space)||'Checking installed agents…',loading:this.loading}))
      .when(Boolean(this.agentError),el=>el.child(div().text_size(TYPE.meta).text_color(t.ansi1).child(this.agentError)))
      .child(label('Model'))
      .child(this.select(`${id}-model`,modelReason?'Choose an agent first':this.model||models[0].label,models,this.model,(key,cx)=>{
        this.customModel=key==='__custom__';
        if (this.customModel) this.custom.focus();
        else {this.model=key;this.custom.set_value(key);this.changed(cx);}
      },{disabled:Boolean(modelReason),reason:modelReason,loading:this.modelsLoading}))
      .when(this.customModel,el=>el.child(dialogInput(this.custom,`${id}-custom-model`,{label:'Custom model',invalid:Boolean(this.model&&!validModel(this.model))})))
      .when(this.customModel,el=>el.child(div().text_size(TYPE.meta).text_color(this.model&&!validModel(this.model)?t.ansi1:t.muted).whitespace_normal().child(this.model&&!validModel(this.model)?'Use an exact model ID without spaces or flags.':'Exact model ID; clearing it restores Default.')));
  }
}
