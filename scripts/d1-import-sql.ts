export function forD1Import(sql: string): string {
  const lines = sql.split("\n");
  const beginCount = lines.filter((line) => line === "BEGIN TRANSACTION;").length;
  const commitCount = lines.filter((line) => line === "COMMIT;").length;

  if (beginCount !== 1 || commitCount !== 1) {
    throw new Error(
      `restore SQL transaction wrapper changed unexpectedly (BEGIN=${beginCount}, COMMIT=${commitCount})`,
    );
  }

  // Cloudflare's D1 import path rejects explicit SQL transactions. Wrangler's
  // documented import flow expects BEGIN TRANSACTION / COMMIT to be removed
  // from SQLite-style dumps before `d1 execute --file --remote`.
  return lines
    .filter((line) => line !== "BEGIN TRANSACTION;" && line !== "COMMIT;")
    .join("\n");
}
