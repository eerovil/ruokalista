interface Env {
  DB: D1Database;
}

function html(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store"
    }
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      const result = await env.DB.prepare("SELECT 1 AS ok").first<{ ok: number }>();
      return Response.json({ ok: result?.ok === 1 });
    }

    if (url.pathname === "/") {
      return html(`<!doctype html>
<html lang="fi">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Ruokalista</title>
</head>
<body>
  <main>
    <h1>Ruokalista</h1>
    <p>Worker toimii. Seuraavaksi rakennetaan varsinainen viikkonäkymä.</p>
  </main>
</body>
</html>`);
    }

    return html("<h1>404</h1><p>Sivua ei löytynyt.</p>", 404);
  }
} satisfies ExportedHandler<Env>;
