/**
 * Everything the Worker is given at runtime. One Env, bound once, passed down —
 * there is no second environment type and nothing copies or rewrites this.
 */
export interface Env {
  DB: D1Database;
  RECIPE_IMAGES: R2Bucket;

  /**
   * Signs the session cookie. Set as a Worker secret in production and in
   * .dev.vars locally; rotating it signs everyone out. Optional in the type
   * because an unconfigured deployment must refuse requests rather than crash.
   */
  SESSION_SECRET?: string;

  /**
   * Google OAuth, set as Worker secrets. Optional in the type because a
   * deployment without them must say sign-in is not configured rather than
   * crash — and must not let anyone in.
   */
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;

  /** Structures pasted recipe text. Without it, intake says so and refuses. */
  ANTHROPIC_API_KEY?: string;

  /**
   * Fine-grained PAT restricted to eerovil/ruokalista-backup with repository
   * Contents read/write. The nightly scheduled handler fails loudly without it.
   */
  BACKUP_GITHUB_TOKEN?: string;

  /**
   * Bearer token for the S-ostoslista sync service (see
   * SOSTOSLISTA_SERVICE_URL), which puts things on the household's real
   * S-ryhmä shopping list. Not an S-ryhmä credential: that service holds
   * those. Optional in the type because a deployment without it must say the
   * shopping list is not connected rather than crash.
   */
  SOSTOSLISTA_API_TOKEN?: string;

  /** Where that service lives. A plain var, set in wrangler.jsonc. */
  SOSTOSLISTA_SERVICE_URL?: string;
}
