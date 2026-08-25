import type { Env } from "./env.ts";
import type { RouteContext } from "./router.ts";

const SNAPSHOT_URL =
  "https://api.github.com/repos/eerovil/ruokalista-backup/contents/snapshot.json";
const GITHUB_API_VERSION = "2026-03-10";
const MAX_SNAPSHOT_BYTES = 50 * 1024 * 1024;

/**
 * Temporary #64 bridge: lets the production deploy runner retrieve the private
 * GitHub snapshot without putting it in this public repo, logs, or artifacts.
 * The high-entropy bearer token is created and deleted by that same CI job.
 */
export async function backupSnapshotForRestoreDrill({
  request,
  env,
}: Pick<RouteContext, "request" | "env">): Promise<Response> {
  const drillToken = env.BACKUP_DRILL_TOKEN;
  const authorization = request.headers.get("authorization");
  if (!drillToken || authorization !== `Bearer ${drillToken}`) {
    return new Response("Not found", { status: 404 });
  }

  const githubToken = env.BACKUP_GITHUB_TOKEN;
  if (!githubToken) {
    return new Response("Backup credential unavailable", { status: 503 });
  }

  const response = await fetch(SNAPSHOT_URL, {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${githubToken}`,
      "X-GitHub-Api-Version": GITHUB_API_VERSION,
      "User-Agent": "ruokalista-backup-restore-drill",
    },
  });
  if (!response.ok) {
    return new Response(`Backup repository read failed: HTTP ${response.status}`, {
      status: 502,
    });
  }

  const payload: unknown = await response.json();
  if (!isRecord(payload) || payload.encoding !== "base64" || typeof payload.content !== "string") {
    return new Response("Backup repository returned an unexpected file shape", {
      status: 502,
    });
  }

  let bytes: Uint8Array;
  try {
    const compact = payload.content.replace(/\s/g, "");
    const binary = atob(compact);
    bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  } catch {
    return new Response("Backup repository returned invalid base64", { status: 502 });
  }

  if (bytes.byteLength > MAX_SNAPSHOT_BYTES) {
    return new Response("Backup snapshot exceeds restore-drill size guard", {
      status: 413,
    });
  }

  return new Response(bytes, {
    status: 200,
    headers: {
      "Cache-Control": "no-store",
      "Content-Type": "application/json; charset=utf-8",
    },
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
