// Session inventory lives in Herdr shared state, never a background daemon.
import { View, div, svg, image } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, ScrollHandle, VirtualListScrollHandle, v_virtual_list, Scrollbar } from "gpui-base";
import { agents, spaces, panes, terminals, machines, focused, shared, setShared, props, checking,
  exec, hc, run, theme, closeOverlay, notify } from "herdr";
import { STATE_KEY, initialState, reconcile, recordVisit, recentRows, archiveRows, resumeArgs, sessionKey, conversationKey,
  archiveReason, restoreAvailability, usableTitle, archivedTabTitle, needsForegroundVerification, reconcileForeground } from "./model.js";

import { SESSION_COMPACT_HEIGHT, sessionCaption, sessionContext } from './row.js';

const AUTO_TITLES='session-hub.auto-titles';
const autoTitleToken=argv=>{
 if(!Array.isArray(argv))return null;
 if(argv.length>4&&/(?:^|\/)(?:zsh|bash)$/.test(argv[0])&&argv[1]==='-lic'&&argv[2]==='"$@"; exec "$0" -li'&&argv[3]===argv[0])argv=argv.slice(4);
 if(!/(?:^|\/)env$/.test(argv[0]??''))return null;
 const assignments=[];for(const value of argv.slice(1)){if(!/^[A-Za-z_][A-Za-z0-9_]*=/.test(value))break;assignments.push(value);}
 const matches=assignments.filter(value=>/^HERDR_AUTO_TITLE_TOKEN=[A-Za-z0-9_-]{8,128}$/.test(value));
 return matches.length===1?matches[0].slice('HERDR_AUTO_TITLE_TOKEN='.length):null;
};
const TOOLS = new Set(["codex", "claude", "nclaude", "pi", "opencode"]);
const state = () => ({ ...initialState(), ...(shared(STATE_KEY) ?? {}) });
const foregroundStamp = entry => JSON.stringify([
  entry.generation, entry.firstSeen, entry.pid, entry.tool, entry.reportedNativeId ?? entry.nativeId,
]);
const glyph = (status, t) => {
  const label = { working: "Working", blocked: "Needs input", done: "Unread" }[status];
  if (!label) return div().size(0);
  return div().size(16).flex().items_center().justify_center().flex_none()
    .accessibility_label(label).tooltip(label)
    .child(status === "working"
      ? svg('mods/session-recent-refined/spinner.svg').size(12).text_color(t.working).spin(900)
      : div().size(status === "blocked" ? 8 : 6).rounded(4).bg(t[status]));
};
const toolIcon=(entry,t,icons)=>{
 const key=entry.tool==='nclaude'?'claude':entry.tool;
 const override=icons[entry.tool??entry.program?.key];
 const program=override??entry.program??agents().find(a=>a.program?.key===key)?.program;
 const path=program?.icon??`icons/${TOOLS.has(key)?key:'shell'}.svg`;
 return program?.tint===false?image(path).size(16).flex_none():svg(path).size(16).flex_none().text_color(t.foreground);
};
const shortAge = (at) => { const d = Math.max(0, Date.now() - at); return d < 60000 ? "now" : d < 3600000 ? `${Math.floor(d/60000)}m` : d < 86400000 ? `${Math.floor(d/3600000)}h` : `${Math.floor(d/86400000)}d`; };

export function inventorySnapshot() {
  const allSpaces = spaces(), allAgents = agents(), allPanes = panes();
  const agentByAddress = new Map(allAgents.map(a=>[a.address,a]));
  const paneByAddress = new Map(allPanes.filter(p=>p.terminal).map(p=>[p.terminal,p]));
  const spaceByID = new Map(allSpaces.map(s=>[s.id,s]));
  const spaceByTab = new Map(allSpaces.flatMap(s=>(s.tabs??[]).map(t=>[t.id,s])));
  const taskHosts=shared('task-spaces.hosts')??{};
  const assigned=new Map(), mainOwners=new Map();
  for(const [host,state] of Object.entries(taskHosts)){
    const qualify=id=>host==='local'?id:`${host}/${id}`;
    for(const claim of Object.values(state.checkouts??{}))
      if(claim.space!==claim.task)assigned.set(qualify(claim.space),claim);
    for(const [id,task] of Object.entries(state.tasks??{}))
      if(task.main_space?.space)mainOwners.set(qualify(task.main_space.space),id);
  }
  const entries = [], finished = [];
  for (const terminal of terminals()) {
    const a = agentByAddress.get(terminal.address);
    const pane = paneByAddress.get(terminal.address);
    const machine = terminal.address.includes("/") ? terminal.address.split("/")[0] : null;
    const labels = terminal.labels ?? {};
    const launchTitle = usableTitle(labels["session.title"]);
    const identity = { address: terminal.address, firstSeen: terminal.created_ms,
      generation: labels["agent.launch"] ?? null, nativeId: labels["native.session"] ?? null };
    if (terminal.state !== "live") {
      finished.push({ ...identity, reason: terminal.reason, title: launchTitle });
      continue;
    }
    const qualify = id => id ? (machine ? `${machine}/${id}` : id) : null;
    const localSpace = labels["herdr.space"];
    const sid = a?.space ?? qualify(localSpace);
    const tab = pane?.tab ?? a?.tab ?? qualify(labels["herdr.tab"]);
    const sp = spaceByTab.get(tab) ?? spaceByID.get(sid);
    if (!sp && !a) continue;
    const reported = a?.program?.key ?? terminal.program?.key;
    const label = labels["agent.tool"];
    const argv = terminal.argv ?? [];
    const gateway = argv.some((value,i) => /(?:^|\/)herdr-agent(?:\.sh)?$/.test(value) && argv[i+1] === "nclaude");
    const tool = TOOLS.has(label) ? label : gateway && (reported === "claude" || a?.app === "claude-code") ? "nclaude" : TOOLS.has(reported) ? reported :
      (a?.app === "claude-code" ? "claude" : TOOLS.has(a?.app) ? a.app : null);
    const shell = terminal.program?.shell === true;
    const isAgent = Boolean(a || (!shell && terminal.program?.agent && tool));
    const nativeTab = sp?.tabs?.find(t => t.id === tab);
    // AgentInfo.tab_name also contains the position of an unnamed tab.
    const tabTitle = nativeTab?.named ? usableTitle(nativeTab.name) : null;
    const cwd=pane?.cwd??terminal.foreground?.cwd??terminal.cwd??sp?.folder;
    const spaceName=sp?.name??a?.space_name??'Space';
    const state=taskHosts[machine??'local'], claim=assigned.get(sp?.id??sid);
    const mainOwner=mainOwners.get(sp?.id??sid);
    const taskID=claim?.task??mainOwner??localSpace??sp?.id?.split('/').at(-1);
    const task=state?.tasks?.[taskID];
    const owner=taskID&&spaceByID.get(machine?`${machine}/${taskID}`:taskID);
    const checkout=claim?.folder||(task?.main===false&&!mainOwner?task.folder:null);
    const directory=(task?.repo||claim?.repo)?.replace(/\/\.git\/?$/,'')||task?.main_space?.folder||task?.folder||cwd;
    const context=sessionContext(directory,
      owner?.name||task?.name||spaceName,checkout?.replace(/\/+$/,'').split('/').at(-1));
    entries.push({ ...identity, space: sp?.id ?? sid, spaceName, context,
      tab, title: tabTitle || launchTitle || a?.title || terminal.title || terminal.name || tool || "Terminal",
      titleSource: tabTitle ? "tab" : launchTitle ? "label" : "fallback",
      cwd, directory,
      machine, tool: isAgent ? tool : null, nativeId: isAgent ? identity.nativeId : null,
      program: a?.program ?? terminal.program, isAgent, status: a?.status ?? (typeof terminal.status === "string" ? terminal.status : terminal.status?.status) ?? "idle",
      pid: terminal.pid });
  }
  return { entries, finished, ready: machines().filter(m => m.layout === "ready").map(m => m.name), focused: focused()?.terminal ?? allAgents.find(a => a.focused)?.address ?? null };
}

export class SessionHub extends View {
  init(given, cx) {
    this.view = given?.hubView ?? (props() ?? given ?? {}).view ?? "recent";
    this.filter = ""; this.at = 0; this.busy = new Set(); this.probed = {}; this.signature = null;
    this.handle = cx.focus_handle();
    this.openedFrom = focused()?.terminal ?? agents().find(a => a.focused)?.address ?? state().lastFocus;
    if (checking()) return;
    if (this.view !== "service") {
      this.scroll = this.view === "archive" ? ScrollHandle.new() : VirtualListScrollHandle.new();
      this.input = InputState.new({ placeholder: this.view === "archive" ? "Search archived sessions…" : "Search recent sessions…" });
      this.input.on("change", (_event, cx) => { this.filter = this.input.value(); this.at = 0; this.scroll.scroll_to_item(0); cx.notify(); });
      this.input.on("submit", (_event, cx) => this.activate(this.rows()[this.at], cx));
      this.input.focus();
    }
    this.capture(cx);
    if (this.view === "recent") {
      const rows = this.rows();
      this.at = rows.length > 1 && rows[0].address === this.openedFrom ? 1 : 0;
    }
    if (this.view === "service") {
      this.foregroundChecks = new Map();
      const survey = cx => { this.probeMissing(cx); this.probeDisputed(cx); this.updateAutoTitles(cx); };
      cx.timer.every(4000, cx => { this.capture(cx, true); survey(cx); });
      survey(cx);
    }
  }

  capture(cx, confirm = false) {
    const snap = inventorySnapshot();
    const signature = JSON.stringify(snap);
    if (!confirm && signature === this.signature) return;
    this.signature = signature;
    const old = state();
    let next = reconcile(old, snap, Date.now());
    next = recordVisit(next, snap.focused, Date.now());
    if (JSON.stringify(next) !== JSON.stringify(old)) setShared(STATE_KEY, next);
  }

  probeMissing(cx) {
    const current = state();
    for (const entry of Object.values(current.live)) {
      if (!entry.isAgent || entry.nativeId || entry.missingSince || this.busy.has(entry.address)) continue;
      if (Date.now() - (this.probed[entry.address] ?? 0) < 15000) continue;
      this.probed[entry.address] = Date.now(); this.busy.add(entry.address);
      cx.spawn(async cx => {
        try {
          const id = entry.address.split("/").pop();
          const result = await exec("herdr-session-probe", ["--probe", id], { on: entry.machine });
          const data = result.code === 0 ? JSON.parse(result.stdout) : null;
          const latest = state(); const live = latest.live[entry.address];
          if (data?.nativeId && live?.isAgent && live.firstSeen === entry.firstSeen) {
            const updated = { ...live, nativeId: data.nativeId, tool: data.tool || live.tool };
            setShared(STATE_KEY, { ...latest, live: { ...latest.live, [entry.address]: updated } });
            await hc(["label", entry.address, `native.session=${data.nativeId}`]);
          }
        } catch { /* Missing probes leave a visibly unavailable exact resume, never a guess. */ }
        finally { this.busy.delete(entry.address); cx.notify(); }
      });
    }
  }

  probeDisputed(cx) {
    const current = state();
    for (const address of this.foregroundChecks.keys()) {
      if (!current.live[address]) this.foregroundChecks.delete(address);
    }
    for (const entry of Object.values(current.live)) {
      const { address, machine } = entry;
      const reported = entry.reportedNativeId ?? entry.nativeId;
      if (!reported || entry.missingSince || this.busy.has(address) || !needsForegroundVerification(current,entry)) continue;
      const stamp = foregroundStamp(entry);
      const last = this.foregroundChecks.get(address);
      if (last?.stamp === stamp && Date.now() - last.at < 60000) continue;
      this.foregroundChecks.set(address,{ stamp, at: Date.now() });
      this.busy.add(address);
      cx.spawn(async cx => {
        try {
          const result = await exec("herdr-session-probe", ["--verify", address.split("/").pop()], { on: machine });
          const verified = result.code === 0 ? JSON.parse(result.stdout) : null;
          if (!verified?.nativeId) return;
          const observed = inventorySnapshot().entries.find(e => e.address === address);
          if (!observed || foregroundStamp(observed) !== stamp) return;
          const latest = state();
          const next = reconcileForeground(latest,observed,verified,Date.now());
          if (next !== latest) { setShared(STATE_KEY,next); cx.notify(); }
        } catch { /* Retry later if exact foreground evidence is unavailable. */ }
        finally { this.busy.delete(address); }
      });
    }
  }

  updateAutoTitles(cx) {
    const intents=shared(AUTO_TITLES)??{};this.titleBusy??=new Set();this.titleChecked??={};
    const forget=token=>{const next={...(shared(AUTO_TITLES)??{})};if(next[token]){delete next[token];setShared(AUTO_TITLES,next);}};
    const locate=token=>{
      const matches=terminals().filter(t=>t.state==='live'&&autoTitleToken(t.argv)===token);if(matches.length!==1)return null;const terminal=matches[0];
      const pane=panes().find(p=>p.terminal===terminal.address),agent=agents().find(a=>a.address===terminal.address);
      const space=spaces().find(sp=>sp.tabs?.some(tab=>tab.id===(pane?.tab??agent?.tab)));
      const tab=space?.tabs?.find(tab=>tab.id===(pane?.tab??agent?.tab));
      return {terminal,space,tab,entry:state().live[terminal.address]};
    };
    for(const [token,originalIntent] of Object.entries(intents)) {
      let intent=originalIntent;
      if(intent.manual||Date.now()-(intent.createdAt??0)>86400000){forget(token);continue;}
      const current=locate(token);if(!current)continue;
      const {terminal,space,tab,entry}=current;
      // The terminal can precede its pane/tab in the native model. Keep intent.
      if(!tab||!space)continue;
      if(intent.newSpace&&!intent.space) {
        const machine=space.machine??null,trim=p=>(p??'').replace(/\/+$/,'');
        if(machine!==(intent.machine??null)||trim(space.folder)!==trim(intent.folder)){forget(token);continue;}
        intent={...intent,space:space.id};
        setShared(AUTO_TITLES,{...(shared(AUTO_TITLES)??{}),[token]:intent});
      }
      if(space.id!==intent.space||tab.named){forget(token);continue;}
      const generation=terminal.labels?.['agent.launch'],nativeId=terminal.labels?.['native.session'];
      if(intent.address&&(intent.address!==terminal.address||intent.generation!==generation||(nativeId&&intent.nativeId!==nativeId))){forget(token);continue;}
      if(!nativeId||!generation||!entry?.isAgent||entry.tool!==intent.tool)continue;
      if(!intent.address){setShared(AUTO_TITLES,{...(shared(AUTO_TITLES)??{}),[token]:{...intent,address:terminal.address,generation,nativeId}});}
      if(this.titleBusy.has(token)||Date.now()-(this.titleChecked[token]??0)<8000)continue;
      this.titleChecked[token]=Date.now();this.titleBusy.add(token);
      cx.spawn(async cx=>{
        try {
          const result=await exec('herdr-session-probe',['--title',entry.tool,'--id',nativeId],{on:entry.machine});
          const data=result.code===0?JSON.parse(result.stdout):null;
          const latest=locate(token),pending=(shared(AUTO_TITLES)??{})[token];
          if(!pending||!latest)return;
          if(latest.tab?.named||latest.space?.id!==intent.space||latest.terminal.address!==terminal.address||latest.terminal.labels?.['agent.launch']!==generation||latest.terminal.labels?.['native.session']!==nativeId){forget(token);return;}
          if(typeof data?.title==='string'&&data.title.trim()&&data.title.length<=80&&!/[\x00-\x1f\x7f]/.test(data.title)){
            run('tab.rename',{id:latest.tab.id,name:data.title});
            // A tab can close before the next render sees its new name.
            const saved=state(),live=saved.live[terminal.address];
            if(live?.isAgent&&live.tool===entry.tool&&live.generation===generation&&live.nativeId===nativeId){
              setShared(STATE_KEY,{...saved,live:{...saved.live,[terminal.address]:{...live,title:data.title,titleSource:"tab"}}});
            }
            forget(token);
          }
        } catch { /* Missing native data leaves the tab unnamed; never choose a sibling. */ }
        finally {this.titleBusy.delete(token);cx.notify();}
      });
    }
  }

  rows() {
    const s = state();
    return this.view === "archive" ? archiveRows(s, this.filter) : recentRows(s, this.filter);
  }

  async verifyLiveConversation(entry) {
    const family = tool => ["claude","nclaude"].includes(tool) ? "claude" : tool;
    const candidates = Object.values(state().live).filter(e => e.isAgent && !e.missingSince && (e.machine ?? null) === (entry.machine ?? null));
    const checked = await Promise.all(candidates.map(async candidate => {
      try {
        const result = await exec("herdr-session-probe", ["--verify", candidate.address.split("/").pop()], { on: candidate.machine });
        return { candidate, verified: result.code === 0 ? JSON.parse(result.stdout) : null };
      } catch { return { candidate, verified: null }; }
    }));
    const match = checked.find(x => x.verified?.nativeId === entry.nativeId && family(x.verified?.tool) === family(entry.tool));
    if (match) return match.candidate;
    const uncertain = checked.filter(({candidate,verified}) => !verified?.nativeId &&
      (!verified?.tool || family(verified.tool) === family(entry.tool)) &&
      (candidate.cwd === entry.cwd || candidate.nativeId === entry.nativeId));
    if (uncertain.length) {
      const addresses = uncertain.map(x => x.candidate.address).join(", ");
      const error = Error(`Cannot verify the live conversation in ${addresses}. Focus the listed terminal, then close it or identify its session before restoring. No second writer was started.`);
      error.blockers = uncertain.map(x => x.candidate);
      throw error;
    }
    return null;
  }

  async restore(entry, cx) {
    if (this.busy.has(entry.id)) return;
    const restoreKey = sessionKey(entry);
    if (Date.now() - (state().restoring?.[restoreKey] ?? 0) < 60000) { this.error = "A restore is already starting; wait for the agent to appear"; cx.notify(); return; }
    this.busy.add(entry.id); this.error = null; this.restoreBlockers = []; cx.notify();
    let queued = false;
    try {
      const argv = resumeArgs(entry);
      const ready = machines().some(m => m.name === (entry.machine ?? null) && m.layout === "ready");
      if (!ready) throw Error(`${entry.machine ?? "Local host"} is not connected`);
      setShared(STATE_KEY, { ...state(), restoring: { ...(state().restoring ?? {}), [restoreKey]: Date.now() } });
      const same = await this.verifyLiveConversation(entry);
      if (same) {
        const current = state();
        setShared(STATE_KEY, { ...current, archive:current.archive.filter(row => conversationKey(row) !== conversationKey(entry)) });
        run("agent.focus", { terminal: same.address });
        this.dismiss();
        return;
      }
      // Verify original cwd before issuing a structure command that would otherwise fall back home.
      const directory = await exec("test", ["-d", entry.cwd], { on: entry.machine });
      if (directory.code !== 0) throw Error("The original working directory is unavailable");
      const sp = spaces().find(s => s.id === entry.space && (s.machine ?? null) === (entry.machine ?? null));
      const title = archivedTabTitle(entry);
      if (sp) run("tab.new", { space: sp.id, folder: entry.cwd, ...(title ? { name: title } : {}), argv });
      else run("space.new", { machine: entry.machine ?? "", folder: entry.cwd, name: entry.spaceName, ...(title ? { tab: title } : {}), argv });
      queued = true;
      // Keep the archive entry until an exact matching live conversation appears.
      notify({ title: "Restoring agent session", body: `${entry.tool} · ${entry.spaceName}` });
      this.dismiss();
    } catch (e) { this.error = String(e.message ?? e); this.restoreBlockers = e.blockers ?? []; }
    finally {
      if (!queued) { const next = { ...(state().restoring ?? {}) }; delete next[restoreKey]; setShared(STATE_KEY, { ...state(), restoring: next }); }
      this.busy.delete(entry.id); cx.notify();
    }
  }

  activate(entry, cx) {
    if (!entry || this.view === "archive") return;
    run(entry.isAgent ? "agent.focus" : "pane.focus", { terminal: entry.address }); this.dismiss();
  }
  dismiss() { if (props()?.overlay) closeOverlay(props().overlay); }

  button(id, label, action) {
    const t = theme();
    return div().id(id).px(8).py(4).rounded(5).bg(t.raised).cursor_pointer()
      .hover(s => s.bg(t.hover)).on_click((_e,cx) => { cx.stop_propagation(); action(cx); }).child(label);
  }
  restoreGlyph(id, label, hint, action) {
    const t = theme();
    const activate = (_event, cx) => { cx.stop_propagation(); action(cx); };
    return div().id(id).size(20).h(20).flex_none().flex().items_center().justify_center().rounded(4)
      .text_size(12).text_color(action ? t.muted : t.dim).tooltip(hint).accessibility_label(hint)
      .when(Boolean(action), el => el.tab_index(0).cursor_pointer()
        .hover(s => s.bg(t.hover).text_color(t.foreground))
        .focus(s => s.bg(t.selected).text_color(t.foreground))
        .on_mouse_down("left", (_event, cx) => cx.stop_propagation())
        .on_mouse_up("left", (_event, cx) => cx.stop_propagation())
        .on_click(activate).on_key_down((event, cx) => {
          if ((event.key === "enter" || event.key === "space") && !event.is_held) activate(event,cx);
        }))
      .child(label);
  }
  row(entry, index, online = new Set(machines().filter(m=>m.layout==="ready").map(m=>m.name)), visits = state().visits, icons=shared('agent-settings.icons')??{}, restoring={}) {
    const t = theme(), archive = this.view === "archive";
    const ready = online.has(entry.machine ?? null);
    const pending = archive && restoring[sessionKey(entry)];
    const availability = restoreAvailability(entry, ready);
    const busy = this.busy.has(entry.id) || (pending && Date.now() - pending < 60000);
    const restoreClick = archive && availability.available && !busy ? cx => cx.spawn(cx => this.restore(entry,cx)) : null;
    const reason = archive ? archiveReason(entry.reason) : null;
    const hint = [entry.title, [entry.spaceName,entry.machine ?? "local",entry.tool || "terminal"].join(" · "),
      entry.cwd, archive && reason, archive && (busy ? "Restoring session…" : `${availability.label}. ${availability.hint}`),
      archive && `Native session: ${entry.nativeId || "not captured"}`].filter(Boolean).join("\n");
    const selected = index === this.at;
    const current = entry.address === this.openedFrom;
    const foreground = !archive && !selected && !current && entry.status === 'idle' ? t.muted : t.foreground;
    return h_flex().id(`hub-${archive ? entry.id : entry.address}`).h(SESSION_COMPACT_HEIGHT).px(8).gap(6).rounded(6).items_center().flex_none().text_size(13)
      .when(selected, el => el.bg(t.selected))
      .when(!selected, el => el.hover(s => s.bg(t.hover)))
      .aria_selected(selected).tooltip(hint)
      .when(!archive, el => el.cursor_pointer())
      .when(archive, el => el.on_click((_event,cx) => { this.at = index; cx.notify(); }))
      .child(toolIcon(entry,t,icons))
      .child(sessionCaption(entry.title, entry.context??sessionContext(entry.cwd,entry.spaceName),t,foreground,true,archive?120:240))
      .when(archive && Boolean(entry.machine),el=>el.child(div().text_size(10).text_color(t.muted).child(entry.machine==='ivm'?'IVM':entry.machine)))
      .when(!archive,el=>el.child(h_flex().gap(5).items_center().flex_none()
        .child(div().w(38).text_right().text_size(10).text_color(t.muted).child(current?'Current':''))
        .child(div().w(26).truncate().text_right().text_size(10).text_color(t.muted)
          .child(entry.machine==='ivm'?'IVM':entry.machine??''))
        .child(div().w(26).text_right().text_size(11).text_color(t.muted)
          .child(shortAge(visits[entry.address]??entry.firstSeen??Date.now())))
        .child(h_flex().w(20).items_center().justify_center().child(glyph(entry.status,t)))))
      .when(archive, el => el
        .child(this.restoreGlyph(`hub-restore-${entry.id}`, busy ? "…" : availability.available ? "↩" : "⊘",
          busy ? "Restoring session…" : `${availability.label}. ${availability.hint}`, restoreClick)));
  }

  render(cx) {
    if (checking()) return div();
    if (this.view === "service") { this.capture(cx); return div().size(1); }
    const t = theme(), rows = this.rows();
    const online=new Set(machines().filter(m=>m.layout==="ready").map(m=>m.name)), { visits, restoring }=state();
    const icons=shared('agent-settings.icons')??{};
    const rowKey=entry=>entry.id??entry.address;
    const byKey=new Map(rows.map(entry=>[rowKey(entry),entry]));
    this.at = Math.max(0, Math.min(this.at, rows.length - 1));
    return v_flex().id("session-hub").size_full().min_h(0).bg(t.background).text_color(t.foreground)
      .track_focus(this.handle).on_key_down((e,cx) => {
        if (e.key === "down" || e.key === "up") { cx.stop_propagation(); this.at = Math.max(0, Math.min(rows.length - 1, this.at + (e.key === "down" ? 1 : -1))); this.scroll.scroll_to_item(this.at); cx.notify(); }
        else if (e.key === "enter" && this.view !== "archive") { cx.stop_propagation(); this.activate(rows[this.at],cx); }
      })
      .child(div().px(12).py(10).font_semibold().child(this.view === "archive" ? "Archive" : "Recent sessions"))
      .child(h_flex().px(8).mb(8).child(Input.new(this.input).flex_1().min_w(0).h(32)
        .px(8).rounded(6).border_1().border_color(t.input).bg(t.background).text_size(13)
        .focus(el => el.border_color(t.accent))))
      .when(Boolean(this.error),el => el.child(div().px(12).py(6).text_color(t.ansi1).child(this.error)))
      .when(Boolean(this.restoreBlockers?.length), el => el.child(v_flex().px(10).pb(8).gap(4).children(this.restoreBlockers.map(blocker =>
        this.button(`hub-focus-blocker-${blocker.address}`, `Focus ${blocker.address} · ${blocker.title || blocker.tool || "Agent"}`, () => { run("agent.focus", { terminal: blocker.address }); this.dismiss(); })
          .accessibility_label(`Focus blocking terminal ${blocker.address}`).tooltip("Inspect this live conversation before restoring another session")))))
      .child(v_flex().id("hub-rows").relative().flex_1().min_h(0).px(4)
        .when(rows.length>0,el=>el
          .child(this.view === "archive"
            ? v_flex().id("session-hub-rows").flex_1().min_h(0).overflow_y_scroll().track_scroll(this.scroll)
              .children(rows.map((entry,i) => this.row(entry,i,online,visits,icons,restoring)))
            : v_virtual_list("session-hub-rows",rows.length,SESSION_COMPACT_HEIGHT,index=>rowKey(rows[index]),
              range=>rows.slice(range.start,range.end).map((entry,i)=>this.row(entry,range.start+i,online,visits,icons)))
              .flex_1().min_h(0).track_scroll(this.scroll).on_item_click((key,cx)=>this.activate(byKey.get(key),cx)))
          .child(Scrollbar.vertical("session-hub-rows").absolute().inset_0()
            .when(this.view==="archive",el=>el.mode("scrolling"))))
        .when(!rows.length,el=>el.child(div().p(14).text_size(12).text_color(t.muted)
          .child(this.filter.trim() ? "No matching sessions. Clear the search." : this.view === "archive" ? "No archived agent sessions yet." : "No recent sessions yet."))))
      .when(this.view === "archive",el => el.child(div().px(10).py(8).text_size(10).text_color(t.muted).child("30 days · up to 100 sessions")));
  }
}
export default SessionHub;
