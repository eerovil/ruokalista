/**
 * The one HTML shell. Server-rendered, mobile-first — a week gets planned at the
 * kitchen table and a recipe gets read at the hob.
 *
 * `html` is a tagged template that escapes every interpolated value. To put
 * already-built markup in, wrap it in `raw()`; that is the only way past the
 * escaping, so it is also the only thing to look at when reviewing for XSS.
 */

import { PWA_CLIENT_SCRIPT, THEME_COLOR } from "./pwa-content.ts";
import { formatMultiplier, MULTIPLIER_CHOICES } from "./scaling.ts";

/**
 * Written out longhand rather than as a `constructor(readonly value: string)`
 * parameter property, because node's `--experimental-strip-types` only removes
 * types and cannot desugar one. That single line made every module that reaches
 * this one — which is most of them, through `auth.ts` — impossible to load in a
 * `dev/` check, and the storage failure cases in
 * `dev/check-recipe-image-commit.ts` are exactly the kind that cannot be
 * provoked through a browser. Same class, same behaviour, one more line.
 */
export class Raw {
  readonly value: string;

  constructor(value: string) {
    this.value = value;
  }
}

export function raw(value: string): Raw {
  return new Raw(value);
}

export function html(
  strings: TemplateStringsArray,
  ...values: unknown[]
): Raw {
  let out = strings[0] ?? "";

  for (let i = 0; i < values.length; i++) {
    out += render(values[i]) + (strings[i + 1] ?? "");
  }

  return new Raw(out);
}

function render(value: unknown): string {
  if (value instanceof Raw) return value.value;
  if (value === null || value === undefined) return "";
  if (Array.isArray(value)) return value.map(render).join("");
  return escape(String(value));
}

export function escape(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * The shared visual foundation. Hierarchy is carried by colour tokens rather
 * than by opacity — faded text on a phone in a bright kitchen is the first
 * thing to become unreadable — and every control is at least a thumb tall.
 */
const STYLES = `
  :root {
    color-scheme: light dark;
    --bg: light-dark(#ffffff, #15171c);
    --fg: light-dark(#16181d, #ecedf1);
    --muted: light-dark(#5c6270, #a3a9b6);
    --edge: light-dark(#e1e4ea, #2d313a);
    --surface: light-dark(#f5f6f8, #1d2027);
    --accent: light-dark(#1f5d3c, #7fd6a4);
    --accent-fg: light-dark(#ffffff, #10251a);
    --warn: light-dark(#8a3312, #f0a98a);

    --tap: 2.75rem;
    --tap-compact: 2.25rem;
    --radius: .5rem;
    --tabs-height: 3.75rem;
  }
  * { box-sizing: border-box; }
  /* The hidden attribute is how the islands hide things, and the browser
     implements it as a default display:none that any rule of its own beats.
     Several elements below do have such a rule, so this says the attribute
     wins. (No backticks in here: this stylesheet is a template literal.) */
  [hidden] { display: none !important; }
  /* No picture may be wider than the screen it is on. Recipe images arrive from
     outside and are whatever size the tool that made them chose. */
  img { max-width: 100%; height: auto; }
  body {
    margin: 0; padding: 0; background: var(--bg); color: var(--fg);
    font: 1rem/1.55 system-ui, sans-serif;
    -webkit-text-size-adjust: 100%;
  }
  main {
    margin: 0 auto; padding: 1rem;
    max-width: 40rem;
  }
  body.has-tabs main {
    padding-bottom: calc(var(--tabs-height) + env(safe-area-inset-bottom) + 1.5rem);
  }

  h1 { font-size: 1.5rem; line-height: 1.25; margin: 0 0 1rem; letter-spacing: -.01em; }
  h2 { font-size: 1.15rem; margin: 1.75rem 0 .5rem; }
  h3 { font-size: .8rem; font-weight: 600; letter-spacing: .04em;
    text-transform: uppercase; color: var(--muted); margin: 1.25rem 0 .35rem; }
  a { color: inherit; }
  ul { list-style: none; margin: 0; padding: 0; }

  :focus-visible {
    outline: 2px solid var(--accent); outline-offset: 2px; border-radius: .2rem;
  }

  /* ---------------------------------------------------------- the shell */

  .topbar {
    position: sticky; top: 0; z-index: 2;
    display: flex; align-items: center; justify-content: space-between; gap: .5rem;
    margin: 0 auto; padding: calc(.5rem + env(safe-area-inset-top)) 1rem .5rem;
    max-width: 40rem;
    background: var(--bg);
  }
  .wordmark {
    font-size: .95rem; font-weight: 600; letter-spacing: .01em;
    color: var(--muted); text-decoration: none;
  }
  .account { position: relative; }
  .account > summary {
    display: flex; align-items: center; justify-content: center;
    width: var(--tap); height: var(--tap); margin-right: -.6rem;
    list-style: none; cursor: pointer; color: var(--muted); border-radius: 50%;
  }
  .account > summary::-webkit-details-marker { display: none; }
  .account[open] > summary { color: var(--fg); background: var(--surface); }
  .account-menu {
    position: absolute; right: 0; top: calc(100% + .25rem); z-index: 3;
    min-width: 12rem; padding: .5rem;
    background: var(--bg); border: 1px solid var(--edge);
    border-radius: var(--radius);
    box-shadow: 0 .5rem 1.5rem light-dark(rgba(0,0,0,.12), rgba(0,0,0,.5));
  }
  .account-menu form { margin: 0; }
  .account-menu button { width: 100%; }
  .account-menu a {
    display: flex; align-items: center;
    min-height: var(--tap); padding: 0 .6rem; margin-bottom: .35rem;
    font-weight: 600; text-decoration: none;
    border-bottom: 1px solid var(--edge);
  }

  .tabs {
    position: fixed; left: 0; right: 0; bottom: 0; z-index: 2;
    display: flex;
    padding-bottom: env(safe-area-inset-bottom);
    background: var(--bg); border-top: 1px solid var(--edge);
  }
  .tabs a {
    flex: 1;
    display: flex; flex-direction: column; align-items: center; justify-content: center;
    gap: .15rem; min-height: var(--tabs-height); padding: .4rem .2rem;
    font-size: .7rem; text-decoration: none; color: var(--muted);
    border-top: 2px solid transparent;
  }
  .tabs a[aria-current] { color: var(--accent); border-top-color: var(--accent); font-weight: 600; }
  .tabs svg { width: 1.4rem; height: 1.4rem; }

  /* ---------------------------------------------------------- controls */

  button, .button {
    display: inline-flex; align-items: center; justify-content: center; gap: .4rem;
    min-height: var(--tap); padding: .5rem 1rem;
    font: inherit; color: inherit; text-decoration: none;
    background: var(--surface); border: 1px solid var(--edge);
    border-radius: var(--radius); cursor: pointer;
  }
  .button, button.primary {
    color: var(--accent-fg); background: var(--accent);
    border-color: var(--accent); font-weight: 600;
  }
  button.quiet { background: transparent; color: var(--muted); }
  input[type=search], textarea, select, input[type=text], input[type=number],
  input:not([type]) {
    width: 100%; min-height: var(--tap); padding: .55rem .7rem; font: inherit;
    background: var(--bg); color: inherit;
    border: 1px solid var(--edge); border-radius: var(--radius);
  }
  input[type=search] { flex: 1; }
  textarea { resize: vertical; line-height: 1.5; }
  input[type=file] { font: inherit; }

  form { display: flex; gap: .5rem; margin-bottom: 1rem; }
  form.stacked { display: block; }
  form.stacked label { display: block; margin: 1rem 0 .3rem; font-size: .9rem;
    font-weight: 600; }
  form.inline { display: flex; gap: .3rem; align-items: center; margin: 0; }
  form.inline input { width: 3.6rem; min-height: var(--tap-compact);
    padding: .25rem; text-align: center; }
  form.inline button { min-height: var(--tap-compact); padding: .25rem .6rem;
    font-size: .85rem; }

  /* ------------------------------------------------------------ screens */

  .recipes li { border-bottom: 1px solid var(--edge); }
  .recipes a { display: flex; align-items: center; gap: .7rem;
    min-height: var(--tap); padding: .75rem 0; text-decoration: none; }
  .recipes-text { display: flex; flex-direction: column; justify-content: center;
    min-width: 0; }
  .recipes .meta, .yield, .empty { color: var(--muted); font-size: .85rem; }
  .lines li { padding: .55rem 0; font-size: 1.05rem; border-bottom: 1px solid var(--edge); }
  .amount { font-weight: 600; font-variant-numeric: tabular-nums; }
  .source { display: block; margin-top: .1rem; color: var(--muted); font-size: .8rem; }
  .source-text { white-space: pre-wrap; color: var(--muted); font-size: .85rem;
    margin: .5rem 0 0; }
  .source-link { margin: .5rem 0 0; font-size: .85rem; word-break: break-all; }
  .source-original { margin: 2rem 0 1rem; }
  .source-original > summary {
    display: inline-flex; align-items: center;
    min-height: var(--tap-compact); cursor: pointer;
    color: var(--muted); font-size: .9rem;
  }
  .yield { margin: 0 0 1rem; }
  .yield.is-scaled {
    display: inline-block; padding: .3rem .6rem;
    color: var(--accent); font-size: .85rem; font-weight: 600;
    background: var(--surface); border-radius: var(--radius);
  }
  .recipe-edit { margin-top: 2rem; font-size: .9rem; }
  .recipe-edit a { color: var(--muted); }
  .keep-awake {
    display: flex; align-items: center; gap: .6rem; margin: 1rem 0;
    color: var(--muted); font-size: .85rem;
  }
  .keep-awake[hidden] { display: none; }
  .keep-awake button { flex: none; min-height: var(--tap-compact); padding: .3rem .6rem; }
  .keep-awake button[hidden] { display: none; }
  .keep-awake-video {
    position: fixed; left: 0; bottom: 0; width: 1px; height: 1px;
    opacity: .001; pointer-events: none;
  }
  ol { padding-left: 1.2rem; }
  ol li { margin-bottom: .5rem; }

  .edit-lines, .edit-steps { padding-left: 1.2rem; }
  .line { padding: .75rem 0; border-bottom: 1px solid var(--edge); }
  .line.is-new { border-left: 3px solid var(--accent); padding-left: .6rem; }
  .amounts { display: flex; gap: .4rem; margin-bottom: .4rem; }
  .badge {
    display: inline-block; margin-bottom: .35rem; padding: .15rem .45rem;
    font-size: .75rem; color: var(--muted);
    border: 1px solid var(--edge); border-radius: .25rem;
  }
  .remove { display: inline-flex; align-items: center; gap: .35rem;
    min-height: var(--tap-compact); font-size: .85rem; color: var(--muted); }
  .remove input { width: auto; min-height: 0; }
  nav.weeks { display: flex; justify-content: space-between; gap: .5rem;
    margin-bottom: 1.5rem; font-size: .85rem; }
  nav.weeks a { display: inline-flex; align-items: center;
    min-height: var(--tap-compact); text-decoration: none; color: var(--muted); }
  .day { margin-bottom: 1.25rem; scroll-margin-top: .75rem; }
  .day h2 { display: flex; align-items: center; gap: .5rem;
    margin: 0 0 .4rem; font-size: 1rem; text-transform: capitalize; }
  .day.is-today h2 { font-weight: 700; }
  .day.is-today { padding: .6rem .7rem .1rem; border: 1px solid var(--accent);
    border-radius: var(--radius); background: var(--surface); }
  .today-badge { padding: .1rem .4rem; font-size: .7rem; font-weight: 600;
    text-transform: none; color: var(--accent-fg); background: var(--accent);
    border-radius: .25rem; }
  .covered-status { margin-left: auto; font-size: .75rem; font-weight: 600;
    text-transform: none; color: var(--accent); white-space: nowrap; }
  .continuing-card { margin: 0 0 .5rem; padding: .15rem .7rem;
    background: var(--surface); border: 1px solid var(--edge);
    border-radius: var(--radius); }
  .continuing-row { display: flex; flex-wrap: wrap; align-items: baseline;
    gap: .2rem .75rem; padding: .45rem 0; }
  .continuing-row + .continuing-row { border-top: 1px solid var(--edge); }
  .continuing-title { flex: 1 1 12rem; min-width: 0; font-weight: 600;
    overflow-wrap: break-word; }
  .continuing-slots { flex: 0 0 auto; font-size: .8rem;
    color: var(--muted); white-space: nowrap; }
  .batch-cards { display: flex; flex-direction: column; gap: .5rem;
    margin: 0 0 .5rem; }
  /* One cooking reads as one card: head, then a hairline per covered day. */
  .batch-card { min-width: 0; background: var(--surface);
    border: 1px solid var(--edge); border-radius: var(--radius);
    overflow: hidden; }
  /* The head wraps rather than clipping: a long Finnish compound title beside
     the wider carried pill runs a 360px row out of width, and a card that
     hides its overflow would simply cut the name off. */
  .batch-card .entry > a { flex-wrap: wrap; gap: .4rem .6rem;
    padding: .6rem .7rem; background: transparent; border-radius: 0; }
  .batch-card .entry .recipe-image.is-thumb { flex: none;
    width: 3rem; height: 3rem; border-radius: 50%; }
  /* Picture and name stay together on one line; only the pill wraps below.
     A content-sized basis is what makes it wrap for a long name and stay
     inline for a short one. (No backticks here — STYLES is a template
     literal, so one would end the string.) */
  .batch-head-main { display: flex; align-items: center; gap: .6rem;
    flex: 1 1 auto; min-width: 0; }
  .batch-card .entry-title { min-width: 0; overflow-wrap: break-word; }
  .batch-start, .batch-carried { flex: none; margin-left: auto;
    padding: .2rem .55rem;
    font-size: .75rem; font-weight: 600; white-space: nowrap;
    border-radius: 1rem; }
  .batch-start { color: var(--accent-fg); background: var(--accent); }
  .batch-carried { color: var(--accent); border: 1px solid var(--accent); }
  .batch-when { display: block; margin: 0; padding: 0; list-style: none; }
  .batch-when-day { display: flex; flex-wrap: wrap; align-items: center;
    gap: .5rem; padding: .45rem .7rem; font-size: .85rem;
    border-top: 1px solid var(--edge); }
  .batch-when-weekday { min-width: 1.5rem; color: var(--fg);
    text-transform: capitalize; }
  .batch-when-date { min-width: 3rem; color: var(--muted);
    font-variant-numeric: tabular-nums; }
  .batch-when-slots { flex: 1 1 6rem; min-width: 0; color: var(--fg);
    overflow-wrap: break-word; }
  .batch-passes { margin-left: auto; padding: .1rem .45rem;
    font-size: .7rem; color: var(--accent); white-space: nowrap;
    border: 1px solid var(--accent); border-radius: 1rem; }
  /* A batch #165 could not convert. Loud enough to be corrected, quiet enough
     not to look like an error the household caused. */
  .batch-unconverted { margin: 0; padding: .35rem .7rem;
    font-size: .75rem; color: var(--accent);
    border-top: 1px solid var(--edge); }
  .batch-end, .batch-onward { margin: 0; padding: .35rem .7rem .45rem;
    font-size: .75rem; color: var(--muted); }
  .batch-end { text-align: right; }
  /* Jump back to today after scrolling away — the week's one floating action. */
  .to-today {
    position: fixed; right: 1rem; z-index: 2;
    bottom: calc(var(--tabs-height) + env(safe-area-inset-bottom) + 1rem);
    display: inline-flex; align-items: center;
    min-height: var(--tap-compact); padding: .4rem .9rem;
    font-size: .85rem; font-weight: 600; text-decoration: none;
    color: var(--accent); background: var(--bg);
    border: 1px solid var(--accent); border-radius: 1.5rem;
    box-shadow: 0 .25rem .75rem light-dark(rgba(0,0,0,.15), rgba(0,0,0,.55));
  }
  .slot-actions { display: flex; gap: 1rem; padding: .2rem 0 .5rem;
    border-top: 1px solid var(--edge); }
  .empty-slot, .add-more { display: inline-flex; align-items: center;
    min-height: var(--tap-compact); font-size: .9rem; color: var(--muted); }
  .entry > a {
    display: flex; align-items: center; gap: .5rem;
    min-height: var(--tap); padding: .5rem .6rem;
    text-decoration: none;
    background: var(--surface); border-radius: var(--radius);
  }
  .entries { display: flex; flex-direction: column; gap: .35rem; margin: .1rem 0 .5rem; }
  /* Today's own container is already --surface, so its cards need to lift. */
  .day.is-today .batch-card,
  .day.is-today .continuing-card { background: var(--bg); }
  .entry-title { flex: 1; }
  .entry-when { margin: 0 0 .2rem; }
  .meta { color: var(--muted); font-size: .85rem; }
  .batch-actions { display: flex; flex-wrap: wrap; gap: .5rem; }
  .control-row { display: flex; gap: .5rem; align-items: center; }
  .control-row input { width: 5rem; text-align: center; }
  /* One tap for the four multipliers a household actually uses, and a box for
     everything else — the domain takes any positive number. */
  .multiplier-choice { display: flex; flex-wrap: wrap; gap: .4rem; align-items: center; }
  .multiplier-choice button { min-width: 3.5rem; padding: .4rem .6rem; }
  .multiplier-choice .is-current { background: var(--accent); color: var(--bg);
    border-color: var(--accent); }
  .multiplier-choice input { width: 4.5rem; text-align: center; }
  .coverage-weeks { align-items: center; }
  .coverage-weeks span { color: var(--muted); }
  .coverage-grid { display: grid; grid-template-columns: minmax(7rem, 1fr) 1fr 1fr;
    gap: .35rem; align-items: stretch; margin-bottom: 1rem; }
  .coverage-grid > strong { align-self: end; font-size: .75rem; text-align: center; }
  .coverage-day { display: flex; flex-direction: column; justify-content: center;
    min-height: var(--tap); text-transform: capitalize; }
  .coverage-day small { color: var(--muted); }
  .coverage-form { display: block; }
  .coverage-cell { position: relative; display: flex; cursor: pointer; }
  .coverage-cell input { position: absolute; width: 1px; height: 1px;
    overflow: hidden; opacity: 0; }
  .coverage-cell > span { display: flex; align-items: center; justify-content: center;
    width: 100%; min-height: var(--tap); padding: .3rem;
    color: var(--muted); font-size: .75rem; border: 1px solid var(--edge);
    border-radius: var(--radius); }
  .coverage-cell .chosen { display: none; }
  .coverage-cell input:checked + span { color: var(--accent-fg);
    background: var(--accent); border-color: var(--accent); font-weight: 600; }
  .coverage-cell input:checked + span .choose { display: none; }
  .coverage-cell input:checked + span .chosen { display: inline; }
  .coverage-cell input:focus-visible + span { outline: 2px solid var(--accent);
    outline-offset: 2px; }
  .coverage-form > button { width: 100%; }
  .section { font-size: .85rem; }
  .edit-step { flex-direction: column; align-items: stretch; }
  .part { margin: 1.5rem 0; padding-left: .7rem;
    border-left: 3px solid var(--edge); }
  .part h2 { margin-top: 0; font-size: 1.05rem; }
  .ingredients li { padding: .5rem 0; border-bottom: 1px solid var(--edge); }
  .position { width: 3rem !important; flex: none !important; color: var(--muted); }
  .edit-steps li { display: flex; gap: .4rem; align-items: flex-start; }
  .edit-steps li.has-phase { flex-wrap: wrap; }
  .edit-steps li.has-phase > label { flex-basis: 100%; }
  .pick li { padding: .5rem 0; border-bottom: 1px solid var(--edge); }
  .pick .recipe-image.is-thumb { width: 2.5rem; height: 2.5rem; }
  .entry .recipe-image.is-thumb { width: 2.25rem; height: 2.25rem; }
  /* min-width so a long name shrinks instead of shoving the row's controls
     past the viewport edge — a flex item will not go below its content
     otherwise, which is how the multiplier control ended up over the button. */
  .pick-title { flex: 1 1 auto; min-width: 0; overflow-wrap: break-word; }
  /* Narrow and non-shrinking, so a long recipe name gives way rather than
     pushing the multiplier field over the button beside it. */
  .pick-multiplier { flex: 0 0 auto; width: 4.5rem; min-height: var(--tap-compact); }
  .chosen { list-style: none; margin: .25rem 0 0; padding: 0; }
  .chosen li {
    display: flex; align-items: center; gap: .75rem;
    padding: .35rem 0; min-height: var(--tap-compact);
    border-bottom: 1px solid var(--edge);
  }
  .chosen img {
    width: 3rem; height: 3rem; object-fit: cover;
    border-radius: var(--radius); background: var(--surface);
  }
  .chosen .page-name { flex: 1; }
  .status { margin: .5rem 0 0; color: var(--fg); font-size: .9rem; font-weight: 600; }
  .progress {
    margin: .35rem 0 0; padding: .6rem .8rem;
    font-size: .85rem; color: var(--muted);
    background: var(--surface); border-radius: var(--radius);
  }
  .ingredient-row {
    display: flex; align-items: baseline; gap: .75rem;
    min-height: var(--tap-compact);
  }
  .ingredient-name { flex: 1; }
  .rename > summary {
    display: flex; align-items: baseline; gap: .75rem;
    min-height: var(--tap); padding: .1rem 0; cursor: pointer;
    list-style: none;
  }
  .rename > summary::-webkit-details-marker { display: none; }
  .rename[open] > summary .ingredient-name { font-weight: 600; }
  /* Nothing else says these rows open. A chevron does, without a second line. */
  .rename > summary::after {
    content: "›"; color: var(--muted); font-size: 1.1rem; line-height: 1;
    transition: transform .1s;
  }
  .rename[open] > summary::after { transform: rotate(90deg); }
  .rename form.inline { margin: .4rem 0 .6rem; }
  .rename form.inline input { width: auto; flex: 1; text-align: left; }
  /* The same row for a member who cannot rename: no chevron, because nothing
     opens, and no pointer, because nothing happens if they press it. */
  .rename.is-readonly {
    display: flex; align-items: baseline; gap: .75rem;
    min-height: var(--tap); padding: .1rem 0;
  }
  /* The cupboard's own screen: a short list of staples, each with the one
     thing there is to do to it. */
  .pantry li {
    display: flex; align-items: baseline; gap: .75rem;
    min-height: var(--tap); padding: .5rem 0;
    border-bottom: 1px solid var(--edge);
  }
  .pantry .ingredient-name { flex: 1; }
  .pantry form { margin: 0; }
  /* The move between the two shopping sections, inside the opened row. */
  .pantry-action { margin: .2rem 0 .6rem; }
  .pantry-action button { width: 100%; }
  .shopping-section { margin: 1.6rem 0 .2rem; font-size: 1.05rem; }
  .shopping-section + .empty { margin-top: 0; }
  button.danger {
    color: var(--accent-fg); background: var(--warn);
    border-color: var(--warn); font-weight: 600;
  }
  .plain li { padding: .35rem 0; color: var(--muted); }
  form.confirm { display: block; margin: 1.5rem 0 1rem; }
  .nothing { padding: 1.5rem 0; text-align: center; }
  .nothing .empty { margin: 0 0 1rem; }
  .recipe-delete { margin-top: 2.5rem; font-size: .9rem; }
  .recipe-delete a { color: var(--warn); }
  .review-title { margin: 0; font-size: 1.25rem; font-weight: 600; }
  .creating {
    padding: .6rem .8rem; margin: 1rem 0;
    font-size: .9rem; color: var(--muted);
    background: var(--surface); border-radius: var(--radius);
  }
  .line-note {
    display: block; margin-top: .15rem;
    color: var(--warn); font-size: .8rem;
  }
  /* The picture found on an imported page, shown before it is saved (#205).
     Contained rather than cropped: the point of showing it is to let somebody
     see that it is the dish and not the site's masthead, and a crop is exactly
     what would hide that. */
  .found-image { margin: 1.2rem 0 0; }
  .found-image img {
    display: block; width: 100%;
    max-height: 40vw; object-fit: contain;
    background: var(--surface); border-radius: var(--radius);
  }
  .found-image .tick {
    display: flex; align-items: center; gap: .5rem;
    min-height: var(--tap);
    color: var(--muted); font-size: .9rem;
  }
  .found-image .tick input { width: auto; margin: 0; }
  .save-draft { width: 100%; margin: 1.5rem 0 .5rem; }
  .edit-draft > summary {
    display: inline-flex; align-items: center;
    min-height: var(--tap); cursor: pointer;
    color: var(--muted); font-size: .9rem;
  }
  .needs-answer ul.plain { margin-top: .35rem; font-weight: 400; }
  /* The doubts box is a "look at this", not a "well done" — so it borrows the
     warning colour rather than the accent every other panel uses. */
  .needs-answer.is-doubt { border-color: var(--warn); }
  .needs-answer.is-doubt strong { color: var(--warn); }
  .needs-answer {
    display: flex; align-items: flex-start; gap: .5rem;
    padding: .7rem .8rem; margin: 0 0 1rem;
    font-size: .9rem; font-weight: 600;
    background: var(--surface); border: 1px solid var(--accent);
    border-left-width: 4px; border-radius: var(--radius);
  }
  .line-more { margin-top: .5rem; }
  .line-more > summary {
    display: inline-flex; align-items: center;
    min-height: var(--tap-compact); cursor: pointer;
    color: var(--muted); font-size: .8rem;
  }
  .more-fields {
    display: grid; grid-template-columns: 1fr 1fr; gap: .5rem;
    margin: .5rem 0;
  }
  .more-field label {
    display: block; margin-bottom: .15rem;
    color: var(--muted); font-size: .75rem;
  }
  .more-field input { min-height: var(--tap-compact); }
  .add-lines { margin: .5rem 0 1rem; }
  .add-lines > summary {
    display: inline-flex; align-items: center;
    min-height: var(--tap); cursor: pointer;
    color: var(--accent); font-size: .9rem; font-weight: 600;
  }
  .amounts .qty { flex: 0 0 6rem; }

  /* The editor's compact ingredient row (issue #128): what it is, how much of
     it, and away with it, all on one line. The picker takes the slack because
     it is the field holding a word rather than a number. */
  .line.is-compact { padding: .5rem 0; }
  .line-main { display: flex; flex-wrap: wrap; gap: .4rem; align-items: center; }
  .line-main select { flex: 1 1 9rem; min-width: 0; margin: 0; }
  .line-main .qty { flex: 0 0 5rem; margin: 0; }
  .line-main .remove { flex: 0 0 auto; }
  .add-line { margin: .75rem 0 1rem; }
  .add-line button {
    min-height: var(--tap); width: 100%;
    color: var(--accent); background: var(--surface);
    border: 1px dashed var(--accent); font-weight: 600;
  }

  /* Off screen, not display:none — a submit button the browser has thrown away
     cannot be the one that answers Enter, which is this button's whole job. */
  .default-submit {
    position: absolute; width: 1px; height: 1px; min-height: 0;
    padding: 0; margin: -1px; border: 0; overflow: hidden; clip: rect(0 0 0 0);
  }

  /* The editor's save bar (issue #184). It sticks to the bottom of the screen,
     clear of the fixed tab strip, so Tallenna is one tap away wherever you are
     in a long form; once the end of the form scrolls into view the bar simply
     sits there. A browser without position:sticky gets exactly the old
     behaviour, which is why this needs no script. */
  .editor-actions {
    position: sticky; z-index: 1;
    bottom: calc(var(--tabs-height) + env(safe-area-inset-bottom));
    display: flex; gap: .5rem;
    padding: .6rem 0; margin-top: 1rem;
    background: var(--bg); border-top: 1px solid var(--edge);
  }
  .editor-actions button { flex: 1; }

  .line-conflicts {
    padding: .7rem .8rem; margin: 0 0 1rem;
    background: var(--surface); border: 1px solid var(--accent);
    border-left-width: 4px; border-radius: var(--radius);
  }
  .line-conflicts h3 { margin: 0 0 .4rem; font-size: 1rem; }
  .line-conflicts p { margin: .4rem 0; font-size: .9rem; }
  /* Each entry says "Vaihe 3" itself, so a list marker would number the
     numbers. */
  .mention-steps { margin: .3rem 0 .6rem; padding-left: 0; list-style: none; }
  .mention-steps .step-number {
    display: block; color: var(--muted); font-size: .75rem;
  }
  .mention-steps .step-text { display: block; font-size: .9rem; }
  .force-remove { display: flex; flex-wrap: wrap; gap: .5rem;
    align-items: center; }
  .force-remove .empty { flex: 1 1 12rem; font-size: .75rem; }
  .badge.is-decision {
    color: var(--accent-fg); background: var(--accent); border-color: var(--accent);
    font-weight: 600;
  }
  /* A height in CSS rather than an aspect-ratio: the same band is there whether
     the recipe has a picture or not, so nothing shifts as you scroll, and old
     Safari — which has no aspect-ratio — gets the same layout as everything
     else. */
  .recipe-image {
    height: 11rem; margin: 0 0 1rem; overflow: hidden;
    border-radius: var(--radius); background: var(--surface);
  }
  .recipe-image img { display: block; width: 100%; height: 100%; object-fit: cover; }
  .recipe-image.is-empty { border: 1px dashed var(--edge); }
  /* The main picture on a screen that is about one dish. The generator makes
     square pictures with the food deliberately inside the frame, so cropping
     one into an 11rem strip throws most of it away (issue #116). This band is
     4:3 of the phone's own width — taller than the strip, still not the whole
     screen — and the picture is contained inside it rather than cropped to
     fill it. A vw height with a max-height rather than an aspect-ratio, so
     there is one rule and no fallback branch for old Safari. The cap stops a
     portrait
     upload making the page absurdly tall. Any letterboxing shows the surface
     colour the band already has, so it reads as a frame. */
  .recipe-image.is-hero { height: 75vw; max-height: 22rem; }
  .recipe-image.is-hero img { object-fit: contain; object-position: center; }
  /* A recipe with no picture keeps the short band: an empty dashed box has
     nothing to show, so there is no reason to give it more of the screen. */
  .recipe-image.is-hero.is-empty { height: 11rem; }
  /* The same picture at row size. It never flexes, so a long title cannot
     squeeze it, and it crops rather than squashing: a recipe photograph is not
     a shape we get to choose. */
  .recipe-image.is-thumb {
    flex: none; width: 3rem; height: 3rem; margin: 0; align-self: center;
  }
  .recipe-image-editor { margin: 0 0 1.5rem; }
  .recipe-image-editor h2 { margin: 0 0 .5rem; }
  /* ------------------------------------------------------ the shopping list */

  /* Which meals are in the list, folded away: the list itself is what somebody
     opened the screen to read. */
  .shopping-picker { margin: 0 0 1.25rem; padding: 0 .8rem;
    background: var(--surface); border: 1px solid var(--edge);
    border-radius: var(--radius); }
  .shopping-picker > summary {
    display: flex; align-items: center; gap: .5rem;
    min-height: var(--tap); cursor: pointer; font-weight: 600;
  }
  .shopping-picker > summary .meta { margin-left: auto; font-weight: 400; }
  .shopping-picker form.stacked { margin: 0; padding-bottom: .8rem; }
  .shopping-picker button { width: 100%; }
  /* form.stacked's global "label { display: block }" would stack the tick box
     above its own meal, so this has to be scoped to the row, exactly as the
     admin image list found out. */
  .shopping-meals li label {
    display: flex; align-items: center; gap: .7rem;
    min-height: var(--tap); padding: .35rem 0; margin: 0;
    font-weight: 400; cursor: pointer;
    border-top: 1px solid var(--edge);
  }
  .shopping-meals li input { flex: none; min-height: 0;
    width: 1.15rem; height: 1.15rem; accent-color: var(--accent); }
  .shopping-meal { display: flex; flex-direction: column; min-width: 0;
    overflow-wrap: break-word; }
  .shopping-meal-title { font-weight: 600; }

  .shopping-list > li { border-bottom: 1px solid var(--edge); }
  /* Every form that has to leave the page comes back to #aines-<id>, and the
     header is sticky — without this the row it returns to would land under it
     and read as the wrong row (#200). */
  .shopping-list > li[id] { scroll-margin-top: 4.5rem; }
  .shopping-item > summary {
    display: flex; align-items: baseline; gap: .75rem;
    min-height: var(--tap); padding: .35rem 0; cursor: pointer;
    list-style: none;
  }
  .shopping-item > summary::-webkit-details-marker { display: none; }
  /* Nothing else says these rows open, the same problem the ingredient list
     solved with a chevron. */
  .shopping-item > summary::after {
    content: "›"; color: var(--muted); font-size: 1.1rem; line-height: 1;
    transition: transform .1s;
  }
  .shopping-item[open] > summary::after { transform: rotate(90deg); }
  /* The chosen product's picture, on the row itself (#159). It is smaller than
     the row's own minimum height, and the slot collapses when there is no
     picture, so no row grows and no row is left holding an empty box. */
  .shopping-thumb { flex: none; align-self: center; line-height: 0; }
  .shopping-thumb:empty { display: none; }
  .shopping-thumb img {
    width: 1.6rem; height: 1.6rem; object-fit: contain; background: #fff;
    border: 1px solid var(--edge); border-radius: .25rem;
  }
  .shopping-name { flex: 1; min-width: 0; overflow-wrap: break-word; }
  .shopping-item[open] .shopping-name { font-weight: 600; }
  .shopping-total { font-weight: 600; font-variant-numeric: tabular-nums;
    text-align: right; }
  /* An amount the recipe never gave a number to is not a quantity, so it does
     not get a quantity's weight. */
  .shopping-total.is-unstated { font-weight: 400; color: var(--muted);
    font-size: .85rem; }
  .shopping-from { margin: 0 0 .6rem; padding-left: .7rem;
    border-left: 3px solid var(--edge); }
  .shopping-from li { display: flex; flex-wrap: wrap; align-items: baseline;
    gap: .5rem; padding: .3rem 0; font-size: .9rem; }
  .shopping-from-what { flex: 1; min-width: 0; overflow-wrap: break-word; }
  .shopping-from-amount { font-variant-numeric: tabular-nums; }
  .shopping-from .source { flex-basis: 100%; margin: 0; }

  .s-shopping-send {
    margin: 0 0 1rem; padding: .8rem;
    background: var(--surface); border: 1px solid var(--accent);
    border-radius: var(--radius);
  }
  .s-shopping-send h2 { margin: 0; }
  .s-shopping-send p { margin: .25rem 0 .7rem; color: var(--muted); }
  .s-shopping-send button { width: 100%; }
  .shopping-sent {
    padding: .7rem .8rem; margin: 0 0 1rem;
    background: var(--surface); border: 1px solid var(--accent);
    border-radius: var(--radius);
  }
  .s-shopping-product {
    display: flex; flex-wrap: wrap; align-items: center; gap: .7rem;
    margin: .6rem 0; padding: .65rem;
    background: var(--surface); border-radius: var(--radius);
  }
  /* One row may buy more than one packet since #161, so the summary stacks
     what it is buying and the button column stays where it was. */
  .s-shopping-product-summary {
    display: flex; flex: 1 1 13rem; flex-direction: column; gap: .4rem;
    min-width: 0;
  }
  .s-shopping-product-one {
    display: flex; align-items: center; gap: .7rem; min-width: 0;
  }
  .s-product-scope, .s-package-total { font-size: .85rem; }
  .s-shopping-product-one img, .s-product-results img {
    flex: none; object-fit: contain; background: #fff;
    border: 1px solid var(--edge); border-radius: .35rem;
  }
  /* The sizes have to be said here, not left to the width and height
     attributes: the shell's own img rule sets height to auto, which outranks the height
     attribute, so a tall carton photograph was drawing itself several hundred
     pixels high, and object-fit had no box to fit it inside. That
     is what made a chosen product tower over the row it replaced (#200), and
     it is why .shopping-thumb img — the one that always said its size in CSS
     — was the only picture on this screen behaving. */
  .s-shopping-product-one img { width: 2.5rem; height: 2.5rem; }
  .s-product-results img { width: 5rem; height: 5rem; }
  .s-shopping-product-copy, .s-product-result-copy {
    display: flex; flex: 1 1 12rem; flex-direction: column; min-width: 0;
    overflow-wrap: break-word;
  }
  /* Held to one line each, so "Teksti" and a chosen product are the same two
     lines tall and the swap does not move the rows underneath (#200). The
     picker's own results are free to wrap — they are inside a fixed sheet. */
  .s-shopping-product-copy > * {
    overflow: hidden; white-space: nowrap; text-overflow: ellipsis;
  }
  /* The product takes the whole width and its buttons drop below it. Squeezed
     beside them the name ellipsised away the very thing somebody is shopping
     for — "Kotimaista rasvaton ma…" is not a carton you can find (#200). */
  .s-shopping-product-body {
    display: flex; flex: 1 1 100%; min-width: 0; min-height: 2.6rem;
  }
  /* Nothing to add a second package size to yet. The button keeps its place
     rather than appearing the moment a product is chosen, so the rows below it
     never move (#200) — which only works if it also reads as unavailable. */
  .s-shopping-product button[disabled] {
    color: var(--muted); cursor: default;
    background: transparent; border-style: dashed;
  }

  /* The package sizes an ingredient knows beyond the one it is buying. Only
     drawn where there is more than one, so an ordinary row shows none of it. */
  .s-product-sizes {
    flex-basis: 100%; display: grid; gap: .3rem;
    margin: .2rem 0 0; padding-top: .5rem;
    border-top: 1px solid var(--edge);
  }
  .s-product-sizes > li {
    display: flex; align-items: center; gap: .5rem; font-size: .85rem;
  }
  .s-product-size-name { flex: 1 1 8rem; min-width: 0; overflow-wrap: break-word; }
  .s-product-sizes form { margin-left: auto; }
  .s-product-sizes button { min-height: var(--tap-compact); }

  /* How far a choice reaches — asked once above the results, not per product. */
  .s-product-scope-choice {
    display: block; margin: 0 0 .7rem; font-size: .85rem; color: var(--muted);
  }
  .s-product-scope-choice select { width: 100%; }
  .s-product-size-entry {
    display: flex; flex-wrap: wrap; align-items: flex-end; gap: .4rem;
    font-size: .8rem; color: var(--muted);
  }
  .s-product-size-entry input { width: 4.5rem; }

  /* The one loading indicator, shared by everything on this screen that waits
     on the network (#159): a saving row, the send button, and the read of the
     S-ostoslista's current contents. */
  .spinner {
    display: inline-block; flex: none; width: .85rem; height: .85rem;
    margin-right: .4rem; vertical-align: -.1rem;
    border: 2px solid var(--edge); border-top-color: var(--accent);
    border-radius: 50%; animation: spin .7s linear infinite;
  }
  @keyframes spin { to { transform: rotate(360deg); } }
  @media (prefers-reduced-motion: reduce) { .spinner { animation: none; } }

  /* The row's one busy line. The server draws it on every mapped-capable row
     and the island only fills and empties it, so a save starting or finishing
     never changes a row's height (#200) — hence the reserved min-height. */
  /* The reserved height and the filled height have to be the same number, or
     the slot defeats itself: at the shell's 1.55 line-height a .85rem line is
     taller than a bare min-height, so starting a save would still grow the
     row. Both are pinned to the same value instead. */
  .s-status { flex-basis: 100%; min-height: 1.5rem; line-height: 1.5rem;
    margin: 0; color: var(--muted); font-size: .85rem; }

  /* A refusal is a fixed strip above the tab bar, not a paragraph pushed into
     the list. It is the one place on this screen that says a save failed, and
     it says it without moving what the member was reading (#200). */
  .s-toast {
    position: fixed; left: .6rem; right: .6rem; z-index: 11;
    bottom: calc(var(--tabs-height) + env(safe-area-inset-bottom) + .6rem);
    display: flex; flex-wrap: wrap; align-items: center; gap: .5rem;
    padding: .6rem .7rem;
    color: var(--warn); font-size: .85rem;
    background: var(--bg); border: 1px solid var(--warn);
    border-radius: var(--radius);
    box-shadow: 0 .4rem 1.2rem light-dark(rgba(0,0,0,.18), rgba(0,0,0,.5));
  }
  .s-toast-text { flex: 1 1 12rem; min-width: 0; overflow-wrap: break-word; }
  .s-toast button { min-height: var(--tap-compact); }

  /* The product picker: one per screen, fixed to the bottom of the viewport.
     Being outside the list's flow is the whole point — opening and closing it
     moves no row, which is what walking a long list needs (#200). */
  .s-sheet { position: fixed; top: 0; right: 0; bottom: 0; left: 0; z-index: 10; }
  .s-sheet-backdrop {
    position: absolute; top: 0; right: 0; bottom: 0; left: 0;
    background: rgba(0,0,0,.45);
  }
  .s-sheet-panel {
    position: absolute; left: 0; right: 0; bottom: 0;
    max-height: 85vh; overflow-y: auto; overscroll-behavior: contain;
    padding: .8rem .8rem calc(.8rem + env(safe-area-inset-bottom));
    background: var(--bg);
    border-top: 1px solid var(--edge);
    border-radius: var(--radius) var(--radius) 0 0;
    box-shadow: 0 -.4rem 1.4rem light-dark(rgba(0,0,0,.22), rgba(0,0,0,.6));
  }
  /* On a wider screen it is a centred dialog rather than a full-width sheet;
     the flow is the same one, and nothing about it is phone-only. */
  @media (min-width: 48rem) {
    .s-sheet-panel {
      left: 50%; right: auto; bottom: 5vh; width: 92vw; max-width: 34rem;
      transform: translateX(-50%);
      max-height: 80vh; border: 1px solid var(--edge);
      border-radius: var(--radius);
    }
  }
  /* The heading is the only thing that says which of twenty ingredients this
     search is for, so it stays put while the results scroll under it. */
  .s-sheet-head {
    position: sticky; top: 0; z-index: 1;
    display: flex; align-items: flex-start; gap: .6rem;
    margin: -.8rem -.8rem .6rem; padding: .8rem;
    background: var(--bg); border-bottom: 1px solid var(--edge);
  }
  .s-sheet-titles { flex: 1; min-width: 0; }
  .s-sheet-name { margin: 0; font-size: 1.05rem; overflow-wrap: break-word; }
  .s-sheet-sub { margin: .15rem 0 0; color: var(--muted); font-size: .85rem;
    overflow-wrap: break-word; }
  .s-sheet-close { flex: 0 0 auto; min-height: var(--tap-compact); }
  .s-sheet-scope[hidden] { display: none; }

  .s-product-search { display: flex; align-items: flex-end; gap: .5rem;
    margin-bottom: .6rem; }
  .s-product-search label { flex: 1; min-width: 0; margin: 0;
    font-size: .85rem; color: var(--muted); }
  .s-product-search input { width: 100%; }
  .s-product-search button { flex: 0 0 auto; }
  .s-product-panel-state { margin: 0 0 .6rem; color: var(--muted);
    font-size: .9rem; }

  .s-current { margin: 1.4rem 0 .8rem; border-top: 1px solid var(--edge);
    padding-top: .6rem; }
  .s-current h3 { margin: 0 0 .3rem; font-size: .95rem; }
  .s-current-state { display: flex; align-items: center; gap: .5rem;
    margin: 0; color: var(--muted); font-size: .85rem; }
  .s-current-state button { min-height: var(--tap-compact); }
  .s-current-items li {
    display: flex; align-items: baseline; gap: .6rem;
    padding: .3rem 0; font-size: .9rem;
    border-top: 1px solid var(--edge);
  }
  .s-current-name { flex: 1; min-width: 0; overflow-wrap: break-word; }
  .product-search-form { margin-bottom: 1rem; }
  .s-product-results { display: grid; gap: .7rem; }
  .s-product-results > li {
    display: flex; flex-wrap: wrap; align-items: center; gap: .75rem;
    padding: .75rem; background: var(--surface);
    border: 1px solid var(--edge); border-radius: var(--radius);
  }
  .s-product-results form { flex: 0 0 auto; margin-left: auto; }
  .s-product-results > li > button { flex: 0 0 auto; margin-left: auto; }

  .refused {
    padding: .7rem .8rem; margin: 0 0 1rem;
    color: var(--warn); font-size: .9rem;
    background: var(--surface); border: 1px solid var(--warn);
    border-radius: var(--radius);
  }

  @media (min-width: 48rem) {
    .tabs { justify-content: center; }
    .tabs a { flex: 0 1 9rem; }
  }
`;

/**
 * The multiplier control, wherever a household picks one (#165).
 *
 * Four one-tap choices and a box for anything else, because 0,5× to 2× is what
 * a kitchen reaches for and the domain still accepts any positive number. Each
 * chip is its own submit button rather than a radio, so choosing one is a
 * single tap on a phone and the screen needs no script to work — the standing
 * rule for anything on the planning path (see docs/codebase/screens.md).
 *
 * The chips post `preset` and the box posts `multiplier`, which is what keeps
 * them apart: a browser sends a submit button's value only for the button that
 * was pressed, so a handler reading `preset` first knows a chip was tapped and
 * otherwise reads whatever was typed.
 *
 * `current` marks the chip that is already in force. `typed` is what to put in
 * the box, which on a refusal is what the member wrote rather than what is
 * stored — this app never throws away somebody's input to show them an error.
 */
export function multiplierField(
  options: {
    current: number | null;
    typed: string;
    label: string;
    describedBy?: string;
    submit: string;
  },
): Raw {
  return html`<div class="multiplier-choice" role="group" aria-label="${options.label}">
    ${MULTIPLIER_CHOICES.map(
      (choice) => html`<button
        type="submit"
        name="preset"
        value="${String(choice)}"
        class="${choice === options.current ? "is-current" : ""}"
      >${formatMultiplier(choice)}</button>`,
    )}
    <input
      name="multiplier"
      inputmode="decimal"
      value="${options.typed}"
      size="4"
      aria-label="Muu kerroin"
      ${options.describedBy === undefined
        ? ""
        : raw(`aria-describedby="${escape(options.describedBy)}"`)}
    />
    <button type="submit">${options.submit}</button>
  </div>`;
}

/**
 * Which bottom-tab destination a screen belongs to. `signed-out` is the shell
 * for a browser with nowhere to navigate yet — no tabs, no sign-out.
 */
export type Shell =
  | "week"
  | "shopping"
  | "recipes"
  | "intake"
  | "ingredients"
  | "signed-out";

const TABS: { shell: Shell; href: string; label: string; icon: string }[] = [
  {
    shell: "week",
    href: "/",
    label: "Viikko",
    icon: `<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M8 3v4M16 3v4M3 10h18"/>`,
  },
  {
    // Next to the week on purpose: the list is a reading of the week, and the
    // shop is the next thing that happens after the week is planned.
    shell: "shopping",
    href: "/ostoslista",
    label: "Ostokset",
    // A trolley, not a basket: the Ainekset tab is already a jar-shaped
    // container, and two containers side by side read as the same tab twice.
    icon: `<circle cx="9.5" cy="20" r="1.4"/><circle cx="17" cy="20" r="1.4"/><path d="M3 4h2l2.5 10.2a1.5 1.5 0 0 0 1.5 1.1h7.6a1.5 1.5 0 0 0 1.5-1.2L20 8H6"/>`,
  },
  {
    shell: "recipes",
    href: "/recipes",
    label: "Reseptit",
    icon: `<path d="M4 4.5A1.5 1.5 0 0 1 5.5 3H19v18H5.5A1.5 1.5 0 0 1 4 19.5z"/><path d="M8 8h7M8 12h7"/>`,
  },
  {
    shell: "intake",
    href: "/intake",
    label: "Lisää",
    icon: `<circle cx="12" cy="12" r="9"/><path d="M12 8v8M8 12h8"/>`,
  },
  {
    shell: "ingredients",
    href: "/ingredients",
    label: "Ainekset",
    icon: `<path d="M5 9h14l-1.2 10.2a2 2 0 0 1-2 1.8H8.2a2 2 0 0 1-2-1.8z"/><path d="M9 9a3 3 0 0 1 6 0"/>`,
  },
];

function icon(paths: string): Raw {
  return raw(
    `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`,
  );
}

function tabs(current: Shell): Raw {
  return html`<nav class="tabs" aria-label="Päävalikko">
  ${TABS.map(
    (tab) =>
      html`<a href="${tab.href}"${tab.shell === current
        ? raw(' aria-current="page"')
        : ""}>${icon(tab.icon)}<span>${tab.label}</span></a>`,
  )}
</nav>`;
}

/**
 * Who is looking at the screen. The shell asks one question about them — are
 * they an admin — and that decides whether the account menu offers the admin
 * panel. Nothing else about the viewer reaches this file, and the menu entry is
 * courtesy: `/admin` refuses an ordinary member whether or not they saw a link.
 *
 * `Member` satisfies this by shape, so every screen passes the member it
 * already has. A screen with no viewer — the sign-in wall and its refusals —
 * passes null, which is also the shell that renders no account button at all.
 */
export interface Viewer {
  isAdmin: boolean;
}

/**
 * The account affordance: small, out of the way, and the way out of the app —
 * and, for an admin, the one way in to the admin panel. It lives here rather
 * than on the week screen so that every screen offers it, which is what #106
 * asked for and what #94 deliberately deferred.
 */
function accountMenu(viewer: Viewer | null): Raw {
  return html`<details class="account">
  <summary role="button" aria-label="Tili">
    ${icon(`<circle cx="12" cy="8" r="3.5"/><path d="M5 20a7 7 0 0 1 14 0"/>`)}
  </summary>
  <div class="account-menu">
    ${viewer?.isAdmin ? html`<a href="/admin">Ylläpito</a>` : ""}
    <form method="post" action="/auth/signout">
      <button type="submit" class="quiet">Kirjaudu ulos</button>
    </form>
  </div>
</details>`;
}

export function page(
  title: string,
  body: Raw,
  shell: Shell,
  viewer: Viewer | null,
  status = 200,
): Response {
  const document = html`${pageHead(title, shell, viewer)}
${body}
${pageTail(shell)}`;

  return new Response(document.value, {
    status,
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

/**
 * A screen sent in pieces, for the one thing on the reading and editing paths
 * that has to wait on a language model (#208).
 *
 * Cloudflare closes a proxied request that goes ~125 s without a byte, which is
 * why intake streams at all (`src/intake.ts`). A prompt edit is the same shape
 * of wait but not the same shape of work: nothing is written until the member
 * saves, so it does not need a background job's durability — it needs the
 * connection to stay open while the member watches. Sending the shell first and
 * the answer when it arrives does that with no script, which is the standing
 * rule on the editing path.
 *
 * `render` may emit as much as it likes before returning the body it ends on.
 * The status is always 200: the headers are gone by the time anything can be
 * refused, so a refusal is written into the body instead.
 */
export function streamingPage(
  title: string,
  shell: Shell,
  viewer: Viewer | null,
  render: (emit: (chunk: Raw) => void) => Promise<Raw>,
): Response {
  const encoder = new TextEncoder();

  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      const emit = (chunk: Raw) =>
        controller.enqueue(encoder.encode(chunk.value));

      emit(pageHead(title, shell, viewer));
      try {
        emit(await render(emit));
      } catch (error) {
        console.log(JSON.stringify({
          event: "streamed_page.failed",
          detail: String((error as Error)?.message ?? error),
        }));
        emit(html`<p class="refused">Jokin meni pieleen. Yritä uudelleen.</p>`);
      }
      emit(pageTail(shell));
      controller.close();
    },
  });

  return new Response(body, {
    status: 200,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

function pageHead(title: string, shell: Shell, viewer: Viewer | null): Raw {
  const signedIn = shell !== "signed-out";

  return html`<!doctype html>
<html lang="fi">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="${THEME_COLOR}">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="default">
<meta name="apple-mobile-web-app-title" content="Ruokalista">
<link rel="manifest" href="/manifest.webmanifest">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">
<title>${title} · Ruokalista</title>
<style>${raw(STYLES)}</style>
</head>
<body class="${signedIn ? "has-tabs" : "signed-out"}">
${signedIn
    ? html`<header class="topbar">
  <a class="wordmark" href="/">Ruokalista</a>
  ${accountMenu(viewer)}
</header>`
    : ""}
<main>`;
}

function pageTail(shell: Shell): Raw {
  const signedIn = shell !== "signed-out";

  return html`</main>
${signedIn ? tabs(shell) : ""}
<script>${raw(PWA_CLIENT_SCRIPT)}</script>
</body>
</html>`;
}
