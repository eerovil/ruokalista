import type { Env } from "./env.ts";
import { ingredientsFor } from "./ingredients.ts";
import {
  draftFromJson,
  importFailureMessage,
  MAX_IMAGES,
  streamDraft,
  STRUCTURED_BY,
  type DraftStreamRecord,
  type IntakeImage,
  type IntakeSource,
} from "./intake.ts";
import type { Member } from "./members.ts";

export type IntakeJobStatus = "queued" | "running" | "ready" | "failed";

interface StoredImageRef {
  key: string;
  mediaType: string;
}

interface IntakeJobRow {
  id: string;
  household_id: number;
  created_by: number;
  status: IntakeJobStatus;
  lease_id: string | null;
  source_route: "pasted" | "photographed";
  source_text: string | null;
  image_refs: string | null;
  draft_json: string | null;
  error_message: string | null;
  created_at: string;
  updated_at: string;
}

export interface IntakeJob {
  id: string;
  householdId: number;
  createdBy: number;
  status: IntakeJobStatus;
  sourceRoute: "pasted" | "photographed";
  sourceText: string | null;
  imageRefs: StoredImageRef[];
  draftJson: string | null;
  draftTitle: string | null;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
}

interface IntakeBody {
  sourceText?: unknown;
  image?: unknown;
  mediaType?: unknown;
  images?: unknown;
}

const GENERIC_FAILURE = "Reseptin jäsennys ei onnistunut. Yritä uudelleen.";
const RUNNING_LEASE_MINUTES = 16;
// Wrangler allows 20 retries. Reconcile one delivery before that limit so a
// transient failure while writing the terminal state still gets one last try.
const FAILURE_RECONCILIATION_ATTEMPT = 20;

interface QueueDependencies {
  process?: (env: Env, id: string) => Promise<"done" | "busy">;
  reconcile?: (
    db: D1Database,
    id: string,
    message: string,
  ) => Promise<"done" | "busy">;
}

interface IntakeProcessDependencies {
  structure?: (env: Env, job: IntakeJob) => Promise<string>;
}

/** Parse both today's multi-page body and the older one-photo PWA body. */
export function readImages(body: IntakeBody): IntakeImage[] {
  const mediaTypeOf = (value: unknown): string =>
    typeof value === "string" && value !== "" ? value : "image/jpeg";

  if (Array.isArray(body.images)) {
    return body.images.flatMap((entry): IntakeImage[] => {
      const page = (entry ?? {}) as Record<string, unknown>;
      const base64 = page["image"];
      if (typeof base64 !== "string" || base64 === "") return [];
      return [{ base64, mediaType: mediaTypeOf(page["mediaType"]) }];
    });
  }

  if (typeof body.image === "string" && body.image !== "") {
    return [{ base64: body.image, mediaType: mediaTypeOf(body.mediaType) }];
  }

  return [];
}

/** Persist one source and enqueue only its opaque id. */
export async function createIntakeJob(
  env: Env,
  member: Member,
  body: IntakeBody,
): Promise<IntakeJob> {
  const images = readImages(body);
  if (images.length > MAX_IMAGES) {
    throw new IntakeRefused(`Yhteen reseptiin voi antaa enintään ${MAX_IMAGES} kuvaa.`);
  }

  const sourceText =
    typeof body.sourceText === "string" && body.sourceText.trim() !== ""
      ? body.sourceText
      : null;
  if (images.length === 0 && sourceText === null) {
    throw new IntakeRefused("Anna joko tekstiä tai kuva.");
  }

  const id = crypto.randomUUID();
  const imageRefs: StoredImageRef[] = [];

  try {
    for (let index = 0; index < images.length; index += 1) {
      const image = images[index]!;
      const key = `intake/${id}/${index + 1}`;
      await env.RECIPE_IMAGES.put(key, decodeBase64(image.base64), {
        httpMetadata: { contentType: image.mediaType },
      });
      imageRefs.push({ key, mediaType: image.mediaType });
    }

    await env.DB.prepare(
      `INSERT INTO intake_job
         (id, household_id, created_by, status, source_route, source_text, image_refs)
       VALUES (?, ?, ?, 'queued', ?, ?, ?)`,
    )
      .bind(
        id,
        member.householdId,
        member.id,
        images.length > 0 ? "photographed" : "pasted",
        images.length > 0 ? null : sourceText,
        images.length > 0 ? JSON.stringify(imageRefs) : null,
      )
      .run();
  } catch (error) {
    await deleteImages(env.RECIPE_IMAGES, imageRefs);
    throw error;
  }

  try {
    await env.INTAKE_QUEUE.send({ jobId: id }, { contentType: "json" });
  } catch (error) {
    await markQueuedFailed(env.DB, id, importFailureMessage(error));
  }

  const job = await findIntakeJob(env.DB, id, member.householdId);
  if (job === null) throw new Error("The queued intake job disappeared.");
  return job;
}

export class IntakeRefused extends Error {}

export async function listIntakeJobs(
  db: D1Database,
  householdId: number,
): Promise<IntakeJob[]> {
  const { results } = await db
    .prepare(
      `SELECT * FROM intake_job
        WHERE household_id = ?
        ORDER BY updated_at DESC, created_at DESC`,
    )
    .bind(householdId)
    .all<IntakeJobRow>();
  return results.map(toJob);
}

export async function findIntakeJob(
  db: D1Database,
  id: string,
  householdId: number,
): Promise<IntakeJob | null> {
  const row = await db
    .prepare("SELECT * FROM intake_job WHERE id = ? AND household_id = ?")
    .bind(id, householdId)
    .first<IntakeJobRow>();
  return row === null ? null : toJob(row);
}

/** Retry the retained source; only a failed job can be put back on the queue. */
export async function retryIntakeJob(
  env: Env,
  id: string,
  householdId: number,
): Promise<boolean> {
  const result = await env.DB.prepare(
    `UPDATE intake_job
        SET status = 'queued', error_message = NULL, updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND household_id = ? AND status = 'failed'`,
  )
    .bind(id, householdId)
    .run();
  if (result.meta.changes !== 1) return false;

  try {
    await env.INTAKE_QUEUE.send({ jobId: id }, { contentType: "json" });
  } catch (error) {
    await markQueuedFailed(env.DB, id, importFailureMessage(error));
  }
  return true;
}

/** Remove a completed job once its reviewed draft became a recipe. */
export async function deleteIntakeJob(
  env: Env,
  id: string,
  householdId: number,
): Promise<void> {
  const job = await findIntakeJob(env.DB, id, householdId);
  if (job === null || job.status !== "ready") return;
  await env.DB.prepare("DELETE FROM intake_job WHERE id = ? AND household_id = ?")
    .bind(id, householdId)
    .run();
  await deleteImages(env.RECIPE_IMAGES, job.imageRefs);
}

/** The Queue entrypoint. Every message is explicitly acknowledged or retried. */
export async function processIntakeQueue(
  batch: MessageBatch<{ jobId: string }>,
  env: Env,
  dependencies: QueueDependencies = {},
): Promise<void> {
  const process = dependencies.process ?? processIntakeJob;
  const reconcile = dependencies.reconcile ?? reconcileExhaustedJob;
  for (const message of batch.messages) {
    try {
      const outcome = await process(env, message.body.jobId);
      if (outcome === "busy") {
        message.retry({ delaySeconds: 60 });
      } else message.ack();
    } catch (error) {
      console.log(JSON.stringify({
        event: "intake.queue_retry",
        job_id: message.body.jobId,
        detail: String((error as Error)?.message ?? error),
      }));
      if (message.attempts >= FAILURE_RECONCILIATION_ATTEMPT) {
        try {
          const outcome = await reconcile(
            env.DB,
            message.body.jobId,
            importFailureMessage(error),
          );
          if (outcome === "done") message.ack();
          else message.retry({ delaySeconds: 60 });
        } catch (reconciliationError) {
          console.log(JSON.stringify({
            event: "intake.queue_reconciliation_retry",
            job_id: message.body.jobId,
            detail: String(
              (reconciliationError as Error)?.message ?? reconciliationError,
            ),
          }));
          message.retry({ delaySeconds: 60 });
        }
      } else {
        message.retry({ delaySeconds: 60 });
      }
    }
  }
}

export async function processIntakeJob(
  env: Env,
  id: string,
  dependencies: IntakeProcessDependencies = {},
): Promise<"done" | "busy"> {
  const leaseId = crypto.randomUUID();
  const claimed = await env.DB.prepare(
    `UPDATE intake_job
        SET status = 'running', lease_id = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
        AND (
          status = 'queued'
          OR (status = 'running' AND updated_at <= datetime('now', ?))
        )`,
  )
    .bind(leaseId, id, `-${RUNNING_LEASE_MINUTES} minutes`)
    .run();

  if (claimed.meta.changes !== 1) {
    const row = await env.DB.prepare("SELECT status FROM intake_job WHERE id = ?")
      .bind(id)
      .first<{ status: IntakeJobStatus }>();
    return row?.status === "running" ? "busy" : "done";
  }

  const row = await env.DB.prepare(
    "SELECT * FROM intake_job WHERE id = ? AND lease_id = ?",
  )
    .bind(id, leaseId)
    .first<IntakeJobRow>();
  if (row === null) return "done";
  const job = toJob(row);

  try {
    const source = await sourceForJob(env.RECIPE_IMAGES, job);
    const draftJson = dependencies.structure
      ? await dependencies.structure(env, job)
      : await collectValidatedDraft(
          streamDraft(
            env,
            source,
            await ingredientsFor(env.DB, job.householdId),
          ),
        );

    // `draftStream` validates before complete; validate once more at the
    // persistence boundary so a malformed value can never become a ready job.
    draftFromJson(draftJson, source, STRUCTURED_BY);

    const completed = await env.DB.prepare(
      `UPDATE intake_job
          SET status = 'ready', draft_json = ?, error_message = NULL,
              lease_id = NULL, updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND status = 'running' AND lease_id = ?`,
    )
      .bind(draftJson, id, leaseId)
      .run();
    if (completed.meta.changes !== 1) return "done";
    await deleteImages(env.RECIPE_IMAGES, job.imageRefs);
  } catch (error) {
    await markOwnedFailed(
      env.DB,
      id,
      leaseId,
      importFailureMessage(error),
    );
  }

  return "done";
}

async function sourceForJob(bucket: R2Bucket, job: IntakeJob): Promise<IntakeSource> {
  if (job.sourceRoute === "pasted") {
    return { route: "pasted", text: job.sourceText ?? "" };
  }

  const images: IntakeImage[] = [];
  for (const ref of job.imageRefs) {
    const object = await bucket.get(ref.key);
    if (object === null) throw new Error("A retained intake image is missing.");
    images.push({
      base64: encodeBase64(new Uint8Array(await object.arrayBuffer())),
      mediaType: ref.mediaType,
    });
  }
  if (images.length === 0) throw new Error("The photographed intake has no pages.");
  return { route: "photographed", images };
}

/** Read the existing NDJSON retry protocol without involving a browser. */
export async function collectValidatedDraft(
  stream: ReadableStream<Uint8Array>,
): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let pending = "";
  let draft = "";

  const record = (line: string): string | null => {
    if (line === "") return null;
    const parsed = JSON.parse(line) as DraftStreamRecord;
    if (parsed.type === "delta") draft += parsed.text;
    else if (parsed.type === "restart") draft = "";
    else if (parsed.type === "complete") return draft;
    else if (parsed.type === "failed") throw new Error("The model did not produce a draft.");
    return null;
  };

  while (true) {
    const { value, done } = await reader.read();
    pending += decoder.decode(value, { stream: !done });
    const lines = pending.split("\n");
    pending = lines.pop() ?? "";
    for (const line of lines) {
      const complete = record(line);
      if (complete !== null) return complete;
    }
    if (done) break;
  }

  const complete = record(pending);
  if (complete !== null) return complete;
  throw new Error("The model stream ended without a completed draft.");
}

async function markQueuedFailed(
  db: D1Database,
  id: string,
  message: string,
): Promise<void> {
  await db.prepare(
    `UPDATE intake_job
        SET status = 'failed', lease_id = NULL, draft_json = NULL, error_message = ?,
            updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND status = 'queued'`,
  )
    .bind(message || GENERIC_FAILURE, id)
    .run();
}

async function markOwnedFailed(
  db: D1Database,
  id: string,
  leaseId: string,
  message: string,
): Promise<void> {
  await db.prepare(
    `UPDATE intake_job
        SET status = 'failed', lease_id = NULL, draft_json = NULL,
            error_message = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND status = 'running' AND lease_id = ?`,
  )
    .bind(message || GENERIC_FAILURE, id, leaseId)
    .run();
}

async function reconcileExhaustedJob(
  db: D1Database,
  id: string,
  message: string,
): Promise<"done" | "busy"> {
  const failed = await db.prepare(
    `UPDATE intake_job
        SET status = 'failed', lease_id = NULL, draft_json = NULL,
            error_message = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
        AND (
          status = 'queued'
          OR (status = 'running' AND updated_at <= datetime('now', ?))
        )`,
  )
    .bind(message || GENERIC_FAILURE, id, `-${RUNNING_LEASE_MINUTES} minutes`)
    .run();
  if (failed.meta.changes === 1) return "done";

  const row = await db.prepare("SELECT status FROM intake_job WHERE id = ?")
    .bind(id)
    .first<{ status: IntakeJobStatus }>();
  return row?.status === "running" || row?.status === "queued" ? "busy" : "done";
}

/** Recreate lost queue messages and bound orphaned temporary photographs. */
export async function maintainIntakeJobs(env: Env): Promise<void> {
  const { results } = await env.DB.prepare(
    `SELECT id, status FROM intake_job
      WHERE status = 'queued'
         OR (status = 'running' AND updated_at <= datetime('now', ?))
      ORDER BY updated_at
      LIMIT 100`,
  )
    .bind(`-${RUNNING_LEASE_MINUTES} minutes`)
    .all<{ id: string; status: IntakeJobStatus }>();

  for (const job of results) {
    if (job.status === "running") {
      const reset = await env.DB.prepare(
        `UPDATE intake_job
            SET status = 'queued', lease_id = NULL, updated_at = CURRENT_TIMESTAMP
          WHERE id = ? AND status = 'running'
            AND updated_at <= datetime('now', ?)`,
      )
        .bind(job.id, `-${RUNNING_LEASE_MINUTES} minutes`)
        .run();
      if (reset.meta.changes !== 1) continue;
    }
    await env.INTAKE_QUEUE.send({ jobId: job.id }, { contentType: "json" });
  }

  await deleteOrphanedIntakeImages(env);
}

async function deleteOrphanedIntakeImages(env: Env): Promise<void> {
  const { results } = await env.DB.prepare(
    "SELECT image_refs FROM intake_job WHERE image_refs IS NOT NULL",
  ).all<{ image_refs: string }>();
  const referenced = new Set(
    results.flatMap((row) => parseImageRefs(row.image_refs).map((ref) => ref.key)),
  );
  const oldestOrphan = Date.now() - 24 * 60 * 60 * 1000;
  let cursor: string | undefined;
  do {
    const listed = await env.RECIPE_IMAGES.list({ prefix: "intake/", cursor });
    for (const object of listed.objects) {
      if (!referenced.has(object.key) && object.uploaded.getTime() <= oldestOrphan) {
        await env.RECIPE_IMAGES.delete(object.key);
      }
    }
    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor !== undefined);
}

async function deleteImages(bucket: R2Bucket, refs: StoredImageRef[]): Promise<void> {
  for (const ref of refs) {
    try {
      await bucket.delete(ref.key);
    } catch (error) {
      console.log(JSON.stringify({
        event: "intake.image_cleanup_failed",
        key: ref.key,
        detail: String((error as Error)?.message ?? error),
      }));
    }
  }
}

function toJob(row: IntakeJobRow): IntakeJob {
  return {
    id: row.id,
    householdId: row.household_id,
    createdBy: row.created_by,
    status: row.status,
    sourceRoute: row.source_route,
    sourceText: row.source_text,
    imageRefs: parseImageRefs(row.image_refs),
    draftJson: row.draft_json,
    draftTitle: draftTitle(row.draft_json),
    errorMessage: row.error_message,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function parseImageRefs(json: string | null): StoredImageRef[] {
  if (json === null) return [];
  try {
    const parsed = JSON.parse(json) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((entry): StoredImageRef[] => {
      const ref = (entry ?? {}) as Record<string, unknown>;
      return typeof ref["key"] === "string" && typeof ref["mediaType"] === "string"
        ? [{ key: ref["key"], mediaType: ref["mediaType"] }]
        : [];
    });
  } catch {
    return [];
  }
}

function draftTitle(json: string | null): string | null {
  if (json === null) return null;
  try {
    const parsed = JSON.parse(json) as Record<string, unknown>;
    return typeof parsed["title"] === "string" ? parsed["title"] : null;
  } catch {
    return null;
  }
}

function decodeBase64(value: string): Uint8Array {
  const binary = atob(value);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function encodeBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunk) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunk));
  }
  return btoa(binary);
}
