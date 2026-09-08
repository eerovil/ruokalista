import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import test from "node:test";
import { build } from "esbuild";

import { health, healthResponse } from "../src/health.ts";
import { PRODUCTION_ORIGIN } from "../src/public-origin.ts";
import type { RouteContext } from "../src/router.ts";
import { assertReleaseCheckout, releaseArgs } from "../scripts/deploy-release.mjs";
import {
  RELEASE_VERIFY_ATTEMPTS,
  verifyAndCloseDeployedIssues,
  verifyProductionRelease,
  WORKER_ORIGIN,
} from "../scripts/verify-release.ts";
import type { GitHubRequest } from "../scripts/deployed-issue.ts";
import { migratedDatabase } from "./support/d1.ts";

const SHA = "b".repeat(40);
const OLD = "a".repeat(40);
const PREVIOUS = "9".repeat(40);
const MIGRATIONS = readdirSync(new URL("../migrations/", import.meta.url))
  .filter((name) => name.endsWith(".sql")).sort();
const RELEASE = { sha: SHA, migrations: MIGRATIONS };
const healthy = () => Response.json({ status: "ok", database: "ok", schema: "ok", release: SHA });

function databaseWithHistory() {
  const database = migratedDatabase();
  database.sql.exec("CREATE TABLE d1_migrations (name TEXT PRIMARY KEY)");
  const insert = database.sql.prepare("INSERT INTO d1_migrations VALUES (?)");
  for (const name of MIGRATIONS) insert.run(name);
  return database;
}

test("release build args stamp the SHA and all filenames deterministically", () => {
  const unsorted = [...MIGRATIONS].reverse();
  const args = releaseArgs(SHA, unsorted);
  assert.deepEqual(args, ["deploy", "--define",
    `__RUOKALISTA_RELEASE__:${JSON.stringify(RELEASE)}`, "--tag", SHA]);
  assert.deepEqual(unsorted, [...MIGRATIONS].reverse());
  for (const bad of ["", "main", "a".repeat(39), SHA + "\n"]) {
    assert.throws(() => releaseArgs(bad, MIGRATIONS), /SHA/);
  }
  for (const bad of [[], ["../schema.sql"], ["0001_init.sql\n"], [MIGRATIONS[0], MIGRATIONS[0]]]) {
    assert.throws(() => releaseArgs(SHA, bad), /migration list/);
  }
  assertReleaseCheckout(SHA, SHA, "");
  assertReleaseCheckout(SHA, undefined, "");
  assert.throws(() => assertReleaseCheckout(SHA, OLD, ""), /does not match/);
  assert.throws(() => assertReleaseCheckout(SHA, SHA, " M src/index.ts"), /dirty/);
  assert.throws(() => assertReleaseCheckout(SHA, SHA, "?? migrations/new.sql"), /dirty/);
});

test("a stamped release requires every migration and its active schema columns", async () => {
  const database = databaseWithHistory();
  try {
    const response = await healthResponse(database.db, RELEASE);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.deepEqual(await response.json(), { status: "ok", database: "ok", release: SHA, schema: "ok" });

    // The latest migration is present and even the row count stays the same,
    // but a missing middle migration must fail. Migration numbers alone are not unique.
    database.sql.prepare("DELETE FROM d1_migrations WHERE name = ?").run(MIGRATIONS[8]!);
    database.sql.exec("INSERT INTO d1_migrations VALUES ('unknown.sql')");
    assert.equal((await healthResponse(database.db, RELEASE)).status, 503);
    database.sql.prepare("INSERT INTO d1_migrations VALUES (?)").run(MIGRATIONS[8]!);
    database.sql.exec("DROP TABLE recipe_image_cleanup");
    const failed = await healthResponse(database.db, RELEASE);
    assert.equal(failed.status, 503);
    assert.equal((await failed.json() as { schema: string }).schema, "unready");
  } finally { database.sql.close(); }
});

test("missing migration metadata or empty manifests cannot report verified readiness", async () => {
  const database = migratedDatabase();
  try {
    assert.equal((await healthResponse(database.db, RELEASE)).status, 503);
    assert.equal((await healthResponse(database.db, { sha: SHA, migrations: [] })).status, 503);
  } finally { database.sql.close(); }
});

test("untagged local health stays usable but query and env cannot impersonate a release", async () => {
  const database = migratedDatabase();
  try {
    const url = new URL(`${PRODUCTION_ORIGIN}/health?release=${SHA}`);
    const response = await health({
      url, request: new Request(url, { headers: { "X-Release-SHA": SHA } }), params: {},
      env: { DB: database.db, RELEASE_SHA: SHA },
    } as unknown as RouteContext);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { status: "ok", database: "ok", release: null, schema: "unverified" });
  } finally { database.sql.close(); }
});

test("unreachable and unmigrated databases retain their degraded health responses", async () => {
  for (const [name, first] of [
    ["unreachable", async () => { throw new Error("private connection detail"); }],
    ["unmigrated", async () => ({ tables: 0 })],
  ] as const) {
    const db = { prepare: () => ({ first }) } as unknown as D1Database;
    const response = await healthResponse(db, RELEASE);
    assert.equal(response.status, 503);
    const value = await response.json() as { database: string; schema: string };
    assert.equal(value.database, name);
    assert.equal(value.schema, "unready");
    assert.ok(!JSON.stringify(value).includes("private connection detail"));
  }
});

test("the actual build replacement bakes release identity into the health handler", async () => {
  const define = releaseArgs(SHA, MIGRATIONS)[2]!.split(":").slice(1).join(":");
  const built = await build({
    entryPoints: ["src/health.ts"], bundle: true, write: false, format: "esm",
    platform: "neutral", target: "es2022", define: { __RUOKALISTA_RELEASE__: define },
  });
  const compiled = await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0]!.text).toString("base64")}`);
  const database = databaseWithHistory();
  try {
    const response = await compiled.health({ env: { DB: database.db, RELEASE_SHA: OLD },
      request: new Request(`${PRODUCTION_ORIGIN}/health?release=${OLD}`) });
    assert.equal((await response.json()).release, SHA);
  } finally { database.sql.close(); }
});

interface Probe { url: URL; init: RequestInit }
function probes(override?: (probe: Probe) => Response | undefined | Promise<Response | undefined>) {
  const calls: Probe[] = [];
  const delays: number[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const probe = { url: new URL(String(input)), init: init! };
    calls.push(probe);
    const response = await override?.(probe);
    if (response) return response;
    return probe.url.pathname === "/health" ? healthy() : new Response(null, {
      status: 302, headers: { Location: "/signin" },
    });
  };
  return { calls, delays, fetchImpl, sleep: async (ms: number) => { delays.push(ms); } };
}

for (const scenario of ["public-down", "upstream-down", "wrong-sha", "missing-sha", "schema", "database", "status",
  "auth-open", "auth-missing-location", "auth-external", "auth-wrong-path", "html", "bad-json", "oversized", "timeout"] as const) {
  test(`${scenario}: failed verification never calls the issue-closing API`, async () => {
    const f = probes(({ url }) => {
      if (scenario === "upstream-down" && url.origin === WORKER_ORIGIN) return new Response(null, { status: 503 });
      if (url.origin !== PRODUCTION_ORIGIN) return;
      if (url.pathname === "/recipes") {
        if (scenario === "auth-open") return new Response("private data", { status: 200 });
        if (scenario === "auth-missing-location") return new Response(null, { status: 302 });
        if (scenario === "auth-external") return new Response(null, { status: 302, headers: { Location: "https://other.example/signin" } });
        if (scenario === "auth-wrong-path") return new Response(null, { status: 302, headers: { Location: "/error" } });
        return;
      }
      if (scenario === "public-down") return new Response(null, { status: 502 });
      if (scenario === "html") return new Response("<html>proxy error</html>", { headers: { "Content-Type": "text/html" } });
      if (scenario === "bad-json") return new Response("{", { headers: { "Content-Type": "application/json" } });
      if (scenario === "oversized") return Response.json({ excess: "x".repeat(20_000) });
      if (scenario === "timeout") throw new DOMException("probe timed out", "TimeoutError");
      const value: Record<string, unknown> = { status: "ok", database: "ok", schema: "ok", release: SHA };
      if (scenario === "wrong-sha") value.release = OLD;
      if (scenario === "missing-sha") delete value.release;
      if (scenario === "schema") value.schema = "unready";
      if (scenario === "database") value.database = "unreachable";
      if (scenario === "status") value.status = "degraded";
      return Response.json(value);
    });
    let githubCalls = 0;
    await assert.rejects(verifyAndCloseDeployedIssues("eerovil/ruokalista", SHA, async () => {
      githubCalls += 1;
      throw new Error("must not call GitHub");
    }, f), /Release verification failed after 6 attempts/);
    assert.equal(githubCalls, 0);
    assert.equal(f.delays.length, RELEASE_VERIFY_ATTEMPTS - 1);
    assert.ok(f.calls.length <= RELEASE_VERIFY_ATTEMPTS * 3);
  });
}

test("propagation retries recheck both origins and send no credentials or expected SHA", async () => {
  let publicChecks = 0;
  const f = probes(({ url }) => {
    if (url.origin === PRODUCTION_ORIGIN && url.pathname === "/health" && ++publicChecks === 1) {
      return Response.json({ status: "ok", database: "ok", schema: "ok", release: OLD });
    }
  });
  await verifyProductionRelease(SHA, f);
  assert.equal(f.delays.length, 1);
  assert.deepEqual(f.calls.map(({ url }) => url.origin + url.pathname), [
    WORKER_ORIGIN + "/health", PRODUCTION_ORIGIN + "/health",
    WORKER_ORIGIN + "/health", PRODUCTION_ORIGIN + "/health", PRODUCTION_ORIGIN + "/recipes",
  ]);
  const nonces = new Set(f.calls.map(({ url }) => url.searchParams.get("release_probe")));
  assert.equal(nonces.size, f.calls.length);
  for (const { url, init } of f.calls) {
    assert.ok(!url.href.includes(SHA));
    assert.equal(init.cache, "no-store");
    assert.equal(init.credentials, "omit");
    assert.ok(init.signal instanceof AbortSignal);
    assert.equal(new Headers(init.headers).get("authorization"), null);
    assert.equal(new Headers(init.headers).get("cookie"), null);
    assert.equal(init.redirect, url.pathname === "/recipes" ? "manual" : "error");
  }
});

test("successful live checks preserve catch-up, eligibility and already-closed behavior", async () => {
  const f = probes();
  const patches: string[] = [];
  const pull = (number: number, body: string) => ({ number, body,
    merged_at: "2026-09-08T00:00:00Z", base: { ref: "main", repo: { full_name: "eerovil/ruokalista" } } });
  const request: GitHubRequest = async (method, path) => {
    // Even read-only GitHub calls cannot precede the complete release check.
    assert.equal(f.calls.length, 3);
    if (path.includes("/deployments?")) return [{ id: 2, sha: OLD }, { id: 1, sha: PREVIOUS }];
    if (path.includes("/deployments/2/")) return [{ state: "failure" }];
    if (path.includes("/deployments/1/")) return [{ state: "success" }];
    if (path.includes("/compare/")) return { status: "ahead", commits: [{ sha: OLD }, { sha: SHA }] };
    if (path.endsWith(`${OLD}/pulls`)) return [pull(269, "Issue: #259")];
    if (path.endsWith(`${SHA}/pulls`)) return [pull(270, "Issue: #261"), pull(271, "Related to #263")];
    if (method === "PATCH") { patches.push(path); return { state: "closed" }; }
    if (path.endsWith("/259")) return { number: 259, state: "open" };
    if (path.endsWith("/261")) return { number: 261, state: "closed" };
    throw new Error(`Unexpected ${method} ${path}`);
  };
  const result = await verifyAndCloseDeployedIssues("eerovil/ruokalista", SHA, request, f);
  assert.deepEqual(result.closed, [259]);
  assert.deepEqual(result.alreadyClosed, [261]);
  assert.equal(result.skipped.length, 1);
  assert.deepEqual(patches, ["/repos/eerovil/ruokalista/issues/259"]);
});
