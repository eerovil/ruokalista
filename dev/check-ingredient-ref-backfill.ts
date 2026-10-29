import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";

import { MAX_REFS_PER_STEP } from "../src/ingredient-refs.ts";
import {
  buildBackfillExport,
  generateBackfillSql,
  parseBackfillExport,
  parseSignedBackfillSnapshot,
  type BackfillSnapshot,
} from "../scripts/ingredient-ref-backfill.ts";
import { canonicalJson } from "../src/backup.ts";

const digest = "a".repeat(64);

function snapshot(): BackfillSnapshot {
  return {
    sha256: digest,
    captured_at: "2026-08-27T06:00:00.000Z",
    tables: {
      recipe: [{ id: 10 }, { id: 11 }],
      ingredient: [
        { id: 7, name: "tomaatti" },
        { id: 8, name: "crème fraîche" },
      ],
      ingredient_line: [
        { recipe_id: 10, position: 2, ingredient_id: 8 },
        { recipe_id: 10, position: 1, ingredient_id: 7 },
        { recipe_id: 11, position: 1, ingredient_id: 7 },
      ],
      recipe_step: [
        {
          recipe_id: 10,
          position: 1,
          text: "Lisää tomaatit ja crème fraîche.",
          ingredient_refs: null,
        },
        {
          recipe_id: 10,
          position: 2,
          text: "Keitä hetki.",
        },
        {
          recipe_id: 11,
          position: 1,
          text: "Lisää tomaatit.",
          ingredient_refs: "[]",
        },
      ],
    },
  };
}

function marks(refs: unknown[]): unknown {
  return {
    formatVersion: 1,
    snapshotSha256: digest,
    recipes: [{ recipeId: 10, steps: [{ position: 1, ingredientRefs: refs }] }],
  };
}

test("the export contains only unmarked steps and the minimum marking context", () => {
  const exported = buildBackfillExport(snapshot());
  assert.deepEqual(exported, {
    formatVersion: 1,
    snapshotSha256: digest,
    capturedAt: "2026-08-27T06:00:00.000Z",
    recipes: [{
      recipeId: 10,
      ingredients: [
        { position: 1, ingredientId: 7, name: "tomaatti" },
        { position: 2, ingredientId: 8, name: "crème fraîche" },
      ],
      steps: [
        { position: 1, text: "Lisää tomaatit ja crème fraîche." },
        { position: 2, text: "Keitä hetki." },
      ],
    }],
  });
  assert.doesNotMatch(JSON.stringify(exported), /title|quantity|household/i);
});

test("a signed snapshot may trail unrelated current tables", async () => {
  const fixture = snapshot();
  const unsigned = {
    format_version: 1,
    scheduled_at: "2026-08-27T02:00:00.000Z",
    captured_at: fixture.captured_at,
    schema: [],
    row_counts: Object.fromEntries(
      Object.entries(fixture.tables).map(([name, rows]) => [name, rows.length]),
    ),
    tables: fixture.tables,
  };
  const hash = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(canonicalJson(unsigned as never)),
  );
  const sha256 = Array.from(new Uint8Array(hash), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  const parsed = await parseSignedBackfillSnapshot(JSON.stringify({ ...unsigned, sha256 }));
  assert.equal(parsed.sha256, sha256);

  await assert.rejects(
    () => parseSignedBackfillSnapshot(JSON.stringify({ ...unsigned, sha256: "b".repeat(64) })),
    /SHA-256 does not match/,
  );
});

test("valid marks emit guarded SQL that changes only ingredient_refs", () => {
  const exported = buildBackfillExport(snapshot());
  const result = generateBackfillSql(exported, marks([
    { ingredientId: 7, matchedText: "tomaatit", approxPosition: 6 },
    { ingredientId: 8, matchedText: "crème fraîche", approxPosition: 18 },
  ]));

  assert.equal(result.acceptedMarks, 2);
  assert.equal(result.droppedMarks, 0);
  assert.equal(result.updatedSteps, 1);
  assert.match(result.sql, /^UPDATE recipe_step$/m);
  assert.match(result.sql, /^SET ingredient_refs = /m);
  assert.match(result.sql, /WHERE recipe_id = 10 AND position = 1/);
  assert.match(result.sql, /AND text = 'Lisää tomaatit ja crème fraîche\.'/);
  assert.match(result.sql, /AND ingredient_refs IS NULL/);
  assert.match(result.sql, /ingredient_id = 7/);
  assert.match(result.sql, /ingredient_id = 8/);
  assert.doesNotMatch(result.sql, /UPDATE recipe\b|UPDATE ingredient_line/);
});

test("generated SQL changes only refs and is safe to execute twice", () => {
  const exported = buildBackfillExport(snapshot());
  const result = generateBackfillSql(exported, marks([
    { ingredientId: 7, matchedText: "tomaatit", approxPosition: 6 },
  ]));
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE recipe_step (
      recipe_id INTEGER NOT NULL,
      position INTEGER NOT NULL,
      text TEXT NOT NULL,
      ingredient_refs TEXT,
      untouched TEXT NOT NULL,
      PRIMARY KEY (recipe_id, position)
    );
    CREATE TABLE ingredient_line (recipe_id INTEGER NOT NULL, ingredient_id INTEGER NOT NULL);
    INSERT INTO recipe_step VALUES (
      10, 1, 'Lisää tomaatit ja crème fraîche.', NULL, 'keep me'
    );
    INSERT INTO ingredient_line VALUES (10, 7);
  `);
  const before = db.prepare("SELECT * FROM recipe_step").get() as Record<string, unknown>;
  db.exec(result.sql);
  const afterFirst = db.prepare("SELECT * FROM recipe_step").get() as Record<string, unknown>;
  db.exec(result.sql);
  const afterSecond = db.prepare("SELECT * FROM recipe_step").get() as Record<string, unknown>;

  assert.equal(afterFirst.ingredient_refs, '[{"ingredientId":7,"matchedText":"tomaatit","approxPosition":6}]');
  assert.deepEqual(afterSecond, afterFirst);
  assert.deepEqual(
    { ...afterFirst, ingredient_refs: before.ingredient_refs },
    { ...before },
  );
  db.close();
});

test("SQL string literals preserve apostrophes safely", () => {
  const exported = buildBackfillExport(snapshot());
  const recipe = exported.recipes[0];
  const step = recipe?.steps[0];
  assert.ok(step);
  step.text = "Lisää tomaatit chef's choice -kastikkeeseen.";
  const result = generateBackfillSql(exported, marks([
    { ingredientId: 7, matchedText: "tomaatit", approxPosition: 6 },
  ]));
  assert.match(result.sql, /chef''s choice/);
});

test("unknown ingredients, stale wording and malformed marks are dropped", () => {
  const exported = buildBackfillExport(snapshot());
  const result = generateBackfillSql(exported, marks([
    { ingredientId: 999, matchedText: "tomaatit", approxPosition: 6 },
    { ingredientId: 7, matchedText: "paprika", approxPosition: 6 },
    { ingredientId: 7, matchedText: "tomaatit", approxPosition: -1 },
  ]));
  assert.equal(result.acceptedMarks, 0);
  assert.equal(result.droppedMarks, 3);
  assert.equal(result.updatedSteps, 0);
  assert.doesNotMatch(result.sql, /^UPDATE /m);
});

test("a step over the cap is dropped rather than truncated", () => {
  const exported = buildBackfillExport(snapshot());
  const tooMany = Array.from({ length: MAX_REFS_PER_STEP + 1 }, () => ({
    ingredientId: 7,
    matchedText: "tomaatit",
    approxPosition: 6,
  }));
  const result = generateBackfillSql(exported, marks(tooMany));
  assert.equal(result.acceptedMarks, 0);
  assert.equal(result.droppedMarks, MAX_REFS_PER_STEP + 1);
  assert.equal(result.updatedSteps, 0);
});

test("an empty confident set leaves the recipe untouched", () => {
  const exported = buildBackfillExport(snapshot());
  const result = generateBackfillSql(exported, marks([]));
  assert.equal(result.updatedSteps, 0);
  assert.doesNotMatch(result.sql, /^UPDATE /m);
});

test("a duplicate recipe or step target cannot emit a second update", () => {
  const exported = buildBackfillExport(snapshot());
  const oneRef = { ingredientId: 7, matchedText: "tomaatit", approxPosition: 6 };
  const result = generateBackfillSql(exported, {
    formatVersion: 1,
    snapshotSha256: digest,
    recipes: [
      { recipeId: 10, steps: [
        { position: 1, ingredientRefs: [oneRef] },
        { position: 1, ingredientRefs: [oneRef] },
      ] },
      { recipeId: 10, steps: [{ position: 1, ingredientRefs: [oneRef] }] },
    ],
  });
  assert.equal(result.updatedSteps, 1);
  assert.equal(result.acceptedMarks, 1);
  assert.equal(result.droppedMarks, 2);
});

test("marks must name the exact export snapshot", () => {
  const exported = buildBackfillExport(snapshot());
  assert.throws(
    () => generateBackfillSql(exported, {
      formatVersion: 1,
      snapshotSha256: "b".repeat(64),
      recipes: [],
    }),
    /different snapshot/,
  );
});

test("malformed recipe and step envelopes are refused clearly", () => {
  const exported = buildBackfillExport(snapshot());
  assert.throws(
    () => generateBackfillSql(exported, {
      formatVersion: 1,
      snapshotSha256: digest,
      recipes: [{ recipeId: 10, steps: [], extra: true }],
    }),
    /unexpected fields/,
  );
  assert.throws(
    () => generateBackfillSql(exported, {
      formatVersion: 1,
      snapshotSha256: digest,
      recipes: [{ recipeId: 10, steps: [{ position: 1, ingredientRefs: "no" }] }],
    }),
    /ingredientRefs is invalid/,
  );
});

test("the private export parser refuses shape drift", () => {
  const exported = buildBackfillExport(snapshot());
  assert.deepEqual(parseBackfillExport(JSON.parse(JSON.stringify(exported))), exported);
  assert.throws(
    () => parseBackfillExport({ ...exported, householdId: 1 }),
    /unexpected fields/,
  );
});

// ------------------------------------------------------------ groups (#376)

const maitoRef = '[{"ingredientId":3,"matchedText":"maito","approxPosition":31}]';

function groupSnapshot(): BackfillSnapshot {
  return {
    sha256: digest,
    captured_at: "2026-10-29T06:00:00.000Z",
    tables: {
      recipe: [{ id: 20 }],
      ingredient: [
        { id: 1, name: "vehnäjauho" },
        { id: 2, name: "leivinjauhe" },
        { id: 3, name: "maito" },
      ],
      ingredient_line: [
        { recipe_id: 20, position: 1, ingredient_id: 1 },
        { recipe_id: 20, position: 2, ingredient_id: 2 },
        { recipe_id: 20, position: 3, ingredient_id: 3 },
      ],
      recipe_step: [
        {
          recipe_id: 20,
          position: 1,
          text: "Yhdistä kuivat aineet ja lisää maito.",
          ingredient_refs: maitoRef,
        },
        { recipe_id: 20, position: 2, text: "Paista.", ingredient_refs: null },
      ],
    },
  };
}

function groupMarks(refs: unknown[]): unknown {
  return {
    formatVersion: 2,
    snapshotSha256: digest,
    recipes: [{ recipeId: 20, steps: [{ position: 1, ingredientRefs: refs }] }],
  };
}

const dryGroup = [
  { ingredientId: 1, matchedText: "kuivat aineet", approxPosition: 8 },
  { ingredientId: 2, matchedText: "kuivat aineet", approxPosition: 8 },
];

test("the group export offers marked steps too, with what they hold", () => {
  const unmarked = buildBackfillExport(groupSnapshot());
  assert.deepEqual(unmarked.recipes[0]?.steps.map((step) => step.position), [2]);

  const exported = buildBackfillExport(groupSnapshot(), "groups");
  assert.equal(exported.formatVersion, 2);
  assert.deepEqual(exported.recipes[0]?.steps, [
    { position: 1, text: "Yhdistä kuivat aineet ja lisää maito.", existingRefs: maitoRef },
    { position: 2, text: "Paista.", existingRefs: null },
  ]);
  assert.deepEqual(parseBackfillExport(JSON.parse(JSON.stringify(exported))), exported);
});

test("a group is added after the step's own refs, guarded on them, once", () => {
  const exported = buildBackfillExport(groupSnapshot(), "groups");
  const result = generateBackfillSql(exported, groupMarks([
    ...dryGroup,
    // A lone mark is the #120 job's, not this one's.
    { ingredientId: 3, matchedText: "maito", approxPosition: 31 },
  ]));

  assert.equal(result.acceptedMarks, 2);
  assert.equal(result.droppedMarks, 1);
  assert.equal(result.updatedSteps, 1);
  assert.match(result.sql, /AND ingredient_refs = '\[\{"ingredientId":3/);
  assert.doesNotMatch(result.sql, /ingredient_refs IS NULL/);

  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE recipe_step (
      recipe_id INTEGER NOT NULL,
      position INTEGER NOT NULL,
      text TEXT NOT NULL,
      ingredient_refs TEXT,
      PRIMARY KEY (recipe_id, position)
    );
    CREATE TABLE ingredient_line (recipe_id INTEGER NOT NULL, ingredient_id INTEGER NOT NULL);
    INSERT INTO ingredient_line VALUES (20, 1), (20, 2), (20, 3);
  `);
  db.prepare("INSERT INTO recipe_step VALUES (20, 1, ?, ?)").run(
    "Yhdistä kuivat aineet ja lisää maito.",
    maitoRef,
  );
  db.exec(result.sql);
  const afterFirst = db.prepare("SELECT ingredient_refs FROM recipe_step").get() as {
    ingredient_refs: string;
  };
  db.exec(result.sql);
  const afterSecond = db.prepare("SELECT ingredient_refs FROM recipe_step").get();

  assert.deepEqual(
    JSON.parse(afterFirst.ingredient_refs).map((ref: { ingredientId: number }) => ref.ingredientId),
    [3, 1, 2],
  );
  assert.deepEqual(afterSecond, afterFirst);
  db.close();
});

test("a group the step already holds, or a step edited since, changes nothing", () => {
  const snap = groupSnapshot();
  const already = JSON.stringify(dryGroup);
  (snap.tables.recipe_step[0] as Record<string, unknown>).ingredient_refs = already;
  const exported = buildBackfillExport(snap, "groups");
  assert.equal(generateBackfillSql(exported, groupMarks(dryGroup)).updatedSteps, 0);

  const fresh = buildBackfillExport(groupSnapshot(), "groups");
  const sql = generateBackfillSql(fresh, groupMarks(dryGroup)).sql;
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE recipe_step (
      recipe_id INTEGER NOT NULL, position INTEGER NOT NULL,
      text TEXT NOT NULL, ingredient_refs TEXT
    );
    CREATE TABLE ingredient_line (recipe_id INTEGER NOT NULL, ingredient_id INTEGER NOT NULL);
    INSERT INTO ingredient_line VALUES (20, 1), (20, 2), (20, 3);
    INSERT INTO recipe_step VALUES (20, 1, 'Yhdistä kuivat aineet ja lisää maito.', NULL);
  `);
  db.exec(sql);
  // The column moved since the snapshot (here: emptied), so the guard refuses.
  const row = db.prepare("SELECT ingredient_refs FROM recipe_step").get() as {
    ingredient_refs: string | null;
  };
  assert.equal(row.ingredient_refs, null);
  db.close();
});

test("marks must be made for the same job as the export", () => {
  const exported = buildBackfillExport(groupSnapshot(), "groups");
  assert.throws(
    () => generateBackfillSql(exported, { ...(groupMarks(dryGroup) as object), formatVersion: 1 }),
    /formatVersion does not match/,
  );
});
