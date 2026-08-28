/**
 * The private HTTP API in `s-ostoslista-client/worker`, kept behind one small
 * client so screens never know its routes, authentication, or response shape.
 *
 * The service itself syncs its D1 copy to the phone's S-ostoslista in the
 * background. These calls therefore finish when the private service has
 * accepted the local change, not when the phone has completed a sync.
 */

export interface SOstoslistaItem {
  id: string;
  name: string;
  ean: string | null;
}

export interface SOstoslistaProduct {
  ean: string;
  sokId: string;
  name: string;
  price: number | null;
  priceUnit: string | null;
  available: boolean | null;
  /** Stable public S-group CDN URL derived from the EAN. */
  imageUrl: string;
}

export type SOstoslistaKey = { ean: string } | { note: string };

export class SOstoslistaError extends Error {
  readonly status: number | null;

  constructor(
    message: string,
    status: number | null = null,
  ) {
    super(message);
    this.name = "SOstoslistaError";
    this.status = status;
  }
}

type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export class SOstoslistaClient {
  readonly #baseUrl: URL;
  readonly #apiToken: string;
  readonly #fetch: Fetcher;

  constructor(
    baseUrl: string,
    apiToken: string,
    fetcher: Fetcher = (input, init) => fetch(input, init),
  ) {
    try {
      this.#baseUrl = new URL(baseUrl);
    } catch {
      throw new SOstoslistaError("S-ostoslista URL is invalid.");
    }
    if (!/^https?:$/.test(this.#baseUrl.protocol)) {
      throw new SOstoslistaError("S-ostoslista URL must use HTTP or HTTPS.");
    }
    if (!this.#baseUrl.pathname.endsWith("/")) this.#baseUrl.pathname += "/";
    if (apiToken.trim() === "") {
      throw new SOstoslistaError("S-ostoslista API token is empty.");
    }
    this.#apiToken = apiToken;
    this.#fetch = fetcher;
  }

  /** The list as the sync service currently holds it. */
  async list(): Promise<SOstoslistaItem[]> {
    const payload = await this.#request("items");
    const record = asRecord(payload, "list response");
    if (!Array.isArray(record["items"])) {
      throw malformed("list response has no items array");
    }
    return record["items"].map((item, index) => readItem(item, `items[${index}]`));
  }

  /** Search the S-group catalogue. Results include the EAN persisted locally. */
  async search(query: string, limit = 20): Promise<SOstoslistaProduct[]> {
    const q = query.trim();
    if (q === "") throw new SOstoslistaError("Product search query is empty.");

    const pageSize = Number.isFinite(limit)
      ? Math.max(1, Math.min(50, Math.floor(limit)))
      : 20;
    const params = new URLSearchParams({
      q,
      limit: String(pageSize),
    });
    const payload = await this.#request(`products?${params}`);
    const record = asRecord(payload, "search response");
    if (!Array.isArray(record["results"])) {
      throw malformed("search response has no results array");
    }
    return record["results"].map((item, index) =>
      readProduct(item, `results[${index}]`),
    );
  }

  /** Add either one concrete EAN product or one free-text reminder. */
  async add(key: SOstoslistaKey): Promise<SOstoslistaItem> {
    const payload = await this.#request("items", {
      method: "POST",
      body: JSON.stringify(cleanKey(key)),
    });
    return readItem(payload, "add response");
  }

  /**
   * Push the service's own copy to the phone's S-ostoslista now.
   *
   * The service syncs on its own schedule, so nothing here depends on this
   * call: what it buys is that a list sent from Ruokalista shows up on the
   * phone straight away instead of at the next sweep. The response body is not
   * read — the service says what it did in its own shape, and there is nothing
   * this app would do differently with it.
   */
  async sync(): Promise<void> {
    await this.#request("sync", { method: "POST" }, false);
  }

  /** Remove every copy added under this EAN or note key. */
  async remove(key: SOstoslistaKey): Promise<string[]> {
    const clean = cleanKey(key);
    const params = new URLSearchParams(clean);
    const payload = await this.#request(`items?${params}`, { method: "DELETE" });
    const record = asRecord(payload, "remove response");
    if (!Array.isArray(record["deleted"]) ||
        !record["deleted"].every((id) => typeof id === "string")) {
      throw malformed("remove response has no deleted id array");
    }
    return record["deleted"] as string[];
  }

  /**
   * `expectJson` is false for the one call whose body nobody reads. A service
   * that answers `204 No Content` to it is answering correctly, and demanding
   * JSON there would turn a healthy sync into a refusal.
   */
  async #request(
    path: string,
    init: RequestInit = {},
    expectJson = true,
  ): Promise<unknown> {
    const headers = new Headers(init.headers);
    headers.set("authorization", `Bearer ${this.#apiToken}`);
    if (init.body !== undefined) headers.set("content-type", "application/json");

    let response: Response;
    try {
      response = await this.#fetch(new URL(path, this.#baseUrl), {
        ...init,
        headers,
      });
    } catch (error) {
      throw new SOstoslistaError(
        `S-ostoslista request failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    let payload: unknown;
    if (expectJson) {
      try {
        payload = await response.json();
      } catch {
        throw new SOstoslistaError(
          `S-ostoslista returned invalid JSON (${response.status}).`,
          response.status,
        );
      }
    } else {
      payload = await readOptionalJson(response);
    }
    if (!response.ok) {
      const record = isRecord(payload) ? payload : null;
      const detail = typeof record?.["error"] === "string"
        ? `: ${record["error"]}`
        : "";
      throw new SOstoslistaError(
        `S-ostoslista returned ${response.status}${detail}`,
        response.status,
      );
    }
    return payload;
  }
}

/**
 * Product images are not signed API results. S-group's public CDN is keyed by
 * EAN and sends long-lived cache headers, so this stable URL is safe to persist.
 */
export function sProductImageUrl(ean: string): string {
  return `https://cdn.s-cloud.fi/v1/w256_q75/product/ean/${encodeURIComponent(ean)}_kuva1.jpg`;
}

/**
 * A body that may not be there. It is still read, because a refusal's own
 * `error` field is the one line that says why the call failed, and losing it
 * would leave a log entry saying only that something returned 500.
 */
async function readOptionalJson(response: Response): Promise<unknown> {
  let text: string;
  try {
    text = await response.text();
  } catch {
    return null;
  }
  if (text.trim() === "") return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function cleanKey(key: SOstoslistaKey): Record<string, string> {
  const name = "ean" in key ? "ean" : "note";
  const value = ("ean" in key ? key.ean : key.note).trim();
  if (value === "") throw new SOstoslistaError(`${name} is empty.`);
  return { [name]: value };
}

function readItem(value: unknown, at: string): SOstoslistaItem {
  const item = asRecord(value, at);
  if (typeof item["id"] !== "string" || typeof item["name"] !== "string") {
    throw malformed(`${at} is missing id or name`);
  }
  if (item["ean"] !== null && typeof item["ean"] !== "string") {
    throw malformed(`${at}.ean is invalid`);
  }
  return { id: item["id"], name: item["name"], ean: item["ean"] };
}

function readProduct(value: unknown, at: string): SOstoslistaProduct {
  const product = asRecord(value, at);
  for (const key of ["ean", "sokId", "name"] as const) {
    if (typeof product[key] !== "string" || product[key].trim() === "") {
      throw malformed(`${at}.${key} is invalid`);
    }
  }
  const price = nullableNumber(product["price"], `${at}.price`);
  const priceUnit = nullableString(product["priceUnit"], `${at}.priceUnit`);
  const available = nullableBoolean(product["available"], `${at}.available`);
  return {
    ean: product["ean"] as string,
    sokId: product["sokId"] as string,
    name: product["name"] as string,
    price,
    priceUnit,
    available,
    imageUrl: sProductImageUrl(product["ean"] as string),
  };
}

function nullableString(value: unknown, at: string): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") throw malformed(`${at} is invalid`);
  return value;
}

function nullableNumber(value: unknown, at: string): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw malformed(`${at} is invalid`);
  }
  return value;
}

function nullableBoolean(value: unknown, at: string): boolean | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "boolean") throw malformed(`${at} is invalid`);
  return value;
}

function asRecord(value: unknown, at: string): Record<string, unknown> {
  if (!isRecord(value)) throw malformed(`${at} is not an object`);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function malformed(detail: string): SOstoslistaError {
  return new SOstoslistaError(`Malformed S-ostoslista response: ${detail}.`);
}
