// The spaces list: nested worktrees, branch captions and request status.
// Repository facts follow each space's first terminal.
import { div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import {
  spaces,
  focused,
  agents,
  machines,
  panes,
  run,
  openOverlay,
  hc,
  theme,
  shared,
  setShared,
  watchFolder,
  window,
  layout,
} from "herdr";
import { PRStatusObserver, prPlaceKey, prAppearance } from "../git/pr-status.js";
import { REQUESTS, REQUEST_FILTER, requestURL } from "../git/requests-index.js";
import { spaceFolder, checkoutKey, readCheckout } from "../git/checkouts.js";
import { loadSettings, duration } from "../settings.js";
import { findNode } from "./find-node.js";
import { TEXT, ROW_END, Icon, IconButton, SpaceAvatar, Badge, Rail, SidebarScroll, directoryTint, attentionRows } from "./ui.js";

import { HEIGHT, SPACE, RADIUS } from "../ui-kit.js";
import { taskRows, agentCounts, spaceContext, repositoryGroups } from "./tree-model.js";
const TREE_STATE = "better-sidebar.tree";
const USUAL_BRANCHES = new Set(["main", "master"]);
const rowHeight = () => 48;

// Watches and terminal events handle most changes. Poll visible repositories
// occasionally to catch edits and commits made outside Herdr.
const GIT_FALLBACK_MS = 15000;
// Preferences a person may change in the installed mod.json under `settings`.
// `combined` is read by the lists view: tabs, or spaces above agents.
const DEFAULT_SETTINGS = { git: { retry_after: "15s" }, pull_request_status: true, combined: true, archive: true };

// A space speaks up only when something in it needs you.
function glyph(status) {
  return status === "blocked" || status === "done" ? "●" : "·";
}

function tone(t, status) {
  return t[status] ?? t.unknown;
}

export class Spaces {
  // ── Lifecycle and refresh scheduling ──────────────────────────────────────

  init(_props, cx) {
    this.prObserver = new PRStatusObserver();
    this.requestsPanel = Boolean(findNode(layout(), "merge-requests"));
    this.settings = DEFAULT_SETTINGS;
    this.applySettings(cx);
    // Repository caches are keyed by [machine, folder], so equal paths on
    // different machines cannot share Git or PR state. null means not a repo.
    this.git = Object.create(null);
    this.checked = {}; // Checkout key -> last Git read time.
    this.unsure = new Set(); // Transient failures, eligible for retry.
    this.pending = new Set(); // Deduplicated queue for the single Git reader.

    this.busy = {}; // pane -> an agent working or a program in front of its shell
    this.ready = {}; // machine -> its layout was readable at the last look
    this.at = {}; // Space ID -> checkout key at the previous refresh.
    this.watching = new Set(); // local repos' git folders
    // Spaces made while this runs wait (at most a moment) for their git, so a
    // worktree appears under its repo instead of jumping there.
    this.shown = new Set(spaces().map((s) => s.id));
    this.born = {};
    this.pressed = null;
    this.over = null;
    this.machines = [];
    this.folded = new Set();
    this.directoryOrder = [];
    try {
      this.folded = new Set(JSON.parse(localStorage.getItem("machines.folded") ?? "[]"));
    } catch {
      /* Ignore invalid saved UI state. */
    }
    try {
      const saved = JSON.parse(localStorage.getItem('directory.order') ?? '[]');
      if(Array.isArray(saved))this.directoryOrder=saved.filter(id=>typeof id==='string');
    } catch { /* Ignore invalid saved directory order. */ }
    this.refreshMachines(cx);
    cx.timer.every(15000, (cx) => this.refreshMachines(cx));
    // Git metadata is read only when a checkout's answer could have changed.
    cx.timer.every(1000, (cx) => this.checkNew(cx));
  }

  // Read the installed mod.json once; Herdr restarts the mod when it changes.
  applySettings(cx) {
    cx.spawn(async (cx) => {
      const { settings, problems } = await loadSettings("better-sidebar-refined", DEFAULT_SETTINGS);
      this.settings = settings;
      for (const problem of problems) console.warn(`better-sidebar mod.json settings: ${problem}`);
      cx.notify();
    });
  }

  checkNew(cx) {
    const now = Date.now();
    const sp = spaces();
    this.updateColors(sp);
    for (const s of sp) if (!this.shown.has(s.id)) this.born[s.id] ??= now;
    const ps = panes();
    this.publishParents(sp, ps);
    const places = sp.map((s) => {
      const tabs = new Set((s.tabs ?? []).map((tab) => tab.id));
      const folder = spaceFolder(s, ps);
      return {
        folder,
        machine: s.machine,
        branch:
          ps.find((p) => tabs.has(p.tab) && p.cwd === folder)?.branch ??
          this.git[prPlaceKey(s.machine, folder)]?.branch,
      };
    });
    this.requestsPanel = Boolean(findNode(layout(), "merge-requests"));
    if (!this.requestsPanel && this.settings.pull_request_status) this.prObserver.refresh(places, cx);
    const due = this.due(now, sp, ps);
    if (due.size) this.refreshGit(due, cx);
    if (sp.some((s) => !this.shown.has(s.id))) cx.notify();
  }

  // Places whose git could have changed: new ones (a new space, a cd), where a
  // command or an agent's turn just ended (a checkout, a commit, edits), those on
  // a machine that is back, and repos in view whose fallback is due.
  due(now, spaceList, paneList) {
    const places = Object.create(null);
    for (const space of spaceList) places[space.id] = checkoutKey(space, paneList);
    const used = new Set(Object.values(places).filter((key) => JSON.parse(key)[1]));
    const due = new Set([...used].filter((key) => !(key in this.git)));

    this.addChangedBranches(due, now, spaceList, paneList, places);
    this.addRevisited(due, places, used);
    this.addFinishedWork(due, spaceList, paneList, places, used);
    this.addReconnected(due, used);
    this.addFallbacks(due, now, used);
    return due;
  }

  // Branch names arrive live from Herdr. Refresh richer Git metadata promptly
  // after a checkout, without waiting for the slower fallback poll.
  addChangedBranches(due, now, spaceList, paneList, places) {
    for (const space of spaceList) {
      const key = places[space.id];
      const folder = spaceFolder(space, paneList);
      const tabIDs = new Set((space.tabs ?? []).map((tab) => tab.id));
      const branch = paneList.find((pane) => tabIDs.has(pane.tab) && pane.cwd === folder)?.branch;
      const stale = branch && !this.unsure.has(key) && this.git[key]?.branch !== branch;
      if (stale && now - (this.checked[key] ?? 0) > 1000) due.add(key);
    }
  }

  // Returning to a previously visited folder still requires a fresh read.
  addRevisited(due, places, used) {
    for (const [id, key] of Object.entries(places)) {
      if (this.at[id] && this.at[id] !== key && used.has(key)) due.add(key);
    }
    this.at = places;
  }

  // A completed command may have changed sibling worktrees' ahead/behind too.
  addFinishedWork(due, spaceList, paneList, places, used) {
    const spaceByTab = {};
    for (const space of spaceList) {
      for (const tab of space.tabs ?? []) spaceByTab[tab.id] = space;
    }
    const busy = {};
    for (const pane of paneList) {
      if (!pane.terminal || !spaceByTab[pane.tab]) continue;
      busy[pane.pane] = pane.status === "working" || !(pane.program?.shell || pane.program?.agent);
      if (this.busy[pane.pane] && !busy[pane.pane]) {
        const key = places[spaceByTab[pane.tab].id];
        this.sameRepo(key, used).forEach((k) => due.add(k));
      }
    }
    this.busy = busy;
  }

  addReconnected(due, used) {
    for (const machine of machines()) {
      const ready = machine.layout === "ready";
      if (ready && this.ready[machine.name] === false) {
        for (const key of used) if (JSON.parse(key)[0] === machine.name) due.add(key);
      }
      this.ready[machine.name] = ready;
    }
  }

  addFallbacks(due, now, used) {
    if (!window().active) return;
    const every = duration(this.settings.git.retry_after, GIT_FALLBACK_MS);
    for (const key of used) {
      const watched = this.git[key] || this.unsure.has(key);
      const shown = !this.folded.has(JSON.parse(key)[0]);
      if (watched && shown && now - (this.checked[key] ?? 0) > every) due.add(key);
    }
  }

  // `key` and the other places in its repo (a commit there moves their ahead/behind).
  sameRepo(key, keys) {
    const repo = this.git[key]?.repo;
    return [key, ...(repo ? [...keys].filter((k) => this.git[k]?.repo === repo) : [])];
  }

  refreshMachines(cx) {
    cx.spawn(async (cx) => {
      try {
        const r = await hc(["machine", "ls", "--json"]);
        if (r.code !== 0) return;
        const next = (JSON.parse(r.stdout).machines ?? []).filter((m) => !m.temporary);
        const signature = JSON.stringify(next.map(m => [m.name,m.state]));
        if(signature===this.machineSignature)return;
        this.machineSignature=signature;
        this.machines=next;
        cx.notify();
      } catch {
        // Keep the last machine list if core is temporarily unavailable.
      }
    });
  }

  // One look at a time, each place once however often it was asked for meanwhile.
  refreshGit(keys, cx) {
    for (const k of keys) this.pending.add(k);
    if (this.refreshing) return;
    this.refreshing = true;
    cx.spawn(async (cx) => {
      let changed = false;
      while (this.pending.size) {
        const keys = [...this.pending];
        this.pending.clear();
        for (const key of keys) {
          const before = JSON.stringify(this.git[key]);
          await this.check(key, cx);
          changed ||= before !== JSON.stringify(this.git[key]);
        }
      }
      const used = new Set(
        Object.values(this.git)
          .filter(Boolean)
          .map((g) => JSON.parse(g.repo))
          .filter(([on]) => !on)
          .map(([, repo]) => repo),
      );
      for (const repo of this.watching) if (!used.has(repo)) this.watching.delete(repo);
      this.refreshing = false;
      if(changed)cx.notify();
    });
  }

  // ── Read-only Git metadata and local watches ──────────────────────────────

  // One place's git. A failure to ask (the machine is away) keeps what it showed.
  async check(key, cx) {
    const [on, cwd] = JSON.parse(key);
    this.checked[key] = Date.now();
    this.unsure.delete(key);
    try {
      const info = await readCheckout(cwd, on);
      this.git[key] = info;
      if (info && !on) this.watch(JSON.parse(info.repo)[1], cx);
    } catch {
      this.git[key] ??= null;
      this.unsure.add(key);
    }
  }

  watch(repo, cx) {
    if (this.watching.has(repo)) return;
    this.watching.add(repo);
    cx.spawn(async (cx) => {
      try {
        while (this.watching.has(repo)) {
          await watchFolder(repo);
          const mine = JSON.stringify([null, repo]);
          if (this.watching.has(repo))
            this.refreshGit(
              Object.keys(this.git).filter((k) => this.git[k]?.repo === mine),
              cx,
            );
        }
      } catch {
        this.watching.delete(repo);
      }
    });
  }

  // ── Space navigation and worktree/machine grouping ────────────────────────

  // Tells the agents block, a separate copy, which main space each space belongs
  // to: the repository's open main checkout, else the repository's folder name.
  publishParents(sp, ps) {
    const known = sp.map((w) => ({ w, g: this.git[checkoutKey(w, ps)] })).filter((r) => r.g);
    const parents = {};
    for (const { w, g } of known) {
      const main = known.find((r) => r.g.repo === g.repo && !r.g.linked);
      const folder = JSON.parse(g.repo)[1]
        .replace(/\/\.git\/?$/, "")
        .split("/")
        .pop();
      parents[w.id] = { key: g.repo, label: main?.w.name || folder };
    }
    const text = JSON.stringify(parents);
    if (text === this.parentsText) return;
    this.parentsText = text;
    setShared("better-sidebar.space-parents", parents);
  }

  menu(w) {
    const row = this.ordered().find(r => r.w.id === w.id);
    const children=new Set((row?.members??[]).filter(id=>id!==w.id));
    openOverlay({mod:"better-sidebar-refined",kind:"popup",width:230,height:146,
      props:{view:"space-menu",space:w.id,taskSpace:w.contextSpace,repo:row?.repo ?? row?.g?.repo,virtual:Boolean(row?.virtual),
        hasChildren:spaces().some(s=>children.has(s.id)&&s.tabs?.length)}});
  }

  spaceFolded(id) { return !this.revealExpanded?.has(id) && Boolean((shared(TREE_STATE) ?? {}).folded?.[id]); }
  toggleSpace(id) {
    const folded = this.spaceFolded(id);
    this.revealExpanded?.delete(id);
    const state=shared(TREE_STATE)??{};
    setShared(TREE_STATE,{...state,folded:{...state.folded,[id]:!folded}});
  }
  statusCounts(ids, t) {
    const counts=agentCounts(this.agentStatus??attentionRows(agents(),focused()?.terminal),ids);
    return h_flex().flex_none().gap(5).items_center().children(
      Object.entries(counts).filter(([,n])=>n).map(([state,n])=>h_flex().gap(3).items_center().text_size(11)
        .text_color(t[state]).tooltip({working:"Running",blocked:"Needs input",done:"Unread result"}[state])
        .child(String(n)).child(state==="working"?Icon("spinner",12).spin(900):div().text_size(11).child(state==="blocked"?"◌":"●"))));
  }

  // Spaces in order, each worktree space moved under its main checkout's.
  ordered(sp = spaces(), ps = panes(), hosts = shared("task-spaces.hosts")??{}, folds = shared(TREE_STATE)?.folded??{}) {
    const ready = (w) =>
      this.shown.has(w.id) ||
      w.id === this.revealRequest?.space ||
      checkoutKey(w, ps) in this.git ||
      Date.now() - (this.born[w.id] ??= Date.now()) > 1500;
    for (const w of sp) if (!this.shown.has(w.id) && ready(w)) this.shown.add(w.id);
    const list = sp
      .map((w, i) => {
        const folder=spaceFolder(w,ps),tabs=new Set((w.tabs??[]).map(t=>t.id));
        const cached=this.git[checkoutKey(w,ps)]??null;
        const branch=ps.find(p=>tabs.has(p.tab)&&p.cwd===folder)?.branch;
        return {w:{...w,folder},i,g:branch?{...cached,branch}:cached};
      })
      .filter((r) => this.shown.has(r.w.id));
    const folded=new Set(Object.keys(folds).filter(k=>folds[k]));
    return taskRows(list,hosts,this.collapsed()?new Set():folded);
  }

  // The rows, under a header per machine once one isn't this computer.
  grouped(t, collapsed, snapshot, aboveCount = 0) {
    const paneList=snapshot?.paneList??panes();
    const hosts=snapshot?.hosts??shared('task-spaces.hosts')??{};
    const spaceList = snapshot?.spaceList ?? spaces();
    const reveal = this.revealRequest;
    if (reveal && !collapsed && !this.revealPath) {
      const expanded = repositoryGroups(this.ordered(spaceList, paneList, hosts, {}), hosts);
      const directory = expanded.find(group => group.rows.some(row => row.w.id === reveal.space));
      const project = directory?.rows.find(row => !row.tree && row.members?.includes(reveal.space));
      if (directory && project) {
        this.revealPath = {directory: directory.id, project: project.w.id};
        this.revealExpanded = new Set([directory.id, project.w.id, reveal.space]);
      }
    }
    const folds={...(shared(TREE_STATE)?.folded??{})};
    for (const id of this.revealExpanded ?? []) delete folds[id];
    const avatars=shared('space.colors')??{};
    const rows=this.ordered(spaceList,paneList,hosts,folds);
    const colors=shared('better-sidebar.directory-colors')??{};
    const requests=this.requestsPanel ? shared(REQUESTS) : null;
    const activeSpace=(snapshot?snapshot.focus:focused())?.space;
    const draw = (r,paint,target) => {
      const mrCount=requests?.badges?.[r.w.id] ?? requests?.open?.[r.w.id];
      if (collapsed) {
        if (this.refinedChrome ? r.tree : r.presentationRoot) return [];
        return [this.compact(r, t, mrCount)];
      }
      const folded=Boolean(folds[r.w.id]);
      return [this.row({...r,paint,mrCount},t,paneList,hosts,folded,avatars),
        ...(r.virtual||folded?[]:this.under?.(r,paint,target)??[])];
    };
    let revealAnchor;
    const projects = (list,paint, locate = false) => {
      if(collapsed)return list.flatMap(r=>draw(r));
      const blocks=[];
      for(const r of list) {
        if(!r.tree||!blocks.length)blocks.push({root:r,rows:[]});
        blocks.at(-1).rows.push(r);
      }
      return blocks.flatMap(({root,rows})=>{
        const active=(root.members??[root.w.id]).includes(activeSpace)||rows.some(r=>r.w.active);
        const card = (content, id, first = true, last = true) => v_flex().id(id)
          .min_w(0).px(ROW_END.cardInset).pt(first ? 4 : 0).pb(last ? 4 : 0).mb(last ? 8 : 0)
          .rounded(this.refinedChrome ? RADIUS.surface : 9).relative()
          .when(!first, el => el.rounded_t(0))
          .when(!last, el => el.rounded_b(0))
          .when(Boolean(paint.base) || !this.refinedChrome, el => el.bg(paint.base || t.foreground+'04'))
          .when(active,e=>e.child(div().id('active-'+id).absolute().left(0).top(first ? 8 : 0).bottom(last ? 8 : 0).w(2).rounded(1).bg(t.accent)
            .opacity(this.refinedChrome ? .85 : .4)))
          .when(this.sessionDrag?.current?.target===root.w.id,e=>e.border(1).border_color(t.accent))
          .when(this.sessionDrag?.tracking&&!root.presentationRoot,e=>e
            .on_mouse_move((event,cx)=>this.sessionDrag.over(root.w.id,event,cx))
            .on_mouse_up("left",(event,cx)=>this.sessionDrag.drop(root.w.id,event,cx)))
          .when(this.sessionDrag?.tracking,e=>e.on_hover((on,cx)=>{
            const target=this.sessionDrag.current?.target;
            if(!on&&target&&(root.members??[root.w.id]).includes(target))this.sessionDrag.leave(target,cx);
          }))
          .children(content);
        const id = 'project-'+root.w.id;
        if (!locate || root.w.id !== this.revealPath?.project) return [card(rows.flatMap(r=>draw(r,paint)),id)];
        // A native scroll handle can reveal a direct child. Divide just this
        // card at the target row so the precise session can be scrolled into view.
        const content = [];
        let index = -1;
        for (const row of rows) {
          const target = row.w.id === reveal.space ? { ...reveal, index:0 } : null;
          const nodes = draw(row,paint,target);
          if (target) index = content.length + target.index;
          content.push(...nodes);
        }
        if (index < 0) return [card(content,id)];
        const before = content.slice(0,index), after = content.slice(index+1);
        revealAnchor = card([content[index]],id+'-current',!before.length,!after.length);
        return [
          ...(before.length ? [card(before,id,true,false)] : []), revealAnchor,
          ...(after.length ? [card(after,id+'-rest',false,true)] : []),
        ];
      });
    };
    // Hosts are attributes of directory groups, never another collapsible level.
    if(rows.length) {
      const rank=new Map(this.directoryOrder.map((id,index)=>[id,index]));
      const groups=repositoryGroups(rows,hosts).sort((a,b)=>(rank.get(a.id)??rank.size)-(rank.get(b.id)??rank.size));
      if(collapsed)return groups.flatMap(repo=>projects(repo.rows));
      const ids=groups.map(repo=>repo.id);
      const output = groups.flatMap(repo=>{
        const folded=Boolean(folds[repo.id]),paint=this.paint(repo.machine,repo.folder,t,colors);
        const locate = !folded && repo.id === this.revealPath?.directory &&
          !this.directoryDrag && !this.draggingSpace && !this.sessionDrag?.tracking;
        if (locate) return [this.directorySection(repo,t,ids,false,[]), ...projects(repo.rows,paint,true)];
        return [this.directorySection(repo,t,ids,folded,folded?[]:projects(repo.rows,paint))];
      });
      if (revealAnchor && this.revealScrolled !== reveal.at) {
        this.revealScroll?.scroll_to_item(aboveCount + output.indexOf(revealAnchor));
        this.revealScrolled = reveal.at;
      }
      return output;
    }
    const loading=[null,...this.machines.map(m=>m.name)].some(m=>this.machineLoading(m));
    return [loading?this.loadingRow(null,t,collapsed):
      div().px(8).py(10).text_color(t.dim).child(collapsed?'–':'No Spaces yet. Create a task to get started.')];
  }

  paint(machine,folder,t,colors) {
    return {
      base:directoryTint(machine,folder,t,t.chrome,colors),
      hover:this.refinedChrome ? t.hover : directoryTint(machine,folder,t,t.hover,colors)||t.hover,
      selected:this.refinedChrome ? t.selected : directoryTint(machine,folder,t,t.selected,colors)||t.selected,
    };
  }

  directorySection(repo,t,ids,folded,children) {
    const drag=this.directoryDrag,active=Boolean(drag?.active),target=drag?.target;
    return v_flex().id('directory-group-'+repo.id).relative().flex_none().min_w(0)
      .when(active&&drag.id===repo.id,e=>e.opacity(.55))
      .when(Boolean(drag),e=>e
        .on_mouse_move((event,cx)=>this.hoverDirectory(repo.id,event,cx))
        .on_mouse_up('left',(event,cx)=>this.dropDirectory(repo.id,event,ids,cx)))
      .child(this.directoryHeader(repo,t,folded))
      .children(children)
      .when(active&&target?.id===repo.id,e=>e.child(div().id('directory-drop-'+repo.id)
        .absolute().left(0).right(0).h(2).rounded(1).bg(t.accent)
        .when(target.before,x=>x.top(0)).when(!target.before,x=>x.bottom(0))));
  }

  beginDirectoryDrag(id,event,cx) {
    if(!event.position)return;
    this.clearSpaceDrag(cx);
    this.suppressDirectoryClick=false;
    this.directoryDrag={id,start:event.position,active:false,target:null};
  }

  clearDirectoryDrag(cx) {
    if(this.directoryDrag?.active){this.suppressDirectoryClick=true;cx.notify();}
    this.directoryDrag=null;
  }

  directoryDropTarget(id,event) {
    const drag=this.directoryDrag;
    if(!drag?.active||id===drag.id||!event.position||!event.bounds)return null;
    return {id,before:event.position.y < event.bounds.y+event.bounds.height/2};
  }

  hoverDirectory(id,event,cx) {
    const drag=this.directoryDrag;
    if(!drag?.active)return;
    const target=this.directoryDropTarget(id,event);
    if(target?.id===drag.target?.id&&target?.before===drag.target?.before)return;
    drag.target=target;
    cx.notify();
  }

  dropDirectory(id,event,ids,cx) {
    const source=this.directoryDrag?.id,target=this.directoryDropTarget(id,event);
    const active=this.directoryDrag?.active;
    this.clearDirectoryDrag(cx);
    if(active)cx.stop_propagation();
    if(!target||!ids.includes(source))return;
    const next=ids.filter(id=>id!==source);
    next.splice(next.indexOf(id)+(target.before?0:1),0,source);
    if(next.every((id,index)=>id===ids[index]))return;
    this.directoryOrder=[...next,...this.directoryOrder.filter(id=>!ids.includes(id))];
    localStorage.setItem('directory.order',JSON.stringify(this.directoryOrder));
  }

  directoryHeader(repo,t,folded=this.spaceFolded(repo.id)) {
    const machine=repo.machine??null;
    const connected=!machine||this.machines.some(m=>m.name===machine&&m.state==='connected');
    return h_flex().id(repo.id).h(this.refinedChrome ? HEIGHT.control : 27).pl(ROW_END.padding).pr(ROW_END.padding+ROW_END.cardInset)
      .mb(4).gap(7).items_center().rounded(6).hover(e=>e.bg(t.hover))
      .text_color(this.refinedChrome ? t.muted : t.dim).text_size(TEXT.label)
      .cursor_grab().on_mouse_down('left',(e,cx)=>this.beginDirectoryDrag(repo.id,e,cx))
      .on_click(()=>{if(!this.suppressDirectoryClick)this.toggleSpace(repo.id);this.suppressDirectoryClick=false;})
      .on_mouse_down('right',(_e,cx)=>{cx.stop_propagation();openOverlay({mod:'better-sidebar-refined',kind:'popup',width:245,height:405,props:{view:'directory-menu',machine,folder:repo.folder,name:repo.name}});})
      .child(Icon(folded?'chevron-right':'chevron-down',11).id('disclosure-'+repo.id))
      .child(Icon('folder',13)).child(div().flex_1().min_w(0).truncate().font_medium().tooltip(repo.folder).child(repo.name))
      .when(!this.refinedChrome || this.width >= 240 || !connected, el => el.child(
        div().text_size(10).text_color(connected ? (this.refinedChrome ? t.muted : t.dim) : t.ansi3)
          .tooltip(connected ? repo.folder : 'Host offline').child(machine === 'ivm' ? 'IVM' : machine || 'Local')))
      .child(IconButton({t,id:'new-task-'+repo.id,icon:'plus',iconSize:11,muted:true,label:'New task in '+repo.name,onClick:()=>openOverlay({mod:'task-spaces-refined',kind:'popup',width:540,height:0.85,props:{action:'create',entry:'repository',machine,folder:repo.folder}})}).size(ROW_END.status).opacity(.68).hover(e=>e.opacity(1)));
  }

  machineLoading(m) {
    const layout = machines().find((k) => k.name === m)?.layout;
    return (
      layout === "loading" ||
      (!layout && this.machines.some((k) => k.name === m && k.state === "connected")) ||
      spaces().some((s) => (s.machine ?? null) === m && !this.shown.has(s.id))
    );
  }

  loadingRow(m, t, collapsed) {
    return div()
      .id(`machine-loading-${m ?? "local"}`)
      .h(28)
      .flex_none()
      .px(8)
      .text_size(TEXT.small)
      .text_color(t.dim)
      .child(collapsed ? "…" : "Loading Spaces…");
  }

  newSpaceRow(m, t, collapsed) {
    return h_flex()
      .id(`machine-new-${m ?? "local"}`)
      .h(28)
      .flex_none()
      .px(8)
      .gap(7)
      .items_center()
      .rounded(7)
      .text_size(TEXT.small)
      .text_color(t.dim)
      .hover((s) => s.bg(t.hover).text_color(t.foreground))
      .on_click(() => openOverlay({mod:'task-spaces-refined',kind:'popup',width:540,height:0.85,props:{action:'create',entry:'host',mode:'session',machine:m}}))
      .child(Icon("plus", 12))
      .when(!collapsed, (el) => el.child("New task"));
  }

  machineHeader(m, t, collapsed) {
    const machine = this.machines.find((k) => k.name === m);
    const connected = !m || machine?.state === "connected";
    const head = h_flex()
      .id(`machine-${m ?? "local"}`)
      .h(28)
      .flex_none()
      .px(collapsed ? 2 : 8)
      .gap(7)
      .items_center()
      .text_size(TEXT.label)
      .font_medium().rounded(6)
      .text_color(t.dim)
      .cursor_pointer()
      .hover((s) => s.bg(t.hover))
      .on_click((_e, cx) => {
        if (!this.folded.delete(m)) this.folded.add(m);
        localStorage.setItem("machines.folded", JSON.stringify([...this.folded]));
        cx.notify();
      })
      .child(Icon(this.folded.has(m)?"chevron-right":"chevron-down",11).id(`disclosure-machine-${m??"local"}`))
      .child(Icon(m ? "server" : "monitor", 13));
    if (collapsed) return head;
    return head
      .child(
        div()
          .flex_1()
          .truncate()
          .child(m==="ivm"?"IVM":m??"Local"),
      )
      .when(!connected, (el) =>
        el.child(
          div()
            .flex_none()
            .child((machine?.state ?? "asleep").replace(/_/g, " ")),
        ),
      )
      .when(connected && Boolean(m), (el) => el.child(div().id("setup-host-" + m).px(5)
        .tooltip("Set up Task Spaces on " + m).accessibility_label("Set up host")
        .cursor_pointer().hover((style) => style.bg(t.hover)).child("Setup").on_click((_event, cx) => {
          cx.stop_propagation();
          openOverlay({ mod: "worktree-close-refined", kind: "popup", width: 500, height: 260,
            props: { mode: "host", machine: m } });
        })))
      .when(connected, (el) => el.child(this.machineAddButton(m, t)))
      .child(
        div()
          .size(6)
          .rounded(3)
          .flex_none()
          .bg(connected ? t.ansi2 : t.dim),
      );
  }

  machineAddButton(m, t) {
    return div()
      .id(`machine-add-${m ?? "local"}`)
      .flex_none()
      .px(4)
      .rounded(4)
      .hover((s) => s.bg(t.hover).text_color(t.foreground))
      .on_click((_e, cx) => {
        cx.stop_propagation();
        openOverlay({mod:'task-spaces-refined',kind:'popup',width:540,height:0.85,props:{action:'create',entry:'host',mode:'session',machine:m}});
      })
      .child("+");
  }

  // ── Branch and PR descriptions ───────────────────────────────────────────

  // The right end of a name row: the branch unless it's the usual one or repeats the
  // name, and on the selected space how far it is from its remote.
  // The branch, quietly beside the name. main, master and the space's own name go without saying.
  branchName(g, name, t) {
    const branch = g?.branch === "(detached)" ? "detached" : (g?.branch ?? "detached");
    const shown = g && !USUAL_BRANCHES.has(branch) && branch !== name;
    return div()
      .flex_1()
      .min_w(0)
      .truncate()
      .text_size(TEXT.caption)
      .text_color(t.dim)
      .when(shown, (el) => el.tooltip(branch).child(branch));
  }

  // Only the pull request belongs here; commit-distance counters add sidebar noise.
  requestBadge(space, count, t) {
    if (!count) return null;
    const counts = typeof count === "number" ? {open:count,merged:0,closed:0} : count;
    const summary = Object.entries(counts).filter(([, total]) => total > 0)
      .map(([state,total]) => `${total} ${state}`).join(", ");
    if (!summary) return null;
    const label = `Merge requests · ${summary} · ${space.name}`;
    const color = counts.open || counts.closed ? t.accent : t.ansi5;
    const shortcut = window().platform === "macos" ? "Cmd" : "Ctrl";
    return IconButton({
      id: `space-mrs-${space.id}`, icon: "pull-request", iconSize: 11, label, t,
      onClick: (cx, event) => {
        if (this.isPRLinkClick(event)) {
          const requests = shared(REQUESTS)?.requests ?? [];
          const urls = new Set(requests.filter(pr => pr.spaces?.some(row => row.id === space.id)).map(requestURL));
          for (const url of urls) if (url) cx.open_url(url);
          return;
        }
        setShared(REQUEST_FILTER, space.id);
        run("layout.select", { stack: "panel-body", child: "merge-requests" });
        run("layout.show", { id: "panel" });
      },
    }).size(ROW_END.status).text_color(color).hover(el => el.bg(t.hover).text_color(t.foreground))
      .tooltip(`${label}\n${shortcut}-click to open all in browser`);
  }

  // The branch and PR must describe the same checkout: the space's first
  // terminal, matching Herdr's space naming and worktree grouping semantics.
  checkoutStatus(w, ps = panes()) {
    const folder = spaceFolder(w, ps);
    const tabs = new Set((w.tabs ?? []).map((tab) => tab.id));
    const branch =
      ps.find((pane) => tabs.has(pane.tab) && pane.cwd === folder)?.branch ??
      this.git[prPlaceKey(w.machine, folder)]?.branch;
    const status = this.prObserver.entries.get(prPlaceKey(w.machine, folder));
    return status?.branch === branch ? status : null;
  }

  checkoutPRs(w) {
    return this.checkoutStatus(w)?.prs ?? [];
  }

  // Keep ordinary clicks available to the enclosing space row. Modified link
  // presses must stop both mouse events: the row selects on mouse-up, not click.
  isPRLinkClick(event) {
    return window().platform === "macos"
      ? Boolean(event.modifiers?.platform)
      : Boolean(event.modifiers?.control || event.modifiers?.platform);
  }

  prNumber(w, pr, status) {
    const url = pr.url || `https://github.com/${pr.repository}/pull/${pr.number}`;
    const shortcut = window().platform === "macos" ? "Cmd" : "Ctrl";
    return div()
      .id(`space-pr-link-${w.id}-${pr.repository}-${pr.number}`)
      .text_size(TEXT.caption)
      .cursor_pointer()
      .tooltip(
        `${pr.repository}#${pr.number} · ${status.label}\n${pr.title}\n${url}\n${shortcut}-click to open`,
      )
      .on_mouse_down("left", (event, cx) => {
        if (!this.isPRLinkClick(event)) return;
        cx.stop_propagation();
        this.clearSpaceDrag(cx);
      })
      .on_mouse_up("left", (event, cx) => {
        if (this.isPRLinkClick(event)) cx.stop_propagation();
      })
      .on_click((event, cx) => {
        if (!this.isPRLinkClick(event)) return;
        cx.stop_propagation();
        cx.open_url(url);
      })
      .child(status.ready ? `#${pr.number} ✓` : `#${pr.number}`);
  }

  prBadge(w, t, compact = false, status) {
    const prs = status===undefined?this.checkoutPRs(w):status?.prs??[];
    if (!prs.length) return null;
    const badge = h_flex().gap(5).flex_none().items_center();
    // Keep the sidebar width bounded when a branch targets several base repos.
    for (const pr of prs.slice(0, 1)) {
      const status = prAppearance(pr, t);
      badge.child(
        h_flex()
          .id(`space-pr-${w.id}-${pr.repository}-${pr.number}`)
          .gap(3)
          .items_center()
          .text_color(status.color)
          .tooltip(`${pr.repository}#${pr.number} · ${status.label}\n${pr.title}`)
          .child(Icon(`${status.icon}`).size(13).flex_none())
          .when(!compact, (el) => el.child(this.prNumber(w, pr, status))),
      );
    }
    if (!compact && prs.length > 1)
      badge.child(
        div()
          .text_size(TEXT.caption)
          .text_color(t.dim)
          .tooltip(
            prs
              .slice(1)
              .map((pr) => `${pr.repository}#${pr.number} · ${pr.title}`)
              .join("\n"),
          )
          .child(`+${prs.length - 1}`),
      );
    return badge;
  }

  // Under the row only when the PR lookup failed; the PR itself sits at the row's right.
  prLine(w, t, tree, status = this.checkoutStatus(w)) {
    return h_flex()
      .id(`space-pr-line-${w.id}`)
      .h(20)
      .pl(tree ? 44 : 27)
      .items_center()
      .tooltip(`PR refresh failed: ${status.error}`)
      .child(
        div()
          .text_size(TEXT.caption)
          .text_color(t.dim)
          .child(status.prs.length ? "PR may be stale" : "PR unavailable"),
      );
  }
  // ── Expanded/compact rows and sidebar rendering ──────────────────────────

  row({ w, i, g, tree, virtual, presentationRoot, members, paint, mrCount }, t, paneList, hosts=shared("task-spaces.hosts")??{}, folded=this.spaceFolded(w.id), avatars) {
    const status = virtual || this.requestsPanel ? null : this.checkoutStatus(w,paneList);
    const hasPRLine = Boolean(status?.error);
    // One row is lit: under the lists view, the focused agent beneath takes it.
    const lit = w.active && !this.quiet?.(w,folded);
    const context = spaceContext(w,g,hosts);
    const branch = g?.branch?.replace(/^users\/[^/]+\//, "");
    const caption = tree ? branch || "Branch unavailable" : this.refinedChrome ? branch : context.location;
    const showCaption = (!virtual || presentationRoot) && Boolean(caption);
    const row = v_flex()
      .relative()
      .id(`space-${w.id}`)
      .px(ROW_END.padding)
      .h((this.refinedChrome ? showCaption ? HEIGHT.rowTwo : HEIGHT.row : rowHeight({ tree })) + (hasPRLine ? 22 : 0))
      .flex_none()
      .justify_center()
      .rounded(8)
      .when(lit, (el) => el.bg(paint?.selected||t.selected))
      .when(this.sessionDrag?.current?.target===w.id,e=>e.border(1).border_color(t.accent))
      .when(!lit, (el) => el.hover((s) => s.bg(paint?.hover||t.hover)))
      .when(this.draggingSpace && this.pressed === i && this.over !== i, el=>el.opacity(.5))
      .on_mouse_down("right", (_e,cx) => {cx.stop_propagation();this.menu(w);})
      .child(this.rowTitle(w,tree,t,virtual,members,status,context.folder,folded,avatars,mrCount))
      .when(showCaption, el=>el.child(
        div().id(`space-context-${w.id}`).pl(22).min_w(0).truncate()
          .text_size(this.refinedChrome ? TEXT.badge : TEXT.caption).text_color(this.refinedChrome ? t.muted : t.dim)
          .when(this.refinedChrome, label => label.opacity(.8))
          .tooltip(`${context.location}${g?.branch ? "\n"+g.branch : ""}`)
          .child(caption)
      ))
      .when(hasPRLine, (el) => el.child(this.prLine(w, t, Boolean(tree), status)));
    if (this.draggingSpace && this.over === i && this.pressed !== i)
      row.child(this.dropLine(i, t));
    const activate = () => this.openSpace(w, members);
    const dragged = virtual ? row.cursor_pointer().on_click(activate) : this.withDragging(row, w, i, activate);
    // Nested under the lists view, a worktree hangs from its main space's line.
    if (!(tree && this.under)) return dragged;
    if (this.refinedChrome) return h_flex().pl(SPACE.row).child(dragged.flex_1().min_w(0));
    return h_flex().child(Rail(tree.startsWith("└") ? "└" : "├", 14,t)).child(dragged.flex_1().min_w(0));
  }

  openSpace(w, members = [w.id]) {
    if (members.length === 1 && members[0] === w.id) {
      run("space.select", {id: w.id});
      return;
    }
    // Projected task roots may not exist natively. Members include checkouts
    // hidden by disclosure, so navigation never depends on the drawn rows.
    const native = new Map(spaces().map(space => [space.id, space]));
    const candidates = [...new Set([w.id, ...members])].map(id => native.get(id)).filter(Boolean);
    const agentTabs = new Set(agents().map(agent => agent.tab));
    const pick = (space, accepts) => {
      const tabs = (space.tabs ?? []).filter(tab => tab.panes !== 0 && accepts(tab));
      return tabs.find(tab => tab.active) ?? tabs[0];
    };
    const current = candidates.find(space => space.active);
    const ordered = current ? [current, ...candidates.filter(space => space !== current)] : candidates;
    const isAgent = tab => tab.status != null || agentTabs.has(tab.id);
    const tab = ordered.map(space => pick(space, isAgent)).find(Boolean) ??
      ordered.map(space => pick(space, () => true)).find(Boolean);
    if (tab) run("tab.select", {id: tab.id});
    else if (candidates.length) run("space.select", {id: candidates[0].id});
  }

  // Where the dragged space would land.
  dropLine(i, t) {
    return div()
      .absolute()
      .left(0)
      .right(0)
      .h(2)
      .bg(t.accent)
      .when(this.pressed < i, (line) => line.bottom(0))
      .when(this.pressed > i, (line) => line.top(0));
  }

  // Press to select or start a drag; spaces only move within their machine.
  clearSpaceDrag(cx) {
    const painted=this.draggingSpace;
    this.pressed=null;this.over=null;this.pressedSpace=null;this.pressPoint=null;this.draggingSpace=false;
    if(painted)cx.notify();
  }

  armDrag(event,cx) {
    const directory=this.directoryDrag;
    if(directory) {
      const point=event.position;
      if(!directory.active&&point&&Math.hypot(point.x-directory.start.x,point.y-directory.start.y)>=6) {
        directory.active=true;
        cx.notify();
        cx.timer.after?.(15000,cx=>{if(this.directoryDrag===directory)this.clearDirectoryDrag(cx);});
      }
      return;
    }
    const start=this.pressPoint,point=event.position;
    if(!start||!point||this.draggingSpace||Math.hypot(point.x-start.x,point.y-start.y)<6)return;
    this.draggingSpace=true;
    cx.notify();
  }

  withDragging(row, w, i, activate) {
    return row
      .on_mouse_down("left", e => {
        this.pressed=i;this.pressedSpace=w;this.pressPoint=e?.position;
        this.over=null;this.draggingSpace=false;
      })
      .when(this.draggingSpace||this.sessionDrag?.tracking,el=>el.on_mouse_move((e,cx)=>{
        if(this.sessionDrag?.tracking){cx.stop_propagation();this.sessionDrag.over(w.id,e,cx);return;}
        const source=this.pressedSpace;
        if(!this.draggingSpace||!source)return;
        const over=(source.machine??null)===(w.machine??null)?i:null;
        if(this.over!==over){this.over=over;cx.notify();}
      }))
      .on_mouse_up("left",(e,cx)=>{
        if(this.sessionDrag?.drop(w.id,e,cx))return;
        const source=this.pressedSpace,from=this.pressed,dragging=this.draggingSpace;
        this.clearSpaceDrag(cx);
        if(!source)return;
        if(dragging&&from!==i&&(source.machine??null)===(w.machine??null)){
          const ps=panes(),sourceGit=this.git[checkoutKey(source,ps)],targetGit=this.git[checkoutKey(w,ps)];
          if(sourceGit?.linked&&sourceGit.repo===targetGit?.repo)
            openOverlay({mod:'task-spaces-refined',kind:'popup',width:540,height:0.85,props:{action:'manage',space:w.id,sourceSpace:source.id}});
          else run('space.move',{id:source.id,index:i+1});
        } else if(!dragging&&from===i)activate();
      });
  }

  rowTitle(w, tree, t, virtual = false, members = [], status, folder, folded=this.spaceFolded(w.id), avatars, mrCount) {
    const request = virtual ? null : this.requestsPanel
      ? this.requestBadge(w, mrCount, t) : this.prBadge(w, t, false, status);
    return h_flex()
      .gap(5)
      .items_center()
      .child(div().id(`fold-space-${w.id}`).w(12).flex_none().text_color(t.dim).cursor_pointer()
        .on_mouse_down("left",(_e,cx)=>cx.stop_propagation())
        .on_mouse_up("left",(_e,cx)=>cx.stop_propagation())
        .on_click((_e,cx)=>{cx.stop_propagation();this.toggleSpace(w.id);})
        .opacity(folded?1:.7).hover(e=>e.opacity(1).text_color(t.foreground))
        .child(this.refinedChrome ? Icon(folded ? "chevron-right" : "chevron-down", 12) : folded ? "▸" : "▾"))
      .when(Boolean(tree), (el) => el.when(!this.under, (e) => e.pl(22)).child(Icon("branch", 13).text_color(t.dim)))
      .when(!tree, (el) => el.child(this.avatar(w,t,avatars)))
      .child(
        div().id(`space-name-${w.id}`).flex_1().min_w(0).truncate().tooltip(folder? w.name+"\n"+folder : w.name).text_color(t.foreground).child(w.name),
      )
      .when(folded,el=>el.child(this.statusCounts(members?.length?members:[w.id],t)))
      .child(h_flex().gap(ROW_END.gap).flex_none().items_center()
        .when(Boolean(request),el=>el.child(h_flex().min_w(ROW_END.time).justify_end().child(request)))
        .child(IconButton({t,id:'new-session-'+w.id,icon:'plus',iconSize:11,muted:true,label:'New session in '+w.name,onClick:()=>openOverlay({mod:'task-spaces-refined',kind:'popup',width:540,height:0.85,props:{action:'create',entry:!tree&&(shared('task-spaces.hosts')??{})[w.machine||'local']?.tasks?.[(w.contextSpace||w.id).replace(w.machine?w.machine+'/':'','')]?'task':'worktree',space:w.contextSpace||w.id,machine:w.machine??null}})}).size(ROW_END.status).opacity(.68).hover(e=>e.opacity(1))));
  }

  avatar(w, t, avatars=shared("space.colors")??{}) {
    return SpaceAvatar(w, t, avatars);
  }

  compact({ w, i, members }, t, mrCount) {
    if (this.refinedChrome) {
      const counts = agentCounts(this.agentStatus ?? [], members ?? [w.id]);
      const status = counts.blocked ? "blocked" : counts.done ? "done" : counts.working ? "working" : null;
      const label = { blocked: "Needs input", done: "Unread", working: "Working" }[status];
      const active = w.active || members?.includes(focused()?.space);
      return h_flex().id(`space-${w.id}`).h(HEIGHT.row).gap(4)
      .flex_none().items_center().justify_center().rounded(RADIUS.control).cursor_pointer().tooltip(w.name)
      .accessibility_label(label ? `${w.name} · ${label}` : w.name)
      .when(active === true, el => el.bg(t.selected))
      .when(active !== true, el => el.hover(s => s.bg(t.hover)))
      .on_click(() => this.openSpace(w, members))
      .child(div().relative().child(this.avatar(w, t))
        .when(Boolean(status), el => el.child(
          div().size(6).absolute().top(0).right(0).rounded(4).bg(t[status]))));
    }
    const badge = this.requestsPanel ? this.requestBadge(w, mrCount, t) : this.prBadge(w, t, true);
    return h_flex()
      .id(`space-${w.id}`)
      .h(26)
      .flex_none()
      .justify_center()
      .gap(4)
      .when(w.active, (el) => el.bg(t.raised))
      .hover((s) => s.bg(t.hover))
      .on_click(() => run("space.select", { id: w.id }))
      .child(
        div()
          .text_color(w.active ? t.foreground : t.muted)
          .child(String(i + 1)),
      )
      .when(Boolean(badge), (el) => el.child(badge))
      .when(!badge, (el) => el.child(div().text_color(tone(t, w.status)).child(glyph(w.status))));
  }

  // Share avatar colors with Herdr's own space menus. Do this during data
  // synchronization, never render: setShared itself schedules a redraw.
  updateColors(sp) {
    const palette = ["ansi6", "ansi3", "ansi4", "ansi5", "ansi2", "ansi1"];
    const ids = new Set(sp.map((p) => p.id));
    const kept = Object.fromEntries(
      Object.entries(shared("space.colors") ?? {}).filter(([id]) => ids.has(id)),
    );
    let changed = Object.keys(kept).length !== Object.keys(shared("space.colors") ?? {}).length;
    for (const p of sp) {
      if (kept[p.id] || p.name === "~") continue;
      const uses = (c) => Object.values(kept).filter((v) => v === c).length;
      kept[p.id] = palette.reduce((best, c) => (uses(c) < uses(best) ? c : best));
      changed = true;
    }
    if (changed) setShared("space.colors", kept);
  }

  collapsed() {
    return (this.width ?? findNode(layout(), "sidebar")?.size?.px ?? Infinity) < 160;
  }

  render() {
    const t = theme();
    const collapsed = this.collapsed();
    return v_flex()
      .id("better-sidebar-root")
      .size_full()
      .min_h(0)
      .bg(t.chrome)
      .text_size(TEXT.body)
      .on_size_change((size, cx) => this.resized(size, cx))
      .child(this.header(t, collapsed))
      .child(this.body(t, collapsed));
  }

  resized(size, cx) {
    const wasCollapsed = (this.width ?? Infinity) < 160;
    this.width = size.width;
    if (wasCollapsed !== this.width < 160) cx.notify();
  }

  newSpaceButton() {
    return IconButton({
      id: "space-new",
      icon: "plus",
      label: "New task",
      iconSize: 14,
      muted: true,
      onClick: () => openOverlay({mod:'task-spaces-refined',kind:'popup',width:540,height:0.85,props:{action:'create'}}),
    });
  }

  header(t, collapsed) {
    return h_flex()
      .h(31)
      .pl(16)
      .pr(10)
      .items_center()
      .justify_between()
      .text_size(TEXT.label)
      .text_color(t.dim)
      .when(!collapsed, (el) => el.child("Spaces"))
      .child(this.newSpaceButton());
  }

  body(t, collapsed, snapshot) {
    const above = this.above?.() ?? [];
    return SidebarScroll("spaces-list",v_flex()
      .px(10)
      .pt(4)
      .pb(14)
      .on_mouse_up("left", (_e,cx)=>{this.clearSpaceDrag(cx);this.clearDirectoryDrag(cx);})
      .on_mouse_down_out((_e,cx)=>{this.clearSpaceDrag(cx);this.clearDirectoryDrag(cx);})
      .when(!this.sessionDrag,el=>el.on_mouse_move((e,cx)=>this.armDrag(e,cx)))
      .when(Boolean(this.revealScroll),el=>el.track_scroll(this.revealScroll))
      .children(above)
      .children(this.grouped(t, collapsed, snapshot, above.length)));
  }
}
