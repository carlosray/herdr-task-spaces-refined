import { spaces, shared, openOverlay } from "herdr";

export function offerWorktreeClose(id) {
  const space = spaces().find((row) => row.id === id);
  if (!space) return false;
  const { machine } = space;
  const native = machine ? id.slice(machine.length + 1) : id;
  const registry = shared("task-spaces.hosts")?.[machine || "local"];
  const claim = Object.values(registry?.checkouts ?? {}).find((row) => row.space === native);
  if (!claim || claim.main !== false) return false;
  const policy = shared("task-spaces.close-policies")?.[JSON.stringify([machine, claim.repo])];
  if (!policy?.enabled) return false;
  openOverlay({ mod: "worktree-close-refined", kind: "popup", width: 530, height: 340,
    props: { space: id, machine, folder: claim.folder, repo: claim.repo } });
  return true;
}
