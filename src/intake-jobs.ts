import type { Env } from "./env.ts";
import { ingredientsFor } from "./ingredients.ts";
import {
  draftFromJson,
  importFailureMessage,
  MAX_IMAGES,
  MAX_PAGE_BASE64_BYTES,
  MAX_PAGES_BASE64_BYTES,
  streamDraft,
  STRUCTURED_BY,
  type DraftStreamRecord,
  type IntakeImage,
  type IntakeSource,
} from "./intake.ts";
import type { Member } from "./members.ts";
import { extensionFor } from "./image-bytes.ts";
import {
  fetchRecipeImage,
  fetchRecipePage,
  normaliseRecipeUrl,
  PageRefused,
  type FetchFailure,
  type PageFetcher,
} from "./recipe-fetch.ts";
import { readMode, streamRecipeEdit, type PromptMode } from "./recipe-prompt-edit.ts";
import { findRecipe, type Recipe } from "./recipes.ts";

export type IntakeJobStatus = "queued" | "running" | "ready" | "failed";

/** The three ways a recipe arrives (#192 added the third). */
export type IntakeJobRoute = "pasted" | "photographed" | "linked";

/** An image object in R2 that belongs to a job and dies with it. */
export interface StoredImageRef {
  key: string;
  mediaType: string;
}

interface IntakeJobRow {
  id: string;
  household_id: number;
  created_by: number;
  status: IntakeJobStatus;
  lease_id: string | null;
  source_route: IntakeJobRoute;
  source_text: string | null;
  source_url: string | null;
  import_guidance: string | null;
  image_refs: string | null;
  page_image_key: string | null;
  page_image_type: string | null;
  draft_json: string | null;
  error_message: string | null;
  target_recipe_id: number | null;
  target_revision: number | null;
  edit_mode: PromptMode | null;
  target_recipe_json: string | null;
  created_at: string;
  updated_at: string;
}

export interface IntakeJob {
  id: string;
  householdId: number;
  createdBy: number;
  status: IntakeJobStatus;
  sourceRoute: IntakeJobRoute;
  sourceText: string | null;
  /** The address a linked import reads, and null on every other route. */
  sourceUrl: string | null;
  /** Optional member guidance for structuring a linked page (#219). */
  importGuidance: string | null;
  imageRefs: StoredImageRef[];
  /** The picture found on a linked import's page (#205), or null. */
  pageImage: StoredImageRef | null;
  draftJson: string | null;
  draftTitle: string | null;
  errorMessage: string | null;
  targetRecipeId: number | null;
  targetRevision: number | null;
  editMode: PromptMode | null;
  targetRecipe: Recipe | null;
  createdAt: string;
  updatedAt: string;
}

interface IntakeBody {
  sourceText?: unknown;
  image?: unknown;
  mediaType?: unknown;
  images?: unknown;
  url?: unknown;
  guidance?: unknown;
  recipeId?: unknown;
  mode?: unknown;
}

const GENERIC_FAILURE = "Reseptin jäsennys ei onnistunut. Yritä uudelleen.";
export const MAX_IMPORT_GUIDANCE = 2_000;
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
  structure?: (env: Env, job: IntakeJob, source: IntakeSource) => Promise<string>;
  /**
   * Stands in for `fetch` when a linked job reads its page, so
   * `dev/check-intake-jobs.ts` can drive the whole lifecycle with no network.
   */
  fetchPage?: PageFetcher;
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
  const targetRecipeId = readTargetRecipeId(body.recipeId);
  const targetRecipe = targetRecipeId === null
    ? null
    : await findRecipe(env.DB, member.householdId, targetRecipeId);
  if (targetRecipeId !== null && targetRecipe === null) {
    throw new IntakeRefused("Muokattavaa reseptiä ei löytynyt.");
  }
  let editMode: PromptMode | null = null;
  if (targetRecipe !== null) {
    try {
      editMode = readMode(body.mode);
    } catch {
      throw new IntakeRefused("Valitse, täydennetäänkö nykyistä vai korvataanko se.");
    }
  }
  const images = readImages(body);
  if (images.length > MAX_IMAGES) {
    throw new IntakeRefused(`Yhteen reseptiin voi antaa enintään ${MAX_IMAGES} kuvaa.`);
  }

  // What the pages weigh, refused in Finnish rather than left to fail further
  // in (#218). The browser applies the same limits as each page is chosen, so
  // reaching here means something sent pages that screen never prepared.
  const pageBytes = images.map((image) => image.base64.length);
  const totalBytes = pageBytes.reduce((total, bytes) => total + bytes, 0);
  if (images.length > 0) {
    // The one line that says what an import was actually asked to carry. A
    // photographed import that goes wrong is otherwise a job id and a guess.
    console.log(JSON.stringify({
      event: "intake.pages_received",
      pages: images.length,
      base64_bytes: totalBytes,
      largest_page_bytes: Math.max(...pageBytes),
    }));
  }
  if (pageBytes.some((bytes) => bytes > MAX_PAGE_BASE64_BYTES)) {
    throw new IntakeRefused(
      "Yksi kuvista on liian suuri lähetettäväksi. Ota se uudelleen.",
    );
  }
  if (totalBytes > MAX_PAGES_BASE64_BYTES) {
    throw new IntakeRefused(
      "Kuvat ovat yhteensä liian suuria. Poista jokin sivu ja yritä uudelleen.",
    );
  }

  const sourceText =
    typeof body.sourceText === "string" && body.sourceText.trim() !== ""
      ? body.sourceText
      : null;

  // A photograph wins over an address and an address over an already-pasted
  // box, so the recipe that gets imported is the newest thing the member
  // reached for. The address is checked here rather than in the consumer: an
  // address that could never be fetched should be refused while the member is
  // still looking at the field they typed it into.
  const sourceUrl = images.length === 0 ? readIntakeUrl(body.url) : null;

  if (images.length === 0 && sourceUrl === null && sourceText === null) {
    throw new IntakeRefused("Anna reseptin osoite, tekstiä tai kuva.");
  }

  const route: IntakeJobRoute =
    images.length > 0 ? "photographed" : sourceUrl !== null ? "linked" : "pasted";
  const importGuidance = route === "linked" ? readImportGuidance(body.guidance) : null;

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
         (id, household_id, created_by, status, source_route, source_text,
          source_url, import_guidance, image_refs, target_recipe_id,
          target_revision, edit_mode, target_recipe_json)
       VALUES (?, ?, ?, 'queued', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        id,
        member.householdId,
        member.id,
        route,
        // A linked job starts with no text at all: the page has not been read
        // yet, and it is the consumer that reads it.
        route === "pasted" ? sourceText : null,
        sourceUrl,
        importGuidance,
        route === "photographed" ? JSON.stringify(imageRefs) : null,
        targetRecipe?.id ?? null,
        targetRecipe?.revision ?? null,
        editMode,
        targetRecipe === null ? null : JSON.stringify(targetRecipe),
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

function readImportGuidance(value: unknown): string | null {
  if (typeof value !== "string" || value.trim() === "") return null;
  const guidance = value.trim();
  if (guidance.length > MAX_IMPORT_GUIDANCE) {
    throw new IntakeRefused(
      `Lisäohje voi olla enintään ${MAX_IMPORT_GUIDANCE} merkkiä.`,
    );
  }
  return guidance;
}

/** The server-owned edit snapshot, only when every durable identity agrees. */
export function editTargetFor(job: IntakeJob): Recipe | null {
  const target = job.targetRecipe;
  if (job.targetRecipeId === null) return null;
  if (
    target === null ||
    job.editMode === null ||
    job.targetRevision === null ||
    target.id !== job.targetRecipeId ||
    target.revision !== job.targetRevision ||
    target.householdId !== job.householdId
  ) {
    throw new IntakeRefused("Muokkaustyön reseptitiedot eivät täsmää.");
  }
  return target;
}

function readTargetRecipeId(value: unknown): number | null {
  if (value === undefined || value === null || value === "") return null;
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id <= 0) {
    throw new IntakeRefused("Muokattavaa reseptiä ei löytynyt.");
  }
  return id;
}

/**
 * The address a linked import will read, or null when none was given.
 *
 * `normaliseRecipeUrl` is the same check the fetch itself goes through, so an
 * address that could not be fetched is refused here rather than becoming a job
 * that is certain to fail. It also fills in a missing scheme, which is what
 * lets a member paste `kotikokki.fi/resepti` the way people actually do.
 */
function readIntakeUrl(value: unknown): string | null {
  if (typeof value !== "string" || value.trim() === "") return null;
  try {
    const url = normaliseRecipeUrl(value);
    const host = url.hostname.toLowerCase();
    // K-Ruoka challenge-blocks server fetches. Do not work around that browser
    // challenge or depend on its undocumented frontend API (#246).
    if (host === "k-ruoka.fi" || host === "www.k-ruoka.fi") {
      throw new IntakeRefused(
        "K-Ruoka-linkkejä ei tueta. Liitä reseptin teksti tai tuo resepti kuvasta.",
      );
    }
    return url.toString();
  } catch (error) {
    if (error instanceof IntakeRefused) throw error;
    throw new IntakeRefused(LINK_REFUSALS.invalid_url);
  }
}

/**
 * Why a web address gave up no recipe, in Finnish (#192).
 *
 * The fetch names its refusals in a closed set of English words; this is the
 * one place each becomes something a household reads. A page's own error text
 * never becomes a Finnish message, and never reaches a screen.
 */
const LINK_REFUSALS: Record<FetchFailure, string> = {
  invalid_url: "Osoite ei näytä nettiosoitteelta. Tarkista linkki.",
  unreachable:
    "Sivua ei saatu auki. Tarkista linkki tai kokeile hetken kuluttua uudelleen.",
  not_a_page: "Osoitteesta ei löytynyt nettisivua.",
  too_large: "Sivu on liian suuri luettavaksi.",
  no_recipe:
    "Sivulta ei löytynyt reseptiä. Voit liittää tekstin itse tuontilomakkeelle.",
};

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
  await deleteImages(
    env.RECIPE_IMAGES,
    job.pageImage === null ? job.imageRefs : [...job.imageRefs, job.pageImage],
  );
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
    const source = await sourceForJob(env, job, dependencies.fetchPage);
    const target = editTargetFor(job);
    if (
      job.targetRecipeId !== null &&
      (target === null || job.editMode === null)
    ) {
      throw new IntakeRefused(
        "Resepti on muuttunut tai poistettu. Aloita muokkaus uudelleen.",
      );
    }
    const draftJson = dependencies.structure
      ? await dependencies.structure(env, job, source)
      : await collectValidatedDraft(
          target === null
            ? streamDraft(
                env,
                source,
                await ingredientsFor(env.DB, job.householdId),
              )
            : streamRecipeEdit(
                env,
                target,
                source,
                await ingredientsFor(env.DB, job.householdId),
                job.editMode!,
              ),
        );

    // `draftStream` validates before complete; validate once more at the
    // persistence boundary so a malformed value can never become a ready job.
    draftFromJson(
      draftJson,
      target === null ? source : { route: "pasted", text: target.sourceText },
      STRUCTURED_BY,
    );

    const completed = await env.DB.prepare(
      `UPDATE intake_job
          SET status = 'ready', draft_json = ?, error_message = NULL,
              lease_id = NULL, updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND status = 'running' AND lease_id = ?`,
    )
      .bind(draftJson, id, leaseId)
      .run();
    if (completed.meta.changes !== 1) return "done";
    // The photographed pages have done their work the moment a draft exists.
    // A linked job's found picture is deliberately not touched here: it is the
    // dish's photograph, wanted by the review screen and again at save, and
    // `deleteIntakeJob` is what takes it.
    await deleteImages(env.RECIPE_IMAGES, job.imageRefs);
  } catch (error) {
    await markOwnedFailed(env.DB, id, leaseId, jobFailureMessage(error));
  }

  return "done";
}

/**
 * What the model will be given, assembled at the moment the job runs.
 *
 * A linked job is read here rather than when it was created, which is the
 * whole reason it is a job: fetching in the request would hold that request
 * open for a slow site, and #186 moved imports off the request precisely so a
 * member could navigate away. The text it reads is written back onto the job,
 * so a retry after a *model* failure reuses it instead of asking the site
 * again, and so a failed import can still show what it did manage to read.
 */
async function sourceForJob(
  env: Env,
  job: IntakeJob,
  fetchPage?: PageFetcher,
): Promise<IntakeSource> {
  if (job.sourceRoute === "pasted") {
    return { route: "pasted", text: job.sourceText ?? "" };
  }

  if (job.sourceRoute === "linked") {
    const address = job.sourceUrl ?? "";
    if (job.sourceText !== null && job.sourceText.trim() !== "") {
      return {
        route: "linked",
        url: address,
        text: job.sourceText,
        guidance: job.importGuidance ?? undefined,
      };
    }

    const page = fetchPage
      ? await fetchRecipePage(address, fetchPage)
      : await fetchRecipePage(address);
    console.log(JSON.stringify({
      event: "intake.page_fetched",
      job_id: job.id,
      host: new URL(page.url).hostname,
      structured: page.structured,
      characters: page.sourceText.length,
    }));

    // Written before the model runs, so the text survives a model failure and
    // the retry is of the structuring rather than of the whole read.
    await env.DB.prepare(
      `UPDATE intake_job SET source_text = ?, source_url = ? WHERE id = ?`,
    )
      .bind(page.sourceText, page.url, job.id)
      .run();

    await keepPageImage(env, job, page.imageUrls, fetchPage);

    return {
      route: "linked",
      url: page.url,
      text: page.sourceText,
      guidance: job.importGuidance ?? undefined,
    };
  }

  const images: IntakeImage[] = [];
  for (const ref of job.imageRefs) {
    const object = await env.RECIPE_IMAGES.get(ref.key);
    if (object === null) throw new Error("A retained intake image is missing.");
    images.push({
      base64: encodeBase64(new Uint8Array(await object.arrayBuffer())),
      mediaType: ref.mediaType,
    });
  }
  if (images.length === 0) throw new Error("The photographed intake has no pages.");
  return { route: "photographed", images };
}

/**
 * Store the page's own photograph against the job, if it gave up one (#205).
 *
 * The bytes are copied rather than the address kept: a household's recipe must
 * not go blank because somebody else reorganised their media library or
 * started refusing hotlinks, which is what ADR-0011's "nothing is stored but
 * text and the address" has been amended to allow.
 *
 * Nothing in here may fail the import. The recipe — the name, the ingredients,
 * the method — is already read and already written back by the time this runs,
 * and losing all of it because an image server was slow would be a far worse
 * trade than importing a recipe with no picture on it. So every failure is a
 * log line and a job that carries on without one.
 */
async function keepPageImage(
  env: Env,
  job: IntakeJob,
  candidates: string[],
  fetchPage?: PageFetcher,
): Promise<void> {
  if (candidates.length === 0) return;

  try {
    const image = fetchPage
      ? await fetchRecipeImage(candidates, fetchPage)
      : await fetchRecipeImage(candidates);
    if (image === null) {
      console.log(JSON.stringify({
        event: "intake.page_image_missed",
        job_id: job.id,
        candidates: candidates.length,
      }));
      return;
    }

    const key = `intake/${job.id}/found.${extensionFor(image.contentType)}`;
    await env.RECIPE_IMAGES.put(key, image.bytes, {
      httpMetadata: { contentType: image.contentType },
    });

    await env.DB.prepare(
      "UPDATE intake_job SET page_image_key = ?, page_image_type = ? WHERE id = ?",
    )
      .bind(key, image.contentType, job.id)
      .run();

    console.log(JSON.stringify({
      event: "intake.page_image_kept",
      job_id: job.id,
      bytes: image.bytes.byteLength,
      media_type: image.contentType,
    }));
  } catch (error) {
    console.log(JSON.stringify({
      event: "intake.page_image_failed",
      job_id: job.id,
      detail: String((error as Error)?.message ?? error),
    }));
  }
}

/**
 * The picture a linked job found, ready to become the recipe's own.
 *
 * Household-scoped like every other read here, and null whenever there is no
 * picture to hand over — including for a photographed job, whose stored images
 * are its input pages and not a photograph of the dish.
 */
export async function readIntakeJobImage(
  env: Env,
  id: string,
  householdId: number,
): Promise<{ bytes: ArrayBuffer; mediaType: string } | null> {
  const job = await findIntakeJob(env.DB, id, householdId);
  const ref = intakeJobImageRef(job);
  if (ref === null) return null;

  const object = await env.RECIPE_IMAGES.get(ref.key);
  if (object === null) return null;
  return { bytes: await object.arrayBuffer(), mediaType: ref.mediaType };
}

/** The one image a linked job may carry, or null on every other route. */
export function intakeJobImageRef(job: IntakeJob | null): StoredImageRef | null {
  if (job === null || job.sourceRoute !== "linked") return null;
  return job.pageImage;
}

/**
 * Read the existing NDJSON retry protocol without involving a browser.
 *
 * `onDelta` is told how much draft has arrived so far. The queue consumer has
 * nobody to tell, but a prompt edit (#208) is read by somebody waiting, and
 * that is what keeps its connection open while the model thinks.
 */
export async function collectValidatedDraft(
  stream: ReadableStream<Uint8Array>,
  onDelta?: (soFar: string) => void,
): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let pending = "";
  let draft = "";

  const record = (line: string): string | null => {
    if (line === "") return null;
    const parsed = JSON.parse(line) as DraftStreamRecord;
    if (parsed.type === "delta") {
      draft += parsed.text;
      onDelta?.(draft);
    } else if (parsed.type === "restart") draft = "";
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

/**
 * The Finnish a failed job carries, whichever half of the import failed.
 *
 * A page that would not be read is a different thing to explain than a model
 * that would not answer, and the member can usually act on the first — so the
 * fetch's named reason is kept rather than flattened into the generic wording.
 * The English detail still only goes to the log.
 */
function jobFailureMessage(error: unknown): string {
  if (error instanceof PageRefused) {
    console.log(JSON.stringify({
      event: "intake.page_refused",
      reason: error.reason,
    }));
    return LINK_REFUSALS[error.reason];
  }
  return importFailureMessage(error);
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
    `SELECT image_refs, page_image_key
       FROM intake_job
      WHERE image_refs IS NOT NULL OR page_image_key IS NOT NULL`,
  ).all<{ image_refs: string | null; page_image_key: string | null }>();
  const referenced = new Set(
    results.flatMap((row) => [
      ...parseImageRefs(row.image_refs).map((ref) => ref.key),
      ...(row.page_image_key === null ? [] : [row.page_image_key]),
    ]),
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
    sourceUrl: row.source_url,
    importGuidance: row.import_guidance ?? null,
    imageRefs: parseImageRefs(row.image_refs),
    pageImage: row.page_image_key === null || row.page_image_type === null
      ? null
      : { key: row.page_image_key, mediaType: row.page_image_type },
    draftJson: row.draft_json,
    draftTitle: draftTitle(row.draft_json),
    errorMessage: row.error_message,
    targetRecipeId: row.target_recipe_id ?? null,
    targetRevision: row.target_revision ?? null,
    editMode: row.edit_mode ?? null,
    targetRecipe: parseTargetRecipe(row.target_recipe_json ?? null),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function parseTargetRecipe(json: string | null): Recipe | null {
  if (json === null) return null;
  try {
    return JSON.parse(json) as Recipe;
  } catch {
    return null;
  }
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
