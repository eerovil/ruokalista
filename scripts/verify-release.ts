import { PRODUCTION_ORIGIN } from "../src/public-origin.ts";
import { closeDeployedIssues, type GitHubRequest } from "./deployed-issue.ts";

export const WORKER_ORIGIN = "https://ruokalista.eerovil.workers.dev";
export const RELEASE_VERIFY_ATTEMPTS = 6;
export const RELEASE_REQUEST_TIMEOUT_MS = 10_000;
const MAX_HEALTH_BYTES = 16 * 1024;

interface VerificationDependencies {
  fetchImpl?: typeof fetch;
  sleep?: (milliseconds: number) => Promise<void>;
}

async function healthJson(response: Response): Promise<Record<string, unknown>> {
  if (!response.headers.get("content-type")?.toLowerCase().includes("application/json")) {
    await response.body?.cancel();
    throw new Error("health is not JSON");
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error("health has no body");
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > MAX_HEALTH_BYTES) throw new Error("health response is too large");
      chunks.push(value);
    }
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  const value: unknown = JSON.parse(new TextDecoder().decode(bytes));
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("health has an invalid shape");
  }
  return value as Record<string, unknown>;
}

/** Probe upstream AND the actual browser-facing site, without credentials. */
export async function verifyProductionRelease(
  sha: string,
  dependencies: VerificationDependencies = {},
): Promise<void> {
  if (typeof sha !== "string" || sha.length !== 40 || !/^[0-9a-f]{40}$/.test(sha)) throw new Error("GITHUB_SHA is invalid");
  const fetchImpl = dependencies.fetchImpl ?? fetch;
  const sleep = dependencies.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  let lastError: unknown;
  for (let attempt = 1; attempt <= RELEASE_VERIFY_ATTEMPTS; attempt += 1) {
    try {
      for (const origin of [WORKER_ORIGIN, PRODUCTION_ORIGIN]) {
        const url = new URL("/health", origin);
        url.searchParams.set("release_probe", crypto.randomUUID());
        const response = await fetchImpl(url, {
          redirect: "error", cache: "no-store", credentials: "omit",
          headers: { "Cache-Control": "no-cache", Accept: "application/json" },
          signal: AbortSignal.timeout(RELEASE_REQUEST_TIMEOUT_MS),
        });
        if (response.status !== 200) {
          await response.body?.cancel();
          throw new Error(`${origin}: health HTTP ${response.status}`);
        }
        const health = await healthJson(response);
        if (health.status !== "ok" || health.database !== "ok" || health.schema !== "ok") {
          throw new Error(`${origin}: database/schema readiness failed`);
        }
        if (health.release !== sha) throw new Error(`${origin}: wrong or missing release SHA`);
      }

      const url = new URL("/recipes", PRODUCTION_ORIGIN);
      url.searchParams.set("release_probe", crypto.randomUUID());
      const response = await fetchImpl(url, {
        redirect: "manual", cache: "no-store", credentials: "omit",
        headers: { "Cache-Control": "no-cache" },
        signal: AbortSignal.timeout(RELEASE_REQUEST_TIMEOUT_MS),
      });
      await response.body?.cancel();
      const location = response.headers.get("location");
      const target = location ? new URL(location, PRODUCTION_ORIGIN) : null;
      if (response.status !== 302 || target?.origin !== PRODUCTION_ORIGIN ||
          target.pathname !== "/signin" || target.username || target.password) {
        throw new Error("Public signed-out recipe screen does not redirect to sign-in");
      }
      return;
    } catch (error) {
      lastError = error;
      if (attempt < RELEASE_VERIFY_ATTEMPTS) await sleep(attempt * 1000);
    }
  }
  throw new Error(`Release verification failed after ${RELEASE_VERIFY_ATTEMPTS} attempts: ${String(lastError)}`);
}

/** The CLI uses this boundary: failed live verification cannot call GitHub. */
export async function verifyAndCloseDeployedIssues(
  repository: string,
  sha: string,
  request: GitHubRequest,
  dependencies: VerificationDependencies = {},
) {
  await verifyProductionRelease(sha, dependencies);
  return closeDeployedIssues(repository, sha, request);
}
