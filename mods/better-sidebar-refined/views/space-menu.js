import { div } from "gpui-kit";
import { v_flex } from "gpui-base";
import { props, theme, closeOverlay, openOverlay, run, exec } from "herdr";
import { setDirectoryTint, directoryTint, markSessionUnread } from "./ui.js";
import { DIRECTORY_TINTS } from "./session-hub/row.js";
import { offerWorktreeClose } from "./close-route.js";
export const TREE_STATE = "better-sidebar.tree";
const item=(p,id,label,action)=>div().id(id).h(31).px(10).flex().items_center().rounded(5)
  .hover(s=>s.bg(theme().hover)).on_click((_e,cx)=>{action(cx);closeOverlay(p.overlay);}).child(label);
const menu=()=>v_flex().p(5).bg(theme().popover).text_color(theme().foreground).text_size(12.5);
export class SpaceMenu {
  init() { this.p = props(); }
  render() {
    const p=this.p;
    return menu()
      .child(item(p,'manage-task','Task & worktrees…',()=>openOverlay({mod:'task-spaces-refined',kind:'popup',width:520,height:0.85,props:{action:'manage',space:p.taskSpace??p.space}})))
      .when(!p.virtual,e=>e.child(item(p,'copy-space-id','Copy Space ID',cx=>cx.write_to_clipboard(p.space)))
        .child(item(p,'space-rename','Rename…',()=>run('space.rename',{id:p.taskSpace??p.space})))
        .when(!p.hasChildren,m=>m.child(item(p,'space-close','Close Space…',()=>{if(!offerWorktreeClose(p.space))run('space.close',{id:p.space});}))))
      .when(p.hasChildren,e=>e.child(div().px(10).py(5).text_color(theme().dim).child('Worktree sessions are still open')))
      .when(Boolean(p.virtual),e=>e.child(div().px(10).py(5).text_color(theme().dim).child('Visual group · no terminal')));
  }
}
export class SessionMenu {
  init() { this.p=props(); }
  render() {
    const p=this.p;
    return menu()
      .when(p.status==='idle',e=>e.child(item(p,'session-unread','Mark as unread',()=>markSessionUnread(p.terminal,p.active,p.native??p.generation))))
      .when(Boolean(p.manager), e => e.child(item(p, 'open-manager', `Go to manager · ${p.managerName ?? p.manager}`,
        () => run('pane.focus', { terminal: p.manager }))))
      .child(item(p,'copy-terminal-id','Copy terminal ID',cx=>cx.write_to_clipboard(p.terminal)))
      .when(Boolean(p.native),e=>e.child(item(p,'copy-native-session-id','Copy native session ID',cx=>cx.write_to_clipboard(p.native))))
      .when(Boolean(p.space),e=>e.child(item(p,'copy-space-id','Copy Space ID',cx=>cx.write_to_clipboard(p.space))));
  }
}

export class DirectoryMenu {
  init(){this.p=props();}
  render(){
    const p=this.p,t=theme();
    return menu().child(div().px(10).py(5).text_color(t.dim).child(p.name+' · '+(p.machine==='ivm'?'IVM':p.machine||'Local')))
      .child(item(p,'directory-new-task','New task…',()=>openOverlay({mod:'task-spaces-refined',kind:'popup',width:540,height:0.85,props:{entry:'repository',action:'create',machine:p.machine??null,folder:p.folder}})))
      .child(item(p,'directory-close-settings','Worktree close settings…',cx=>cx.spawn(async ()=>{
        const result=await exec('herdr-task',['resolve-directory','--folder',p.folder],{on:p.machine??null});
        const value=JSON.parse(result.stdout);
        if(result.code || !value.repo)return;
        openOverlay({mod:'worktree-close-refined',kind:'popup',width:530,height:340,
          props:{mode:'settings',machine:p.machine??null,repo:value.repo,display:value.folder}});
      })))
      .child(item(p,'directory-color-reset','No color',()=>setDirectoryTint(p.machine,p.folder,null)))
      .children(DIRECTORY_TINTS.map(([id,label,fill])=>item(p,'directory-color-'+id,label,()=>setDirectoryTint(p.machine,p.folder,id)).border_l(3).border_color(fill)));
  }
}
