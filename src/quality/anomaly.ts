/**
 * Probe anomaly detection.
 *
 * A crawler can fail quietly: GitHub tightens limits, a shard goes stale, DNS
 * starts flaking. The site keeps serving and nobody notices that discovery has
 * quietly stopped. This compares the current run against the previous one and
 * warns on regressions that are invisible from the published output alone.
 *
 * Writes a rolling history to src/quality/data/probe-history.json.
 *
 * Usage: bun run src/quality/anomaly.ts [--baseline path.json]
 */

import { existsSync, readFileSync, mkdirSync } from "node:fs";
import { PATHS } from "../paths";
import { readFileSync as rf } from "node:fs";
import { PATHS } from "../paths";

const DB = PATHS.corpus;
const HISTORY = PATHS.history;
mkdirSync("src/quality/data", { recursive: true });

/** Windows editors/PowerShell can prepend a BOM, which JSON.parse rejects. */
function readJson(path: string): any {
  return JSON.parse(readFileSync(path, "utf8").replace(/^\uFEFF/, ""));
}

const db = readJson(DB) as {
  records: Record<string, any>;
  stats: { harvestCalls: number; probesRun: number };
};
const all = Object.values(db.records);
const alive = all.filter((r) => r.liveness === "alive");
const probed = all.filter((r) => r.last_checked !== null);

const now = {
  at: new Date().toISOString(),
  corpus: all.length,
  alive: alive.length,
  alive_pct: all.length ? +((alive.length / all.length) * 100).toFixed(1) : 0,
  suspect: all.filter((r) => r.liveness === "suspect").length,
  flaky: all.filter((r) => r.liveness === "flaky").length,
  title_yield: probed.length
    ? +((probed.filter((r) => r.title !== null).length / probed.length) * 100).toFixed(1)
    : 0,
  desc_yield: probed.length
    ? +((probed.filter((r) => r.page_description !== null).length / probed.length) * 100).toFixed(1)
    : 0,
  never_probed: all.filter((r) => r.last_checked === null).length,
};

console.log("=== current ===");
for (const [k, v] of Object.entries(now)) {
  if (k === "at") continue;
  console.log(`  ${k.padEnd(14)} ${v}`);
}

let history: any[] = existsSync(HISTORY) ? readJson(HISTORY) : [];
const prev = history[history.length - 1];

const issues: string[] = [];
if (prev) {
  console.log(`\n=== vs previous run (${prev.at}) ===`);

  const delta = (k: string, cur: number, old: number, unit = "") => {
    const d = cur - old;
    const sign = d >= 0 ? "+" : "";
    console.log(`  ${k.padEnd(14)} ${old}${unit} -> ${cur}${unit}  (${sign}${d})`);
  };
  delta("corpus", now.corpus, prev.corpus);
  delta("alive", now.alive, prev.alive);
  delta("alive_pct", now.alive_pct, prev.alive_pct, "%");

  if (now.alive_pct < prev.alive_pct - 5) {
    issues.push(
      `alive rate dropped ${(prev.alive_pct - now.alive_pct).toFixed(1)}pts ` +
        `(${prev.alive_pct}% -> ${now.alive_pct}%). Possible: GitHub rate-limiting, ` +
        `network/DNS flakiness, or a real wave of sites dying.`,
    );
  }
  if (prev.corpus > 0 && now.corpus < prev.corpus * 0.98) {
    issues.push(
      `corpus shrank ${((prev.corpus - now.corpus) / prev.corpus * 100).toFixed(1)}%. ` +
        `The harvester may have failed or the DB was truncated.`,
    );
  }
  if (now.title_yield < prev.title_yield - 10) {
    issues.push(
      `title yield dropped ${(prev.title_yield - now.title_yield).toFixed(1)}pts. ` +
        `Metadata extraction may be broken.`,
    );
  }
  if (now.flaky > prev.flaky * 1.5 && prev.flaky > 20) {
    issues.push(
      `flaky records jumped ${prev.flaky} -> ${now.flaky}. Network or rate-limit problem.`,
    );
  }
} else {
  console.log("\n  (no history yet - this run becomes the baseline)");
}

if (now.never_probed > 0) {
    issues.push(`${now.never_probed} records have never been probed - run src/index/probe.ts`);
}
if (now.alive === 0) {
    issues.push("ZERO alive records - the index is about to be empty.");
}

history.push(now);
history = history.slice(-30); // keep a month of daily runs
await Bun.write(HISTORY, JSON.stringify(history, null, 2));

if (issues.length) {
  console.log(`\n=== ${issues.length} ANOMALY(IES) ===`);
  for (const i of issues) console.log(`  ! ${i}`);
  console.log("\nANOMALIES DETECTED");
  process.exit(1);
}
console.log("\nNO ANOMALIES");
