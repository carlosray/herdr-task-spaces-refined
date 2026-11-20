// Canonical personal Herdr controls. Vendored into each mod's module sandbox.
import { div, svg } from 'gpui-kit';
import { h_flex, Input } from 'gpui-base';
import { theme } from 'herdr';
import { TYPE, HEIGHT, RADIUS, SPACE, ICON_SIZE, controlState, iconControl } from './ui-kit.js';

export const UI = {
  text: {meta:TYPE.meta,ui:TYPE.control,title:TYPE.body,dialog:TYPE.title},
  radius: {control:RADIUS.control,dialog:RADIUS.surface},
  height: {compact:HEIGHT.control,dialog:HEIGHT.header},
};

export function button(id,label,onClick,options={}) {
  const t=theme(),variant=options.variant ?? (options.solid?'primary':'secondary');
  const primary=variant==='primary',ghost=variant==='ghost',danger=options.danger||variant==='danger';
  const color=options.disabled?t.dim:primary?t.solid_foreground:danger?t.ansi1:ghost?t.muted:t.foreground;
  const el=h_flex().id(id).h(options.height??HEIGHT.control).px(SPACE.card).gap(SPACE.icon).flex_none()
    .items_center().justify_center().rounded(RADIUS.control).text_size(TYPE.control)
    .text_color(color)
    .when(primary&&!options.disabled,e=>e.bg(t.solid).font_medium())
    .when(!primary&&!ghost&&!options.disabled,e=>e.border_1().border_color(t.input).bg(t.raised))
    .accessibility_label(label??id)
    .when(Boolean(options.icon),e=>e.child(options.icon))
    .when(Boolean(label),e=>e.child(label));
  if(options.disabled)return el.opacity(0.45).tooltip(options.reason||'Unavailable');
  el.cursor_pointer().on_click((_event,cx)=>onClick(cx));
  if(primary)return el.hover(s=>s.opacity(0.88)).active(s=>s.opacity(0.88));
  const selected=Boolean(options.selected);
  return controlState(el,t,{selected})
    .when(selected,e=>e.text_color(t.foreground))
    .when(!selected&&ghost&&!danger,e=>e.hover(s=>s.bg(t.hover).text_color(t.foreground)));
}

export function ActionButton({id,label,onClick,icon,primary,variant,disabled,disabledReason,small=false,...rest}) {
  return button(id,label,onClick,{...rest,icon,solid:primary,variant,disabled,reason:disabledReason,
    height:small?UI.height.compact:UI.height.dialog});
}

export function sectionTab({id,label,count,active,onClick}) {
  const t=theme();
  return h_flex().id(id).h(UI.height.dialog).px(SPACE.card).gap(SPACE.small).flex_none().items_center()
    .border_b(2).border_color(active?t.accent:'#00000000')
    .text_color(active?t.foreground:t.muted).text_size(UI.text.ui)
    .role('tab').aria_selected(Boolean(active)).cursor_pointer().when(!active,el=>el.hover(s=>s.bg(t.hover)))
    .on_click((_event,cx)=>onClick(cx)).child(label)
    .when(count!==undefined&&count!==null,el=>el.child(div().text_size(UI.text.meta).text_color(t.muted).child(String(count))));
}

const focusedInputs=new WeakSet();

export function trackInputFocus(state) {
  state.on('focus',(_event,cx)=>{focusedInputs.add(state);cx.notify();});
  state.on('blur',(_event,cx)=>{focusedInputs.delete(state);cx.notify();});
}

export function dialogInput(state,id,{label,disabled=false,focused=focusedInputs.has(state),invalid=false}={}) {
  const t=theme();
  return Input.new(state).id(id).w_full().h(HEIGHT.header).px(SPACE.row)
    .rounded(RADIUS.control).border_1().bg(t.background).text_size(TYPE.control).text_color(t.foreground)
    .border_color(invalid?t.ansi1:focused&&!disabled?t.accent:t.input).disabled(disabled)
    .when(Boolean(label),el=>el.accessibility_label(label));
}

export function dialogIcon(name,size=ICON_SIZE.control) {
  return svg(`mods/agent-launcher-refined/${name}.svg`).size(size).flex_none();
}

export function dialogIconButton(t,id,label,name,onClick,disabled=false) {
  const glyph=dialogIcon(name);
  if(disabled)return div().id(id).size(HEIGHT.control).flex_none().flex()
    .items_center().justify_center().rounded(RADIUS.control).text_color(t.dim).opacity(0.45)
    .accessibility_label(label).tooltip('Unavailable').child(glyph);
  return iconControl(t,label,glyph).id(id).hover(s=>s.bg(t.hover).text_color(t.foreground))
    .on_click((_event,cx)=>onClick(cx));
}

export function dialogHeader(title,close,back) {
  const t=theme();
  return h_flex().h(HEIGHT.control).flex_none().gap(SPACE.icon).items_center()
    .when(Boolean(back),el=>el.child(dialogIconButton(t,'dialog-back','Back','chevron-left',back)))
    .child(div().flex_1().min_w(0).truncate().text_size(TYPE.control).font_semibold().child(title))
    .child(dialogIconButton(t,'dialog-close','Close dialog','close',close));
}

export function loadingSpinner(t) {
  return dialogIcon('spinner',ICON_SIZE.mini).text_color(t.working).spin(900);
}
