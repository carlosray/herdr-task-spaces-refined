import { exec, appHome, setShared, notify } from 'herdr';
import { spaceContext } from './tree-model.js';
const trim=p=>(p??'').replace(/\/+$/,'')||'/';
export class SessionDrag {
  frame(view) { if(this.current&&Date.now()-this.current.at>15000)this.current=null;this.view=view;this.spaces=new Map((view.spaceList??[]).map(s=>[s.id,s])); }
  suppressClick(){return Date.now()<(this.ignoreUntil??0);}
  get tracking(){return Boolean(this.current?.active&&!this.current.invalid);}
  cancel(cx){
    const tracking=this.tracking;
    this.current=null;
    if(tracking)cx?.notify();
  }
  begin(terminal,tab,space,event,cx) {
    if(this.busy||!this.view)return;
    const panes=this.view.paneList.filter(p=>p.tab===tab&&p.terminal);
    const s=this.spaces.get(space),t=this.view.terminalByAddress.get(terminal);
    const cwd=panes[0]?.cwd||t?.foreground?.cwd||t?.cwd||s?.folder;
    if(!s||!cwd)return;
    cx.stop_propagation();this.error=null;this.failed=null;
    this.current={terminal,tab,space,cwd,machine:s.machine??null,start:event.position,at:Date.now(),active:false,target:null,invalid:panes.length!==1?(panes.length?'This tab contains several terminals':'No live terminal in this tab'):null};
  }
  arm(event,cx) {
    const d=this.current;if(!d)return false;
    if(Date.now()-d.at>15000){this.cancel(cx);return false;}
    if(d.active)return this.tracking;
    const point=event.position??d.start;
    if(Math.hypot(point.x-d.start.x,point.y-d.start.y)<6)return false;
    d.active=true;
    if(d.invalid){notify({title:d.invalid,body:'Drag a tab with one live terminal.',level:'info'});return false;}
    cx.notify();
    return true;
  }
  over(space,event,cx) {
    if(!this.arm(event,cx))return;
    const d=this.current;
    const target=this.spaces.get(space);
    const targetFolder=target?spaceContext(target,null,this.view.hosts??{}).folder:null;
    const allowed=target&&target.id!==d.space&&(target.machine??null)===d.machine&&trim(targetFolder)===trim(d.cwd);
    const next=allowed?space:null;
    if(d.target!==next){d.target=next;cx.notify();}
  }
  leave(space,cx){if(this.current?.target===space){this.current.target=null;cx.notify();}}
  drop(space,event,cx) {
    if(!this.tracking)return false;
    cx.stop_propagation();
    // Resolve the row under mouse-up even if there hasn't been a paint since
    // the threshold move. The last highlighted row can already be out of view.
    this.over(space,event,cx);
    this.finish(cx);
    return true;
  }
  finish(cx,target=this.current?.target) {
    const d=this.current;this.current=null;
    if(!d?.active)return;
    this.ignoreUntil=Date.now()+400;
    if(target)this.submit({source:d.space,target,tab:d.tab,terminal:d.terminal},cx);
    else cx.notify();
  }
  retry(cx){if(this.failed)this.submit(this.failed,cx);}
  submit(request,cx) {
    if(this.busy)return;this.busy=true;this.error=null;this.failed=request;
    cx.notify();
    cx.spawn(async cx=>{
      try {
        const args=[appHome()+'/mods/better-sidebar-refined/rehome.py',...Object.entries(request).flatMap(([k,v])=>['--'+k,v])];
        const result=await exec('python3',args,{on:null,timeout:90000});
        let body;try{body=JSON.parse(result.stdout);}catch{throw new Error('Move response unavailable. Retry verification of the same tab.');}
        if(result.code!==0||body.error)throw new Error(body.error||'Move refused');
        this.failed=null;setShared('task-spaces.open',{id:request.target,tab:request.tab});
      }catch(e){this.error=e.message;notify({title:'Session move needs attention',body:e.message,level:'warning'});}
      this.busy=false;cx.notify();
    });
  }
}
