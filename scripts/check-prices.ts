// The site is the source of truth for Super Quant-Room prices and lifetimes. This reads the `PRICE`
// and `AI_PRICE` tables from the site's room page and checks the API charges exactly the same.
//
//   pnpm check:prices                       # the live page, https://usepoof.chat/room/
//   pnpm check:prices ../site/room/index.html
import { readFile } from "node:fs/promises";
import {
  AI_PRICE_MICROS,
  PRICE_MICROS,
  SUPER_LIFETIMES,
  formatUsd,
  priceMicros,
} from "../packages/protocol/src/pay.ts";

const source = process.argv[2] ?? "https://usepoof.chat/room/";
const html = source.startsWith("http")
  ? await (await fetch(source)).text()
  : await readFile(source, "utf8");

const price =
  /const PRICE = \{3600:\{base:([\d.]+), extra:([\d.]+)\}, 86400:\{base:([\d.]+), extra:([\d.]+)\}\}/.exec(
    html,
  );
const ai = /const AI_PRICE = \{3600:(\d+(?:\.\d+)?), 86400:(\d+(?:\.\d+)?)\}/.exec(html);
if (!price || !ai) {
  console.error(
    `Couldn't find PRICE / AI_PRICE in ${source}. The page changed: update this script and pay.ts together.`,
  );
  process.exit(1);
}
const micros = (usd: string) => Math.round(Number(usd) * 1_000_000);
const site = {
  3600: { base: micros(price[1]!), extraPerson: micros(price[2]!), ai: micros(ai[1]!) },
  86400: { base: micros(price[3]!), extraPerson: micros(price[4]!), ai: micros(ai[2]!) },
};

let ok = true;
for (const lifetime of SUPER_LIFETIMES) {
  const ours = { ...PRICE_MICROS[lifetime], ai: AI_PRICE_MICROS[lifetime] };
  if (JSON.stringify(ours) !== JSON.stringify(site[lifetime])) {
    ok = false;
    console.error(
      `${lifetime}s: site ${JSON.stringify(site[lifetime])}, API ${JSON.stringify(ours)}`,
    );
  }
}
if (!ok) process.exit(1);
const sample = { lifetime: 3600, people: 4, ai: false } as const;
console.log(`Prices match ${source} (e.g. 4 people, 1 hour: ${formatUsd(priceMicros(sample))}).`);
