/**
 * Enough of D1 to run a real write path against a real database, in process.
 *
 * `dev/` checks test functions rather than screens, and until now nothing here
 * touched a database: anything needing one went to the browser suite, which
 * runs the Worker against local D1. That does not reach the case #210 is about.
 * The window between "the vocabulary still has this category" and "the batch
 * that stores it" is a few statements wide and closes on its own; no browser can
 * be told to press a button inside it.
 *
 * So the database comes here instead. `node:sqlite` runs the real migrations,
 * `saveRecipe` and the bulk action run against it unchanged, and `beforeBatch`
 * is the seam that lets a check do something — remove a category, say — in
 * exactly the moment the code has finished validating and has not yet written.
 *
 * This is a test double for the shape of the API, not for what it does. Every
 * statement is really executed, a batch is really one transaction, and the
 * foreign keys are really on, because those three are the things being checked.
 */

import { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const MIGRATIONS = join(import.meta.dirname, "..", "..", "migrations");

type Value = string | number | null;

export interface FakeD1 {
  /** Every migration applied, foreign keys on, nothing else in it. */
  db: D1Database;
  /** Run something the instant before the next batch commits, once. */
  beforeBatch: (hook: () => void) => void;
  /** Straight SQL, for a check's own fixtures and assertions. */
  sql: DatabaseSync;
}

export function migratedDatabase(): FakeD1 {
  const sql = new DatabaseSync(":memory:");
  sql.exec("PRAGMA foreign_keys = ON");
  for (const file of readdirSync(MIGRATIONS).sort()) {
    if (!file.endsWith(".sql")) continue;
    sql.exec(readFileSync(join(MIGRATIONS, file), "utf8"));
  }

  let hook: (() => void) | null = null;

  function bound(text: string, values: Value[]): D1PreparedStatement {
    const statement = {
      bind: (...next: unknown[]) => bound(text, next as Value[]),

      first: async (column?: string) => {
        const row = sql.prepare(text).get(...values) as
          | Record<string, Value>
          | undefined;
        if (row === undefined) return null;
        return column === undefined ? row : (row[column] ?? null);
      },

      all: async () => {
        const results = sql.prepare(text).all(...values);
        return { results, success: true, meta: {} };
      },

      run: async () => {
        const changes = sql.prepare(text).run(...values);
        return {
          results: [],
          success: true,
          meta: { changes: Number(changes.changes) },
        };
      },

      raw: async () => {
        throw new Error("raw() is not part of this double");
      },
    };
    return statement as unknown as D1PreparedStatement;
  }

  const db = {
    prepare: (text: string) => bound(text, []),

    // One transaction, exactly as D1 runs one: a statement that throws takes
    // every statement before it back out with it. That is the half of this
    // double the integrity checks actually lean on.
    batch: async (statements: D1PreparedStatement[]) => {
      const ran = statements as unknown as Array<{
        run: () => Promise<{ meta: { changes: number } }>;
      }>;
      if (hook !== null) {
        const once = hook;
        hook = null;
        once();
      }
      sql.exec("BEGIN");
      const results = [];
      try {
        for (const statement of ran) results.push(await statement.run());
      } catch (error) {
        sql.exec("ROLLBACK");
        throw error;
      }
      sql.exec("COMMIT");
      return results;
    },

    exec: async (text: string) => {
      sql.exec(text);
      return { count: 0, duration: 0 };
    },
  };

  return {
    db: db as unknown as D1Database,
    beforeBatch: (next: () => void) => {
      hook = next;
    },
    sql,
  };
}
