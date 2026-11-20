// Read-only PR discovery for each [machine, checkout]. This observer is separate
// from space rendering so frequent redraws never launch Git or GitHub commands.
import { exec } from "herdr";
import { gitlabRepository, listGitLabRequests } from "./gitlab-mrs.js";

export const PR_POLL_MS = 60000;
export const prPlaceKey = (machine, folder) => JSON.stringify([machine ?? null, folder]);
const PR_FIELDS =
  "id,number,title,url,state,isDraft,headRefName,headRepository,updatedAt,statusCheckRollup,reviewDecision,mergeStateStatus,headRepositoryOwner,baseRefName";

/** Terminal PR states win over draft/CI flags left over from when it was open. */
export function prAppearance(pr, colors) {
  if (pr.state === "MERGED") return { icon: "merged", color: colors.ansi5, label: "Merged" };
  if (pr.state === "CLOSED") return { icon: "closed", color: colors.ansi1, label: "Closed" };
  if (pr.isDraft) return { icon: "draft", color: colors.dim, label: "Draft" };
  const failed = (pr.statusCheckRollup ?? []).some((check) =>
    ["FAILURE", "ERROR", "TIMED_OUT", "ACTION_REQUIRED", "STARTUP_FAILURE"].includes(
      String(check.conclusion || check.state || check.status).toUpperCase(),
    ),
  );
  const open = (color, label, ready = false) => ({ icon: "pull-request", color, label, ready });
  if (pr.mergeStateStatus === "DIRTY") return open(colors.ansi1, "Conflicts");
  if (failed) return open(colors.ansi1, "Checks failed");
  if (pr.reviewDecision === "CHANGES_REQUESTED") return open(colors.ansi3, "Changes requested");
  // CLEAN is GitHub's own "mergeable now": an empty decision means no review is required.
  if (pr.mergeStateStatus === "CLEAN" && (pr.reviewDecision === "APPROVED" || !pr.reviewDecision))
    return open(colors.ansi2, "Ready to merge", true);
  return open(colors.ansi2, "Open");
}

/** Only github.com remotes are supported. Never pass an arbitrary remote URL to gh. */
export function githubRepository(url) {
  return /^(?:https?:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/.exec(
    url.trim(),
  )?.[1];
}

/**
 * One observer per sidebar. Git runs on the checkout's machine; gh runs locally,
 * using the person's existing authentication. No helper executable is required.
 * Maps include the machine in their keys so remote paths cannot collide.
 */
export class PRStatusObserver {
  constructor({ allRequests = false, onChange } = {}) {
    this.allRequests = allRequests;
    this.onChange = onChange;
    this.places = new Map(); // Current checkout snapshots, replaced on refresh.
    this.checked = new Map(); // Checkout key -> last attempt time and branch.
    this.entries = new Map(); // Checkout key -> last published PRs or error.
    this.cache = new Map(); // gh argument list -> short-lived response cache.
    this.rateLimit = new Map();
  }

  refresh(places, cx, force = false) {
    this.places = new Map(
      places
        .filter((place) => place.folder)
        .map((place) => [prPlaceKey(place.machine, place.folder), place]),
    );
    for (const key of this.entries.keys()) if (!this.places.has(key)) this.entries.delete(key);
    for (const key of this.checked.keys()) if (!this.places.has(key)) this.checked.delete(key);
    for (const [key, value] of this.cache)
      if (Date.now() - value.at >= PR_POLL_MS) this.cache.delete(key);
    if (this.busy) return;
    if (force) { this.checked.clear(); this.cache.clear(); }

    const due = [...this.places].filter(([key, place]) => {
      if(place.ready===false)return false;
      const last = this.checked.get(key);
      return !last || last.branch !== place.branch || Date.now() - last.at >= (last.retry ? 5000 : PR_POLL_MS);
    });
    // checkNew runs frequently. Do not spawn tasks or redraw on cache hits.
    if (!due.length) return;
    this.busy = true;
    cx.spawn(async (cx) => {
      let changed = false;
      let index = 0;
      const enqueue = async () => {
        while (index < due.length) {
          const [key, place] = due[index++];
          if (!this.isCurrent(key, place)) continue;
          const previous = this.entries.get(key);
          this.checked.set(key, { at: Date.now(), branch: place.branch });
          let next;
          try {
            const result = await this.lookup(place, previous);
            next = { ...(this.allRequests ? result : { prs: result }), branch: place.branch };
          } catch (error) {
            if (error.branchChanged) {
              if (this.isCurrent(key, place)) {
                this.checked.get(key).retry = true;
                changed = this.entries.delete(key) || changed;
              }
              continue;
            }
            // An unavailable provider leaves the current branch's last known results visible.
            next = { prs: previous?.branch === place.branch ? previous.prs : [], branch: place.branch, error: error.message };
          }
          if (this.isCurrent(key, place) && JSON.stringify(previous) !== JSON.stringify(next)) {
            this.entries.set(key, next);
            changed = true;
          }
        }
      };
      try {
        await Promise.all(Array.from({ length: Math.min(this.allRequests ? 3 : 1, due.length) }, enqueue));
      } finally {
        this.busy = false;
        // In the shared index, completed empty results also advance loading state.
        if (this.onChange) this.onChange();
        else if (changed) cx.notify();
      }
    });
  }

  // A lookup may finish after navigation or a branch switch. Publish only if
  // the caller's checkout snapshot still describes a tracked space.
  isCurrent(key, place) {
    const current=this.places.get(key);
    return Boolean(current && current.ready!==false && current.branch===place.branch);
  }

  async lookup(place, previous) {
    const git = (args) =>
      exec("git", ["--no-optional-locks", ...args], { cwd: place.folder, on: place.machine });
    const head = await git(["symbolic-ref", "--quiet", "--short", "HEAD"]);
    if (head.code !== 0) {
      if (head.code === 1 || /not a git repository/i.test(head.stderr ?? "")) return this.allRequests ? { prs: [] } : [];
      throw new Error("Cannot read checkout branch");
    }
    const branch = head.stdout.trim();
    if (this.allRequests && place.branch && place.branch !== branch)
      throw Object.assign(new Error("Checkout branch changed"), { branchChanged: true });
    // Explicit worktree bindings survive local branch renames and take
    // precedence over guessing a PR from matching head branch names.
    const association = await git(["config", "--get", `branch.${branch}.herdr-pr`]);
    if (association.code !== 0 && association.code !== 1)
      throw new Error("Cannot read PR association");
    const binding = /^([\w.-]+\/[\w.-]+)#([1-9][0-9]*)$/.exec(association.stdout?.trim() ?? "");
    if (binding) {
      const pr = await this.query([
        "pr",
        "view",
        binding[2],
        "--repo",
        binding[1],
        "--json",
        PR_FIELDS,
      ]);
      const prs = [{ ...pr, repository: binding[1] }];
      return this.allRequests ? { prs, queriedBranch: branch } : prs;
    }

    const remotes = await git(["remote"]);
    if (remotes.code !== 0) throw new Error("Cannot read Git remotes");
    const repositories = new Set(), gitlab = new Map(), origins = new Map();
    const remoteNames = remotes.stdout.trim().split(/\r?\n/).filter(Boolean);
    for (const name of remoteNames) {
      const result = await git(["remote", "get-url", name]);
      if (result.code !== 0) throw new Error("Cannot read Git remote URL");
      const repository = githubRepository(result.stdout);
      if (repository) { repositories.add(repository); origins.set(name, { github: repository }); }
      else if (this.allRequests) {
        const project=gitlabRepository(result.stdout);
        if(project) {
          const key=`${project.host}/${project.path}`;
          gitlab.set(key,project); origins.set(name,{ gitlab:key });
        }
      }
    }

    let source;
    if(this.allRequests && remoteNames.length) {
      for(const [key, push] of [[`branch.${branch}.pushRemote`,true],["remote.pushDefault",true],[`branch.${branch}.remote`,false]]) {
        const remote=await git(["config","--get",key]);
        const name=remote.stdout?.trim();
        if(remote.code!==0||!remoteNames.includes(name))continue;
        if(push) {
          const url=await git(["remote","get-url","--push",name]);
          if(url.code!==0)throw new Error("Cannot read Git push remote URL");
          const github=githubRepository(url.stdout), project=gitlabRepository(url.stdout);
          if(github) {repositories.add(github);source={ github };}
          else if(project) {const id=`${project.host}/${project.path}`;gitlab.set(id,project);source={ gitlab:id };}
        } else source=origins.get(name);
        return source ? this.lookupSources(branch,source,repositories,gitlab,previous) : { prs: [], queriedBranch: branch };
      }
    }
    if(this.allRequests)return this.lookupSources(branch,source,repositories,gitlab,previous);
    const candidates=[];
    const heads = new Set([...repositories].map(repo=>repo.toLowerCase()));
    for(const repository of repositories)candidates.push(...await this.lookupGitHub(repository,branch,heads));
    const matches = this.deduplicate(candidates);
    // A reused branch should show its current PR, not a historical merged one.
    const open = matches.filter((pr) => pr.state === "OPEN");
    return open.length ? open : matches.slice(0, 1);
  }

  async lookupGitHub(repository,branch,knownHeads) {
    const found = await this.query([
        "pr",
        "list",
        "--repo",
        this.allRequests ? `github.com/${repository}` : repository,
        "--head",
        branch,
        "--state",
        "all",
        "--limit",
        "100",
        "--json",
        PR_FIELDS,
      ]);
    return found.filter(pr => {
        const head=pr.headRepository?.nameWithOwner ??
          (pr.headRepositoryOwner?.login && pr.headRepository?.name ? `${pr.headRepositoryOwner.login}/${pr.headRepository.name}` : '');
        // Branch names are not unique across forks. Only show PRs whose head
        // repository is one of this checkout's remotes, not somebody else's fork.
        return pr.headRefName === branch && knownHeads.has(head?.toLowerCase());
    }).map(pr=>({...pr,repository}));
  }

  async lookupSources(branch,source,repositories,gitlab,previous) {
    const parts={}, failures=[];
    const load=async (key,query)=>{
      try {parts[key]=await query();}
      catch(error) {
        failures.push(error.message);
        parts[key]=previous?.queriedBranch===branch ? previous.parts?.[key] ?? [] : [];
      }
    };
    if(!source?.gitlab) {
      const heads=new Set((source?.github?[source.github]:[...repositories]).map(repo=>repo.toLowerCase()));
      for(const repository of repositories)
        await load(`github:${repository}`,()=>this.lookupGitHub(repository,branch,heads));
    }
    if(!source?.github) {
      const projectIds=source?.gitlab?[source.gitlab]:[...gitlab.keys()];
      for(const id of projectIds)await load(`gitlab:${id}`,()=>listGitLabRequests(gitlab.get(id),branch,(cmd,args,options)=>this.queryResult(cmd,args,options)));
    }
    return {prs:this.deduplicate(Object.values(parts).flat()), parts, queriedBranch:branch,
      ...(failures.length?{error:failures.join(" · ")}:{})};
  }

  deduplicate(candidates) {
    return [
      ...new Map(candidates.map((pr) => [pr.id ?? `${pr.repository}#${pr.number}`, pr])).values(),
    ].sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""));
  }

  async query(args) {
    const result=await this.queryResult('gh',args);
    if (result.code !== 0) throw new Error(/gh auth login/i.test(result.stderr ?? '')
      ? 'GitHub is not authenticated. Run gh auth login.' : 'Could not load GitHub pull requests');
    return JSON.parse(result.stdout);
  }

  async queryResult(command,args,options) {
    const key = JSON.stringify([command,args]);
    const cached = this.cache.get(key);
    if (cached && Date.now() - cached.at < PR_POLL_MS) return cached.result;
    const at = Date.now();
    const host=command==='gh'?'github.com':args[args.indexOf('--hostname')+1];
    if(host&&(this.rateLimit.get(host)??0)>at)return {code:1,stderr:'HTTP 429'};
    const result = Promise.resolve(exec(command,args,options));
    const item={at,result};
    this.cache.set(key,item);
    try {
      const response=await result;
      if(response.code!==0) {
        if(host&&/HTTP 429|rate limit/i.test(response.stderr ?? ''))this.rateLimit.set(host,Date.now()+PR_POLL_MS);
        if(this.cache.get(key)===item)this.cache.delete(key);
      }
      return response;
    } catch(error) {
      if(this.cache.get(key)===item)this.cache.delete(key);
      throw error;
    }
  }
}
