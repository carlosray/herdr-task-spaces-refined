// Adapted from Herdr's shipped agents mod, with grouping by main space and by
// name prefix. Agents in grouped or priority views; parents take their most urgent sub-agent's place.
// A viewed done agent stays in Done until left.

import { div, image, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import {
  agents,
  terminals,
  panes,
  focused,
  spaces,
  run,
  theme,
  shared,
  setShared,
  setAgentOrder,
  window,
  layout,
  openOverlay,
} from "herdr";
import { findNode } from "./find-node.js";
import { TEXT, ROW_END, Icon, IconButton, GroupHeader, Menu, MenuLabel, MenuOption, SidebarScroll, directoryTint, attentionRows, openSessionRead } from "./ui.js";

import { SESSION_COMPACT_HEIGHT, sessionCaption, sessionContext } from "./session-hub/row.js";
import { directoryForSpace } from "./tree-model.js";

// The sidebar's rail goes by its width, not a flag: dragging its edge narrows it too.
const narrow = () => (findNode(layout(), "sidebar")?.size?.px ?? Infinity) < 160;

// To the rail (on macOS wide enough for the traffic lights), or back to the width it had.
function toggleSidebar() {
  const width = findNode(layout(), "sidebar")?.size?.px;
  if (!narrow()) setShared("sidebar.width", width);
  // Mods edited before the rail went by width still read the flag.
  setShared("sidebar.collapsed", !narrow());
  run("layout.resize", {
    id: "sidebar",
    px: narrow() ? (shared("sidebar.width") ?? 268) : window()?.platform === "macos" ? 76 : 44,
  });
}

export const knownAgentProgram = p => Boolean(p?.agent || ['codex','claude','nclaude','pi','opencode'].includes(p?.key) || /^(?:codex(?: cli)?|claude(?: code)?|nclaude|pi|open\s?code)$/i.test(p?.name??''));
const clean = (s) => (s ?? "").replace(/^[^\p{L}\p{N}]+/u, "").trim();

function lead(tab, all = panes()) {
  const mine = all.filter((p) => p.tab === tab.id && p.terminal);
  return mine.find((p) => p.program?.agent) ?? mine.find((p) => p.focused) ?? mine[0];
}

function title(tab, l, terminal) {
  if (tab.named && tab.name?.trim()) return tab.name;
  const intended = terminal?.labels?.["session.title"]?.trim();
  if (intended) return intended;
  const prog = l?.program?.name;
  const live = clean(l?.title);
  const telling =
    live &&
    live !== prog &&
    !/^[~/]|^[A-Za-z]:\\/.test(live) &&
    !live.includes("@") &&
    live.toLowerCase() !== l?.program?.key;
  return tab.name === prog && telling ? live : tab.name;
}
// A native UUID is authoritative when route aliases differ between hosts.
export function managerAddress(terminal, all, canonical, nativeManagers) {
  const labels=terminal?.labels??{},native=labels['orchestration.parent-session'];
  if(native) {
    if(nativeManagers)return nativeManagers.get(native)??null;
    const matches=all.filter(t=>canonical.has(t.address)&&(!t.state||t.state==='live')&&t.labels?.['native.session']===native);
    return matches.length===1?matches[0].address:null;
  }
  const resolve=value=>{
    if(!value)return null;
    const machine=terminal?.address?.includes('/')?terminal.address.split('/')[0]:null;
    const addr=machine&&!value.includes('/')?machine+'/'+value:value;
    return canonical.has(addr)?addr:null;
  };
  return resolve(labels['orchestration.parent']||labels['orchestration.parent-terminal'])||resolve(terminal?.parent);
}
const RANK = { blocked: 4, done: 3, working: 2, idle: 1 };
// A sub-agent without a pane isn't in agents(): its raw word, error counting as
// blocked. It's never done: it reports to its parent, and the parent's done is the news.
const kidStatus = (k, listed) => {
  const s = listed.get(k.address) ?? k.status;
  return s === "error" ? "blocked" : s === "done" ? "idle" : s;
};
const SORTS = [
  { id: "priority", label: "Priority", icon: "clock" },
  { id: "grouped", label: "Grouped by space", icon: "layers" },
  { id: "parent", label: "Grouped by main space", icon: "git-branch" },
  { id: "prefix", label: "Grouped by prefix", icon: "tag" },
];
const sortOf = () => SORTS.find((s) => s.id === shared("agents.sort")) ?? SORTS[0];
const SECTION = { 0: "Status unavailable", 4: "Needs input", 3: "Done", 2: "Working", 1: "Idle" };
const SECTION_STATUS = { 4: "blocked", 3: "done", 2: "working" };

// PR-12, INS-4 and PLAT-work, also after a folder such as feature/INS-4: capitals
// need nothing more, while lower case needs a number so herdr-mods is no prefix.
const PREFIX = /(?:^|\/)(?:([A-Z][A-Z0-9]*)-\S|([A-Za-z][A-Za-z0-9]*)-\d)/;
export function namePrefix(...names) {
  for (const name of names) {
    const match = PREFIX.exec(name ?? "");
    if (match) return (match[1] ?? match[2]).toUpperCase();
  }
  return null;
}

// How `sort` gathers agents: a group's key and heading. Null keeps priority's sections.
function grouping(sort, tabName) {
  if (sort === "grouped") return (a) => ({ id: `sp-${a.space}`, label: a.space_name || "" });
  if (sort === "parent") {
    const parents = shared("better-sidebar.space-parents") ?? {};
    return (a) => {
      const parent = parents[a.space];
      return parent
        ? { id: `repo-${parent.key}`, label: parent.label }
        : { id: `sp-${a.space}`, label: a.space_name || "" };
    };
  }
  if (sort === "prefix")
    return (a) => {
      const prefix = namePrefix(a.space_name, tabName(a));
      return prefix
        ? { id: `prefix-${prefix}`, label: `${prefix}-` }
        : { id: "prefix-none", label: "No prefix" };
    };
  return null;
}

function duration(ms) {
  const m = Math.floor(ms / 60000);
  if (m < 1) return "<1m";
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}h` : `${Math.floor(h / 24)}d`;
}

// The agent's icon from the app's program table: a one-color glyph or a picture.
function icon(p, size, color) {
  if (!p?.icon) return null;
  // The original Codex logo has an opaque tile. Its silhouette would be a
  // square in the monochrome SVG renderer.
  if (p.tint && p.icon === "icons/codex.svg") return Icon("openai", size).text_color(color);
  return p.tint
    ? svg(p.icon).size(size).flex_none().text_color(color)
    : image(p.icon).w(size).h(size).flex_none();
}

// What a row calls an agent: its tab's title, or failing that its own.
function agentLabel(spaceList, paneList, terminalByAddress) {
  const tabs=new Map(),panesByTab=new Map();
  for(const space of spaceList)for(const tab of space.tabs??[])tabs.set(tab.id,tab);
  for(const pane of paneList){
    if(!pane.terminal)continue;
    const current=panesByTab.get(pane.tab);
    if(!current||(!current.program?.agent&&(pane.program?.agent||(!current.focused&&pane.focused))))panesByTab.set(pane.tab,pane);
  }
  return (a) => {
    const tab = tabs.get(a.tab);
    return tab ? (tab.named || terminalByAddress.get(a.address)?.labels?.["session.title"]?.trim()
      ? title(tab, panesByTab.get(a.tab), terminalByAddress.get(a.address))
      : a.tab_name || title(tab, panesByTab.get(a.tab)))
      : terminalByAddress.get(a.address)?.labels?.["session.title"]?.trim() || a.title || a.program?.name || "";
  };
}

// Same group next to each other, so the list reads, and next-agent keys move, in order.
function gatherGroups(list, groupOf, sortId) {
  const gathered = new Map();
  for (const a of list) {
    const { id } = groupOf(a);
    gathered.set(id, [...(gathered.get(id) ?? []), a]);
  }
  const ids = [...gathered.keys()];
  if (sortId === "prefix")
    ids.sort((x, y) => (x === "prefix-none") - (y === "prefix-none") || x.localeCompare(y));
  return ids.flatMap((id) => gathered.get(id));
}

export class Agents {
  init(_props, cx) {
    this.sortOpen = false;
    this.sortFocus = cx.focus_handle();
    this.folded = new Set();
    // Each agent's last state and when it changed (ms), kept across restarts.
    this.changed = JSON.parse(localStorage.getItem("changed") ?? "{}");
    cx.timer.every(30000, (cx) => cx.notify());
  }

  // Stamps agents whose state changed. Done and idle count as one: looking at a
  // finished agent turns done into idle, and looking isn't the agent doing anything.
  track(list, now) {
    let dirty = false;
    for (const a of list) {
      const s = a.status === "done" ? "idle" : a.status;
      if (this.changed[a.address]?.s === s) continue;
      this.changed[a.address] = { s, at: now };
      dirty = true;
    }
    if (!dirty) return;
    // Gone and old: the list alone is empty right after a start.
    const listed = new Set(list.map((a) => a.address));
    for (const [k, c] of Object.entries(this.changed))
      if (!listed.has(k) && now - c.at > 30 * 86400000) delete this.changed[k];
    localStorage.setItem("changed", JSON.stringify(this.changed));
  }

  since(a) {
    return this.changed[a.address]?.at ?? 0;
  }

  // Looking at a done agent makes it idle; it stays with Done until you leave
  // it rather than drop away under you. Any other change moves it at once.
  hold(list) {
    const cur = list.find((a) => a.focused);
    const same = cur && cur.address === this.held?.address;
    // Arriving, or any change but done turning idle, sets what it was.
    if (!same || cur.status !== "idle")
      this.held = cur ? { address: cur.address, rank: RANK[cur.status] ?? 0 } : null;
  }

  rank(a) {
    const sawDone =
      a.address === this.held?.address && this.held.rank === RANK.done && a.status === "idle";
    return sawDone ? RANK.done : (RANK[a.status] ?? 0);
  }

  // Sort menu for the lists view's tab bar.
  sortMenu() {
    return this.renderSortMenu(sortOf());
  }

  sortOptions() {
    const on = sortOf().id;
    return SORTS.map((s) =>
      MenuOption({
        id: `sort-${s.id}`,
        icon: s.icon,
        label: s.label,
        selected: s.id === on,
        onClick: (cx) => {
          setShared("agents.sort", s.id);
          this.sortOpen = false;
          cx.notify();
        },
      }),
    );
  }

  renderSortMenu(sort) {
    return Menu({
      id: "ag-sort-menu",
      open: this.sortOpen,
      focus: this.sortFocus,
      onOpenChange: (open, cx) => {
        this.sortOpen = open;
        cx.notify();
      },
      trigger: IconButton({
        id: "ag-sort",
        icon: sort.icon,
        label: `Sort agents: ${sort.label}`,
        iconSize: 14,
        muted: true,
      }),
      children: [MenuLabel("Sort agents"), ...this.sortOptions()],
    });
  }

  peek(addr) {
    run("terminal.peek", { terminal: addr });
  }

  // Live sub-agents of `addr`, depth first, each with the tree lines in front of it.
  tree(childrenByParent, addr, lead = [], canonical = new Set(), onlyAgents = false) {
    // A pane-owned descendant starts its own canonical subtree. Shell launchers
    // without a pane are transparent, so real headless agents remain reachable.
    const children = parent => (childrenByParent.get(parent)??[]).filter(k=>!canonical.has(k.address))
      .flatMap(k=>onlyAgents && !knownAgentProgram(k.program) &&
        !["claude","nclaude","codex","pi","opencode"].includes(k.labels?.["agent.tool"]) ? children(k.address) : [k]);
    const kids = children(addr);
    return kids.flatMap((k, i) => {
      const last = i === kids.length - 1;
      return [
        { t: k, lines: [...lead, last ? "└" : "├"] },
        ...this.tree(childrenByParent, k.address, [...lead, last ? "" : "│"], canonical, onlyAgents),
      ];
    });
  }

  subRow(t, s, shown, compact) {
    const k = s.t;
    const st = kidStatus(k, this.listed);
    const pic = icon(k.program, 14, t.foreground);
    const on = k.address === shown;
    return h_flex()
      .id(`sub-${k.address}`)
      .pl(39)
      .pr(8)
      .rounded(8)
      .h(26)
      .flex_none()
      .gap(0)
      .items_center()
      .text_size(12.5)
      .when(on, (el) => el.bg(t.raised))
      .hover((s) => s.bg(t.hover))
      .on_click(() => this.peek(k.address))
      .children(
        s.lines.map((l) =>
          div()
            .self_start()
            .mt(-4)
            .w(9)
            .h(17)
            .mr(4)
            .flex_none()
            .when(Boolean(l), (el) => el.border_l(1.5).border_color(t.input))
            .when(l === "└" || l === "├", (el) => el.border_b(1.5).rounded_bl(6)),
        ),
      )
      .when(Boolean(pic), (el) => el.child(div().mr(8).child(pic)))
      .child(
        div()
          .flex_1()
          .truncate()
          .text_color(on ? t.foreground : t.muted)
          .child(k.labels?.["session.title"]?.trim() || k.name || k.template || k.program?.name || k.address),
      )
      .child(this.status(t, { status: st }, compact));
  }

  // compact: a ! for blocked where a header already says "Needs input".
  status(t, a, compact = false) {
    if (this.refinedChrome) {
      const label = { working: "Working", blocked: "Needs input", done: "Unread" }[a.status];
      if (!label) return div().size(0);
      const mark = a.status === "working"
        ? Icon("spinner", 12).text_color(t.working).spin(900)
        : div().size(a.status === "blocked" ? 8 : 6).rounded(4).bg(t[a.status]);
      return div().id(`status-${a.address ?? a.status}`).size(16).flex_none().flex()
        .items_center().justify_center().accessibility_label(label).tooltip(label).child(mark);
    }
    const color = t[a.status] ?? t.dim;
    if (a.status === "working")
      return Icon("spinner").size(12).mx(1).flex_none().text_color(t.working).spin(900);
    if (a.status === "blocked" && compact)
      return div()
        .size(14)
        .flex_none()
        .rounded(4)
        .bg(t.blocked + "26")
        .text_size(TEXT.avatar)
        .font_bold()
        .text_color(t.blocked)
        .flex()
        .items_center()
        .justify_center()
        .child("!");
    if (a.status === "blocked")
      return div()
        .flex_none()
        .px(6)
        .h(18)
        .rounded(5)
        .bg(t.blocked + "26")
        .text_size(TEXT.avatar)
        .font_semibold()
        .text_color(t.blocked)
        .flex()
        .items_center()
        .child("Needs input");
    // Idle: a ring; done: a dot.
    if (a.status === "idle")
      return div()
        .size(7)
        .mx(3)
        .flex_none()
        .rounded(4)
        .border(1.5)
        .border_color(t.idle ?? t.dim);
    return div()
      .size(7)
      .mx(3)
      .flex_none()
      .rounded(4)
      .bg(a.status === "done" ? color : t.dim + "00");
  }

  // opts, from the lists view: `view` already read, `heading: false` under its tabs.
  render(opts = {}) {
    const t = theme();
    const view = opts.view ?? this.readView();
    let rows;
    if(opts.flat&&opts.hostHeader) {
      const machine=a=>a.address.includes('/')?a.address.split('/')[0]:null;
      const byHost=new Map([null,...(opts.hosts??[])].map(host=>[host,[]]));
      for(const agent of view.list){
        const host=machine(agent);
        if(!byHost.has(host))byHost.set(host,[]);
        byHost.get(host).push(agent);
      }
      const hosts=[...byHost.keys()].sort((a,b)=>a===null?-1:b===null?1:a.localeCompare(b));
      setAgentOrder(hosts.flatMap(m=>byHost.get(m).map(a=>a.address)));
      rows=hosts.map(m=>v_flex().id('agent-host-'+(m||'local')).min_w(0).p(4).mb(10).rounded(9)
        .bg(t.foreground+'04')
        .child(opts.hostHeader(m)).children(opts.hostFolded(m)?[]:byHost.get(m).map(a=>this.agentRow(a,[],view,t))));
    } else {
      setAgentOrder(view.list.map(a=>a.address));
      rows=opts.flat ? view.list.map((a,i)=>view.collapsed?this.railRow(a,i,t):this.agentRow(a,[],view,t))
        : view.collapsed ? view.list.flatMap((a,i)=>this.agentWithSubs(a,i,view,t))
        : view.groups.flatMap((group,index)=>this.groupRows(group,index,view,t));
    }

    return v_flex()
      .size_full()
      .min_h(0)
      .bg(t.chrome)
      // Under the lists view's tabs, the tab bar's space divides it instead.
      .when(opts.heading !== false, (el) => el.border_t(1).border_color(t.border))
      .text_size(TEXT.body)
      .when(!view.collapsed && opts.heading !== false, (el) => el.child(this.heading(view.sort, t)))
      .when(view.list.length === 0 && !view.collapsed, (el) => el.child(this.emptyMessage(t)))
      .child(SidebarScroll("ag-list",v_flex().px(view.collapsed ? 0 : 8).children(rows)))
      .when(view.collapsed, (el) => el.child(this.expandRow(t)));
  }

  // ── What to show ──────────────────────────────────────────────────────────

  // Everything one render needs: the agents in order, in their groups.
  readView(flat = false, nested = false) {
    const sort = flat ? SORTS[0] : sortOf();
    const all = terminals(), now = Date.now(), focus = focused();
    const terminalByAddress = new Map(all.map(t=>[t.address,t]));
    const childrenByParent = new Map();
    for(const terminal of all){
      if(!terminal.parent||terminal.state!=="live")continue;
      if(!childrenByParent.has(terminal.parent))childrenByParent.set(terminal.parent,[]);
      childrenByParent.get(terminal.parent).push(terminal);
    }
    const spaceList=spaces(),paneList=panes(),states=shared('task-spaces.hosts')??{};
    const spaceByID=new Map(spaceList.map(s=>[s.id,s])), spaceByTab=new Map();
    for(const space of spaceList)for(const tab of space.tabs??[])spaceByTab.set(tab.id,space);
    const paneByTab=new Map();
    for(const pane of paneList)if(pane.cwd&&!paneByTab.has(pane.tab))paneByTab.set(pane.tab,pane);
    const reported=agents();
    const native=attentionRows(reported,focus?.terminal||reported.find(a=>a.focused)?.address,all);
    const unordered=[...native], known=new Set(native.map(a=>a.address));
    for(const [i,p] of paneList.entries()) {
      const t=terminalByAddress.get(p.terminal),tool=t?.labels?.['agent.tool'];
      if(!t||t.state!=='live'||known.has(p.terminal)||
        !(knownAgentProgram(p.program)||['codex','claude','nclaude','pi','opencode'].includes(tool)))continue;
      const sp=spaceByTab.get(p.tab);if(!sp)continue;
      known.add(p.terminal);
      const program=knownAgentProgram(p.program)?p.program:{key:tool,name:tool,agent:true,icon:`icons/${tool==='nclaude'?'claude':tool}.svg`,tint:true};
      unordered.push({address:p.terminal,pane:p.pane,space:sp.id,space_name:sp.name,tab:p.tab,
        tab_name:sp.tabs.find(tab=>tab.id===p.tab)?.name,program,status:'unknown',focused:Boolean(p.focused),seq:1000000+i});
    }
    this.listed = new Map(unordered.map((a) => [a.address, a.status]));
    this.track(unordered, now);
    this.hold(unordered);
    const byPriority = !nested && sort.id === "priority";
    const urgency = nested?null:this.urgencies(unordered, childrenByParent);
    const ordered = byPriority ? this.byUrgency(unordered, urgency) : unordered;
    const context=new Map(), paints=new Map(), assignmentBySpace=new Map(), mainOwners=new Map();
    const parents=nested?{}:shared('better-sidebar.space-parents')??{};
    const colors=nested?{}:shared('better-sidebar.directory-colors')??{};
    const t=nested?null:theme();
    for(const [host,state] of Object.entries(states)){
      for(const [id,task] of Object.entries(state.tasks??{}))if(task.main_space?.space)
        mainOwners.set(host==='local'?task.main_space.space:host+'/'+task.main_space.space,id);
      for(const row of Object.values(state.checkouts??{}))if(row.space!==row.task)
        assignmentBySpace.set(host==='local'?row.space:host+'/'+row.space,row);
    }
    const at=s=>{
      for(const tab of s?.tabs??[]){const pane=paneByTab.get(tab.id);if(pane)return pane.cwd;}
      return s?.folder||'';
    };
    if(!nested)for(const s of spaceList) {
      const machine=s.machine,id=machine&&s.id.startsWith(machine+'/')?s.id.slice(machine.length+1):s.id;
      const state=states[machine||'local'];
      const assignment=assignmentBySpace.get(s.id);
      const taskID=assignment?.task??mainOwners.get(s.id)??id,parentID=machine?machine+'/'+taskID:taskID;
      const taskSpace=spaceByID.get(parentID)??s,task=state?.tasks?.[taskID];
      const path=task?.main_space?.folder||task?.repo?.replace(/\/\.git\/?$/,'')||task?.folder||at(taskSpace);
      const name=taskSpace?.name||task?.name||s.name;
      const child=(assignment?.folder||(task?.main===false&&!mainOwners.has(s.id)?task.folder:null))?.replace(/\/+$/,'').split('/').pop();
      context.set(s.id,sessionContext(path,name,child));
      if(!nested){
        const folder=directoryForSpace(s,states,paneList,parents);
        const base=directoryTint(machine,folder,t,t.chrome,colors);
        if(base)paints.set(s.id,{base,hover:directoryTint(machine,folder,t,t.hover,colors),selected:directoryTint(machine,folder,t,t.selected,colors)});
      }
    }
    const canonical = new Set([...unordered.map(a=>a.address),...paneList.map(p=>p.terminal).filter(Boolean)]);
    const nativeManagers = new Map();
    for (const terminal of all) {
      const native = terminal.labels?.["native.session"];
      if (native && canonical.has(terminal.address) && (!terminal.state || terminal.state === "live"))
        nativeManagers.set(native, nativeManagers.has(native) ? null : terminal.address);
    }
    const label = agentLabel(spaceList,paneList,terminalByAddress);
    const groupOf = nested?null:grouping(sort.id, label);
    const list = groupOf ? gatherGroups(ordered, groupOf, sort.id) : ordered;
    return {
      sort,
      count: unordered.length,
      all,
      now,
      byPriority,
      collapsed: narrow(),
      shown: focus?.agent,
      list,
      label,
      context, paints, native, childrenByParent,
      paneList, spaceList, terminalByAddress, canonical, nativeManagers, icons:shared('agent-settings.icons')??{},
      agentByAddress:new Map(unordered.map(agent=>[agent.address,agent])), hosts:states, focus,
      groups: nested?[]:this.makeGroups(list, groupOf, byPriority, urgency),
    };
  }

  // An agent's urgency is its own or its most urgent sub-agent's.
  urgencies(list, childrenByParent) {
    const kids = (a) =>
      this.tree(childrenByParent, a.address).map((s) => RANK[kidStatus(s.t, this.listed)] ?? 0);
    return new Map(list.map((a) => [a.address, Math.max(this.rank(a), ...kids(a))]));
  }

  byUrgency(list, urgency) {
    const rankOf = (a) => urgency.get(a.address);
    return [...list].sort(
      (x, y) => rankOf(y) - rankOf(x) || this.since(y) - this.since(x) || y.seq - x.seq,
    );
  }

  // Groups in list order: spaces (grouped) or priority sections. Agents of a
  // space are next to each other in agents(), so neighbours make a group.
  makeGroups(rest, groupOf, byPriority, urgency) {
    const groups = [];
    for (const a of rest) {
      const rank = urgency.get(a.address) ?? 0;
      const group = groupOf ? groupOf(a) : { id: `sec-${rank}`, label: SECTION[rank] };
      if (groups.at(-1)?.id === group.id) groups.at(-1).members.push(a);
      else
        groups.push({ ...group, status: byPriority ? SECTION_STATUS[rank] : null, members: [a] });
    }
    return groups;
  }

  toggleFold(id, cx) {
    if (!this.folded.delete(id)) this.folded.add(id);
    cx.notify();
  }

  // ── Drawing ───────────────────────────────────────────────────────────────

  heading(sort, t) {
    return h_flex()
      .px(16)
      .h(41)
      .pt(14)
      .pb(5)
      .flex_none()
      .items_center()
      .justify_between()
      .child(div().text_size(TEXT.label).font_medium().text_color(t.dim).child("Agents"))
      .child(this.renderSortMenu(sort));
  }

  emptyMessage(t) {
    return div()
      .px(12)
      .text_size(TEXT.small)
      .text_color(t.dim)
      .child(
        "No agent status yet. Agents show up here when they report their status. Older versions and agents inside tmux may not.",
      );
  }

  // Under the compact rail, the way back to the full sidebar.
  expandRow(t) {
    if (this.refinedChrome) return h_flex().h(28).flex_none().justify_center().items_center()
      .child(IconButton({ id: "expand-sidebar", icon: "panel-left", label: "Expand sidebar", t,
        onClick: toggleSidebar }).size(24).text_color(t.muted));
    return h_flex()
      .h(28)
      .items_center()
      .justify_center()
      .child(
        div()
          .id("collapse")
          .text_size(TEXT.body)
          .text_color(t.dim)
          .hover((s) => s.text_color(t.foreground))
          .on_click(toggleSidebar)
          .child("»"),
      );
  }

  groupRows(group, index, view, t) {
    const members = this.folded.has(group.id)
      ? []
      : group.members.flatMap((a, i) => this.agentWithSubs(a, i, view, t));
    return [this.groupHeader(group, index, view, t), ...members];
  }

  // Folded, a group's header also says its most urgent state.
  groupHeader(group, index, view, t) {
    const folded = this.folded.has(group.id);
    const top = group.members.reduce(
      (most, a) => ((RANK[a.status] ?? 0) > (RANK[most] ?? 0) ? a.status : most),
      null,
    );
    const showTop = folded && !view.byPriority && top && top !== "idle";
    return GroupHeader({
      id: group.id,
      label: group.label,
      count: group.members.length,
      labelColor: t[group.status],
      folded,
      divided: index > 0,
      action: showTop ? this.status(t, { status: top }, true) : null,
      onClick: (cx) => this.toggleFold(group.id, cx),
    });
  }

  agentWithSubs(a, i, view, t) {
    if (view.collapsed) return [this.railRow(a, i, t)];
    const subs = this.tree(view.childrenByParent, a.address, [], view.canonical, true);
    const row = this.agentRow(a, subs, view, t);
    if (this.folded.has(a.address)) return [row];
    return [row, ...subs.map((s) => this.subRow(t, s, view.shown, view.byPriority))];
  }

  railRow(a, i, t) {
    return h_flex()
      .id(`ag-${a.address}`)
      .h(26)
      .px(8)
      .flex_none()
      .items_center()
      .gap(4)
      .hover((s) => s.bg(t.hover))
      .on_click(() => {openSessionRead(a.address);run("pane.focus", { pane: a.pane });})
      .child(
        div()
          .flex_1()
          .min_w(0)
          .whitespace_nowrap()
          .text_right()
          .text_color(t.muted)
          .child(String(i + 1)),
      )
      .child(
        h_flex()
          .w(14)
          .flex_none()
          .items_center()
          .justify_center()
          .child(this.status(t, a, true)),
      );
  }

  agentRow(a, subs, view, t) {
    const lit = a.focused || view.activeAgent === a.address;
    const terminal=view.terminalByAddress.get(a.address);
    const tool = terminal?.labels?.["agent.tool"];
    const program = view.icons?.[tool ?? a.program?.key] ?? a.program;
    const pic = this.refinedChrome && (!program?.icon || program.shell || program.key === "shell")
      ? Icon("terminal", 16).text_color(t.muted) : icon(program, 16, t.foreground);
    const parent = managerAddress(terminal,view.all,view.canonical,view.nativeManagers);
    const parentAgent = view.agentByAddress?.get(parent);
    const parentName = parentAgent ? view.label(parentAgent) : view.terminalByAddress.get(parent)?.labels?.['session.title'] || parent;
    const managerBadge = parent ? IconButton({ id: `managed-by-${a.address}`, icon: "manager", iconSize: 12,
      label: `Managed by ${parentName}`, muted: true, t,
      onClick: () => run("pane.focus", { terminal: parent }),
    }).size(this.refinedChrome ? 18 : 20)
      .when(this.refinedChrome, button => button.text_color(t.muted))
      .hover(button => button.bg(t.hover).text_color(t.accent)) : null;
    const paint=view.paint??view.paints?.get(a.space);
    const showTime = !this.refinedChrome || (view.width >= 300 && !view.nested);
    const when = showTime ? this.since(a) : null;
    // An agent on another machine (`vps/t7`) says which.
    return h_flex()
      .id(`ag-${a.address}`)
      .px(ROW_END.padding)
      .h(this.refinedChrome ? 32 : view.nested ? 30 : SESSION_COMPACT_HEIGHT)
      .flex_none()
      .rounded(this.refinedChrome ? 6 : 8)
      .items_center()
      .gap(this.refinedChrome ? 6 : 9)
      .when(!view.nested&&Boolean(paint?.base),el=>el.bg(paint.base))
      .when(lit, el=>el.bg(paint?.selected||t.selected))
      .cursor_pointer()
      .when(!lit, row => row.hover(el=>el.bg(paint?.hover||t.hover)))
      .on_click(() => {if(!this.sessionDrag?.suppressClick()){openSessionRead(a.address);run("pane.focus", { pane: a.pane });}})
      .on_mouse_down("right",(_e,cx)=>{cx.stop_propagation();this.sessionMenu(a.address,a.space,terminal,this.refinedChrome ? parent : null,parentName);})
      .when(this.sessionDrag,el=>el
        .on_mouse_down("left",(e,cx)=>this.sessionDrag.begin(a.address,a.tab,a.space,e,cx))
        .on_mouse_up("left",(e,cx)=>this.sessionDrag.drop(a.space,e,cx)))
      .when(this.sessionDrag?.tracking,el=>el.on_mouse_move((e,cx)=>{
        cx.stop_propagation();this.sessionDrag.over(a.space,e,cx);
      }))
      .when(Boolean(pic), (el) => el.child(this.agentIcon(a, pic, subs)))
      .child(this.agentName(a, view, t, lit, this.refinedChrome ? managerBadge : null))
      .when(!this.refinedChrome && Boolean(managerBadge), el => el.child(managerBadge))
      .when(subs.length > 0, (el) => el.child(this.foldButton(a, subs, t)))
      .child(h_flex().flex_none().gap(ROW_END.gap).items_center()
        .when(showTime, el => el.child(h_flex().w(ROW_END.time).flex_none().justify_end()
          .text_size(TEXT.caption).text_color(this.refinedChrome ? t.muted : t.dim).child(when ? duration(view.now - when) : "")))
        .child(h_flex().min_w(ROW_END.status).flex_none().justify_center().items_center()
          .child(this.status(t, a, view.byPriority))));
  }

  sessionMenu(address, space, terminal, manager, managerName) {
    const nativeAgent=agents().find(a=>a.address===address);
    openOverlay({mod:'better-sidebar-refined',kind:'popup',width:230,height:(terminal?.labels?.['native.session']?110:78)+(nativeAgent?.status==='idle'?32:0)+(manager?32:0),
      props:{view:'session-menu',terminal:address,space,manager,managerName,native:terminal?.labels?.['native.session'],status:nativeAgent?.status,active:Boolean(nativeAgent?.focused||focused()?.terminal===address||(nativeAgent?.pane&&focused()?.pane===nativeAgent.pane)),generation:terminal?.created_ms}});
  }

  // A tab with no agent, under its space in the lists view: its program and its name.
  tabRow(w, tab, lit, t, view) {
    const l = lead(tab,view.paneList);
    const terminal = view.terminalByAddress.get(l?.terminal);
    const tool = terminal?.labels?.["agent.tool"];
    const program = knownAgentProgram(l?.program) ? l.program :
      tool && ["claude","nclaude","codex","pi","opencode"].includes(tool)
        ? {key:tool,agent:true,icon:`icons/${tool === "nclaude" ? "claude" : tool}.svg`,tint:true} : l?.program;
    // The tab's title, as Herdr's tab bar shows it.
    const name = title(tab,l,terminal);
    // A mod's pane runs no program, but the mod may publish an icon, as Better Tabs reads it.
    const modIcon = shared("mod-icons")?.[view.paneList.find((p) => p.tab === tab.id && p.mod)?.mod];
    const pic =
      icon(view.icons?.[tool??program?.key]??program, 16, t.dim) ?? (modIcon ? svg(modIcon).size(16).flex_none().text_color(t.dim) : null);
    return h_flex()
      .id(`tab-${tab.id}`)
      .when(this.sessionDrag,el=>el
        .on_mouse_down("left",(e,cx)=>this.sessionDrag.begin(l?.terminal,tab.id,w.id,e,cx))
        .on_mouse_up("left",(e,cx)=>this.sessionDrag.drop(w.id,e,cx)))
      .when(this.sessionDrag?.tracking,el=>el.on_mouse_move((e,cx)=>{
        cx.stop_propagation();this.sessionDrag.over(w.id,e,cx);
      }))
      .on_mouse_down("right",(_e,cx)=>{cx.stop_propagation();if(l?.terminal)this.sessionMenu(l.terminal,w.id,terminal);})
      .px(8)
      .h(30)
      .flex_none()
      .rounded(8)
      .items_center()
      .gap(9)
      .when(lit, (el) => el.bg(view.paint?.selected||t.selected))
      .cursor_pointer()
      .when(!lit, el => el.hover(s => s.bg(view.paint?.hover || t.hover)))
      .on_click(() => {
        if(this.sessionDrag?.suppressClick())return;
        openSessionRead(l?.terminal);run("space.select", { id: w.id });
        run("tab.select", { id: tab.id });
      })
      .child(pic ?? div().w(16).flex_none())
      .child(sessionCaption(name,null,t,lit?t.foreground:t.muted));
  }

  // With sub-agents, clicking the icon folds them.
  agentIcon(a, pic, subs) {
    return div()
      .id(`agent-fold-${a.address}`)
      .when(subs.length > 0, (el) =>
        el.on_click((_e, cx) => {
          cx.stop_propagation();
          this.toggleFold(a.address, cx);
        }),
      )
      .child(pic);
  }

  // The tab's title, then quietly its space; nested under its space's row, its program.
  agentName(a, view, t, lit = a.focused, titleAction = null) {
    const context=view.context?.get(a.space)??a.space_name;
    const foreground=a.status==="idle"&&!lit?t.muted:t.foreground;
    const subtitle = view.nested || (this.refinedChrome && view.width < 240) ? null : context;
    return sessionCaption(view.label(a), subtitle, t, foreground, !view.nested,
      this.refinedChrome && view.width < 300 ? 74 : 120, titleAction);
  }

  // The fold chevron; folded, the count too, colored by the most urgent one.
  foldButton(a, subs, t) {
    const statuses = subs.map((s) => kidStatus(s.t, this.listed));
    const top = statuses.reduce((m, s) => ((RANK[s] ?? 0) > (RANK[m] ?? 0) ? s : m), null);
    const open = !this.folded.has(a.address);
    return div()
      .id(`fold-${a.address}`)
      .h(18)
      .px(3)
      .gap(3)
      .flex()
      .items_center()
      .rounded(4)
      .text_size(TEXT.caption)
      .text_color(open ? t.dim : (t[top] ?? t.dim))
      .cursor_pointer()
      .hover((s) => s.bg(t.hover).text_color(t.foreground))
      .on_click((_e, cx) => {
        cx.stop_propagation();
        this.toggleFold(a.address, cx);
      })
      .child(Icon(`chevron-${open ? "down" : "right"}`, 11))
      .when(!open, (el) => el.child(String(subs.length)));
  }

}
