// Compact row / inline Model-button structure adapted from Over9k Launcher.
// Copyright (c) 2026 the Over9k authors. MIT; see license-over9k.txt.
import { div } from 'gpui-kit';
import { h_flex } from 'gpui-base';
import { theme } from 'herdr';
import { dialogIcon } from './ui.js';
import { TYPE, HEIGHT, RADIUS, SPACE, ICON_SIZE, controlState } from './ui-kit.js';

export function MenuRow({id,icon,name,hint='',selected=false,onChoose,onModel}) {
  const t=theme();
  const row=h_flex().id(id).h(HEIGHT.control).px(SPACE.row).gap(SPACE.icon).rounded(RADIUS.control).items_center().flex_none()
    .text_color(t.foreground).cursor_pointer().role('list_box_option').aria_selected(selected)
    .on_click((_event,cx)=>onChoose(cx))
    .when(Boolean(icon),el=>el.child(icon))
    .child(div().flex_1().min_w(0).truncate().text_size(TYPE.control).child(name))
    .when(Boolean(onModel),el=>el.child(controlState(h_flex().id(`${id}-more`).h(HEIGHT.mini).px(SPACE.icon).gap(SPACE.small)
      .flex_none().rounded(RADIUS.inline).items_center().border_1().border_color(t.input).text_size(TYPE.meta).text_color(t.muted)
      .cursor_pointer().accessibility_label(`Choose ${name} model`)
      .on_mouse_down('left',(_event,cx)=>cx.stop_propagation())
      .on_click((_event,cx)=>{cx.stop_propagation();onModel(cx);})
      .child('Model').child(dialogIcon('chevron-right',ICON_SIZE.mini)),t)))
    .when(Boolean(hint),el=>el.child(div().flex_none().max_w(100).truncate().text_size(TYPE.meta).text_color(t.muted)
      .tooltip(hint).child(hint)));
  return controlState(row,t,{selected});
}
