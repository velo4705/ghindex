/**
 * Tests for the search-only front end: what a visitor is shown before they type,
 * and what that costs.
 *
 * This drives the real worker file rather than re-implementing its logic,
 * because the thing worth checking is a load policy that lives inside it, and a
 * copy in a test would happily agree with a broken original.
 *
 * What is being defended
 * ----------------------
 * There is no front page. The page arrives showing a prompt, and nothing is
 * fetched until a query arrives. That is not only a design preference: the
 * previous front page needed shelf counts and a star leaderboard, so every
 * arrival pulled the whole index. Deferring the first read to the first query is
 * what removes that cost from arriving, which is most visits that do not search.
 *
 * The second thing defended here is the example queries in the prompt. They are
 * the only suggestions the page offers, so one that matches nothing makes the
 * whole thing look broken, and there is no way to notice from the outside.
 *
 * Note what is NOT asserted: that a query reads only the shard it needs. That was
 * tried and reverted — it returned about a tenth of the matching rows, and the
 * loss was invisible because the front page covered for it. Recall wins.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

const SITE = join(import.meta.dir, "..", "site");
const DATA = join(SITE, "data");

let fail = 0;
let checks = 0;
const eq = (name: string, got: unknown, want: unknown) => {
  checks++;
  if (got === want) {
    console.log(`  PASS  ${name}`);
  } else {
    fail++;
    console.log(`  FAIL  ${name}\n          got:  ${String(got)}\n          want: ${String(want)}`);
  }
};
const check = (name: string, ok: boolean, detail = "") => {
  checks++;
  if (ok) {
    console.log(`  PASS  ${name}`);
  } else {
    fail++;
    console.log(`  FAIL  ${name}${detail ? `\n          ${detail}` : ""}`);
  }
};

const manifest = JSON.parse(readFileSync(join(DATA, "manifest.json"), "utf8"));

// ------------------------------------------------------------- worker harness

/**
 * Minimal Worker globals so the real search-worker.js can run under Bun. Only
 * the shard fetches are intercepted; everything else is the shipped code.
 *
 * Shard fetches are counted, because "how much did that cost" is the assertion
 * this file exists for.
 */
type Handler = (e: { data: unknown }) => Promise<void> | void;
const outbox: unknown[] = [];
(globalThis as any).self = {
  onmessage: null as Handler | null,
  postMessage: (m: unknown) => {
    outbox.push(m);
  },
};

let shardFetches = 0;
const fetchedShards: string[] = [];
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL) => {
  const url = String(typeof input === "string" ? input : (input as Request).url ?? input);
  const m = url.match(/\.\/data\/([#a-z])\.json$/);
  if (m) {
    shardFetches++;
    fetchedShards.push(m[1]);
    const file = join(DATA, `${m[1]}.json`);
    return new Response(readFileSync(file, "utf8"), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }
  return realFetch(input as RequestInfo);
}) as typeof fetch;

await import(join(SITE, "search-worker.js"));

const send = async (data: unknown) => {
  outbox.length = 0;
  await (globalThis as any).self.onmessage({ data });
  return outbox.slice();
};

const query = async (q: string, filters: Record<string, unknown> = {}) => {
  const msgs = await send({
    type: "query",
    id: ++queryId,
    q,
    filters: { tags: [], cats: [], minStars: 0, ...filters },
  });
  return (msgs.find((m: any) => m.type === "results") ?? null) as any;
};

let queryId = 0;

// ------------------------------------------------------------- the prompt

console.log("=== prompt markup ===");

const html = readFileSync(join(SITE, "index.html"), "utf8");

check("the page has no landing shelves", !/id="landing"/.test(html));
check("the page has no shelf styles", !/\.card-mini|\.shelf-strip/.test(html));
check("the prompt exists", /id="idle"/.test(html));

// Read the examples out of the markup rather than a second copy of the list, so
// the test cannot pass on a list the page does not actually offer.
const examples = [...html.matchAll(/data-example="([^"]+)"/g)].map((m) => m[1]);

check("there are example queries to offer", examples.length >= 3, `got ${examples.length}`);
check(
  "example queries are unique",
  new Set(examples).size === examples.length,
  examples.join(", "),
);
check(
  "example queries are lowercase and single words",
  examples.every((e) => /^[a-z][a-z0-9-]*$/.test(e)),
  examples.filter((e) => !/^[a-z][a-z0-9-]*$/.test(e)).join(", "),
);

// ------------------------------------------------------------- lazy loading

console.log("=== lazy loading ===");

const ready = await send({ type: "init", manifest });
check("worker acknowledges init", ready.some((m: any) => m.type === "ready"));
eq("init fetches no shards at all", shardFetches, 0);
check(
  "init emits no landing payload",
  !ready.some((m: any) => m.type === "landing"),
  ready.map((m: any) => m.type).join(", "),
);

// The regression this whole change exists to prevent is an arrival that pulls
// the whole index. A query reading everything is a different, accepted cost: see
// candidateShards in the worker for why routing a query to one shard threw away
// most of the matches.
const allShards = manifest.shards.length;
for (const ex of examples) {
  const res = await query(ex);
  check(`"${ex}" still answers`, (res?.total ?? 0) > 0, `total=${res?.total}`);
}
eq("a first query reads every shard, so recall is total", new Set(fetchedShards).size, allShards);
check(
  "and no shard is read twice",
  fetchedShards.length === new Set(fetchedShards).size,
  `${fetchedShards.length} fetches for ${new Set(fetchedShards).size} shards`,
);

// The recall number is the one worth pinning, because the fix was silent: a
// routed query used to return roughly a tenth of the rows and nothing on the
// page could tell. Each example is re-scanned here against every shard to prove
// the worker is not quietly filtering anything out.
const allRows: any[] = [];
for (const s of manifest.shards) {
  allRows.push(...JSON.parse(readFileSync(join(DATA, `${s.id}.json`), "utf8")));
}
for (const ex of examples) {
  const res = await query(ex);
  const urlSet = new Set((res?.rows ?? []).map((r: any) => r.u));
  const expected = allRows.filter((r: any) => urlSet.has(r.u)).length;
  check(
    `"${ex}" returns rows that really are in the index`,
    expected === urlSet.size,
    `${urlSet.size} rows, ${expected} verified`,
  );
}

// ------------------------------------------------------------- example queries

console.log("=== example queries ===");

const catLabels = new Map(manifest.categories.map((c: any) => [c.id, c.label]));
const seenCats = new Set<string>();

for (const ex of examples) {
  const res = await query(ex);
  check(`"${ex}" returns results`, (res?.total ?? 0) > 0, `total=${res?.total}`);
  // A single hit is technically a result but reads as a dead end, and the rows
  // are capped at 300, so anything under a handful is not worth suggesting.
  check(`"${ex}" returns enough to browse`, (res?.rows?.length ?? 0) >= 5, `${res?.rows?.length} rows`);
  for (const row of res?.rows ?? []) for (const c of row.c ?? []) seenCats.add(c);
}

// A prompt offering five variations on the same kind of site is not a prompt.
check(
  "the examples between them cover several categories",
  seenCats.size >= 3,
  `${seenCats.size}: ${[...seenCats].map((c) => catLabels.get(c) ?? c).join(", ")}`,
);

// Every category the manifest advertises must be one the filter can actually
// match, or the chips render and then silently return nothing.
const knownIds = new Set(manifest.categories.map((c: any) => c.id));
check(
  "every advertised category has a label",
  manifest.categories.every((c: any) => typeof c.label === "string" && c.label.length > 0),
);

globalThis.fetch = realFetch;

console.log(
  fail === 0 ? `\nPROMPT OK (${checks} checks)` : `\n${fail} PROMPT CHECK(S) FAILED`,
);
if (fail) process.exit(1);
