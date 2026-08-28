import { html, raw, type Raw } from "./html.ts";
import { formatMeasurement } from "./quantities.ts";
import type { Recipe, RecipeLine, RecipeStep } from "./recipes.ts";
import type { RecipePhase } from "./recipe-phase.ts";
import {
  formatMultiplier,
  scaleMeasurement,
  sourceWorthShowing,
} from "./scaling.ts";

/** The private protocol shared by Ruokalista's web sender and web receiver. */
export const CAST_NAMESPACE = "urn:x-cast:fi.eerovil.ruokalista.recipe";

interface CastGroup {
  title: string;
  items: string[];
}

export interface CastRecipe {
  version: 1;
  title: string;
  multiplier: string;
  ingredients: CastGroup[];
  instructions: CastGroup[];
}

/**
 * The receiver gets only what it draws. It never receives a household id,
 * source text, edit revision, image URL, or an authenticated recipe endpoint.
 */
export function castRecipe(recipe: Recipe, multiplier: number): CastRecipe {
  if (recipe.parts.length === 0) {
    return {
      version: 1,
      title: recipe.title,
      multiplier: formatMultiplier(multiplier),
      ingredients: ingredientGroup(recipe.lines, multiplier, ""),
      instructions: instructionGroup(recipe.steps, ""),
    };
  }

  const before: RecipePhase[] = [null, "before_parts"];
  const after: RecipePhase[] = ["after_parts"];

  return {
    version: 1,
    title: recipe.title,
    multiplier: formatMultiplier(multiplier),
    ingredients: [
      ...ingredientGroup(linesIn(recipe, before), multiplier, "Ennen osia"),
      ...recipe.parts.flatMap((part) =>
        ingredientGroup(part.lines, multiplier, part.title)
      ),
      ...ingredientGroup(linesIn(recipe, after), multiplier, "Lopuksi"),
    ],
    instructions: [
      ...instructionGroup(stepsIn(recipe, before), "Ennen osia"),
      ...recipe.parts.flatMap((part) =>
        instructionGroup(part.steps, part.title)
      ),
      ...instructionGroup(stepsIn(recipe, after), "Lopuksi"),
    ],
  };
}

function linesIn(recipe: Recipe, phases: RecipePhase[]): RecipeLine[] {
  return recipe.lines.filter((line) => phases.includes(line.phase));
}

function stepsIn(recipe: Recipe, phases: RecipePhase[]): RecipeStep[] {
  return recipe.steps.filter((step) => phases.includes(step.phase));
}

function ingredientGroup(
  lines: readonly RecipeLine[],
  multiplier: number,
  title: string,
): CastGroup[] {
  if (lines.length === 0) return [];
  return [{
    title,
    items: lines.map((line) => {
      const amount = formatMeasurement(scaleMeasurement(line, multiplier));
      const display = amount === ""
        ? line.ingredient
        : `${amount} ${line.ingredient}`;
      if (!sourceWorthShowing(line, multiplier)) return display;

      // An unstated amount often carries its cooking instruction only in the
      // source wording: "hieman", "maun mukaan", "tarvittaessa". On the TV
      // that wording replaces the bare ingredient rather than becoming a
      // detached evidence line underneath it.
      return amount === "" ? line.sourceLine : `${display} · ${line.sourceLine}`;
    }),
  }];
}

function instructionGroup(
  steps: readonly RecipeStep[],
  title: string,
): CastGroup[] {
  if (steps.length === 0) return [];
  return [{ title, items: steps.map((step) => step.text) }];
}

/** Cast launcher and sender island for an authenticated recipe screen. */
export function castSender(
  recipe: Recipe,
  multiplier: number,
  applicationId: string | undefined,
): Raw {
  const configured = applicationId?.trim() ?? "";
  if (configured === "") return raw("");

  const payload = encodeURIComponent(JSON.stringify(castRecipe(recipe, multiplier)));

  return html`<div class="cast-action" id="cast-action" hidden>
      <google-cast-launcher
        id="cast-launcher"
        role="button"
        tabindex="0"
        aria-label="Näytä Cast-laitteet"
        title="Näytä Cast-laitteet"
        hidden
      ></google-cast-launcher>
      <span>Lähetä televisioon</span>
    </div>
    <div
      id="cast-recipe"
      data-application-id="${configured}"
      data-namespace="${CAST_NAMESPACE}"
      data-recipe="${payload}"
      hidden
    ></div>
    <style>
      .cast-action {
        display: flex; align-items: center; gap: .55rem; margin: 0 0 1rem;
        color: var(--muted); font-size: .85rem;
      }
      google-cast-launcher {
        width: var(--tap); height: var(--tap); padding: .55rem;
        --connected-color: var(--accent);
        --disconnected-color: var(--muted);
      }
    </style>
    <script>${raw(CAST_SENDER_ISLAND)}</script>
    <script
      src="https://www.gstatic.com/cv/js/sender/v1/cast_sender.js?loadCastFramework=1"
      async
    ></script>`;
}

/* Deliberately ES5: recipe-screen islands are shipped without transpilation. */
const CAST_SENDER_ISLAND = `
(function () {
  var state = document.getElementById('cast-recipe');
  var launcher = document.getElementById('cast-launcher');
  var action = document.getElementById('cast-action');
  if (!state || !launcher || !action || typeof window.JSON === 'undefined') return;

  var recipe;
  try {
    recipe = JSON.parse(decodeURIComponent(state.getAttribute('data-recipe')));
  } catch (error) {
    return;
  }

  function sendRecipe(context) {
    var session = context.getCurrentSession();
    if (!session || typeof session.sendMessage !== 'function') return;
    var sent = session.sendMessage(state.getAttribute('data-namespace'), recipe);
    if (sent && typeof sent.catch === 'function') sent.catch(function () {});
  }

  window.__onGCastApiAvailable = function (available) {
    if (
      !available ||
      typeof window.cast === 'undefined' ||
      typeof window.chrome === 'undefined' ||
      !chrome.cast ||
      !cast.framework
    ) return;

    var context = cast.framework.CastContext.getInstance();
    context.setOptions({
      receiverApplicationId: state.getAttribute('data-application-id'),
      autoJoinPolicy: chrome.cast.AutoJoinPolicy.ORIGIN_SCOPED
    });
    launcher.removeAttribute('hidden');
    action.removeAttribute('hidden');

    context.addEventListener(
      cast.framework.CastContextEventType.SESSION_STATE_CHANGED,
      function (event) {
        if (
          event.sessionState === cast.framework.SessionState.SESSION_STARTED ||
          event.sessionState === cast.framework.SessionState.SESSION_RESUMED
        ) sendRecipe(context);
      }
    );
    sendRecipe(context);
  };
}());`;

/** Public, data-free page registered as the custom Web Receiver URL. */
export function castReceiver(): Response {
  const document = html`<!doctype html>
<html lang="fi">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Ruokalista</title>
  <style>${raw(CAST_RECEIVER_STYLE)}</style>
</head>
<body>
  <main id="recipe" aria-live="polite">
    <p class="waiting">Odotetaan reseptiä…</p>
  </main>
  <script src="https://www.gstatic.com/cast/sdk/libs/caf_receiver/v3/cast_receiver_framework.js"></script>
  <script>${raw(CAST_RECEIVER_ISLAND)}</script>
</body>
</html>`;

  return new Response(document.value, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "public, max-age=300",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
      "x-frame-options": "DENY",
    },
  });
}

const CAST_RECEIVER_STYLE = `
  :root {
    color-scheme: dark;
    --fit: 1;
    --bg: #101713;
    --surface: #18231d;
    --fg: #f3f5f3;
    --muted: #b7c3bb;
    --accent: #8cddb0;
  }
  * { box-sizing: border-box; }
  html, body { width: 100%; height: 100%; margin: 0; overflow: hidden; }
  body {
    background: radial-gradient(circle at 12% 0%, #203529 0, var(--bg) 42%);
    color: var(--fg); font-family: system-ui, sans-serif;
  }
  main {
    width: 100vw; height: 100vh; padding: calc(3vh * var(--fit)) 4vw;
    display: grid; grid-template-rows: auto minmax(0, 1fr);
    gap: calc(2.4vh * var(--fit));
  }
  .waiting { place-self: center; color: var(--muted); font-size: 3vw; }
  header { display: flex; align-items: baseline; gap: 2vw; min-width: 0; }
  h1 {
    flex: 1; min-width: 0; margin: 0;
    font-size: calc(clamp(2rem, 4.2vw, 5rem) * var(--fit));
    line-height: 1.05; letter-spacing: -.025em; overflow-wrap: break-word;
  }
  .multiplier {
    flex: none; margin: 0; padding: .2em .5em;
    color: var(--accent); background: var(--surface); border-radius: .3em;
    font-size: calc(clamp(1.5rem, 2.5vw, 3rem) * var(--fit)); font-weight: 700;
  }
  .columns {
    display: grid; grid-template-columns: minmax(0, .82fr) minmax(0, 1.18fr);
    gap: 4vw; min-height: 0;
  }
  section { min-width: 0; }
  h2 {
    margin: 0 0 .35em; color: var(--accent);
    font-size: calc(clamp(1.35rem, 2.2vw, 2.7rem) * var(--fit));
  }
  h3 {
    margin: .65em 0 .15em; color: var(--muted);
    font-size: calc(clamp(1rem, 1.45vw, 1.8rem) * var(--fit));
    text-transform: uppercase; letter-spacing: .05em;
  }
  ul, ol { margin: 0; padding-left: 1.15em; }
  ul { list-style: none; padding-left: 0; }
  li {
    margin: 0 0 .3em; overflow-wrap: break-word;
    font-size: calc(clamp(1rem, 1.65vw, 2rem) * var(--fit)); line-height: 1.25;
  }
  .ingredients li { padding: .16em 0; border-bottom: 1px solid #304039; }
  .instructions li { padding-left: .2em; }
`;

/* Deliberately ES5: this inline receiver code is not passed through a build. */
const CAST_RECEIVER_ISLAND = `
(function () {
  var namespace = '${CAST_NAMESPACE}';
  var root = document.getElementById('recipe');

  function text(tag, value, className) {
    var element = document.createElement(tag);
    if (className) element.className = className;
    element.textContent = value;
    return element;
  }

  function validGroups(groups) {
    if (!Array.isArray(groups) || groups.length > 20) return false;
    for (var index = 0; index < groups.length; index += 1) {
      if (
        !groups[index] ||
        typeof groups[index].title !== 'string' ||
        groups[index].title.length > 500 ||
        !Array.isArray(groups[index].items) ||
        groups[index].items.length > 200
      ) return false;
      for (var item = 0; item < groups[index].items.length; item += 1) {
        if (
          typeof groups[index].items[item] !== 'string' ||
          groups[index].items[item].length > 4000
        ) return false;
      }
    }
    return true;
  }

  function valid(recipe) {
    return recipe && recipe.version === 1 &&
      typeof recipe.title === 'string' && recipe.title.length <= 500 &&
      typeof recipe.multiplier === 'string' && recipe.multiplier.length <= 40 &&
      validGroups(recipe.ingredients) && validGroups(recipe.instructions);
  }

  function column(title, groups, className, listTag) {
    var section = document.createElement('section');
    section.className = className;
    section.appendChild(text('h2', title));
    for (var index = 0; index < groups.length; index += 1) {
      var group = groups[index];
      if (group.title) section.appendChild(text('h3', group.title));
      var list = document.createElement(listTag);
      for (var item = 0; item < group.items.length; item += 1) {
        list.appendChild(text('li', group.items[item]));
      }
      section.appendChild(list);
    }
    return section;
  }

  function fit() {
    var scale = 1;
    root.style.setProperty('--fit', String(scale));
    while (root.scrollHeight > root.clientHeight && scale > .58) {
      scale = Math.round((scale - .04) * 100) / 100;
      root.style.setProperty('--fit', String(scale));
    }
  }

  function render(recipe) {
    if (!valid(recipe)) return;
    while (root.firstChild) root.removeChild(root.firstChild);

    var header = document.createElement('header');
    header.appendChild(text('h1', recipe.title));
    header.appendChild(text('p', recipe.multiplier, 'multiplier'));
    root.appendChild(header);

    var columns = document.createElement('div');
    columns.className = 'columns';
    columns.appendChild(column('Ainekset', recipe.ingredients, 'ingredients', 'ul'));
    columns.appendChild(column('Valmistus', recipe.instructions, 'instructions', 'ol'));
    root.appendChild(columns);
    fit();
  }

  window.__ruokalistaCastReceive = render;
  window.addEventListener('resize', fit);

  if (typeof window.cast === 'undefined' || !cast.framework) return;
  var context = cast.framework.CastReceiverContext.getInstance();
  context.addCustomMessageListener(namespace, function (event) {
    render(event.data);
  });
  context.start();
}());`;
