/**
 * Deep-dive: fully paginate a few shards to replace sampled estimates with
 * real per-shard yield.
 *
 * The 94-shard sweep hit the 1,000-result cap on 230/282 calls but only read
 * per_page=100 items, so it sampled ~10% of every shard. This measures the
 * true has_pages rate and true unique-per-shard yield, which is what the
 * corpus-size extrapolation actually depends on.
 */

import { existsSync, readFileSync } from "node:fs";

const TOKEN = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN ?? "";
const H = {
  Authorization: `Bearer ${TOKEN}`,
  "User-Agent": "ghindex-m0/0.1",
  Accept: "application/vnd.github+json",
};
const MIN_INTERVAL_MS = 2200;
let lastCall = 0;

async function searchPage(q: string, page: number) {
  const wait = lastCall + MIN_INTERVAL_MS - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastCall = Date.now();
  const url = `https://api.github.com/search/repositories?q=${encodeURIComponent(q)}&per_page=100&page=${page}`;
  const res = await fetch(url, { headers: H });
  if (res.status === 422) return { total_count: 1000, items: [] as any[], capped: true };
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return { ...(await res.json()), capped: false };
}

/** Topics chosen to span the size distribution seen in the sweep. */
const SHARDS = [
  { q: "topic:portfolio", label: "portfolio (small/medium)" },
  { q: "topic:blog", label: "blog (medium)" },
  { q: "topic:react", label: "react (very large)" },
  { q: "topic:documentation", label: "documentation (medium)" },
  { q: "topic:game", label: "game (large)" },
  { q: "topic:tailwind", label: "tailwind (very large)" },
];

async function main() {
  const all = new Map<string, string>();
  const rows: any[] = [];

  for (const shard of SHARDS) {
    let shardPages = 0;
    let shardHasPages = 0;
    let shardUnique = 0;
    let totalCount = 0;
    let hitCap = false;

    for (let page = 1; page <= 10; page++) {
      let res: any;
      try {
        res = await searchPage(shard.q, page);
      } catch (e) {
        console.error(`  ${shard.q} p${page}: ${String(e).slice(0, 80)}`);
        break;
      }
      if (res.capped) { hitCap = true; break; }
      totalCount = res.total_count;
      if (res.items.length === 0) break;
      shardPages += res.items.length;
      for (const r of res.items) {
        if (!r?.has_pages) continue;
        shardHasPages++;
        if (!all.has(r.full_name)) {
          all.set(r.full_name, shard.q);
          shardUnique++;
        }
      }
      if (res.items.length < 100) break;
    }

    const rate = shardPages ? (shardHasPages / shardPages) * 100 : 0;
    rows.push({
      shard: shard.q,
      label: shard.label,
      total_count: totalCount,
      itemsRead: shardPages,
      hasPages: shardHasPages,
      hasPagesRate: +rate.toFixed(1),
      newUnique: shardUnique,
      hitCap,
    });
    console.log(
      `${shard.q.padEnd(26)} total=${String(totalCount).padStart(7)} read=${String(shardPages).padStart(4)} ` +
        `has_pages=${String(shardHasPages).padStart(4)} (${rate.toFixed(1)}%) new=${String(shardUnique).padStart(4)}` +
        `${hitCap ? "  [CAPPED]" : ""} | corpus=${all.size}`,
    );
  }

  const totalRead = rows.reduce((a, r) => a + r.itemsRead, 0);
  const totalPages = rows.reduce((a, r) => a + r.hasPages, 0);
  const overallRate = totalRead ? (totalPages / totalRead) * 100 : 0;
  const cappedCount = rows.filter((r) => r.hitCap).length;

  console.log(`\n${"=".repeat(62)}`);
  console.log("  DEEP PAGINATION — TRUE YIELD");
  console.log("=".repeat(62));
  console.log(`  items actually read:      ${totalRead.toLocaleString()}`);
  console.log(`  has_pages:                ${totalPages.toLocaleString()}`);
  console.log(`  TRUE has_pages rate:      ${overallRate.toFixed(1)}%`);
  console.log(`  unique Pages sites:       ${all.size.toLocaleString()}`);
  console.log(`  shards that hit the cap:  ${cappedCount}/${rows.length}`);
  console.log("");
  console.log("  CORPUS CEILING (full pagination, near-cap shards):");
  const shards = 400; // realistic topic+keyword shard count
  console.log(`    ${shards} shards x 1000 results x ${(overallRate / 100).toFixed(2)} has_pages`);
  console.log(`    = ${Math.round(shards * 1000 * (overallRate / 100)).toLocaleString()} sites`);
  console.log("");
  console.log(`  vs. the 94-shard sampled sweep which found ${all.size} (sampled ~10% of each)`);
  console.log("=".repeat(62));

  await Bun.write("m0/data/deep-sweep.json", JSON.stringify({ rows, uniquePages: all.size, overallRate }, null, 2));
}

await main();
