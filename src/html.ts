/**
 * The one HTML shell. Server-rendered, mobile-first — a week gets planned at the
 * kitchen table and a recipe gets read at the hob.
 *
 * `html` is a tagged template that escapes every interpolated value. To put
 * already-built markup in, wrap it in `raw()`; that is the only way past the
 * escaping, so it is also the only thing to look at when reviewing for XSS.
 */

export class Raw {
  constructor(readonly value: string) {}
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
    margin: 0 auto; padding: .5rem 1rem;
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
  .recipes a { display: flex; flex-direction: column; justify-content: center;
    min-height: var(--tap); padding: .75rem 0; text-decoration: none; }
  .recipes .meta, .yield, .empty { color: var(--muted); font-size: .85rem; }
  .lines li { padding: .55rem 0; font-size: 1.05rem; border-bottom: 1px solid var(--edge); }
  .amount { font-weight: 600; font-variant-numeric: tabular-nums; }
  .source { display: block; margin-top: .1rem; color: var(--muted); font-size: .8rem; }
  .source-text { white-space: pre-wrap; color: var(--muted); font-size: .85rem;
    margin: .5rem 0 0; }
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
  .day { margin-bottom: 1.5rem; }
  .day h2 { margin: 0 0 .4rem; font-size: 1rem; text-transform: capitalize; }
  .day.is-today h2 { font-weight: 700; }
  .day.is-today { border-left: 3px solid var(--accent); padding-left: .6rem; }
  .slot { padding: .4rem 0 .6rem; border-top: 1px solid var(--edge); }
  .slot h3 { margin: 0 0 .3rem; }
  .empty-slot, .add-more { display: inline-flex; align-items: center;
    min-height: var(--tap-compact); font-size: .9rem; color: var(--muted); }
  .entry > a {
    display: flex; align-items: baseline; gap: .5rem;
    min-height: var(--tap); padding: .5rem .6rem;
    text-decoration: none;
    background: var(--surface); border-radius: var(--radius);
  }
  .entries { display: flex; flex-direction: column; gap: .35rem; margin: .1rem 0 .5rem; }
  .entry-title { flex: 1; }
  .entry-portions { color: var(--muted); font-size: .8rem; white-space: nowrap;
    font-variant-numeric: tabular-nums; }
  .entry-when { margin: 0 0 .2rem; text-transform: capitalize; }
  .meta { color: var(--muted); font-size: .85rem; }
  .portions-row { display: flex; gap: .5rem; align-items: center; }
  .portions-row input { width: 5rem; text-align: center; }
  .section { font-size: .85rem; }
  .edit-step { flex-direction: column; align-items: stretch; }
  .part { margin: 1.5rem 0; padding-left: .7rem;
    border-left: 3px solid var(--edge); }
  .part h2 { margin-top: 0; font-size: 1.05rem; }
  .ingredients li { padding: .5rem 0; border-bottom: 1px solid var(--edge); }
  .position { width: 3rem !important; flex: none !important; color: var(--muted); }
  .edit-steps li { display: flex; gap: .4rem; align-items: flex-start; }
  .pick li { padding: .5rem 0; border-bottom: 1px solid var(--edge); }
  .pick-title { flex: 1; }
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
  .badge.is-decision {
    color: var(--accent-fg); background: var(--accent); border-color: var(--accent);
    font-weight: 600;
  }
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
 * Which bottom-tab destination a screen belongs to. `signed-out` is the shell
 * for a browser with nowhere to navigate yet — no tabs, no sign-out.
 */
export type Shell =
  | "week"
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

/** The account affordance: small, out of the way, and the way out of the app. */
const ACCOUNT = html`<details class="account">
  <summary role="button" aria-label="Tili">
    ${icon(`<circle cx="12" cy="8" r="3.5"/><path d="M5 20a7 7 0 0 1 14 0"/>`)}
  </summary>
  <div class="account-menu">
    <form method="post" action="/auth/signout">
      <button type="submit" class="quiet">Kirjaudu ulos</button>
    </form>
  </div>
</details>`;

export function page(
  title: string,
  body: Raw,
  shell: Shell,
  status = 200,
): Response {
  const signedIn = shell !== "signed-out";

  const document = html`<!doctype html>
<html lang="fi">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${title} · Ruokalista</title>
<style>${raw(STYLES)}</style>
</head>
<body class="${signedIn ? "has-tabs" : "signed-out"}">
${signedIn
    ? html`<header class="topbar">
  <a class="wordmark" href="/">Ruokalista</a>
  ${ACCOUNT}
</header>`
    : ""}
<main>
${body}
</main>
${signedIn ? tabs(shell) : ""}
</body>
</html>`;

  return new Response(document.value, {
    status,
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}
