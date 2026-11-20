// The bar: tabs that wrap onto more lines, the + after them, then the toolbar and ⋮.
import { div, svg, image } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { spaces, panes, terminals, run, openOverlay, closeOverlay, focused, props, theme, window, shared, layout, settings } from "herdr";
import { offerWorktreeClose } from "./close-route.js";
import { find } from "../actions/engine.js";
import { TEXT, Icon, IconButton, DropLine } from "./ui.js";

import { HEIGHT, SPACE, TYPE } from "../ui-kit.js";

const CHAR_WIDTH = 8; // Roughly, to size the drag preview.
const TAB_HEIGHT = 29;
const TAB_GAP = 6; // Wide enough for the drop line to stand clear of both tabs.
const BAR_HEIGHT = 42;
const BAR_PADDING = BAR_HEIGHT - TAB_HEIGHT;
const WORKSPACE_TAB_HEIGHT = 28;
const WORKSPACE_TAB_GAP = 4;

const contains = (bounds, point) =>
  bounds &&
  point.x >= bounds.x &&
  point.x <= bounds.x + bounds.width &&
  point.y >= bounds.y &&
  point.y <= bounds.y + bounds.height;

export const tabBarMethods = {
  // A small button that ignores the click a drag's release can leave behind.
  simple(id, content, label, action) {
    return IconButton({
      id,
      content,
      label,
      onClick: (event, cx) => {
        if (!(Date.now() < this.ignoreClickUntil)) action(event, cx);
      },
    });
  },

  tabIcon(tab, ps, t, terminalByAddress, icons) {
    const mine = ps.filter((p) => p.tab === tab.id);
    const lead = mine.find((p) => p.program?.agent) ?? mine[0];
    const tool = terminalByAddress?.get(lead?.terminal)?.labels?.['agent.tool'];
    const program = icons?.[tool??lead?.program?.key]??lead?.program;
    if (program?.icon) {
      return program.tint
        ? svg(program.icon).size(14).text_color(t.muted)
        : image(program.icon).size(14);
    }
    // Mod panes carry no program, but a mod may publish an icon for itself.
    const modIcon = shared("mod-icons")?.[mine.find((p) => p.mod)?.mod];
    return modIcon ? svg(modIcon).size(14).text_color(t.muted) : null;
  },

  tabLabel(tab, ps, terminalByAddress) {
    if (tab.named && tab.name?.trim()) return tab.name;
    const mine = ps.filter(p=>p.tab===tab.id && p.terminal);
    const lead = mine.find(p=>p.program?.agent) ?? mine.find(p=>p.focused) ?? mine[0];
    return terminalByAddress.get(lead?.terminal)?.labels?.["session.title"]?.trim() || tab.name;
  },

  keepTaskRoot(space, all) {
    if(space.tabs?.length!==1)return false;
    const prefix=space.machine?`${space.machine}/`:'';
    const id=space.id.slice(prefix.length);
    const state=shared('task-spaces.hosts')?.[space.machine||'local'];
    const task=state?.tasks?.[id]??Object.values(state?.tasks??{}).find(row=>row.main_space?.space===id);
    if(!task)return false;
    const children=new Set(Object.values(state.checkouts??{}).filter(row=>row.task===task.id&&row.space!==id).map(row=>prefix+row.space));
    return all.some(row=>children.has(row.id)&&row.tabs?.length);
  },

  closeTab(id=focused()?.tab) {
    if(!id)return;
    const all=spaces(),space=all.find(row=>row.tabs?.some(tab=>tab.id===id));
    if(space?.tabs.length===1 && !this.keepTaskRoot(space,all) && offerWorktreeClose(space.id))return;
    if(space)run('tab.close',{id,...(this.keepTaskRoot(space,all)?{confirmed:true}:{})});
  },

  closeFocusedPane() {
    const target=focused();
    if(!target?.pane)return;
    const all=spaces(),space=all.find(row=>row.id===target.space);
    if(space?.tabs.find(tab=>tab.id===target.tab)?.panes===1) {
      if(this.keepTaskRoot(space,all))return this.closeTab(target.tab);
      if(space.tabs.length===1&&offerWorktreeClose(space.id))return;
    }
    run('pane.close',{pane:target.pane});
  },

  renderProtectedTabMenu() {
    const {overlay,tab,space}=props(),t=theme();
    const entries=[['Rename','tab.rename',{id:tab}],['New tab','tab.new',{space}],['Close tab','tab.close',{id:tab}]];
    const select=([,command,args])=>{
      closeOverlay(overlay);
      if(command==='tab.close')this.closeTab(tab);
      else run(command,args);
    };
    return v_flex().p(5).bg(t.popover).text_color(t.foreground).text_size(TEXT.menu)
      .track_focus(this.menuFocus).on_key_down((event,cx)=>{
        if(event.key==='escape')closeOverlay(overlay);
        else if(event.key==='enter')select(entries[this.menuIndex]);
        else if(event.key==='up'||event.key==='down') {
          this.menuIndex=(this.menuIndex+(event.key==='up'?entries.length-1:1))%entries.length;
          cx.notify();
        } else return;
        cx.stop_propagation();
      })
      .children(entries.map((entry,index)=>div().id(entry[1]).h(31).px(10).flex().items_center().rounded(5)
        .when(index===this.menuIndex,e=>e.bg(t.selected)).when(index!==this.menuIndex,e=>e.hover(s=>s.bg(t.hover)))
        .on_click(()=>select(entry)).child(entry[0])));
  },

  renderWorkspaceTabMenu(t) {
    const { overlay, space, height } = props();
    const tabs = spaces().find(item => item.id === space)?.tabs ?? [];
    const choose = tab => {
      closeOverlay(overlay);
      if (tab) run("tab.select", { id: tab.id });
    };
    return v_flex().h(height).p(4).bg(t.popover).text_color(t.foreground)
      .track_focus(this.menuFocus).on_key_down((event, cx) => {
        if (event.key === "escape") closeOverlay(overlay);
        else if (event.key === "enter" && !event.is_held) choose(tabs[this.menuIndex]);
        else if ((event.key === "up" || event.key === "down") && tabs.length) {
          this.menuIndex = (this.menuIndex + (event.key === "up" ? -1 : 1) + tabs.length) % tabs.length;
          this.menuScroll.scroll_to_item(this.menuIndex);
          cx.notify();
        } else return;
        cx.stop_propagation();
      })
      .child(v_flex().id("workspace-tab-menu-rows").min_h(0).flex_1().track_scroll(this.menuScroll)
        .overflow_y_scroll().children(tabs.map((tab, index) => h_flex().id(`workspace-menu-${tab.id}`)
          .h(HEIGHT.control).flex_none().px(8).gap(6).items_center().rounded(6).cursor_pointer()
          .text_size(TYPE.control).aria_selected(index === this.menuIndex)
          .when(index === this.menuIndex, el => el.bg(t.selected))
          .when(index !== this.menuIndex, el => el.hover(s => s.bg(t.hover)))
          .on_click(() => choose(tab))
          .child(div().flex_1().min_w(0).truncate().tooltip(tab.name).child(tab.name)))));
  },

  tabItem(tab, space, ps, t, terminalByAddress, icons, workspace = false) {
    const name = this.tabLabel(tab,ps,terminalByAddress);
    const icon = this.tabIcon(tab, ps, t, terminalByAddress, icons);
    const drag = this.tabDrag;
    const refined = workspace && this.config().refinedChrome;
    return h_flex()
      .id(`tab-${tab.id}`)
      .aria_selected(tab.active === true)
      .relative()
      .h(workspace ? WORKSPACE_TAB_HEIGHT : TAB_HEIGHT)
      .px(refined ? 6 : 10)
      .gap(refined ? 4 : 7)
      .rounded(workspace ? 6 : 7)
      .items_center()
      .flex_none()
      .text_size(workspace ? TYPE.control : TEXT.tab)
      .when(!workspace, el => el.border(1).border_color(tab.active ? t.border : t.chrome))
      .bg(tab.active ? (workspace ? t.selected : t.raised) : t.chrome)
      .when(workspace, el => el.on_size_change((size, cx) => {
        if (this.tabWidths.get(tab.id) === size.width) return;
        this.tabWidths.set(tab.id, size.width);
        cx.notify();
      }))
      .text_color(tab.active ? t.foreground : t.muted)
      .when(!tab.active, el => el.hover(s => s.bg(t.hover)))
      .active(s => s.bg(t.selected))
      .when(drag?.active && drag.id === tab.id, (el) => el.opacity(0.35))
      .on_mouse_down("left", (event, cx) => this.beginTabDrag(tab, event, cx))
      .on_mouse_move((event, cx) => this.hoverTab(tab, event, cx))
      .on_mouse_up("left", (event, cx) => this.finishTabDrag(tab, event, cx))
      .on_mouse_down("right", (_e, cx) => {
        cx.stop_propagation();
        this.cancelDrags(cx);
        if(this.keepTaskRoot(space,spaces())) {
          openOverlay({mod:'better-tabs-refined',kind:'popup',width:200,height:105,props:{mode:'protected-tab-menu',tab:tab.id,space:space.id}});
          return;
        }
        openOverlay({
          mod: "menu",
          kind: "popup",
          width: 200,
          props: { tab: "tab", target: { id: tab.id, space: space.id } },
        });
      })
      .when(Boolean(icon), (el) => el.child(icon))
      .child(
        div()
          .max_w(this.settings.tabs.max_width)
          .truncate()
          .tooltip(name)
          .child(tab.zoomed ? `${name} Z` : name),
      )
      .when(tab.status === "working", (el) =>
        el.child(Icon("spinner", 12).text_color(t.working).spin(900)),
      )
      .when(["blocked", "done"].includes(tab.status), (el) =>
        el.child(div().size(6).rounded(3).bg(t[tab.status])),
      )
      .when(workspace, el => el.child(div().w(refined ? 16 : 26).flex_none()
        .when(tab.active, slot => slot.child(this.closeTabButton(tab).size(refined ? 16 : 26)))))
      .when(!workspace && tab.active, el => el.child(this.closeTabButton(tab)))
      .when(drag?.active && drag.target?.id === tab.id, (el) =>
        el.child(DropLine(drag.target.after)),
      );
  },

  closeTabButton(tab) {
    return this.simple(`close-${tab.id}`, Icon("close", 12), "Close tab", (_e, cx) => {
      this.cancelDrags(cx);
      this.closeTab(tab.id);
    }).on_mouse_up("left", (_e, cx) => cx.stop_propagation());
  },

  dragPreview(t) {
    const drag = this.tabDrag?.active ? this.tabDrag : this.actionDrag();
    if (!drag?.active) return null;
    const width = Math.min(
      200,
      Math.max(90, String(drag.label).length * CHAR_WIDTH + (drag.icon ? 52 : 32)),
    );
    const x = drag.point.x - (this.barBounds?.x ?? 0);
    // Offset the preview from the pointer so it cannot cover the drop hitbox.
    const left = x + width + 12 < (this.width ?? 1200) ? x + 12 : Math.max(0, x - width - 12);
    return h_flex()
      .id("drag-preview")
      .absolute()
      .left(left)
      .top(4)
      .h(29)
      .w(width)
      .px(9)
      .gap(5)
      .items_center()
      .rounded(7)
      .border(1)
      .border_color(t.accent)
      .bg(t.raised)
      .text_color(t.foreground)
      .opacity(0.95)
      .when(Boolean(drag.icon), (el) => el.child(Icon(drag.icon)))
      .child(div().min_w(0).truncate().child(drag.label));
  },

  // Tabs wrap, and only the layout can make the bar taller. Sizes reach us scaled by
  // zoom, while layout sizes are written as at zoom 1.
  fitHeight(size) {
    const rows = Math.round(size.height / (settings().zoom || 1));
    const height = Math.max(BAR_HEIGHT, rows + BAR_PADDING);
    if (height === this.barHeight) return;
    this.barHeight = height;
    run("layout.resize", { id: find(layout(), "tabs-row") ? "tabs-row" : "tabs", px: height });
  },

  // Room for the macOS traffic lights when the sidebar doesn't already clear them.
  leftPadding() {
    const root = layout();
    const w = window();
    if (w?.platform !== "macos" || w.titlebar !== "none" || w.fullscreen || !root?.traffic_lights)
      return 10;
    const sidebar = find(root, "sidebar");
    const lights = (root.traffic_lights[0] + 64) / (settings().zoom || 1);
    return Math.max(10, lights - (sidebar?.hidden ? 0 : (sidebar?.size?.px ?? 0)));
  },

  syncEmptyWorkspace() {
    const stack = find(layout(), "workspace-content");
    if (!stack) return;
    const space = spaces().find(item => item.active);
    const tabs = space?.tabs ?? [];
    const active = tabs.find(tab => tab.active) ?? tabs[0];
    const hasSplits = active?.panes > 1 && !active.zoomed;
    const child = space && !tabs.some(tab => tab.panes !== 0) ? "workspace-empty"
      : hasSplits && stack.children?.some(node => node.id === "workspace-split") ? "workspace-split" : "main";
    if (stack.active !== child) run("layout.select", {stack: stack.id, child});
  },

  renderEmptyWorkspace(t) {
    const space = spaces().find(item => item.active);
    const create = () => openOverlay({mod: "agent-launcher-refined", kind: "popup", width: 480, height: 0.85,
      props: {space: space.id, fixedSpace: true}});
    return v_flex().size_full().items_center().justify_center().gap(12)
      .when(Boolean(space), el => el
        .child(div().text_size(13).text_color(t.muted).child("No sessions in this workspace"))
        .child(h_flex().id("empty-create-session").h(32).px(12).gap(6).rounded(6)
          .items_center().border_1().border_color(t.border).bg(t.raised).text_color(t.foreground)
          .text_size(TEXT.button).cursor_pointer().hover(button => button.bg(t.hover))
          .on_click(create).child(Icon("plus", 12)).child("Create session")));
  },

  render() {
    const mode = this.config().mode;
    if (mode === "protected-tab-menu") return this.renderProtectedTabMenu();
    if (mode === "overflow") return this.renderOverflow();
    const t = theme();
    if (mode === "workspace-tab-menu") return this.renderWorkspaceTabMenu(t);
    if (mode === "panel-toolbar") return this.renderPanelHeader(t);
    if (mode === "panel-footer") return div().size_full().bg(t.chrome);
    if (mode === "panel-gutter") return div().size_full().bg(t.canvas);
    if (mode === "empty-workspace") return this.renderEmptyWorkspace(t);
    const workspace = mode === "workspace-tabs";
    const refined = workspace && this.config().refinedChrome;
    const panel = workspace && find(layout(), this.config().rememberPanels?.container ?? "panel");
    const bar = h_flex()
      .id("better-tabs-root")
      .relative()
      .text_size(TEXT.tab)
      .size_full()
      .min_w(0)
      .px(10)
      .pl(this.leftPadding())
      .pt(workspace ? 0 : BAR_PADDING / 2)
      .pb(refined ? SPACE.row : workspace ? 4 : 0)
      .gap(workspace ? WORKSPACE_TAB_GAP : TAB_GAP)
      .items_start()
      .bg(t.chrome)
      .when(!workspace, el => el.border_b(1).border_color(t.border))
      .on_size_change((size, cx) => {
        if (this.width !== size.width) {
          this.width = size.width;
          cx.notify();
        }
      })
      .on_mouse_move((event, cx) => this.movePointer(event, cx))
      .on_mouse_up("left", (_event, cx) => {
        this.commitTabDrag(cx);
        this.finishActionDrag(cx);
      })
      .on_mouse_down_out((_event, cx) => this.cancelDrags(cx))
      .on_hover((hovered, cx) => {
        if (!hovered) this.cancelDrags(cx);
      })
      .child(this.renderTabList(t, workspace))
      .when(!workspace, el => el.child(this.renderToolbar(t)))
      .when(panel?.hidden, el => el.child(this.panelToggle(panel).mt(10)));
    if (window()?.buttons) bar.children(this.windowButtons());
    const preview = this.dragPreview(t);
    if (preview) bar.child(preview);
    return bar;
  },

  renderTabList(t, workspace = false) {
    const space = spaces().find((s) => s.active);
    const tabs = space?.tabs ?? [];
    const ps = panes();
    const terminalByAddress = new Map(terminals().map(t=>[t.address,t]));
    const icons = shared('agent-settings.icons')??{};
    const item = tab => this.tabItem(tab, space, ps, t, terminalByAddress, icons, workspace);
    if (workspace) return this.workspaceTabStrip(tabs, item, space?.id, t);
    return h_flex()
      .id("tab-scroll")
      .flex_1()
      .min_w(0)
      .flex_wrap()
      .items_center()
      .gap(TAB_GAP)
      .on_size_change((size) => this.fitHeight(size))
      .children(tabs.map(item))
      .child(this.newTabButton(tabs));
  },

  workspaceTabStrip(tabs, item, space, t) {
    const refined = this.config().refinedChrome;
    const zoom = settings().zoom || 1;
    const gap = WORKSPACE_TAB_GAP * zoom;
    const available = this.stripWidth || Infinity;
    const rows = [[]];
    let used = 0;
    // ScrollHandle can reveal a direct child. Make each measured row a child
    // so selecting a tab from a later row can reveal that whole row.
    for (const tab of refined ? tabs : [...tabs, null]) {
      const width = tab ? (this.tabWidths.get(tab.id) ?? 185 * zoom) : 26 * zoom;
      if (rows.at(-1).length && used + gap + width > available) {
        rows.push([]);
        used = 0;
      }
      used += (rows.at(-1).length ? gap : 0) + width;
      rows.at(-1).push(tab);
    }
    const active = tabs.find(tab => tab.active);
    const rowIndex = active ? rows.findIndex(row => row.includes(active)) : -1;
    const position = active ? `${active.id}:${rowIndex}` : null;
    if (position !== this.scrolledTab) {
      this.scrolledTab = position;
      if (rowIndex >= 0) this.tabScroll.scroll_to_item(rowIndex);
    }
    const rowCount = Math.min(2, rows.length);
    const strip = v_flex().flex_1().min_w(0).h_full().justify_end()
      .child(v_flex().id("tab-scroll").w_full().min_h(0)
        .h(rowCount * WORKSPACE_TAB_HEIGHT + (rowCount - 1) * WORKSPACE_TAB_GAP).gap(WORKSPACE_TAB_GAP)
        .track_scroll(this.tabScroll)
        .when(this.config().refinedChrome, el => el.overflow_y_scroll())
        .when(!this.config().refinedChrome, el => el.overflow_y_scrollbar().mode("scrolling"))
        .on_size_change((size, cx) => {
          const resized = this.stripWidth !== size.width;
          if (resized) {
            this.stripWidth = size.width;
            this.scrolledTab = null;
            cx.notify();
          }
          if (this.config().refinedChrome) this.fitWorkspaceBand(rowCount);
        })
        .children(rows.map(row => h_flex().h(WORKSPACE_TAB_HEIGHT).flex_none().items_center()
          .gap(WORKSPACE_TAB_GAP).children(row.map(tab => tab ? item(tab) : this.newTabButton(tabs))))));
    if (!refined) return strip;
    const more = rows.length > 2;
    const label = `All ${tabs.length} tabs`;
    const height = Math.min(360, tabs.length * HEIGHT.control + 8);
    const overflow = h_flex().w(26).h(WORKSPACE_TAB_HEIGHT).flex_none().items_center().justify_center()
      .when(more, el => el.child(this.simple("workspace-tab-overflow", Icon("more-vertical", 14), label, () =>
        openOverlay({ mod: "better-tabs-refined", kind: "popup", width: 280, height,
          props: { mode: "workspace-tab-menu", space, height, index: tabs.indexOf(active) < 0 ? 0 : tabs.indexOf(active) } }))));
    return h_flex().min_w(0).flex_1().h_full().items_end().gap(WORKSPACE_TAB_GAP)
      .child(strip).child(overflow).child(this.newTabButton(tabs).h(WORKSPACE_TAB_HEIGHT));
  },

  fitWorkspaceBand(rows) {
    const px = HEIGHT.band + (rows - 1) * (WORKSPACE_TAB_HEIGHT + WORKSPACE_TAB_GAP);
    const band = find(layout(), "tabs-row");
    if (band && band.size?.px !== px) run("layout.resize", { id: band.id, px });
  },

  // Dropping a tab on the + puts it last.
  newTabButton(tabs) {
    const asLast = (event) => ({ ...event, local_position: { x: Infinity } });
    return this.simple("tab-new", Icon("plus", 14), "New tab", () =>
      openOverlay({ mod: "agent-launcher-refined", kind: "popup", width: 480, height: 0.85, props: { space: spaces().find((s) => s.active)?.id, fixedSpace: true } }),
    )
      .on_mouse_move((event, cx) => {
        if (tabs.length) this.hoverTab(tabs.at(-1), asLast(event), cx);
      })
      .on_mouse_up("left", (event, cx) => {
        if (this.tabDrag && tabs.length) this.finishTabDrag(tabs.at(-1), asLast(event), cx);
      });
  },

  panelToggle(panel) {
    return this.simple("panel-toggle", Icon("mods/better-sidebar-refined/icons/panel-right.svg", 15),
      panel.hidden ? "Show right sidebar" : "Hide right sidebar", () => run("layout.toggle", { id: panel.id }));
  },

  renderPanelHeader(t) {
    const panel = find(layout(), this.config().panel ?? "panel");
    if (this.config().refinedChrome) {
      return h_flex().id("right-sidebar-header").size_full().min_w(0).px(SPACE.row)
        .gap(SPACE.small).items_center().bg(t.chrome)
        .on_size_change((size, cx) => {
          const width = size.width / (settings().zoom || 1);
          if (this.width !== width) { this.width = width; cx.notify(); }
        })
        .on_mouse_up("left", (_event, cx) => this.finishActionDrag(cx))
        .on_mouse_down_out((_event, cx) => this.cancelDrags(cx))
        .child(this.renderToolbar(t, true))
        .child(div().flex_1().min_w(0))
        .when(Boolean(panel), el => el.child(this.panelToggle(panel)));
    }
    return v_flex().id("right-sidebar-header").size_full().min_w(0).bg(t.chrome)
      .on_size_change((size, cx) => {
        if (this.width !== size.width) { this.width = size.width; cx.notify(); }
      })
      .on_mouse_up("left", (_event, cx) => this.finishActionDrag(cx))
      .on_mouse_down_out((_event, cx) => this.cancelDrags(cx))
      .child(h_flex().h(46).px(10).items_center().justify_end().flex_none()
        .when(Boolean(panel), el => el.child(this.panelToggle(panel))))
      .child(h_flex().h(36).px(8).items_center().min_w(0).flex_none()
        .child(this.renderToolbar(t, true)));
  },

  renderToolbar(t, panel = false) {
    const { visible, overflow } = this.toolbar();
    const toolbar = h_flex()
      .id("action-toolbar")
      .h(TAB_HEIGHT)
      .gap(this.config().refinedChrome ? SPACE.small : TAB_GAP)
      .items_center()
      .flex_none()
      .on_mouse_move((event, cx) => {
        const drag = this.actionDrag();
        if (!drag || contains(drag.target?.bounds, event.position ?? drag.point)) return;
        this.moveActionDrag(event, cx, {
          kind: "toolbar",
          id: visible.at(-1)?.id ?? null,
          after: true,
          bounds: event.bounds,
        });
      })
      .on_hover((hovered, cx) => {
        if (!hovered && this.actionDrag()?.target) this.moveActionDrag({}, cx, null);
      });
    let group;
    for (const entry of visible) {
      if (group !== undefined && entry.group !== group)
        toolbar.child(div().w(1).h(16).mx(4).bg(t.border));
      group = entry.group;
      toolbar.child(this.actionButton(entry));
    }
    return toolbar
      .when(!panel || overflow.length > 0 || Boolean(this.actionDrag()?.active), el => el.child(this.moreButton(overflow, t)));
  },

  // The ⋮: lists hidden actions, and takes a dragged action to hide it.
  moreButton(overflow, t) {
    const drag = this.actionDrag();
    return this.simple(
      "actions-more",
      Icon("more-vertical", 16),
      "More actions · drop a toolbar action here to hide it",
      () => this.openActions(overflow),
    )
      .when(drag?.active && drag.target?.kind === "overflow", (el) =>
        el.bg(t.selected).border(1).border_color(t.accent),
      )
      .on_mouse_down("left", (event, cx) => {
        cx.stop_propagation();
        this.moreBounds = event.bounds ?? this.moreBounds;
      })
      .on_mouse_move((event, cx) => {
        this.moreBounds = event.bounds ?? this.moreBounds;
        this.moveActionDrag(event, cx, { kind: "overflow", bounds: event.bounds });
      })
      .on_mouse_up("left", (_event, cx) => {
        cx.stop_propagation();
        this.finishActionDrag(cx);
      });
  },

  // Windows and Linux draw their own window controls.
  windowButtons() {
    const w = window();
    const windows = w.platform === "windows";
    return [
      this.simple("minimize", windows ? Icon("win-min", 16) : "−", "Minimize", () =>
        run("window.minimize"),
      ),
      this.simple(
        "maximize",
        windows ? Icon(w.maximized ? "win-restore" : "win-max", 16) : "□",
        "Maximize",
        () => run("window.maximize"),
      ),
      this.simple("close-window", Icon("close", 13), "Close window", () => run("window.close")),
    ];
  },
};
