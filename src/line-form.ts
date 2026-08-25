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

/** Blank rows so a line the model missed can be added without JavaScript. */
export const SPARE_LINES = 3;

/** Deliberate request limits: hidden counts are untrusted browser input. */
export const MAX_LINES = 200;
export const MAX_STEPS = 200;

export class FormRefused extends Error {}

/** Raw values preserve even invalid user input when a form is refused. */
export interface LineFormValues {
  position: string;
  quantity: string;
  quantityMax: string;
  unit: string;
  altQuantity: string;
  altUnit: string;
  section: string;
  ingredientChoice: string;
  newName: string;
  sourceLine: string;
  remove: boolean;
}

export interface StepFormValues {
  index: number;
  position: string;
  text: string;
  section: string;
}

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
  line: DraftLine | LineFormValues,
  index: number,
  ingredients: IngredientSummary[],
  options: LineRowOptions = {},
): Raw {
  const values = isLineFormValues(line)
    ? line
    : lineValuesFromDraft(line, index);
  const proposedName = values.newName.trim();
  const needsAnswer =
    values.ingredientChoice === "" && proposedName !== "";
  const isNew = needsAnswer || values.ingredientChoice === "new";

  return html`<li class="${isNew ? "line is-new" : "line"}">
    ${isNew ? html`<span class="badge">Uusi aines</span>` : ""}

    <div class="amounts">
      ${options.reorderable
        ? html`<input
            name="line.${index}.position"
            inputmode="numeric"
            value="${values.position}"
            aria-label="Järjestys"
            class="position"
          />`
        : ""}
      <input
        name="line.${index}.quantity"
        inputmode="decimal"
        value="${values.quantity}"
        aria-label="Määrä"
        placeholder="Määrä"
      />
      <input
        name="line.${index}.quantityMax"
        inputmode="decimal"
        value="${values.quantityMax}"
        aria-label="Välin yläpää"
        placeholder="–"
      />
      <input
        name="line.${index}.unit"
        value="${values.unit}"
        aria-label="Yksikkö"
        placeholder="Yksikkö"
      />
    </div>

    <div class="amounts">
      <input
        name="line.${index}.altQuantity"
        inputmode="decimal"
        value="${values.altQuantity}"
        aria-label="Toinen määrä"
        placeholder="Toinen määrä"
      />
      <input
        name="line.${index}.altUnit"
        value="${values.altUnit}"
        aria-label="Toinen yksikkö"
        placeholder="Toinen yksikkö"
      />
    </div>

    ${options.sections
      ? html`<input
          name="line.${index}.section"
          value="${values.section}"
          aria-label="Osa"
          placeholder="Osa (esim. juustokastike)"
          class="section"
        />`
      : ""}

    <select name="line.${index}.ingredient" aria-label="Aines">
      <option value="" ${values.ingredientChoice === "" ? "selected" : ""}>
        ${needsAnswer ? "— vastaa tähän —" : "— valitse aines —"}
      </option>
      <option value="new" ${values.ingredientChoice === "new" ? "selected" : ""}>
        ${proposedName === ""
          ? "Luo uusi aines"
          : `Hyväksy uutena: ${proposedName}`}
      </option>
      ${ingredients.map(
        (ingredient) => html`<option
          value="${ingredient.id}"
          ${values.ingredientChoice === String(ingredient.id)
            ? "selected"
            : ""}
        >
          ${ingredient.name}
        </option>`,
      )}
    </select>

    <input
      name="line.${index}.newName"
      value="${values.newName}"
      aria-label="Uuden aineksen nimi"
      placeholder="Uuden aineksen nimi"
    />
    <input
      name="line.${index}.source"
      value="${values.sourceLine}"
      aria-label="Lähderivi"
      placeholder="Lähderivi"
    />

    ${values.sourceLine === ""
      ? ""
      : html`<span class="source">${values.sourceLine}</span>`}

    <label class="remove">
      <input
        type="checkbox"
        name="line.${index}.remove"
        ${values.remove ? "checked" : ""}
      />
      Poista rivi
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

export function lineValuesFromDraft(
  line: DraftLine,
  index: number,
): LineFormValues {
  return {
    position: String(index + 1),
    quantity: line.quantity === null ? "" : formatDecimal(line.quantity),
    quantityMax:
      line.quantityMax === null ? "" : formatDecimal(line.quantityMax),
    unit: line.unit ?? "",
    altQuantity:
      line.altQuantity === null ? "" : formatDecimal(line.altQuantity),
    altUnit: line.altUnit ?? "",
    section: line.section ?? "",
    ingredientChoice:
      line.ingredientId === null ? "" : String(line.ingredientId),
    newName: line.ingredientName,
    sourceLine: line.sourceLine,
    remove: false,
  };
}

export function lineValuesFromForm(
  form: FormData,
  index: number,
): LineFormValues {
  return {
    position: field(form, `line.${index}.position`),
    quantity: field(form, `line.${index}.quantity`),
    quantityMax: field(form, `line.${index}.quantityMax`),
    unit: field(form, `line.${index}.unit`),
    altQuantity: field(form, `line.${index}.altQuantity`),
    altUnit: field(form, `line.${index}.altUnit`),
    section: field(form, `line.${index}.section`),
    ingredientChoice: field(form, `line.${index}.ingredient`),
    newName: field(form, `line.${index}.newName`),
    sourceLine: field(form, `line.${index}.source`),
    remove: form.get(`line.${index}.remove`) !== null,
  };
}

export function readLineCount(value: FormDataEntryValue | null): number {
  const text = String(value ?? "").trim();
  const count = Number(text);
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new FormRefused("Ainesrivien määrä on virheellinen.");
  }
  if (count > MAX_LINES) {
    throw new FormRefused(`Ainesrivejä voi olla enintään ${MAX_LINES}.`);
  }
  return count;
}

/** A safe count for re-rendering even when the submitted hidden count was bad. */
export function lineCountForRendering(form: FormData): number {
  try {
    return readLineCount(form.get("lineCount"));
  } catch {
    let highest = -1;
    for (const key of form.keys()) {
      const match = /^line\.(\d+)\./.exec(key);
      if (match === null) continue;
      const index = Number(match[1]);
      if (Number.isSafeInteger(index) && index >= 0 && index < MAX_LINES) {
        highest = Math.max(highest, index);
      }
    }
    return highest + 1;
  }
}

/**
 * The submitted lines, in the order the position boxes ask for. A spare row
 * nobody filled in is dropped; an unanswered real one is kept, so the gate can
 * refuse it rather than the parser silently losing it.
 */
export function readLines(form: FormData, lineCount: number): LineToSave[] {
  if (!Number.isSafeInteger(lineCount) || lineCount < 0 || lineCount > MAX_LINES) {
    throw new FormRefused(`Ainesrivejä voi olla enintään ${MAX_LINES}.`);
  }

  const rows: { position: number; line: LineToSave }[] = [];

  for (let i = 0; i < lineCount; i++) {
    const values = lineValuesFromForm(form, i);
    if (values.remove) continue;
    if (untouched(values)) continue;

    const quantity = positiveNumber(values.quantity, "Määrän");
    const quantityMax = positiveNumber(values.quantityMax, "Välin yläpään");
    if (quantityMax !== null && quantity === null) {
      throw new FormRefused("Välin yläpää tarvitsee myös alarajan.");
    }
    if (quantity !== null && quantityMax !== null && quantityMax < quantity) {
      throw new FormRefused("Välin yläpää ei voi olla alarajaa pienempi.");
    }

    const altQuantity = positiveNumber(values.altQuantity, "Toisen määrän");
    const altUnit = readText(values.altUnit);
    if ((altQuantity === null) !== (altUnit === null)) {
      throw new FormRefused(
        "Toinen mitta tarvitsee sekä määrän että yksikön.",
      );
    }
    if (altQuantity !== null && quantity === null) {
      throw new FormRefused("Toinen mitta tarvitsee myös ensimmäisen määrän.");
    }

    rows.push({
      position: positiveWhole(values.position, i + 1, "Järjestyksen"),
      line: {
        quantity,
        quantityMax,
        unit: readText(values.unit),
        altQuantity,
        altUnit,
        ingredient: readIngredient(form, i),
        sourceLine: values.sourceLine.trim(),
        section: readText(values.section),
      },
    });
  }

  return rows
    .sort((a, b) => a.position - b.position)
    .map((row) => row.line);
}

export function stepValuesFromForm(form: FormData): StepFormValues[] {
  const steps: StepFormValues[] = [];
  const seen = new Set<number>();

  for (const [key, value] of form.entries()) {
    const match = /^step\.(\d+)$/.exec(key);
    if (match === null) continue;

    const index = Number(match[1]);
    if (!Number.isSafeInteger(index) || index < 0 || index >= MAX_STEPS) {
      throw new FormRefused(`Vaiheita voi olla enintään ${MAX_STEPS}.`);
    }
    if (seen.has(index)) continue;
    seen.add(index);

    steps.push({
      index,
      position: field(form, `step.${index}.position`),
      text: String(value),
      section: field(form, `step.${index}.section`),
    });
  }

  if (steps.length > MAX_STEPS) {
    throw new FormRefused(`Vaiheita voi olla enintään ${MAX_STEPS}.`);
  }
  return steps.sort((a, b) => a.index - b.index);
}

export function stepValuesForRendering(form: FormData): StepFormValues[] {
  try {
    return stepValuesFromForm(form);
  } catch {
    const steps: StepFormValues[] = [];
    const seen = new Set<number>();
    for (const [key, value] of form.entries()) {
      const match = /^step\.(\d+)$/.exec(key);
      if (match === null) continue;
      const index = Number(match[1]);
      if (
        !Number.isSafeInteger(index) ||
        index < 0 ||
        index >= MAX_STEPS ||
        seen.has(index)
      ) {
        continue;
      }
      seen.add(index);
      steps.push({
        index,
        position: field(form, `step.${index}.position`),
        text: String(value),
        section: field(form, `step.${index}.section`),
      });
    }
    return steps.sort((a, b) => a.index - b.index);
  }
}

/** The steps, in the order their position boxes ask for. */
export function readSteps(form: FormData): StepToSave[] {
  return stepValuesFromForm(form)
    .map((values) => ({
      position: positiveWhole(
        values.position,
        values.index + 1,
        "Järjestyksen",
      ),
      step: {
        text: values.text,
        section: readText(values.section),
      },
    }))
    .sort((a, b) => a.position - b.position)
    .map((entry) => entry.step)
    .filter((step) => step.text.trim() !== "");
}

export function readIngredient(form: FormData, index: number): LineIngredient {
  const choice = field(form, `line.${index}.ingredient`);

  if (choice === "new") {
    return { kind: "new", name: field(form, `line.${index}.newName`) };
  }

  const id = Number(choice);
  if (Number.isSafeInteger(id) && id > 0) return { kind: "existing", id };

  return { kind: "unanswered" };
}

/** Accepts the Finnish decimal comma as well as a point, and rejects junk. */
export function readNumber(value: FormDataEntryValue | null): number | null {
  const text = String(value ?? "").trim().replace(",", ".");
  if (text === "") return null;

  const parsed = Number(text);
  if (!Number.isFinite(parsed)) {
    throw new FormRefused(`Kelvoton luku: ${String(value ?? "")}.`);
  }
  return parsed;
}

/** A positive whole number, or null when the field was deliberately blank. */
export function readWhole(value: FormDataEntryValue | null): number | null {
  const text = String(value ?? "").trim();
  if (text === "") return null;

  const parsed = readNumber(value);
  if (parsed === null || !Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new FormRefused("Annosmäärän pitää olla positiivinen kokonaisluku.");
  }
  return parsed;
}

export function readText(value: FormDataEntryValue | null): string | null {
  const text = String(value ?? "").trim();
  return text === "" ? null : text;
}

function positiveNumber(text: string, label: string): number | null {
  const value = readNumber(text);
  if (value !== null && value <= 0) {
    throw new FormRefused(`${label} pitää olla suurempi kuin nolla.`);
  }
  return value;
}

function positiveWhole(
  text: string,
  fallback: number,
  label: string,
): number {
  if (text.trim() === "") return fallback;
  const value = readNumber(text);
  if (value === null || !Number.isSafeInteger(value) || value <= 0) {
    throw new FormRefused(`${label} pitää olla positiivinen kokonaisluku.`);
  }
  return value;
}

function untouched(values: LineFormValues): boolean {
  return (
    values.ingredientChoice === "" &&
    values.newName.trim() === "" &&
    values.quantity.trim() === "" &&
    values.quantityMax.trim() === "" &&
    values.unit.trim() === "" &&
    values.altQuantity.trim() === "" &&
    values.altUnit.trim() === "" &&
    values.section.trim() === "" &&
    values.sourceLine.trim() === ""
  );
}

function field(form: FormData, name: string): string {
  return String(form.get(name) ?? "");
}

function isLineFormValues(
  line: DraftLine | LineFormValues,
): line is LineFormValues {
  return "ingredientChoice" in line;
}
