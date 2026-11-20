// Compact row / model submenu adapted from Over9k Launcher (MIT).
// Copyright (c) 2026 the Over9k authors; see license-over9k.txt.
import { View, div, svg, image } from 'gpui-kit';
import { v_flex, h_flex, InputState, ScrollHandle } from 'gpui-base';
import { theme, props, appHome, readTextFile, exec, run, openOverlay, closeOverlay, shared, setShared } from 'herdr';
import { Selection } from './selection.js';
import { button, dialogHeader, dialogIcon, dialogInput, loadingSpinner } from './ui.js';
import { TYPE, HEIGHT, RADIUS, SPACE, ICON_SIZE } from './ui-kit.js';
import { normalizeModels, sessionTitle, supportsModel, validModel } from './model.js';
import { MenuRow } from './over9k-ui.js';

const TERMINAL={key:'terminal',name:'Terminal'};

export default class AgentLauncher extends View {
  init(given,cx) {
    const p=props()??given??{};
    this.newSpace=p.newSpace===true;
    this.fixedSpace=Boolean(p.fixedSpace);
    this.taskSessionTitle=this.fixedSpace&&!this.newSpace&&typeof p.taskSessionTitle==='string'?p.taskSessionTitle.trim():'';
    this.returnContext=p.returnContext;
    this.selector=new Selection();
    this.selector.init({...p,allowTerminal:true,strictSpace:this.fixedSpace||p.strictSpace,onChange:()=>{this.error=null;}},cx);
    this.page='agents';this.agentIndex=null;this.modelIndex=null;this.inputFocus='agents';
    this.search=InputState.new({placeholder:'Search Terminal or installed agents…'});
    this.modelSearch=InputState.new({placeholder:'Search models…'});
    this.title=InputState.new({placeholder:'',value:p.title??''});
    this.search.on('change',(_event,cx)=>{this.agentIndex=0;this.error=null;cx.notify();});
    this.modelSearch.on('change',(_event,cx)=>{this.modelIndex=0;this.error=null;cx.notify();});
    this.search.on('submit',(event,cx)=>{if(event.shift)this.openModels(this.currentAgent(),cx);else this.next(cx);});
    this.modelSearch.on('submit',(event,cx)=>{if(!event.shift)this.submit(cx);});
    this.title.on('change',(_event,cx)=>cx.notify());
    this.title.on('submit',(event,cx)=>{if(!event.shift)this.start(cx);});
    this.selector.custom.on('submit',(event,cx)=>{if(this.showCustom&&!event.shift)this.useCustom(cx);});
    for(const [state,name] of [[this.search,'agents'],[this.modelSearch,'models'],[this.title,'title'],[this.selector.custom,'custom']]) {
      state.on('focus',(_event,cx)=>{this.inputFocus=name;cx.notify();});
      state.on('blur',(_event,cx)=>{if(this.inputFocus===name)this.inputFocus=null;cx.notify();});
    }
    this.handle=cx.focus_handle();this.agentScroll=ScrollHandle.new();this.modelScroll=ScrollHandle.new();
    this.focusTools(cx);
  }
  focusTools(cx) {
    if(!this.fixedSpace){this.search.focus();return;}
    this.inputFocus=null;
    this.handle.focus();
    // The popup host may restore its focus after mounting the initial mod.
    cx?.timer?.after(1,()=>{if(this.page==='agents'&&!this.inputFocus)this.handle.focus();});
  }
  agentChoices() {
    const query=this.search.value().toLowerCase();
    return [TERMINAL,...this.selector.agents].filter(a=>!query||`${a.name} ${a.key}`.toLowerCase().includes(query));
  }
  currentAgent() {
    const rows=this.agentChoices();
    return rows[this.agentIndex??rows.findIndex(a=>a.key===this.selector.agentId)]??rows[0]??null;
  }
  modelChoices() {
    const rows=normalizeModels(this.selector.models,this.selector.model,this.selector.defaultModel);
    rows.push({id:'__custom__',label:'Custom model…',detail:'Enter an exact model identifier'});
    const query=this.modelSearch.value().toLowerCase();
    return rows.filter(m=>!query||`${m.label} ${m.id} ${m.detail??''}`.toLowerCase().includes(query));
  }
  currentModel() {
    const rows=this.modelChoices();
    return rows[this.modelIndex??rows.findIndex(m=>m.id===this.selector.model)]??rows[0]??null;
  }
  selectAgent(agent,cx) {
    if(!agent)return;
    this.agentIndex=this.agentChoices().findIndex(a=>a.key===agent.key);
    if(agent.key!=='terminal'&&this.selector.agentId!==agent.key)this.selector.chooseAgent(agent.key,cx);
    cx.notify();
  }
  spaceValue() {
    const target=this.selector.destination();
    return {space:this.newSpace?null:target,folder:target?.folder,machine:target?.machine,
      error:target?this.selector.destinationError(target):'Choose an existing Space.'};
  }
  next(cx) {
    if(this.starting)return;
    const agent=this.currentAgent(),target=this.spaceValue();
    if(!agent||target.error){this.error=target.error||'Choose a matching installed agent.';cx.notify();return;}
    this.selectAgent(agent,cx);
    if(agent.key!=='terminal') {
      const value=this.selector.value();
      if(value.error){this.error=value.error;cx.notify();return;}
    }
    this.chosen=agent;this.error=null;
    if(this.taskSessionTitle){this.start(cx);return;}
    this.page='title';this.title.focus();cx.notify();
  }
  openModels(agent,cx) {
    if(!supportsModel(agent))return;
    this.selectAgent(agent,cx);this.page='models';this.modelIndex=null;this.showCustom=false;
    this.modelSearch.set_value('');this.modelSearch.focus();this.error=null;cx.notify();
  }
  back(cx) {
    if(this.newSpace&&this.starting)return;
    this.page='agents';this.showCustom=false;this.focusTools(cx);this.error=null;cx.notify();
  }
  changeDestination(cx) {
    if(!this.returnContext||this.starting)return;
    let agent=this.selector.agentId;
    if(this.page==='title')agent=this.chosen?.key??agent;
    else if(this.page==='agents'&&!this.selector.loading)agent=this.currentAgent()?.key??agent;
    const model=agent===this.selector.agentId&&agent!==TERMINAL.key?this.selector.model:'';
    const overlay=props()?.overlay;
    try {
      openOverlay({mod:'task-spaces-refined',kind:'popup',width:540,height:.85,
        props:{...this.returnContext,agent,model,title:this.title.value()}});
      if(overlay)closeOverlay(overlay);
    } catch(error) {
      this.error=String(error.message??error);cx.notify();
    }
  }
  chooseModel(model,cx) {
    if(!model)return;
    if(model.id==='__custom__') {
      this.showCustom=true;this.selector.custom.set_value(this.selector.model);this.selector.custom.focus();cx.notify();return;
    }
    this.selector.model=model.id;this.selector.custom.set_value(model.id);this.selector.changed(cx);this.back(cx);
  }
  useCustom(cx) {
    const id=this.selector.custom.value().trim();
    if(id&&!validModel(id)){this.error='Use an exact model ID without spaces or flags.';cx.notify();return;}
    this.chooseModel({id},cx);
  }
  submit(cx) {
    if(this.page==='models') {
      if(this.showCustom)this.useCustom(cx);else this.chooseModel(this.currentModel(),cx);
    } else if(this.page==='title')this.start(cx);else this.next(cx);
  }
  start(cx) {
    if(this.starting)return;
    if(this.page!=='title'&&!this.taskSessionTitle){this.next(cx);return;}
    const target=this.spaceValue(),agent=this.chosen;
    if(target.error||!agent){this.error=target.error||'Choose an agent.';cx.notify();return;}
    const value=agent.key==='terminal'?target:this.selector.value();
    if(value.error){this.error=value.error;cx.notify();return;}
    // space.new uses the empty string for an explicit local destination.
    const args=this.newSpace?{machine:target.machine??'',folder:target.folder}:{space:target.space.id,folder:target.folder};
    const manual=this.taskSessionTitle||this.title.value().trim();
    if(manual) {
      args.name=this.taskSessionTitle||sessionTitle('',manual,agent.name);
      if(this.newSpace)args.tab=args.name;
    }
    let token=null;
    if(agent.key!=='terminal') {
      args.argv=value.argv;
      if(args.name&&supportsModel(agent)&&Array.from(args.name).length<=160&&!/[\x00-\x1f\x7f-\x9f]/.test(args.name))
        args.argv=[...args.argv.slice(0,2),'--herdr-title',args.name,...args.argv.slice(2)];
      if(!manual) {
        token=`a${Date.now().toString(36)}_${Math.random().toString(36).slice(2,12)}`;
        args.argv=['env',`HERDR_AUTO_TITLE_TOKEN=${token}`,...value.argv];
      }
    }
    const fail=(error,cx)=>{this.starting=false;this.error=String(error?.message??error);cx.notify();};
    const launch=cx=>{
      if(token) {
        const destination=this.newSpace?{newSpace:true,machine:target.machine,folder:args.folder}:{space:target.space.id};
        const intents={...(shared('session-hub.auto-titles')??{})};
        intents[token]={token,...destination,tool:agent.key,createdAt:Date.now(),manual:false};
        setShared('session-hub.auto-titles',intents);
      }
      try {
        run(this.newSpace?'space.new':'tab.new',args);
      } catch(error) {
        if(token){const intents={...(shared('session-hub.auto-titles')??{})};delete intents[token];setShared('session-hub.auto-titles',intents);}
        fail(error,cx);return;
      }
      if(props()?.overlay)closeOverlay(props().overlay);
    };
    this.starting=true;
    if(!this.newSpace){launch(cx);return;}
    cx.spawn(async cx=>{
      const host=target.machine??'Local';
      const unavailable=`Could not verify the directory on ${host}. Check the connection and Python 3, or open an existing Space.`;
      let directory;
      try {
        const source=await readTextFile(`${appHome()}/mods/agent-launcher-refined/validate-directory.py`);
        if(!source)throw new Error('Missing directory validator');
        const result=await exec('python3',['-c',source,target.folder],{on:target.machine,timeout:15000});
        if(result.code!==0)throw new Error('Directory validator failed');
        directory=JSON.parse(result.stdout);
      } catch {fail(unavailable,cx);return;}
      const error=this.selector.destinationError();
      if(error){fail(error,cx);return;}
      if(typeof directory?.error==='string'){fail(directory.error,cx);return;}
      if(directory?.ok!==true||typeof directory.folder!=='string'||!directory.folder.startsWith('/')||directory.folder.includes('\0')) {
        fail(unavailable,cx);return;
      }
      args.folder=directory.folder;
      launch(cx);
    });
    cx.notify();
  }
  key(event,cx) {
    const mods=event.modifiers??{};
    if(event.key==='escape') {
      cx.stop_propagation();
      if(this.selector.open){this.selector.open=null;cx.notify();}
      else if(this.page!=='agents')this.back(cx);else closeOverlay(props().overlay);
      return;
    }
    // Native input submit owns Enter; its bubbled key must not advance twice.
    if(event.key==='enter'&&mods.platform&&!mods.shift){if(!event.is_held&&!this.inputFocus){cx.stop_propagation();this.submit(cx);}return;}
    if(event.key==='enter'&&!event.is_held&&!this.inputFocus&&!mods.shift&&!mods.control&&!mods.alt){
      cx.stop_propagation();this.submit(cx);return;
    }
    if(['title','custom'].includes(this.inputFocus))return;
    if((event.key==='right'||(event.key==='enter'&&mods.shift))&&this.page==='agents') {
      cx.stop_propagation();this.openModels(this.currentAgent(),cx);return;
    }
    if(event.key==='left'&&this.page==='models'){cx.stop_propagation();this.back(cx);return;}
    if(!['up','down'].includes(event.key)||this.page==='title')return;
    const models=this.page==='models',rows=models?this.modelChoices():this.agentChoices();
    if(!rows.length)return;
    cx.stop_propagation();
    const current=models?this.currentModel():this.currentAgent();
    const index=Math.max(0,rows.findIndex(row=>(models?row.id:row.key)===(models?current?.id:current?.key)));
    const next=(index+(event.key==='down'?1:rows.length-1))%rows.length;
    if(models){this.modelIndex=next;this.modelScroll.scroll_to_item(next);}
    else{this.agentIndex=next;this.agentScroll.scroll_to_item(next);}
    cx.notify();
  }
  agentIcon(agent,model='') {
    if(agent?.key==='terminal')return dialogIcon('terminal');
    if(/qwen/i.test(model))return svg('mods/agent-launcher-refined/qwen.svg').size(ICON_SIZE.program).text_color('#6f69f7').flex_none();
    if(!agent?.icon)return div().size(ICON_SIZE.program).flex_none();
    return agent.tint?svg(agent.icon).size(ICON_SIZE.program).text_color(theme().foreground).flex_none():image(agent.icon).size(ICON_SIZE.program).flex_none();
  }
  titleView() {
    const t=theme();
    return v_flex().id('launch-title-step').gap(SPACE.row).py(SPACE.row)
      .child(div().text_size(TYPE.meta).text_color(t.muted).child('Session title (optional)'))
      .child(dialogInput(this.title,'launch-title',{label:'Session title (optional)',focused:this.inputFocus==='title'}))
      .child(div().text_size(TYPE.meta).text_color(t.muted).whitespace_normal().child(this.chosen?.key==='terminal'?'Leave blank to use the shell name.':'Leave blank to use the agent’s conversation title when available.'));
  }
  destinationView(target) {
    const t=theme();
    const name=this.newSpace?'New Space':target.space?.name??'Space unavailable';
    const host=target.machine===null||(target.space&&target.machine===undefined)?'Local':target.machine==='ivm'?'IVM':target.machine||'Host unavailable';
    const folder=target.folder||(target.space?'Home directory':'Choose a directory');
    return v_flex().id(this.newSpace?'launch-new-space':'launch-fixed-space').w_full().min_w(0).h(HEIGHT.rowTwo).flex_none().px(SPACE.row).justify_center()
      .rounded(RADIUS.control).bg(t.background).accessibility_label(`${name} · ${host} · ${folder}`)
      .child(h_flex().min_w(0).gap(SPACE.row).items_center()
        .child(div().flex_1().min_w(0).truncate().text_size(TYPE.body).child(name))
        .child(div().text_size(TYPE.meta).text_color(t.muted).child(host)))
      .child(div().min_w(0).truncate().text_size(TYPE.meta).text_color(t.muted).tooltip(folder).child(folder));
  }
  render() {
    const t=theme(),target=this.spaceValue(),models=this.page==='models',title=this.page==='title';
    const rows=models?this.modelChoices():this.agentChoices(),selected=models?this.currentModel():this.currentAgent();
    const viewport=Math.max(HEIGHT.control,Math.min(rows.length,8)*HEIGHT.control);
    const blocking=this.error||target.error;
    const actionError=target.error||(!title&&!selected?'No matching choice.':'');
    const showFixedDestination=this.newSpace;
    const showPicker=!this.fixedSpace&&!this.newSpace&&!title;
    const showSearch=!title&&(models||!this.fixedSpace);
    const agent=this.selector.agents.find(a=>a.key===this.selector.agentId),space=target.space;
    const list=v_flex().id(models?'launch-model-list':'launch-agent-list').h(viewport).min_h(HEIGHT.control).overflow_y_scrollbar()
      .track_scroll(models?this.modelScroll:this.agentScroll).role('list_box');
    if(models) {
      for(const row of rows)list.child(MenuRow({id:`launch-model-${row.id||'default'}`,icon:this.agentIcon(agent,row.id),name:row.label,
        selected:row.id===selected?.id,hint:row.id===this.selector.model?'Selected':'',onChoose:cx=>this.chooseModel(row,cx)}));
    } else {
      for(const row of rows)list.child(MenuRow({id:`launch-agent-${row.key}`,icon:this.agentIcon(row),name:row.name,
        selected:row.key===selected?.key,onChoose:cx=>{this.selectAgent(row,cx);this.next(cx);},
        onModel:supportsModel(row)?cx=>this.openModels(row,cx):null}));
    }
    if(!rows.length)list.child(div().h(HEIGHT.control).px(SPACE.row).flex().items_center().text_color(t.muted).child(models?(this.selector.modelsLoading?'Checking models…':'No matching models.'):'No matching tools.'));
    return v_flex().id('agent-launcher').w_full().max_h(550).min_h(0).p(SPACE.card).gap(SPACE.row).bg(t.popover).text_color(t.foreground).text_size(TYPE.body)
      .key_context('agent-launcher').track_focus(this.handle).on_key_down((event,cx)=>this.key(event,cx))
      .child(dialogHeader(models?`${agent?.name??'Agent'} · Models`:'New session',
        ()=>closeOverlay(props().overlay),models||title?cx=>this.back(cx):null))
      .when(showFixedDestination,el=>el.child(this.destinationView(target)))
      .when(showPicker,el=>el.child(this.selector.select('launch-space',space?`${space.name} · ${space.machine??'Local'}`:'Choose an existing Space…',this.selector.spaceChoices(),this.selector.spaceId,(id,cx)=>{
        this.selector.chooseSpace(id,cx);this.page='agents';this.agentIndex=null;this.search.set_value('');this.search.focus();
      },{detail:space?.folder})))
      .when(showSearch,el=>el.child(div().h(HEIGHT.header).flex_none().on_key_down((event,cx)=>this.key(event,cx))
        .child(dialogInput(models?this.modelSearch:this.search,models?'launch-model-search':'launch-search',
          {label:models?'Search models':'Search agents',focused:this.inputFocus===this.page}))))
      .when(!title,el=>el.child(list))
      .when(title,el=>el.child(this.titleView()))
      .when(models&&this.selector.modelsLoading,el=>el.child(h_flex().gap(SPACE.icon).items_center().text_size(TYPE.meta).text_color(t.muted)
        .child(loadingSpinner(t)).child('Checking models…')))
      .when(models&&!this.selector.modelsLoading&&Boolean(this.selector.modelNote),el=>el.child(
        div().text_size(TYPE.meta).text_color(t.muted).whitespace_normal().child(this.selector.modelNote)))
      .when(this.showCustom,el=>el.child(dialogInput(this.selector.custom,'launch-custom-model',{label:'Custom model',focused:this.inputFocus==='custom',invalid:Boolean(this.selector.model&&!validModel(this.selector.model))})))
      .when(Boolean(blocking),el=>el.child(div().flex_none().text_size(TYPE.meta).text_color(t.ansi1).whitespace_normal().child(blocking)))
      .child(h_flex().id('launch-footer').h(HEIGHT.header).flex_none().gap(SPACE.row).items_center()
        .when(Boolean(this.returnContext),el=>el.child(button('launch-change-destination','Change destination',cx=>this.changeDestination(cx),
          {variant:'ghost',height:HEIGHT.header,disabled:this.starting,reason:'Starting session…'})))
        .child(div().flex_1())
        .child(button('launch-cancel','Cancel',()=>closeOverlay(props().overlay),{variant:'ghost',height:HEIGHT.header}))
        .child(button('launch-start',models?'Use model ↵':title||this.taskSessionTitle?(this.starting?'Starting session…':'Start session ↵'):'Continue ↵',cx=>this.submit(cx),{variant:'primary',height:HEIGHT.header,disabled:Boolean(actionError)||this.starting,reason:actionError||'Starting session…'})));
  }
}
