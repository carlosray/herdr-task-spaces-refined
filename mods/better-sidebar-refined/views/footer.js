// The sidebar's last line: Settings, Mod settings and Add machine as icons. Herdr's
// own footer gives each a labelled row, which costs twice the height. Mod settings
// opens Better Config, and shows only when that mod is installed.
import { div } from "gpui-kit";
import { h_flex } from "gpui-base";
import { theme, run, updates, readTextFile, appHome, layout, props, focused, shared, setShared } from "herdr";
import { Icon, SIZE, REVEAL_CURRENT } from "./ui.js";
import { findNode } from "./find-node.js";

export class Footer {
  init(given, cx) {
    this.refinedChrome = (props()?.refinedChrome ?? given?.refinedChrome) === true;
    this.hasConfig = false;
    // shortcut: checked once, so installing Better Config shows the button after the next reload.
    readTextFile(`${appHome()}/mods/better-config-refined/mod.json`)
      .then((raw) => {
        this.hasConfig = raw !== null;
        cx?.notify();
      })
      .catch(() => {});
  }

  button(id, label, action, t, icons) {
    return h_flex()
      .id(id)
      .h(this.refinedChrome ? 24 : SIZE.icon)
      .px(6)
      .gap(3)
      .flex_none()
      .items_center()
      .rounded(6)
      .text_color(t.muted)
      .cursor_pointer()
      .hover((s) => s.bg(t.hover).text_color(t.foreground))
      .accessibility_label(label)
      .tooltip(label)
      .on_click(action)
      .children(icons);
  }

  render() {
    const t = theme();
    const rail = this.refinedChrome && (findNode(layout(), "sidebar")?.size?.px ?? 268) < 160;
    const canReveal = this.refinedChrome && Boolean(focused()?.space);
    const updateDot = updates().app.ready ? [div().size(6).rounded_full().bg(t.accent)] : [];
    return h_flex()
      .id("sidebar-footer")
      .size_full()
      .px(8)
      .gap(2)
      .when(rail && canReveal, el => el.px(2))
      .when(rail, el => el.justify_center())
      .when(this.refinedChrome, el => el.border_r(1))
      .items_center()
      .bg(t.chrome)
      .border_t(1)
      .border_color(t.border)
      .child(
        this.button("settings", "Settings", () => run("app.settings"), t, [
          Icon("settings"),
          ...updateDot,
        ]).when(rail && canReveal, el => el.px(3)),
      )
      .when(this.hasConfig && !rail, (el) =>
        el.child(
          this.button("mod-settings", "Mod settings", () => run("mod.open", { name: "better-config-refined" }), t, [
            Icon("sliders"),
          ]),
        ),
      )
      .when(!rail, el => el.child(
        this.button("machine", "Add machine", () => run("mod.open", { name: "machine-add" }), t, [
          Icon("plus", 12),
          Icon("server"),
        ]),
      ))
      .when(canReveal, el => el.child(div().flex_1()).child(
        this.button("reveal-current", "Show current session in Spaces", () => {
          const target = focused();
          if (!target?.space) return;
          if (rail) run("layout.resize", { id: "sidebar", px: Math.max(200, shared("sidebar.width") ?? 268) });
          setShared(REVEAL_CURRENT, { space: target.space, terminal: target.terminal, tab: target.tab, at: Date.now() });
        }, t, [Icon("locate", 14)]).when(rail, button => button.px(3)),
      ));
  }
}
