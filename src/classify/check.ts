/**
 * M4 — validate the taxonomy against the real corpus before shipping it.
 * Prints the category distribution, uncategorized share, and sample errors.
 */
import { readFileSync } from "node:fs";
import { PATHS } from "../paths";
import { classify, CATEGORIES, CATEGORY_LABELS } from "./taxonomy";

const db = JSON.parse(readFileSync(PATHS.corpus, "utf8")) as {
  records: Record<string, Record>;
};
const alive = Object.values(db.records).filter((r) => r.liveness === "alive");
console.log(`[classify] ${alive.length} alive records\n`);

const counts = new Map<string, number>();
let multi = 0;
let uncategorized = 0;
const uncatSamples: string[] = [];

for (const r of alive) {
  const res = classify(r.topics ?? []);
  if (res.categories.length === 0) {
    uncategorized++;
    if (uncatSamples.length < 12) {
      uncatSamples.push(`  ${r.url}\n      topics: ${(r.topics ?? []).slice(0, 6).join(", ")}`);
    }
  }
  if (res.categories.length > 1) multi++;
  for (const c of res.categories) counts.set(c, (counts.get(c) ?? 0) + 1);
}

console.log("=== category distribution ===");
for (const c of CATEGORIES) {
  const n = counts.get(c) ?? 0;
  const bar = "█".repeat(Math.round((n / alive.length) * 100));
  console.log(
    `  ${CATEGORY_LABELS[c].padEnd(20)} ${String(n).padStart(5)}  ${((n / alive.length) * 100).toFixed(1).padStart(5)}%  ${bar}`,
  );
}

const classified = alive.length - uncategorized;
console.log(`\n  classified at least once: ${classified} (${((classified / alive.length) * 100).toFixed(1)}%)`);
console.log(`  multi-category:            ${multi} (${((multi / alive.length) * 100).toFixed(1)}%)`);
console.log(`  uncategorized:             ${uncategorized} (${((uncategorized / alive.length) * 100).toFixed(1)}%)`);

console.log(`\n=== uncategorized samples (spot-check for false negatives) ===`);
for (const s of uncatSamples) console.log(s);

// Show what a few well-known sites classified as, to eyeball correctness.
console.log(`\n=== spot checks ===`);
for (const needle of ["squidfunk", "iuricode", "react-native", "mkdocs", "recharts"]) {
  const r = alive.find(
    (x) => x && typeof x.o === "string" && (x.o.toLowerCase() === needle || x.u.includes(needle)),
  );
  if (!r) continue;
  const res = classify(r.topics ?? []);
  console.log(
    `  ${r.u}\n     -> ${res.categories.join(", ") || "(uncategorized)"}  [${Object.values(res.evidence).flat().join(", ")}]`,
  );
}
