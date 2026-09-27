/**
 * One-off corpus repair.
 *
 * Two data-integrity bugs were found by src/quality/health.ts and are fixed at the
 * source (src/index/core.ts), but the existing corpus already contains the bad rows.
 * This recomputes URLs from owner/repo and drops records whose Pages site
 * cannot be resolved at all, then forces a re-probe of anything whose URL
 * changed (its old liveness verdict referred to a different address).
 *
 * Safe to re-run: it is idempotent for already-correct records.
 */

import { readFileSync } from "node:fs";
import { PATHS } from "../paths";
import { isValidPagesUrl, pagesUrlFor, decodeEntities } from "./core";

const DB = PATHS.corpus;
const db = JSON.parse(readFileSync(DB, "utf8")) as { records: Record<string, any> };

let urlFixed = 0;
let dropped = 0;
let needsReprobe = 0;
let entitiesFixed = 0;
const examples: string[] = [];
const entityExamples: string[] = [];

for (const [key, rec] of Object.entries(db.records)) {
  const correct = pagesUrlFor(rec.owner, rec.name, rec.homepage);
  if (correct !== rec.url) {
    if (examples.length < 6) {
      examples.push(`  ${key}\n     old: ${rec.url}\n     new: ${correct}`);
    }
    rec.url = correct;
    urlFixed++;
    // The previous probe result described a different address.
    rec.liveness = "unknown";
    rec.http_status = null;
    rec.last_checked = null;
    rec.last_ok = null;
    rec.fails = 0;
    rec.next_check = null;
    needsReprobe++;
  }
  if (!isValidPagesUrl(rec.url)) {
    delete db.records[key];
    dropped++;
    continue;
  }

  // Scrape-sourced metadata can carry raw HTML entities, which render as
  // literal "&#x27;" in the UI and in the generated <title>/<meta>.
  for (const field of ["title", "page_description", "description"] as const) {
    const before = rec[field];
    if (typeof before !== "string" || !before.includes("&")) continue;
    const after = decodeEntities(before);
    if (after !== before) {
      if (entityExamples.length < 5) {
        entityExamples.push(`     ${before.slice(0, 60)}\n  ->  ${after.slice(0, 60)}`);
      }
      rec[field] = after;
      entitiesFixed++;
    }
  }
}

await Bun.write(DB, JSON.stringify(db, null, 2));

console.log("=== corpus repair ===");
console.log(`  URLs corrected:  ${urlFixed}`);
console.log(`  records dropped: ${dropped} (unresolvable as a github.io site)`);
console.log(`  reset to unknown: ${needsReprobe} (will be re-probed)`);
console.log(`  entities decoded: ${entitiesFixed}`);
if (entityExamples.length) {
  console.log("\n  entity examples:");
  for (const e of entityExamples) console.log(e);
}
if (examples.length) {
  console.log("\n  examples:");
  for (const e of examples) console.log(e);
}

// Verify post-conditions.
const all = Object.values(db.records);
const bad = all.filter((r) => !isValidPagesUrl(r.url));
const urls = all.map((r) => r.url.replace(/\/+$/, "").toLowerCase());
const dupes = urls.length - new Set(urls).size;
console.log(`\n  remaining invalid URLs: ${bad.length}`);
console.log(`  duplicate URLs in corpus: ${dupes} (collapsed at publish time)`);
console.log(`  corpus size: ${all.length}`);
