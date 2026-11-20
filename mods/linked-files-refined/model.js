// Pure code-location mapping, shared byte-for-byte with stock-based viewers.
export function codeReference(path,start,end=start) {
  if(typeof path!=='string'||!path||path.startsWith('/')||path.split('/').includes('..')||/[\x00-\x1f\x7f]/.test(path))throw new Error('A repository-relative text path is required');
  if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start<1||end<1)throw new Error('Select a source line first');
  const a=Math.min(start,end),b=Math.max(start,end);
  return `${path}:${a}${a===b?'':`-${b}`}`;
}
export function selectedLines(text,range) {
  const a=Math.max(0,Math.min(range.start,range.end,text.length));
  const b=Math.max(a,Math.min(Math.max(range.start,range.end),text.length));
  const line=offset=>text.slice(0,offset).split('\n').length;
  return [line(a),line(b>a?b-1:b)];
}
export function diffRows(lines) {
  let old=0,next=0;
  const untab=text=>text.replace(/[^\t]*\t/g,s=>s.slice(0,-1).padEnd((s.length-1)-(s.length-1)%4+4));
  return lines.map(line=>{
    const match=/^@@ -(\d+)(?:,\d+)? \+(\d+)/.exec(line);
    if(match){old=+match[1];next=+match[2];return {kind:'@',text:line};}
    const kind=line[0];
    if(kind==='-')return {kind,number:old,oldLine:old++,newLine:null,text:untab(line.slice(1))||' '};
    if(kind==='+')return {kind,number:next,oldLine:null,newLine:next++,text:untab(line.slice(1))||' '};
    if(kind===' '){const row={kind,number:next,oldLine:old++,newLine:next++,text:untab(line.slice(1))||' '};return row;}
    return {kind:'',text:line};
  });
}
/** Map inclusive 1-based display rows (e.g. selectedLines(diffText, range))
 * to source coordinates. Hunk headers/metadata do not count as source lines.
 * Mixed deletion/addition selections prefer current-file lines; deleted-only
 * selections use old-file lines. Null means no selectable source line.
 * displayStart/displayEnd retain the normalized original display selection. */
export function diffSelection(rows,range) {
  if(!Array.isArray(rows)||!Array.isArray(range)||range.length!==2||!range.every(n=>Number.isSafeInteger(n)&&n>0))throw new Error('Select a valid display line range');
  const displayStart=Math.min(...range),displayEnd=Math.max(...range);
  const selected=rows.slice(displayStart-1,displayEnd);
  const valid=n=>Number.isSafeInteger(n)&&n>0;
  const current=selected.filter(row=>valid(row.newLine));
  const side=current.length?'new':'old';
  const source=current.length?current:selected.filter(row=>valid(row.oldLine));
  if(!source.length)return null;
  const key=side==='new'?'newLine':'oldLine';
  return {start:source[0][key],end:source[source.length-1][key],side,displayStart,displayEnd};
}
export const eligibleAgents=(list,space)=>list.filter(a=>a.space===space);
