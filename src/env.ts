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
   * Draws recipe pictures, sixteen to a contact sheet. Admin-only and paid per
   * request, so a deployment without it refuses generation rather than crashes —
   * and every other picture path, including the manual upload, works without it.
   */
  OPENAI_API_KEY?: string;

  /**
   * Fine-grained PAT restricted to eerovil/ruokalista-backup with repository
   * Contents read/write. The nightly scheduled handler fails loudly without it.
   */
  BACKUP_GITHUB_TOKEN?: string;
}
