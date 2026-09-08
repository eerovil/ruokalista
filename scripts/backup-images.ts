import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { BackupSnapshot } from "../src/backup.ts";
import { MAX_IMAGE_BYTES, readImage } from "../src/image-bytes.ts";
import { parseAndValidateSnapshot } from "../src/restore.ts";

export interface ImageAudit {
  snapshotSha256: string;
  references: number;
  objects: Array<{
    key: string;
    recipeIds: number[];
    status: "readable" | "unavailable" | "invalid";
    bytes?: number;
    sha256?: string;
  }>;
}

export type ImageReader = (key: string) => Promise<Uint8Array | null>;

/** Audit a validated snapshot, including its parts, one distinct key at a time.
 * Digests describe the bytes read NOW; old D1 snapshots contain no image digest.
 * A readable header is not proof of full decodability or historical identity.
 */
export async function auditBackupImages(
  snapshot: BackupSnapshot,
  read: ImageReader,
): Promise<ImageAudit> {
  const keys = new Map<string, number[]>();
  let references = 0;
  for (const recipe of snapshot.tables.recipe) {
    const key = recipe.image_key;
    // Older snapshots may predate the optional image column.
    if (key === null || key === undefined) continue;
    if (typeof key !== "string" || !key.trim() || /[\0\r\n]/.test(key) ||
        new TextEncoder().encode(key).length > 1024) {
      throw new Error("Snapshot contains an invalid image key");
    }
    references += 1;
    const ids = keys.get(key) ?? [];
    ids.push(recipe.id as number);
    keys.set(key, ids);
  }

  const result: ImageAudit = { snapshotSha256: snapshot.sha256, references, objects: [] };
  for (const [key, recipeIds] of keys) {
    const item: ImageAudit["objects"][number] = { key, recipeIds, status: "unavailable" };
    try {
      const data = await read(key);
      if (data !== null) {
        item.status = "invalid";
        if (data.byteLength > 0 && data.byteLength <= MAX_IMAGE_BYTES) {
          const bytes = new Uint8Array(data).buffer;
          const image = readImage(bytes);
          if (image !== null && image.width > 0 && image.height > 0) {
            item.status = "readable";
            item.bytes = data.byteLength;
            const digest = await crypto.subtle.digest("SHA-256", bytes);
            item.sha256 = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
          }
        }
      }
    } catch {
      // Missing objects, permissions and transport failures all mean NOT
      // verified. Never emit a provider error that might contain private data.
      item.status = "unavailable";
    }
    result.objects.push(item);
  }
  return result;
}

export function imageAuditSummary(audit: ImageAudit): string {
  const count = (status: string) => audit.objects.filter((item) => item.status === status).length;
  return `references=${audit.references} objects=${audit.objects.length} readable=${count("readable")} unavailable=${count("unavailable")} invalid=${count("invalid")}`;
}

export function assertImagesReadable(audit: ImageAudit): void {
  if (audit.objects.some((item) => item.status !== "readable")) {
    throw new Error(`Snapshot image audit failed: ${imageAuditSummary(audit)}`);
  }
}

export interface ImageSource {
  bucket: string;
  remote: boolean;
  persistTo?: string;
}

/** Only GET is ever issued; no upload, delete, migration or deployment. */
export function r2ImageArgs(source: ImageSource, key: string): string[] {
  if (!/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(source.bucket)) {
    throw new Error("Image bucket name is invalid");
  }
  if (source.remote && source.persistTo) throw new Error("--persist-to is local-only");
  return ["r2", "object", "get", `${source.bucket}/${key}`, "--pipe",
    source.remote ? "--remote" : "--local",
    ...(source.persistTo ? ["--persist-to", source.persistTo] : [])];
}

export function createR2ImageReader(source: ImageSource, run = spawnSync): ImageReader {
  // Validate configuration even for snapshots without images.
  r2ImageArgs(source, "validation");
  return async (key) => {
    const result = run(process.execPath, [
      // The bin wrapper spawns a child that can outlive a wrapper timeout.
      fileURLToPath(new URL("../node_modules/wrangler/wrangler-dist/cli.js", import.meta.url)),
      ...r2ImageArgs(source, key),
    ], {
      cwd: fileURLToPath(new URL("../", import.meta.url)),
      env: { ...process.env, WRANGLER_SEND_METRICS: "false", CI: "true" },
      // Binary stdout only; cap both memory and the per-object command lifetime.
      maxBuffer: MAX_IMAGE_BYTES + 1,
      timeout: 60_000,
      killSignal: "SIGKILL",
    });
    if (result.error || result.status !== 0) throw new Error("Image could not be read");
    return result.stdout;
  };
}

export interface ImageAuditOptions extends ImageSource {
  snapshot: string;
  report?: string;
}

export function parseImageAuditArgs(args: string[]): ImageAuditOptions {
  const values = new Map<string, string>();
  const flags = new Set<string>();
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    if (values.has(arg) || flags.has(arg)) throw new Error("Duplicate image audit argument");
    if (arg === "--local" || arg === "--remote") flags.add(arg);
    else if (["--snapshot", "--bucket", "--persist-to", "--report"].includes(arg)) {
      const value = args[++i];
      if (!value || value.startsWith("--")) throw new Error("Image audit argument requires a value");
      values.set(arg, value);
    } else throw new Error("Unknown image audit argument");
  }
  const snapshot = values.get("--snapshot");
  const bucket = values.get("--bucket");
  if (!snapshot || !bucket) throw new Error("--snapshot and --bucket are required");
  if (flags.has("--local") === flags.has("--remote")) throw new Error("Choose exactly one of --local or --remote");
  const source = { bucket, remote: flags.has("--remote"), persistTo: values.get("--persist-to") };
  r2ImageArgs(source, "validation");
  return { ...source, snapshot, report: values.get("--report") };
}

/** A read-only entry point: validate the full snapshot before touching R2. */
export async function runImageAudit(
  options: ImageAuditOptions,
  read: ImageReader = createR2ImageReader(options),
): Promise<ImageAudit> {
  const snapshot = await parseAndValidateSnapshot(readFileSync(options.snapshot, "utf8"));
  const audit = await auditBackupImages(snapshot, read);
  if (options.report) {
    // Keys and recipe IDs are private; never overwrite a file or follow a link.
    writeFileSync(options.report, `${JSON.stringify(audit, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  }
  assertImagesReadable(audit);
  return audit;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const audit = await runImageAudit(parseImageAuditArgs(process.argv.slice(2)));
    console.log(`Image availability verified: ${imageAuditSummary(audit)}`);
    console.log("Historical byte identity and future retention are NOT verified by this audit.");
  } catch {
    // Even snapshot parse errors can contain private ingredient/member values.
    console.error("Image audit failed. Check the private report (if requested), snapshot, and bucket access. No database or bucket data was changed.");
    process.exitCode = 1;
  }
}
