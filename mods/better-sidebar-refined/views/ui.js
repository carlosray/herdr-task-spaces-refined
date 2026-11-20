// The design kit: Herdr's own conventions, measured from its shipped mods, as
// tokens and small components. UI only: values in, callbacks out, no Git or
// Herdr commands. Components return ordinary elements, so callers can chain.
import { div, svg } from "gpui-kit";
import { h_flex, v_flex, Popover, Scrollbar } from "gpui-base";
import { theme, shared, setShared } from "herdr";
import { DIRECTORY_TINTS, directoryColorKey, directoryTone } from "./session-hub/row.js";

// Plain px: Herdr scales a mod's sizes by zoom itself.
export const TEXT = {
  badge: 10,
  avatar: 10.5,
  caption: 11,
  label: 11.5,
  small: 12,
  menu: 12.8,
  body: 13,
};
const RADIUS = { small: 4, control: 6, row: 7 };
export const SIZE = { group: 30, menu: 31, row: 28, icon: 26, iconSmall: 20 };
export const ROW_END = { padding: 8, cardInset: 4, gap: 5, status: 20, time: 26 };
export const REVEAL_CURRENT = "better-sidebar.reveal-current";

export function SidebarScroll(id, content) {
  return v_flex().relative().flex_1().min_h(0)
    .child(content.id(id).absolute().inset_0().overflow_y_scroll())
    .child(Scrollbar.vertical(id).absolute().inset_0().mode("scrolling"));
}

export const Icon = (name, size = 14) =>
  svg(`mods/better-sidebar-refined/icons/${name}.svg`).size(size).flex_none();

const AVATAR_COLORS = {
  ansi6: "#22a99a", ansi3: "#e3814f", ansi4: "#5b8def",
  ansi5: "#8b7cf6", ansi2: "#3fae6a", ansi1: "#d9649a",
};

export function SpaceAvatar(space, t, colors) {
  const color = colors?.[space.id] ?? "ansi6";
  const fill = color.startsWith("#") ? color : (AVATAR_COLORS[color] ?? t[color]);
  return h_flex().size(18).flex_none().rounded(5).bg(fill).items_center().justify_center()
    .text_size(TEXT.avatar).font_bold().text_color("#ffffff")
    .child([...space.name][0]?.toUpperCase() ?? "?");
}

export function Badge(text, t = theme()) {
  return div()
    .flex_none()
    .px(5)
    .py(1)
    .rounded(RADIUS.small)
    .border_1()
    .border_color(t.border)
    .text_size(TEXT.badge)
    .text_color(t.muted)
    .child(String(text));
}

export function IconButton({ id, icon, label, onClick, iconSize = 15, muted = false, t = theme() }) {
  return div()
    .id(id)
    .size(SIZE.icon)
    .flex_none()
    .flex()
    .items_center()
    .justify_center()
    .rounded(RADIUS.control)
    .text_color(muted ? t.dim : t.foreground)
    .cursor_pointer()
    .accessibility_label(label)
    .tooltip(label)
    .hover((s) => s.bg(t.hover).text_color(t.foreground))
    .when(Boolean(onClick), (el) =>
      el.on_mouse_down("left",(_e,cx)=>cx.stop_propagation())
        .on_mouse_up("left",(_e,cx)=>cx.stop_propagation())
        .on_click((event, cx) => {
          cx.stop_propagation();
          onClick(cx, event);
        }),
    )
    .child(Icon(icon, iconSize));
}

// A section heading in a list. Its chevron and click fold the section.
export function GroupHeader({
  id,
  label,
  count,
  labelColor,
  folded = false,
  divided = false,
  action,
  onClick,
}) {
  const t = theme();
  return h_flex()
    .id(id)
    .h(SIZE.group)
    .flex_none()
    .px(8)
    .gap(6)
    .items_center()
    .text_size(TEXT.caption)
    .text_color(t.muted)
    .cursor_pointer()
    .when(divided, (el) => el.mt(4).border_t(1).border_color(t.border))
    .hover((s) => s.text_color(t.foreground))
    .on_click((_e, cx) => onClick(cx))
    .child(Icon(folded ? "chevron-right" : "chevron-down", 12).text_color(t.dim))
    .child(
      div()
        .min_w(0)
        .truncate()
        .font_medium()
        .text_color(labelColor ?? t.muted)
        .child(label),
    )
    .child(Badge(count))
    .child(div().flex_1())
    .when(Boolean(action), (el) => el.child(action));
}

// One step of a tree's line, in front of a nested row: "│" carries on past it,
// "├" branches to it, "└" ends at it, "" leaves the column blank. `mid` is how far
// down the row its title sits, where the branch turns.
export function Rail(kind, mid = 15, t = theme()) {
  const line = () => div().absolute().left(17.5).top(0).border_color(t.input);
  return div()
    .relative()
    .w(24)
    .flex_none()
    .self_stretch()
    .when(kind === "│" || kind === "├", (el) => el.child(line().bottom(0).border_l(1.5)))
    .when(kind === "├" || kind === "└", (el) =>
      el.child(line().h(mid).w(7).border_l(1.5).border_b(1.5).rounded_bl(6)),
    );
}

// A popup anchored to its trigger.
export function Menu({ id, open, onOpenChange, focus, trigger, children, width = 220 }) {
  const t = theme();
  const body = v_flex()
    .id(`${id}-body`)
    .w(width)
    .p(5)
    .gap(1)
    .rounded(RADIUS.row)
    .border_1()
    .border_color(t.border)
    .bg(t.popover)
    .text_color(t.foreground)
    .track_focus(focus)
    .on_key_down((event, cx) => {
      if (event.key !== "escape") return;
      cx.stop_propagation();
      onOpenChange(false, cx);
    })
    .children(children);
  return Popover.new(id)
    .open(open)
    .anchor("top_right")
    .track_focus(focus)
    .on_open_change((value, cx) => onOpenChange(value, cx))
    .trigger(trigger)
    .when(open, (el) => el.content(body));
}

export function MenuLabel(text) {
  const t = theme();
  return div()
    .px(8)
    .pt(6)
    .pb(3)
    .text_size(TEXT.caption)
    .font_medium()
    .text_color(t.dim)
    .child(text);
}

export function MenuOption({ id, icon, iconElement, indent = 0, label, selected, onClick }) {
  const t = theme();
  return h_flex()
    .id(id)
    .h(SIZE.menu)
    .flex_none()
    .px(8)
    .when(indent > 0, el => el.pl(8 + indent))
    .gap(9)
    .items_center()
    .rounded(RADIUS.row)
    .cursor_pointer()
    .text_size(TEXT.menu)
    .role("menu_item_radio")
    .aria_selected(Boolean(selected))
    .when(!selected, el => el.hover(s => s.bg(t.hover)))
    .on_click((_e, cx) => onClick(cx))
    .child(iconElement ?? Icon(icon, 14).text_color(t.muted))
    .child(div().flex_1().min_w(0).truncate().tooltip(label).child(label))
    .when(selected, (el) => el.child(Icon("check", 14)));
}

export function setDirectoryTint(machine,folder,tint) {
  const colors={...(shared('better-sidebar.directory-colors')??{})},key=directoryColorKey(machine,folder);
  if(DIRECTORY_TINTS.some(c=>c[0]===tint))colors[key]=tint;else delete colors[key];
  setShared('better-sidebar.directory-colors',colors);
}
export function directoryTint(machine, folder, t = theme(), surface = t.chrome, colors = shared('better-sidebar.directory-colors') ?? {}) {
  return directoryTone(machine, folder, t, surface, colors);
}
export function markSessionUnread(address,active,native) {
  setShared('better-sidebar.unread',{...(shared('better-sidebar.unread')??{}),[address]:{waitLeave:Boolean(active),native:native??null}});
}
export function openSessionRead(address) {
  const marks=shared('better-sidebar.unread')??{};if(!marks[address])return;
  const next={...marks};delete next[address];setShared('better-sidebar.unread',next);
}
export function attentionRows(list,current,terminalList) {
  const marks=shared('better-sidebar.unread')??{},next={...marks};let changed=false;
  if(terminalList)for(const [address,mark] of Object.entries(marks)){
    const terminal=terminalList.find(t=>t.address===address),identity=terminal?.labels?.['native.session']??terminal?.created_ms??null;
    if(terminal&&(terminal.state!=='live'||(mark.native!=null&&identity!==mark.native))){delete next[address];changed=true;}
  }
  const rows=list.map(a=>{
    let mark=next[a.address];if(!mark)return a;
    if(a.status!=='idle'){delete next[a.address];changed=true;return a;}
    if(current&&current!==a.address&&mark.waitLeave){mark=next[a.address]={...mark,waitLeave:false};changed=true;}
    else if(current===a.address&&!mark.waitLeave){delete next[a.address];changed=true;return a;}
    return ['idle','done'].includes(a.status)?{...a,status:'done',manualUnread:true}:a;
  });
  if(changed)setShared('better-sidebar.unread',next);
  return rows;
}
