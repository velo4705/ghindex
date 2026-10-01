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
/**
 * Freshness is measured from the newest probe in the CORPUS, not from the
 * manifest's `generated_at`.
 *
 * Those are not the same question, and conflating them made a healthy pipeline
 * look broken. The build deliberately freezes `generated_at` on a no-op rebuild
 * so the manifest stays byte-identical and git sees no diff (see
 * test-idempotent.ts). That means `generated_at` answers "when did the content
 * last change", which can legitimately be weeks ago on a stable index. Reading
 * it as "when did we last check" reported a 72h-old healthy index as STALE and
 * turned CI red for a run that had actually just succeeded.
 *
 * The question health should ask is whether the probe pipeline is still
 * running, and only the corpus knows that: its newest `last_checked` moves on
 * every successful sweep, whether or not any verdict changed.
 */
let freshestChecked = 0;
if (existsSync(PATHS.corpus)) {
  try {
    const corpus = JSON.parse(readFileSync(PATHS.corpus, "utf8"));
    for (const rec of Object.values<any>(corpus.records ?? {})) {
      const t = rec?.last_checked ? Date.parse(rec.last_checked) : NaN;
      if (!Number.isNaN(t) && t > freshestChecked) freshestChecked = t;
    }
  } catch (e) {
    warn(`corpus could not be read for staleness: ${e}`);
  }
}

if (freshestChecked === 0) {
  err("no record in the corpus has been probed - cannot detect staleness");
} else {
  const ageH = (Date.now() - freshestChecked) / 3_600_000;
  if (ageH > MAX_AGE_H) {
    err(`data is STALE: newest probe ${ageH.toFixed(1)}h ago (limit ${MAX_AGE_H}h). The refresh job is probably failing.`);
  } else {
    ok(`newest probe ${ageH.toFixed(1)}h ago (limit ${MAX_AGE_H}h)`);
  }
  // Reported for context only. Frozen on no-op rebuilds, by design.
  const gen = manifest.generated_at ? Date.parse(manifest.generated_at) : NaN;
  if (!Number.isNaN(gen)) {
    ok(`index content last changed ${((Date.now() - gen) / 3_600_000).toFixed(1)}h ago`);
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
// Only files the build actually emits as shards should be checked for orphans.
// reports.json is a report artifact, not an index shard, so treating it as an
// orphan was a false alarm on every run.
const { readdirSync } = await import("node:fs");
const NOT_SHARDS = new Set(["manifest.json", "reports.json"]);
const onDisk = readdirSync(PATHS.data).filter(
  (f) => f.endsWith(".json") && !NOT_SHARDS.has(f),
);
const listed = new Set(manifest.shards.map((s: any) => s.file));
const orphans = onDisk.filter((f) => !listed.has(f));
if (orphans.length === 0) ok("no orphaned shard files");
else warn(`orphaned (unreferenced) shards: ${orphans.join(", ")}`);

// ---- every published URL must be backed by a live record ----
if (existsSync(PATHS.corpus)) {
  const db = readJson(PATHS.corpus) as {
    records: Record<string, any>;
  };
  const norm = (u: string) => u.replace(/\/+$/, "").toLowerCase();

  // Index the corpus by normalised URL so we can ask which record actually
  // backs each published URL.
  const aliveBacking = new Set<string>();
  const nonAliveAliases: string[] = [];
  for (const r of Object.values(db.records)) {
    if (!r.url) continue;
    const key = norm(r.url);
    if (r.liveness === "alive") aliveBacking.add(key);
    else nonAliveAliases.push(`${r.full_name} (${r.liveness}) -> ${r.url}`);
  }

  // A dead link is served only when the PUBLISHED URL has no live record
  // behind it. The build dedupes by URL across publishable (alive) records
  // only, so a published URL is always backed by an alive record; the
  // non-alive records that share it are unpublished aliases, not served rows.
  //
  // The previous version of this check flagged those aliases as leaked dead
  // links, which was wrong: it asked "does a non-alive record point at this
  // URL?" rather than "is the published copy of this URL live?". With
  // tarrex/hugo-theme-online-resume alive and tarrex/online-resume flaky on
  // the same URL it reported a dead link that was never served.
  const unserved = [...seenUrls].filter((u) => !aliveBacking.has(norm(u)));
  if (unserved.length === 0) {
    ok(`every published URL (${seenUrls.size}) is backed by a live record`);
  } else {
    err(
      `${unserved.length} published URL(s) have no live record behind them: ` +
        unserved.slice(0, 3).join("; "),
    );
  }

  // Alias collisions are data hygiene, not a serving bug: worth seeing, not
  // worth failing CI over.
  const aliasCollisions = nonAliveAliases.filter((s) => {
    const url = s.slice(s.indexOf("-> ") + 3);
    return seenUrls.has(norm(url));
  });
  if (aliasCollisions.length) {
    warn(
      `${aliasCollisions.length} non-alive repo(s) alias a published URL ` +
        `(harmless; the live record is the one served): ${aliasCollisions.slice(0, 2).join("; ")}`,
    );
  }

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
