import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

const port = Number(process.env["S_OSTOSLISTA_TEST_PORT"] ?? "8788");
const token = "test-s-ostoslista-token";

interface LoggedRequest {
  method: string;
  path: string;
  body: unknown;
}

const requests: LoggedRequest[] = [];
const items: Array<{ id: string; name: string; ean: string | null }> = [];
let failNext = false;
let failSync = false;
let nextId = 1;

const products = {
  maito: [
    {
      ean: "6415712506032",
      sokId: "100812882",
      name: "Kotimaista rasvaton maito 1 l",
      price: 0.85,
      priceUnit: "KPL",
      available: true,
    },
    {
      ean: "6414893386488",
      sokId: "100296218",
      name: "Valio kevytmaito 1 l",
      price: 1.25,
      priceUnit: "KPL",
      available: true,
    },
  ],
  kahvi: [
    {
      ean: "6411300000814",
      sokId: "100001234",
      name: "Juhla Mokka kahvi 500 g",
      price: 6.49,
      priceUnit: "KPL",
      available: false,
    },
  ],
  // #204's audit walks several ingredients in a row, and a walk where only
  // milk ever finds anything photographs the fixture rather than the flow.
  // Deliberately not sitruunaruoho: shopping.spec.ts leans on the row after
  // maito finding nothing.
  jauheliha: [
    {
      ean: "6408430000159",
      sokId: "100523111",
      name: "Kotimaista nauta-sikajauheliha 400 g",
      price: 4.29,
      priceUnit: "KPL",
      available: true,
    },
    {
      ean: "6408430000753",
      sokId: "100523112",
      name: "Atria naudan jauheliha 10 % 400 g",
      price: 5.49,
      priceUnit: "KPL",
      available: true,
    },
  ],
  juusto: [
    {
      ean: "6408430011117",
      sokId: "100477001",
      name: "Kotimaista juustoraaste 250 g",
      price: 2.19,
      priceUnit: "KPL",
      available: true,
    },
    {
      ean: "6408430011124",
      sokId: "100477002",
      name: "Valio Polar 15 juustoviipale 350 g",
      price: 3.95,
      priceUnit: "KPL",
      available: true,
    },
  ],
  oljy: [
    {
      ean: "6414893000019",
      sokId: "100311444",
      name: "Keiju rypsiöljy 1 l",
      price: 3.59,
      priceUnit: "KPL",
      available: true,
    },
  ],
} as const;

createServer(async (request, response) => {
  const url = new URL(request.url ?? "/", `http://127.0.0.1:${port}`);

  if (request.method === "GET" && url.pathname === "/health") {
    return send(response, 200, { ok: true });
  }
  if (request.method === "POST" && url.pathname === "/_test/reset") {
    requests.length = 0;
    items.length = 0;
    failNext = false;
    failSync = false;
    nextId = 1;
    return send(response, 200, { ok: true });
  }
  if (request.method === "POST" && url.pathname === "/_test/fail-next") {
    failNext = true;
    return send(response, 200, { ok: true });
  }
  // Separate from fail-next, because a send's own calls come first: this fails
  // only the sync that follows a send that otherwise worked.
  if (request.method === "POST" && url.pathname === "/_test/fail-sync") {
    failSync = true;
    return send(response, 200, { ok: true });
  }
  if (request.method === "GET" && url.pathname === "/_test/requests") {
    return send(response, 200, { requests });
  }

  if (request.headers.authorization !== `Bearer ${token}`) {
    return send(response, 401, { error: "unauthorized" });
  }
  const body = await readBody(request);
  requests.push({ method: request.method ?? "GET", path: url.pathname + url.search, body });

  if (failNext) {
    failNext = false;
    return send(response, 503, { error: "test outage" });
  }
  if (request.method === "GET" && url.pathname === "/items") {
    return send(response, 200, { items });
  }
  // The real service answers this by pushing its copy to the phone. Nothing
  // reads the body, and it replies 204 on purpose so the client is exercised
  // against a sync that says nothing at all.
  if (request.method === "POST" && url.pathname === "/sync") {
    if (failSync) {
      failSync = false;
      return send(response, 503, { error: "test sync outage" });
    }
    response.writeHead(204);
    return response.end();
  }
  if (request.method === "POST" && url.pathname === "/items") {
    const record = isRecord(body) ? body : {};
    const ean = typeof record["ean"] === "string" ? record["ean"] : null;
    const note = typeof record["note"] === "string" ? record["note"] : null;
    if ((ean === null) === (note === null)) {
      return send(response, 400, { error: "ean or note is required" });
    }
    const existing = items.find((item) => ean !== null ? item.ean === ean : item.name === note);
    if (existing) return send(response, 200, existing);
    const product = Object.values(products).flat().find((one) => one.ean === ean);
    const created = {
      id: `item-${nextId++}`,
      name: note ?? product?.name ?? ean!,
      ean,
    };
    items.push(created);
    return send(response, 201, created);
  }
  if (request.method === "DELETE" && url.pathname === "/items") {
    const ean = url.searchParams.get("ean");
    const note = url.searchParams.get("note");
    const deleted = items.filter((item) => ean !== null ? item.ean === ean : item.name === note);
    for (const item of deleted) items.splice(items.indexOf(item), 1);
    return send(response, deleted.length === 0 ? 404 : 200, {
      deleted: deleted.map((item) => item.id),
    });
  }
  if (request.method === "GET" && url.pathname === "/products") {
    const query = (url.searchParams.get("q") ?? "").toLocaleLowerCase("fi-FI");
    if (query === "virhe") return send(response, 503, { error: "test outage" });
    const found = query.includes("kahvi")
      ? products.kahvi
      : query.includes("maito")
        ? products.maito
        : query.includes("jauheliha")
          ? products.jauheliha
          : query.includes("juusto")
            ? products.juusto
            : query.includes("öljy") || query.includes("oljy")
              ? products.oljy
              : [];
    return send(response, 200, { query, results: found });
  }
  return send(response, 404, { error: "not found" });
}).listen(port, "127.0.0.1");

async function readBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of request) chunks.push(chunk as Uint8Array);
  const text = Buffer.concat(chunks).toString("utf8");
  if (text === "") return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function send(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(`${JSON.stringify(body)}\n`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
