/**
 * The recipe snapshots an existing-recipe intake job carries (#215).
 *
 * The server loads the dish itself when the job is created and stores it on the
 * job row, so the model, the review's change list and the save's optimistic
 * checks all read the same recipe. A browser run stubs the import endpoint, so
 * these stand in for what the server would have loaded — which is why they are
 * written to match `dev/seed.sql` exactly, revisions and part ids included,
 * rather than being a convenient approximation. A snapshot that disagreed with
 * the seeded rows would make the review's *Poistettu* lines and the staleness
 * refusals say things about a recipe that is not the one on disk.
 */

const OWNER = {
  createdAt: "",
  createdBy: "Eero",
  imageKey: null,
  householdId: 1,
  householdName: "Koti",
  publishedAt: null,
  shareCount: 0,
  categories: [] as string[],
  sourceRoute: "pasted" as const,
  sourceUrl: null,
  revision: 0,
};

function line(
  position: number,
  ingredientId: number,
  ingredient: string,
  quantity: number | null,
  unit: string | null,
  sourceLine: string,
  over: { quantityMax?: number | null; altQuantity?: number | null; altUnit?: string | null; phase?: "before_parts" | "after_parts" | null } = {},
) {
  return {
    position,
    quantity,
    quantityMax: over.quantityMax ?? null,
    unit,
    altQuantity: over.altQuantity ?? null,
    altUnit: over.altUnit ?? null,
    ingredientId,
    ingredient,
    productImageUrl: null,
    sourceLine,
    phase: over.phase ?? null,
    alternativeGroup: null,
  };
}

/** Seeded recipe 1: a plain dish, four lines, three steps with mentions. */
export const KAALILAATIKKO = {
  ...OWNER,
  id: 1,
  title: "Kaalilaatikko",
  yieldPortions: 4,
  sourceText:
    "Kaalilaatikko\n½ dl öljyä\n1–1 ja ½ l vettä\n½ (500 g) valkokaali\nhieman sitruunaruohoa",
  parentId: null,
  parts: [],
  lines: [
    line(1, 1, "öljy", 0.5, "dl", "½ dl öljyä"),
    line(2, 2, "vesi", 1, "l", "1–1 ja ½ l vettä", { quantityMax: 1.5 }),
    line(3, 3, "valkokaali", 0.5, "kpl", "½ (500 g) valkokaali", {
      altQuantity: 500,
      altUnit: "g",
    }),
    line(4, 4, "sitruunaruoho", null, null, "hieman sitruunaruohoa"),
  ],
  steps: [
    {
      text: "Kuullota kaali öljyssä.",
      phase: null,
      refs: [
        { ingredientId: 3, matchedText: "kaali", approxPosition: 9 },
        { ingredientId: 1, matchedText: "öljyssä", approxPosition: 15 },
      ],
    },
    {
      text: "Lisää vesi ja hauduta.",
      phase: null,
      refs: [{ ingredientId: 2, matchedText: "vesi", approxPosition: 6 }],
    },
    {
      text: "Mausta sitruunaruoholla ja tarjoa.",
      phase: null,
      refs: [
        { ingredientId: 4, matchedText: "sitruunaruoholla", approxPosition: 7 },
        { ingredientId: 3, matchedText: "kaali", approxPosition: 0 },
      ],
    },
  ],
};

const LASAGNE_SOURCE =
  "Lasagne\nJauhelihakastike\n400 g jauhelihaa\nJuustokastike\n5 dl maitoa\n2 dl juustoa";

/** Seeded recipe 4: the lasagne's jauhelihakastike, a recipe row of its own. */
export const JAUHELIHAKASTIKE = {
  ...OWNER,
  id: 4,
  title: "Jauhelihakastike",
  yieldPortions: null,
  sourceText: "Lasagne",
  parentId: 3,
  parts: [],
  lines: [line(1, 7, "jauheliha", 400, "g", "400 g jauhelihaa")],
  steps: [
    { text: "Ruskista jauheliha.", phase: null, refs: [] },
    {
      text: "Anna jauhelihan hautua hetki.",
      phase: null,
      refs: [{ ingredientId: 7, matchedText: "jauhelihan", approxPosition: 5 }],
    },
  ],
};

/** Seeded recipe 5: the juustokastike, the part the staleness scenario edits. */
export const JUUSTOKASTIKE = {
  ...OWNER,
  id: 5,
  title: "Juustokastike",
  yieldPortions: null,
  sourceText: "Lasagne",
  parentId: 3,
  parts: [],
  lines: [
    line(1, 9, "maito", 5, "dl", "5 dl maitoa"),
    line(2, 8, "juusto", 2, "dl", "2 dl juustoa"),
  ],
  steps: [
    { text: "Kuumenna maito ja sulata juusto joukkoon.", phase: null, refs: [] },
  ],
};

/** Seeded recipe 3: the dish written in named parts (ADR-0002). */
export const LASAGNE = {
  ...OWNER,
  id: 3,
  title: "Lasagne",
  yieldPortions: 6,
  sourceText: LASAGNE_SOURCE,
  parentId: null,
  parts: [JAUHELIHAKASTIKE, JUUSTOKASTIKE],
  lines: [
    line(1, 10, "lasagnelevy", 12, "kpl", "12 lasagnelevyä", {
      phase: "after_parts",
    }),
  ],
  steps: [
    { text: "Voitele vuoka.", phase: null, refs: [] },
    { text: "Lämmitä uuni 200 asteeseen.", phase: "before_parts", refs: [] },
    {
      text: "Kokoa vuokaan ja paista 40 minuuttia.",
      phase: "after_parts",
      refs: [],
    },
  ],
};
