/**
 * Publish pipeline: turns the corpus into static files a Pages site can serve.
 *
 * Turns src/index/data/corpus.json into static files a GitHub Pages site can serve.
 *
 * Design decisions (and why):
 *
 *  - PUBLISHABLE ONLY. Only liveness==='alive' records ship. Dead records stay
 *    in m1's DB (never deleted) but must never reach the site.
 *
 *  - SHORT FIELD NAMES. At ~100k records, key names are a real fraction of the
 *    payload. u/o/r/t/d/g is used instead of url/owner/repo/title/...
 *
 *  - SHARD BY OWNER INITIAL. A query for a username can then load only the one
 *    shard that can possibly match, instead of the whole index. The manifest
 *    records which shards exist and how big they are.
 *
 *  - CHANGED-SHARDS-ONLY. Rewriting every shard on every run makes deploys
 *    huge and git diffs useless. We hash each shard and only write the ones
 *    whose content actually changed, deleting shards that lost all records.
 *
 * Usage: bun run src/publish/build.ts [--out dist] [--shards 1|36]
 */

import { existsSync, readFileSync, rmSync, mkdirSync } from "node:fs";
import { PATHS } from "../paths";
import { createHash } from "node:crypto";
import { PATHS } from "../paths";
import { isPublishable, type Record } from "../index/core";
import { PATHS } from "../paths";
import { classify, CATEGORIES, CATEGORY_LABELS } from "../classify/taxonomy";
import { PATHS } from "../paths";

const outArg = process.argv.indexOf("--out");
const OUT = outArg >= 0 ? process.argv[outArg + 1] : PATHS.data;
// --shards 1 disables sharding entirely (single index); useful for measuring.
const SHARDS = process.argv.includes("--shards") ? Number(process.argv[process.argv.indexOf("--shards") + 1]) : 36;

/** Compact published shape. */
interface Packed {
  u: string; // url
  o: string; // owner
  r: string; // repo
  t: string | null; // page title
  d: string | null; // page description
  g: string[]; // raw topics (free-text search)
  c: string[]; // derived categories (browse/facets)
  s: number; // stars
  p: string; // pushed_at
}

function pack(rec: Record): Packed {
  return {
    u: rec.url,
    o: rec.owner,
    r: rec.name,
    t: rec.title,
    d: rec.page_description ?? rec.description,
    g: rec.topics.slice(0, 6),
    // Categories are DERIVED from topics at build time, so a newly harvested
    // site classifies itself with no manual step.
    c: classify(rec.topics ?? []).categories,
    s: rec.stars,
    p: rec.pushed_at,
  };
}

/** Stable key order keeps hashes stable across runs when data is unchanged. */
function serialize(rows: Packed[]): string {
  return JSON.stringify(rows, (k, v) => v);
}

function shardOf(owner: string): string {
  if (SHARDS <= 1) return "_all";
  const c = owner.trim().toLowerCase().charAt(0);
  return /[a-z]/.test(c) ? c : /[0-9]/.test(c) ? "#" : "_";
}

/** JSON.parse that tolerates a BOM and returns null rather than throwing. */
function safeParse(text: string): any | null {
  try {
    return JSON.parse(text.replace(/^\uFEFF/, ""));
  } catch {
    return null;
  }
}

async function main() {
  const src = PATHS.corpus;
  if (!existsSync(src)) {
    console.error("no corpus - run: bun run src/discover/harvest.ts, then bun run src/index/probe.ts");
    process.exit(1);
  }

  const db = JSON.parse(readFileSync(src, "utf8")) as { records: Record<string, Record> };
  const all = Object.values(db.records);
  const alive = all.filter(isPublishable);
  // Dedupe by URL, not by repo. The same site is reachable from several repos
  // (forked templates, renamed repos, an apex site plus its subpath), so
  // full_name is NOT a unique key for a user-facing index. Keep the
  // best-populated record: prefer one with a title, then more stars.
  const byUrl = new Map<string, Record>();
  for (const rec of alive) {
    const key = rec.url.replace(/\/+$/, "").toLowerCase();
    const prev = byUrl.get(key);
    if (!prev) {
      byUrl.set(key, rec);
      continue;
    }
    const better =
      (rec.title !== null) !== (prev.title !== null)
        ? rec.title !== null
        : rec.stars > prev.stars;
    if (better) byUrl.set(key, rec);
  }
  const deduped = [...byUrl.values()];
  const dropped = alive.length - deduped.length;

  console.log(
    `[build] corpus ${all.length} records, ${alive.length} alive, ${deduped.length} after URL dedupe` +
      (dropped ? ` (${dropped} duplicate URLs collapsed)` : ""),
  );

  const aliveForPublish = deduped;
  if (aliveForPublish.length === 0) {
    console.error("[build] nothing alive yet - refusing to publish an empty index");
    process.exit(1);
  }

  mkdirSync(OUT, { recursive: true });

  // Group into shards, sorting within shard for stable output.
  const groups = new Map<string, Packed[]>();
  for (const rec of aliveForPublish) {
    const k = shardOf(rec.owner);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k)!.push(pack(rec));
  }

  const manifestShards: { id: string; file: string; count: number; bytes: number }[] = [];
  const written: string[] = [];
  let skipped = 0;
  let totalBytes = 0;

  for (const [id, rows] of [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    rows.sort((a, b) => b.s - a.s || a.o.localeCompare(b.o) || a.r.localeCompare(b.r));
    const body = serialize(rows);
    const file = `${id}.json`;
    const path = `${OUT}/${file}`;
    const hash = createHash("sha256").update(body).digest("hex").slice(0, 12);
    const bytes = Buffer.byteLength(body);

    // Write only if content changed, so deploys stay small.
    if (existsSync(path) && readFileSync(path, "utf8") === body) {
      skipped++;
    } else {
      await Bun.write(path, body);
      written.push(file);
    }

    totalBytes += bytes;
    manifestShards.push({ id, file, count: rows.length, bytes });
  }

  // Remove shards that no longer have records (e.g. all sites died).
  // Files that are NOT shards must be preserved: reports.json is generated by
  // src/publish/reports.ts into the same directory, and an earlier version of
  // this loop deleted it on every run because it is not listed in the manifest.
  const currentIds = new Set(manifestShards.map((s) => s.file));
  const PRESERVE = new Set(["manifest.json", "reports.json"]);
  for (const entry of require("node:fs").readdirSync(OUT)) {
    if (PRESERVE.has(entry)) continue;
    if (entry.endsWith(".json") && !currentIds.has(entry)) {
      rmSync(`${OUT}/${entry}`);
      console.log(`[build] removed empty shard ${entry}`);
    }
  }

  const catTotals = new Map<string, number>();
  for (const rows of groups.values()) {
    for (const row of rows) {
      for (const c of row.c) catTotals.set(c, (catTotals.get(c) ?? 0) + 1);
    }
  }

  /**
   * Content fingerprint of the index, EXCLUDING the timestamp.
   *
   * This is what makes the build idempotent. The manifest carries
   * `generated_at`, which changes on every single run; writing it
   * unconditionally made the "unchanged" shards look stale to git and failed
   * CI's reproducibility check on every push, even though no data had actually
   * changed. The fingerprint compares only what the site would actually serve.
   */
  const indexFingerprint = createHash("sha256")
    .update(
      JSON.stringify({
        total: aliveForPublish.length,
        corpus_total: all.length,
        shards: manifestShards.map((s) => [s.file, s.count, s.bytes]),
        categories: CATEGORIES.map((id) => [id, catTotals.get(id) ?? 0]),
        schema: 2,
      }),
    )
    .digest("hex")
    .slice(0, 16);

  const manifest = {
    generated_at: new Date().toISOString(),
    fingerprint: indexFingerprint,
    total: aliveForPublish.length,
    corpus_total: all.length,
    shards: manifestShards,
    // Category vocabulary ships with the manifest so labels live in one place.
    categories: CATEGORIES.map((id) => ({
      id,
      label: CATEGORY_LABELS[id],
      count: catTotals.get(id) ?? 0,
    })),
    uncategorized: aliveForPublish.filter((r) => classify(r.topics ?? []).categories.length === 0).length,
    schema: 2,
  };

  /**
   * Only rewrite the manifest when the index content actually changed. When
   * only the timestamp would differ, keep the previous `generated_at` so the
   * file stays byte-identical and git sees no change.
   */
  const manifestPath = `${OUT}/manifest.json`;
  const prior = existsSync(manifestPath) ? safeParse(readFileSync(manifestPath, "utf8")) : null;
  const manifestChanged = !prior || prior.fingerprint !== indexFingerprint;
  if (!manifestChanged && prior.generated_at) {
    manifest.generated_at = prior.generated_at;
  }
  const manifestBody = JSON.stringify(manifest, null, 2);
  if (manifestChanged || !existsSync(manifestPath)) {
    await Bun.write(manifestPath, manifestBody);
  }

  const manifestBytes = Buffer.byteLength(manifestBody);
  const fmt = (b: number) => (b < 1024 ? `${b} B` : b < 1048576 ? `${(b / 1024).toFixed(1)} KB` : `${(b / 1048576).toFixed(2)} MB`);

  console.log(`\n[build] ${manifestShards.length} shards -> ${OUT}/`);
  console.log(`[build] wrote ${written.length}, unchanged ${skipped}`);
  console.log(`[build] index payload: ${fmt(totalBytes)} uncompressed across shards`);
  console.log(`[build] manifest: ${fmt(manifestBytes)}`);
  console.log(`[build] rough gzip estimate: ~${fmt(Math.round(totalBytes * 0.32))}`);

  // Decision support: at this corpus size, is sharding earning its complexity?
  const perShard = totalBytes / manifestShards.length;
  console.log(`\n[build] avg shard: ${fmt(perShard)}`);
  if (SHARDS > 1) {
    const fullLoadMB = totalBytes / 1048576;
    console.log(`[build] full-index load: ${fullLoadMB.toFixed(2)} MB (~${(fullLoadMB * 0.32).toFixed(2)} MB gzipped)`);
    if (fullLoadMB * 0.32 < 2) {
    console.log("[build] NOTE: gzipped full index is <2MB - consider --shards 1 (simpler) unless it grows");
    }
  }

  const biggest = [...manifestShards].sort((a, b) => b.bytes - a.bytes).slice(0, 3);
  console.log("[build] largest shards: " + biggest.map((s) => `${s.id}(${s.count})`).join(", "));
}

await main();
