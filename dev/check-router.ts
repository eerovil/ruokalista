import assert from "node:assert/strict";
import test from "node:test";

import { Router, type RouteContext } from "../src/router.ts";

const env = {} as never;
const reply = (body: string) => () => new Response(body);

async function body(router: Router, path: string, method = "GET"): Promise<string> {
  return (await router.handle(
    new Request(`https://example.test${path}`, { method }),
    env,
  )).text();
}

test("literal route wins over a parameter regardless of registration order", async () => {
  for (const literalFirst of [true, false]) {
    const router = new Router();
    const addLiteral = () => router.get("/recipes/julkiset", reply("literal"));
    const addParameter = () => router.get(
      "/recipes/:id",
      ({ params }: RouteContext) => new Response(`parameter:${params.id}`),
    );

    if (literalFirst) {
      addLiteral();
      addParameter();
    } else {
      addParameter();
      addLiteral();
    }

    assert.equal(await body(router, "/recipes/julkiset"), "literal");
  }
});

test("the first differing segment decides specificity", async () => {
  const router = new Router()
    .get("/a/:value/c", reply("later literal"))
    .get("/a/b/:value", reply("earlier literal"));

  assert.equal(await body(router, "/a/b/c"), "earlier literal");
});

test("parameter values are decoded and exposed to the handler", async () => {
  const router = new Router().get(
    "/recipes/:id",
    ({ params }) => new Response(params.id),
  );

  assert.equal(await body(router, "/recipes/hello%20world"), "hello world");
});

test("a malformed percent escape is a 404 rather than an exception", async () => {
  const router = new Router().get(
    "/recipes/:id",
    reply("matched"),
  );

  const result = await router.handle(
    new Request("https://example.test/recipes/%E0%A4%A"),
    env,
  );

  assert.equal(result.status, 404);
});

test("HEAD uses the matching GET route", async () => {
  let calls = 0;
  const router = new Router().get("/health", () => {
    calls += 1;
    return new Response("ok");
  });

  const result = await router.handle(
    new Request("https://example.test/health", { method: "HEAD" }),
    env,
  );

  assert.equal(result.status, 200);
  assert.equal(calls, 1);
});

test("an unknown path is 404", async () => {
  const router = new Router().get("/known", reply("known"));
  const result = await router.handle(
    new Request("https://example.test/unknown"),
    env,
  );

  assert.equal(result.status, 404);
});

test("method selection happens after choosing the most-specific path", async () => {
  const router = new Router()
    .get("/recipes/:id", reply("parameter get"))
    .post("/recipes/julkiset", reply("literal post"));

  const get = await router.handle(
    new Request("https://example.test/recipes/julkiset"),
    env,
  );
  assert.equal(get.status, 405);
  assert.equal(await body(router, "/recipes/julkiset", "POST"), "literal post");
});

test("same-method patterns with indistinguishable shapes are rejected", () => {
  assert.throws(
    () => new Router()
      .get("/recipes/:id", reply("id"))
      .get("/recipes/:slug", reply("slug")),
    /Ambiguous GET route pattern: \/recipes\/:slug/,
  );
});

test("the same path shape may serve different methods", async () => {
  const router = new Router()
    .get("/recipes/:id", reply("get"))
    .post("/recipes/:slug", reply("post"));

  assert.equal(await body(router, "/recipes/42"), "get");
  assert.equal(await body(router, "/recipes/42", "POST"), "post");
});
