const BACKUP_REPOSITORY = "eerovil/ruokalista-backup";
const BACKUP_PATH = "snapshot.json";
const GITHUB_API_VERSION = "2026-03-10";
const MAX_SNAPSHOT_BYTES = 50 * 1024 * 1024;
const TRANSIENT_ATTEMPTS = 3;

export const BACKUP_TABLES = [
  { name: "household", orderBy: "id" },
  { name: "member", orderBy: "id" },
  { name: "intake_job", orderBy: "created_at, id" },
  { name: "ingredient", orderBy: "id" },
  { name: "recipe", orderBy: "id" },
  { name: "recipe_step", orderBy: "recipe_id, position" },
  { name: "ingredient_line", orderBy: "id" },
  { name: "planned_batch", orderBy: "id" },
  { name: "batch_occurrence", orderBy: "batch_id, date, slot" },
  { name: "pantry_entry", orderBy: "id" },
  { name: "recipe_preference", orderBy: "id" },
  { name: "ingredient_product", orderBy: "id" },
  { name: "recipe_ingredient_product", orderBy: "id" },
] as const;

export type BackupTableName = (typeof BACKUP_TABLES)[number]["name"];

type JsonPrimitive = string | number | boolean | null;
type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
type BackupRow = Record<string, JsonValue>;

export interface BackupSchemaEntry {
  type: string;
  name: string;
  tbl_name: string;
  sql: string;
}

export interface BackupSnapshotUnsigned {
  format_version: 1;
  scheduled_at: string;
  captured_at: string;
  schema: BackupSchemaEntry[];
  row_counts: Record<BackupTableName, number>;
  tables: Record<BackupTableName, BackupRow[]>;
}

export interface BackupSnapshot extends BackupSnapshotUnsigned {
  sha256: string;
}

export interface BackupRunResult {
  scheduledAt: string;
  capturedAt: string;
  digest: string;
  rowCounts: Record<BackupTableName, number>;
  committed: boolean;
}

interface BackupEnv {
  DB: D1Database;
  BACKUP_GITHUB_TOKEN?: string;
}

interface GithubContent {
  sha: string;
  size: number;
  content?: string;
  encoding?: string;
}

interface CurrentBackup {
  sha: string;
  scheduledAt: string | null;
}

interface BackupDependencies {
  fetchImpl?: typeof fetch;
  sleep?: (milliseconds: number) => Promise<void>;
  now?: () => Date;
}

/**
 * Read all durable application tables and their schema in one D1 batch. D1
 * executes a batch transactionally, so the rows describe one coherent point in
 * time instead of one table being captured before another table's write.
 */
export async function createBackupSnapshot(
  db: D1Database,
  scheduledAt: string,
  capturedAt: string,
): Promise<BackupSnapshot> {
  const schemaNames = BACKUP_TABLES.map(({ name }) => `'${name}'`).join(", ");
  const schemaStatement = db.prepare(
    `SELECT type, name, tbl_name, sql
       FROM sqlite_schema
      WHERE sql IS NOT NULL
        AND (name IN (${schemaNames}) OR tbl_name IN (${schemaNames}))
      ORDER BY type, name`,
  );
  const tableStatements = BACKUP_TABLES.map(({ name, orderBy }) =>
    db.prepare(`SELECT * FROM ${name} ORDER BY ${orderBy}`),
  );

  const results = await db.batch<Record<string, unknown>>([
    schemaStatement,
    ...tableStatements,
  ]);
  const schemaResult = results[0];
  if (!schemaResult) throw new Error("backup schema query returned no result");

  const schema = schemaResult.results.map(toSchemaEntry);
  const rowCounts = {} as Record<BackupTableName, number>;
  const tables = {} as Record<BackupTableName, BackupRow[]>;

  BACKUP_TABLES.forEach(({ name }, index) => {
    const result = results[index + 1];
    if (!result) throw new Error(`backup query returned no result for ${name}`);
    const rows = result.results.map(toBackupRow);
    tables[name] = rows;
    rowCounts[name] = rows.length;
  });

  const unsigned: BackupSnapshotUnsigned = {
    format_version: 1,
    scheduled_at: scheduledAt,
    captured_at: capturedAt,
    schema,
    row_counts: rowCounts,
    tables,
  };

  return {
    ...unsigned,
    sha256: await sha256Hex(canonicalJson(unsigned)),
  };
}

export function serializeBackupSnapshot(snapshot: BackupSnapshot): string {
  return `${canonicalJson(snapshot)}\n`;
}

/** Canonical JSON keeps digests stable even if object property insertion order changes. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("backup contains a non-finite number");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(",")}}`;
  }
  throw new Error(`backup contains unsupported value type: ${typeof value}`);
}

export async function runNightlyBackup(
  env: BackupEnv,
  scheduledTime: number,
  dependencies: BackupDependencies = {},
): Promise<BackupRunResult> {
  const token = env.BACKUP_GITHUB_TOKEN;
  if (!token) throw new Error("BACKUP_GITHUB_TOKEN is not configured");

  const scheduledAt = new Date(scheduledTime).toISOString();
  const capturedAt = (dependencies.now ?? (() => new Date()))().toISOString();
  const snapshot = await createBackupSnapshot(env.DB, scheduledAt, capturedAt);
  const serialized = serializeBackupSnapshot(snapshot);
  const committed = await writeSnapshotToGitHub(
    serialized,
    scheduledAt,
    token,
    dependencies,
  );

  console.log(
    JSON.stringify({
      event: "backup.completed",
      scheduled_at: scheduledAt,
      captured_at: capturedAt,
      row_counts: snapshot.row_counts,
      sha256: snapshot.sha256,
      committed,
    }),
  );

  return {
    scheduledAt,
    capturedAt,
    digest: snapshot.sha256,
    rowCounts: snapshot.row_counts,
    committed,
  };
}

export async function writeSnapshotToGitHub(
  serialized: string,
  scheduledAt: string,
  token: string,
  dependencies: BackupDependencies = {},
): Promise<boolean> {
  const fetchImpl = dependencies.fetchImpl ?? fetch;
  const sleep = dependencies.sleep ?? defaultSleep;
  const bytes = new TextEncoder().encode(serialized);
  if (bytes.byteLength > MAX_SNAPSHOT_BYTES) {
    throw new Error(
      `backup snapshot is ${bytes.byteLength} bytes; revisit storage before it approaches GitHub's 100 MiB object limit`,
    );
  }
  const content = bytesToBase64(bytes);

  let current = await fetchCurrentBackup(token, fetchImpl, sleep);
  if (current?.scheduledAt === scheduledAt) return false;

  for (let conflictAttempt = 0; conflictAttempt < 2; conflictAttempt += 1) {
    const response = await githubRequest(
      contentsUrl(),
      {
        method: "PUT",
        headers: githubHeaders(token, "application/vnd.github+json"),
        body: JSON.stringify({
          message: `backup: ${scheduledAt}`,
          content,
          ...(current ? { sha: current.sha } : {}),
        }),
      },
      fetchImpl,
      sleep,
    );

    if (response.status === 200 || response.status === 201) return true;
    if (response.status !== 409 || conflictAttempt === 1) {
      throw new Error(`GitHub backup write failed with HTTP ${response.status}`);
    }

    current = await fetchCurrentBackup(token, fetchImpl, sleep);
    if (current?.scheduledAt === scheduledAt) return false;
  }

  throw new Error("GitHub backup write exhausted conflict retries");
}

export function backupIsStale(
  scheduledAt: string,
  now: Date,
  maxAgeMilliseconds = 36 * 60 * 60 * 1000,
): boolean {
  const captured = Date.parse(scheduledAt);
  if (!Number.isFinite(captured)) return true;
  return now.getTime() - captured > maxAgeMilliseconds;
}

async function fetchCurrentBackup(
  token: string,
  fetchImpl: typeof fetch,
  sleep: (milliseconds: number) => Promise<void>,
): Promise<CurrentBackup | null> {
  const response = await githubRequest(
    contentsUrl(),
    { headers: githubHeaders(token, "application/vnd.github.object+json") },
    fetchImpl,
    sleep,
  );
  if (response.status === 404) return null;
  if (!response.ok) {
    throw new Error(`GitHub backup read failed with HTTP ${response.status}`);
  }

  const metadata = (await response.json()) as GithubContent;
  if (metadata.size > MAX_SNAPSHOT_BYTES) {
    throw new Error(
      `existing backup is ${metadata.size} bytes; revisit storage before it approaches GitHub's 100 MiB object limit`,
    );
  }

  let text: string;
  if (metadata.encoding === "base64" && metadata.content) {
    text = base64ToUtf8(metadata.content);
  } else {
    const raw = await githubRequest(
      contentsUrl(),
      { headers: githubHeaders(token, "application/vnd.github.raw+json") },
      fetchImpl,
      sleep,
    );
    if (!raw.ok) {
      throw new Error(`GitHub backup raw read failed with HTTP ${raw.status}`);
    }
    text = await raw.text();
  }

  let scheduledAt: string | null = null;
  try {
    const parsed = JSON.parse(text) as { scheduled_at?: unknown };
    if (typeof parsed.scheduled_at === "string") scheduledAt = parsed.scheduled_at;
  } catch {
    // A corrupt previous file should not block replacement. #63 validates a
    // snapshot before restore; this read only needs the idempotency key.
  }

  return { sha: metadata.sha, scheduledAt };
}

async function githubRequest(
  input: RequestInfo | URL,
  init: RequestInit,
  fetchImpl: typeof fetch,
  sleep: (milliseconds: number) => Promise<void>,
): Promise<Response> {
  let lastError: unknown;

  for (let attempt = 0; attempt < TRANSIENT_ATTEMPTS; attempt += 1) {
    try {
      const response = await fetchImpl(input, init);
      const transient = response.status === 429 || response.status >= 500;
      if (!transient || attempt === TRANSIENT_ATTEMPTS - 1) return response;

      const retryAfterHeader = response.headers.get("retry-after");
      const retryAfter = retryAfterHeader === null ? Number.NaN : Number(retryAfterHeader);
      const delay = Number.isFinite(retryAfter) && retryAfter >= 0
        ? retryAfter * 1000
        : 100 * 2 ** attempt;
      await sleep(delay);
    } catch (error) {
      lastError = error;
      if (attempt === TRANSIENT_ATTEMPTS - 1) throw error;
      await sleep(100 * 2 ** attempt);
    }
  }

  throw lastError instanceof Error ? lastError : new Error("GitHub request failed");
}

function githubHeaders(token: string, accept: string): HeadersInit {
  return {
    Accept: accept,
    Authorization: `Bearer ${token}`,
    "X-GitHub-Api-Version": GITHUB_API_VERSION,
    "User-Agent": "ruokalista-backup",
  };
}

function contentsUrl(): string {
  return `https://api.github.com/repos/${BACKUP_REPOSITORY}/contents/${BACKUP_PATH}`;
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

export function utf8ToBase64(value: string): string {
  return bytesToBase64(new TextEncoder().encode(value));
}

export function base64ToUtf8(value: string): string {
  const binary = atob(value.replace(/\s/g, ""));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return new TextDecoder().decode(bytes);
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

function toSchemaEntry(row: Record<string, unknown>): BackupSchemaEntry {
  if (
    typeof row.type !== "string" ||
    typeof row.name !== "string" ||
    typeof row.tbl_name !== "string" ||
    typeof row.sql !== "string"
  ) {
    throw new Error("backup schema row has an unexpected shape");
  }
  return {
    type: row.type,
    name: row.name,
    tbl_name: row.tbl_name,
    sql: row.sql,
  };
}

function toBackupRow(row: Record<string, unknown>): BackupRow {
  const converted: BackupRow = {};
  for (const [key, value] of Object.entries(row)) {
    if (
      value === null ||
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "boolean"
    ) {
      converted[key] = value;
      continue;
    }
    throw new Error(`backup row column ${key} has unsupported value type`);
  }
  return converted;
}

function defaultSleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
