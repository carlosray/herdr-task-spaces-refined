import { View, div } from "gpui-kit";
import { InputState, h_flex, v_flex } from "gpui-base";
import { closeOverlay, exec, home, panes, props, run, setShared, shared, spaces, theme } from "herdr";
import { button, dialogHeader, dialogInput, trackInputFocus } from "./ui.js";

const policies = "task-spaces.close-policies";
const signature = (space) => {
  const tabs = space.tabs.map(({ id }) => id);
  const members = panes().filter((pane) => tabs.includes(pane.tab));
  return JSON.stringify([tabs, members.map(({ pane, terminal, cwd }) => [pane, terminal, cwd])]);
};

export default class WorktreeClose extends View {
  init(_props, cx) {
    this.p = props() ?? {};
    this.settings = this.p.mode === "settings";
    this.setup = this.p.mode === "host";
    this.space = spaces().find((row) => row.id === this.p.space);
    this.machine = this.p.machine ?? this.space?.machine ?? null;
    this.handle = cx.focus_handle();
    this.handle.focus();
    this.choice = "keep";
    this.busy = false;
    this.closed = false;
    this.error = "";
    this.folder = this.p.folder ?? "";
    this.repo = this.p.repo;
    this.id = this.machine ? this.p.space?.slice(this.machine.length + 1) : this.p.space;
    this.request = null;
    this.expected = this.space ? signature(this.space) : null;
    this.key = JSON.stringify([this.machine, this.repo]);
    const policy = shared(policies)?.[this.key] ?? {};
    this.enabled = Boolean(policy.enabled);
    this.branch = InputState.new({ value: policy.branch ?? "{worktree}-idle" });
    this.command = InputState.new({ value: policy.command ?? "", placeholder: "Optional, e.g. git branch-idle" });
    for (const input of [this.branch, this.command]) {
      trackInputFocus(input);
      input.on("change", (_event, cx) => cx.notify());
    }
  }

  save() {
    setShared(policies, {
      ...(shared(policies) ?? {}),
      [this.key]: { enabled: this.enabled, branch: this.branch.value().trim(), command: this.command.value().trim() },
    });
    closeOverlay(this.p.overlay);
  }

  async call(args) {
    const reply = await exec("herdr-task", args, { on: this.machine, timeout: 90000 });
    let data;
    try { data = JSON.parse(reply.stdout); }
    catch { throw new Error("The host did not return a Task Spaces result. Check the host setup."); }
    if (reply.code && !data.waiting) throw new Error(data.error || "The worktree operation failed.");
    return data;
  }

  target() {
    return spaces().find((row) => row.id === this.p.space);
  }

  confirm(cx) {
    if (this.busy || this.closed) return;
    const target = this.target();
    if (!target || signature(target) !== this.expected) {
      this.error = "The tabs changed. Reopen Close Space to review the current tabs.";
      return cx.notify();
    }
    if (this.choice === "keep") {
      closeOverlay(this.p.overlay);
      return run("space.close", { id: this.p.space, confirmed: true });
    }
    this.busy = true;
    this.error = "";
    const choice = this.choice;
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        const request = this.request ?? globalThis.crypto?.randomUUID?.() ??
          `close-${Date.now()}-${Math.random().toString(36).slice(2)}`;
        await this.call(["prepare-close-worktree", "--space", this.id, "--folder", this.folder,
          "--request-id", request, "--action", choice, "--branch=" + this.branch.value().trim(),
          "--command=" + this.command.value().trim()]);
        this.request = request;
        const current = this.target();
        if (!current || signature(current) !== this.expected) {
          await this.call(["cancel-close-worktree", "--space", this.id, "--request-id", request]);
          this.request = null;
          throw new Error("The tabs changed. Reopen Close Space to review the current tabs.");
        }
        run("space.close", { id: this.p.space, confirmed: true });
        this.closed = true;
        await this.finish(cx);
      } catch (err) {
        this.error = String(err.message ?? err);
        this.busy = false;
        cx.notify();
      }
    });
  }

  async finish(cx, attempts = 18) {
    try {
      const result = await this.call(["finish-close-worktree", "--space", this.id, "--request-id", this.request]);
      if (!result.waiting) return closeOverlay(this.p.overlay);
      if (attempts) {
        cx.timer.after(350, (cx) => cx.spawn(async (cx) => this.finish(cx, attempts - 1)));
        return;
      }
      this.error = "The checkout is still in use. Resolve the active terminal, then retry.";
    } catch (err) {
      this.error = String(err.message ?? err);
    }
    this.busy = false;
    cx.notify();
  }

  cancelPending(cx) {
    this.busy = true;
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        await this.call(["cancel-close-worktree", "--space", this.id, "--request-id", this.request]);
        closeOverlay(this.p.overlay);
      } catch (err) { this.error = String(err.message ?? err); }
      finally { this.busy = false; cx.notify(); }
    });
  }

  render() {
    const t = theme();
    const close = () => { if (!this.busy && !this.request) closeOverlay(this.p.overlay); };
    if (this.setup) {
      const installer = home() + "/.local/share/herdr-task-spaces-refined/install.py";
      return v_flex().p(14).gap(12).size_full().bg(t.popover).text_color(t.foreground)
        .child(dialogHeader("Set up " + this.machine, close))
        .child(div().child("Install Task Spaces tools and the configured agent instructions on this host."))
        .child(div().text_color(this.error ? t.ansi1 : t.muted).child(this.error || this.setupResult || ""))
        .child(button("setup-host", this.busy ? "Installing…" : "Install host tools", (cx) => {
          this.busy = true;
          this.error = "";
          cx.notify();
          cx.spawn(async (cx) => {
            try {
              const result = await exec("python3", [installer, "--host", this.machine], { timeout: 120000 });
              if (result.code) throw Error(result.stderr || "Host setup failed.");
              this.setupResult = "Host tools installed.";
            } catch (err) { this.error = String(err.message ?? err); }
            finally { this.busy = false; cx.notify(); }
          });
        }, { solid: true, disabled: this.busy }));
    }
    const root = v_flex().p(14).gap(10).size_full().bg(t.popover).text_color(t.foreground)
      .text_size(13).track_focus(this.handle).on_key_down((event, cx) => {
        if (event.key === "escape") { close(); cx.stop_propagation(); }
      })
      .child(dialogHeader(this.settings ? "Worktree close settings" : "Close Space?", close))
      .child(div().text_color(t.muted).child(this.settings ? this.p.display : this.folder));
    if (this.settings) {
      return root.child(button("enable", this.enabled ? "Return options enabled" : "Return options disabled",
        (cx) => { this.enabled = !this.enabled; cx.notify(); }, { selected: this.enabled }))
        .child(div().child("Pool branch · {worktree} is the directory name"))
        .child(dialogInput(this.branch, "idle-branch", { label: "Pool branch" }))
        .child(dialogInput(this.command, "idle-command", { label: "Optional command on this host" }))
        .child(h_flex().justify_end().gap(8)
          .child(button("cancel", "Cancel", close))
          .child(button("save", "Save", () => this.save(), { solid: true, disabled: !this.branch.value().trim() })));
    }
    const title = this.branch.value().replaceAll("{worktree}", this.folder.split("/").at(-1));
    const choiceLabels = [["keep", "Keep worktree"], ["return", "Return to pool"], ["delete", "Delete worktree"]];
    const detail = {
      keep: "Close the Space and keep the current checkout and branch.",
      return: this.command.value() ? `Run ${this.command.value()} and verify branch ${title}.` : `Switch to ${title}.`,
      delete: "Remove the linked checkout. Its Git branch will be kept.",
    };
    if (!this.closed) root.child(h_flex().gap(5).children(choiceLabels.map(([key, label]) =>
      button("pick-" + key, label, (cx) => { this.choice = key; cx.notify(); }, { selected: this.choice === key, disabled: this.busy }))))
      .child(div().text_color(t.muted).child(detail[this.choice]));
    if (this.error) root.child(div().text_color(t.ansi1).child(this.error));
    const footer = h_flex().justify_end().gap(8);
    if (this.closed) {
      footer.child(button("cancel-action", "Cancel worktree action", (cx) => this.cancelPending(cx), { disabled: this.busy }));
      footer.child(button("retry", this.busy ? "Finishing…" : "Retry", (cx) => {
        this.busy = true;
        this.error = "";
        cx.notify();
        cx.spawn(async (cx) => this.finish(cx));
      }, { solid: true, disabled: this.busy }));
    } else {
      footer.child(button("cancel", "Cancel", close, { disabled: this.busy }));
      footer.child(button("confirm", this.choice === "delete" ? "Close and delete" : this.choice === "return" ? "Close and return" : "Close Space",
        (cx) => this.confirm(cx), { solid: true, disabled: this.busy }));
    }
    return root.child(footer);
  }
}
