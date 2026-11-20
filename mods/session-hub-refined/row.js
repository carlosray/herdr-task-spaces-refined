import { div } from 'gpui-kit';
import { h_flex, v_flex } from 'gpui-base';

export const SESSION_COMPACT_HEIGHT = 32;

export function sessionCaption(title, subtitle, theme, foreground = theme.foreground, inline = false, contextWidth = 120) {
  if (inline) return h_flex().flex_1().min_w(0).gap(8).items_center()
    .child(div().min_w(0).flex_1().truncate().text_size(13).text_color(foreground).tooltip(title).child(title))
    .when(Boolean(subtitle), el => el.child(div().min_w(0).max_w(contextWidth).truncate()
      .text_size(11).text_color(theme.muted).tooltip(subtitle).child(subtitle)));
  return v_flex().flex_1().min_w(0).gap(2)
    .child(div().min_w(0).truncate().text_size(13).text_color(foreground).child(title))
    .when(Boolean(subtitle), el => el.child(div().min_w(0).truncate()
      .text_size(11).text_color(theme.muted).tooltip(subtitle).child(subtitle)));
}

export function sessionContext(folder, task, checkout) {
  const path = folder?.replace(/^\/(?:Users|home)\/[^/]+(?=\/|$)/, '~');
  const basename = path?.replace(/\/+$/, '').split('/').at(-1);
  return [path, task === basename ? null : task, checkout === basename ? null : checkout].filter(Boolean).join(' › ');
}

// Personal directory accents use fixed hues mixed into the current theme surface.
// Keys are host-local repository identities; neither checkout ownership nor status changes.
export const DIRECTORY_TINTS = [
  ['blue','Blue','#658cc4'],['teal','Teal','#58a6a1'],['sage','Sage','#83a18a'],
  ['olive','Olive','#a0a579'],['sand','Sand','#b7a080'],['apricot','Apricot','#c99a7c'],
  ['rose','Rose','#bf8f9c'],['mauve','Mauve','#aa8fb9'],['lavender','Lavender','#9296c5'],['slate','Slate','#8a9aa9'],
];
export function directoryColorKey(machine,folder) {return JSON.stringify([machine||'local',folder?.replace(/\/+$/,'')||'/']);}
function rgba(hex) {
  if (typeof hex !== 'string' || !/^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(hex)) return null;
  let digits=hex.slice(1);
  if(digits.length<=4)digits=[...digits].map(channel=>channel+channel).join('');
  if(digits.length===6)digits+='ff';
  return [0,2,4,6].map(i=>parseInt(digits.slice(i,i+2),16));
}
function composite(top,bottom) {
  if(!top)return bottom;
  const alpha=top[3]/255;
  return bottom.map((channel,i)=>channel+(top[i]-channel)*alpha);
}
export function directoryTone(machine, folder, t, surface = t.chrome, colors = {}) {
  const choice=colors[directoryColorKey(machine,folder)];
  const tint=rgba(DIRECTORY_TINTS.find(c=>c[0]===choice)?.[2]);
  if(!tint)return null;
  const background=composite(rgba(t.background),[23,25,28]);
  const chrome=composite(rgba(t.chrome),background);
  const target=surface===t.chrome?chrome:composite(rgba(surface),chrome);
  // Preserve the theme's contrast across states. Bright or dark accent tokens
  // can be valid as translucent overlays, but dominate when made opaque.
  const toned=target.map((v,i)=>{const delta=v-chrome[i];return chrome[i]+delta*26/(26+Math.abs(delta));});
  return '#'+toned.map((v,i)=>Math.round(v*.89+tint[i]*.11).toString(16).padStart(2,'0')).join('');
}
