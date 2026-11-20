// Native Automations panel. Scheduling/history are owned by the existing Go service.
import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, TextareaState, Textarea } from "gpui-base";
import { exec, home, theme, terminals, spaces, run, notify, watchFolder, checking } from "herdr";
import { Selection } from "./launcher/selection.js";
import { button as sharedButton, dialogIcon, dialogInput, trackInputFocus } from "./launcher/ui.js";
import { automationInput, automationSpace, automationRows, promptArguments, expandPrompt, SUPPORTED_AUTOMATION_AGENTS } from "./model.js";
import { TYPE, HEIGHT, RADIUS, SPACE, ICON_SIZE, cardHeader, controlState, iconControl } from "./ui-kit.js";

const PRESETS = [["Hourly", "0 * * * *"], ["Every morning", "0 9 * * *"], ["Weekdays 9:00", "0 9 * * 1-5"], ["Mondays 9:00", "0 9 * * 1"]];
const FINISHED = new Set(["done", "failed", "cancelled", "missed", "skipped"]);
const SECTIONS = [["manual", "Manual"], ["schedules", "Schedules"], ["history", "History"]];
const human = cron => PRESETS.find(([,c]) => c === cron)?.[0] ?? cron;
function ago(iso) { const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000); return !Number.isFinite(s) ? "" : s < 60 ? "now" : s < 3600 ? `${Math.round(s/60)}m ago` : s < 86400 ? `${Math.round(s/3600)}h ago` : `${Math.round(s/86400)}d ago`; }
function next(iso) { const date = new Date(iso); if (!Number.isFinite(date.getTime()) || date.getFullYear() < 2000) return ""; return `${["Sun","Mon","Tue","Wed","Thu","Fri","Sat"][date.getDay()]} ${date.toTimeString().slice(0,5)}`; }

export default class Automations extends View {
  init(_props, cx) {
    this.list = null; this.runs = []; this.historyReady = false; this.view = {kind:"list"}; this.error = null; this.note = null;
    this.section = localStorage.getItem("automations.section") || "manual";
    this.known = null; this.refreshing = false; this.handle = cx.focus_handle();
    if (checking()) return;
    cx.spawn(async cx => { this.bin = `${home()}/.local/bin/herdr-automations`; await this.refresh(cx); this.watch(cx); });
    cx.timer.every(15000, cx => this.refresh(cx));
  }
  async cli(args, input) {
    // Exec has no stdin API: positional data feeds a fixed shell program.
    const r = input === undefined ? await exec(this.bin,args) : await exec("sh",["-c",'bin=$1 json=$2; shift 2; printf %s "$json" | "$bin" "$@"',"sh",this.bin,JSON.stringify(input),...args]);
    if (r.code !== 0) throw Error((r.stderr || r.stdout).trim().replace(/^error: /,""));
    return r.stdout;
  }
  async refresh(cx) {
    if (!this.bin || this.refreshing) return;
    this.refreshing = true;
    try { this.list = JSON.parse(await this.cli(["ls","--json"])); this.runs = JSON.parse(await this.cli(["history","--json"])); this.historyReady = true; this.error = null; this.announce(); }
    catch(e) { this.error = String(e.message ?? e); }
    finally { this.refreshing = false; cx.notify(); }
  }
  watch(cx) {
    for (const dir of [this.list?.config?.replace(/\/[^/]+$/,""),this.list?.state].filter(Boolean)) cx.spawn(async cx => {
      for (;;) { try { await watchFolder(dir); } catch { return; } await this.refresh(cx); }
    });
  }
  announce() {
    if (this.known) for (const r of this.runs) {
      if (!this.known.has(r.run_id) && ["failed","missed"].includes(r.status)) notify({title:`${r.automation}: ${r.status}`,body:r.error || "",level:r.status === "failed" ? "error" : "warning"});
    }
    this.known = new Set(this.runs.map(r => r.run_id));
  }
  live(address) { return terminals().find(t => t.address === address && t.state === "live"); }
  liveFor(name) { return terminals().find(t => t.labels?.automation === name && t.state === "live" && ["working","blocked"].includes(typeof t.status === "string" ? t.status : t.status?.state)); }
  act(cx,args,done,input) {
    if (this.acting) return;
    this.acting = true; this.note = null;
    cx.spawn(async cx => { try { await this.cli(args,input); done?.(); } catch(e) { this.note = String(e.message ?? e); } finally { this.acting = false; await this.refresh(cx); cx.notify(); } });
  }
  runProblem(a) {
    return !a ? "This automation no longer exists." : a.disabled ? "This automation is inactive. Activate it before running." : this.liveFor(a.name) ? "This automation is already running." : !automationSpace(a,spaces()) ? "Edit this automation to select an available destination." : this.acting ? "An automation action is in progress." : "";
  }
  trigger(a,cx) {
    this.note = this.runProblem(a);
    if (this.note) { cx.notify(); return; }
    try {
      const names = a.manual ? promptArguments(a.prompt || "") : [];
      if (names.length) {
        this.arguments = {name:a.name,prompt:a.prompt,back:this.view,error:null,fields:names.map(name=>{
          const input=InputState.new({value:"",placeholder:name});
          trackInputFocus(input);
          input.on("change",(_e,cx)=>{if(this.arguments)this.arguments.error=null;cx.notify();});
          return {name,input};
        })};
        this.view={kind:"arguments"};cx.notify();return;
      }
      this.act(cx,["run",a.name,"--bg"]);
    } catch(e) { this.note=String(e.message??e);cx.notify(); }
  }
  cancelArguments(cx) {
    this.view=this.arguments?.back??{kind:"list"};this.arguments=null;cx.notify();
  }
  argumentValues() {
    return Object.fromEntries(this.arguments.fields.map(f=>[f.name,f.input.value()]));
  }
  argumentProblem() {
    const f=this.arguments,a=this.list?.automations.find(a=>a.name===f.name);
    const problem=this.runProblem(a);
    if(problem)return problem;
    if(!a.manual||a.prompt!==f.prompt)return "The automation changed. Cancel and run it again.";
    try { expandPrompt(f.prompt,this.argumentValues());return ""; } catch(e) { return String(e.message??e); }
  }
  launchArguments(cx) {
    if(!this.arguments||this.acting)return;
    const problem=this.argumentProblem();
    if(problem){this.arguments.error=problem;cx.notify();return;}
    const f=this.arguments,values=this.argumentValues();
    this.act(cx,["run",f.name,"--bg","--arguments-stdin"],()=>this.cancelArguments(cx),values);
  }
  open(r,cx) {
    if (!r.seen && FINISHED.has(r.status)) this.act(cx,["seen",r.run_id]);
    if (r.terminal && this.live(r.terminal)) run("pane.focus",{terminal:r.terminal});
    else { this.view = {kind:"detail",name:r.automation}; cx.notify(); }
  }
  edit(original,cx) {
    const a = this.list?.automations.find(x => x.name === original) ?? {name:"",cron:"0 9 * * 1-5",manual:this.section === "manual",agent:"claude",prompt:"",timeout_minutes:60};
    const field = (value, placeholder) => {
      const state = InputState.new({value:String(value ?? ""),placeholder});
      trackInputFocus(state);
      state.on("change",(_e,cx)=>{this.form.result=null;cx.notify();});
      return state;
    };
    const target = automationSpace(a,spaces()) ?? (!original ? spaces().find(s => s.active) : null);
    this.form = {original,manual:Boolean(a.manual),disabled:Boolean(a.disabled),name:field(a.name,"daily-review"),cron:field(a.cron,"0 9 * * 1-5"),timeout:field(a.timeout_minutes ?? 60,"60"),prompt:TextareaState.new({placeholder:"What should the agent do?",value:a.prompt || ""}),result:null};
    this.form.prompt.set_auto_grow(4,12); this.form.prompt.on("change",(_e,cx)=>cx.notify());
    this.form.selection = new Selection(); this.form.selection.init({space:target?.id ?? "__choose_space__",agent:a.agent,model:a.model || "",allowedAgents:SUPPORTED_AUTOMATION_AGENTS,onChange:cx=>{if(this.form){this.form.result=null;cx.notify();}}},cx);
    this.view = {kind:"form"}; cx.notify();
  }
  entry() { const f = this.form; return automationInput({name:f.name.value(),cron:f.cron.value(),manual:f.manual,disabled:f.disabled,prompt:f.prompt.value(),timeout:f.timeout.value()}, f.selection.value()); }
  async put(dryRun) {
    const entry = this.entry(), args = ["put",...(this.form.original ? ["--original",this.form.original] : []),...(dryRun ? ["--dry-run"] : [])];
    // Literal JSON is stdin, never interpolated shell code; exec currently has no stdin option.
    const r = await exec("sh",["-c",'bin=$1 json=$2; shift 2; printf %s "$json" | "$bin" "$@"',"sh",this.bin,JSON.stringify(entry),...args]);
    if (r.code !== 0) throw Error((r.stderr || r.stdout).trim());
    return JSON.parse(r.stdout);
  }
  save(cx) {
    if (this.saving) return; const f = this.form; this.saving = true;
    cx.spawn(async cx => { try { const res = await this.put(false); if(res.problem) f.result = res; else { this.section = f.manual ? "manual" : "schedules"; this.view={kind:"detail",name:f.name.value().trim()}; this.form=null; } } catch(e) { f.result={problem:String(e.message ?? e)}; } finally { this.saving=false; await this.refresh(cx); cx.notify(); } });
  }
  button(id,label,click,options) {
    return sharedButton(id,label,cx=>{cx.stop_propagation();click(cx);},options);
  }
  input(id,state,label) {
    return dialogInput(state,id,{label}).h(HEIGHT.control);
  }
  switch_(id,on,t,toggle) {
    const label = on ? "Deactivate automation" : "Activate automation";
    return controlState(h_flex().id(id).h(HEIGHT.control).px(SPACE.small).gap(SPACE.icon).flex_none().items_center()
      .rounded(RADIUS.control).cursor_pointer().accessibility_label(label).tooltip(label)
      .on_click((_e,cx)=>{cx.stop_propagation();toggle(cx);})
      .child(div().text_size(TYPE.meta).text_color(on?t.ansi2:t.muted).child(on?"Active":"Inactive"))
      .child(h_flex().w(HEIGHT.control).h(SPACE.section).rounded(RADIUS.surface).p(2).bg(on?t.accent:t.input)
        .when(on,e=>e.justify_end()).child(div().size(ICON_SIZE.mini).rounded(SPACE.icon).bg(t.background))), t);
  }
  createLabel() { return this.section==="manual" ? "New manual automation" : "New schedule"; }
  sectionTabs(t) {
    return h_flex().id("automation-sections").flex_1().min_w(0).gap(SPACE.small).items_center()
      .role("tab_list").accessibility_label("Automation sections")
      .children(SECTIONS.map(([id,label]) => {
        const selected = this.section === id;
        return controlState(h_flex().id(`automation-tab-${id}`).h(HEIGHT.control).px(SPACE.row).min_w(0).items_center()
          .rounded(RADIUS.control).text_size(TYPE.control).text_color(selected ? t.foreground : t.muted)
          .role("tab").aria_selected(selected).accessibility_label(label).tooltip(label).cursor_pointer()
          .when(selected, e => e.font_medium())
          .on_click((_e,cx) => { this.section=id;localStorage.setItem("automations.section",id);cx.notify(); })
          .child(div().min_w(0).truncate().child(label)), t, { selected });
      }));
  }
  warning(id,message,label,action,t) {
    return h_flex().id(id).px(SPACE.card).py(SPACE.row).gap(SPACE.row).items_center().border_b(1).border_color(t.border)
      .child(div().flex_1().min_w(0).whitespace_normal().text_size(TYPE.control).text_color(t.ansi3).child(message))
      .child(this.button(`${id}-action`,label,action,{variant:"ghost"}));
  }
  render(cx) {
    const t=theme(),back=this.view.kind!=="list";
    const root=v_flex().id("automations").size_full().min_h(0).bg(t.background).rounded(RADIUS.card)
      .overflow_hidden().border_1().border_color(t.border).text_color(t.foreground).text_size(TYPE.body)
      .track_focus(this.handle).focus(s => s.border_color(t.accent));
    if(back)root.child(cardHeader(t)
      .child(iconControl(t, "Back to automations", dialogIcon("chevron-left"))
        .id("auto-back").on_click((_e,cx)=>{if(this.arguments)this.cancelArguments(cx);else{this.view={kind:"list"};this.form=null;cx.notify();}}))
      .child(div().font_medium().child("Automations")));
    else root.child(cardHeader(t).px(SPACE.row)
      .child(this.sectionTabs(t))
      .when(this.section!=="history"&&Boolean(this.list&&automationRows(this.list.automations,this.section).length), e =>
        e.child(iconControl(t, this.createLabel(), svg("mods/automations-refined/plus.svg").size(ICON_SIZE.control))
          .id("automation-create").on_click((_e,cx)=>this.edit(null,cx)))));
    if(this.error||this.note)root.child(h_flex().px(SPACE.card).py(SPACE.row).gap(SPACE.row).items_center()
      .child(div().flex_1().min_w(0).whitespace_normal().text_size(TYPE.control).text_color(t.ansi1).child(this.error||this.note))
      .when(Boolean(this.error),e=>e.child(this.button("automation-retry","Retry",cx=>cx.spawn(cx=>this.refresh(cx)),{variant:"ghost"}))));
    if(this.section==="schedules"&&this.list&&!this.list.scheduler)root.child(this.warning("scheduler-stopped","Scheduler is stopped. Schedules will not run.","Start scheduler",cx=>this.act(cx,["service","install"]),t));
    if(this.section==="schedules"&&this.list?.paused)root.child(this.warning("legacy-pause","A global pause is holding schedules.","Resume schedules",cx=>this.act(cx,["resume","--all"]),t));
    const body=this.view.kind==="arguments"?this.renderArguments(t,cx):this.view.kind==="form"?this.renderForm(t,cx):this.view.kind==="detail"?this.renderDetail(t,cx):this.section==="history"?this.renderHistory(t,cx):this.renderList(t,cx);
    return root.child(div().id("automations-body").flex_1().min_h(0).overflow_y_scrollbar().child(body));
  }
  renderList(t) {
    const col=v_flex().p(SPACE.small);if(!this.list)return col.child(div().p(SPACE.row).text_color(t.muted).child(this.error?"Couldn’t load automations.":"Loading automations…"));
    const entries=automationRows(this.list.automations,this.section);
    if(!entries.length)col.child(v_flex().id("automation-empty").px(SPACE.card).py(SPACE.section).gap(SPACE.row).items_center()
      .child(div().id("automation-empty-title").text_size(TYPE.body).font_medium().child(this.section==="manual"?"No manual automations yet":"No schedules yet"))
      .child(div().id("automation-empty-body").text_size(TYPE.control).text_color(t.muted).whitespace_normal().child(this.section==="manual"?"Save a prompt you run on demand.":"Run an agent in a Space on a cron schedule."))
      .child(this.button("automation-empty-create",this.createLabel(),cx=>this.edit(null,cx),{solid:true})));
    for(const a of entries)col.child(this.row(a,t));
    for(const d of this.list.invalid??[])col.child(div().p(SPACE.row).text_color(t.ansi1).text_size(TYPE.control).whitespace_normal().child(`${d.name||"Invalid entry"}: ${d.message}`));
    return col;
  }
  row(a,t) {
    const sp=automationSpace(a,spaces()),live=this.liveFor(a.name);
    const runReason=a.disabled?"Activate this automation before running.":live?"This automation is already running.":this.acting?"An automation action is in progress.":!sp?"Edit this automation to select an available destination.":"";
    const nextRun = next(a.next);
    const sub = live ? "Running" : a.disabled ? "" : a.manual ? "On demand"
      : [human(a.cron), nextRun ? `Next run ${nextRun}` : ""].filter(Boolean).join(" · ");
    const target = [sp?.name, a.machine || "Local", a.agent || a.template, a.model].filter(Boolean).join(" · ");
    const meta = [sp ? "" : "Destination unavailable", sub, target].filter(Boolean).join(" · ");
    const runLabel = `Run ${a.name}`;
    const play = svg("mods/automations-refined/play.svg").size(ICON_SIZE.control);
    const runButton = runReason
      ? controlState(div().size(HEIGHT.control).flex_none().flex().items_center().justify_center().text_color(t.dim)
        .accessibility_label(runLabel).tooltip(runReason).child(play), t, { disabled: true })
      : iconControl(t, runLabel, play).on_click((_e,cx) => {cx.stop_propagation();this.trigger(a,cx);});
    return controlState(h_flex().id(`auto-${a.name}`).h(HEIGHT.rowTwo).flex_none().px(SPACE.row)
      .gap(SPACE.small).items_center().rounded(RADIUS.control).cursor_pointer()
      .on_click((_e,cx)=>{this.view={kind:"detail",name:a.name};cx.notify();})
      .child(v_flex().flex_1().min_w(0)
        .child(div().truncate().tooltip(a.name).child(a.name))
        .child(div().id(sp ? `auto-${a.name}-meta` : `unavailable-${a.name}`).min_w(0).truncate().text_size(TYPE.meta)
          .text_color(!sp ? t.ansi3 : live ? t.working : t.muted)
          .tooltip(meta).child(meta)))
      .child(this.switch_(`enabled-${a.name}`,!a.disabled,t,cx=>this.act(cx,[a.disabled?"resume":"pause",a.name])))
      .child(runButton.id(`run-${a.name}`)), t);
  }
  historyRow(r,t) {
    const failure = ["failed","missed"].includes(r.status);
    const unread = !r.seen && failure;
    const meta = [r.trigger, ago(r.at), r.seconds ? `${r.seconds}s` : "", r.terminal].filter(Boolean).join(" · ");
    const mark = ({done:"✓",failed:"✕",missed:"◷",cancelled:"⊘",skipped:"↷",running:"◌"})[r.status] ?? "·";
    return controlState(v_flex().id(`run-${r.run_id}`).min_h(HEIGHT.rowTwo).flex_none().justify_center()
      .px(SPACE.row).py(SPACE.small).rounded(RADIUS.control).cursor_pointer()
      .on_click((_e,cx)=>this.open(r,cx))
      .child(h_flex().gap(SPACE.icon).items_center()
        .child(div().id(`run-${r.run_id}-title`).flex_1().min_w(0).truncate().tooltip(r.automation)
          .when(unread, e => e.font_medium()).child(r.automation))
        .child(div().flex_none().text_size(TYPE.meta).text_color(r.status === "done" ? t.ansi2 : failure ? t.ansi1 : t.muted)
          .child(`${mark} ${r.status}`))
        .child(div().id(`run-${r.run_id}-unread`).size(SPACE.icon).flex_none().rounded(RADIUS.inline)
          .when(unread, e => e.bg(t.done).accessibility_label("Unread").tooltip("Unread"))))
      .child(div().min_w(0).truncate().text_size(TYPE.meta).text_color(t.muted).tooltip(meta).child(meta))
      .when(Boolean(r.error),e=>e.child(div().pt(SPACE.small).text_size(TYPE.control).text_color(t.ansi1)
        .whitespace_normal().child(r.error))), t);
  }
  renderHistory(t) {
    if(!this.historyReady&&!this.runs.length)
      return div().p(SPACE.card).text_color(t.muted).child(this.error?"Couldn’t load run history.":"Loading run history…");
    const list=this.runs.filter(r=>r.status!=="scheduled");
    return v_flex().p(SPACE.small).children(list.length?list.map(r=>this.historyRow(r,t)):[div().p(SPACE.row).text_color(t.muted).child("No runs yet.")]);
  }
  renderDetail(t) {
    const a=this.list?.automations.find(x=>x.name===this.view.name);if(!a)return div().p(SPACE.card).text_color(t.muted).child("This automation is unavailable.");
    const sp=automationSpace(a,spaces());const recent=this.runs.filter(r=>r.automation===a.name&&r.status!=="scheduled");
    return v_flex().p(SPACE.card).gap(SPACE.row).child(this.row(a,t))
      .child(h_flex().gap(SPACE.icon).child(this.button("automation-edit","Edit",cx=>this.edit(a.name,cx))).child(this.button("automation-delete",this.deleting===a.name?"Confirm delete":"Delete",cx=>{if(this.deleting!==a.name){this.deleting=a.name;cx.notify();return;}this.act(cx,["rm",a.name],()=>{this.view={kind:"list"};this.deleting=null;});},{danger:true})))
      .child(div().text_size(TYPE.meta).text_color(t.muted).child(`Space: ${sp?.name??"Unavailable"}${a.machine?` (${a.machine})`:""}`))
      .child(div().p(SPACE.row).bg(t.raised).rounded(RADIUS.control).whitespace_normal().text_size(TYPE.control).child(a.prompt||a.workflow||""))
      .child(div().pt(SPACE.small).text_size(TYPE.meta).text_color(t.muted).child("Recent runs"))
      .child(v_flex().children(recent.length?recent.slice(0,30).map(r=>this.historyRow(r,t))
        :[div().text_color(t.muted).text_size(TYPE.control).child("No runs yet.")]));
  }
  renderArguments(t) {
    const f=this.arguments,problem=this.argumentProblem();
    return v_flex().id("automation-arguments").p(SPACE.card).gap(SPACE.row)
      .child(div().text_size(TYPE.body).font_medium().child(`Run ${f.name}`))
      .child(div().text_size(TYPE.control).text_color(t.muted).whitespace_normal().child("Fill in this run's arguments. The saved template stays unchanged."))
      .children(f.fields.map((field,index)=>v_flex().gap(SPACE.small)
        .child(div().text_size(TYPE.meta).text_color(t.muted).child(field.name))
        .child(this.input(`argument-${index}`,field.input,field.name))))
      .when(Boolean(f.error),e=>e.child(div().text_size(TYPE.control).text_color(t.ansi1).whitespace_normal().child(f.error)))
      .child(h_flex().pt(SPACE.row).gap(SPACE.icon).justify_end()
        .child(this.button("arguments-cancel","Cancel",cx=>this.cancelArguments(cx),{disabled:this.acting,reason:this.acting?"Starting automation…":""}))
        .child(this.button("arguments-run",this.acting?"Starting…":"Run",cx=>this.launchArguments(cx),{solid:true,disabled:Boolean(problem),reason:problem})));
  }
  renderForm(t) {
    const f=this.form,label=text=>div().pt(SPACE.row).text_size(TYPE.meta).text_color(t.muted).child(text);
    const box=v_flex().p(SPACE.card).gap(SPACE.icon).child(div().text_size(TYPE.body).font_medium().child(f.original?`Edit ${f.original}`:f.manual?"New manual automation":"New schedule"))
      .child(f.selection.render({id:"automation-target"}))
      .child(label("Name")).child(this.input("f-name",f.name,"Name"));
    if(!f.manual)box.child(label("Schedule")).child(h_flex().gap(SPACE.small).flex_wrap().children(PRESETS.map(([name,cron])=>this.button(`preset-${name}`,name,cx=>{f.cron.set_value(cron);f.result=null;cx.notify();})))).child(this.input("f-cron",f.cron,"Schedule"));
    return box.child(label("Prompt")).child(Textarea.new(f.prompt).id("f-prompt").w_full().p(SPACE.row)
      .rounded(RADIUS.control).border_1().border_color(t.input).bg(t.background).focus(s => s.border_color(t.accent))
      .text_size(TYPE.control).text_color(t.foreground).accessibility_label("Prompt"))
      .when(f.manual,e=>e.child(div().text_size(TYPE.meta).text_color(t.muted).whitespace_normal().child('For a value requested at launch, use {argument name="Granola link"}. Repeated names are asked once.')))
      .child(label("Timeout (minutes)")).child(this.input("f-timeout",f.timeout,"Timeout (minutes)"))
      .child(h_flex().pt(SPACE.row).child(this.switch_("f-enabled",!f.disabled,t,cx=>{f.disabled=!f.disabled;cx.notify();})))
      .when(Boolean(f.result?.problem),e=>e.child(div().text_size(TYPE.control).text_color(t.ansi1).whitespace_normal().child(f.result.problem)))
      .child(h_flex().pt(SPACE.row).gap(SPACE.icon).justify_end().child(this.button("f-cancel","Cancel",cx=>{this.form=null;this.view={kind:"list"};cx.notify();})).child(this.button("f-save",this.saving?"Saving…":"Save",cx=>this.save(cx),{solid:true,disabled:this.saving||!f.name.value().trim()||!f.prompt.value().trim()||Boolean(f.selection.value().error)||(!f.manual&&!f.cron.value().trim()),reason:this.saving?"Saving automation…":!f.name.value().trim()?"Enter a name.":!f.prompt.value().trim()?"Enter a prompt.":f.selection.value().error||(!f.manual&&!f.cron.value().trim()?"Enter a schedule.":"")})));
  }
}
