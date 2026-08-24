/**
 * Everything the Worker is given at runtime. One Env, bound once, passed down —
 * there is no second environment type and nothing copies or rewrites this.
 */
export interface Env {
  DB: D1Database;
}
