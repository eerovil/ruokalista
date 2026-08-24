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

const STYLES = `
  :root { color-scheme: light dark; --edge: color-mix(in srgb, currentColor 15%, transparent); }
  * { box-sizing: border-box; }
  body {
    margin: 0 auto; padding: 1rem; max-width: 40rem;
    font: 1rem/1.5 system-ui, sans-serif;
  }
  h1 { font-size: 1.4rem; margin: 0 0 1rem; }
  h2 { font-size: 1.1rem; margin: 1.5rem 0 .5rem; }
  a { color: inherit; }
  nav { display: flex; gap: 1rem; margin-bottom: 1.5rem; font-size: .9rem; }
  ul { list-style: none; margin: 0; padding: 0; }
  .recipes li { border-bottom: 1px solid var(--edge); }
  .recipes a { display: block; padding: .75rem 0; text-decoration: none; }
  .recipes .meta, .yield, .empty { opacity: .65; font-size: .85rem; }
  .lines li { padding: .4rem 0; border-bottom: 1px solid var(--edge); }
  .amount { font-variant-numeric: tabular-nums; }
  .source { display: block; opacity: .55; font-size: .8rem; }
  ol { padding-left: 1.2rem; }
  ol li { margin-bottom: .5rem; }
  form { display: flex; gap: .5rem; margin-bottom: 1rem; }
  input[type=search] { flex: 1; padding: .5rem; font: inherit;
    border: 1px solid var(--edge); border-radius: .3rem; background: transparent; }
  button { padding: .5rem .8rem; font: inherit; }
  .source-text { white-space: pre-wrap; opacity: .7; font-size: .85rem; }
`;

export function page(title: string, body: Raw, status = 200): Response {
  const document = html`<!doctype html>
<html lang="fi">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title} · Ruokalista</title>
<style>${raw(STYLES)}</style>
</head>
<body>
<nav><a href="/recipes">Reseptit</a></nav>
${body}
</body>
</html>`;

  return new Response(document.value, {
    status,
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}
