import { requireMember, requireMemberScreen } from "./auth.ts";
import type { Env } from "./env.ts";
import { listIngredients } from "./ingredients.ts";
import {
  correctScreen,
  intakeScreen,
  saveScreen,
  structureScreen,
  structureStream,
} from "./intake-screens.ts";
import {
  apiListRecipes,
  apiShowRecipe,
  recipeListScreen,
  recipeScreen,
} from "./recipes.ts";
import { Router, type RouteContext } from "./router.ts";
import {
  completeSignIn,
  signInScreen,
  signOut,
  startSignIn,
} from "./signin.ts";

/**
 * The Worker. One fetch handler, one router, one Env — the whole app hangs off
 * this file. Screens and API routes get added to the table below as they land.
 *
 * Everything except /health goes through requireMember.
 */

const router = new Router()
  .get("/health", health)
  // The week screen takes over "/" once it exists; until then the recipe list
  // is the only way in.
  .get("/", () => new Response(null, { status: 302, headers: { Location: "/recipes" } }))
  .get("/signin", signInScreen)
  .get("/auth/google", startSignIn)
  .get("/auth/google/callback", completeSignIn)
  .post("/auth/signout", signOut)
  .get("/recipes", requireMemberScreen(recipeListScreen))
  .get("/recipes/:id", requireMemberScreen(recipeScreen))
  .get("/intake", requireMemberScreen(intakeScreen))
  .post("/intake", requireMemberScreen(structureScreen))
  .post("/intake/correct", requireMemberScreen(correctScreen))
  .post("/api/intake/structure", requireMember(structureStream))
  .post("/recipes", requireMemberScreen(saveScreen))
  .get("/api/recipes", requireMember(apiListRecipes))
  .get("/api/recipes/:id", requireMember(apiShowRecipe))
  .get("/api/ingredients", requireMember(listIngredients));

export default {
  fetch(request: Request, env: Env): Promise<Response> {
    return router.handle(request, env);
  },
} satisfies ExportedHandler<Env>;

/**
 * Public, and the only route that is. Answers whether the Worker is up and
 * whether its D1 binding actually reaches a migrated database — the two things
 * worth knowing before anything else is built on top.
 */
async function health({ env }: RouteContext): Promise<Response> {
  let database: "ok" | "unmigrated" | "unreachable" = "unreachable";

  try {
    const row = await env.DB.prepare(
      "SELECT count(*) AS tables FROM sqlite_master WHERE type = 'table' AND name = 'household'",
    ).first<{ tables: number }>();

    database = row && row.tables > 0 ? "ok" : "unmigrated";
  } catch {
    database = "unreachable";
  }

  return Response.json(
    { status: database === "ok" ? "ok" : "degraded", database },
    { status: database === "ok" ? 200 : 503 },
  );
}
