import assert from "node:assert/strict";
import test from "node:test";

import { DRAFT_SCHEMA } from "../src/intake.ts";

/**
 * Structured outputs accept a subset of JSON Schema, and a keyword outside it
 * does not degrade — the whole request is a 400, so *every* model-backed
 * import fails at once. That is what `maxItems` did after #120: the schema
 * change shipped unproven because nothing about it needed a paid call, and the
 * first symptom a household saw was "the model returned unparseable JSON" on
 * an intake screen three hops away from the cause.
 *
 * This walks the schema instead, so the next unsupported keyword is a failing
 * check rather than a broken import.
 */
const UNSUPPORTED = [
  "maxItems",
  "minItems",
  "uniqueItems",
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "multipleOf",
  "minLength",
  "maxLength",
  "pattern",
  "minProperties",
  "maxProperties",
];

function walk(node: unknown, path: string, found: string[]): void {
  if (Array.isArray(node)) {
    node.forEach((item, index) => walk(item, `${path}[${index}]`, found));
    return;
  }
  if (typeof node !== "object" || node === null) return;

  for (const [key, value] of Object.entries(node)) {
    if (UNSUPPORTED.includes(key)) found.push(`${path}.${key}`);
    walk(value, `${path}.${key}`, found);
  }
}

test("the draft schema uses only keywords structured outputs accept", () => {
  const found: string[] = [];
  walk(DRAFT_SCHEMA, "draft", found);
  assert.deepEqual(found, []);
});

test("every object in the draft schema closes itself", () => {
  const open: string[] = [];

  const visit = (node: unknown, path: string): void => {
    if (Array.isArray(node)) {
      node.forEach((item, index) => visit(item, `${path}[${index}]`));
      return;
    }
    if (typeof node !== "object" || node === null) return;

    const record = node as Record<string, unknown>;
    if (record["type"] === "object" && record["additionalProperties"] !== false) {
      open.push(path);
    }
    for (const [key, value] of Object.entries(record)) {
      visit(value, `${path}.${key}`);
    }
  };

  visit(DRAFT_SCHEMA, "draft");
  assert.deepEqual(open, []);
});
