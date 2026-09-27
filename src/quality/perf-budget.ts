/**
 * Performance budget.
 *
 * A budget nobody measures is a wish. This measures what a real first-time
 * visitor actually downloads and fails the build on regression, so perf cannot
 * quietly rot across dozens of index rebuilds.
 *
 * Budgets are expressed GZIPPED, because that is what the wire cost is. Raw
 * sizes are reported for context.
 *
 * Usage: bun run src/quality/perf-budget.ts            # check against budget
 *        bun run src/quality/perf-budget.ts --write    # record current as the budget
 */

import { readFileSync, existsSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { gzipSync, constants } from "node:zlib";
import { PATHS } from "../paths";

const BUDGET_FILE = PATHS.budget;

/** Critical path for a first visit: shell, script, worker, manifest. */
const CRITICAL = [
  `${PATHS.site}/index.html`,
  `${PATHS.site}/app.js`,
  `${PATHS.site}/search-worker.js`,
  `${PATHS.site}/favicon.svg`,
];
/** Worst case: everything, because a user can browse every shard. */
const ALL_PREFIX = `${PATHS.data}/`;

function gz(path: string): number {
  return gzipSync(readFileSync(path), { level: constants.Z_BEST_COMPRESSION }).length;
}

function walk(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((f) => {
    const p = `${dir}/${f}`;
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

// ---- measure ----
const critical = CRITICAL.filter(existsSync).map((p) => ({ path: p, raw: statSync(p).size, gz: gz(p) }));
const dataFiles = walk(ALL_PREFIX);
const data = dataFiles.map((p) => ({ path: p, raw: statSync(p).size, gz: gz(p) }));

const criticalRaw = critical.reduce((a, f) => a + f.raw, 0);
const criticalGz = critical.reduce((a, f) => a + f.gz, 0);
const dataRaw = data.reduce((a, f) => a + f.raw, 0);
const dataGz = data.reduce((a, f) => a + f.gz, 0);
const largest = [...data].sort((a, b) => b.gz - a.gz)[0];

const bytesPerRecord = data.length ? dataRaw / (readManifestTotal() || 1) : 0;
const recordTotal = readManifestTotal();

function readManifestTotal(): number {
  const p = `${PATHS.data}/manifest.json`;
  if (!existsSync(p)) return 0;
  try {
    return (JSON.parse(readFileSync(p, "utf8")) as { total: number }).total;
  } catch {
    return 0;
  }
}

const fmt = (b: number) =>
  b < 1024 ? `${b} B` : b < 1048576 ? `${(b / 1024).toFixed(1)} KB` : `${(b / 1048576).toFixed(2)} MB`;

const measured = {
  captured_at: new Date().toISOString(),
  records: recordTotal,
  critical_raw: criticalRaw,
  critical_gz: criticalGz,
  data_raw: dataRaw,
  data_gz: dataGz,
  largest_shard_gz: largest?.gz ?? 0,
  bytes_per_record: Math.round(bytesPerRecord),
};

console.log("=== payload (gzipped = wire cost) ===");
for (const f of critical) console.log(`  ${f.path.padEnd(26)} ${fmt(f.raw).padStart(9)} raw  ${fmt(f.gz).padStart(9)} gz`);
console.log(`  ${"CRITICAL TOTAL".padEnd(26)} ${fmt(criticalRaw).padStart(9)} raw  ${fmt(criticalGz).padStart(9)} gz`);
console.log(`\n  data shards: ${data.length} files, ${fmt(dataRaw)} raw, ${fmt(dataGz)} gz`);
console.log(`  largest single shard: ${largest?.path} ${fmt(largest?.gz ?? 0)} gz`);
console.log(`  records: ${recordTotal.toLocaleString()}  (${measured.bytes_per_record} raw bytes/record)`);
console.log(`  full-index load (worst case): ${fmt(dataGz)} gz`);

// ---- budget ----
const LIMITS = {
  // Shell + JS must stay tiny: this is the every-visit cost.
  critical_gz: 60 * 1024,
  // A single shard is what one query loads. Cap it so first search is fast.
  largest_shard_gz: 250 * 1024,
  // Growth guard: bytes/record should not creep. Descriptions and topics are
  // the usual culprits; 400 means someone added an unbounded field.
  bytes_per_record: 400,
};

if (process.argv.includes("--write")) {
  writeFileSync(BUDGET_FILE, JSON.stringify({ limits: LIMITS, baseline: measured }, null, 2));
  console.log(`\n[budget] recorded baseline -> ${BUDGET_FILE}`);
  process.exit(0);
}

console.log("\n=== budget check ===");
let fail = 0;
const check = (name: string, actual: number, limit: number) => {
  const ok = actual <= limit;
  const pct = ((actual / limit) * 100).toFixed(0);
  console.log(
    `  ${ok ? "PASS" : "FAIL"}  ${name.padEnd(24)} ${fmt(actual).padStart(9)} / ${fmt(limit).padStart(9)}  (${pct}% of budget)`,
  );
  if (!ok) fail++;
};

check("critical path gz", criticalGz, LIMITS.critical_gz);
check("largest shard gz", measured.largest_shard_gz, LIMITS.largest_shard_gz);
if (recordTotal > 0) check("bytes per record", measured.bytes_per_record, LIMITS.bytes_per_record);

if (existsSync(BUDGET_FILE)) {
  const prev = JSON.parse(readFileSync(BUDGET_FILE, "utf8")) as {
    baseline: { critical_gz: number; data_gz: number; records: number };
  };
  const growth = (prev.baseline.records > 0 ? recordTotal / prev.baseline.records : 1) * 100;
  console.log(
    `\n  baseline: ${prev.baseline.records.toLocaleString()} records, ` +
      `${fmt(prev.baseline.data_gz)} gz -> now ${recordTotal.toLocaleString()} records, ${fmt(dataGz)} gz`,
  );
  console.log(`  corpus growth: ${growth.toFixed(1)}%`);
  if (growth > 300) {
    console.log("  WARN  corpus more than tripled; re-check the sharding strategy");
  }
}

console.log(`\n${fail === 0 ? "PERF BUDGET OK" : `${fail} BUDGET VIOLATION(S)`}`);
process.exit(fail === 0 ? 0 : 1);
