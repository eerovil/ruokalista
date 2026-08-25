import type { Env } from "./env.ts";

/**
 * The one router. Every request the Worker answers is matched here and nowhere
 * else — there is no second fetch handler and no inner app to delegate to.
 *
 * Patterns are literal paths with `:name` segments, e.g. `/api/recipes/:id`.
 */

export interface RouteContext {
  request: Request;
  env: Env;
  url: URL;
  params: Record<string, string>;
}

export type Handler = (ctx: RouteContext) => Response | Promise<Response>;

interface Route {
  method: string;
  segments: string[];
  handler: Handler;
}

export class Router {
  #routes: Route[] = [];

  add(method: string, pattern: string, handler: Handler): this {
    this.#routes.push({ method, segments: segmentsOf(pattern), handler });
    return this;
  }

  get(pattern: string, handler: Handler): this {
    return this.add("GET", pattern, handler);
  }

  post(pattern: string, handler: Handler): this {
    return this.add("POST", pattern, handler);
  }

  put(pattern: string, handler: Handler): this {
    return this.add("PUT", pattern, handler);
  }

  patch(pattern: string, handler: Handler): this {
    return this.add("PATCH", pattern, handler);
  }

  delete(pattern: string, handler: Handler): this {
    return this.add("DELETE", pattern, handler);
  }

  async handle(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = segmentsOf(url.pathname);

    // A GET route also answers HEAD; the runtime drops the body for us.
    const method = request.method === "HEAD" ? "GET" : request.method;

    let pathExists = false;

    for (const route of this.#routes) {
      const params = matchSegments(route.segments, path);
      if (params === null) continue;
      pathExists = true;
      if (route.method !== method) continue;
      return route.handler({ request, env, url, params });
    }

    return pathExists
      ? new Response("Method not allowed", { status: 405 })
      : new Response("Not found", { status: 404 });
  }
}

function segmentsOf(path: string): string[] {
  return path.split("/").filter((segment) => segment.length > 0);
}

/** The captured `:name` params, or null when this pattern does not match. */
function matchSegments(
  pattern: string[],
  path: string[],
): Record<string, string> | null {
  if (pattern.length !== path.length) return null;

  const params: Record<string, string> = {};

  for (let i = 0; i < pattern.length; i++) {
    const expected = pattern[i]!;
    const actual = path[i]!;

    if (expected.startsWith(":")) {
      try {
        params[expected.slice(1)] = decodeURIComponent(actual);
      } catch {
        // A malformed escape is a path that does not match, not a Worker crash.
        return null;
      }
    } else if (expected !== actual) {
      return null;
    }
  }

  return params;
}
