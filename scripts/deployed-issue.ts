interface PullRequest {
  number?: unknown;
  body?: unknown;
  merged_at?: unknown;
  base?: {
    ref?: unknown;
    repo?: { full_name?: unknown } | null;
  } | null;
}

interface Deployment {
  id?: unknown;
  sha?: unknown;
}

interface DeploymentStatus {
  state?: unknown;
}

interface Comparison {
  status?: unknown;
  commits?: unknown;
}

interface Commit {
  sha?: unknown;
}

interface Issue {
  number?: unknown;
  state?: unknown;
  pull_request?: unknown;
}

export interface GitHubRequest {
  (method: "GET" | "PATCH", path: string, body?: unknown): Promise<unknown>;
}

export interface CloseResult {
  closed: number[];
  alreadyClosed: number[];
  skipped: string[];
}

export function issueMarker(body: unknown):
  | { issueNumber: number }
  | { reason: string } {
  if (typeof body !== "string") return { reason: "has no Issue marker" };

  const markerLines = body
    .split(/\r?\n/)
    .filter((line) => /^\s*issue\s*:/i.test(line));
  if (markerLines.length === 0) return { reason: "has no Issue marker" };
  if (markerLines.length !== 1) return { reason: "must have exactly one Issue marker" };

  const match = /^Issue: #([1-9]\d*)$/.exec(markerLines[0]!);
  if (!match) return { reason: "has a malformed Issue marker" };

  const issueNumber = Number(match[1]);
  if (!Number.isSafeInteger(issueNumber)) return { reason: "has an invalid issue number" };
  return { issueNumber };
}

export function closePlans(
  value: unknown,
  repository: string,
): { plans: Array<{ issueNumber: number; pullRequestNumber: number }>; skipped: string[] } {
  if (!Array.isArray(value)) throw new Error("GitHub returned an invalid pull request list");

  const pullRequests = new Map<number, PullRequest>();
  for (const pullRequest of value as PullRequest[]) {
    if (
      typeof pullRequest.merged_at !== "string" ||
      pullRequest.base?.ref !== "main" ||
      pullRequest.base.repo?.full_name?.toLowerCase() !== repository.toLowerCase()
    ) continue;
    if (!Number.isSafeInteger(pullRequest.number)) {
      throw new Error("GitHub returned a pull request without a valid number");
    }
    pullRequests.set(pullRequest.number as number, pullRequest);
  }

  const plansByIssue = new Map<number, { issueNumber: number; pullRequestNumber: number }>();
  const skipped: string[] = [];
  for (const [pullRequestNumber, pullRequest] of pullRequests) {
    const marker = issueMarker(pullRequest.body);
    if ("reason" in marker) {
      skipped.push(`pull request #${pullRequestNumber} ${marker.reason}`);
    } else {
      if (!plansByIssue.has(marker.issueNumber)) {
        plansByIssue.set(marker.issueNumber, {
          issueNumber: marker.issueNumber,
          pullRequestNumber,
        });
      }
    }
  }
  return { plans: [...plansByIssue.values()], skipped };
}

export async function deployedCommitShas(
  repository: string,
  sha: string,
  request: GitHubRequest,
): Promise<string[]> {
  const value = await request(
    "GET",
    `/repos/${repository}/deployments?environment=production&per_page=100`,
  );
  if (!Array.isArray(value)) throw new Error("GitHub returned an invalid deployment list");

  let previousSha = "";
  for (const deployment of value as Deployment[]) {
    if (deployment.sha === sha) continue;
    if (!Number.isSafeInteger(deployment.id) || !isSha(deployment.sha)) {
      throw new Error("GitHub returned an invalid deployment");
    }
    const statuses = await request(
      "GET",
      `/repos/${repository}/deployments/${deployment.id}/statuses?per_page=100`,
    );
    if (!Array.isArray(statuses)) throw new Error("GitHub returned an invalid deployment status list");
    if ((statuses as DeploymentStatus[]).some((status) => status.state === "success")) {
      previousSha = deployment.sha as string;
      break;
    }
  }

  // On the first production deployment there is no earlier baseline. Its own
  // commit is still associated with the PR that introduced it.
  if (!previousSha) {
    if (value.length === 100) {
      throw new Error("no successful production deployment found in the newest 100 deployments");
    }
    return [sha];
  }

  const commits: string[] = [];
  for (let page = 1; ; page += 1) {
    const comparison = await request(
      "GET",
      `/repos/${repository}/compare/${previousSha}...${sha}?per_page=100&page=${page}`,
    ) as Comparison;
    if (comparison.status !== "ahead" && comparison.status !== "identical") {
      throw new Error("the last successful production deployment is not an ancestor of GITHUB_SHA");
    }
    if (!Array.isArray(comparison.commits)) {
      throw new Error("GitHub returned an invalid commit comparison");
    }
    const pageCommits = (comparison.commits as Commit[]).map((commit) => {
      if (!isSha(commit.sha)) throw new Error("GitHub returned an invalid commit");
      return commit.sha;
    });
    commits.push(...pageCommits);
    if (pageCommits.length < 100) break;
  }
  if (!commits.includes(sha)) commits.push(sha);
  return [...new Set(commits)];
}

export async function closeDeployedIssues(
  repository: string,
  sha: string,
  request: GitHubRequest,
): Promise<CloseResult> {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) {
    throw new Error("GITHUB_REPOSITORY is invalid");
  }
  if (!isSha(sha)) throw new Error("GITHUB_SHA is invalid");

  const commits = await deployedCommitShas(repository, sha, request);
  const associated: unknown[] = [];
  for (const commit of commits) {
    const pullRequests = await request(
      "GET",
      `/repos/${repository}/commits/${commit}/pulls`,
    );
    if (!Array.isArray(pullRequests)) {
      throw new Error("GitHub returned an invalid pull request list");
    }
    associated.push(...pullRequests);
  }
  const { plans, skipped } = closePlans(associated, repository);
  const result: CloseResult = { closed: [], alreadyClosed: [], skipped };

  for (const plan of plans) {
    const issue = await request(
      "GET",
      `/repos/${repository}/issues/${plan.issueNumber}`,
    ) as Issue;
    if (issue.number !== plan.issueNumber || typeof issue.state !== "string") {
      throw new Error("GitHub returned an invalid issue");
    }
    if (issue.pull_request) {
      result.skipped.push(`#${plan.issueNumber} is a pull request, not an issue`);
      continue;
    }
    if (issue.state === "closed") {
      result.alreadyClosed.push(plan.issueNumber);
      continue;
    }

    await request(
      "PATCH",
      `/repos/${repository}/issues/${plan.issueNumber}`,
      { state: "closed", state_reason: "completed" },
    );
    result.closed.push(plan.issueNumber);
  }
  return result;
}

function isSha(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{40}$/i.test(value);
}
