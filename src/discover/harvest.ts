/**
 * Harvester: discovers Pages-enabled repos via the GitHub Search API.
 *
 * Design notes (all grounded in M0 measurements):
 *
 *  - Search caps at 1,000 results per query (page 11 -> HTTP 422), so DEPTH is
 *    structurally zero. The corpus can only grow by SHARD WIDTH: many distinct
 *    query windows. We therefore generate a large cross-product of shards
 *    (topic x stars x language) rather than paging deeply.
 *  - `has_pages` is not a server-side qualifier; filter client-side on the
 *    field. ~27.2% of results have Pages enabled.
 *  - 95.4% of Pages sites live at a SUBPATH (owner.github.io/<repo>/), not the
 *    apex. See pagesUrlFor() in core.ts.
 *  - Resumable: state is checkpointed after every shard, so a long harvest can
 *    be interrupted and continued without losing work.
 *
 * Usage:
 *   GITHUB_TOKEN=... bun run src/discover/harvest.ts            # run until budget spent
 *   bun run src/discover/harvest.ts --stats                     # report progress only
 */

import { existsSync, readFileSync } from "node:fs";
import { PATHS } from "../paths";
import { pagesUrlFor, type Record } from "./core";
import { PATHS } from "../paths";

const TOKEN = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN ?? "";
if (!TOKEN) {
  console.error("set GITHUB_TOKEN (gh auth token)");
  process.exit(1);
}

const H = {
  Authorization: `Bearer ${TOKEN}`,
  "User-Agent": "ghindex-m1/0.1",
  Accept: "application/vnd.github+json",
};

const DB = PATHS.corpus;
const SHARD_FILE = PATHS.shards;
const MIN_MS = 2200; // stay under 30 search req/min
let lastCall = 0;

// ---------------------------------------------------------------- shards

const TOPICS = [
  "portfolio", "game", "documentation", "blog", "dashboard", "react", "vue",
  "tailwind", "landing-page", "cv", "resume", "website", "webapp", "saas",
  "wiki", "docs", "cli", "ui", "template", "nextjs", "astro", "svelte",
  "typescript", "python", "javascript", "static-site", "animation", "music",
  "gallery", "design", "showcase", "course", "tutorial", "cheatsheet",
  "leetcode", "finance", "ai", "machine-learning", "data-science",
  "visualization", "weather", "news", "forum", "converter", "generator",
  "editor", "markdown", "pdf", "docker", "security", "download", "manga",
  "novel", "blogging", "vercel", "firebase", "supabase", "graphql",
  "web-design", "javascript-game", "opensource", "hacktoberfest", "learning",
  "material", "bootstrap", "web-components", "pwa", "electron",
];

/**
 * Star partitions, measured on a 21-shard run: `stars:>100`, `>20`, `>5` all
 * returned ZERO new sites: they are strict subsets of the unpartitioned
 * top-1000 window, which search already returns ranked by best match. Only the
 * low-star tail escapes that window, so that is the only partition worth its
 * search calls. Budget spent on the others is wasted.
 */
const STAR_BUCKETS = ["", " stars:1..5"];

/**
 * Each distinct query is an independent 1,000-result window, so the shard
 * space is the cross-product. We cap generation and consume it in order.
 */
function buildShards(): string[] {
  const out: string[] = [];
  for (const t of TOPICS) {
    for (const s of STAR_BUCKETS) {
      out.push(`topic:${t}${s}`);
    }
  }
  return out;
}

// ---------------------------------------------------------------- db

interface Db {
  records: Record<string, Record>;
  stats: { harvestCalls: number; probesRun: number };
}

function loadDb(): Db {
  if (existsSync(DB)) {
    return JSON.parse(readFileSync(DB, "utf8")) as Db;
  }
  return { records: {}, stats: { harvestCalls: 0, probesRun: 0 } };
}

function saveDb(db: Db) {
  return Bun.write(DB, JSON.stringify(db, null, 2));
}

function completedShards(): Set<string> {
  if (!existsSync(SHARD_FILE)) return new Set();
  return new Set(JSON.parse(readFileSync(SHARD_FILE, "utf8")) as string[]);
}

function saveShards(done: Set<string>) {
  return Bun.write(SHARD_FILE, JSON.stringify([...done], null, 2));
}

// ---------------------------------------------------------------- api

async function search(q: string, page: number) {
  const wait = lastCall + MIN_MS - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastCall = Date.now();
  const url = `https://api.github.com/search/repositories?q=${encodeURIComponent(q)}&per_page=100&page=${page}`;
  const res = await fetch(url, { headers: H });
  if (res.status === 422) return { capped: true, items: [] as any[] };
  if (res.status === 403 || res.status === 429) {
    const retry = Number(res.headers.get("retry-after") ?? 60);
    console.error(`  [rate limited] sleeping ${retry}s`);
    await new Promise((r) => setTimeout(r, retry * 1000));
    return { capped: false, items: [] as any[], throttled: true };
  }
  if (!res.ok) return { capped: false, items: [] as any[], throttled: false };
  return { capped: false, items: (await res.json()).items ?? [] };
}

// ---------------------------------------------------------------- main

async function main() {
  const db = loadDb();
  const done = completedShards();
  const queue = buildShards().filter((s) => !done.has(s));

  if (process.argv.includes("--stats")) {
    const all = Object.values(db.records);
    const by = (l: string) => all.filter((r) => r.liveness === l).length;
    console.log("=== corpus stats ===");
    console.log(`  records:      ${all.length}`);
    console.log(`  alive:        ${by("alive")}`);
    console.log(`  suspect:      ${by("suspect")}`);
    console.log(`  flaky:        ${by("flaky")}`);
    console.log(`  tombstoned:   ${by("tombstoned")}`);
    console.log(`  unknown:      ${by("unknown")}`);
    console.log(`  shards done:  ${done.size}/${buildShards().length}`);
    console.log(`  pending:      ${queue.length}`);
    return;
  }

  // Wall-clock budget so a long run can be stopped safely (it checkpoints).
  const BUDGET_MS = Number(process.env.BUDGET_MS ?? 25 * 60_000);
  const t0 = Date.now();
  console.log(
    `[harvest] ${queue.length} shards pending, budget ${(BUDGET_MS / 60000).toFixed(0)}min`,
  );

  for (const shard of queue) {
    if (Date.now() - t0 > BUDGET_MS) {
    console.log("[harvest] budget exhausted - stopping (state saved, rerun to continue)");
      break;
    }

    let newCount = 0;
    let seen = 0;
    // Depth is capped at the 1,000-result ceiling.
    for (let page = 1; page <= 10; page++) {
      const { capped, items } = await search(shard, page);
      db.stats.harvestCalls++;
      if (capped) break;
      if (items.length === 0) break;
      seen += items.length;
      for (const r of items) {
        if (!r?.has_pages) continue;
        if (db.records[r.full_name]) continue;
        const owner: string = r.owner?.login ?? r.full_name.split("/")[0];
        const name: string = r.name;
        db.records[r.full_name] = {
          full_name: r.full_name,
          owner,
          name,
          url: pagesUrlFor(owner, name, r.homepage ?? null),
          homepage: r.homepage ?? null,
          topics: r.topics ?? [],
          description: r.description ?? null,
          stars: r.stargazers_count ?? 0,
          pushed_at: r.pushed_at ?? "",
          discovered_at: new Date().toISOString(),
          liveness: "unknown",
          http_status: null,
          last_checked: null,
          last_ok: null,
          fails: 0,
          next_check: null, // unknown => due immediately
          title: null,
          page_description: null,
          blocks_framing: null,
        };
        newCount++;
      }
      if (items.length < 100) break;
    }

    done.add(shard);
    await saveShards(done);
    if (newCount > 0) await saveDb(db);

    console.log(
      `[harvest] ${shard.padEnd(34)} read=${String(seen).padStart(4)} NEW=${String(newCount).padStart(3)} | corpus=${Object.keys(db.records).length}`,
    );
  }

  await saveDb(db);
  const all = Object.values(db.records);
  console.log(`\n[harvest] corpus: ${all.length} records across ${done.size} shards`);
  console.log(`[harvest] ${all.filter((r) => r.liveness === "unknown").length} awaiting probe`);
  console.log("[harvest] run 'bun run src/index/probe.ts' to check liveness");
}

await main();
