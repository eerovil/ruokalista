import { requireMember, requireMemberScreen } from "./auth.ts";
import { runNightlyBackup } from "./backup.ts";
import type { Env } from "./env.ts";
import {
  apiRename,
  ingredientsScreen,
  renameForm,
} from "./ingredient-screens.ts";
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
import {
  apiAddMealEntry,
  apiChangePortions,
  apiMenu,
  apiRemoveMealEntry,
} from "./menu.ts";
import {
  apiDeleteRecipe,
  confirmDeleteScreen,
  deleteRecipeForm,
  editorScreen,
  saveEditForm,
} from "./recipe-editor.ts";
import { Router, type RouteContext } from "./router.ts";
import {
  completeSignIn,
  devSignIn,
  signInScreen,
  signOut,
  startSignIn,
} from "./signin.ts";
import {
  addEntryForm,
  changePortionsForm,
  mealEntryScreen,
  pickerScreen,
  removeEntryForm,
  weekScreen,
} from "./week-screens.ts";

/**
 * The Worker. One fetch handler, one router, one Env — the whole app hangs off
 * this file. Screens and API routes get added to the table below as they land.
 *
 * Everything except /health goes through requireMember.
 */

const router = new Router()
  .get("/health", health)
  .get("/", requireMemberScreen(weekScreen))
  .get("/picker", requireMemberScreen(pickerScreen))
  .post("/meal-entries", requireMemberScreen(addEntryForm))
  .get("/meal-entries/:id", requireMemberScreen(mealEntryScreen))
  .post("/meal-entries/:id/portions", requireMemberScreen(changePortionsForm))
  .post("/meal-entries/:id/delete", requireMemberScreen(removeEntryForm))
  .get("/api/menu", requireMember(apiMenu))
  .post("/api/meal-entries", requireMember(apiAddMealEntry))
  .patch("/api/meal-entries/:id", requireMember(apiChangePortions))
  .delete("/api/meal-entries/:id", requireMember(apiRemoveMealEntry))
  .get("/signin", signInScreen)
  .get("/auth/google", startSignIn)
  .get("/auth/google/callback", completeSignIn)
  .post("/auth/dev-signin", devSignIn)
  .post("/auth/signout", signOut)
  .get("/recipes", requireMemberScreen(recipeListScreen))
  .get("/recipes/:id", requireMemberScreen(recipeScreen))
  .get("/recipes/:id/edit", requireMemberScreen(editorScreen))
  .post("/recipes/:id", requireMemberScreen(saveEditForm))
  .get("/recipes/:id/delete", requireMemberScreen(confirmDeleteScreen))
  .post("/recipes/:id/delete", requireMemberScreen(deleteRecipeForm))
  .delete("/api/recipes/:id", requireMember(apiDeleteRecipe))
  .get("/ingredients", requireMemberScreen(ingredientsScreen))
  .post("/ingredients/:id/rename", requireMemberScreen(renameForm))
  .patch("/api/ingredients/:id", requireMember(apiRename))
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

  async scheduled(
    controller: ScheduledController,
    env: Env,
    _ctx: ExecutionContext,
  ): Promise<void> {
    await runNightlyBackup(env, controller.scheduledTime);
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