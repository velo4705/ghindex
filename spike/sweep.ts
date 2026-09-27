/**
 * M0 final — corpus size estimate via sharded discovery.
 *
 * Search hard-caps at 1,000 results per query, so total reach = (number of
 * distinct shards) x (1,000) x (has_pages rate ~0.30). This sweeps a wide grid
 * of topic/keyword shards and reports:
 *
 *   - unique Pages sites found
 *   - how quickly shards stop yielding NEW sites (saturation)
 *   - the extrapolated reachable ceiling
 *
 * Authenticated search is 30/min, so pacing is enforced centrally.
 */

import { readFileSync, existsSync } from "node:fs";

const TOKEN = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN ?? "";
if (!TOKEN) {
  console.error("set GITHUB_TOKEN (gh auth token)");
  process.exit(1);
}

const H = {
  Authorization: `Bearer ${TOKEN}`,
  "User-Agent": "ghindex-m0/0.1",
  Accept: "application/vnd.github+json",
};

const MIN_INTERVAL_MS = 2200; // ~27 req/min, under the 30/min ceiling
let lastCall = 0;

async function search(q: string): Promise<{ total_count: number; items: any[] }> {
  const wait = lastCall + MIN_INTERVAL_MS - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastCall = Date.now();

  const url = `https://api.github.com/search/repositories?q=${encodeURIComponent(q)}&per_page=100&page=1`;
  const res = await fetch(url, { headers: H });
  if (!res.ok) {
    const body = await res.text();
    // 422 = the 1000-result cap was hit, not a real failure.
    if (res.status === 422) return { total_count: 1000, items: [] };
    throw new Error(`HTTP ${res.status}: ${body.slice(0, 140)}`);
  }
  return await res.json();
}

const TOPICS = [
  "portfolio", "game", "documentation", "blog", "dashboard", "react", "vue",
  "tailwind", "landing-page", "cv", "resume", "website", "webapp", "saas",
  "ecommerce", "chatbot", "wiki", "notebook", "docs", "api", "cli", "ui",
  "template", "bootstrap", "nextjs", "astro", "svelte", "typescript",
  "python", "javascript", "static-site", "material", "bootstrap5", "animation",
  "music", "video", "podcast", "gallery", "photo", "design", "showcase",
  "hacktoberfest", "student", "course", "tutorial", "learn", "cheatsheet",
  "algorithm", "interview", "leetcode", "finance", "crypto", "nft", "ai",
  "machine-learning", "deep-learning", "ml", "data-science", "visualization",
  "map", "weather", "news", "social", "chat", "forum", "community", "tools",
  "utility", "converter", "generator", "editor", "markdown", "pdf", "editor",
  "docker", "devops", "monitoring", "security", "encryption", "download",
  "anime", "manga", "comics", "novel", "story", "poetry", "blogging",
  "netlify", "vercel", "firebase", "supabase", "graphql", "rest", "microservices",
];

async function main() {
  const found = new Map<string, { full_name: string; url: string; shard: string }>();
  const perShard: { shard: string; total: number; pages: number; fresh: number }[] = [];
  let capped = 0;
  let processed = 0;

  const resume = existsSync("m0/data/sweep-state.json")
    ? (JSON.parse(readFileSync("m0/data/sweep-state.json", "utf8")) as string[])
    : [];
  const done = new Set(resume);
  const queue = TOPICS.filter((t) => !done.has(t));
  console.log(`[sweep] ${TOPICS.length} shards, ${queue.length} remaining (resumable)`);

  for (const topic of queue) {
    let total = 0;
    let pagesCount = 0;
    let fresh = 0;
    for (const suffix of ["", " stars:>2", " stars:>20"]) {
      const q = `topic:${topic}${suffix}`;
      try {
        const { total_count, items } = await search(q);
        total = Math.max(total, total_count);
        if (total_count >= 1000) capped++;
        for (const r of items) {
          if (!r?.has_pages) continue;
          pagesCount++;
          if (!found.has(r.full_name)) {
            found.set(r.full_name, {
              full_name: r.full_name,
              url: "pending",
              shard: topic,
            });
            fresh++;
          }
        }
        processed++;
      } catch (e) {
        console.error(`  [shard ${topic} "${suffix}"] ${String(e).slice(0, 90)}`);
      }
    }
    perShard.push({ shard: topic, total, pages: pagesCount, fresh });
    const pct = ((processed / (TOPICS.length * 3)) * 100).toFixed(0);
    console.log(
      `[${String(pct).padStart(3)}%] topic:${topic.padEnd(16)} total=${String(total).padStart(6)} ` +
        `pages=${String(pagesCount).padStart(3)} NEW=${String(fresh).padStart(3)} | corpus=${found.size}`,
    );
    await Bun.write("m0/data/sweep-state.json", JSON.stringify([...done, topic]));
  }

  await Bun.write(
    "m0/data/sweep.json",
    JSON.stringify({ uniquePages: found.size, capped, perShard }, null, 2),
  );

  // Saturation: are later shards still finding new sites?
  const freshSeries = perShard.map((s) => s.fresh);
  const half = Math.floor(freshSeries.length / 2);
  const firstHalf = freshSeries.slice(0, half).reduce((a, b) => a + b, 0);
  const secondHalf = freshSeries.slice(half).reduce((a, b) => a + b, 0);
  const sorted = [...freshSeries].sort((a, b) => b - a);
  const topDecile = sorted.slice(0, Math.max(1, Math.floor(sorted.length / 10)));

  console.log(`\n${"=".repeat(60)}`);
  console.log("  CORPUS SIZE ESTIMATE");
  console.log("=".repeat(60));
  console.log(`  shards swept:        ${perShard.length}`);
  console.log(`  search calls:        ${processed} (capped-at-1000: ${capped})`);
  console.log(`  UNIQUE Pages sites:  ${found.size}`);
  console.log(`  first-half NEW:      ${firstHalf}`);
  console.log(`  second-half NEW:     ${secondHalf}`);
  console.log(`  saturation:          ${
    secondHalf < firstHalf * 0.5 ? "YES — shards are exhausting" : "NO — still finding new sites"
  }`);
  console.log(`  top-10% of shards contributed: ${topDecile.reduce((a, b) => a + b, 0)} new`);
  console.log(`\n  avg new sites/shard: ${(found.size / Math.max(1, perShard.length)).toFixed(1)}`);
  console.log(`  reach ceiling if all ${TOPICS.length} shards were near-cap:`);
  console.log(`    ${TOPICS.length} x 1000 x 0.30 has_pages ≈ ${Math.round(TOPICS.length * 1000 * 0.3).toLocaleString()} sites`);
  console.log("=".repeat(60));
}

await main();
