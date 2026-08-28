import { adminScreen, adminStatus } from "./admin-screens.ts";
import {
  requireAdmin,
  requireAdminScreen,
  requireMember,
  requireMemberScreen,
} from "./auth.ts";
import { scheduledBackup } from "./backup-scheduled.ts";
import { castReceiver } from "./cast.ts";
import {
  batchIntakeScreen,
  importBatchScreen,
  reviewBatchScreen,
} from "./batch-intake-screens.ts";
import type { Env } from "./env.ts";
import {
  addMemberForm,
  createHouseholdForm,
  editMemberForm,
  householdListScreen,
  householdScreen,
  removeMemberForm,
  renameHouseholdForm,
} from "./household-admin.ts";
import {
  apiRename,
  ingredientsScreen,
  renameForm,
} from "./ingredient-screens.ts";
import { listIngredients } from "./ingredients.ts";
import {
  correctScreen,
  intakeJobReviewScreen,
  intakeJobStatus,
  intakeScreen,
  retryIntakeJobForm,
  saveScreen,
  startIntakeJob,
} from "./intake-screens.ts";
import { maintainIntakeJobs, processIntakeQueue } from "./intake-jobs.ts";
import {
  apiListRecipes,
  apiShowRecipe,
  publicRecipeListScreen,
  recipeListScreen,
  recipeScreen,
} from "./recipes.ts";
import { preferredMultiplierForm, publishForm } from "./publish-screens.ts";
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
  recipeImageAdminScreen,
  recipeImageConfirmScreen,
  recipeImageSplitter,
} from "./recipe-image-admin.ts";
import {
  apiDeleteRecipeImage,
  apiPutRecipeImage,
  apiRecipeImage,
  apiRecipeImageStatus,
} from "./recipe-images.ts";
import {
  appleIcon,
  faviconIcon,
  manifest,
  maskableIcon,
  offline,
  regularIcon192,
  regularIcon512,
  serviceWorker,
} from "./pwa.ts";
import { pantryRemoveForm, pantryScreen } from "./pantry-screens.ts";
import { Router, type RouteContext } from "./router.ts";
import {
  currentListJson,
  productSearchJson,
  productSearchScreen,
  removeProductForm,
  saveProductForm,
  sendShoppingListForm,
  shoppingPantryForm,
  shoppingScreen,
} from "./shopping-screens.ts";
import {
  completeSignIn,
  devSignIn,
  signInScreen,
  signOut,
  startSignIn,
} from "./signin.ts";
import {
  addBatchForm,
  changeBatchMultiplierForm,
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
 * Everything except /health goes through requireMember. The admin routes go
 * through requireAdmin as well, which is that same wall with one more question
 * asked after it.
 */

const router = new Router()
  .get("/health", health)
  .get("/manifest.webmanifest", manifest)
  .get("/sw.js", serviceWorker)
  .get("/offline", offline)
  .get("/favicon.svg", faviconIcon)
  .get("/icon-192.png", regularIcon192)
  .get("/icon-512.png", regularIcon512)
  .get("/icon-maskable-512.png", maskableIcon)
  .get("/apple-touch-icon.png", appleIcon)
  .get("/cast/receiver", castReceiver)
  .get("/", requireMemberScreen(weekScreen))
  .get("/picker", requireMemberScreen(pickerScreen))
  .post("/batches", requireMemberScreen(addBatchForm))
  .get("/batches/:id", requireMemberScreen(plannedBatchScreen))
  .get("/batches/:id/coverage", requireMemberScreen(coverageScreen))
  .post("/batches/:id/coverage", requireMemberScreen(coverageForm))
  .post("/batches/:id/multiplier", requireMemberScreen(changeBatchMultiplierForm))
  .post("/batches/:id/recipe", requireMemberScreen(changeBatchRecipeForm))
  .post("/batches/:id/delete", requireMemberScreen(removeBatchForm))
  .get("/ostoslista", requireMemberScreen(shoppingScreen))
  .post("/ostoslista/kaappi", requireMemberScreen(shoppingPantryForm))
  .post("/ostoslista/laheta", requireMemberScreen(sendShoppingListForm))
  .get("/ostoslista/tuote", requireMemberScreen(productSearchScreen))
  .post("/ostoslista/tuote", requireMemberScreen(saveProductForm))
  .post("/ostoslista/tuote/poista", requireMemberScreen(removeProductForm))
  .get("/ostoslista/haku", requireMember(productSearchJson))
  .get("/ostoslista/s-lista", requireMember(currentListJson))
  .get("/kaappi", requireMemberScreen(pantryScreen))
  .post("/kaappi/:id/poista", requireMemberScreen(pantryRemoveForm))
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
  // Before `/recipes/:id`: the router answers with the first pattern that
  // matches, and a literal segment has to win over the wildcard that would
  // otherwise swallow it.
  .get("/recipes/julkiset", requireMemberScreen(publicRecipeListScreen))
  .post("/recipes/julkaisu", requireMemberScreen(publishForm))
  .get("/recipes/:id", requireMemberScreen(recipeScreen))
  .get("/recipes/:id/edit", requireMemberScreen(editorScreen))
  .post("/recipes/:id", requireMemberScreen(saveEditForm))
  .post("/recipes/:id/kerroin", requireMemberScreen(preferredMultiplierForm))
  .post("/recipes/:id/image", requireMemberScreen(uploadRecipeImageForm))
  .post("/recipes/:id/image/delete", requireMemberScreen(deleteRecipeImageForm))
  .get("/recipes/:id/delete", requireMemberScreen(confirmDeleteScreen))
  .post("/recipes/:id/delete", requireMemberScreen(deleteRecipeForm))
  .delete("/api/recipes/:id", requireMember(apiDeleteRecipe))
  .get("/api/recipes/:id/image", requireMember(apiRecipeImage))
  .put("/api/recipes/:id/image", requireMember(apiPutRecipeImage))
  .delete("/api/recipes/:id/image", requireMember(apiDeleteRecipeImage))
  .get("/api/recipes/:id/image/status", requireMember(apiRecipeImageStatus))
  .get("/ingredients", requireMemberScreen(ingredientsScreen))
  // Renaming a global ingredient rewrites what every household's recipes say,
  // so it is an admin operation while reading the list is not (#143).
  .post("/ingredients/:id/rename", requireAdminScreen(renameForm))
  .patch("/api/ingredients/:id", requireAdmin(apiRename))
  .get("/intake", requireMemberScreen(intakeScreen))
  .post("/intake/correct", requireMemberScreen(correctScreen))
  .get("/intake/imports/:id/review", requireMemberScreen(intakeJobReviewScreen))
  .post("/intake/imports/:id/retry", requireMemberScreen(retryIntakeJobForm))
  .post("/api/intake/imports", requireMember(startIntakeJob))
  .get("/api/intake/imports/:id", requireMember(intakeJobStatus))
  .post("/recipes", requireMemberScreen(saveScreen))
  .get("/api/recipes", requireMember(apiListRecipes))
  .get("/api/recipes/:id", requireMember(apiShowRecipe))
  .get("/api/ingredients", requireMember(listIngredients))
  .get("/admin", requireAdminScreen(adminScreen))
  .get("/intake/batch", requireAdminScreen(batchIntakeScreen))
  .post("/intake/batch/review", requireAdminScreen(reviewBatchScreen))
  .post("/intake/batch/import", requireAdminScreen(importBatchScreen))
  .get("/admin/households", requireAdminScreen(householdListScreen))
  .post("/admin/households", requireAdminScreen(createHouseholdForm))
  .get("/admin/households/:id", requireAdminScreen(householdScreen))
  .post("/admin/households/:id/name", requireAdminScreen(renameHouseholdForm))
  .post("/admin/households/:id/members", requireAdminScreen(addMemberForm))
  .post("/admin/households/:id/members/:memberId", requireAdminScreen(editMemberForm))
  .post(
    "/admin/households/:id/members/:memberId/delete",
    requireAdminScreen(removeMemberForm),
  )
  .get("/admin/recipe-images", requireAdminScreen(recipeImageAdminScreen))
  .get("/admin/recipe-images/confirm", requireAdminScreen(recipeImageConfirmScreen))
  .get("/admin/recipe-images/split.js", requireAdminScreen(recipeImageSplitter))
  .get("/api/admin/status", requireAdmin(adminStatus));

export default {
  fetch(request: Request, env: Env): Promise<Response> {
    return router.handle(request, env);
  },

  async scheduled(
    controller: ScheduledController,
    env: Env,
    _ctx: ExecutionContext,
  ): Promise<void> {
    try {
      await maintainIntakeJobs(env);
    } catch (error) {
      console.error(JSON.stringify({
        event: "intake.maintenance_failed",
        detail: String((error as Error)?.message ?? error),
      }));
    }
    if (controller.cron === "17 2 * * *") await scheduledBackup(controller, env);
  },

  async queue(
    batch: MessageBatch<{ jobId: string }>,
    env: Env,
  ): Promise<void> {
    await processIntakeQueue(batch, env);
  },
} satisfies ExportedHandler<Env, { jobId: string }>;

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
