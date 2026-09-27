/**
 * Fault-injection test for src/quality/anomaly.ts: a detector that has never fired is
 * indistinguishable from a detector that cannot fire. This mutates the history
 * to simulate a degraded run and asserts the detector reports it.
 */
import { readFileSync, writeFileSync } from "node:fs";

const H = "src/quality/data/probe-history.json";
const original = readFileSync(H, "utf8");
const hist = JSON.parse(original);

if (hist.length < 1) {
  console.log("  SKIP  no history to mutate; run `bun run src/quality/anomaly.ts` first");
  process.exit(0);
}

// Rewrite the most recent baseline as a "healthy past" so the current state
// looks like a regression.
const last = hist[hist.length - 1];
last.alive_pct = 92.0;
last.alive = 9000;
last.corpus = 9000;
last.title_yield = 90.0;
last.flaky = 50;
writeFileSync(H, JSON.stringify(hist, null, 2));
console.log(`  injected degraded baseline: alive_pct=92.0, corpus=9000, title_yield=90.0`);

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
