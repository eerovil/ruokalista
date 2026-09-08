import { closeDeployedIssues, type GitHubRequest } from "./deployed-issue.ts";

const repository = process.env.GITHUB_REPOSITORY ?? "";
const sha = process.env.GITHUB_SHA ?? "";
const token = process.env.GITHUB_TOKEN ?? "";

if (!token) throw new Error("GITHUB_TOKEN is not configured");

const request: GitHubRequest = async (method, path, body) => {
  const response = await fetch(`https://api.github.com${path}`, {
    method,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "X-GitHub-Api-Version": "2026-03-10",
      "User-Agent": "ruokalista-production-deploy",
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!response.ok) {
    throw new Error(`GitHub ${method} ${path} failed: HTTP ${response.status}`);
  }
  return response.json();
};

const result = await closeDeployedIssues(repository, sha, request);
for (const reason of result.skipped) console.log(`issue left open: ${reason}`);
for (const issueNumber of result.alreadyClosed) {
  console.log(`issue #${issueNumber} was already closed`);
}
for (const issueNumber of result.closed) console.log(`issue #${issueNumber} closed`);
