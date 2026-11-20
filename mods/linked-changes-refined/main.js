import { View, div } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, Scrollbar, v_virtual_list, Editor, EditorState } from "gpui-base";
import { spaces, panes, focused, exec, readTextFile, watchFolder, theme, settings, props, run, checking } from "herdr";

function location() {
  const space = spaces().find((s) => s.active), f = focused();
  const pane = f?.pane ? panes().find(p => p.pane === f.pane) : null;
  const on = f?.pane === null ? (f.terminal?.includes("/") ? f.terminal.split("/")[0] : null) : space?.machine ?? null;
  return { cwd: pane?.cwd || f?.cwd || space?.folder, on };
}
const key = () => JSON.stringify(location());
// Reads write nothing under .git (no index refresh or lock, no fsmonitor cookie):
// the folder watch would see it, and every refresh would start the next one.
const READ = ["--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "diff.autoRefreshIndex=false"];
const countLines = (text) => text ? text.split("\n").length - Number(text.endsWith("\n")) : 0;

import { codeReference, diffRows, selectedLines, diffSelection } from "./model.js";
import { referenceAction, referenceFocus } from "./reference-actions.js";
import { TYPE, HEIGHT, RADIUS, SPACE, ICON_SIZE, cardHeader, controlState } from "./ui-kit.js";

export default class Changes extends View {
  init(_props, cx) {
    this.given=props()??_props??{};this.fileOnly=this.given.view==="diff";this.selectedRow=null;
    this.files = []; this.rows = []; this.diffWidth = 0; this.message = ""; this.handle = cx.focus_handle();this.referenceMod="linked-changes";
    const colors=theme();this.diffEditor=EditorState.new({readonly:true,language:"diff",line_numbers:false,folding:false,font_family:settings().font_family,font_size:TYPE.control,value:"",syntax:{keyword:colors.ansi5,string:colors.ansi2,comment:colors.muted,function:colors.ansi4,type:colors.ansi3,number:colors.ansi1,constant:colors.ansi6}});
    referenceFocus(this,cx);
    this.input = InputState.new({ placeholder: "Commit message" });
    this.input.on("change", (_e, cx) => {
      const hadMessage = Boolean(this.message.trim());
      this.message = this.input.value();
      if (hadMessage !== Boolean(this.message.trim())) cx.notify();
    });
    this.input.on("submit", (_e, cx) => this.commit(cx));
    this.input.on("focus", (_e, cx) => { this.typing = true; cx.notify(); });
    this.input.on("blur", (_e, cx) => { this.typing = false; cx.notify(); });
    if(checking())return;
    this.refresh(cx);
    cx.timer.every(10000, (cx) => this.refresh(cx));
  }

  place(){return this.fileOnly?{cwd:this.given.root,on:this.given.on??null}:location();}
  placeKey(){return JSON.stringify(this.place());}
  codeLocation(){
    if(!this.diffEditor||!this.open||this.context!==this.placeKey())return null;
    const display=selectedLines(this.diffEditor.value(),this.diffEditor.selected_range());
    const source=diffSelection(this.rows,display);if(!source)return null;
    return {space:this.given.space??spaces().find(s=>s.active)?.id,reference:codeReference(this.open,source.start,source.end)+(source.side==='old'?" (deleted line; before local changes)":"")};
  }

  watch(root, cx) {
    if (this.on || this.watched === root) return;
    this.watched = root;
    cx.spawn(async (cx) => {
      try {
        while (this.watched === root) {
          await watchFolder(root);
          if (this.watched === root) this.refresh(cx);
        }
      } catch { this.watched = null; }
    });
  }

  refresh(cx) {
    if (this.loading || this.busy) return;
    const { cwd, on } = this.place(), context = this.placeKey();
    if (context !== this.context) {
      this.context = context; this.root = null; this.files = []; this.open = null;
      this.setLines([]); this.message = ""; this.input.set_value(""); this.error = null; this.note = null; this.watched = null; this.closed = false; this.limited = false;
    }
    if (!cwd) return;
    this.loading = true;
    cx.spawn(async (cx) => {
      try {
        const top = await exec("git", ["rev-parse", "--show-toplevel"], { cwd, on });
        if (this.placeKey() !== context) return;
        if (top.code !== 0) { this.root = null; this.files = []; this.setLines([]); this.open = null; this.error = /not a git repository/i.test(top.stderr??"") ? "Open a session in a Git checkout to view changes." : (top.stderr||"Couldn’t open the checkout.").trim(); return; }
        const root = top.stdout.trim(), git = (args) => exec("git", [...READ, ...args], { cwd: root, on });
        const status = await git(["status", "--porcelain=v1", "-z", "--no-renames", "--untracked-files=all"]);
        if (status.code !== 0) throw new Error(status.stderr);
        const head = await git(["rev-parse", "--verify", "HEAD"]);
        const stats = {};
        const results = head.code === 0 ? [await git(["diff", "HEAD", "--numstat", "-z", "--no-renames"])] : [await git(["diff", "--cached", "--numstat", "-z", "--no-renames"]), await git(["diff", "--numstat", "-z", "--no-renames"])];
        for (const result of results) {
          if (result.code !== 0) throw new Error(result.stderr);
          for (const entry of result.stdout.split("\0")) {
            const [a, d, ...parts] = entry.split("\t");
            if (!parts.length) continue;
            const path = parts.join("\t"), old = stats[path] ?? { add: 0, del: 0 };
            stats[path] = { add: old.add + (Number(a) || 0), del: old.del + (Number(d) || 0), binary: a === "-" };
          }
        }
        const files = [];
        const entries = status.stdout.split("\0").filter(Boolean);
        for (const entry of entries.slice(0, 1000)) {
          const xy = entry.slice(0, 2), path = entry.slice(3), fresh = xy === "??";
          const conflict = xy.includes("U") || xy === "AA" || xy === "DD";
          const s = conflict ? "U" : xy.includes("D") ? "D" : fresh || xy.includes("A") ? "A" : "M";
          const stat = stats[path] ?? { add: 0, del: 0 };
          files.push({ path, status: s, fresh, ...stat });
        }
        if (this.placeKey() !== context) return;
        this.root = root; this.on = on; this.hasHead = head.code === 0; this.files = files; this.limited = entries.length > 1000; this.error = null;
        this.watch(root, cx);
        if (this.open && !files.some((f) => f.path === this.open)) { this.open = null; this.setLines([]); }
        // The first file's diff shows until you pick another.
        if (!this.open && !this.closed && files.length) this.open = this.fileOnly?this.given.path:files[0].path;
        if (this.open) {
          try { await this.load(this.open, context); }
          catch { if (this.placeKey() === context) this.setLines(["Cannot preview this diff (too large or unreadable)"]); }
        }
      } catch (e) { if (this.placeKey() === context) this.error = String(e); }
      finally { this.loading = false; cx.notify(); }
    });
  }

  async load(path, context) {
    const file = this.files.find((f) => f.path === path), root = this.root, on = this.on;
    if (!file) return;
    let lines;
    if (file.fresh || (!this.hasHead && file.status === "A")) {
      const text = await readTextFile(`${root}/${path}`, { on }).catch(() => null);
      if (text === null) lines = ["Cannot preview this file (binary, too large, or unreadable)"];
      else if (text.includes("\0")) lines = ["Binary file · no text diff"];
      else {
        file.add = countLines(text);
        lines = [`@@ -0,0 +1,${file.add} @@`, ...text.slice(0, 400000).replace(/\n$/, "").split("\n").slice(0, 1500).map(l => `+${l}`)];
      }
    } else {
      const r = await exec("git", [...READ, "diff", ...(this.hasHead ? ["HEAD"] : []), "--no-ext-diff", "--no-textconv", "--no-color", "--", path], { cwd: root, on });
      if (r.code !== 0) throw new Error(r.stderr);
      const all = r.stdout.replace(/\n$/, "").split("\n"), first = all.findIndex((l) => l.startsWith("@@"));
      lines = first < 0 ? [file.binary ? "Binary file changed" : "No text diff available"] : all.slice(first);
    }
    if (this.placeKey() === context && this.open === path) this.setLines(lines.slice(0, 1500).map(line => line.length > 4000 ? line.slice(0, 4000) + "… (line truncated)" : line));
  }

  setLines(lines) {
    const next=diffRows(lines);
    if(JSON.stringify(this.rows)!==JSON.stringify(next)){this.selectedRow=null;this.rowVersion=(this.rowVersion??0)+1;}
    this.rows = next;
    const text=lines.join("\n");if(this.diffEditor&&this.diffEditor.value()!==text){this.diffEditor.set_value(text);this.diffEditor.set_selected_range({start:0,end:0});}
    this.diffWidth = Math.max(300, ...this.rows.map(row => (row.text.length + 1) * 7 + 50));
  }

  pick(path, cx) {
    this.open = this.open === path ? null : path; this.setLines([]); this.note = null;
    this.closed = !this.open;
    const context = this.context;
    if (this.open) cx.spawn(async (cx) => {
      try { await this.load(path, context); }
      catch (e) { if (this.placeKey() === context && this.open === path) this.note = `Cannot preview this diff (too large or unreadable): ${e}`; }
      cx.notify();
    });
    cx.notify();
  }

  commit(cx) {
    if (!this.message.trim() || !this.root || this.busy || this.loading || this.context !== this.placeKey()) return;
    const root = this.root, on = this.on, context = this.context, message = this.message.trim();
    this.busy = true; this.note = null;
    cx.spawn(async (cx) => {
      try {
        for (const args of [["add", "-A"], ["commit", "-m", message]]) {
          const r = await exec("git", args, { cwd: root, on });
          if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim());
        }
        if (this.placeKey() === context) { this.message = ""; this.input.set_value(""); }
      } catch (e) { if (this.placeKey() === context) this.note = `Commit failed: ${e}`; }
      finally { this.busy = false; this.refresh(cx); cx.notify(); }
    });
    cx.notify();
  }

  diffRow({ kind, number, text }, t, index) {
    if (kind === "@") return div().w_full().px(12).h(20).flex_none().truncate().bg(t.raised).text_color(t.dim).child(text);
    return h_flex().w_full().h(20).flex_none().gap(10).when(kind === "+", (e) => e.bg(t.ansi2 + "18")).when(kind === "-", (e) => e.bg(t.ansi1 + "18")).when(index===this.selectedRow,e=>e.bg(t.selected)).cursor_pointer()
      .child(div().w(30).flex_none().text_right().text_color(t.dim).child(number === undefined ? "" : String(number)))
      .child(div().flex_1().min_w(0).truncate().child(text));
  }

  fileRow(f, t) {
    const slash = f.path.lastIndexOf("/") + 1;
    const status = f.fresh ? "Untracked" : ({A:"Added",D:"Deleted",U:"Merge conflict",M:"Modified"})[f.status];
    return controlState(h_flex().id(`change-${f.path}`).h(HEIGHT.control).flex_none()
      .px(SPACE.row).gap(SPACE.row).items_center().rounded(RADIUS.control).cursor_pointer()
      .on_click((_e, cx) => this.pick(f.path, cx))
      .child(div().w(ICON_SIZE.control).flex_none().text_size(TYPE.meta)
        .text_color(f.status === "A" ? t.ansi2 : f.status === "D" || f.status === "U" ? t.ansi1 : t.ansi3)
        .tooltip(status).child(f.fresh ? "?" : f.status))
      .child(h_flex().flex_1().min_w(0).tooltip(f.path)
        .when(slash > 0, e => e.child(div().min_w(0).max_w("50%").text_color(t.muted)
          .truncate().text_ellipsis_middle().child(f.path.slice(0, slash))))
        .child(div().min_w(0).truncate().text_ellipsis_middle().child(f.path.slice(slash))))
      .when(f.add > 0, e => e.child(div().flex_none().text_size(TYPE.meta).text_color(t.ansi2).child(`+${f.add}`)))
      .when(f.del > 0, e => e.child(div().flex_none().text_size(TYPE.meta).text_color(t.ansi1).child(`−${f.del}`))),
      t, { selected: this.open === f.path });
  }

  render(cx) {
    if (this.placeKey() !== this.context) this.refresh(cx);
    const t = theme(), add = this.files.reduce((n, f) => n + f.add, 0), del = this.files.reduce((n, f) => n + f.del, 0);
    const commitReason = this.busy ? "Commit in progress." : this.loading ? "Loading changes…"
      : !this.root || this.context !== this.placeKey() ? "Open a Git checkout to commit changes."
      : !this.message.trim() ? "Enter a commit message." : "";
    return v_flex().id("changes").size_full().min_h(0).rounded(RADIUS.card).overflow_hidden().bg(t.background)
      .border_1().border_color(t.border).text_color(t.foreground).text_size(TYPE.body)
      .track_focus(this.handle).focus(s => s.border_color(t.accent)).key_context(this.referenceContext)
      .on_action(this.referenceCopyAction,(_e,cx)=>{cx.stop_propagation();referenceAction(this,"copy-reference",cx);})
      .on_action(this.referenceInsertAction,(_e,cx)=>{cx.stop_propagation();referenceAction(this,"send-reference",cx);})
      .on_key_down((e, cx) => {
        if (e.key === "escape" && this.typing) { this.typing = false; this.handle.focus(); cx.stop_propagation(); cx.notify(); }
      })
      .child(cardHeader(t)
        .child(div().flex_1().min_w(0).font_medium().truncate().text_ellipsis_middle()
          .when(this.fileOnly, e => e.tooltip(this.given.path)).child(this.fileOnly ? this.given.path : "Changes"))
        .child(div().flex_none().text_size(TYPE.meta).text_color(t.muted).child(`${this.files.length} changed file${this.files.length===1?"":"s"}`))
        .child(div().flex_none().text_size(TYPE.meta).text_color(t.ansi2).child(`+${add}`))
        .child(div().flex_none().text_size(TYPE.meta).text_color(t.ansi1).child(`−${del}`)))
      // overflow_y_scrollbar() wraps the list, so its flex sizing never reached the panel's layout.
      .when(!this.fileOnly, el => el
        .child(div().flex_1().min_h(HEIGHT.rowTwo).max_h(this.files.length * HEIGHT.control + 2 * SPACE.small).relative()
          .child(v_flex().id("changes-list").absolute().inset_0().overflow_y_scroll().p(SPACE.small)
            .children(this.files.map(f => this.fileRow(f, t)))
            .when(!this.files.length&&!this.error, e => e.child(div().p(SPACE.row).text_color(t.muted).child(this.loading ? "Loading changes…" : this.root ? "No uncommitted changes" : "Open a session with a working directory to view changes."))))
          .child(Scrollbar.vertical("changes-list").absolute().inset_0()))
        .child(div().h(SPACE.small).flex_none().border_t(1).border_color(t.border).tooltip("The file list and diff have a fixed divider.")))
      .when(Boolean(this.error), el => el.child(div().px(SPACE.card).py(SPACE.small).text_size(TYPE.meta).text_color(t.ansi1).child(this.error)))
      .when(this.limited, el => el.child(div().px(SPACE.card).py(SPACE.small).text_size(TYPE.meta).text_color(t.muted).child("Showing the first 1,000 changed files")))
      .child(div().flex_1().min_h(0).child(Editor.new(this.diffEditor).size_full()))
      .when(Boolean(this.note), e => e.child(div().px(SPACE.card).pb(SPACE.row).text_size(TYPE.meta).text_color(t.ansi1).child(this.note)))
      .when(!this.fileOnly, el => el.child(h_flex().flex_none().p(SPACE.row).gap(SPACE.row).border_t(1).border_color(t.border)
        .child(div().id("commit-message").flex_1().min_w(0).h(HEIGHT.control).px(SPACE.row).flex().items_center()
          .rounded(RADIUS.control).bg(t.background).border_1().border_color(this.typing ? t.accent : t.input)
          .cursor_text().on_mouse_down("left", (_e, cx) => cx.stop_propagation())
          .child(Input.new(this.input).h_full().text_size(TYPE.control).text_color(t.foreground)))
        .child(controlState(div().id("commit").h(HEIGHT.control).px(SPACE.card).flex_none().flex().items_center()
          .rounded(RADIUS.control).text_size(TYPE.control).font_medium()
          .when(Boolean(commitReason), e => e.text_color(t.dim).tooltip(commitReason))
          .when(!commitReason, e => e.bg(t.solid).text_color(t.solid_foreground).cursor_pointer()
            .on_click((_e, cx) => this.commit(cx)))
          .child(this.busy ? "Committing…" : "Commit all changes"), t, { disabled: Boolean(commitReason) })
          .when(!commitReason, e => e.hover(s => s.bg(t.solid).opacity(0.88))
            .active(s => s.bg(t.selected).text_color(t.foreground))))));
  }
}
