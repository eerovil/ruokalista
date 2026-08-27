import {
  MAX_CELLS,
  NO_TRANSPARENCY,
  OUTPUT_EDGE,
  PngError,
  splitContactSheet,
} from "../contact-sheet.ts";

/**
 * Cutting a contact sheet up in the admin's own browser, and uploading the
 * pieces.
 *
 * This is the half of the recipe-image flow the Worker cannot do. Cloudflare's
 * Free plan gives a request 10 ms of CPU; decoding one 1,024 px sheet costs
 * about 0.22 s and encoding sixteen 512 px crops about 1.0 s, so the work is
 * roughly a hundred times the budget and no amount of tuning closes that. The
 * one live attempt at doing it server-side ran for 178 seconds and was killed.
 * `docs/adr/0005-the-worker-does-no-pixel-work.md` is the decision; this file is
 * where the work went instead.
 *
 * **It is not a second implementation of the splitter.** It imports
 * `contact-sheet.ts` and `png.ts` — the very modules `dev/check-contact-sheet.ts`
 * tests under node — and a build step bundles them for the browser. So the crop
 * rules, the ownership margin, the gutter recovery and every reason a sheet is
 * refused exist once. A hand-written browser copy of those rules would be a
 * second set of them to keep in step, which is exactly the drift this repository
 * keeps being bitten by.
 *
 * Storing goes through `PUT /api/recipes/:id/image`, the bulk route #89 already
 * had, with #95's `origin=generated&fingerprint=…&model=…`. One request per
 * recipe, and no new endpoint: the freshness bookkeeping and the
 * compare-and-swap that protects a picture somebody uploaded in the meantime
 * are the code that was already there and already tested.
 *
 * Two ordering rules are carried over from #96 unchanged, and both matter:
 *
 *   - **Every crop is cut and checked before the first one is uploaded.** A
 *     sheet that cannot be cut safely changes nothing at all.
 *   - **Once uploading starts, a recipe that got its picture keeps it.** One
 *     failure does not undo the ones before it and does not stop the ones
 *     after: each stored crop is a correct picture of its recipe with a
 *     fingerprint that still matches, and deleting good pictures to tidy up one
 *     failure would destroy work to make a report look neater.
 */

/** What one cell is for, read out of the manifest the screen rendered. */
interface Cell {
  recipeId: number;
  title: string;
  /** The recipe content the picture will be a picture of, from the server. */
  fingerprint: string;
  /** The image key the confirmation screen saw; empty means there was no image. */
  expectedImageKey: string | null;
  row: HTMLElement;
}

/**
 * A bound on the file, before it is decoded. Past this the wait is long enough
 * that somebody would think the page had hung — and a sheet this large is
 * almost certainly not a sheet. The pixel work itself is the browser's own and
 * needs no other limit.
 */
const MAX_SHEET_BYTES = 20 * 1024 * 1024;

/** What `image_generated_by` records. The server states it; nothing here invents it. */
function modelOf(form: HTMLElement): string {
  return form.getAttribute("data-model") ?? "";
}

const form = document.getElementById("split-form");
const input = document.getElementById("sheet") as HTMLInputElement | null;
const button = document.getElementById("split-submit") as HTMLButtonElement | null;
const note = document.getElementById("split-note");
const manifest = document.getElementById("split-manifest");

if (form !== null && input !== null && button !== null && note !== null && manifest !== null) {
  start(form, input, button, note, manifest);
}

function start(
  form: HTMLElement,
  input: HTMLInputElement,
  button: HTMLButtonElement,
  note: HTMLElement,
  manifest: HTMLElement,
): void {
  // The screen renders disabled and says so, because without this script there
  // is nothing to press. Turning the control on is this file's way of saying it
  // loaded — a browser too old for `DecompressionStream` never gets here, and
  // the message it was rendered with stays on screen.
  if (typeof DecompressionStream === "undefined" || typeof CompressionStream === "undefined") {
    say(note, "error", "Tämä selain on liian vanha arkin leikkaamiseen. Kokeile uudemmalla.");
    return;
  }

  button.disabled = false;
  say(note, "quiet", "Valitse arkki ja leikkaa kuvat. Leikkaaminen kestää hetken.");

  form.addEventListener("submit", (event: Event) => {
    event.preventDefault();
    void run(input, button, note, manifest, modelOf(form));
  });
}

async function run(
  input: HTMLInputElement,
  button: HTMLButtonElement,
  note: HTMLElement,
  manifest: HTMLElement,
  model: string,
): Promise<void> {
  const cells = cellsOf(manifest);
  const file = input.files === null ? null : input.files[0];

  if (file === null || file === undefined) {
    say(note, "error", "Valitse arkki, jonka leikkaan.");
    return;
  }
  if (file.size > MAX_SHEET_BYTES) {
    say(
      note,
      "error",
      `Arkki on ${megabytes(file.size)} MB. Enintään ${megabytes(MAX_SHEET_BYTES)} MB.`,
    );
    return;
  }
  if (cells.length === 0 || cells.length > MAX_CELLS) {
    say(note, "error", "Erässä ei ole leikattavia reseptejä.");
    return;
  }

  button.disabled = true;
  for (const cell of cells) mark(cell, "quiet", "Odottaa");

  // ---- cut everything first, and store nothing yet ----
  say(note, "quiet", "Leikataan arkkia…");

  let split;
  try {
    split = await splitContactSheet(new Uint8Array(await file.arrayBuffer()), cells.length);
  } catch (error) {
    // A PNG shape the decoder will not read — sixteen bits a channel, or
    // interlaced — says so by name rather than as a mystery.
    const why = error instanceof PngError
      ? error.message
      : "tiedostoa ei voitu lukea PNG-kuvana";
    say(note, "error", `Arkkia ei voitu lukea: ${why}`);
    for (const cell of cells) mark(cell, "quiet", "Ei kuvaa");
    button.disabled = false;
    return;
  }

  if (!split.ok) {
    // Nothing has been uploaded and nothing will be. Every recipe is exactly as
    // it was, so the whole batch can be tried again with another sheet for
    // nothing but the drawing.
    if (split.kind === "sheet") {
      say(note, "error", sheetRefusal(split.reason));
      for (const cell of cells) mark(cell, "quiet", "Ei kuvaa");
    } else {
      say(
        note,
        "error",
        "Arkkia ei voitu leikata turvallisesti, joten mitään ei tallennettu. " +
          "Piirrä uusi arkki ja leikkaa se — uusi yritys ei maksa mitään.",
      );
      for (const cell of cells) {
        const mine = split.problems.filter((problem) => problem.cell === cellIndex(cells, cell));
        mark(
          cell,
          "error",
          mine.length === 0
            ? "Ei kuvaa: toinen ruutu hylättiin"
            : `Hylätty: ${mine.map((problem) => problem.reason).join("; ")}`,
        );
      }
    }
    button.disabled = false;
    return;
  }

  // ---- past here every crop exists and has been checked, so uploads begin ----
  say(note, "quiet", `Leikattu. Tallennetaan ${split.crops.length} kuvaa…`);

  let stored = 0;
  for (const crop of split.crops) {
    const cell = cells[crop.cell];
    if (cell === undefined) continue;

    mark(cell, "quiet", "Tallennetaan…");
    const failure = await upload(cell, crop.png, model);

    if (failure === null) {
      stored += 1;
      mark(cell, "done", `Kuva tallennettu (${OUTPUT_EDGE}px)`);
      showPicture(cell);
    } else {
      // One recipe's answer, not the batch's. The ones already stored stay
      // stored and the ones after this are still tried.
      mark(cell, "error", `Ei tallennettu: ${failure}`);
    }
  }

  say(
    note,
    stored === cells.length ? "done" : "error",
    `${stored} / ${cells.length} reseptiä sai kuvan.` +
      (stored === cells.length ? "" : " Loput voi yrittää uudelleen."),
  );
  button.disabled = false;
}

/**
 * A whole-sheet refusal, in Finnish.
 *
 * `contact-sheet.ts` is shared with the Worker and its reasons are in English,
 * which is fine for a per-cell complaint an admin reads once in a hundred
 * batches. Flattened transparency is not that: it is the failure an external
 * image tool is *most likely* to produce, so it earns a sentence in the
 * language of the screen and a note about what to do instead.
 *
 * Anything else that ever refuses a whole sheet falls through to its own
 * English words rather than to silence.
 */
function sheetRefusal(reason: string): string {
  if (reason === NO_TRANSPARENCY) {
    return (
      "Arkkia ei voitu leikata: siinä ei ole yhtään läpinäkyvää kuvapistettä. " +
      "Annokset erotellaan toisistaan juuri läpinäkyvästä taustasta, ja moni " +
      "kuvageneraattori litistää sen valkoiseksi. Tallenna arkki uudelleen " +
      "läpinäkyvällä taustalla (PNG). Mitään ei tallennettu."
    );
  }
  return `Arkkia ei voitu leikata: ${reason}.`;
}

/**
 * Store one crop, or say why not.
 *
 * The fingerprint travels from the server through the manifest and back up
 * here, rather than being left for the API to fill in: it states the recipe the
 * picture was actually drawn from. Letting the server default it would record
 * the recipe as it stands at upload time, which is a claim about a recipe
 * nobody read — and the gap here is real, since the admin went away to draw a
 * sheet in between.
 */
async function upload(cell: Cell, png: Uint8Array, model: string): Promise<string | null> {
  const query =
    `?origin=generated&fingerprint=${encodeURIComponent(cell.fingerprint)}` +
    `&model=${encodeURIComponent(model)}`;

  let response: Response;
  try {
    response = await fetch(`/api/recipes/${cell.recipeId}/image${query}`, {
      method: "PUT",
      headers: {
        "content-type": "image/png",
        // This is the state before the admin left to draw the sheet. The API
        // must not replace a picture somebody chose during that long gap.
        "x-expected-image-key": cell.expectedImageKey ?? "",
      },
      // A fresh copy: the stored bytes outlive the raster they were cut from,
      // and a view onto a larger buffer would keep the whole sheet alive.
      body: png.slice(),
    });
  } catch {
    return "verkkovirhe";
  }

  if (response.status === 204) return null;

  // 409 is the one worth explaining: somebody changed this recipe's picture
  // while the sheet was being drawn, so the picture chosen last survives.
  if (response.status === 409) {
    return "kuva muuttui sillä välin — nykyinen kuva säilytettiin";
  }
  return `palvelin vastasi ${response.status}`;
}

function cellsOf(manifest: HTMLElement): Cell[] {
  const cells: Cell[] = [];
  const rows = manifest.querySelectorAll("[data-recipe-id]");

  for (let at = 0; at < rows.length; at += 1) {
    const row = rows[at] as HTMLElement;
    const id = Number(row.getAttribute("data-recipe-id"));
    if (!isFinite(id) || id <= 0) continue;
    cells.push({
      recipeId: id,
      title: row.getAttribute("data-title") ?? String(id),
      fingerprint: row.getAttribute("data-fingerprint") ?? "",
      expectedImageKey: row.getAttribute("data-expected-image-key") || null,
      row,
    });
  }

  return cells;
}

/** A cell's position, which is the only thing that maps it to a recipe. */
function cellIndex(cells: readonly Cell[], cell: Cell): number {
  return cells.indexOf(cell);
}

/**
 * Put the picture that was just stored into the row, so the screen shows the
 * result rather than the state the server rendered.
 *
 * The row's thumbnail was drawn before any of this ran: for a recipe with no
 * picture it is the empty placeholder `recipeImage` renders, and for one being
 * replaced it is still the old picture. Neither is what the recipe has now, and
 * "did my recipes get their pictures" is the only question this screen exists
 * to answer.
 *
 * The query string is a cache-buster, and it is needed rather than tidy: the URL
 * is unchanged when a picture is replaced, so the browser would otherwise show
 * the cached old one.
 */
function showPicture(cell: Cell): void {
  const holder = cell.row.querySelector(".recipe-image");
  if (holder === null) return;

  const image = document.createElement("img");
  image.src = `/api/recipes/${cell.recipeId}/image?stored=${cell.fingerprint}`;
  image.alt = "";

  holder.textContent = "";
  holder.appendChild(image);
  // The placeholder is hidden from a screen reader and styled as an absence;
  // it holds a picture now, so it is neither.
  holder.className = holder.className.replace(" is-empty", "");
  holder.removeAttribute("aria-hidden");
}

function mark(cell: Cell, kind: string, text: string): void {
  const target = cell.row.querySelector("[data-cell-status]");
  if (target === null) return;
  target.textContent = text;
  (target as HTMLElement).className = `meta split-${kind}`;
}

function say(note: HTMLElement, kind: string, text: string): void {
  note.textContent = text;
  note.className = `split-note split-${kind}`;
}

function megabytes(bytes: number): string {
  return String(Math.round((bytes / (1024 * 1024)) * 10) / 10);
}
