/**
 * Fault-injection test for src/quality/anomaly.ts: a detector that has never fired is
 * indistinguishable from a detector that cannot fire. This mutates the history
 * to simulate a degraded run and asserts the detector reports it.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { PATHS } from "../paths";

const H = "src/quality/data/probe-history.json";
const original = readFileSync(H, "utf8");
const hist = JSON.parse(original);

if (hist.length < 1) {
  console.log("  SKIP  no history to mutate; run `bun run src/quality/anomaly.ts` first");
  process.exit(0);
}

// Rewrite the most recent baseline as a "healthy past" so the current state
// looks like a regression.
//
// The injected numbers are derived from the LIVE corpus, not hardcoded and not
// copied from history. This fixture previously claimed a healthy past of
// alive=9000/corpus=9000, which was only ever correct while the corpus was
// smaller than 9,000. Once the real corpus grew past that, the "regression" it
// injected was an improvement, the detector correctly declined to fire, and the
// test failed while the detector was working exactly as intended. Deriving from
// the corpus keeps the fixture a regression no matter how much the index grows.
const corpusDb = JSON.parse(readFileSync(PATHS.corpus, "utf8"));
const live = Object.values<any>(corpusDb.records ?? {});
const liveAlive = live.filter((r) => r?.liveness === "alive").length;
const livePct = live.length ? (liveAlive / live.length) * 100 : 0;
const liveProbed = live.filter((r) => r?.last_checked);
const liveTitlePct = liveProbed.length
  ? (liveProbed.filter((r) => r?.title).length / liveProbed.length) * 100
  : 0;

const last = hist[hist.length - 1];
// Above the live values by enough to clear each detector's threshold, but
// below the caps that would make the injected "healthy past" absurd.
last.alive_pct = Math.min(99, livePct + 13);
last.alive = Math.round(liveAlive * 1.1);
last.corpus = Math.round(live.length * 1.1);
last.title_yield = Math.min(99, liveTitlePct + 20);
last.flaky = Math.max(0, Math.round(live.filter((r) => r?.liveness === "flaky").length / 2));
writeFileSync(H, JSON.stringify(hist, null, 2));
console.log(
  `  live corpus ${live.length} (${livePct.toFixed(1)}% alive) -> injected healthy past: ` +
    `alive_pct=${last.alive_pct.toFixed(1)}, corpus=${last.corpus}, title_yield=${last.title_yield.toFixed(1)}`,
);

const proc = Bun.spawn(["bun", "run", "src/quality/anomaly.ts"], { stdout: "pipe", stderr: "pipe" });
const out = await new Response(proc.stdout).text();
const code = await proc.exited;

writeFileSync(H, original);

const fired = code === 1 && /ANOMALIES DETECTED/.test(out);
const checks = [
  ["exits non-zero on regression", code === 1],
  ["reports ANOMALIES DETECTED", /ANOMALIES DETECTED/.test(out)],
  ["flags alive-rate drop", /alive rate dropped/.test(out)],
  ["flags corpus shrink", /corpus shrank/.test(out)],
  ["flags title-yield drop", /title yield dropped/.test(out)],
];

let fail = 0;
for (const [name, ok] of checks) {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}`);
  if (!ok) fail++;
}
if (!fired) console.log("\n  detector output was:\n" + out.split("\n").map((l) => "    " + l).join("\n"));
console.log(`\n${fail === 0 ? "ANOMALY DETECTOR VERIFIED" : `${fail} CHECK(S) FAILED`}`);
process.exit(fail === 0 ? 0 : 1);
