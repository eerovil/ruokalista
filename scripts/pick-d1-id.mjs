/**
 * Read `wrangler d1 list --json` on stdin and print the uuid of the database
 * with the given name, or nothing when it does not exist.
 *
 *   wrangler d1 list --json | node scripts/pick-d1-id.mjs ruokalista
 *
 * Why not `wrangler d1 info <name>`: that resolves the name through
 * wrangler.jsonc's binding, so before the real id is written there it asks
 * Cloudflare about the placeholder and gets a 7404. `d1 list` reads no config.
 *
 * Why the scanning: wrangler prints a banner, and sometimes warnings containing
 * a `[`, before the JSON. So try to parse from each `[` until one works.
 */

const wanted = process.argv[2];
if (!wanted) {
  console.error("usage: node scripts/pick-d1-id.mjs <database name>");
  process.exit(1);
}

let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => (input += chunk));
process.stdin.on("end", () => {
  const databases = parseFirstArray(stripAnsi(input));
  if (databases === null) process.exit(0);

  const match = databases.find(
    (database) => database && database.name === wanted,
  );
  if (match?.uuid) process.stdout.write(`${match.uuid}\n`);
});

function stripAnsi(text) {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\[[0-9;]*m/g, "");
}

function parseFirstArray(text) {
  for (let i = text.indexOf("["); i !== -1; i = text.indexOf("[", i + 1)) {
    try {
      const value = JSON.parse(text.slice(i));
      if (Array.isArray(value)) return value;
    } catch {
      // Not the start of the payload; keep looking.
    }
  }
  return null;
}
