import { html, type Raw } from "./html.ts";
import type { IngredientSummary } from "./ingredients.ts";
import type { DraftLine } from "./intake.ts";
import { formatDecimal } from "./quantities.ts";
import type { LineIngredient, LineToSave, StepToSave } from "./recipe-save.ts";

/**
 * One editable ingredient line, shared by the intake correction screen and the
 * recipe editor. Both need the same thing: the amounts, the ingredient picker
 * with its approve-a-new-one step, and the source line underneath.
 *
 * Kept in one place so the approval gate cannot be right on one screen and
 * wrong on the other.
 */

/** Blank rows so a line the model missed can be added without any JavaScript. */
export const SPARE_LINES = 3;

export interface LineRowOptions {
  /** Show a position box, so lines can be reordered without JavaScript. */
  reorderable?: boolean;
  /**
   * Show the part this line belongs to. Only intake needs it: once saved, a
   * part is a recipe of its own and is edited on its own screen.
   */
  sections?: boolean;
}

export function lineRow(
  line: DraftLine,
  index: number,
  ingredients: IngredientSummary[],
  options: LineRowOptions = {},
): Raw {
  const isNew = line.ingredientId === null && line.ingredientName !== "";

  return html`<li class="${isNew ? "line is-new" : "line"}">
    ${isNew ? html`<span class="badge">Uusi aines</span>` : ""}

    <div class="amounts">
      ${options.reorderable
        ? html`<input
            name="line.${index}.position"
            inputmode="numeric"
            value="${index + 1}"
            aria-label="Järjestys"
            class="position"
          />`
        : ""}
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

    ${options.sections
      ? html`<input
          name="line.${index}.section"
          value="${line.section ?? ""}"
          aria-label="Osa"
          placeholder="Osa (esim. juustokastike)"
          class="section"
        />`
      : ""}

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

export function emptyLine(): DraftLine {
  return {
    quantity: null,
    quantityMax: null,
    unit: null,
    altQuantity: null,
    altUnit: null,
    ingredientId: null,
    ingredientName: "",
    sourceLine: "",
    section: null,
  };
}

/**
 * The submitted lines, in the order the position boxes ask for. A spare row
 * nobody filled in is dropped; an unanswered real one is kept, so the gate can
 * refuse it rather than the parser silently losing it.
 */
export function readLines(form: FormData, lineCount: number): LineToSave[] {
  const rows: { position: number; line: LineToSave }[] = [];

  for (let i = 0; i < lineCount; i++) {
    if (form.get(`line.${i}.remove`) !== null) continue;

    const ingredient = readIngredient(form, i);
    const quantity = readNumber(form.get(`line.${i}.quantity`));
    const unit = readText(form.get(`line.${i}.unit`));
    const sourceLine = String(form.get(`line.${i}.source`) ?? "").trim();

    const untouched =
      ingredient.kind === "unanswered" &&
      quantity === null &&
      unit === null &&
      sourceLine === "";
    if (untouched) continue;

    const altQuantity = readNumber(form.get(`line.${i}.altQuantity`));
    const altUnit = readText(form.get(`line.${i}.altUnit`));
    const altIsWhole = altQuantity !== null && altUnit !== null;

    rows.push({
      position: readNumber(form.get(`line.${i}.position`)) ?? i + 1,
      line: {
        quantity,
        quantityMax: readNumber(form.get(`line.${i}.quantityMax`)),
        unit,
        altQuantity: altIsWhole && quantity !== null ? altQuantity : null,
        altUnit: altIsWhole && quantity !== null ? altUnit : null,
        ingredient,
        sourceLine,
        section: readText(form.get(`line.${i}.section`)),
      },
    });
  }

  return rows
    .sort((a, b) => a.position - b.position)
    .map((row) => row.line);
}

/** The steps, in the order their position boxes ask for. */
export function readSteps(form: FormData): StepToSave[] {
  const steps: { position: number; step: StepToSave }[] = [];

  for (const [key, value] of form.entries()) {
    const match = /^step\.(\d+)$/.exec(key);
    if (match === null) continue;

    const index = Number(match[1]);
    steps.push({
      position: readNumber(form.get(`step.${index}.position`)) ?? index + 1,
      step: {
        text: String(value),
        section: readText(form.get(`step.${index}.section`)),
      },
    });
  }

  return steps
    .sort((a, b) => a.position - b.position)
    .map((entry) => entry.step)
    .filter((step) => step.text.trim() !== "");
}

export function readIngredient(form: FormData, index: number): LineIngredient {
  const choice = String(form.get(`line.${index}.ingredient`) ?? "");

  if (choice === "new") {
    return { kind: "new", name: String(form.get(`line.${index}.newName`) ?? "") };
  }

  const id = Number(choice);
  if (Number.isSafeInteger(id) && id > 0) return { kind: "existing", id };

  return { kind: "unanswered" };
}

/** Accepts the Finnish decimal comma as well as a point. */
export function readNumber(value: File | string | null): number | null {
  const text = String(value ?? "").trim().replace(",", ".");
  if (text === "") return null;

  const parsed = Number(text);
  return Number.isFinite(parsed) ? parsed : null;
}

export function readWhole(value: File | string | null): number | null {
  const parsed = readNumber(value);
  return parsed !== null && Number.isSafeInteger(parsed) ? parsed : null;
}

export function readText(value: File | string | null): string | null {
  const text = String(value ?? "").trim();
  return text === "" ? null : text;
}
