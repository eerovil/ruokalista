import {
  ALTERNATIVE_WORD,
  alternativeSets,
  sharedSource,
} from "./alternatives.ts";
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
    // The receiver draws plain strings, so a group of alternatives is one item
    // joined by the word itself: "1 lihaliemikuutio tai 1 annos fondia". A cook
    // reading a TV across the kitchen needs the choice on one line, not two
    // items that look like two things to fetch.
    items: alternativeSets(lines).map((set) => castSet(set.options, multiplier)),
  }];
}

/**
 * One item on the receiver's ingredient list: a line, or a whole choice.
 *
 * The shared source is stated once after the joined options rather than inside
 * each of them. Import gives every option of a group the same sentence, and a
 * scaled cooking makes each option worth showing — so the old per-option
 * version put the entire `tai` phrase inside each string and then joined those
 * with another ` tai `, which on a TV read as four things rather than a choice
 * between two (#183).
 */
function castSet(options: readonly RecipeLine[], multiplier: number): string {
  // An ordinary line is unaffected by any of this, including the rule that an
  // unstated amount lets its source wording replace the ingredient outright.
  if (options.length === 1) return castLine(options[0]!, multiplier);

  const shared = sharedSource(options, (line) =>
    sourceWorthShowing(line, multiplier),
  );
  if (shared === "") {
    // Options carrying genuinely different wording each keep their own.
    return options
      .map((line) => castLine(line, multiplier))
      .join(` ${ALTERNATIVE_WORD} `);
  }

  const joined = options
    .map((line) => display(line, multiplier))
    .join(` ${ALTERNATIVE_WORD} `);
  return `${joined} · ${shared}`;
}

/** `2 dl maito`, or the bare ingredient when the source stated no amount. */
function display(line: RecipeLine, multiplier: number): string {
  const amount = formatMeasurement(scaleMeasurement(line, multiplier));
  return amount === "" ? line.ingredient : `${amount} ${line.ingredient}`;
}

function castLine(line: RecipeLine, multiplier: number): string {
  const amount = formatMeasurement(scaleMeasurement(line, multiplier));
  const shown = amount === "" ? line.ingredient : `${amount} ${line.ingredient}`;
  if (!sourceWorthShowing(line, multiplier)) return shown;

  // An unstated amount often carries its cooking instruction only in the
  // source wording: "hieman", "maun mukaan", "tarvittaessa". On the TV
  // that wording replaces the bare ingredient rather than becoming a
  // detached evidence line underneath it.
  return amount === "" ? line.sourceLine : `${shown} · ${line.sourceLine}`;
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
      /* A display rule beats the browser's own [hidden], so say it again. */
      .cast-action[hidden] { display: none; }
      /*
        The launcher hides itself with an inline style whenever it decides
        there is nothing to cast to, and it does not always undo that once a
        device turns up. Whether the row belongs on the screen is decided by
        the cast state below, so the button is kept visible from here — an
        author !important outranks the SDK's inline display.
      */
      google-cast-launcher {
        display: inline-block !important;
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

  // No device to send to is the one state the row has nothing to say in.
  function showAction(context) {
    var absent = (cast.framework.CastState &&
      cast.framework.CastState.NO_DEVICES_AVAILABLE) || 'NO_DEVICES_AVAILABLE';
    var current = typeof context.getCastState === 'function'
      ? context.getCastState()
      : null;
    if (current === absent) action.setAttribute('hidden', 'hidden');
    else action.removeAttribute('hidden');
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
    showAction(context);
    context.addEventListener(
      cast.framework.CastContextEventType.CAST_STATE_CHANGED,
      function () { showAction(context); }
    );

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
  /*
    A long ingredient list is one tall narrow column while the instructions
    end halfway down. Before shrinking the type, the list is flowed into two
    sub-columns and the ingredients side takes the width the instructions
    were not using. The receiver adds .split only when the recipe overflows.
  */
  .columns.split { grid-template-columns: minmax(0, 1.3fr) minmax(0, 1fr); }
  .columns.split .ingredients .groups { column-count: 2; column-gap: 2.4vw; }
  /*
    The mirror image: four ingredients beside a page of method. The ingredient
    column is then mostly empty, and the width is worth more to the side that
    did not fit. The receiver adds .lean on the same terms as .split — only
    when it ends up with bigger type than the plain layout.
  */
  .columns.lean { grid-template-columns: minmax(0, .5fr) minmax(0, 1.5fr); }
  section { min-width: 0; }
  h2 {
    margin: 0 0 .35em; color: var(--accent);
    font-size: calc(clamp(1.35rem, 2.2vw, 2.7rem) * var(--fit));
  }
  h3 {
    margin: .65em 0 .15em; color: var(--muted);
    font-size: calc(clamp(1rem, 1.45vw, 1.8rem) * var(--fit));
    text-transform: uppercase; letter-spacing: .05em;
    break-after: avoid;
  }
  ul, ol { margin: 0; padding-left: 1.15em; }
  ul { list-style: none; padding-left: 0; }
  li {
    margin: 0 0 .3em; overflow-wrap: break-word; break-inside: avoid;
    font-size: calc(clamp(1rem, 1.65vw, 2rem) * var(--fit)); line-height: 1.25;
  }
  .ingredients li { padding: .16em 0; border-bottom: 1px solid #304039; }
  .instructions li { padding-left: .2em; }
  /*
    A Nest Hub is 1024×600 across a seven-inch panel: about 170 pixels to the
    inch, against roughly fifty on a television. So the same vw size is a third
    of the physical height in the kitchen that it is on the TV — 1.65vw lands at
    2.5 mm there, at the edge of what an eye resolves from the other side of a
    worktop, and a 1024×600 screenshot looked at on a laptop flatters it by
    nearly two to one.

    A short screen is therefore treated as a small dense panel rather than a
    small television: a bigger minimum type size, and the page's own margins,
    gaps and row spacing cut back to pay for it. A television is left alone,
    because a receiver that trims its margins loses them to overscan (#227).
  */
  @media (max-height: 800px) {
    main {
      padding: calc(2vh * var(--fit)) 2.4vw; gap: calc(1.6vh * var(--fit));
    }
    /*
      The title is the one thing that gets smaller here. At 4.2vw a long recipe
      name wraps to a second line and takes an eighth of the screen away from
      the text somebody is actually cooking from.
    */
    h1 { font-size: calc(clamp(1.5rem, 2.8vw, 5rem) * var(--fit)); }
    .multiplier { font-size: calc(clamp(1.25rem, 2.2vw, 3rem) * var(--fit)); }
    .columns { gap: 2.6vw; }
    .columns.split .ingredients .groups { column-gap: 2vw; }
    h2 {
      margin-bottom: .25em;
      font-size: calc(clamp(1.6rem, 2.2vw, 2.7rem) * var(--fit));
    }
    h3 { font-size: calc(clamp(1.15rem, 1.45vw, 1.8rem) * var(--fit)); }
    li {
      margin-bottom: .16em;
      font-size: calc(clamp(1.5rem, 1.65vw, 2rem) * var(--fit));
    }
    .ingredients li { padding: .1em 0; }
  }
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
    var flow = document.createElement('div');
    flow.className = 'groups';
    for (var index = 0; index < groups.length; index += 1) {
      var group = groups[index];
      if (group.title) flow.appendChild(text('h3', group.title));
      var list = document.createElement(listTag);
      for (var item = 0; item < group.items.length; item += 1) {
        list.appendChild(text('li', group.items[item]));
      }
      flow.appendChild(list);
    }
    section.appendChild(flow);
    return section;
  }

  // Shrink the shared type scale until the taller column fits, and report the
  // scale the current layout needed.
  function shrinkToFit() {
    var scale = 1;
    root.style.setProperty('--fit', String(scale));
    while (root.scrollHeight > root.clientHeight && scale > .58) {
      scale = Math.round((scale - .02) * 100) / 100;
      root.style.setProperty('--fit', String(scale));
    }
    return scale;
  }

  /*
    Shrinking the type is the last resort, and which layout shrinks least is
    not something a single measurement can be trusted with: each candidate
    moves width from one column to the other, and every line re-wraps as the
    scale changes. So each is taken all the way to the scale it actually needs
    and the one that ends up with the biggest type wins. A tie keeps the
    earlier, plainer layout, and a recipe that already fits at full size never
    tries anything else.

    'split' is for a long ingredient list: short lines wasting the rest of
    their row, so flowing them into two sub-columns and taking width from the
    instructions buys height. 'lean' is the opposite shape — a handful of
    ingredients beside a page of method — where the width is worth more to the
    side that did not fit. Flowing the method itself into two sub-columns is
    not a candidate: a paragraph needs the same area whatever shape it is
    poured into, so two narrow sub-columns of it come out just as tall.
  */
  var LAYOUTS = ['columns', 'columns split', 'columns lean'];

  function fit() {
    var columns = root.querySelector('.columns');
    if (columns) columns.className = LAYOUTS[0];
    var best = shrinkToFit();
    if (!columns || best === 1) return;

    var chosen = LAYOUTS[0];
    for (var index = 1; index < LAYOUTS.length; index += 1) {
      columns.className = LAYOUTS[index];
      var reached = shrinkToFit();
      if (reached > best) {
        best = reached;
        chosen = LAYOUTS[index];
      }
    }
    columns.className = chosen;
    root.style.setProperty('--fit', String(best));
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
