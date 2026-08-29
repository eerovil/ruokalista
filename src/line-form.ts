import { alternativeGroup } from "./alternatives.ts";
import { html, raw, type Raw } from "./html.ts";
import { decodeDraftRefs } from "./ingredient-refs.ts";
import type { IngredientSummary } from "./ingredients.ts";
import type { DraftLine } from "./intake.ts";
import { formatDecimal } from "./quantities.ts";
import type { RecipePhase } from "./recipe-phase.ts";
import type {
  ExpectedPart,
  LineIngredient,
  LineToSave,
  StepToSave,
} from "./recipe-save.ts";

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
  phase: string;
  /**
   * The alternative group this row is an option in (#183), as typed. Any
   * positive whole number will do: what matters is that two rows share it.
   */
  alternativeGroup: string;
  ingredientChoice: string;
  newName: string;
  sourceLine: string;
  /** The model's doubt about this line, carried so a refusal does not lose it. */
  note: string;
  remove: boolean;
}

export interface StepFormValues {
  index: number;
  position: string;
  text: string;
  section: string;
  phase: string;
  /**
   * The step's ingredient mentions, encoded (issue #120). Carried as one opaque
   * hidden field and never shown: it is the model's reading of the sentence,
   * not something anybody asked to maintain. It rides along so that editing a
   * step's wording does not silently throw its links away.
   */
  refs: string;
}

export interface LineRowOptions {
  /** Show a position box, so lines can be reordered without JavaScript. */
  reorderable?: boolean;
  /**
   * Show the part this line belongs to. Only intake needs it: once saved, a
   * part is a recipe of its own and is edited on its own screen.
   */
  sections?: boolean;
  /** Show cooking phase for content belonging to a multipart dish itself. */
  phases?: boolean;
  /**
   * The recipe editor's row (issue #128): the ingredient, the amount's number,
   * its unit as read-only context, and the remove box on the row itself. The
   * unit's editable field and everything else stay one tap down.
   *
   * Off by default, so the intake correction screen keeps the row it has. The
   * two screens are asking different questions: intake is checking a whole
   * import line by line against the text it came from, and the editor is
   * changing one thing about a recipe that is already right.
   */
  compact?: boolean;
  /**
   * Put the cursor on this row's ingredient picker. Used after `+ Lisää aines`,
   * which re-renders the whole screen, so that the browser scrolls to the new
   * row instead of dropping the member back at the top of a long form.
   */
  autofocusRow?: number;
}

/**
 * Which of this line's fields are the uncommon ones — the range's upper bound,
 * a second measurement, the part it belongs to, the source line, its position,
 * its removal. They are still on the form and still submit when hidden; a
 * closed `<details>` does not stop a field being sent.
 *
 * They are revealed rather than removed, and revealed *by default* whenever any
 * of them already carries a value, so a recipe that genuinely uses one is never
 * quietly hiding it — including on a re-render after a refusal.
 *
 * The unit is deliberately not one of them even on a compact row. Its value is
 * visible beside the amount, while its editable field stays behind the
 * disclosure; counting it would open almost every row and there would be
 * nothing compact left.
 */
function hasUncommonValues(
  values: LineFormValues,
  index: number,
  compact: boolean,
): boolean {
  return (
    values.quantityMax.trim() !== "" ||
    values.altQuantity.trim() !== "" ||
    values.altUnit.trim() !== "" ||
    values.section.trim() !== "" ||
    values.phase.trim() !== "" ||
    values.alternativeGroup.trim() !== "" ||
    // A compact row keeps its remove box in the open, so a ticked one is not a
    // reason to unfold anything.
    (!compact && values.remove) ||
    // A position that has been moved off its natural place is a decision
    // somebody made, so it shows.
    (values.position.trim() !== "" &&
      values.position.trim() !== String(index + 1))
  );
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
  const compact = options.compact === true;
  const expanded = hasUncommonValues(values, index, compact);

  const picker = html`<select
    name="line.${index}.ingredient"
    aria-label="Aines"
    ${options.autofocusRow === index ? "autofocus" : ""}
  >
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
        ${values.ingredientChoice === String(ingredient.id) ? "selected" : ""}
      >
        ${ingredient.name}
      </option>`,
    )}
  </select>`;

  const quantityBox = html`<input
    name="line.${index}.quantity"
    inputmode="decimal"
    value="${values.quantity}"
    aria-label="Määrä"
    placeholder="Määrä"
    class="qty"
  />`;

  const removeBox = html`<label class="remove">
    <input
      type="checkbox"
      name="line.${index}.remove"
      ${values.remove ? "checked" : ""}
    />
    Poista
  </label>`;

  return html`<li class="${lineClass(isNew, compact)}">
    ${isNew
      ? html`<span class="badge is-decision"
          >${needsAnswer ? "Vastaa: uusi aines?" : "Uusi aines"}</span
        >`
      : ""}

    ${compact
      ? // Keep the unit visible as context while leaving unit editing with the
        // less common fields under the disclosure.
        html`<div class="line-main">
          ${picker} ${quantityBox}
          ${values.unit.trim() === ""
            ? ""
            : html`<span class="line-unit">${values.unit}</span>`}
          ${removeBox}
        </div>`
      : // The common path: how much, of what. Everything else is one tap down.
        html`<div class="amounts">
            ${quantityBox}
            <input
              name="line.${index}.unit"
              value="${values.unit}"
              aria-label="Yksikkö"
              placeholder="Yksikkö"
              class="unit"
            />
          </div>

          ${picker}`}

    <!-- The proposed name only earns its place while the line is asking to
         create one. Otherwise it rides along below with the rest. -->
    ${isNew
      ? html`<input
          name="line.${index}.newName"
          value="${values.newName}"
          aria-label="Uuden aineksen nimi"
          placeholder="Uuden aineksen nimi"
        />`
      : ""}

    ${values.note === ""
      ? ""
      : html`<input type="hidden" name="line.${index}.note" value="${values.note}" />`}

    ${values.sourceLine === "" || compact
      ? ""
      : html`<span class="source">${values.sourceLine}</span>`}

    <!-- Everything below is labelled rather than placeholdered: a filled field
         shows no placeholder, so grouping these behind a disclosure without
         labels would leave a column of naked numbers. -->
    <details class="line-more" ${expanded ? "open" : ""}>
      <summary>${compact ? "Lisää asetuksia" : "Lisätiedot"}</summary>

      <div class="more-fields">
        ${compact
          ? field(`line.${index}.unit`, "Yksikkö", values.unit)
          : ""}
        ${options.reorderable
          ? field(
              `line.${index}.position`,
              "Järjestys",
              values.position,
              "numeric",
            )
          : ""}
        ${field(
          `line.${index}.quantityMax`,
          "Välin yläpää",
          values.quantityMax,
          "decimal",
        )}
        ${field(
          `line.${index}.altQuantity`,
          "Toinen määrä",
          values.altQuantity,
          "decimal",
        )}
        ${field(`line.${index}.altUnit`, "Toinen yksikkö", values.altUnit)}
        ${options.sections
          ? field(
              `line.${index}.section`,
              "Osa (esim. juustokastike)",
              values.section,
            )
          : ""}
        ${field(
          `line.${index}.alternativeGroup`,
          "Vaihtoehtoryhmä (sama numero = tai)",
          values.alternativeGroup,
          "numeric",
        )}
        ${options.phases && values.section.trim() === ""
          ? phaseSelect(`line.${index}.phase`, values.phase)
          : ""}
        ${isNew
          ? ""
          : field(
              `line.${index}.newName`,
              "Uuden aineksen nimi",
              values.newName,
            )}
        ${field(`line.${index}.source`, "Lähderivi", values.sourceLine)}
      </div>

      ${compact
        ? ""
        : html`<label class="remove">
            <input
              type="checkbox"
              name="line.${index}.remove"
              ${values.remove ? "checked" : ""}
            />
            Poista rivi
          </label>`}
    </details>
  </li>`;
}

function lineClass(isNew: boolean, compact: boolean): string {
  return ["line", isNew ? "is-new" : "", compact ? "is-compact" : ""]
    .filter((name) => name !== "")
    .join(" ");
}

/** One labelled field. The name doubles as the id, which is already unique. */
function field(
  name: string,
  label: string,
  value: string,
  inputMode?: "numeric" | "decimal",
): Raw {
  return html`<div class="more-field">
    <label for="${name}">${label}</label>
    <input
      id="${name}"
      name="${name}"
      value="${value}"
      ${inputMode === undefined ? "" : raw(`inputmode="${inputMode}"`)}
    />
  </div>`;
}

/**
 * The ingredient rows, with the unused spares folded away.
 *
 * Both screens append blank rows so a line the model missed can be added
 * without JavaScript. Rendering them permanently means every recipe ends in
 * three empty forms; putting them behind a disclosure keeps the add-a-line
 * escape hatch and stops it being the last thing on the screen.
 *
 * Which rows are spare is not remembered between requests — it is read back off
 * the values, as "everything after the last row anybody put anything in". A
 * spare somebody filled in and had refused is therefore a real row again.
 *
 * A compact list (the recipe editor, issue #128) has no spares at all. Every row
 * on screen is a row somebody meant, and the list ends in a plain
 * `+ Lisää aines` button that asks the server for exactly one more. That button
 * submits rather than scripting the row in, so it works on the same browsers
 * everything else here does.
 */
export function lineRows(
  rows: Array<DraftLine | LineFormValues>,
  ingredients: IngredientSummary[],
  options: LineRowOptions = {},
): Raw {
  const values = rows.map((row, index) =>
    isLineFormValues(row) ? row : lineValuesFromDraft(row, index),
  );

  if (options.compact === true) {
    return html`<ol class="edit-lines">
        ${values.map((row, index) => lineRow(row, index, ingredients, options))}
      </ol>
      <p class="add-line">
        <button type="submit" name="addLine" value="1">+ Lisää aines</button>
      </p>`;
  }

  let realCount = 0;
  for (let i = 0; i < values.length; i++) {
    if (!untouched(values[i]!)) realCount = i + 1;
  }

  const spares = values.slice(realCount);

  return html`<ol class="edit-lines">
      ${values
        .slice(0, realCount)
        .map((row, index) => lineRow(row, index, ingredients, options))}
    </ol>
    ${spares.length === 0
      ? ""
      : html`<details class="add-lines">
          <summary>+ Lisää ainesrivi</summary>
          <ol class="edit-lines" start="${realCount + 1}">
            ${spares.map((row, offset) =>
              lineRow(row, realCount + offset, ingredients, options),
            )}
          </ol>
        </details>`}`;
}

export function emptyLine(): DraftLine {
  return {
    quantity: null,
    quantityMax: null,
    unit: null,
    altQuantity: null,
    altUnit: null,
    alternativeGroup: null,
    ingredientId: null,
    ingredientName: "",
    sourceLine: "",
    section: null,
    phase: null,
    note: null,
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
    phase: line.phase ?? "",
    alternativeGroup:
      line.alternativeGroup === null ? "" : String(line.alternativeGroup),
    // A name the model proposed is preselected as "create it". Unmatched
    // ingredients are almost always genuinely new, so asking once per line
    // charged for a decision nobody was really making (#53). The names are
    // still stated on screen before saving, and the gate still refuses a line
    // with no answer at all — it is only the model's proposals that default.
    ingredientChoice:
      line.ingredientId !== null
        ? String(line.ingredientId)
        : line.ingredientName.trim() === ""
          ? ""
          : "new",
    newName: line.ingredientName,
    sourceLine: line.sourceLine,
    note: line.note ?? "",
    remove: false,
  };
}

export function lineValuesFromForm(
  form: FormData,
  index: number,
): LineFormValues {
  return {
    position: formField(form, `line.${index}.position`),
    quantity: formField(form, `line.${index}.quantity`),
    quantityMax: formField(form, `line.${index}.quantityMax`),
    unit: formField(form, `line.${index}.unit`),
    altQuantity: formField(form, `line.${index}.altQuantity`),
    altUnit: formField(form, `line.${index}.altUnit`),
    section: formField(form, `line.${index}.section`),
    phase: formField(form, `line.${index}.phase`),
    alternativeGroup: formField(form, `line.${index}.alternativeGroup`),
    ingredientChoice: formField(form, `line.${index}.ingredient`),
    newName: formField(form, `line.${index}.newName`),
    sourceLine: formField(form, `line.${index}.source`),
    note: formField(form, `line.${index}.note`),
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
        phase: readPhase(values.phase),
        alternativeGroup: readAlternativeGroup(values.alternativeGroup),
        // The row this came from, kept because a step's mention points at it.
        // What this function returns is sorted by the position boxes and has
        // the removed rows taken out, so a place in that array is not a row.
        formIndex: i,
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
      position: formField(form, `step.${index}.position`),
      text: String(value),
      section: formField(form, `step.${index}.section`),
      phase: formField(form, `step.${index}.phase`),
      refs: formField(form, `step.${index}.refs`),
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
        position: formField(form, `step.${index}.position`),
        text: String(value),
        section: formField(form, `step.${index}.section`),
        phase: formField(form, `step.${index}.phase`),
        refs: formField(form, `step.${index}.refs`),
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
        phase: readPhase(values.phase),
        refs: decodeDraftRefs(values.refs),
      },
    }))
    .sort((a, b) => a.position - b.position)
    .map((entry) => entry.step)
    .filter((step) => step.text.trim() !== "");
}

/**
 * How many parts one dish's form may carry expectations for. Well past any real
 * dish; it is here only so an untrusted `partCount` cannot ask for a long loop.
 */
const MAX_PARTS = 100;

/**
 * The dish's parts as this form last saw them (#208): which rows they were, and
 * at which revision.
 *
 * A part is a recipe row with its own editor screen (ADR-0002), so the dish's
 * own hidden `revision` says nothing about whether a part moved. These fields
 * are the rest of that lock, and `replaceRecipe` refuses the whole save if one
 * of them no longer holds. They ride in the form rather than being re-read at
 * save time on purpose: what has to be checked is what the member reviewed, not
 * what happens to be in the database when they press the button.
 */
export function setExpectedParts(
  form: FormData,
  parts: readonly ExpectedPart[],
): void {
  form.set("partCount", String(parts.length));
  parts.forEach((part, index) => {
    form.set(`part.${index}.id`, String(part.id));
    form.set(`part.${index}.title`, part.title);
    form.set(`part.${index}.revision`, String(part.revision));
  });
}

/**
 * The same, read back.
 *
 * A malformed entry is dropped rather than refused, and that is safe in the
 * direction that matters: an expectation that goes missing does not weaken the
 * lock, because a section naming a part nobody expected is refused by
 * `replaceRecipe` rather than written. Refusing here instead would throw inside
 * the re-render of the very form being refused.
 */
export function readExpectedParts(form: FormData): ExpectedPart[] {
  const declared = Number(String(form.get("partCount") ?? "").trim());
  if (!Number.isSafeInteger(declared) || declared <= 0) return [];

  const parts: ExpectedPart[] = [];
  for (let index = 0; index < Math.min(declared, MAX_PARTS); index += 1) {
    const id = Number(formField(form, `part.${index}.id`));
    const revision = Number(formField(form, `part.${index}.revision`));
    const title = formField(form, `part.${index}.title`).trim();

    if (!Number.isSafeInteger(id) || id <= 0) continue;
    if (!Number.isSafeInteger(revision) || revision < 0) continue;
    if (title === "") continue;

    parts.push({ id, title, revision });
  }

  return parts;
}

/** Those expectations as the hidden fields that carry them to the next post. */
export function expectedPartFields(parts: readonly ExpectedPart[]): Raw {
  if (parts.length === 0) return raw("");

  return html`<input type="hidden" name="partCount" value="${parts.length}" />
    ${parts.map(
      (part, index) => html`<input
          type="hidden"
          name="part.${index}.id"
          value="${part.id}"
        />
        <input
          type="hidden"
          name="part.${index}.title"
          value="${part.title}"
        />
        <input
          type="hidden"
          name="part.${index}.revision"
          value="${part.revision}"
        />`,
    )}`;
}

export function readIngredient(form: FormData, index: number): LineIngredient {
  const choice = formField(form, `line.${index}.ingredient`);

  if (choice === "new") {
    return { kind: "new", name: formField(form, `line.${index}.newName`) };
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

/**
 * A row's alternative group, refusing what somebody plainly meant as a number.
 *
 * `alternatives.ts::alternativeGroup` is total by design — it is also read on
 * the column and on the model's JSON, where an unusable value has to degrade to
 * "no group". A form is the one edge where that would be wrong: somebody typing
 * `-1` or `kaksi` in the box is asking for a grouping, and silently saving the
 * line ungrouped would lose the edit without saying so.
 */
export function readAlternativeGroup(value: string): number | null {
  if (value.trim() === "") return null;
  const group = alternativeGroup(value);
  if (group === null) {
    throw new FormRefused(
      "Vaihtoehtoryhmän pitää olla positiivinen kokonaisluku.",
    );
  }
  return group;
}

export function readPhase(value: FormDataEntryValue | null): RecipePhase {
  const phase = String(value ?? "").trim();
  if (phase === "") return null;
  if (phase === "before_parts" || phase === "after_parts") return phase;
  throw new FormRefused("Ruoanlaittovaihe on virheellinen.");
}

/** A semantic choice, phrased as cooking order rather than storage vocabulary. */
export function phaseSelect(name: string, value: string): Raw {
  return html`<label>
    Milloin tämä tehdään?
    <select name="${name}" aria-label="Milloin tämä tehdään?">
      <option value="" ${value === "" ? "selected" : ""}>
        Luokittelematon (näytetään ennen osia)
      </option>
      <option value="before_parts" ${value === "before_parts" ? "selected" : ""}>
        Ennen osien valmistusta
      </option>
      <option value="after_parts" ${value === "after_parts" ? "selected" : ""}>
        Osien valmistuksen jälkeen
      </option>
    </select>
  </label>`;
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
    values.phase.trim() === "" &&
    values.alternativeGroup.trim() === "" &&
    values.sourceLine.trim() === ""
  );
}

function formField(form: FormData, name: string): string {
  return String(form.get(name) ?? "");
}

function isLineFormValues(
  line: DraftLine | LineFormValues,
): line is LineFormValues {
  return "ingredientChoice" in line;
}