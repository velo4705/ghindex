/**
 * M0 gate report — turns probe-results.json into the four go/no-go numbers.
 */
import { readFileSync } from "node:fs";

interface ProbeResult {
  domain: string;
  status: number;
  finalUrl: string | null;
  error: string | null;
  blocksFraming: boolean | null;
  hasTitle: boolean | null;
  hasDescription: boolean | null;
}

const data = JSON.parse(readFileSync("m0/data/probe-results.json", "utf8")) as {
  universe: number;
  indexableUniverse: number;
  structurallyUnreachable: number;
  sampleSize: number;
  seconds: number;
  results: ProbeResult[];
};
const r = data.results;
const n = r.length;
const pct = (x: number) => `${((x / n) * 100).toFixed(1)}%`;

// --- Metric 2: liveness ---
const live = r.filter((x) => x.status >= 200 && x.status < 300);
const dead = r.filter((x) => x.status >= 400);
const err = r.filter((x) => x.error !== null && x.status === 0);
const redirectOnly = r.filter((x) => x.status >= 300 && x.status < 400);
const other = n - live.length - dead.length - err.length - redirectOnly.length;

// --- Metric 3: framing ---
const alive = live.filter((x) => x.blocksFraming !== null);
const blocks = alive.filter((x) => x.blocksFraming === true);

// --- Metric 4: metadata (only measured on GET-able HTML) ---
const withTitle = r.filter((x) => x.hasTitle === true);
const withDesc = r.filter((x) => x.hasDescription === true);
const both = r.filter((x) => x.hasTitle === true && x.hasDescription === true);
const descOfLive = live.length ? withDesc.length / live.length : 0;

const line = (s: string) => console.log(s);
line("=".repeat(64));
line("  M0 FEASIBILITY GATE — ghindex");
line("=".repeat(64));
line("");
line(`  Harvested from crt.sh (LOWER BOUND): ${data.universe} names`);
line(`  Structurally unreachable:            ${data.structurallyUnreachable}  (a.b.github.io — no valid cert)`);
line(`  Indexable (owner.github.io):        ${data.indexableUniverse}`);
line(`  Probed:                             ${n}`);
line("");
line("--- METRIC 2: liveness -------------------------------------");
line(`  alive (2xx)      ${String(live.length).padStart(4)}  ${pct(live.length)}`);
line(`  dead (4xx/5xx)   ${String(dead.length).padStart(4)}  ${pct(dead.length)}`);
line(`  network error    ${String(err.length).padStart(4)}  ${pct(err.length)}`);
line(`  3xx unfollowed   ${String(redirectOnly.length).padStart(4)}  ${pct(redirectOnly.length)}`);
line(`  other            ${String(other).padStart(4)}  ${pct(other)}`);
line("");
line("--- METRIC 3: framing (iframes in Grid view) --------------");
line(`  measurable       ${String(alive.length).padStart(4)}  of ${live.length} alive`);
line(`  BLOCK framing    ${String(blocks.length).padStart(4)}  ${pct(blocks.length)}`);
line(`  allow framing    ${String(alive.length - blocks.length).padStart(4)}  ${
  alive.length ? (((alive.length - blocks.length) / alive.length) * 100).toFixed(1) + "%" : "n/a"
}`);
line("");
line("--- METRIC 4: metadata yield -------------------------------");
line(`  has <title>      ${String(withTitle.length).padStart(4)}  ${pct(withTitle.length)}`);
line(`  has description  ${String(withDesc.length).padStart(4)}  ${pct(withDesc.length)}`);
line(`  has both         ${String(both.length).padStart(4)}  ${pct(both.length)}`);
line(`  desc / live      ${(descOfLive * 100).toFixed(1)}%`);
line("");
line("--- VERDICT -----------------------------------------------");
const liveRate = live.length / n;
const blockRate = alive.length ? blocks.length / alive.length : 1;
const gridOk = blockRate < 0.3;
line(`  live rate ${(liveRate * 100).toFixed(1)}%  -> ${
  liveRate > 0.5 ? "PASS" : liveRate > 0.3 ? "MARGINAL" : "FAIL"
} (need >50% to be a directory, not a graveyard)`);
line(`  framing blocked ${(blockRate * 100).toFixed(1)}%  -> ${
  gridOk ? "PASS: iframes viable" : "FAIL: must build screenshot pipeline"
}`);
line(`  description yield ${(descOfLive * 100).toFixed(1)}%  -> ${
  descOfLive > 0.4 ? "PASS" : "MARGINAL: descriptions will be sparse"
}`);
line("");
line(`  extrapolated live sites from ${data.indexableUniverse} indexable: ~${Math.round(
  data.indexableUniverse * liveRate,
).toLocaleString()}`);
line(
  `  probe throughput: ${(n / (data.seconds || 1)).toFixed(0)} domains/sec at concurrency 24`,
);
line("");
line("  CAVEAT 1: crt.sh throttled us (5,055 certs -> 323 names, 43 indexable).");
line("  The true census is far larger; these rates are the signal, not totals.");
line(`  CAVEAT 2: n=${n} is a small sample. Treat percentages as directional.`);
line("=".repeat(64));

// Status breakdown, to see what 'dead' actually looks like.
const byStatus = new Map<number, number>();
for (const x of r) byStatus.set(x.status, (byStatus.get(x.status) ?? 0) + 1);
line("");
line("  status codes: " + [...byStatus.entries()].sort((a, b) => b[1] - a[1])
  .map(([s, c]) => `${s || "ERR"}:${c}`).join("  "));
