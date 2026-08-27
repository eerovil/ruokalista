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
