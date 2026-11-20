import { div } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { checking, exec, machines, panes, run, setShared, shared, spaces, theme, window } from "herdr";
import { PRStatusObserver, prAppearance } from "../git/pr-status.js";
import { fetchGitLabDetails } from "../git/gitlab-mrs.js";
import { REQUESTS, REQUEST_FILTER, REQUEST_REFRESH, checkStatus, requestPlaces, requestSnapshot } from "../git/requests-index.js";
import { Icon, IconButton, Menu, MenuOption, SpaceAvatar, TEXT } from "./ui.js";
import { requestSpaceTree } from "./tree-model.js";

import { HEIGHT, RADIUS, SPACE, cardHeader } from "../ui-kit.js";

const PAGE_SIZE = 32;
const requestId = pr => `${pr.provider === "gitlab" ? "!" : "#"}${pr.number}`;
const providerName = pr => pr.provider === "gitlab" ? "GitLab" : "GitHub";
const spaceName = space => space.machine ? `${space.name} · ${space.machine === "ivm" ? "IVM" : space.machine}` : space.name;
const requestTitle = pr => {
  const title = typeof pr.title === "string" ? pr.title : "";
  return pr.isDraft ? title.replace(/^(?:(?:Draft|WIP):|\[(?:Draft|WIP)\]|\((?:Draft|WIP)\))\s*/i, "") || title : title;
};

export class RequestService {
  init(_props, cx) {
    if (checking()) return;
    this.observer = new PRStatusObserver({ allRequests: true, onChange: () => this.publish() });
    this.refresh(cx);
    cx.timer.every(2500, cx => this.refresh(cx));
  }

  refresh(cx) {
    const requested = shared(REQUEST_REFRESH);
    const force = requested !== this.requested && !this.observer.busy;
    if (force) this.requested = requested;
    this.spaceList = spaces();
    this.places = requestPlaces(this.spaceList, panes(), machines());
    if (force || window().active) this.observer.refresh(this.places, cx, force);
    this.publish();
  }

  publish() {
    const value = requestSnapshot(this.places, this.observer.entries, this.spaceList);
    const signature = JSON.stringify(value);
    if (signature === this.signature) return;
    this.signature = signature;
    setShared(REQUESTS, value);
  }

  render() { return div(); }
}

function linkButton(id, label, action, content = label) {
  const t = theme();
  return div().id(id).px(7).h(24).flex().items_center().rounded(5).min_w(0)
    .text_size(TEXT.caption).text_color(t.accent).truncate().cursor_pointer().accessibility_label(label)
    .hover(el => el.bg(t.hover).text_color(t.foreground))
    .on_mouse_down("left", (_event, cx) => cx.stop_propagation())
    .on_mouse_up("left", (_event, cx) => cx.stop_propagation())
    .on_click((_event, cx) => { cx.stop_propagation(); action(cx); }).child(content);
}

export class Requests {
  init(_props, cx) {
    this.page = 0;
    this.focus = cx.focus_handle();
    this.menuFocus = cx.focus_handle();
    this.details = new Map();
  }

  refresh() { setShared(REQUEST_REFRESH, Date.now()); }

  setFilter(id, cx) {
    this.filterOpen = false;
    setShared(REQUEST_FILTER, id);
    cx.notify();
  }

  filter(choices, selected, t) {
    const colors = shared("space.colors") ?? {};
    const glyph = space => !space?.id ? Icon("folder", 14).text_color(t.muted) :
      space.worktree ? Icon("branch", 14).text_color(t.muted) : SpaceAvatar(space, t, colors);
    const trigger = h_flex().id("mr-filter-trigger").w_full().min_w(0).h(HEIGHT.control).px(8).gap(6)
      .items_center().rounded(6).border_1().border_color(t.input).bg(t.background)
      .focus(el => el.border_color(t.accent))
      .text_size(TEXT.small).cursor_pointer().hover(el => el.bg(t.hover))
      .accessibility_label("Filter by Space")
      .child(glyph(selected))
      .child(div().flex_1().min_w(0).truncate().child(selected ? spaceName(selected) : "All Spaces"))
      .child(Icon("chevron-down", 11).text_color(t.muted));
    const options = this.filterOpen ? [{ id: null, name: "All Spaces" }, ...choices] : [];
    return Menu({ id: "mr-space-filter", open: Boolean(this.filterOpen), focus: this.menuFocus, width: 294, trigger,
      onOpenChange: (open, cx) => { this.filterOpen = open; cx.notify(); },
      children: [v_flex().h(Math.min(248, options.length * 31)).overflow_y_scrollbar().children(options.map(space =>
        MenuOption({ id: `mr-filter-${space.id ?? "all"}`, iconElement: glyph(space), indent: space.worktree ? 20 : 0, label: spaceName(space),
          selected: space.id === (selected?.id ?? null), onClick: cx => this.setFilter(space.id, cx) })))],
    });
  }

  open(pr, cx) {
    this.selected = pr.url;
    this.cursor = pr.url;
    this.focus.focus();
    cx.notify();
    const cached = this.details.get(pr.url);
    if (cached?.pending || (cached && Date.now() - cached.at < 60000)) return;
    this.details.set(pr.url, { pending: true });
    cx.spawn(async cx => {
      try {
        const extra = await this.lookupDetails(pr);
        this.details.set(pr.url, { at: Date.now(), extra });
      } catch {
        this.details.set(pr.url, { at: Date.now(), error: true });
      }
      if (this.selected === pr.url) cx.notify();
    });
  }

  async lookupDetails(pr) {
    if (pr.provider === "gitlab") {
      const detail = await fetchGitLabDetails({ host: pr.url.split("/")[2], path: pr.repository }, pr.number, exec);
      if (detail.id !== pr.id || detail.targetProjectId !== pr.targetProjectId || detail.sourceProjectId !== pr.sourceProjectId)
        throw new Error("GitLab request identity changed");
      return detail;
    }
    const result = await exec("gh", ["pr", "view", String(pr.number), "--repo", `github.com/${pr.repository}`,
      "--json", "latestReviews,reviewRequests,reviewDecision,statusCheckRollup,mergeStateStatus,baseRefName"], { on: null, timeout: 12000 });
    if (result.code !== 0) throw new Error("Could not load GitHub request details");
    const detail = JSON.parse(result.stdout);
    return { ...detail,
      reviewers: (detail.reviewRequests ?? []).map(row => row.login || row.name).filter(Boolean),
      approvals: (detail.latestReviews ?? []).filter(row => row.state === "APPROVED").map(row => row.author?.login).filter(Boolean),
    };
  }

  status(pr, t, pill = false) {
    const state = pr.state === "OPEN" ? (pr.isDraft ? "Draft" : "Open") : pr.state === "MERGED" ? "Merged" : "Closed";
    const color = state === "Open" ? t.ansi2 : state === "Merged" ? t.ansi5 : state === "Closed" ? t.ansi1 : t.muted;
    return div().flex_none().text_size(TEXT.caption).text_color(color)
      .when(pill, el => el.h(20).px(6).flex().items_center().rounded(5)
        .border_1().border_color(t.border).bg(t.raised))
      .child(state);
  }

  row(pr, active, t, filter) {
    const first = pr.spaces.find(space => space.id === filter) ?? pr.spaces[0];
    const reference = first ? spaceName(first) + (pr.spaces.length > 1 ? ` +${pr.spaces.length - 1}` : "") : "";
    return h_flex().id(`mr-row-${pr.url}`).h(HEIGHT.rowTwo).px(SPACE.row).gap(SPACE.icon).flex_none().min_w(0).items_center().rounded(RADIUS.control)
      .when(active, el => el.bg(t.selected))
      .when(!active, el => el.hover(style => style.bg(t.hover))).cursor_pointer()
      .on_click((_event, cx) => this.open(pr, cx))
      .child(v_flex().flex_1().min_w(0).gap(3)
        .child(div().min_w(0).truncate().tooltip(pr.title).font_medium().child(requestTitle(pr)))
        .child(h_flex().gap(2).min_w(0).items_center()
          .child(div().flex_1().min_w(0).truncate().text_size(TEXT.caption).text_color(t.muted)
            .tooltip(`${pr.repository} ${requestId(pr)}`).child(`${requestId(pr)} · ${pr.repository}`))
          .when(Boolean(first), el => el.child(linkButton(`mr-ref-${pr.url}`, reference, () => run("space.select", { id: first.id }))
            .h(18).px(3).max_w(142).tooltip(pr.spaces.map(spaceName).join("\n"))))))
      .child(this.status(pr, t))
      .child(IconButton({ id: `mr-link-${pr.url}`, icon: "external-link", iconSize: 13, muted: true, t,
        label: `Open ${requestId(pr)} in ${providerName(pr)}`, onClick: cx => cx.open_url(pr.url) }));
  }

  detail(pr, t) {
    const cached = this.details.get(pr.url);
    const detail = { ...pr, ...cached?.extra };
    const appearance = prAppearance(detail, t);
    const review = { APPROVED: "Approved", REVIEW_REQUIRED: "Review required", CHANGES_REQUESTED: "Changes requested" }[detail.reviewDecision];
    const approved = new Set(detail.approvals ?? []);
    const otherReviewers = detail.reviewers?.filter(person => !approved.has(person));
    const lines = [
      ["Merge", ["Ready to merge", "Conflicts"].includes(appearance.label) ? appearance.label : detail.mergeStatus],
      ["CI", checkStatus(detail)],
      ["Review", review],
      ["Approved by", detail.approvals?.join(", ")],
      [approved.size ? "Other reviewers" : "Reviewers", otherReviewers?.join(", ")],
    ].filter(([, value]) => value);
    const label = name => div().w(88).h(24).flex_none().flex().items_center()
      .text_size(TEXT.caption).text_color(t.muted).child(name);
    const row = (name, value) => h_flex().gap(8).items_start().child(label(name)).child(value);
    const branch = [detail.headRefName, detail.baseRefName].filter(Boolean).join(" → ");
    return v_flex().id("mr-details").min_h(0).flex_1().overflow_y_scrollbar().mode("scrolling").p(16).gap(8)
      .child(h_flex().gap(8).items_center().child(this.status(detail, t, true))
        .child(div().flex_1().min_w(0).truncate().text_color(t.muted).text_size(TEXT.caption).child(`${pr.repository} ${requestId(pr)}`)))
      .child(div().text_size(13).line_height("18px").max_h(36).overflow_hidden().flex_none()
        .font_semibold().whitespace_normal().tooltip(pr.title).child(requestTitle(pr)))
      .when(Boolean(branch), el => el.child(h_flex().min_w(0).gap(4).text_size(TEXT.caption).text_color(t.muted).tooltip(branch)
        .when(Boolean(detail.headRefName), e => e.child(div().min_w(0).flex_1().whitespace_nowrap()
          .text_ellipsis_middle().overflow_hidden().child(detail.headRefName)))
        .when(Boolean(detail.headRefName && detail.baseRefName), e => e.child(div().flex_none().child("→")))
        .when(Boolean(detail.baseRefName), e => e.child(div().flex_none().max_w(100).truncate().child(detail.baseRefName)))))
      .child(v_flex().pt(4).gap(4)
        .children(lines.map(([name, value]) => row(name, div().min_w(0).flex_1().min_h(24).py(4)
          .text_size(TEXT.small).whitespace_normal().child(value))))
        .when(pr.spaces.length > 0, el => el.child(row(pr.spaces.length === 1 ? "Space" : "Spaces",
          v_flex().min_w(0).flex_1().children(pr.spaces.map(space => linkButton(
            `mr-space-${space.id}`, spaceName(space), () => run("space.select", { id: space.id }),
            h_flex().gap(5).items_center().min_w(0).child(Icon("branch", 12))
              .child(div().min_w(0).truncate().child(spaceName(space)))
          ).px(0)))))))
      .when(Boolean(cached?.pending || cached?.error), el => el.child(div().text_size(TEXT.caption).text_color(t.muted)
        .child(cached.pending ? "Loading request details…" : "Couldn’t load request details")));
  }

  render() {
    const t = theme(), index = shared(REQUESTS), id = shared(REQUEST_FILTER) ?? null;
    const choices = requestSpaceTree(index?.spaces ?? [], shared("task-spaces.hosts") ?? {});
    const selectedSpace = choices.find(space => space.id === id);
    const selectedIds = selectedSpace ? new Set(selectedSpace.spaceIds) : null;
    if (this.lastFilter !== id) {
      this.lastFilter = id; this.selected = null; this.cursor = null; this.page = 0;
    }
    const rows = (index?.requests ?? []).filter(pr => !selectedIds || pr.spaces.some(space => selectedIds.has(space.id)));
    const pageCount = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
    this.page = Math.min(this.page, pageCount - 1);
    const pageRows = rows.slice(this.page * PAGE_SIZE, (this.page + 1) * PAGE_SIZE);
    const detail = rows.find(pr => pr.url === this.selected);
    if (!detail) this.selected = null;
    const inScope = set => set?.some(space => !selectedIds || selectedIds.has(space));
    const loading = !index || inScope(index.loading);
    const unavailable = inScope(index?.unavailable);
    const root = v_flex().id("merge-requests").size_full().min_h(0).rounded(10).overflow_hidden()
      .bg(t.background).border_1().border_color(t.border).text_color(t.foreground).text_size(TEXT.body).track_focus(this.focus)
      .on_key_down((event, cx) => {
        if (detail && event.key === "escape") { this.selected = null; cx.notify(); cx.stop_propagation(); return; }
        if (detail || this.filterOpen || !pageRows.length) return;
        const at = pageRows.findIndex(pr => pr.url === this.cursor);
        if (event.key === "up" || event.key === "down") {
          this.cursor = pageRows[Math.max(0, Math.min(pageRows.length - 1, at + (event.key === "down" ? 1 : -1)))].url;
          cx.notify(); cx.stop_propagation();
        } else if (event.key === "enter" && !event.is_held) {
          this.open(pageRows[Math.max(0, at)], cx); cx.stop_propagation();
        }
      })
      .child(cardHeader(t)
        .when(Boolean(detail), el => el.child(IconButton({ id: "mr-back", icon: "chevron-left", iconSize: 14,
          label: "Back to merge requests", muted: true, t, onClick: cx => { this.selected = null; cx.notify(); } })))
        .child(div().flex_1().min_w(0).truncate().font_semibold().child("Merge requests"))
        .when(Boolean(detail), el => el.child(linkButton("mr-open-provider", `Open in ${providerName(detail)} ↗`,
          cx => cx.open_url(detail.url)).flex_none()))
        .when(!detail, el => el.child(IconButton({ id: "mr-refresh", icon: "refresh", label: "Refresh requests", muted: true, t, onClick: () => this.refresh() }))));
    if (detail) return root.child(this.detail(detail, t));
    return root.child(v_flex().px(8).py(6).child(this.filter(choices, selectedSpace, t)))
      .when(Boolean(unavailable), el => el.child(h_flex().px(14).items_center().gap(5)
        .child(div().flex_1().text_size(TEXT.caption).text_color(t.muted).child(rows.length ? "Some requests may be out of date" : "Couldn’t load requests for some Spaces"))
        .child(linkButton("mr-retry", "Retry", () => this.refresh()))))
      .when(!pageRows.length && (!unavailable || loading), el => el.child(div().px(14).py(8).text_size(TEXT.small).text_color(t.muted)
        .child(loading ? "Loading requests…" : selectedSpace ? "No requests for this Space" : "No requests for current branches")))
      .when(Boolean(pageRows.length), el => el.child(v_flex().id(`mr-list-${this.page}`).p(6).min_h(0).flex_1()
        .overflow_y_scrollbar().mode("scrolling").children(pageRows.map(pr => this.row(pr, pr.url === this.cursor, t, id)))))
      .when(pageCount > 1, el => el.child(h_flex().px(8).py(4).justify_between().items_center().border_t(1).border_color(t.border)
        .when(this.page > 0, inner => inner.child(linkButton("mr-prev", "Previous", cx => { this.page--; this.cursor = null; cx.notify(); })))
        .child(div().text_size(TEXT.caption).text_color(t.muted).child(`${this.page + 1} / ${pageCount}`))
        .when(this.page + 1 < pageCount, inner => inner.child(linkButton("mr-next", "Next", cx => { this.page++; this.cursor = null; cx.notify(); })))));
  }
}
