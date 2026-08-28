import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import test from "node:test";

import {
  claimMemberInvitation,
  HouseholdRefused,
  inviteMember,
  normalizeMemberEmail,
} from "../src/households.ts";
import { completeSignIn } from "../src/signin.ts";
import { base64UrlEncode, sign } from "../src/signing.ts";

function database(): { db: D1Database; dispose: () => void } {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec("PRAGMA foreign_keys = ON");
  sqlite.exec(`
    CREATE TABLE household (id INTEGER PRIMARY KEY, name TEXT NOT NULL);
    CREATE TABLE member (
      id INTEGER PRIMARY KEY,
      household_id INTEGER NOT NULL REFERENCES household(id),
      google_sub TEXT NOT NULL UNIQUE,
      display_name TEXT NOT NULL,
      email TEXT,
      is_admin INTEGER NOT NULL DEFAULT 0,
      removed_at TEXT
    );
    INSERT INTO household (id, name) VALUES (1, 'Koti'), (2, 'Naapuri');
    INSERT INTO member
      (id, household_id, google_sub, display_name, email, is_admin)
    VALUES (1, 1, 'admin-sub', 'Ylläpitäjä', 'admin@example.com', 1);
  `);
  sqlite.exec(readFileSync("migrations/0014_member_invitations.sql", "utf8"));
  return { db: d1Adapter(sqlite), dispose: () => sqlite.close() };
}

/** Execute the production D1 statements against real SQLite in this pure tier. */
function d1Adapter(sqlite: DatabaseSync): D1Database {
  class Prepared {
    private readonly statement: StatementSync;
    private readonly values: unknown[];

    constructor(
      statement: StatementSync,
      values: unknown[] = [],
    ) {
      this.statement = statement;
      this.values = values;
    }

    bind(...values: unknown[]): Prepared {
      return new Prepared(this.statement, values);
    }

    async first<T = Record<string, unknown>>(column?: string): Promise<T | null> {
      const row = this.statement.get(...this.values) as Record<string, unknown> | undefined;
      if (row === undefined) return null;
      return (column === undefined ? row : row[column]) as T;
    }

    async all<T = Record<string, unknown>>(): Promise<D1Result<T>> {
      return result(this.statement.all(...this.values) as T[]);
    }

    async run<T = Record<string, unknown>>(): Promise<D1Result<T>> {
      const meta = this.statement.run(...this.values);
      return {
        ...result<T>([]),
        meta: {
          ...result<T>([]).meta,
          changes: Number(meta.changes),
          last_row_id: Number(meta.lastInsertRowid),
        },
      };
    }
  }

  const prepare = (sql: string) => new Prepared(sqlite.prepare(sql));
  return {
    prepare,
    async batch(statements: Prepared[]) {
      sqlite.exec("BEGIN");
      try {
        const results = [];
        for (const statement of statements) results.push(await statement.run());
        sqlite.exec("COMMIT");
        return results;
      } catch (error) {
        sqlite.exec("ROLLBACK");
        throw error;
      }
    },
  } as unknown as D1Database;
}

function result<T>(results: T[]): D1Result<T> {
  return {
    success: true,
    results,
    meta: {
      served_by: "node:sqlite",
      duration: 0,
      changes: 0,
      last_row_id: 0,
      changed_db: false,
      size_after: 0,
      rows_read: 0,
      rows_written: 0,
    },
  };
}

test("normalizes the one stored spelling and refuses malformed email", () => {
  assert.equal(normalizeMemberEmail("  Uusi@Example.COM "), "uusi@example.com");
  for (const email of ["", "ei-sähköposti", "a@@example.com", ".a@example.com", "a..b@example.com"]) {
    assert.throws(() => normalizeMemberEmail(email), HouseholdRefused);
  }
});

test("one normalized email can be invited only once across households and members", async () => {
  const { db, dispose } = database();
  try {
    await inviteMember(db, 2, " Uusi@Example.COM ", 1);
    assert.equal(
      await db.prepare("SELECT email FROM member_invitation").first("email"),
      "uusi@example.com",
    );
    await assert.rejects(inviteMember(db, 1, "uusi@example.com", 1), /Naapuri/);
    await assert.rejects(inviteMember(db, 2, "ADMIN@example.com", 1), /Koti/);
    await assert.rejects(
      db.prepare(
        `INSERT INTO member (household_id, google_sub, display_name, email)
         VALUES (2, 'duplicate-active', 'Kaksoisolento', 'ADMIN@example.com')`,
      ).run(),
      /UNIQUE constraint failed/,
    );
  } finally {
    dispose();
  }
});

test("only the matching verified Google email consumes an invitation", async () => {
  const { db, dispose } = database();
  try {
    await inviteMember(db, 2, "uusi@example.com", 1);

    await claimMemberInvitation(db, {
      sub: "unverified-sub",
      name: "Väärä",
      email: "uusi@example.com",
      emailVerified: false,
    });
    assert.equal(await db.prepare("SELECT count(*) AS count FROM member").first("count"), 1);

    await claimMemberInvitation(db, {
      sub: "new-google-sub",
      name: "Uusi Käyttäjä",
      email: "UUSI@example.com",
      emailVerified: true,
    });
    const claimed = await db
        .prepare(
          "SELECT household_id, google_sub, display_name, email, is_admin FROM member WHERE google_sub = ?",
        )
        .bind("new-google-sub")
        .first<Record<string, unknown>>();
    assert.deepEqual(
      { ...claimed },
      {
        household_id: 2,
        google_sub: "new-google-sub",
        display_name: "Uusi Käyttäjä",
        email: "uusi@example.com",
        is_admin: 0,
      },
    );
    assert.equal(
      await db.prepare("SELECT count(*) AS count FROM member_invitation").first("count"),
      0,
    );

    await claimMemberInvitation(db, {
      sub: "second-google-sub",
      name: "Toinen",
      email: "uusi@example.com",
      emailVerified: true,
    });
    assert.equal(await db.prepare("SELECT count(*) AS count FROM member").first("count"), 2);
  } finally {
    dispose();
  }
});

test("the real Google callback claims only a matching verified invitation", async () => {
  const verified = database();
  try {
    await inviteMember(verified.db, 2, "uusi@example.com", 1);
    const first = await googleCallback(verified.db, {
      sub: "callback-sub",
      name: "Uusi Käyttäjä",
      email: "UUSI@example.com",
      email_verified: true,
    });
    assert.equal(first.status, 302);
    assert.match(first.headers.get("set-cookie") ?? "", /ruokalista_session=/);

    // The callback is idempotent after the invitation has become a member.
    const second = await googleCallback(verified.db, {
      sub: "callback-sub",
      name: "Uusi Käyttäjä",
      email: "uusi@example.com",
      email_verified: true,
    });
    assert.equal(second.status, 302);
    assert.equal(
      await verified.db.prepare("SELECT count(*) AS count FROM member").first("count"),
      2,
    );
  } finally {
    verified.dispose();
  }

  for (const claims of [
    { sub: "unverified", name: "Uusi", email: "uusi@example.com", email_verified: false },
    { sub: "different", name: "Uusi", email: "muu@example.com", email_verified: true },
  ]) {
    const refused = database();
    try {
      await inviteMember(refused.db, 2, "uusi@example.com", 1);
      const response = await googleCallback(refused.db, claims);
      assert.equal(response.status, 403);
      assert.match(await response.text(), /vahvistettu\s+sähköpostiosoite/);
      assert.equal(
        await refused.db
          .prepare("SELECT count(*) AS count FROM member_invitation")
          .first("count"),
        1,
      );
    } finally {
      refused.dispose();
    }
  }
});

async function googleCallback(
  db: D1Database,
  claims: Record<string, unknown>,
): Promise<Response> {
  const clientId = "test-client";
  const secret = "test-session-secret";
  const now = Math.floor(Date.now() / 1000);
  const unsignedState = `nonce.${now + 300}`;
  const state = `${unsignedState}.${await sign(secret, unsignedState)}`;
  const tokenClaims = {
    iss: "https://accounts.google.com",
    aud: clientId,
    exp: now + 300,
    ...claims,
  };
  const encode = (value: unknown) =>
    base64UrlEncode(new TextEncoder().encode(JSON.stringify(value)));
  const idToken = `${encode({ alg: "none" })}.${encode(tokenClaims)}.test`;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => Response.json({ id_token: idToken });

  try {
    const url = new URL("https://ruokalista.example/auth/google/callback");
    url.searchParams.set("state", state);
    url.searchParams.set("code", "test-code");
    const request = new Request(url, {
      headers: { Cookie: `ruokalista_oauth_state=${state}` },
    });
    return await completeSignIn({
      env: {
        DB: db,
        RECIPE_IMAGES: {} as R2Bucket,
        SESSION_SECRET: secret,
        GOOGLE_CLIENT_ID: clientId,
        GOOGLE_CLIENT_SECRET: "test-client-secret",
      },
      url,
      request,
      params: {},
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
}
