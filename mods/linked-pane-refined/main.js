// A pane's header, for layouts that frame their panes:
//   { "tab": "active", "pane": { "header": { "content": { "mod": "pane" } } } }
// Shows the program's icon (the app's program table), the agent's name or
// the terminal's title, the folder, and the agent's status; buttons split, zoom and close
// this pane. Props from the app: { pane, terminal }. Click: focus the pane.

import { View, div, svg, image } from "gpui-kit";
import { h_flex } from "gpui-base";
import { spaces, panes, props, run, theme, home, layout, keys } from "herdr";
import { offerWorktreeClose } from "./close-route.js";
import { TYPE, HEIGHT, RADIUS, SPACE, ICON_SIZE, cardHeader, iconControl } from "./ui-kit.js";

// Match the first visible tab frame, including the active child of a stack.
function paneFrame(node) {
  if (!node || node.hidden) return null;
  if (node.content?.tab && node.content.pane) return node.content.pane;
  let children = node.children ?? [];
  if (node.type === "stack") {
    const visible = children.filter(child => !child.hidden);
    children = [visible.find(child => child.id === node.active) ?? visible[0]];
  }
  for (const child of children) {
    const frame = paneFrame(child);
    if (frame) return frame;
  }
  return null;
}

function icon(p, size, color) {
  if (!p?.icon) return null;
  return p.tint ? svg(p.icon).size(size).flex_none().text_color(color) : image(p.icon).w(size).h(size).flex_none();
}

function folder(cwd) {
  if (!cwd) return "";
  const h = home();
  return cwd === h ? "~" : cwd.startsWith(h + "/") ? "~" + cwd.slice(h.length) : cwd;
}

export default class Pane extends View {
  init() { this.hovered = false; }

  me() {
    return panes().find((p) => p.pane === props()?.pane);
  }

  button(t, id, icon, label, command, args, bindings) {
    const action = command === "pane.split" ? `${command}:${args.direction}` : command;
    const shortcut = bindings.find(b => b.section === "global" && b.action === action)?.keys;
    return iconControl(t, label, svg(`mods/linked-pane-refined/${icon}.svg`).size(ICON_SIZE.control)).id(id)
      .when(Boolean(shortcut), el => el.tooltip(`${label} (${shortcut})`))
      .on_click((_e, cx) => {
        cx.stop_propagation();
        if (command === "pane.close") {
          const pane = panes().find((row) => row.pane === args.pane);
          const space = spaces().find((row) => row.tabs.some((tab) => tab.id === pane?.tab));
          if (space?.tabs.length === 1 && space.tabs[0].panes === 1 && offerWorktreeClose(space.id)) return;
        }
        run(command, args);
      });
  }

  render() {
    const t = theme();
    const p = this.me();
    if (!p) return div();
    const fileTitle = ["linked-files","linked-changes"].includes(p.mod) ? spaces().flatMap(s=>s.tabs??[]).find(tab=>tab.id===p.tab)?.name : null;
    const name = fileTitle || ((p.program?.agent || p.program?.shell) && p.program.name) || p.title || p.program?.name || "shell";
    const pic = icon(p.program, ICON_SIZE.program, t.muted);
    const st = p.status;
    const pane = p.pane;
    const bottom = paneFrame(layout())?.header?.position === "bottom";
    const bindings = this.hovered ? keys() : [];
    const path = folder(p.cwd);
    return cardHeader(t)
      .id(`pane-head-${pane}`)
      .w_full()
      .gap(SPACE.icon)
      .bg(t.background)
      .when(bottom, el => el.border_b(0).border_t(1))
      .on_hover((hovered, cx) => { this.hovered = hovered; cx.notify(); })
      .on_click(() => run("pane.focus", { pane }))
      .when(Boolean(pic), (el) => el.child(pic))
      .child(div().min_w(0).max_w(260).truncate().font_medium().tooltip(name).child(name))
      .child(div().flex_1().min_w(0).truncate().text_ellipsis_start().text_size(TYPE.meta).text_color(t.muted)
        .when(Boolean(path), el => el.tooltip(p.cwd)).child(path))
      .when(st === "working", el => el.child(div().size(ICON_SIZE.mini).flex_none()
        .text_color(t.working).accessibility_label("Working").tooltip("Working")
        .child(svg("mods/workspace-chrome/spinner.svg").size(ICON_SIZE.mini).spin(900))))
      .when(st === "blocked", el => el.child(div().flex_none().px(SPACE.icon).h(HEIGHT.mini).flex().items_center()
        .rounded(RADIUS.inline).bg(t.blocked + "26").text_size(TYPE.micro).font_medium().text_color(t.blocked).child("Needs input")))
      .when(st === "done", el => el.child(div().size(SPACE.icon).flex_none().rounded(RADIUS.inline).bg(t.done)
        .accessibility_label("Finished unread").tooltip("Finished unread")))
      .when(this.hovered, el => el.child(h_flex().flex_none().items_center()
        .child(this.button(t, `ph-r-${pane}`, "split-right", "Split right", "pane.split", { direction: "right", pane }, bindings))
        .child(this.button(t, `ph-d-${pane}`, "split-down", "Split down", "pane.split", { direction: "down", pane }, bindings))
        .child(this.button(t, `ph-z-${pane}`, p.zoomed ? "unzoom" : "zoom", p.zoomed ? "Unzoom pane" : "Zoom pane", "pane.zoom", { pane }, bindings))
        .child(this.button(t, `ph-x-${pane}`, "close", "Close pane", "pane.close", { pane }, bindings))));
  }
}
