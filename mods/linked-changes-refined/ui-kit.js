import { div } from "gpui-kit";
import { h_flex } from "gpui-base";

export const TYPE = Object.freeze({ micro: 10, meta: 11, control: 12, body: 13, title: 15 });
export const HEIGHT = Object.freeze({ mini: 20, control: 28, header: 32, row: 32, rowTwo: 44, band: 44, footer: 28 });
export const RADIUS = Object.freeze({ inline: 4, control: 6, surface: 8, card: 10 });
export const SPACE = Object.freeze({ small: 4, icon: 6, row: 8, card: 12, section: 16 });
export const ICON_SIZE = Object.freeze({ mini: 12, control: 14, program: 16 });

export function controlState(element, t, { selected = false, disabled = false } = {}) {
  if (disabled) return element.opacity(0.45);
  return element
    .when(selected, el => el.bg(t.selected))
    .when(!selected, el => el.hover(style => style.bg(t.hover)))
    .active(style => style.bg(t.selected));
}

export function cardHeader(t) {
  return h_flex().h(HEIGHT.header).flex_none().px(SPACE.card).gap(SPACE.row)
    .items_center().text_size(TYPE.control).text_color(t.foreground)
    .border_b(1).border_color(t.border);
}

export function iconControl(t, label, icon) {
  return controlState(div().size(HEIGHT.control).flex_none().flex()
    .items_center().justify_center().rounded(RADIUS.control)
    .text_color(t.muted).cursor_pointer().accessibility_label(label).tooltip(label).child(icon), t);
}
