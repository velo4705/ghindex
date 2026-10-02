/**
 * Tests for the landing page payload built by src/site/search-worker.js.
 *
 * This drives the real worker file rather than re-implementing its logic,
 * because the thing worth checking is a curation that lives inside it, and a
 * copy in a test would happily agree with a broken original.
 *
 * What is being defended
 * ----------------------
 * The front page replaced a star leaderboard whose top twenty were almost all
 * framework documentation and "awesome" lists, and a first attempt at deriving
 * the shelves automatically that produced redirect stubs instead. The shelves are
 * now chosen by hand, which moves the risk from "is the algorithm any good" to
 * "does the list still hold up" — so that is what these check: that every pick
 * still exists in the published corpus, that no shelf has quietly rotted, and
 * that the front page is not drifting back into being a ranking.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { applyStarQuota } from "./star-quota";

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
 * Minimal Worker globals so the real search-worker.js can run under Bun.
 * Only the shard fetches are intercepted; everything else is the shipped code.
 */
type Handler = (e: { data: unknown }) => Promise<void> | void;
const outbox: unknown[] = [];
(globalThis as any).self = {
  onmessage: null as Handler | null,
  postMessage: (m: unknown) => {
    outbox.push(m);
  },
};

const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL) => {
  const url = String(typeof input === "string" ? input : (input as Request).url ?? input);
  const m = url.match(/\.\/data\/([#a-z])\.json$/);
  if (m) {
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

const ready = await send({ type: "init", manifest });
check("worker acknowledges init", ready.some((m: any) => m.type === "ready"));

// The landing payload is built after init rather than in the init reply, so
// poll briefly instead of assuming it is already there.
let landing: any = null;
for (let i = 0; i < 100 && !landing; i++) {
  await new Promise((r) => setTimeout(r, 50));
  landing = outbox.find((m: any) => m.type === "landing")?.landing ?? landing;
}
check("worker emits a landing payload", !!landing);

// ------------------------------------------------------------------ shelves

console.log("=== landing shelves ===");
if (landing) {
  const shelves = landing.shelves as Array<{ id: string; label: string; blurb: string; cats: string[]; count: number; rows: any[] }>;

  check("there are shelves to browse", shelves.length >= 4, `got ${shelves.length}`);
  eq(
    "shelf ids are unique",
    new Set(shelves.map((s) => s.id)).size,
    shelves.length,
  );

  for (const s of shelves) {
    check(`shelf "${s.id}" is not empty`, s.rows.length > 0);
    check(
      `shelf "${s.id}" keeps most of its picks`,
      s.rows.length >= 6,
      `only ${s.rows.length} of its picks are still in the corpus`,
    );
    check(`shelf "${s.id}" has a blurb`, typeof s.blurb === "string" && s.blurb.length > 0);
    check(
      `shelf "${s.id}" names categories for its "show all" button`,
      s.cats.length > 0,
    );
    check(
      `shelf "${s.id}" count covers what it shows`,
      s.count >= s.rows.length,
      `count=${s.count} shown=${s.rows.length}`,
    );
    // A shelf is meant to be browsable. A pick whose own title says it is a
    // redirect or a docs page is the exact failure the curation replaced.
    const junk = s.rows.filter((r) =>
      /redirect|documentation|\bdocs?\b|^home$/i.test(`${r.t ?? ""} ${r.d ?? ""}`),
    );
    check(
      `shelf "${s.id}" has no redirect stubs or doc pages`,
      junk.length === 0,
      junk.map((r) => `${r.u} (${r.t})`).join("; "),
    );
  }

  const allRows: any[] = [];
  for (const s of manifest.shards) {
    allRows.push(...JSON.parse(readFileSync(join(DATA, `${s.id}.json`), "utf8")));
  }
  const byUrl = new Map(allRows.map((r) => [r.u, r]));

  // Every curated pick must resolve against the real published data.
  const unresolved = (landing.missing as Array<{ shelf: string; url: string }>) ?? [];
  check(
    "every curated pick still exists in the corpus",
    unresolved.length === 0,
    unresolved.map((m) => `${m.shelf}: ${m.url}`).join("; "),
  );
  check(
    "and the payload reports what fell out, rather than dropping it",
    Array.isArray(landing.missing),
  );

  const shelfUrls = shelves.flatMap((s) => s.rows.map((r) => r.u));
  eq(
    "no site is picked twice",
    new Set(shelfUrls).size,
    shelfUrls.length,
  );
  check(
    "every shelf row is a real published row",
    shelfUrls.every((u) => byUrl.has(u)),
  );

  // Every pick must also survive the publish quota (src/publish/star-quota.ts),
  // or the shelf links to a page that the next `bun run publish` will not
  // generate. Ten of sixteen people/blogs picks were lost this way, so it is
  // checked here rather than left to be rediscovered on the front page.
  const quotaKept = new Set(
    applyStarQuota(
      allRows.map((r) => ({
        ...r,
        stars: r.s ?? 0,
        description: r.d ?? "",
        topics: r.g ?? [],
        owner: r.o,
      })),
    ).map((r) => r.u),
  );
  const outOfQuota = shelfUrls.filter((u) => !quotaKept.has(u));
  check(
    "every curated pick survives the star quota",
    outOfQuota.length === 0,
    outOfQuota.join(", "),
  );

  // The specific regression this feature exists to prevent: the front page
  // quietly becoming the top of the star leaderboard again.
  const topTwenty = allRows
    .slice()
    .sort((a, b) => (b.s ?? 0) - (a.s ?? 0))
    .slice(0, 20)
    .map((r) => r.u);
  const overlap = topTwenty.filter((u) => shelfUrls.includes(u));
  check(
    "the landing is not just the star leaderboard",
    overlap.length <= 2,
    `overlaps: ${overlap.join(", ")}`,
  );

  eq("the reported total matches the manifest", landing.total, manifest.total);
}

globalThis.fetch = realFetch;

console.log(fail === 0 ? `\nLANDING OK (${checks} checks)` : `\n${fail} LANDING CHECK(S) FAILED`);
if (fail) process.exit(1);
