/**
 * Unit tests for the per-star-band publish quota (src/publish/star-quota.ts).
 *
 * Why this has its own file: build.ts calls main() at import time, so the rule
 * cannot be tested where it is applied without rebuilding the whole index.
 *
 * What is being defended
 * ----------------------
 * The rule exists to stop the 0-99 band (4,868 of 7,813 sites) from drowning out
 * every other level of popularity. That means the two ways it could be wrong are
 * both silent: keep too few (a good band is thinned for no reason) or keep the
 * wrong ones (a band is full of templates because stars cannot tell a portfolio
 * from a resume). Both are asserted below against synthetic corpora, and the
 * band edges are pinned because every count in the comment block depends on them.
 */

import { applyStarQuota, bandOf, STAR_BANDS, STAR_QUOTA } from "./star-quota";

let fail = 0;
let checks = 0;
const eq = (name: string, got: unknown, want: unknown) => {
  checks++;
  if (JSON.stringify(got) === JSON.stringify(want)) {
    console.log(`  PASS  ${name}`);
  } else {
    fail++;
    console.log(`  FAIL  ${name}\n          got:  ${JSON.stringify(got)}\n          want: ${JSON.stringify(want)}`);
  }
};
const ok = (name: string, cond: boolean, detail = "") => {
  checks++;
  if (cond) {
    console.log(`  PASS  ${name}`);
  } else {
    fail++;
    console.log(`  FAIL  ${name}${detail ? `\n          ${detail}` : ""}`);
  }
};

const rec = (stars: number, extra: Record<string, unknown> = {}) => ({
  stars,
  description: "",
  topics: [],
  owner: "o",
  ...extra,
});
const count = (rows: any[], lo: number, hi: number) =>
  rows.filter((r) => (r.stars ?? 0) >= lo && (r.stars ?? 0) < hi).length;

// --- band edges -------------------------------------------------------------
// Pinned because the comment block quotes 4,868 / 1,545 / 1,141 / 259 from the
// real corpus, and a band edge moving by one silently invalidates every number.
eq(
  "band edges are 100 / 1k / 10k",
  STAR_BANDS.map((b) => [b.lo, b.hi === Infinity ? null : b.hi]),
  [[0, 100], [100, 1000], [1000, 10000], [10000, null]],
);
eq("bandOf puts 0 and 99 together", [bandOf(0), bandOf(99)], ["0-99", "0-99"]);
eq("bandOf boundary 100", bandOf(100), "100-999");
eq("bandOf boundary 1000", bandOf(1000), "1k-9.9k");
eq("bandOf boundary 10000", bandOf(10000), "10k+");
eq("shipped quota is 600", STAR_QUOTA, 600);

// --- the cap holds, per band -----------------------------------------------
{
  const big = [
    ...Array.from({ length: 4868 }, () => rec(12)),
    ...Array.from({ length: 1545 }, () => rec(400)),
    ...Array.from({ length: 1141 }, () => rec(3000)),
    ...Array.from({ length: 259 }, () => rec(40000)),
  ];
  const kept = applyStarQuota(big);
  eq(
    "real-shaped corpus keeps 600/600/600/259",
    [count(kept, 0, 100), count(kept, 100, 1000), count(kept, 1000, 10000), count(kept, 10000, Infinity)],
    [600, 600, 600, 259],
  );
  eq("total is 2059", kept.length, 2059);
  eq("dropped is 5754", big.length - kept.length, 5754);
  ok("no band exceeds the quota", STAR_BANDS.every((b) => count(kept, b.lo, b.hi) <= STAR_QUOTA));
  ok(
    "the 10k band is never cut (only 259 exist)",
    big.filter((r) => r.stars >= 10000).every((r) => kept.includes(r)),
  );
}

// --- nothing is lost that was under the cap ---------------------------------
{
  const small = [rec(1), rec(99), rec(100), rec(999), rec(1000), rec(9999), rec(10000), rec(500000)];
  eq("an under-quota corpus passes through untouched", applyStarQuota(small).length, 8);
  ok("under-quota rows are the same objects", applyStarQuota(small).every((r, i) => r === small[i]));
}

// --- selection is the highest-starred, and ties are broken deliberately ------
{
  // 0-99 band, all tied on stars, so only the tiebreak can decide.
  const tied = [
    rec(50, { owner: "b", description: "" }),
    rec(50, { owner: "a", description: "x" }),
    rec(50, { owner: "c", description: "xxxx" }),
  ];
  const kept = applyStarQuota(tied, 2);
  eq("ties keep the longer descriptions first", kept.map((r) => r.owner), ["c", "a"]);

  const topicsWin = [
    rec(50, { owner: "z", description: "x", topics: [] }),
    rec(50, { owner: "y", description: "x", topics: ["a", "b"] }),
  ];
  eq("with descriptions equal, topic count decides", applyStarQuota(topicsWin, 1).map((r) => r.owner), ["y"]);

  const ownerBreaks = [rec(50, { owner: "z" }), rec(50, { owner: "a" })];
  eq("with everything equal, owner is a stable last resort", applyStarQuota(ownerBreaks, 1).map((r) => r.owner), ["a"]);

  // The important one: the same input must give the same answer every run, or
  // the published index churns for no reason.
  const noise = Array.from({ length: 200 }, (_, i) => rec(i % 7 === 0 ? 50 : 10, { owner: `o${i % 3}` }));
  const runs = [0, 1, 2].map(() => applyStarQuota(noise, 25).map((r) => r.owner).join(","));
  ok("selection is deterministic across runs", new Set(runs).size === 1);
  eq("a re-run does not mutate the input", noise.length, 200);
}

// --- input shapes that would otherwise throw or silently vanish ------------
{
  const messy = [rec(null as any), rec(undefined as any), rec(0), rec(12)];
  eq("null and undefined stars count as 0", applyStarQuota(messy).length, 4);
  eq("a quota of 0 disables the rule", applyStarQuota(messy, 0).length, 4);
  ok("a disabled quota copies rather than aliases", applyStarQuota(messy, 0) !== messy);
  ok("an empty corpus does not throw", applyStarQuota([]).length === 0);
  ok(
    "missing description and topics do not throw",
    applyStarQuota([{ stars: 5 } as any, { stars: 6 } as any], 1).length === 1,
  );
}

console.log(fail === 0 ? `\n[test-star-quota] ${checks} checks passed` : `\n[test-star-quota] ${fail}/${checks} FAILED`);
process.exit(fail === 0 ? 0 : 1);
