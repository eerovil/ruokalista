import type { Env } from "./env.ts";

/**
 * The one router. Every request the Worker answers is matched here and nowhere
 * else — there is no second fetch handler and no inner app to delegate to.
 *
 * Patterns are literal paths with `:name` segments, e.g. `/api/recipes/:id`.
 * Literal segments outrank parameters at the same position, so registration
 * order never decides which matching path wins. Method selection happens after
 * that path choice: a more-specific path with another method is a 405 rather
 * than a fall-through to a less-specific parameter route.
 *
 * Two patterns for the same method may not have the same literal/parameter
 * shape (`/:id` and `/:slug`, for example), because neither can be more
 * specific than the other.
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

interface Match {
  route: Route;
  params: Record<string, string>;
}

export class Router {
  #routes: Route[] = [];

  add(method: string, pattern: string, handler: Handler): this {
    const segments = segmentsOf(pattern);
    for (const route of this.#routes) {
      if (route.method === method && sameShape(route.segments, segments)) {
        throw new Error(`Ambiguous ${method} route pattern: ${pattern}`);
      }
    }
    this.#routes.push({ method, segments, handler });
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

    let best: Match[] = [];

    for (const route of this.#routes) {
      const params = matchSegments(route.segments, path);
      if (params === null) continue;

      if (best.length === 0) {
        best = [{ route, params }];
        continue;
      }

      const comparison = compareSpecificity(route.segments, best[0]!.route.segments);
      if (comparison > 0) best = [{ route, params }];
      else if (comparison === 0) best.push({ route, params });
    }

    if (best.length === 0) return new Response("Not found", { status: 404 });

    const match = best.find(({ route }) => route.method === method);
    return match === undefined
      ? new Response("Method not allowed", { status: 405 })
      : match.route.handler({ request, env, url, params: match.params });
  }
}

function segmentsOf(path: string): string[] {
  return path.split("/").filter((segment) => segment.length > 0);
}

function parameter(segment: string): boolean {
  return segment.startsWith(":");
}

/** Whether two patterns can match exactly the same paths at equal specificity. */
function sameShape(left: string[], right: string[]): boolean {
  if (left.length !== right.length) return false;

  for (let i = 0; i < left.length; i++) {
    const a = left[i]!;
    const b = right[i]!;
    if (parameter(a) && parameter(b)) continue;
    if (a !== b) return false;
  }

  return true;
}

/** Positive when `left` is the more-specific pattern. */
function compareSpecificity(left: string[], right: string[]): number {
  for (let i = 0; i < left.length; i++) {
    const leftParameter = parameter(left[i]!);
    const rightParameter = parameter(right[i]!);
    if (leftParameter === rightParameter) continue;
    return leftParameter ? -1 : 1;
  }
  return 0;
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

    if (parameter(expected)) {
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
