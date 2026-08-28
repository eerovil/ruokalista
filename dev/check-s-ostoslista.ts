import assert from "node:assert/strict";
import test from "node:test";

import {
  SOstoslistaClient,
  SOstoslistaError,
  sProductImageUrl,
} from "../src/s-ostoslista.ts";

const calls: Array<{ url: string; init?: RequestInit }> = [];

function client(responses: Response[]): SOstoslistaClient {
  calls.length = 0;
  return new SOstoslistaClient(
    "https://private.example/api/",
    "secret-token",
    async (input, init) => {
      calls.push({ url: String(input), init });
      const response = responses.shift();
      if (!response) throw new Error("unexpected request");
      return response;
    },
  );
}

function json(value: unknown, status = 200): Response {
  return Response.json(value, { status });
}

test("list uses bearer auth and reads the service item shape", async () => {
  const api = client([
    json({ items: [{ id: "one", name: "Maito", ean: "6415712506032" }] }),
  ]);
  assert.deepEqual(await api.list(), [
    { id: "one", name: "Maito", ean: "6415712506032" },
  ]);
  assert.equal(calls[0]?.url, "https://private.example/api/items");
  assert.equal(new Headers(calls[0]?.init?.headers).get("authorization"), "Bearer secret-token");
});

test("search encodes the query and adds the stable EAN image", async () => {
  const api = client([
    json({
      results: [{
        ean: "6415712506032",
        sokId: "100812882",
        name: "Kotimaista rasvaton maito 1l",
        price: 0.85,
        priceUnit: "KPL",
        available: true,
      }],
    }),
  ]);
  const found = await api.search(" rasvaton maito ", 200);
  assert.equal(calls[0]?.url, "https://private.example/api/products?q=rasvaton+maito&limit=50");
  assert.equal(found[0]?.imageUrl, sProductImageUrl("6415712506032"));
  assert.match(found[0]?.imageUrl ?? "", /^https:\/\/cdn\.s-cloud\.fi\//);
});

test("add supports a concrete EAN and a free-text note", async () => {
  const api = client([
    json({ id: "ean-item", name: "Maito", ean: "6415712506032" }, 201),
    json({ id: "note-item", name: "Suola — 1 tl", ean: null }, 201),
  ]);
  await api.add({ ean: "6415712506032" });
  await api.add({ note: "Suola — 1 tl" });
  assert.deepEqual(JSON.parse(String(calls[0]?.init?.body)), { ean: "6415712506032" });
  assert.deepEqual(JSON.parse(String(calls[1]?.init?.body)), { note: "Suola — 1 tl" });
  assert.equal(calls[0]?.init?.method, "POST");
});

test("sync posts once and accepts an answer with no body at all", async () => {
  const api = client([new Response(null, { status: 204 })]);
  await api.sync();
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.url, "https://private.example/api/sync");
  assert.equal(calls[0]?.init?.method, "POST");
  assert.equal(
    new Headers(calls[0]?.init?.headers).get("authorization"),
    "Bearer secret-token",
  );
});

test("a refused sync still says why", async () => {
  const api = client([json({ error: "no session" }, 503)]);
  await assert.rejects(
    () => api.sync(),
    (error: unknown) =>
      error instanceof SOstoslistaError &&
      error.status === 503 &&
      /no session/.test(error.message),
  );
});

test("remove uses the same encoded key", async () => {
  const api = client([json({ deleted: ["one", "two"] })]);
  assert.deepEqual(await api.remove({ note: "suola & pippuri" }), ["one", "two"]);
  assert.equal(
    calls[0]?.url,
    "https://private.example/api/items?note=suola+%26+pippuri",
  );
  assert.equal(calls[0]?.init?.method, "DELETE");
});

test("upstream refusals and malformed success payloads are explicit", async () => {
  const refused = client([json({ error: "unauthorized" }, 401)]);
  await assert.rejects(
    refused.list(),
    (error: unknown) =>
      error instanceof SOstoslistaError &&
      error.status === 401 &&
      /unauthorized/.test(error.message),
  );

  const malformed = client([json({ results: [{ ean: "1" }] })]);
  await assert.rejects(malformed.search("milk"), /Malformed S-ostoslista response/);
});

test("network errors do not masquerade as provider responses", async () => {
  const api = new SOstoslistaClient("https://private.example", "token", async () => {
    throw new Error("offline");
  });
  await assert.rejects(api.list(), /request failed: offline/);
});
