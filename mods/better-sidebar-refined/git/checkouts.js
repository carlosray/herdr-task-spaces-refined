// Reading a space's checkout from Git, with no view state.
import { exec } from "herdr";

const basename = (path) => path.replace(/\/+$/, "").split("/").pop();

// The first terminal defines a space's checkout, not whichever pane is focused.
// Pass a panes() snapshot: each API call copies the full pane list.
export function spaceFolder(space, paneList) {
  const tabIDs = new Set((space.tabs ?? []).map((tab) => tab.id));
  return paneList.find((pane) => tabIDs.has(pane.tab) && pane.cwd)?.cwd || space.folder;
}

export const checkoutKey = (space, paneList) =>
  JSON.stringify([space.machine ?? null, spaceFolder(space, paneList)]);

// Branch and repository, or null if this isn't a repository.
// Throws when Git couldn't be asked, so the caller keeps what it knew.
export async function readCheckout(cwd, on) {
  const metadata = await exec(
    "git",
    ["rev-parse", "--show-toplevel", "--path-format=absolute", "--git-common-dir"],
    { cwd, on },
  );
  if (metadata.code !== 0) {
    if (/not a git repository/i.test(metadata.stderr)) return null;
    throw new Error("Cannot read repository metadata");
  }
  const [top, repo] = metadata.stdout.trimEnd().split("\n");
  if (!top || !repo) throw new Error("Cannot read repository metadata");
  const head = await exec("git", ["symbolic-ref", "--quiet", "--short", "HEAD"], { cwd, on });
  if (head.code !== 0 && head.code !== 1) throw new Error("Cannot read checkout branch");
  return {
    name: repo.endsWith("/.git")
      ? basename(repo.slice(0, -5))
      : basename(repo).replace(/\.git$/, ""),
    branch: head.code === 0 ? head.stdout.trim() : "(detached)",
    repo: JSON.stringify([on, repo]),
    linked: repo !== `${top}/.git`,
  };
}
