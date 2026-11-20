import { prPlaceKey } from "./pr-status.js";

export const REQUESTS = "better-sidebar.merge-requests";
export const REQUEST_FILTER = "better-sidebar.merge-request-space";
export const REQUEST_REFRESH = "better-sidebar.merge-request-refresh";

export function requestPlaces(spaces, panes, machines) {
  const byTab = new Map(), occupied = new Set(), byPlace = new Map();
  const ready = new Map(machines.map(machine => [machine.name ?? null, machine.layout]));
  const add = (space, folder, branch) => {
    if (!folder) return;
    const machine = space.machine ?? null, key = prPlaceKey(machine, folder);
    const state = ready.get(machine) ?? (machine ? "unavailable" : "ready");
    const place = byPlace.get(key) ?? { machine, folder, branch, ready: state === "ready", loading: state === "loading", spaces: new Map() };
    if (!place.branch && branch) place.branch = branch;
    place.spaces.set(space.id, { id: space.id, name: space.name, machine });
    byPlace.set(key, place);
  };
  for (const space of spaces) for (const tab of space.tabs ?? []) byTab.set(tab.id, space);
  for (const pane of panes) {
    const space = byTab.get(pane.tab);
    if (!space || !pane.cwd) continue;
    occupied.add(space.id);
    add(space, pane.cwd, pane.branch || undefined);
  }
  for (const space of spaces) if (!occupied.has(space.id)) add(space, space.folder, space.branch || undefined);
  return [...byPlace.values()];
}

export function requestURL(pr) {
  const github = /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/[1-9]\d*$/;
  const gitlab = /^https:\/\/gitlab\.[a-z0-9.-]+\/(?:[\w.-]+\/)+-\/merge_requests\/[1-9]\d*$/;
  return (pr.provider === "gitlab" ? gitlab : github).test(pr.url ?? "") ? pr.url : null;
}

export function requestSnapshot(places, entries, spaceList) {
  const byURL = new Map(), loading = [], unavailable = [];
  for (const place of places) {
    const entry = entries.get(prPlaceKey(place.machine, place.folder));
    const spaces = [...place.spaces.values()];
    if (place.loading) loading.push(...spaces.map(s => s.id));
    else if (!place.ready || (entry?.branch === place.branch && entry?.error)) unavailable.push(...spaces.map(s => s.id));
    else if (!entry || entry.branch !== place.branch) loading.push(...spaces.map(s => s.id));
    if (entry?.branch !== place.branch) continue;
    for (const pr of entry?.prs ?? []) {
      const url = requestURL(pr);
      if (!url || !["OPEN", "CLOSED", "MERGED"].includes(pr.state)) continue;
      const previous = byURL.get(url);
      const item = !previous || (pr.updatedAt ?? "") > (previous.updatedAt ?? "")
        ? {
          url, number: pr.number, id: pr.id, provider: pr.provider, repository: pr.repository, title: pr.title,
          state: pr.state, isDraft: pr.isDraft, updatedAt: pr.updatedAt, headRefName: pr.headRefName,
          baseRefName: pr.baseRefName, reviewDecision: pr.reviewDecision, mergeStateStatus: pr.mergeStateStatus,
          sourceProjectId: pr.sourceProjectId, targetProjectId: pr.targetProjectId,
          statusCheckRollup: pr.statusCheckRollup?.map(({ conclusion, state, status }) => ({ conclusion, state, status })),
          spaces: previous?.spaces ?? new Map(),
        } : previous;
      for (const space of spaces) item.spaces.set(space.id, space);
      byURL.set(url, item);
    }
  }
  const requests = [...byURL.values()].map(pr => ({ ...pr, spaces: [...pr.spaces.values()] }));
  requests.sort((a, b) => Number(b.state === "OPEN") - Number(a.state === "OPEN") ||
    (b.updatedAt ?? "").localeCompare(a.updatedAt ?? "") || a.url.localeCompare(b.url));
  const open = {}, badges = {};
  for (const pr of requests) {
    const state = pr.state.toLowerCase();
    for (const space of pr.spaces) {
      const counts = badges[space.id] ??= { open: 0, merged: 0, closed: 0 };
      counts[state]++;
      if (state === "open") open[space.id] = counts.open;
    }
  }
  return { requests, open, badges, loading: [...new Set(loading)], unavailable: [...new Set(unavailable)],
    spaces: spaceList.map(({ id, name, machine }) => ({ id, name, machine: machine ?? null })) };
}

export function checkStatus(pr) {
  const checks = (pr.statusCheckRollup ?? []).map(check => String(check.conclusion || check.state || check.status || "").toUpperCase());
  if (checks.some(state => ["FAILURE", "FAILED", "ERROR", "TIMED_OUT", "ACTION_REQUIRED", "STARTUP_FAILURE"].includes(state))) return "Checks failed";
  if (checks.some(state => ["PENDING", "QUEUED", "IN_PROGRESS", "RUNNING", "CREATED", "WAITING_FOR_RESOURCE"].includes(state))) return "Checks running";
  if (checks.some(state => ["CANCELED", "CANCELLED"].includes(state))) return "Checks cancelled";
  if (checks.some(state => ["SUCCESS", "PASSED"].includes(state)) &&
      checks.every(state => ["SUCCESS", "PASSED", "SKIPPED", "NEUTRAL"].includes(state))) return "Checks passed";
  return "";
}
