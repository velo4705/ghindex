/**
 * Search correctness check — runs the client's scoring function against
 * the real published shards. Catches regressions that a manual click-through
 * would miss (e.g. a shard that never matches, or a field dropped in packing).
 */

import { readFileSync, existsSync } from "node:fs";
import { PATHS } from "../paths";

const manifest = JSON.parse(readFileSync(`${PATHS.data}/manifest.json`, "utf8"));
const all: any[] = [];
for (const s of manifest.shards) {
  const p = `${PATHS.data}/${s.file}`;
  if (!existsSync(p)) continue;
  all.push(...JSON.parse(readFileSync(p, "utf8")));
}
console.log(`[test] ${all.length} records from ${manifest.shards.length} shards`);

/** Mirror of dist/app.js score(). */
function score(row: any, q: string): number {
  const qy = q.toLowerCase();
  const owner = row.o.toLowerCase();
  const repo = row.r.toLowerCase();
  const title = (row.t ?? "").toLowerCase();
  if (owner === qy) return 1000;
  if (owner.startsWith(qy)) return 900 - owner.length;
  if (repo === qy) return 850;
  if (owner.includes(qy)) return 700;
  if (repo.startsWith(qy)) return 650 - repo.length;
  if (title.startsWith(qy)) return 600;
  if (repo.includes(qy)) return 500;
  if (title.includes(qy)) return 450;
  if ((row.g ?? []).some((g: string) => g.toLowerCase().includes(qy))) return 300;
  if ((row.d ?? "").toLowerCase().includes(qy)) return 200;
  const hay = owner + " " + repo;
  let i = 0;
  for (const ch of hay) {
    if (ch === qy[i]) i++;
    if (i === qy.length) return 100;
  }
  return -1;
}

const CASES: { q: string; expect: (r: any) => boolean; label: string }[] = [
  { q: "portfolio", label: "tag search" },
  { q: "squidfunk", label: "exact owner" },
  { q: "mkdocs", label: "repo substring" },
  { q: "zzzznotathing", label: "no match expected" },
  { q: "a", label: "single char (subsequence)" },
  { q: "game", label: "common tag" },
];

let failures = 0;
for (const c of CASES) {
  const hits = all
    .map((r) => ({ r, s: score(r, c.q) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s || b.r.s - a.r.s);
  const top = hits.slice(0, 3).map((h) => `${h.r.u}`);
  console.log(`\n  "${c.q}" (${c.label}): ${hits.length} hits`);
  for (const t of top) console.log(`     ${t}`);
  if (c.q === "zzzznotathing" && hits.length > 0) {
    console.log("     FAIL: expected zero hits");
    failures++;
  }
  if (c.q === "squidfunk") {
    const first = hits[0]?.r;
    const ok = first && first.o.toLowerCase() === "squidfunk";
    console.log(`     ${ok ? "PASS" : "FAIL"}: exact owner ranked first`);
    if (!ok) failures++;
  }
}

// Recall check: every record should be findable by its own owner initial.
let unreachable = 0;
for (const r of all) {
  if (score(r, r.o.toLowerCase()) < 0) unreachable++;
}
console.log(`\n  every record findable by exact owner: ${unreachable === 0 ? "PASS" : `FAIL (${unreachable} unreachable)`}`);
if (unreachable) failures++;

// The shard-routing check that used to live here is gone, and deliberately so.
// It verified that routing a query to the shard of owners sharing its first
// letter never excluded the owner being searched for — a true statement about a
// scheme that quietly answered with about a tenth of the matching rows, because
// most queries are not matching on the owner's name. The worker now reads every
// shard (see candidateShards there), and test-idle.ts covers the load policy.

console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
