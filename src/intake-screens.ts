import { html, page, type Raw } from "./html.ts";
import { ingredientsFor, type IngredientSummary } from "./ingredients.ts";
import { structureDraftWithRetry, type Draft, type DraftLine } from "./intake.ts";
import type { Member } from "./members.ts";
import { formatDecimal } from "./quantities.ts";
import { saveRecipe, SaveRefused, type LineIngredient } from "./recipe-save.ts";
import type { RouteContext } from "./router.ts";

/**
 * Intake: getting a recipe into the store by pasting text. The correction
 * screen is where a structured draft becomes a recipe, and it is deliberately
 * in the way — nothing saves while a line is unanswered.
 *
 * Nothing is written to D1 until the save, so a failed import leaves no trace
 * and a closed tab loses only the draft. That is why there is no draft table.
 */

/** Blank rows so a line the model missed can be added without any JavaScript. */
const SPARE_LINES = 3;

/** `GET /intake` */
export function intakeScreen(): Response {
  return page(
    "Lisää resepti",
    html`<h1>Lisää resepti</h1>
      <form method="post" action="/intake" class="stacked">
        <label for="sourceText">Liitä reseptin teksti</label>
        <textarea
          id="sourceText"
          name="sourceText"
          rows="16"
          required
          placeholder="Liitä tähän resepti sellaisenaan."
        ></textarea>
        <p class="empty">
          Teksti säilytetään sellaisenaan. Malli ehdottaa jäsennyksen, jonka
          tarkistat ennen tallennusta.
        </p>
        <button type="submit">Jäsennä</button>
      </form>`,
  );
}

/** `POST /intake` — run the model and show the draft for correcting. */
export async function structureScreen(
  { env, request }: RouteContext,
  member: Member,
): Promise<Response> {
  const form = await request.formData();
  const sourceText = String(form.get("sourceText") ?? "").trim();

  if (sourceText === "") {
    return failed("Liitä ensin reseptin teksti.", "");
  }

  const ingredients = await ingredientsFor(env.DB, member.householdId);

  let draft: Draft;
  try {
    draft = await structureDraftWithRetry(env, sourceText, ingredients);
  } catch (error) {
    // The member's text is handed back rather than thrown away.
    return failed(String((error as Error).message ?? error), sourceText);
  }

  return page("Tarkista resepti", correctionForm(draft, ingredients));
}

/** `POST /recipes` — save the corrected draft. */
export async function saveScreen(
  { env, request }: RouteContext,
  member: Member,
): Promise<Response> {
  const form = await request.formData();
  const ingredients = await ingredientsFor(env.DB, member.householdId);

  const sourceText = String(form.get("sourceText") ?? "");
  const structuredBy = String(form.get("structuredBy") ?? "") || null;
  const lineCount = Number(form.get("lineCount") ?? 0);

  const lines = [];
  for (let i = 0; i < lineCount; i++) {
    if (form.get(`line.${i}.remove`) !== null) continue;

    const ingredient = readIngredient(form, i);
    const quantity = readNumber(form.get(`line.${i}.quantity`));
    const unit = readText(form.get(`line.${i}.unit`));
    const sourceLine = String(form.get(`line.${i}.source`) ?? "").trim();

    // A spare row nobody filled in is not an unanswered line.
    const untouched =
      ingredient.kind === "unanswered" &&
      quantity === null &&
      unit === null &&
      sourceLine === "";
    if (untouched) continue;

    const altQuantity = readNumber(form.get(`line.${i}.altQuantity`));
    const altUnit = readText(form.get(`line.${i}.altUnit`));
    const altIsWhole = altQuantity !== null && altUnit !== null;

    lines.push({
      quantity,
      quantityMax: readNumber(form.get(`line.${i}.quantityMax`)),
      unit,
      altQuantity: altIsWhole && quantity !== null ? altQuantity : null,
      altUnit: altIsWhole && quantity !== null ? altUnit : null,
      ingredient,
      sourceLine,
    });
  }

  const steps: string[] = [];
  for (const [key, value] of form.entries()) {
    if (key.startsWith("step.")) steps.push(String(value));
  }

  try {
    const recipeId = await saveRecipe(env.DB, member, {
      title: String(form.get("title") ?? ""),
      yieldPortions: readWhole(form.get("yield")),
      sourceText,
      sourceRoute: "pasted",
      structuredBy,
      steps,
      lines,
    });

    // Straight to the recipe, which is why it was imported.
    return new Response(null, {
      status: 302,
      headers: { Location: `/recipes/${recipeId}` },
    });
  } catch (error) {
    if (!(error instanceof SaveRefused)) throw error;

    // Re-render what they had, with the reason, rather than losing the work.
    const draft = draftFromForm(form, lineCount, sourceText, structuredBy);
    return page(
      "Tarkista resepti",
      html`<p class="refused">${error.message}</p>
        ${correctionForm(draft, ingredients)}`,
      400,
    );
  }
}

// ---------------------------------------------------------------- rendering

function correctionForm(draft: Draft, ingredients: IngredientSummary[]): Raw {
  const rows = [
    ...draft.lines,
    ...Array.from({ length: SPARE_LINES }, emptyLine),
  ];

  return html`<h1>Tarkista resepti</h1>
    <form method="post" action="/recipes" class="stacked">
      <input type="hidden" name="sourceText" value="${draft.sourceText}" />
      <input type="hidden" name="structuredBy" value="${draft.structuredBy}" />
      <input type="hidden" name="lineCount" value="${rows.length}" />

      <label for="title">Nimi</label>
      <input id="title" name="title" value="${draft.title}" required />

      <label for="yield">Annoksia</label>
      <input
        id="yield"
        name="yield"
        inputmode="numeric"
        value="${draft.yieldPortions ?? ""}"
        placeholder="Tyhjä, jos teksti ei kerro"
      />

      <h2>Ainekset</h2>
      <ol class="edit-lines">
        ${rows.map((line, index) => lineRow(line, index, ingredients))}
      </ol>

      <h2>Valmistus</h2>
      <ol class="edit-steps">
        ${draft.steps.map(
          (step, index) => html`<li>
            <textarea name="step.${index}" rows="2">${step}</textarea>
          </li>`,
        )}
      </ol>

      <button type="submit">Tallenna resepti</button>
    </form>`;
}

function lineRow(
  line: DraftLine,
  index: number,
  ingredients: IngredientSummary[],
): Raw {
  const isNew = line.ingredientId === null && line.ingredientName !== "";

  return html`<li class="${isNew ? "line is-new" : "line"}">
    ${isNew ? html`<span class="badge">Uusi aines</span>` : ""}

    <div class="amounts">
      <input
        name="line.${index}.quantity"
        inputmode="decimal"
        value="${line.quantity === null ? "" : formatDecimal(line.quantity)}"
        aria-label="Määrä"
        placeholder="Määrä"
      />
      <input
        name="line.${index}.quantityMax"
        inputmode="decimal"
        value="${line.quantityMax === null
          ? ""
          : formatDecimal(line.quantityMax)}"
        aria-label="Välin yläpää"
        placeholder="–"
      />
      <input
        name="line.${index}.unit"
        value="${line.unit ?? ""}"
        aria-label="Yksikkö"
        placeholder="Yksikkö"
      />
    </div>

    <div class="amounts">
      <input
        name="line.${index}.altQuantity"
        inputmode="decimal"
        value="${line.altQuantity === null
          ? ""
          : formatDecimal(line.altQuantity)}"
        aria-label="Toinen määrä"
        placeholder="Toinen määrä"
      />
      <input
        name="line.${index}.altUnit"
        value="${line.altUnit ?? ""}"
        aria-label="Toinen yksikkö"
        placeholder="Toinen yksikkö"
      />
    </div>

    <select name="line.${index}.ingredient" aria-label="Aines">
      <option value="" ${line.ingredientId === null ? "selected" : ""}>
        ${isNew ? "— vastaa tähän —" : "— valitse aines —"}
      </option>
      ${isNew
        ? html`<option value="new">
            Hyväksy uutena: ${line.ingredientName}
          </option>`
        : ""}
      ${ingredients.map(
        (ingredient) => html`<option
          value="${ingredient.id}"
          ${line.ingredientId === ingredient.id ? "selected" : ""}
        >
          ${ingredient.name}
        </option>`,
      )}
    </select>
    <input
      type="hidden"
      name="line.${index}.newName"
      value="${line.ingredientName}"
    />
    <input
      type="hidden"
      name="line.${index}.source"
      value="${line.sourceLine}"
    />

    ${line.sourceLine === ""
      ? ""
      : html`<span class="source">${line.sourceLine}</span>`}

    <label class="remove">
      <input type="checkbox" name="line.${index}.remove" /> Poista rivi
    </label>
  </li>`;
}

function failed(message: string, sourceText: string): Response {
  return page(
    "Jäsennys epäonnistui",
    html`<h1>Jäsennys epäonnistui</h1>
      <p class="refused">${message}</p>
      <form method="post" action="/intake" class="stacked">
        <textarea name="sourceText" rows="16">${sourceText}</textarea>
        <button type="submit">Yritä uudelleen</button>
      </form>`,
    400,
  );
}

// ----------------------------------------------------------------- parsing

function readIngredient(form: FormData, index: number): LineIngredient {
  const choice = String(form.get(`line.${index}.ingredient`) ?? "");

  if (choice === "new") {
    return { kind: "new", name: String(form.get(`line.${index}.newName`) ?? "") };
  }

  const id = Number(choice);
  if (Number.isSafeInteger(id) && id > 0) return { kind: "existing", id };

  return { kind: "unanswered" };
}

/** Accepts the Finnish decimal comma as well as a point. */
function readNumber(value: File | string | null): number | null {
  const text = String(value ?? "").trim().replace(",", ".");
  if (text === "") return null;

  const parsed = Number(text);
  return Number.isFinite(parsed) ? parsed : null;
}

function readWhole(value: File | string | null): number | null {
  const parsed = readNumber(value);
  return parsed !== null && Number.isSafeInteger(parsed) ? parsed : null;
}

function readText(value: File | string | null): string | null {
  const text = String(value ?? "").trim();
  return text === "" ? null : text;
}

function emptyLine(): DraftLine {
  return {
    quantity: null,
    quantityMax: null,
    unit: null,
    altQuantity: null,
    altUnit: null,
    ingredientId: null,
    ingredientName: "",
    sourceLine: "",
  };
}

/** Rebuild the draft from a refused submission so nothing typed is lost. */
function draftFromForm(
  form: FormData,
  lineCount: number,
  sourceText: string,
  structuredBy: string | null,
): Draft {
  const lines: DraftLine[] = [];

  for (let i = 0; i < lineCount; i++) {
    if (form.get(`line.${i}.remove`) !== null) continue;

    const ingredient = readIngredient(form, i);
    lines.push({
      quantity: readNumber(form.get(`line.${i}.quantity`)),
      quantityMax: readNumber(form.get(`line.${i}.quantityMax`)),
      unit: readText(form.get(`line.${i}.unit`)),
      altQuantity: readNumber(form.get(`line.${i}.altQuantity`)),
      altUnit: readText(form.get(`line.${i}.altUnit`)),
      ingredientId: ingredient.kind === "existing" ? ingredient.id : null,
      ingredientName: String(form.get(`line.${i}.newName`) ?? ""),
      sourceLine: String(form.get(`line.${i}.source`) ?? ""),
    });
  }

  const steps: string[] = [];
  for (const [key, value] of form.entries()) {
    if (key.startsWith("step.")) steps.push(String(value));
  }

  return {
    title: String(form.get("title") ?? ""),
    yieldPortions: readWhole(form.get("yield")),
    sourceText,
    steps,
    lines,
    structuredBy: structuredBy ?? "",
  };
}
