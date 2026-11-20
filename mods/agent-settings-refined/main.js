import { View, div, svg, image } from 'gpui-kit';
import { h_flex, v_flex, InputState, Scrollbar } from 'gpui-base';
import { theme, appHome, readTextFile, writeTextFile, knownAgents, machines, shared, setShared, checking, props, closeOverlay } from 'herdr';
import { button, dialogIconButton, dialogInput, trackInputFocus } from './ui.js';
import { TYPE, HEIGHT, RADIUS, SPACE, ICON_SIZE, cardHeader, controlState } from './ui-kit.js';
import { catalog, editAgent, iconsFor, newAgentKey, parseCommand, parseConfig, programIcons, quoteCommand, ICONS_KEY } from './model.js';

const DEFAULT = {icon:'icons/herdr-agent-glyphs/terminal.svg',tint:true};
const icon = (style,t,size=ICON_SIZE.program) => style?.icon
  ? (style.tint ? svg(style.icon).size(size).text_color(t.foreground) : image(style.icon).size(size)).flex_none()
  : svg(DEFAULT.icon).size(size).text_color(t.muted).flex_none();

export default class AgentSettings extends View {
  init(_,cx) {
    this.rows=[]; this.raw=null; this.config={}; this.ready=false; this.loading=true;
    this.local=[]; this.remote=[]; this.agent=null; this.form=null; this.busy=false;
    this.file=appHome()+'/programs.json';
    this.search=InputState.new({placeholder:'Search agents…'});
    trackInputFocus(this.search);
    this.search.on('change',(_e,cx)=>cx.notify());
    this.handle=cx.focus_handle();
    this.handle.focus();
    if(!checking())this.load(cx);
  }

  load(cx) {
    this.loading=true;
    cx.spawn(async cx=>{
      try {
        const remoteHosts=machines().filter(machine=>machine.name&&machine.layout==='ready');
        const [raw, local, remote]=await Promise.all([
          readTextFile(this.file),
          knownAgents({on:null}).catch(()=>null),
          Promise.all(remoteHosts.map(machine=>knownAgents({on:machine.name}).catch(()=>[]))).then(rows=>rows.flat()),
        ]);
        this.config=parseConfig(raw); this.raw=raw;
        const icons=programIcons(this.config);
        if(JSON.stringify(shared(ICONS_KEY))!==JSON.stringify(icons))setShared(ICONS_KEY,icons);
        this.local=local??[]; this.remote=remote??[];
        this.catalogError=!local?'Local installation check unavailable.':null;
        this.rows=catalog(this.config,this.local,this.remote);
        const visible=this.rows.filter(row=>row.removed===Boolean(this.showRemoved));
        const previous=visible.find(row=>row.key===this.agent?.key);
        this.select(previous??visible.find(row=>row.key==='codex')??visible[0],cx);
        this.ready=true;
      } catch(e) { this.error=String(e.message??e); }
      finally { this.loading=false; cx.notify(); }
    });
  }

  select(row,cx) {
    this.agent=row; this.error=null; this.removeConfirm=false;
    if(!row){this.form=null;cx.notify();return;}
    const name=InputState.new({value:row.name,placeholder:'Agent name'});
    const command=InputState.new({value:quoteCommand(row.run),placeholder:'Executable and arguments'});
    for(const input of [name,command]) {
      trackInputFocus(input);
      input.on('change',(_e,cx)=>{this.error=null;cx.notify();});
    }
    this.form={name,command,choice:row.choice,disabled:row.disabled};
    cx.notify();
  }

  add(cx) {
    if(!this.ready||this.busy)return;
    this.showRemoved=false;
    this.select({key:'',name:'',run:[],original:DEFAULT,choice:'mono',custom:true,disabled:false,removed:false},cx);
    this.form.name.focus();
  }

  save(change,cx) {
    if(this.busy||!this.agent||!this.ready)return;
    const current=this.agent;
    let row=current,next;
    try {
      if(!current.key)row={...current,key:newAgentKey(change.name,this.config,this.rows)};
      next=editAgent(this.config,row,change);
    } catch(e) { this.error=String(e.message??e);cx.notify();return; }
    const payload=JSON.stringify(next,null,2)+'\n', expected=this.raw;
    this.busy=true; this.error=null; cx.notify();
    cx.spawn(async cx=>{
      try {
        await writeTextFile(this.file,payload,expected);
        this.raw=payload; this.config=next;
        setShared(ICONS_KEY,programIcons(next));
        this.rows=catalog(next,this.local,this.remote);
        const updated=this.rows.find(entry=>entry.key===row.key);
        this.showRemoved=Boolean(updated?.removed);
        this.select(updated,cx);
        this.notice=updated?.removed?'Removed from the launcher.':'Agent settings saved.';
      } catch(e) {
        this.error='Couldn’t save programs.json. Reload settings to check for changes. '+String(e.message??e);
      } finally { this.busy=false; cx.notify(); }
    });
  }

  saveForm(cx) {
    const f=this.form, name=f.name.value().trim();
    if(!name) { this.error='Enter an agent name.';cx.notify();return; }
    try {
      const run=parseCommand(f.command.value());
      const change={name,choice:f.choice,disabled:f.disabled};
      if(quoteCommand(run)!==quoteCommand(this.agent.run)||!this.agent.key)change.run=run;
      this.save(change,cx);
    } catch(e) { this.error=String(e.message??e);cx.notify(); }
  }

  chooseList(removed,cx) {
    this.showRemoved=removed;
    this.select(this.rows.find(row=>row.removed===removed),cx);
  }

  field(label,id,state) {
    const t=theme();
    return v_flex().gap(SPACE.small)
      .child(div().text_size(TYPE.meta).text_color(t.muted).child(label))
      .child(dialogInput(state,id,{label}));
  }

  availability(row) {
    if(row.local&&row.remote)return 'Local · Remote';
    if(row.local)return 'Local';
    if(row.remote)return 'Remote';
    return this.catalogError?'Unverified':'Not installed';
  }

  list(t) {
    const query=this.search.value().trim().toLowerCase(), removed=Boolean(this.showRemoved);
    const nonempty=this.rows.some(row=>row.removed);
    const rows=this.rows.filter(row=>row.removed===removed&&row.name.toLowerCase().includes(query));
    return v_flex().w(242).flex_none().min_h(0).h_full().p(SPACE.card).gap(SPACE.row).border_r(1).border_color(t.border)
      .child(dialogInput(this.search,'agent-settings-search',{label:'Search agents'}))
      .when(nonempty,el=>el.child(h_flex().gap(SPACE.small)
        .child(button('listed-agents','Agents',cx=>this.chooseList(false,cx),{variant:'ghost',selected:!removed}))
        .child(button('removed-agents','Removed',cx=>this.chooseList(true,cx),{variant:'ghost',selected:removed}))))
      .child(v_flex().flex_1().min_h(0).relative()
        .child(v_flex().id('agent-settings-list').absolute().inset_0().gap(SPACE.small).overflow_y_scroll()
          .children(rows.map(row=>this.listRow(row,t)))
          .when(!rows.length,el=>el.child(div().p(SPACE.row).text_size(TYPE.meta).text_color(t.muted).child(this.loading?'Checking agents…':'No matching agents.'))))
        .child(Scrollbar.vertical('agent-settings-list').absolute().inset_0()));
  }

  listRow(row,t) {
    const current=this.agent?.key===row.key;
    const style=iconsFor(row).find(choice=>choice.id===row.choice);
    const entry=h_flex().id('agent-row-'+row.key).h(HEIGHT.row).flex_none().px(SPACE.row).gap(SPACE.icon)
      .items_center().rounded(RADIUS.control).text_color(t.foreground)
      .role('list_box_option').aria_selected(current)
      .when(!this.busy,el=>el.cursor_pointer().on_click((_e,cx)=>{if(!this.busy)this.select(row,cx);}))
      .child(icon(style,t))
      .child(div().flex_1().min_w(0).truncate().text_size(TYPE.body).child(row.name))
      .child(div().flex_none().text_size(TYPE.meta).text_color(t.muted).child(row.disabled?'Off':this.availability(row)));
    return controlState(entry,t,{selected:current,disabled:this.busy});
  }

  iconPickers(t,row) {
    return v_flex().gap(SPACE.icon)
      .child(div().text_size(TYPE.meta).text_color(t.muted).child('Icon'))
      .child(h_flex().flex_wrap().gap(SPACE.small).children(iconsFor(row).map(choice=>{
        const selected=this.form.choice===choice.id;
        const entry=h_flex().id('agent-icon-'+choice.id).h(HEIGHT.header).px(SPACE.row).gap(SPACE.icon)
          .items_center().rounded(RADIUS.control).border_1().border_color(t.input)
          .cursor_pointer().role('menu_item_radio').aria_selected(selected)
          .on_click((_e,cx)=>{this.form.choice=choice.id;cx.notify();})
          .child(icon(choice,t)).child(div().text_size(TYPE.control).child(choice.label));
        return controlState(entry,t,{selected});
      })));
  }

  message(text,color) {
    return div().text_size(TYPE.meta).whitespace_normal().text_color(color).child(text);
  }

  editor(t) {
    const row=this.agent,f=this.form;
    if(!row||!f)return div().p(SPACE.card).text_color(t.muted).child(this.loading?'Checking agents…':'Choose an agent to edit its settings.');
    if(row.removed)return v_flex().p(SPACE.card).gap(SPACE.row)
      .child(div().text_size(TYPE.title).font_semibold().child(row.name))
      .child(div().text_color(t.muted).child('Removed agents are hidden from the launcher.'))
      .when(Boolean(this.error),el=>el.child(this.message(this.error,t.ansi1)))
      .child(h_flex().justify_end().child(button('restore-agent','Restore agent',cx=>this.save({removed:false},cx),{variant:'primary',height:HEIGHT.header,disabled:this.busy})));
    const status=row.key?this.availability(row):'';
    const currentIcon=iconsFor(row).find(choice=>choice.id===f.choice);
    return v_flex().gap(SPACE.card).p(SPACE.card)
      .child(h_flex().gap(SPACE.row).items_center()
        .child(div().size(HEIGHT.rowTwo).flex_none().flex().items_center().justify_center().rounded(RADIUS.surface).border_1().border_color(t.border).bg(t.raised).child(icon(currentIcon,t,ICON_SIZE.program)))
        .child(v_flex().flex_1().min_w(0).gap(SPACE.small)
          .child(div().truncate().text_size(TYPE.title).font_semibold().child(row.name||'New agent'))
          .when(Boolean(status),el=>el.child(div().text_size(TYPE.meta).text_color(t.muted).child(status))))
        .child(button('agent-enabled',f.disabled?'Disabled':'Enabled',cx=>{f.disabled=!f.disabled;cx.notify();},
          {height:HEIGHT.header,disabled:this.busy})))
      .child(this.field('Name','agent-settings-name',f.name))
      .child(this.field('Launch command','agent-settings-command',f.command))
      .child(this.iconPickers(t,row))
      .when(Boolean(this.error),el=>el.child(this.message(this.error,t.ansi1)))
      .child(h_flex().items_center().gap(SPACE.row)
        .when(Boolean(row.key),el=>el.child(button('agent-settings-remove',this.removeConfirm?'Confirm removal':'Remove',cx=>{
          if(this.removeConfirm)this.save({removed:true},cx);
          else {this.removeConfirm=true;cx.notify();}
        },{variant:'danger',height:HEIGHT.header,disabled:this.busy})))
        .child(div().flex_1())
        .child(button('agent-settings-save',this.busy?'Saving…':'Save',cx=>this.saveForm(cx),{variant:'primary',height:HEIGHT.header,disabled:this.busy})));
  }

  render() {
    const t=theme();
    const close=()=>closeOverlay(props()?.overlay);
    const message=this.error?(this.form?null:this.error):this.notice||this.catalogError;
    return v_flex().id('agent-settings').size_full().min_h(0).bg(t.popover).text_color(t.foreground).text_size(TYPE.body)
      .track_focus(this.handle).key_context('agent-settings').on_key_down((e,cx)=>{
        if(e.key==='escape'&&!this.busy){cx.stop_propagation();close();}
      })
      .child(cardHeader(t)
        .child(div().flex_1().text_size(TYPE.title).font_semibold().child('Agents'))
        .child(button('reload-agents','Reload',cx=>{this.error=null;this.notice=null;this.load(cx);},{variant:'ghost',disabled:this.busy||this.loading}))
        .child(button('add-agent','Add agent',cx=>this.add(cx),{variant:'secondary',disabled:!this.ready||this.busy}))
        .child(dialogIconButton(t,'close-agent-settings','Close agent settings','close',close,this.busy)))
      .child(h_flex().flex_1().min_h(0).child(this.list(t))
        .child(v_flex().relative().flex_1().min_w(0).h_full().min_h(0)
          .child(v_flex().id('agent-settings-detail').absolute().inset_0().overflow_y_scroll().child(this.editor(t)))
          .child(Scrollbar.vertical('agent-settings-detail').absolute().inset_0())))
      .when(Boolean(this.error||this.notice||this.catalogError),el=>el
        .child(div().px(SPACE.card).py(SPACE.row).text_size(TYPE.meta).whitespace_normal().text_color(this.error?t.ansi1:t.muted)
          .child(this.error||this.notice||this.catalogError)));
  }
}
