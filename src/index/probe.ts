/**
 * Prober: checks liveness and extracts page metadata.
 *
 * The dead-link state machine lives in core.ts (classify/nextCheckFor). Nothing
 * is ever deleted: dead records drop to suspect -> tombstoned and stay in the
 * DB so they can be retried and so we can distinguish "never existed" from
 * "was live, then died".
 *
 * Probing is cheap (~15-60 sites/sec at concurrency 20), so the bottleneck is
 * discovery, not this. Only records due for a check are probed.
 *
 * Usage: bun run src/index/probe.ts [--limit N] [--all]
 */

import { readFileSync } from "node:fs";
import { PATHS } from "../paths";
import { classify, isDue, type Record } from "./core";
import { PATHS } from "../paths";

const DB = PATHS.corpus;
const UA =
  "Mozilla/5.0 (compatible; ghindex-m1/0.1; +https://github.com/; site index)";
const CONCURRENCY = 20;
const TIMEOUT_MS = 15_000;

const titleOf = (h: string) => {
  const m = h.match(/<title[^>]*>([\s\S]{1,300}?)<\/title>/i);
  if (!m) return null;
  const t = m[1].replace(/\s+/g, " ").trim();
  return t.length ? t : null;
};
const descOf = (h: string) => {
  const tag = h.match(/<meta[^>]+name\s*=\s*["']?description["']?[^>]*>/i)?.[0];
  const c = tag?.match(/content\s*=\s*["']([^"']{1,500})["']/i)?.[1];
  return c && c.trim().length ? c.trim() : null;
};

/** Only non-permissive X-Frame-Options / CSP frame-ancestors actually block. */
function blocksFraming(h: Headers): boolean {
  const xfo = h.get("x-frame-options");
  if (xfo) {
    const v = xfo.toLowerCase();
    if (!v.includes("allowall") && !v.includes("allow-from")) return true;
  }
  const csp = h.get("content-security-policy");
  if (csp && /frame-ancestors/i.test(csp)) {
    const fa = csp.match(/frame-ancestors\s+([^;]+)/i)?.[1]?.toLowerCase() ?? "";
    if (!/\*|\bself\b/.test(fa)) return true;
  }
  return false;
}

async function probe(rec: Record): Promise<Record> {
  const now = Date.now();
  let status = 0;
  let error: string | null = null;
  let framing: boolean | null = null;
  let title: string | null = null;
  let desc: string | null = null;

  try {
    const head = await fetch(rec.url, {
      method: "HEAD",
      redirect: "follow",
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { "User-Agent": UA },
    });
    status = head.status;
    framing = blocksFraming(head.headers);

    if (head.ok) {
      const g = await fetch(head.url, {
        redirect: "follow",
        signal: AbortSignal.timeout(TIMEOUT_MS),
        headers: { "User-Agent": UA, Accept: "text/html" },
      });
      if ((g.headers.get("content-type") ?? "").includes("html")) {
        const html = await g.text();
        title = titleOf(html);
        desc = descOf(html);
      }
    }
  } catch (e) {
    error = String(e).slice(0, 100);
  }

  const verdict = classify(status, error, now);
  return {
    ...rec,
    http_status: status || null,
    liveness: verdict.liveness,
    fails: verdict.fails,
    next_check: verdict.nextCheck,
    last_checked: new Date(now).toISOString(),
    last_ok: verdict.liveness === "alive" ? new Date(now).toISOString() : rec.last_ok,
    blocks_framing: framing ?? rec.blocks_framing,
    // Only overwrite metadata when we actually managed to read the page.
    title: title ?? rec.title,
    page_description: desc ?? rec.page_description,
  };
}

async function main() {
  const db = JSON.parse(readFileSync(DB, "utf8")) as {
    records: Record<string, Record>;
    stats: { harvestCalls: number; probesRun: number };
  };

  const force = process.argv.includes("--all");
  const limitArg = process.argv.indexOf("--limit");
  const limit = limitArg >= 0 ? Number(process.argv[limitArg + 1]) : Infinity;

  const due = Object.values(db.records)
    .filter((r) => (force ? r.liveness !== "tombstoned" : isDue(r)))
    .slice(0, limit);

  console.log(
    `[probe] ${Object.keys(db.records).length} records, ${due.length} due` +
      `${force ? " (forced, ignoring schedule)" : ""}`,
  );
  if (due.length === 0) {
    console.log("[probe] nothing due - run the harvester, or use --all");
    return;
  }

  const t0 = Date.now();
  let cursor = 0;
  const out = new Array<Record>(due.length);

  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, due.length) }, async () => {
      for (;;) {
        const i = cursor++;
        if (i >= due.length) return;
        out[i] = await probe(due[i]);
        if ((i + 1) % 100 === 0 || i + 1 === due.length) {
          process.stdout.write(`\r  probed ${i + 1}/${due.length}`);
        }
      }
    }),
  );
  const secs = (Date.now() - t0) / 1000;
  process.stdout.write("\n");

  for (const r of out) {
    db.records[r.full_name] = r;
    db.stats.probesRun++;
  }
  await Bun.write(DB, JSON.stringify(db, null, 2));

  const all = Object.values(db.records);
  const by = (l: string) => all.filter((r) => r.liveness === l).length;
  const alive = by("alive");
  const probed = all.filter((r) => r.last_checked !== null);
  const withTitle = probed.filter((r) => r.title !== null).length;
  const withDesc = probed.filter((r) => r.page_description !== null).length;

  console.log(`\n[probe] done in ${secs.toFixed(1)}s (${(due.length / secs).toFixed(1)}/sec)`);
  console.log(`[probe] corpus: ${all.length} total`);
  console.log(`  alive       ${String(alive).padStart(5)}  ${((alive / all.length) * 100).toFixed(1)}%`);
  console.log(`  suspect     ${String(by("suspect")).padStart(5)}`);
  console.log(`  flaky       ${String(by("flaky")).padStart(5)}`);
  console.log(`  tombstoned  ${String(by("tombstoned")).padStart(5)}`);
  console.log(`  unknown     ${String(by("unknown")).padStart(5)}`);
  if (probed.length) {
    console.log(`  title yield      ${((withTitle / probed.length) * 100).toFixed(1)}%`);
    console.log(`  description yield${((withDesc / probed.length) * 100).toFixed(1)}%`);
  }
}

await main();
