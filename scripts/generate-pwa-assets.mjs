import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { Resvg } from "@resvg/resvg-js";

const root = fileURLToPath(new URL("../", import.meta.url));
const source = await readFile(`${root}assets/pwa/ruokalista-mark.svg`, "utf8");
const target = `${root}assets/pwa/generated`;
const checking = process.argv.includes("--check");

await mkdir(target, { recursive: true });

for (const [name, size] of [
  ["icon-192.png", 192],
  ["icon-512.png", 512],
  ["icon-maskable-512.png", 512],
  ["apple-touch-icon.png", 180],
]) {
  const image = new Resvg(source, {
    fitTo: { mode: "width", value: size },
  }).render();
  const rendered = image.asPng();
  const path = `${target}/${name}`;
  if (checking) {
    const existing = await readFile(path);
    if (!existing.equals(Buffer.from(rendered))) {
      throw new Error(`${name} is stale; run npm run generate:pwa-assets`);
    }
  } else {
    await writeFile(path, rendered);
  }
}

console.log(
  checking
    ? "Ruokalista PWA icons are current"
    : "Generated Ruokalista PWA icons from assets/pwa/ruokalista-mark.svg",
);
