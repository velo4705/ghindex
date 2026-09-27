/**
 * Index health check.
 *
 * A silently-dead cron means a silently-rotting directory: the site keeps
 * serving, but nothing updates and nobody notices. This validates the published
 * index and detects staleness, so CI can go red when the pipeline breaks.
 *
 * Checks:
 *   - manifest is well-formed and self-consistent (shard counts sum to total)
 *   - every shard referenced by the manifest exists and parses
 *   - no orphaned shard files on disk
 *   - no duplicate URLs across shards
 *   - no dead links published (a published record must have been probed alive)
 *   - every record has a valid github.io URL
 *   - index is not stale relative to the last successful probe
 *
 * Usage: bun run src/quality/health.ts [--max-age-hours 48] [--strict]
 */

import { readFileSync, existsSync } from "node:fs";
import { PATHS } from "../paths";

const args = process.argv.slice(2);
const argNum = (flag: string, dflt: number) => {
  const i = args.indexOf(flag);
  return i >= 0 ? Number(args[i + 1]) : dflt;
};
const MAX_AGE_H = argNum("--max-age-hours", 48);
const STRICT = args.includes("--strict");

let errors = 0;
let warnings = 0;

/** Windows editors/PowerShell can prepend a BOM, which JSON.parse rejects. */
function readJson(path: string): any {
  return JSON.parse(readFileSync(path, "utf8").replace(/^\uFEFF/, ""));
}

const err = (m: string) => { console.log(`  ERROR    ${m}`); errors++; };
const warn = (m: string) => { console.log(`  WARNING  ${m}`); warnings++; };
const ok = (m: string) => console.log(`  ok       ${m}`);

const MANIFEST = `${PATHS.data}/manifest.json`;
if (!existsSync(MANIFEST)) {
  err("manifest missing - run: bun run src/publish/build.ts");
  process.exit(1);
}

console.log("=== index health ===\n");

// ---- manifest ----
let manifest: any;
try {
  manifest = JSON.parse(readFileSync(MANIFEST, "utf8"));
} catch (e) {
  err(`manifest is not valid JSON: ${e}`);
  process.exit(1);
}

if (!Array.isArray(manifest.shards) || manifest.shards.length === 0) err("manifest has no shards");
if (typeof manifest.total !== "number" || manifest.total <= 0) err("manifest.total is missing or zero");
if (manifest.schema !== 2) warn(`manifest schema is ${manifest.schema}, expected 2`);

// ---- staleness ----
const gen = manifest.generated_at ? Date.parse(manifest.generated_at) : NaN;
if (Number.isNaN(gen)) {
    err("manifest.generated_at is missing or unparseable - cannot detect staleness");
} else {
  const ageH = (Date.now() - gen) / 3_600_000;
  if (ageH > MAX_AGE_H) {
    err(`index is STALE: built ${ageH.toFixed(1)}h ago (limit ${MAX_AGE_H}h). The refresh job is probably failing.`);
  } else {
    ok(`index age ${ageH.toFixed(1)}h (limit ${MAX_AGE_H}h)`);
  }
}

// ---- shards exist and parse ----
const seenUrls = new Set<string>();
let dupes = 0;
let badUrls = 0;
let totalRecords = 0;
let countMismatch = 0;

for (const s of manifest.shards) {
  const p = `${PATHS.data}/${s.file}`;
  if (!existsSync(p)) {
    err(`shard ${s.file} listed in manifest but missing on disk`);
    continue;
  }
  let rows: any[];
  try {
    rows = JSON.parse(readFileSync(p, "utf8"));
  } catch (e) {
    err(`shard ${s.file} is not valid JSON: ${e}`);
    continue;
  }
  if (!Array.isArray(rows)) {
    err(`shard ${s.file} is not an array`);
    continue;
  }
  if (s.count !== undefined && s.count !== rows.length) {
    warn(`shard ${s.file} manifest says ${s.count} records, file has ${rows.length}`);
    countMismatch++;
  }
  totalRecords += rows.length;

  for (const r of rows) {
    if (!r?.u || !/^https?:\/\/[^/]+\.github\.io(\/.*)?$/.test(r.u)) {
      badUrls++;
      if (badUrls <= 3) err(`invalid github.io URL in ${s.file}: ${JSON.stringify(r?.u)}`);
    }
    if (seenUrls.has(r?.u)) dupes++;
    seenUrls.add(r?.u);
  }
}

if (badUrls === 0) ok("all published URLs are valid github.io links");
if (dupes === 0) ok(`no duplicate URLs across ${manifest.shards.length} shards`);
  else err(`${dupes} duplicate URLs published - sharding or dedup is broken`);

const sum = manifest.shards.reduce((a: number, s: any) => a + (s.count ?? 0), 0);
if (sum !== manifest.total) {
  err(`manifest.total (${manifest.total}) != sum of shard counts (${sum})`);
} else {
  ok(`manifest consistent: ${manifest.total.toLocaleString()} records across ${manifest.shards.length} shards`);
}
if (countMismatch) warn(`${countMismatch} shard(s) had a count mismatch`);

// ---- orphaned shards ----
const { readdirSync } = await import("node:fs");
  const onDisk = readdirSync(PATHS.data).filter((f) => f.endsWith(".json") && f !== "manifest.json");
const listed = new Set(manifest.shards.map((s: any) => s.file));
const orphans = onDisk.filter((f) => !listed.has(f));
if (orphans.length === 0) ok("no orphaned shard files");
else warn(`orphaned (unreferenced) shards: ${orphans.join(", ")}`);

// ---- published set must be the alive set ----
if (existsSync(PATHS.corpus)) {
  const db = readJson(PATHS.corpus) as {
    records: Record<string, any>;
  };
  let nonAlive = 0;
  for (const r of Object.values(db.records)) {
    if (r.liveness === "alive" && !seenUrls.has(r.url)) continue; // fine
    if (r.liveness !== "alive" && seenUrls.has(r.url)) nonAlive++;
  }
  if (nonAlive === 0) ok("no dead/uncategorised records leaked into the published index");
  else err(`${nonAlive} non-alive records are published - dead links are being served`);

  const neverProbed = [...seenUrls].filter((u) => {
    const rec = Object.values(db.records).find((r) => r.url === u);
    return rec && rec.last_checked === null;
  });
  if (neverProbed.length === 0) ok("every published record has been probed at least once");
  else err(`${neverProbed.length} published records were never probed`);
}

// ---- categories ----
if (Array.isArray(manifest.categories)) {
  const withCats = manifest.categories.filter((c: any) => c.count > 0);
  if (withCats.length === 0) warn("no category has any records - classifier may be broken");
  else ok(`categories populated: ${withCats.map((c: any) => `${c.id}=${c.count}`).join(" ")}`);
  const sumCats = manifest.categories.reduce((a: number, c: any) => a + c.count, 0);
  if (sumCats < manifest.total * 0.5) {
    warn(`category coverage low: ${((sumCats / manifest.total) * 100).toFixed(0)}% of records categorised`);
  }
} else {
  err("manifest has no categories array");
}

console.log(`\n  ${errors} error(s), ${warnings} warning(s)`);
const failed = errors > 0 || (STRICT && warnings > 0);
console.log(failed ? "\nINDEX UNHEALTHY" : "\nINDEX HEALTHY");
process.exit(failed ? 1 : 0);
