import { html, page } from "./html.ts";
import type { Member } from "./members.ts";
import {
  PreferenceRefused,
  setPreferredMultiplier,
} from "./recipe-preference.ts";
import {
  blockedMessage,
  PublishRefused,
  publishRecipes,
  setRecipeSharing,
  unpublishRecipes,
  type PublishOutcome,
  type RecipeVisibility,
  type SharingDraft,
} from "./recipe-publish.ts";
import {
  findReadableRecipe,
  ownRecipeList,
  renderRecipe,
  type ListNotice,
} from "./recipes.ts";
import type { RouteContext } from "./router.ts";
import { DEFAULT_MULTIPLIER, parseMultiplier } from "./scaling.ts";

/**
 * The forms behind publishing and behind a household's own default multiplier.
 *
 * Both are posted from two places — the recipe list's bulk controls and one
 * recipe's own screen — and both answer the way every other form in this app
 * does: a success redirects, and a refusal re-renders the screen it came from
 * with the reason on it. `problem()` is the JSON API's refusal and would drop
 * somebody who tapped a button into raw JSON.
 */

/** `POST /recipes/julkaisu` — publish or unpublish one or many recipes. */
export async function publishForm(
  { env, request }: RouteContext,
  member: Member,
): Promise<Response> {
  const form = await request.formData();
  const action = String(form.get("action") ?? "");
  const query = String(form.get("q") ?? "");
  const back = returnPath(form.get("palaa"));
  const ids = form.getAll("recipeId").map((value) => Number(String(value)));

  if (action === "save") {
    const visibility = String(form.get("visibility") ?? "");
    const draft: SharingDraft = {
      visibility: isVisibility(visibility) ? visibility : "private",
      recipientIds: form.getAll("recipientId").map((value) => Number(String(value))),
    };
    if (!isVisibility(visibility) || ids.length !== 1) {
      return refuse(env, member, back, query, "Tuntematon jakotapa.", draft);
    }
    try {
      await setRecipeSharing(env.DB, member, ids[0]!, draft);
    } catch (error) {
      if (!(error instanceof PublishRefused)) throw error;
      return refuse(env, member, back, query, error.message, draft);
    }
    return seeOther(back ?? `/recipes/${ids[0]}`);
  }

  if (action !== "publish" && action !== "unpublish") {
    return refuse(env, member, back, query, "Tuntematon toiminto.");
  }

  let outcome: PublishOutcome;
  try {
    outcome =
      action === "publish"
        ? await publishRecipes(env.DB, member, ids)
        : await unpublishRecipes(env.DB, member, ids);
  } catch (error) {
    if (!(error instanceof PublishRefused)) throw error;
    return refuse(env, member, back, query, error.message);
  }

  // A partial result is still a refusal: something the member asked for did not
  // happen, and they have to be told which and why.
  if (outcome.blocked.length > 0) {
    return refuse(env, member, back, query, blockedMessage(outcome.blocked));
  }

  if (back !== null) return seeOther(back);

  return page(
    "Reseptit",
    await ownRecipeList(env.DB, member, query, doneNotice(action, outcome)),
    "recipes",
    member,
  );
}

/**
 * `POST /recipes/:id/kerroin` — this household's default multiplier for a
 * recipe, its own or a public one.
 *
 * A tapped chip arrives as `preset` and a typed value as `multiplier`, so the
 * chip wins where both are present: pressing 1,5× means 1,5×, whatever is left
 * sitting in the box beside it. A blank box with nothing tapped clears the
 * default, which is the one way to say "no habit here".
 */
export async function preferredMultiplierForm(
  { env, request, params }: RouteContext,
  member: Member,
): Promise<Response> {
  const recipe = await findReadableRecipe(
    env.DB,
    member.householdId,
    Number(params["id"]),
  );
  if (recipe === null) return notFound(member);

  const form = await request.formData();
  const preset = String(form.get("preset") ?? "").trim();
  const typed = String(form.get("multiplier") ?? "").trim();
  const chosen = preset === "" ? typed : preset;

  try {
    if (chosen === "") {
      await setPreferredMultiplier(env.DB, member, recipe.id, null);
    } else {
      const parsed = parseMultiplier(chosen);
      if (parsed === null) throw new PreferenceRefused(
        "Kertoimen pitää olla positiivinen luku, esimerkiksi 0,5 tai 1,5.",
      );
      await setPreferredMultiplier(env.DB, member, recipe.id, parsed);
    }
  } catch (error) {
    if (!(error instanceof PreferenceRefused)) throw error;
    return renderRecipe(
      env.DB,
      member,
      recipe,
      DEFAULT_MULTIPLIER,
      error.message,
      env.CAST_APP_ID,
    );
  }

  return seeOther(`/recipes/${recipe.id}`);
}

/**
 * What to say when it worked.
 *
 * "Already published" is reported separately from "published now" rather than
 * folded into one count: a member who selected eleven recipes and published two
 * of them wants to know that, not to be told eleven were published.
 */
function doneNotice(
  action: "publish" | "unpublish",
  outcome: PublishOutcome,
): ListNotice {
  const verb = action === "publish" ? "julkaistu" : "poistettu julkaisusta";

  if (outcome.changed.length === 0) {
    return {
      message:
        action === "publish"
          ? "Valitut reseptit olivat jo julkaistuja."
          : "Valitut reseptit eivät olleet julkaistuja.",
      refused: false,
    };
  }

  const changed =
    outcome.changed.length === 1
      ? `${outcome.changed[0]} on ${verb}.`
      : `${outcome.changed.length} reseptiä on ${verb}.`;

  return {
    message:
      outcome.unchanged.length === 0
        ? changed
        : `${changed} ${outcome.unchanged.length} oli jo tässä tilassa.`,
    refused: false,
  };
}

/**
 * Back to wherever the button was, with the reason on it.
 *
 * When the post came from one recipe's own screen that is the screen to
 * re-render; otherwise it is the list. The recipe is re-read rather than
 * assumed, because a refusal is exactly the case where what is stored and what
 * the button believed have come apart.
 */
async function refuse(
  env: RouteContext["env"],
  member: Member,
  back: string | null,
  query: string,
  message: string,
  sharingDraft?: SharingDraft,
): Promise<Response> {
  if (back !== null) {
    const recipe = await findReadableRecipe(
      env.DB,
      member.householdId,
      Number(back.slice("/recipes/".length)),
    );
    if (recipe !== null) {
      return renderRecipe(
        env.DB,
        member,
        recipe,
        DEFAULT_MULTIPLIER,
        message,
        env.CAST_APP_ID,
        sharingDraft,
      );
    }
  }

  return page(
    "Reseptit",
    await ownRecipeList(env.DB, member, query, { message, refused: true }),
    "recipes",
    member,
    400,
  );
}

function isVisibility(value: string): value is RecipeVisibility {
  return value === "private" || value === "selected" || value === "public";
}

/**
 * The one shape of return path this accepts.
 *
 * Anything else is dropped rather than followed: a redirect target read off a
 * form is how an open redirect gets built, and the only place that posts one is
 * a recipe's own screen.
 */
function returnPath(value: FormDataEntryValue | null): string | null {
  const text = String(value ?? "");
  if (!/^\/recipes\/[0-9]+$/.test(text)) return null;
  return text;
}

function seeOther(location: string): Response {
  return new Response(null, { status: 303, headers: { Location: location } });
}

function notFound(member: Member): Response {
  return page(
    "Ei löytynyt",
    html`<h1>Ei löytynyt</h1>
      <p class="empty">Tätä reseptiä ei ole.</p>`,
    "recipes",
    member,
    404,
  );
}
