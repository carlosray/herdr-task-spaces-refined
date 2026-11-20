// Pure session inventory, MRU and retention rules. No transcript or environment data.
const DAY = 86400000;
export const STATE_KEY = "session-hub.state";
export const initialState = () => ({ version: 1, live: {}, archive: [], visits: {}, lastFocus: null, restoring: {} });
const claudeAlias = (a,b) => ["claude","nclaude"].includes(a) && ["claude","nclaude"].includes(b);
export const sessionKey = (e) => JSON.stringify([e.machine ?? null, e.tool, e.nativeId || ["terminal",e.address,e.generation ?? e.firstSeen ?? "unresolved"]]);
export const conversationKey = e => e.tool && e.nativeId
  ? sessionKey({ ...e, tool: e.tool === "nclaude" ? "claude" : e.tool }) : null;
function liveConversations(state) {
  return new Map(Object.values(state.live).filter(e => e.isAgent && !e.missingSince && conversationKey(e))
    .map(e => [conversationKey(e), e.address]));
}
const differs = (a,b) => a != null && b != null && a !== b;
const launchChanged = (a,b) => differs(a.generation,b.generation) || differs(a.firstSeen,b.firstSeen);
const conversationChanged = (a,b) => Boolean(a.nativeId && b.nativeId && a.nativeId !== b.nativeId);
const withTitle = (entry,saved) => ({ ...entry, title: saved.title, titleSource: saved.titleSource });
const sameTool = (a,b) => a === b || claudeAlias(a,b);
const sameAgentLaunch = (a,b) => a.isAgent && b.isAgent && a.address === b.address &&
  (a.machine ?? null) === (b.machine ?? null) && sameTool(a.tool,b.tool) &&
  !launchChanged(a,b) && !differs(a.pid,b.pid) &&
  ((a.generation && a.generation === b.generation) || (a.firstSeen != null && a.firstSeen === b.firstSeen));
const switchedFrom = (entry,archived) => archived.reason === "session-switched" &&
  sameAgentLaunch(entry,archived) && conversationChanged(entry,archived);

function preserveTitle(entry, saved) {
  // Old records have no source. Keep their titles when fresh metadata supplies only a fallback.
  if (saved?.title && saved.titleSource !== "fallback" && entry.titleSource === "fallback") return withTitle(entry,saved);
  return entry;
}

export function retainArchive(entries, now) {
  return entries.filter(e => now - e.closedAt <= 30 * DAY)
    .sort((a, b) => b.closedAt - a.closedAt).slice(0, 100)
    .map(({pinned,...entry})=>entry);
}
export function reconcile(previous, snapshot, now) {
  const s = { ...initialState(), ...previous, live: { ...previous.live }, archive: [...(previous.archive ?? [])] };
  const ready = new Set(snapshot.ready ?? []);
  const entries = new Map((snapshot.entries ?? []).map(e => [e.address, e]));
  const finished = new Map((snapshot.finished ?? []).map(e => [e.address, e]));
  const archive = (e, reason) => {
    if (!e.isAgent) return;
    const key = sessionKey(e);
    e = preserveTitle(e, s.archive.find(a => a.id === key));
    s.archive = s.archive.filter(a => a.id !== key);
    s.archive.unshift({ ...e, id: key, reason, closedAt: now, missingSince: undefined, reportedNativeId: undefined });
  };
  for (const [address, old] of Object.entries(s.live)) {
    let current = entries.get(address);
    if (current) {
      const corrected = old.reportedNativeId && sameAgentLaunch(old,current) &&
        (!current.nativeId || current.nativeId === old.reportedNativeId);
      if (corrected) current = { ...current, nativeId: old.nativeId };
      const replaced = launchChanged(old,current);
      const clarified = !replaced && claudeAlias(old.tool,current.tool) && old.nativeId && old.nativeId === current.nativeId;
      const switched = replaced || (current.tool !== old.tool && !clarified) || conversationChanged(old,current);
      if (old.isAgent && !current.isAgent) archive(old, "recovered-shell");
      else if (old.isAgent && switched) archive(old, "session-switched");
      else if (!switched) {
        // The original launch label can outlive a manual rename or the tab projection.
        if (old.titleSource === "tab" && current.titleSource === "label") current = withTitle(current,old);
        else current = preserveTitle(current,old);
      }
      s.live[address] = { ...old, ...current, nativeId: current.isAgent ? (current.nativeId || (old.isAgent && !replaced && old.tool === current.tool ? old.nativeId : null)) : null,
        missingSince: undefined, reportedNativeId: corrected ? old.reportedNativeId : undefined };
      entries.delete(address);
    } else if (finished.has(address)) {
      const ended = finished.get(address);
      const sameGeneration = old.generation && old.generation === ended.generation;
      const sameConversation = old.nativeId && old.nativeId === ended.nativeId &&
        ended.firstSeen != null && ended.firstSeen === old.firstSeen;
      const matches = (sameGeneration || sameConversation) &&
        !launchChanged(old,ended) && !conversationChanged(old,ended);
      const saved = matches && ended.title && old.titleSource !== "tab" ?
        { ...old, title: ended.title, titleSource: "label" } : old;
      archive(saved, ended.reason || "exited");
      delete s.live[address];
    } else if (ready.has(old.machine ?? null)) {
      if (old.missingSince && now - old.missingSince >= 2000) { archive(old, "closed"); delete s.live[address]; }
      else s.live[address] = { ...old, missingSince: old.missingSince || now };
    }
  }
  for (const [address, e] of entries) s.live[address] = { ...e, firstSeen: e.firstSeen ?? now };
  const live = liveConversations(s);
  s.archive = s.archive.filter(entry => {
    const address = live.get(conversationKey(entry));
    if (!address) return true;
    s.live[address] = preserveTitle(s.live[address], entry);
    return false;
  });
  s.archive = retainArchive(s.archive, now);
  const liveKeys = new Set(Object.values(s.live).filter(e => e.isAgent && e.nativeId && !e.missingSince).map(sessionKey));
  s.restoring = Object.fromEntries(Object.entries(s.restoring ?? {}).filter(([key, at]) => now-at < 60000 && !liveKeys.has(key)));
  // Old visit metadata may outlive closures but is bounded independently of the archive.
  const visits = Object.entries(s.visits ?? {}).sort((a,b) => b[1]-a[1]).slice(0, 1000);
  s.visits = Object.fromEntries(visits);
  return s;
}

export function needsForegroundVerification(state, entry) {
  return Boolean(entry.reportedNativeId) || state.archive.some(archived => switchedFrom(entry,archived));
}

export function reconcileForeground(state, observed, verified, now) {
  const current = state.live[observed.address];
  if (!current || current.missingSince || !sameAgentLaunch(current,observed) ||
      !verified?.nativeId || !sameTool(verified.tool,current.tool) ||
      (current.reportedNativeId ?? current.nativeId) !== observed.nativeId ||
      current.nativeId === verified.nativeId) return state;

  let updated;
  if (verified.nativeId === observed.nativeId && current.reportedNativeId) {
    // The agent has now switched to the conversation previously reported by the stale label.
    updated = { ...current, reportedNativeId: undefined };
  } else {
    if (!state.archive.some(entry => switchedFrom(current,entry) && entry.nativeId === verified.nativeId)) return state;
    // Discard the false transition without archiving its unverified destination.
    updated = { ...current, nativeId: verified.nativeId, reportedNativeId: observed.nativeId };
  }
  return reconcile({ ...state, live: { ...state.live, [current.address]: updated } }, { entries: [observed] }, now);
}
export function recordVisit(previous, address, now) {
  if (previous.lastFocus === address) return previous;
  return { ...previous, lastFocus: address, visits: address ? { ...previous.visits, [address]: now } : previous.visits };
}
export function recentRows(state, filter = "") {
  const words = filter.toLowerCase().trim().split(/\s+/).filter(Boolean);
  return Object.values(state.live ?? {}).filter(e => !e.missingSince && words.every(word =>
    [e.title, e.tool, e.spaceName, e.machine ?? "local", e.cwd].join(" ").toLowerCase().includes(word)))
    .sort((a,b) => (state.visits?.[b.address] ?? 0) - (state.visits?.[a.address] ?? 0) || (b.firstSeen ?? 0) - (a.firstSeen ?? 0));
}
export function archiveRows(state, filter = "") {
  const live = liveConversations(state);
  const words = filter.toLowerCase().trim().split(/\s+/).filter(Boolean);
  return state.archive.filter(e => !live.has(conversationKey(e)) && words.every(word =>
    [e.title, e.spaceName, e.tool, e.machine ?? "local", e.nativeId].join(" ").toLowerCase().includes(word)));
}
export const usableTitle = value => typeof value === "string" && value.trim() ? value : null;
export const archivedTabTitle = entry => entry.titleSource === "fallback" ? null : usableTitle(entry.title);

export function resumeArgs(entry) {
  const { tool, nativeId: id } = entry;
  // All supported native IDs are scalar identifiers, never commands or cwd-based latest selectors.
  if (typeof id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{5,160}$/.test(id)) throw Error("Exact native session ID is unavailable");
  const argv = ["herdr-agent", tool];
  const title = archivedTabTitle(entry);
  if (title && !/[\x00-\x1f\x7f-\x9f]/.test(title) && [...title].length <= 160) argv.push("--herdr-title", title);
  if (tool === "codex") return [...argv, "resume", id];
  if (tool === "claude" || tool === "nclaude") return [...argv, "--resume", id];
  if (tool === "pi" || tool === "opencode") return [...argv, "--session", id];
  throw Error("This agent has no supported native session restore adapter");
}

export function archiveReason(reason) {
  if (reason === "session-switched") return "Switched conversation";
  const interruption = {
    "recovered-shell": "Terminal recovered",
    server_stop: "Herdr stopped",
    host_shutdown: "Host shut down",
    holder_lost: "Terminal disconnected",
    stopped_by_restart: "Stopped during restart",
  };
  if (Object.hasOwn(interruption, reason)) return interruption[reason];
  if (["exited","signaled"].includes(reason)) return "Exited";
  return "Closed";
}
export function restoreAvailability(entry, ready = true) {
  try { resumeArgs(entry); }
  catch (e) { return { available: false, label: entry.nativeId && !["codex","claude","nclaude","pi","opencode"].includes(entry.tool) ? "This agent does not support session restore" : "Session ID unavailable", hint: e.message }; }
  if (!ready) return { available: false, label: "Host offline", hint: `${entry.machine ?? "Local host"} is not connected` };
  return { available: true, label: "Restore session", hint: `Resume exact native session ${entry.nativeId}` };
}
