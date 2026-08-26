import { requireMember, requireMemberScreen } from "./auth.ts";
import { scheduledBackup } from "./backup-scheduled.ts";
import {
  batchIntakeScreen,
  importBatchScreen,
  reviewBatchScreen,
} from "./batch-intake-screens.ts";
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
  apiAddPlannedBatch,
  apiMenu,
  apiRemovePlannedBatch,
  apiUpdatePlannedBatch,
} from "./menu.ts";
import {
  apiDeleteRecipe,
  confirmDeleteScreen,
  deleteRecipeForm,
  deleteRecipeImageForm,
  editorScreen,
  saveEditForm,
  uploadRecipeImageForm,
} from "./recipe-editor.ts";
import {
  apiDeleteRecipeImage,
  apiPutRecipeImage,
  apiRecipeImage,
} from "./recipe-images.ts";
import { Router, type RouteContext } from "./router.ts";
import {
  completeSignIn,
  devSignIn,
  signInScreen,
  signOut,
  startSignIn,
} from "./signin.ts";
import {
  addBatchForm,
  changeBatchPortionsForm,
  changeBatchRecipeForm,
  coverageForm,
  coverageScreen,
  pickerScreen,
  plannedBatchScreen,
  removeBatchForm,
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
  .post("/batches", requireMemberScreen(addBatchForm))
  .get("/batches/:id", requireMemberScreen(plannedBatchScreen))
  .get("/batches/:id/coverage", requireMemberScreen(coverageScreen))
  .post("/batches/:id/coverage", requireMemberScreen(coverageForm))
  .post("/batches/:id/portions", requireMemberScreen(changeBatchPortionsForm))
  .post("/batches/:id/recipe", requireMemberScreen(changeBatchRecipeForm))
  .post("/batches/:id/delete", requireMemberScreen(removeBatchForm))
  .get("/api/menu", requireMember(apiMenu))
  .post("/api/batches", requireMember(apiAddPlannedBatch))
  .patch("/api/batches/:id", requireMember(apiUpdatePlannedBatch))
  .delete("/api/batches/:id", requireMember(apiRemovePlannedBatch))
  .get("/signin", signInScreen)
  .get("/auth/google", startSignIn)
  .get("/auth/google/callback", completeSignIn)
  .post("/auth/dev-signin", devSignIn)
  .post("/auth/signout", signOut)
  .get("/recipes", requireMemberScreen(recipeListScreen))
  .get("/recipes/:id", requireMemberScreen(recipeScreen))
  .get("/recipes/:id/edit", requireMemberScreen(editorScreen))
  .post("/recipes/:id", requireMemberScreen(saveEditForm))
  .post("/recipes/:id/image", requireMemberScreen(uploadRecipeImageForm))
  .post("/recipes/:id/image/delete", requireMemberScreen(deleteRecipeImageForm))
  .get("/recipes/:id/delete", requireMemberScreen(confirmDeleteScreen))
  .post("/recipes/:id/delete", requireMemberScreen(deleteRecipeForm))
  .delete("/api/recipes/:id", requireMember(apiDeleteRecipe))
  .get("/api/recipes/:id/image", requireMember(apiRecipeImage))
  .put("/api/recipes/:id/image", requireMember(apiPutRecipeImage))
  .delete("/api/recipes/:id/image", requireMember(apiDeleteRecipeImage))
  .get("/ingredients", requireMemberScreen(ingredientsScreen))
  .post("/ingredients/:id/rename", requireMemberScreen(renameForm))
  .patch("/api/ingredients/:id", requireMember(apiRename))
  .get("/intake", requireMemberScreen(intakeScreen))
  .get("/intake/batch", requireMemberScreen(batchIntakeScreen))
  .post("/intake/batch/review", requireMemberScreen(reviewBatchScreen))
  .post("/intake/batch/import", requireMemberScreen(importBatchScreen))
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
    await scheduledBackup(controller, env);
  },
} satisfies ExportedHandler<Env>;

/**
 * Public, and the only permanent public route. Answers whether the Worker is up
 * and whether its D1 binding actually reaches a migrated database.
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
