/**
 * Shard-space probe — how do we actually expand the corpus?
 *
 * CORRECTION: an earlier report claimed "zero shards hit the cap, so breadth
 * beats depth." That was an artifact of a 10-page loop bound, which is exactly
 * the 1,000-result cap. Direct test: topic:portfolio page=11 -> HTTP 422.
 * Every large topic IS capped, and pagination depth is structurally zero.
 *
 * So corpus growth must come from SHARD DIVERSITY: each distinct query returns
 * its own 1,000-result window. This measures how many genuinely distinct
 * windows a single topic can be split into via qualifier partitioning, which
 * is what determines whether ~100k is reachable or whether the ceiling is far
 * lower.
 */

import { existsSync, readFileSync } from "node:fs";

const TOKEN = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN ?? "";
const H = {
  Authorization: `Bearer ${TOKEN}`,
  "User-Agent": "ghindex-m0/0.1",
  Accept: "application/vnd.github+json",
};
const MIN_MS = 2200;
let last = 0;

async function search(q: string) {
  const wait = last + MIN_MS - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  last = Date.now();
  const res = await fetch(
    `https://api.github.com/search/repositories?q=${encodeURIComponent(q)}&per_page=100&page=1`,
    { headers: H },
  );
  if (res.status === 422) return { total: 1000, items: [] as any[], capped: true };
  if (!res.ok) return { total: 0, items: [] as any[], capped: false, err: `HTTP ${res.status}` };
  return { ...(await res.json()), capped: false };
}

async function main() {
  // How many DISTINCT windows can one big topic be split into?
  // Strategy: partition by stars:>N, since that is monotonic and gives
  // disjoint-ish result sets.
  const partitions = [
    "topic:portfolio stars:>500",
    "topic:portfolio stars:200..500",
    "topic:portfolio stars:50..200",
    "topic:portfolio stars:10..50",
    "topic:portfolio stars:1..10",
    "topic:portfolio stars:<=1",
  ];

  const seen = new Set<string>();
  const rows: any[] = [];

  for (const q of partitions) {
    const { total, items, capped, err } = await search(q);
    const pages = items.filter((r) => r?.has_pages);
    let fresh = 0;
    for (const r of pages) {
      if (!seen.has(r.full_name)) {
        seen.add(r.full_name);
        fresh++;
      }
    }
    rows.push({ q, total, capped, read: items.length, hasPages: pages.length, fresh });
    console.log(
      `${q.padEnd(38)} total=${String(total).padStart(5)}${capped ? " CAP" : "    "} ` +
        `read=${String(items.length).padStart(3)} pages=${String(pages.length).padStart(3)} NEW=${fresh}`,
    );
  }

  console.log(`\n  unique Pages sites from 6 star-partitions of ONE topic: ${seen.size}`);
  console.log(`  (single un-partitioned window would give ~300)`);

  // Now the other axis: how many topics are worth harvesting at all?
  // Measure marginal yield of a few very different topics to size shard space.
  const extra = ["topic:vue", "topic:javascript-game", "topic:web-design", "topic:opensource"];
  for (const q of extra) {
    const { total, items, capped } = await search(q);
    const pages = items.filter((r) => r?.has_pages);
    let fresh = 0;
    for (const r of pages) {
      if (!seen.has(r.full_name)) {
        seen.add(r.full_name);
        fresh++;
      }
    }
    console.log(`${q.padEnd(38)} total=${String(total).padStart(5)}${capped ? " CAP" : "    "} NEW=${fresh}`);
  }

  console.log(`\n  running unique total: ${seen.size}`);
  console.log("\n=== IMPLICATION ===");
  console.log("  Corpus growth = (distinct shard windows) x 1000 x ~0.27 has_pages.");
  console.log("  Because page 11 is 422, depth is impossible; only width helps.");
  console.log("  A production harvester must therefore partition topics by");
  console.log("  stars/language/size, not just page deeper.");

  await Bun.write("m0/data/shard-space.json", JSON.stringify({ rows, unique: seen.size }, null, 2));
}

await main();
