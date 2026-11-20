// Spaces and agents in one block. Combined (the default): tabs for Spaces, with
// each space's tabs and agents under it, and Agents. With `combined: false` in the settings: the
// two lists one above the other, as two blocks of this mod would draw them.
import { v_flex, h_flex, ScrollHandle } from "gpui-base";
import { theme, setAgentOrder, props, layout, run, shared, setShared, window, settings } from "herdr";
import { Spaces } from "./spaces.js";
import { Agents } from "./agents.js";
import { TEXT, Badge, Rail, Icon, IconButton, REVEAL_CURRENT } from "./ui.js";

import { SessionDrag } from "./session-drag.js";
import { SessionHub } from "./session-hub/main.js";

import { HEIGHT, SPACE, TYPE, controlState } from "../ui-kit.js";
import { findNode } from "./find-node.js";

const TABS = ["spaces", "agents", "archive"];
const WIDTH_BREAKS = [160, 214, 240, 300, 340];

export class Lists {
  init(given, cx) {
    this.refinedChrome = (props()?.refinedChrome ?? given?.refinedChrome) === true;
    this.spacesWidth = 268;
    this.minimalChrome = (props()?.minimalChrome ?? given?.minimalChrome) === true;
    this.spaces = new Spaces();
    this.spaces.init(given, cx);
    this.spaces.refinedChrome = this.refinedChrome;
    if (this.refinedChrome) {
      this.spaces.revealScroll = ScrollHandle.new();
      this.lastReveal = shared(REVEAL_CURRENT)?.at;
    }
    this.agents = new Agents();
    this.agents.init(given, cx);
    this.agents.refinedChrome = this.refinedChrome;
    this.sessionDrag=new SessionDrag();
    this.agents.sessionDrag=this.sessionDrag;this.spaces.sessionDrag=this.sessionDrag;
    this.archive = new SessionHub();
    this.archive.init({ hubView: "archive" }, cx);
    const saved = localStorage.getItem("lists.tab");
    this.tab = TABS.includes(saved) ? saved : "spaces";
  }

  pick(tab, cx) {
    this.spaces.clearDirectoryDrag(cx);
    this.tab = tab;
    localStorage.setItem("lists.tab", tab);
    cx.notify();
  }

  render() {
    const t = theme();
    const reveal = this.refinedChrome && shared(REVEAL_CURRENT);
    if (reveal?.space && reveal.at !== this.lastReveal) {
      this.lastReveal = reveal.at;
      this.tab = "spaces";
      this.spaces.revealRequest = reveal;
      this.spaces.revealPath = null;
    }
    const collapsed = this.spaces.collapsed();
    const root = v_flex()
      .id("better-sidebar-lists")
      .size_full()
      .min_h(0)
      .bg(t.chrome)
      .text_size(TEXT.body)
      .when(this.refinedChrome, el => el.border_r(1).border_color(t.border))
      .on_size_change((size, cx) => {
        this.spaces.resized(size, cx);
        if (!this.refinedChrome) return;
        const width = Math.round(size.width / (settings().zoom || 1));
        const reflow = WIDTH_BREAKS.some(limit => (width < limit) !== (this.spacesWidth < limit));
        this.spacesWidth = width;
        if (reflow) cx.notify();
      })
      .on_mouse_move((event,cx)=>{
        if(this.sessionDrag.current)this.sessionDrag.arm(event,cx);
        else this.spaces.armDrag(event,cx);
      })
      .on_mouse_down_out((_e,cx)=>{this.sessionDrag.cancel(cx);this.spaces.clearDirectoryDrag(cx);})
      .on_mouse_down("left",(_e,cx)=>this.sessionDrag.cancel(cx))
      // A release outside a valid row must not submit a stale highlighted target.
      .on_mouse_up("left",(_e,cx)=>{this.sessionDrag.finish(cx,null);this.spaces.clearDirectoryDrag(cx);});
    if(this.spaces.settings.archive===false&&this.tab==="archive")this.tab="spaces";
    this.spaces.under = null;
    this.spaces.quiet = null;
    this.spaces.above = null;
    const combined=Boolean(this.spaces.settings.combined)&&!collapsed;
    const view = this.agents.readView(combined&&this.tab==='agents',combined&&this.tab!=='agents');
    this.sessionDrag.frame(view);
    this.spaces.agentStatus=view.native;
    view.width = this.spacesWidth;
    if (this.refinedChrome) root.child(this.refinedHeader(t, view, collapsed));
    if (this.refinedChrome && collapsed)
      return root.child(this.spaces.body(t, true, view)).child(this.agents.expandRow(t));
    // The rail keeps a compact representation of both lists.
    if (!this.spaces.settings.combined || collapsed)
      return root
        .child(
          v_flex()
            .flex_1()
            .min_h(0)
            .when(!this.refinedChrome, el => el.child(this.spaces.header(t, collapsed)))
            .child(this.spaces.body(t, collapsed)),
        )
        .child(v_flex().flex_1().min_h(0).child(this.agents.render({view})));

    if (!this.refinedChrome) root.child(this.tabBar(t, view));
    if(this.sessionDrag.busy)root.child(h_flex().px(14).py(6).text_size(11).text_color(t.dim).child("Moving session…"));
    if(this.sessionDrag.error)root.child(h_flex().px(14).py(6).gap(7).items_center().child(
      h_flex().flex_1().min_w(0).text_size(11).text_color(t.ansi1).child(this.sessionDrag.error))
      .child(h_flex().id("retry-session-move").cursor_pointer().text_size(11).text_color(t.accent).on_click((_e,cx)=>this.sessionDrag.retry(cx)).child("Retry")));
    if (this.tab === "archive") return root.child(this.archive.render());
    if (this.tab !== "spaces") return root.child(this.agents.render({ view, heading: false, flat: true, hosts:this.spaces.machines.map(m=>m.name), hostHeader:m=>this.spaces.machineHeader(m,t,false), hostFolded:m=>this.spaces.folded.has(m) }));

    // Spaces, each with its tabs and agents beneath in tab order, so rows don't move as
    // their state changes; next-agent keys follow that order.
    const nested = { ...view, sort: { id: "grouped" }, byPriority: false, nested: true };
    const order = [];
    const all=view.native;
    const byTab=new Map();
    for(const agent of all){
      if(!byTab.has(agent.tab))byTab.set(agent.tab,[]);
      byTab.get(agent.tab).push(agent);
    }
    const agentTabs=new Set(view.list.map(a=>a.tab));
    const focusedSpaces=new Set(all.filter(a=>a.focused).map(a=>a.space));
    const nest = (lines, row) => h_flex()
      .when(this.refinedChrome, el => el.pl(lines.length * SPACE.row + SPACE.small))
      .when(!this.refinedChrome, el => el.children(lines.map(l => Rail(l, 15, t))))
      .child(row.flex_1().min_w(0));
    // A space's agents hang from its line; a main space's worktrees come after them,
    // so its line carries on, and a worktree's own agents sit one step further in.
    // Only agent tabs belong in this tree. Resource rows remain even with only shells.
    const shownTab = view.focus?.tab;
    const shownAgents = byTab.get(shownTab) ?? [];
    if (this.refinedChrome)
      nested.activeAgent = (shownAgents.find(agent => agent.focused) ?? shownAgents[0])?.address;
    const plain=tab=>!byTab.has(tab.id);
    const hasAgent=tab=>agentTabs.has(tab.id);
    this.spaces.under = ({ w, tree, kids },paint,target) => {
      const items = (w.tabs??[]).filter(hasAgent).flatMap(tab=>
        plain(tab)?tab.settled?[]:[{tab}]:byTab.get(tab.id).map(a=>({a})));
      order.push(...items.filter((x) => x.a).map((x) => x.a.address));
      const before = tree ? [tree.startsWith("└") ? "" : "│"] : [];
      const visible = [];
      for (const [i, x] of items.entries()) {
        const last = i === items.length - 1 && !kids;
        const [row, ...subs] = x.a
          ? this.agents.agentWithSubs(x.a, i, {...nested,paint}, t)
          : [this.agents.tabRow(w, x.tab, x.tab.id === shownTab, t, {...view,paint})];
        if (target && (x.a ? x.a.address === target.terminal : x.tab.id === target.tab))
          target.index = visible.length + 1;
        visible.push(nest([...before, last ? "└" : "├"], row),
          ...subs.map((s) => nest([...before, last ? "" : "│"], s)));
      }
      return visible;
    };
    // One row lit: a space whose focused agent or tab shows beneath it leaves it to that row.
    this.spaces.quiet = (w,folded) =>
      !folded && (focusedSpaces.has(w.id) || (w.tabs??[]).filter(hasAgent)
        .some(tab => tab.id === shownTab && (this.refinedChrome || plain(tab))));
    const body = this.spaces.body(t, false, view);
    const visible=new Set(order);
    setAgentOrder([...order,...all.filter(a=>!visible.has(a.address)).map(a=>a.address)]);
    return root.child(body);
  }

  refinedHeader(t, view, collapsed) {
    const w = window();
    const sidebar = findNode(layout(), "sidebar");
    const traffic = w?.platform === "macos" && w.titlebar === "none" && !w.fullscreen;
    const twoRows = !collapsed && this.spacesWidth < (traffic ? 340 : 240);
    const toggle = () => {
      if (!collapsed) setShared("sidebar.width", sidebar?.size?.px ?? this.spacesWidth);
      setShared("sidebar.collapsed", !collapsed);
      run("layout.resize", { id: "sidebar", px: collapsed
        ? Math.max(160, shared("sidebar.width") ?? 268) : traffic ? 76 : 44 });
    };
    const tools = h_flex().gap(2).items_center().flex_none()
      .when(!collapsed, el => el.child(IconButton({ id: "sidebar-search", icon: "search",
        label: "Search sessions", t, onClick: () => run("mod.open", { name: "picker" }) }).size(24)))
      .when(!collapsed || !traffic, el => el.child(IconButton({ id: "sidebar-width", icon: "panel-left",
        label: collapsed ? "Expand sidebar" : "Collapse to rail", t, onClick: toggle }).size(24)));
    const tabs = h_flex().flex_1().min_w(0).gap(2).items_center().children(
      TABS.filter(id => id !== "archive" || this.spaces.settings.archive !== false).map(id => {
        const label = id[0].toUpperCase() + id.slice(1);
        return controlState(h_flex().id(`lists-tab-${id}`).h(HEIGHT.control).px(6).gap(4)
          .items_center().rounded(6).text_size(TYPE.control).cursor_pointer()
          .text_color(this.tab === id ? t.foreground : t.muted).aria_selected(this.tab === id)
          .accessibility_label(id === "agents" ? `Agents (${view.count})` : label)
          .on_click((_event, cx) => this.pick(id, cx)).child(label)
          .when(id === "agents" && this.spacesWidth >= 300, el => el.child(
            h_flex().text_size(TYPE.micro).text_color(t.muted).child(String(view.count)))),
          t, { selected: this.tab === id });
      })
    );
    if (!collapsed && this.tab === "spaces" && this.spacesWidth >= 214)
      tools.child(this.spaces.newSpaceButton().size(24));
    const primary = h_flex().h(HEIGHT.band).px(SPACE.row).flex_none().items_center()
      .when(traffic, el => el.pl(76))
      .child(!twoRows && !collapsed ? tabs : h_flex().flex_1())
      .child(tools);
    return v_flex().flex_none()
      .child(primary)
      .when(twoRows, el => el.child(h_flex().h(32).px(SPACE.row).items_center().child(tabs)));
  }

  // Tabs side by side from the left, the picked one filled.
  tabBar(t, view) {
    const tab = (id, label, count) =>
      h_flex()
        .id(`lists-tab-${id}`)
        .px(10)
        .h(this.minimalChrome ? 28 : 24)
        .gap(5)
        .justify_center()
        .items_center()
        .rounded(6)
        .cursor_pointer()
        .text_size(TEXT.label)
        .font_medium()
        .text_color(this.tab === id ? t.foreground : t.dim)
        .when(this.tab === id, (el) => el.bg(t.selected))
        .when(this.tab !== id, (el) => el.hover((s) => s.bg(t.hover).text_color(t.foreground)))
        .on_click((_e, cx) => this.pick(id, cx))
        .child(label)
        // The count badge the group headers use.
        .when(count !== null, (el) => el.child(Badge(count,t)));
    return h_flex()
      .px(8)
      .h(36)
      .mb(4)
      .when(!this.minimalChrome, el => el.border_b(1).border_color(t.border))
      .flex_none()
      .gap(6)
      .items_center()
      .child(
        h_flex()
          .flex_1()
          .gap(2)
          .child(tab("spaces", "Spaces", null))
          .child(tab("agents", "Agents", view.count))
          .when(this.spaces.settings.archive!==false,el=>el.child(tab("archive", "Archive", null))),
      )
      .when(this.tab === "spaces", el => el.child(this.spaces.newSpaceButton()));
  }
}
