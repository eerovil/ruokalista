/**
 * Everything the Worker is given at runtime. One Env, bound once, passed down —
 * there is no second environment type and nothing copies or rewrites this.
 */
export interface Env {
  DB: D1Database;
  RECIPE_IMAGES: R2Bucket;
  INTAKE_QUEUE: Queue<{ jobId: string }>;

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

  /**
   * Google Cast custom receiver application id. Until the receiver is
   * registered, recipe screens stay exactly as they are and load no Cast SDK.
   */
  CAST_APP_ID?: string;

  /** Structures pasted recipe text. Without it, intake says so and refuses. */
  ANTHROPIC_API_KEY?: string;

  /**
   * Fine-grained PAT restricted to eerovil/ruokalista-backup with repository
   * Contents read/write. The nightly scheduled handler fails loudly without it.
   */
  BACKUP_GITHUB_TOKEN?: string;

  /**
   * Bearer token for the S-ostoslista sync service (see
   * SOSTOSLISTA_SERVICE), which can read and modify the bound household's
   * real S-ryhmä shopping list. It cannot authenticate directly to AppSync or
   * expose the phone's identity token. Optional in the type because a
   * deployment without it must say the shopping list is not connected rather
   * than crash.
   */
  SOSTOSLISTA_API_TOKEN?: string;

  /**
   * The sync service itself, bound Worker to Worker. This is the production
   * transport: both Workers sit on eerovil.workers.dev, and Cloudflare refuses
   * to route a Worker's fetch to another Worker on the same zone — it answers
   * with an HTML error page, which surfaced as "invalid JSON" on every call.
   */
  SOSTOSLISTA_SERVICE?: { fetch: typeof fetch };

  /**
   * Call the service over plain HTTP at this URL instead of over the binding.
   * Unset in wrangler.jsonc, so production always uses the binding; the browser
   * tests set it to reach their fixture, and local development can set it to
   * reach a deployment that has no binding.
   */
  SOSTOSLISTA_SERVICE_URL?: string;

  /**
   * The one household allowed to use this integration. Product mappings live
   * on global ingredients, so this gate must be explicit and server-side.
   */
  SOSTOSLISTA_HOUSEHOLD_ID?: string;
}
