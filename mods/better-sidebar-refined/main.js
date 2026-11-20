// Better Sidebar: spaces, agents, both in one block (lists), a footer and a right
// panel toggle. A layout puts one copy per block, and `view` in its props picks which part.
import { View } from "gpui-kit";
import { props } from "herdr";
import { Spaces } from "./views/spaces.js";
import { Agents } from "./views/agents.js";
import { Lists } from "./views/lists.js";
import { Footer } from "./views/footer.js";
import { PanelToggle } from "./views/panel-toggle.js";
import { Requests, RequestService } from "./views/requests.js";

import { SpaceMenu, SessionMenu, DirectoryMenu } from "./views/space-menu.js";

const PARTS = { "directory-menu": DirectoryMenu, "space-menu": SpaceMenu, "session-menu": SessionMenu, lists: Lists, agents: Agents, footer: Footer, "panel-toggle": PanelToggle,
  "merge-requests": Requests, "merge-requests-service": RequestService };

export default class BetterSidebar extends View {
  init(given, cx) {
    const Part = PARTS[props()?.view] ?? Spaces;
    this.part = new Part();
    this.part.init(given, cx);
  }

  render(cx) {
    return this.part.render(cx);
  }
}
