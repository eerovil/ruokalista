import type { RouteContext } from "./router.ts";

export interface ReleaseManifest {
  sha: string;
  migrations: readonly string[];
}

// scripts/deploy-release.mjs replaces this identifier in the built artifact.
// Plain local development has no release claim; neither env nor a request can
// supply one. Never commit a generated SHA: a commit cannot contain its own id.
declare const __RUOKALISTA_RELEASE__: ReleaseManifest;
const RELEASE = typeof __RUOKALISTA_RELEASE__ === "undefined"
  ? null
  : __RUOKALISTA_RELEASE__;

export function health({ env }: RouteContext): Promise<Response> {
  return healthResponse(env.DB, RELEASE);
}

/** Only metadata and a zero-row schema probe; no private recipe data is read. */
export async function healthResponse(
  db: D1Database,
  release: ReleaseManifest | null,
): Promise<Response> {
  let database: "ok" | "unmigrated" | "unreachable" = "unreachable";
  let schema: "ok" | "unready" | "unverified" = "unverified";
  try {
    const row = await db.prepare(
      "SELECT count(*) AS tables FROM sqlite_master WHERE type = 'table' AND name = 'household'",
    ).first<{ tables: number }>();
    database = row && row.tables > 0 ? "ok" : "unmigrated";
  } catch {
    database = "unreachable";
  }

  if (release !== null) {
    schema = "unready";
    if (database === "ok") {
      try {
        const { results } = await db.prepare("SELECT name FROM d1_migrations")
          .all<{ name: string }>();
        const applied = new Set(results.map((row) => row.name));
        // Check every expected filename, not just the latest number or a count:
        // several historical migrations intentionally share a number.
        if (release.migrations.length > 0 &&
            release.migrations.every((name) => applied.has(name))) {
          await db.prepare(
            `SELECT r.revision, r.parent_id, r.image_key, b.instance_key, c.image_key
               FROM recipe AS r
               LEFT JOIN planned_batch AS b ON 0
               LEFT JOIN recipe_image_cleanup AS c ON 0
              LIMIT 0`,
          ).all();
          schema = "ok";
        }
      } catch {
        // Missing migration metadata/columns and D1 errors all fail readiness.
        // Do not put database error strings or schema details on a public route.
        schema = "unready";
      }
    }
  }

  // Untagged local builds keep the health contract used to start browser tests,
  // but release verification separately requires a matching SHA and schema=ok.
  const ok = database === "ok" && (release === null || schema === "ok");
  return Response.json(
    { status: ok ? "ok" : "degraded", database, release: release?.sha ?? null, schema },
    { status: ok ? 200 : 503, headers: { "Cache-Control": "no-store" } },
  );
}
