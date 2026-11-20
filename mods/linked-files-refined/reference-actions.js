import { nextCommand,checking,openOverlay,notify,readTextFile,appHome } from 'herdr';

export function referenceAction(view,action,cx){
  try{
    const selected=view.codeLocation();
    if(!selected)throw new Error('Click a source line or select text first');
    if(action==='copy-reference'){cx.write_to_clipboard(selected.reference);notify({title:'Code reference copied',level:'success',timeout:1800});}
    else openOverlay({mod:'code-links',kind:'dialog',width:460,height:380,props:selected});
  }catch(e){notify({title:String(e.message??e),level:'warning'});}
}
// Only the native per-copy focus event is consumed here. Custom mod commands
// broadcast to shown copies and must never perform Copy/Insert.
export function referenceFocus(view,cx){
  const id=Date.now().toString(36)+Math.random().toString(36).slice(2);
  view.referenceContext='CodeLinks'+id;view.referenceCopyAction='code_link_copy_'+id;view.referenceInsertAction='code_link_insert_'+id;
  const bind=manifest=>{
    const s=manifest?.settings??{},valid=v=>typeof v==='string'&&(v===''||/^(?:(?:cmd|ctrl|alt|shift)-){0,4}[a-z0-9]$/.test(v));
    const copy=valid(s.shortcut_copy)?s.shortcut_copy:'cmd-alt-p';
    const insert=valid(s.shortcut_insert)?s.shortcut_insert:'cmd-alt-k';
    cx.bind_keys([
      ...(copy?[{keystroke:copy,action:view.referenceCopyAction,context:view.referenceContext}]:[]),
      ...(insert&&insert!==copy?[{keystroke:insert,action:view.referenceInsertAction,context:view.referenceContext}]:[]),
    ]);
  };
  if(checking()){bind({});return;}
  cx.spawn(async cx=>{
    let manifest={};try{manifest=JSON.parse(await readTextFile(`${appHome()}/mods/${view.referenceMod}/mod.json`)??'{}');}catch{}
    bind(manifest);cx.notify();
  });
  cx.spawn(async cx=>{for(;;){if(await nextCommand()==='focus')view.handle.focus();}});
}
