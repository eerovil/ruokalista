import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  closeDeployedIssues,
  closePlans,
  deployedCommitShas,
  issueMarker,
  type GitHubRequest,
} from "../scripts/deployed-issue.ts";

const REPOSITORY = "eerovil/ruokalista";
const PREVIOUS_SHA = "9".repeat(40);
const FAILED_SHA = "a".repeat(40);
const CURRENT_SHA = "b".repeat(40);

function pull(number: number, body: unknown, overrides: Record<string, unknown> = {}): unknown {
  return {
    number,
    body,
    merged_at: "2026-09-08T08:00:00Z",
    base: { ref: "main", repo: { full_name: REPOSITORY } },
    ...overrides,
  };
}

test("Issue marker accepts one exact positive issue number", () => {
  assert.deepEqual(issueMarker("Summary\r\n\r\nIssue: #252\r\n"), { issueNumber: 252 });
});

test("Issue marker refuses missing, malformed, closing, and multiple markers", () => {
  assert.deepEqual(issueMarker("Closes #252"), { reason: "has no Issue marker" });
  assert.deepEqual(issueMarker("Issue: eerovil/ruokalista#252"), {
    reason: "has a malformed Issue marker",
  });
  assert.deepEqual(issueMarker("Issue: #252\nIssue: #253"), {
    reason: "must have exactly one Issue marker",
  });
});

test("close plans deduplicate PRs and keep only merged main PRs from this repository", () => {
  assert.deepEqual(closePlans([
    pull(253, "Issue: #252"),
    pull(253, "Issue: #252"),
    pull(254, "Issue: #253"),
    pull(257, "Issue: #252"),
    pull(255, "Issue: #254", { base: { ref: "other", repo: { full_name: REPOSITORY } } }),
    pull(256, "Issue: #255", { base: { ref: "main", repo: { full_name: "other/repo" } } }),
  ], REPOSITORY), {
    plans: [
      { issueNumber: 252, pullRequestNumber: 253 },
      { issueNumber: 253, pullRequestNumber: 254 },
    ],
    skipped: [],
  });
});

test("close plans skip each PR whose marker cannot be trusted", () => {
  assert.deepEqual(closePlans([
    pull(253, "Related to #252"),
    pull(254, "Issue: #252\nIssue: #253"),
  ], REPOSITORY), {
    plans: [],
    skipped: [
      "pull request #253 has no Issue marker",
      "pull request #254 must have exactly one Issue marker",
    ],
  });
});

test("deployment range begins after the last successful production deployment", async () => {
  const request: GitHubRequest = async (_method, path) => {
    if (path.includes("/deployments?")) return [
      { id: 3, sha: CURRENT_SHA },
      { id: 2, sha: FAILED_SHA },
      { id: 1, sha: PREVIOUS_SHA },
    ];
    if (path.includes("/deployments/2/")) return [{ state: "failure" }];
    if (path.includes("/deployments/1/")) return [{ state: "success" }];
    if (path.includes("/compare/")) {
      return { status: "ahead", commits: [{ sha: FAILED_SHA }, { sha: CURRENT_SHA }] };
    }
    throw new Error(`unexpected request: ${path}`);
  };
  assert.deepEqual(
    await deployedCommitShas(REPOSITORY, CURRENT_SHA, request),
    [FAILED_SHA, CURRENT_SHA],
  );
});

test("an incomplete deployment history fails closed instead of dropping old work", async () => {
  const deployments = Array.from({ length: 100 }, (_, index) => ({
    id: index + 1,
    sha: index.toString(16).padStart(40, "0"),
  }));
  const request: GitHubRequest = async (_method, path) => {
    if (path.includes("/deployments?")) return deployments;
    if (path.includes("/statuses?")) return [{ state: "failure" }];
    throw new Error(`unexpected request: ${path}`);
  };
  await assert.rejects(
    deployedCommitShas(REPOSITORY, CURRENT_SHA, request),
    /no successful production deployment found/,
  );
});

test("verified deployment closes open issues across the full undeployed range", async () => {
  const calls: Array<{ method: string; path: string; body?: unknown }> = [];
  const request: GitHubRequest = async (method, path, body) => {
    calls.push({ method, path, ...(body === undefined ? {} : { body }) });
    if (path.includes("/deployments?")) return [{ id: 1, sha: PREVIOUS_SHA }];
    if (path.includes("/deployments/1/")) return [{ state: "success" }];
    if (path.includes("/compare/")) {
      return { status: "ahead", commits: [{ sha: FAILED_SHA }, { sha: CURRENT_SHA }] };
    }
    if (path.endsWith(`${FAILED_SHA}/pulls`)) return [pull(251, "Issue: #250")];
    if (path.endsWith(`${CURRENT_SHA}/pulls`)) return [pull(253, "Issue: #252")];
    if (method === "GET" && path.endsWith("/250")) return { number: 250, state: "open" };
    if (method === "GET" && path.endsWith("/252")) return { number: 252, state: "closed" };
    if (method === "PATCH") return { state: "closed" };
    throw new Error(`unexpected request: ${method} ${path}`);
  };

  assert.deepEqual(await closeDeployedIssues(REPOSITORY, CURRENT_SHA, request), {
    closed: [250],
    alreadyClosed: [252],
    skipped: [],
  });
  assert.deepEqual(calls.filter((call) => call.method === "PATCH"), [{
    method: "PATCH",
    path: `/repos/${REPOSITORY}/issues/250`,
    body: { state: "closed", state_reason: "completed" },
  }]);
});

test("a pull request target is never closed as an issue", async () => {
  const request: GitHubRequest = async (method, path) => {
    if (path.includes("/deployments?")) return [];
    if (path.endsWith("/pulls")) return [pull(253, "Issue: #252")];
    if (method === "GET") return { number: 252, state: "open", pull_request: {} };
    throw new Error("the target must not be updated");
  };
  assert.deepEqual(await closeDeployedIssues(REPOSITORY, CURRENT_SHA, request), {
    closed: [],
    alreadyClosed: [],
    skipped: ["#252 is a pull request, not an issue"],
  });
});

test("workflow closes issues only after live verification with narrow permissions", () => {
  const workflow = readFileSync(".github/workflows/ci.yml", "utf8");
  const deploy = workflow.indexOf("- name: Deploy");
  const issueClose = workflow.indexOf("- name: Verify the public release and close deployed issues");
  assert.ok(deploy >= 0 && issueClose > deploy);
  assert.match(workflow, /run: npm run deploy/);
  const command = readFileSync("scripts/close-deployed-issue.ts", "utf8");
  assert.match(command, /await verifyAndCloseDeployedIssues\(repository, sha, request\)/);
  assert.doesNotMatch(command, /await closeDeployedIssues\(/);
  assert.match(workflow, /deploy:\n(?:.|\n)*?permissions:\n\s+contents: read\n\s+deployments: read\n\s+pull-requests: read\n\s+issues: write/);
  assert.match(workflow, /GITHUB_TOKEN: \$\{\{ github\.token \}\}/);
});
