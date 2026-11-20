const gitLabHost = (host) => host === "gitlab.com" || /^gitlab\.[a-z0-9.-]+$/.test(host ?? "");
const projectPath = /^(?:[\w][\w.-]*\/)+[\w][\w.-]*$/;
const pageSize = 100;
const peopleLimit = 20;
const states = new Map([["opened", "OPEN"], ["merged", "MERGED"], ["closed", "CLOSED"]]);
const positiveId = (id) => Number.isSafeInteger(id) && id > 0;

export function gitlabRepository(url) {
  if (typeof url !== "string") return null;
  const remote = /^(?:https:\/\/([\w.-]+)(?::443)?\/|ssh:\/\/(?:[\w.-]+@)?([\w.-]+)(?::22)?\/|(?:[\w.-]+@)?([\w.-]+):\/?)([\w./-]+)$/i.exec(
    url.trim().replace(/\/$/, ""),
  );
  if (!remote) return null;
  const host = (remote[1] ?? remote[2] ?? remote[3]).toLowerCase();
  const path = remote[4].replace(/\.git$/, "");
  return gitLabHost(host) && projectPath.test(path) ? { host, path } : null;
}

function projectEndpoint(project) {
  if (!gitLabHost(project?.host) || typeof project.path !== "string" || !projectPath.test(project.path))
    throw new Error("Invalid GitLab project");
  return "projects/" + encodeURIComponent(project.path);
}

async function gitlabGet(host, endpoint, execute, timeout = 8000) {
  if (!gitLabHost(host)) throw new Error("Invalid GitLab host");
  let result;
  try {
    result = await execute(
      "glab",
      ["api", "--hostname", host, "--method", "GET", endpoint],
      { on: null, timeout },
    );
  } catch {
    throw new Error("Local glab could not complete the GitLab request");
  }
  if (result.code !== 0) {
    const status = Number(/\bHTTP\s+([45]\d\d)\b/i.exec(result.stderr ?? "")?.[1]);
    if (!status) throw new Error("GitLab request failed in local glab");
    const error = new Error("GitLab request failed (HTTP " + status + ")");
    error.status = status;
    throw error;
  }
  try {
    return JSON.parse(result.stdout);
  } catch {
    throw new Error("Invalid GitLab response");
  }
}

function toRequest(project, mr) {
  const state = states.get(mr?.state);
  if (!state || !positiveId(mr.id) || !positiveId(mr.iid) || !positiveId(mr.target_project_id) ||
      (mr.source_project_id != null && !positiveId(mr.source_project_id)) ||
      [mr.title, mr.source_branch, mr.target_branch, mr.updated_at].some((value) => typeof value !== "string"))
    return null;
  const request = {
    provider: "gitlab",
    repository: project.path,
    id: "gitlab:" + project.host + ":" + mr.id,
    number: mr.iid,
    title: mr.title,
    url: "https://" + project.host + "/" + project.path + "/-/merge_requests/" + mr.iid,
    state,
    isDraft: typeof mr.draft === "boolean" ? mr.draft : mr.work_in_progress === true,
    headRefName: mr.source_branch,
    updatedAt: mr.updated_at,
    sourceProjectId: mr.source_project_id ?? null,
    targetProjectId: mr.target_project_id,
    baseRefName: mr.target_branch,
  };
  if (state !== "OPEN" || request.isDraft) return request;
  const status = mr.detailed_merge_status;
  if (status === "conflict" || (!status && mr.has_conflicts === true)) request.mergeStateStatus = "DIRTY";
  if (status === "requested_changes") request.reviewDecision = "CHANGES_REQUESTED";
  if (status === "not_approved") request.reviewDecision = "REVIEW_REQUIRED";
  return request;
}

export async function listGitLabRequests(project, branch, execute) {
  const endpoint = projectEndpoint(project);
  const { host } = project;
  if (typeof branch !== "string" || !branch) return [];
  const source = await gitlabGet(host, endpoint, execute);
  if (!positiveId(source?.id) || typeof source.path_with_namespace !== "string" ||
      !projectPath.test(source.path_with_namespace))
    throw new Error("Invalid GitLab project response");

  // An MR is stored in the target project. For a fork, check its visible upstream as well.
  const targets = [source];
  const upstream = source.forked_from_project;
  if (positiveId(upstream?.id) && upstream.id !== source.id &&
      typeof upstream.path_with_namespace === "string" && projectPath.test(upstream.path_with_namespace))
    targets.push(upstream);

  const query = "?scope=all&state=all&order_by=updated_at&sort=desc&per_page=" + pageSize +
    "&source_branch=" + encodeURIComponent(branch);
  const pages = await Promise.all(targets.map(async (target) => {
    const mrs = await gitlabGet(host, "projects/" + target.id + "/merge_requests" + query, execute);
    if (!Array.isArray(mrs)) throw new Error("Invalid GitLab merge request list");
    const repository = { host, path: target.path_with_namespace };
    return mrs.slice(0, pageSize)
      .filter((mr) => mr?.source_project_id === source.id && mr.source_branch === branch &&
        mr.target_project_id === target.id)
      .map((mr) => toRequest(repository, mr))
      .filter(Boolean);
  }));
  return pages.flat().sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

function personLabel(value) {
  if (typeof value !== "string" || /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/.test(value)) return "";
  return value.trim().slice(0, 128);
}

function peopleLabels(rows, getUser = (row) => row) {
  if (!Array.isArray(rows)) return [];
  const labels = [], seenIds = new Set(), seenLabels = new Set();
  for (const row of rows) {
    const user = getUser(row);
    const label = personLabel(user?.username) || personLabel(user?.name);
    if (!label) continue;
    const key = label.toLowerCase();
    const id = positiveId(user.id) ? user.id : null;
    if (seenIds.has(id) || seenLabels.has(key)) continue;
    if (id !== null) seenIds.add(id);
    seenLabels.add(key);
    labels.push(label);
    if (labels.length === peopleLimit) break;
  }
  return labels;
}

export async function fetchGitLabDetails(project, number, execute) {
  if (typeof number === "string" && /^[1-9]\d*$/.test(number)) number = Number(number);
  if (!positiveId(number)) throw new Error("Invalid GitLab merge request number");
  const endpoint = projectEndpoint(project) + "/merge_requests/" + number;
  const { host, path } = project;
  const mr = await gitlabGet(host, endpoint, execute);
  const request = toRequest({ host, path }, mr);
  if (!request || request.number !== number) throw new Error("Invalid GitLab merge request response");

  const reviewers = peopleLabels(mr.reviewers);
  if (reviewers.length) request.reviewers = reviewers;
  // Approval access varies by instance and the local account. Details and CI
  // remain useful when this enrichment request fails.
  const approvals = await gitlabGet(host, endpoint + "/approvals", execute, 3000).catch(() => null);
  const matchingApprovals = approvals?.id === mr.id && approvals.iid === mr.iid &&
    approvals.project_id === mr.target_project_id;
  if (matchingApprovals) {
    const approvers = peopleLabels(approvals.approved_by, (row) => row?.user);
    if (approvers.length) request.approvals = approvers;
  }
  if (request.state !== "OPEN" || request.isDraft) return request;

  const pipeline = mr.head_pipeline;
  if (typeof mr.sha === "string" && mr.sha && pipeline?.sha === mr.sha) {
    if (pipeline.status === "success") request.statusCheckRollup = [{ conclusion: "SUCCESS" }];
    if (pipeline.status === "failed") request.statusCheckRollup = [{ conclusion: "FAILURE" }];
    if (pipeline.status === "running") request.statusCheckRollup = [{ status: "IN_PROGRESS" }];
    if (pipeline.status === "pending") request.statusCheckRollup = [{ status: "PENDING" }];
  }

  if (!request.reviewDecision && matchingApprovals) {
    if (positiveId(approvals.approvals_left)) request.reviewDecision = "REVIEW_REQUIRED";
    if (approvals.approved === true && approvals.approvals_left === 0 && positiveId(approvals.approvals_required))
      request.reviewDecision = "APPROVED";
  }

  // The list may have cached mergeability. Use the detailed verdict and the
  // current user's merge permission, with any visible head pipeline as a guard.
  const explicitlyNotDraft = (mr.draft ?? mr.work_in_progress) === false;
  if (explicitlyNotDraft && mr.detailed_merge_status === "mergeable" && mr.user?.can_merge === true &&
      mr.has_conflicts !== true && request.reviewDecision !== "REVIEW_REQUIRED" &&
      (!pipeline || request.statusCheckRollup?.[0].conclusion === "SUCCESS"))
    request.mergeStateStatus = "CLEAN";
  return request;
}
