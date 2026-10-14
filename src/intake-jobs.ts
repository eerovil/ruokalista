import type { Env } from "./env.ts";
import { ingredientsFor } from "./ingredients.ts";
import { linksIn, MAX_LINKS, withoutLinks } from "./intake-box.ts";
import {
  draftFromJson,
  givenMaterial,
  importFailureMessage,
  MAX_IMAGES,
  MAX_PAGE_BASE64_BYTES,
  MAX_PAGES_BASE64_BYTES,
  streamDraft,
  STRUCTURED_BY,
  type DraftStreamRecord,
  type IntakeImage,
  type IntakeSource,
  type ReadPage,
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

/** Why one link gave up no page: the fetch's own word, or K-Ruoka's block. */
export type LinkFailure = FetchFailure | "blocked";

/** One link of a job as the consumer read it (#350). */
export type LinkRead =
  | { url: string; text: string }
  | { url: string; failure: LinkFailure };

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
  link_reads: string | null;
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
  /** What the member typed in the box, links and all; null if nothing. */
  sourceText: string | null;
  /**
   * The first link given, and once the links are read, the first one that
   * gave up a page — the address the recipe will point back at. Null when the
   * box held no link.
   */
  sourceUrl: string | null;
  /** The links as the consumer read them; null until it has (#350). */
  linkReads: LinkRead[] | null;
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
      ? body.sourceText.trim()
      : null;

  // Everything given is material for one recipe (#350): the box's text, the
  // links written in it, and the photographs. A separate `url` is what an
  // installed app still running yesterday's screen sends, and it is read as
  // one more link in front of the box's own.
  const links = intakeLinks(body.url, sourceText);
  const typed = sourceText === null ? "" : withoutLinks(sourceText, takenBy(links));

  if (images.length === 0 && links.length === 0 && sourceText === null) {
    throw new IntakeRefused("Anna reseptin osoite, tekstiä tai kuva.");
  }
  // Only a link that cannot be read and nothing else besides: refused while
  // the member is still looking at it, rather than as a job certain to fail.
  // With anything else given, the import goes on without it.
  if (images.length === 0 && typed === "" && links.length > 0 && links.every(isBlockedLink)) {
    throw new IntakeRefused(K_RUOKA_REFUSAL);
  }
  // Only things written as links, none of them a public address: the same,
  // in the address refusal's own words rather than as an import of a URL.
  if (
    images.length === 0 && links.length === 0 && sourceText !== null &&
    withoutLinks(sourceText) === ""
  ) {
    throw new IntakeRefused(LINK_REFUSALS.invalid_url);
  }

  // The main way in, which is what the saved recipe records as its route:
  // photographs, else a link, else text.
  const route: IntakeJobRoute =
    images.length > 0 ? "photographed" : links.length > 0 ? "linked" : "pasted";
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
        sourceText,
        links[0] ?? null,
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

const K_RUOKA_REFUSAL =
  "K-Ruoka-linkkejä ei tueta. Liitä reseptin teksti tai tuo resepti kuvasta.";

/**
 * The links an import will read, normalised, each once, at most `MAX_LINKS`.
 *
 * `normaliseRecipeUrl` is the same check the fetch itself goes through. A
 * written link that fails it is just words in the box — the box is free text,
 * and "esim.fi" in a sentence is not worth refusing an import over. A separate
 * `url` field (an older screen) is different: the member typed it as an
 * address, so one that is not an address is refused as it always was.
 */
function intakeLinks(url: unknown, text: string | null): string[] {
  const links: string[] = [];
  const add = (address: string) => {
    if (links.length < MAX_LINKS && !links.includes(address)) links.push(address);
  };
  if (typeof url === "string" && url.trim() !== "") {
    try {
      add(normaliseRecipeUrl(url).toString());
    } catch {
      throw new IntakeRefused(LINK_REFUSALS.invalid_url);
    }
  }
  for (const written of linksIn(text ?? "")) {
    try {
      add(normaliseRecipeUrl(written).toString());
    } catch {
      // Not an address after all; it stays in the text as words.
    }
  }
  return links;
}

/** Whether a written link is one of the normalised links being read. */
function takenBy(links: string[]): (written: string) => boolean {
  return (written) => {
    try {
      return links.includes(normaliseRecipeUrl(written).toString());
    } catch {
      return false;
    }
  };
}

/**
 * K-Ruoka challenge-blocks server fetches. Do not work around that browser
 * challenge or depend on its undocumented frontend API (#246); its link is
 * simply not read.
 */
function isBlockedLink(address: string): boolean {
  const host = new URL(address).hostname.toLowerCase();
  return host === "k-ruoka.fi" || host === "www.k-ruoka.fi";
}

/**
 * Why a web address gave up no recipe, in Finnish (#192).
 *
 * The fetch names its refusals in a closed set of English words; this is the
 * one place each becomes something a household reads. A page's own error text
 * never becomes a Finnish message, and never reaches a screen.
 */
const LINK_REFUSALS: Record<LinkFailure, string> = {
  blocked: K_RUOKA_REFUSAL,
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

/**
 * Remove a job that is no longer being worked on: a ready one once its reviewed
 * draft became a recipe, or a ready or failed one the member threw away (#337).
 * A queued or running job is left alone, and so is the answer: false.
 */
export async function deleteIntakeJob(
  env: Env,
  id: string,
  householdId: number,
): Promise<boolean> {
  const job = await findIntakeJob(env.DB, id, householdId);
  if (job === null || (job.status !== "ready" && job.status !== "failed")) {
    return false;
  }
  // Re-checked in the statement, because a retry may have queued it since.
  const deleted = await env.DB.prepare(
    `DELETE FROM intake_job
      WHERE id = ? AND household_id = ? AND status IN ('ready', 'failed')`,
  )
    .bind(id, householdId)
    .run();
  if (deleted.meta.changes !== 1) return false;
  await deleteImages(
    env.RECIPE_IMAGES,
    job.pageImage === null ? job.imageRefs : [...job.imageRefs, job.pageImage],
  );
  return true;
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
 * Links are read here rather than when the job was created, which is the whole
 * reason it is a job: fetching in the request would hold that request open for
 * a slow site, and #186 moved imports off the request precisely so a member
 * could navigate away. What was read is written back onto the job as
 * `link_reads`, so a retry after a *model* failure reuses it instead of asking
 * the sites again, and the review can say which link could not be read.
 */
async function sourceForJob(
  env: Env,
  job: IntakeJob,
  fetchPage?: PageFetcher,
): Promise<IntakeSource> {
  const reads = await readLinks(env, job, fetchPage);
  const pages = readPages(reads);
  const typed = typedMaterial(job);

  const images: IntakeImage[] = [];
  for (const ref of job.imageRefs) {
    const object = await env.RECIPE_IMAGES.get(ref.key);
    if (object === null) throw new Error("A retained intake image is missing.");
    images.push({
      base64: encodeBase64(new Uint8Array(await object.arrayBuffer())),
      mediaType: ref.mediaType,
    });
  }
  if (job.sourceRoute === "photographed" && images.length === 0) {
    throw new Error("The photographed intake has no pages.");
  }

  // Nothing readable at all: the first link's own refusal, which is what a
  // lone link that failed has always said. A single short line next to a dead
  // link is a wish about a recipe that never arrived, not a recipe.
  if (images.length === 0 && pages.length === 0 && !isRecipeText(typed)) {
    const failed = reads.find((read) => "failure" in read);
    if (failed !== undefined && "failure" in failed) {
      throw new LinkUnread(failed.failure);
    }
  }

  return composedSource(job, pages, images);
}

/**
 * The source a job's material makes, shared by the consumer and the review
 * screen so both see the same text. The review has no photographs to hand
 * over (they are gone once a draft exists), and does not need them: the
 * draft already carries their transcription.
 */
export function composedSource(
  job: IntakeJob,
  pages: ReadPage[],
  images: IntakeImage[],
): IntakeSource {
  const typed = typedMaterial(job);
  if (job.sourceRoute === "photographed") {
    const text = givenMaterial(typed, pages, true);
    return text === ""
      ? { route: "photographed", images }
      : { route: "photographed", images, text, fromPages: pages.length > 0 };
  }
  if (pages.length > 0) {
    return {
      route: "linked",
      url: pages[0]!.url,
      text: givenMaterial(typed, pages, false),
      guidance: job.importGuidance ?? undefined,
      mixed: pages.length + (typed === null ? 0 : 1) > 1,
    };
  }
  return { route: "pasted", text: typed ?? job.sourceText ?? "" };
}

/** The pages a job's links gave up, in the order the links were written. */
export function readPages(reads: LinkRead[] | null): ReadPage[] {
  return (reads ?? []).flatMap((read): ReadPage[] =>
    "text" in read ? [{ url: read.url, text: read.text }] : []
  );
}

/** The links a job's review should say were not read. */
export function unreadLinks(job: IntakeJob): Array<{ url: string; message: string }> {
  return (job.linkReads ?? []).flatMap((read) =>
    "failure" in read ? [{ url: read.url, message: LINK_REFUSALS[read.failure] }] : []
  );
}

/**
 * What the member wrote, with the links taken out, or null if that leaves
 * nothing. The links are read as pages; leaving them in the text as well
 * would only show the model the same address twice.
 */
function typedMaterial(job: IntakeJob): string | null {
  const typed = withoutLinks(job.sourceText ?? "", takenBy(jobLinks(job)));
  return typed === "" ? null : typed;
}

/** More than one line: a recipe someone pasted, not a note beside a link. */
function isRecipeText(text: string | null): boolean {
  return text !== null && text.split("\n").filter((line) => line.trim() !== "").length > 1;
}

/** A link that could not be read, when it is the only thing there was. */
class LinkUnread extends Error {
  reason: LinkFailure;

  constructor(reason: LinkFailure) {
    super(`The only link could not be read: ${reason}`);
    this.reason = reason;
  }
}

/**
 * Every link the job has, in order: the stored first one, then the box's.
 * `source_url` is never rewritten after a read, so this is the same list on
 * every retry and its order matches `link_reads`.
 */
function jobLinks(job: IntakeJob): string[] {
  const links = job.sourceUrl === null ? [] : [job.sourceUrl];
  for (const written of linksIn(job.sourceText ?? "")) {
    if (links.length >= MAX_LINKS) break;
    try {
      const address = normaliseRecipeUrl(written).toString();
      if (!links.includes(address)) links.push(address);
    } catch {
      // Words, not an address — the same call `createIntakeJob` made.
    }
  }
  return links;
}

/**
 * Failures a retry should try again: a site that did not answer, or answered
 * with something that was not a page, may well answer next time. A K-Ruoka
 * link or an address that is not one will not.
 */
function readAgain(read: LinkRead | undefined): boolean {
  return read === undefined ||
    ("failure" in read && read.failure !== "blocked" && read.failure !== "invalid_url");
}

/**
 * Read each link, in order, and write what came back onto the job.
 *
 * One link failing does not fail the others or the import (#350): it is
 * recorded with its reason and the review names it. A link already read is
 * not read again, so a retry after a model failure does not go back to the
 * sites; a link that failed in a way that may pass is, which is what *Yritä
 * uudelleen* means for it. The picture is taken from the first page that
 * offers one, after that page's text is safely written, unless the job
 * already has one.
 */
async function readLinks(
  env: Env,
  job: IntakeJob,
  fetchPage?: PageFetcher,
): Promise<LinkRead[]> {
  const links = jobLinks(job);
  if (links.length === 0) return [];
  const before = job.linkReads ?? [];
  if (job.linkReads !== null && !links.some((_, at) => readAgain(before[at]))) {
    return job.linkReads;
  }

  const reads: LinkRead[] = [];
  const pictures: string[][] = [];
  for (const [at, address] of links.entries()) {
    const earlier = before[at];
    if (earlier !== undefined && !readAgain(earlier)) {
      reads.push(earlier);
      continue;
    }
    if (isBlockedLink(address)) {
      reads.push({ url: address, failure: "blocked" });
      continue;
    }
    try {
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
      reads.push({ url: page.url, text: page.sourceText });
      pictures.push(page.imageUrls);
    } catch (error) {
      if (!(error instanceof PageRefused)) throw error;
      console.log(JSON.stringify({
        event: "intake.page_refused",
        job_id: job.id,
        reason: error.reason,
      }));
      reads.push({ url: address, failure: error.reason });
    }
  }

  // Written before the model runs, so the text survives a model failure and
  // the retry is of the structuring rather than of the whole read. The
  // address the recipe points back at is the first page read, taken from
  // these reads by the review; `source_url` keeps the link as given.
  await env.DB.prepare("UPDATE intake_job SET link_reads = ? WHERE id = ?")
    .bind(JSON.stringify(reads), job.id)
    .run();

  const offered = pictures.find((candidates) => candidates.length > 0);
  if (offered !== undefined && job.pageImage === null) {
    await keepPageImage(env, job, offered, fetchPage);
  }

  return reads;
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
 * The picture a job's page offered, ready to become the recipe's own.
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

/**
 * The dish's picture found on one of the job's pages, or null. Any route may
 * have one now that photographs and links go together (#350); a photographed
 * job's own pages are its input, never this.
 */
export function intakeJobImageRef(job: IntakeJob | null): StoredImageRef | null {
  return job?.pageImage ?? null;
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
  if (error instanceof LinkUnread) return LINK_REFUSALS[error.reason];
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
    linkReads: parseLinkReads(row.link_reads ?? null),
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

function parseLinkReads(json: string | null): LinkRead[] | null {
  if (json === null) return null;
  try {
    const parsed = JSON.parse(json) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((entry): LinkRead[] => {
      const read = (entry ?? {}) as Record<string, unknown>;
      const url = read["url"];
      if (typeof url !== "string") return [];
      if (typeof read["text"] === "string") return [{ url, text: read["text"] }];
      if (typeof read["failure"] === "string") {
        return [{ url, failure: read["failure"] as LinkFailure }];
      }
      return [];
    });
  } catch {
    return [];
  }
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
