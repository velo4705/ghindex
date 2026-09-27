/**
 * Probe the GitHub-API-derived population to answer M0's open question:
 * is 44.2% liveness real, or an artifact of CT logs skewing to old/abandoned
 * repos? Same probe methodology as m0/probe.ts so the numbers are comparable.
 */
import { readFileSync } from "node:fs";

const UA =
  "Mozilla/5.0 (compatible; ghindex-m0/0.1; +https://github.com/; feasibility spike)";
const CONCURRENCY = 20;
const TIMEOUT_MS = 15_000;

interface Repo {
  full_name: string;
  url: string;
  homepage: string | null;
  stars: number;
}

interface Res {
  full_name: string;
  url: string;
  status: number;
  error: string | null;
  blocksFraming: boolean | null;
  hasTitle: boolean | null;
  hasDescription: boolean | null;
}

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

async function one(repo: Repo): Promise<Res> {
  const base: Res = {
    full_name: repo.full_name,
    url: repo.url,
    status: 0,
    error: null,
    blocksFraming: null,
    hasTitle: null,
    hasDescription: null,
  };
  let res: Response;
  try {
    res = await fetch(repo.url, {
      method: "HEAD",
      redirect: "follow",
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { "User-Agent": UA },
    });
  } catch (e) {
    return { ...base, error: String(e).slice(0, 100) };
  }
  base.status = res.status;
  base.blocksFraming = blocksFraming(res.headers);
  if (!res.ok) return base;
  try {
    const g = await fetch(res.url, {
      redirect: "follow",
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { "User-Agent": UA, Accept: "text/html" },
    });
    if (!(g.headers.get("content-type") ?? "").includes("html")) return base;
    const html = await g.text();
    base.hasTitle = titleOf(html) !== null;
    base.hasDescription = descOf(html) !== null;
  } catch {}
  return base;
}

const repos = JSON.parse(readFileSync("m0/data/github-repos.json", "utf8")) as Repo[];
console.log(`[probe] probing ${repos.length} GitHub-API-derived Pages sites`);

const t0 = Date.now();
const out: Res[] = new Array(repos.length);
let cursor = 0;
await Promise.all(
  Array.from({ length: CONCURRENCY }, async () => {
    for (;;) {
      const i = cursor++;
      if (i >= repos.length) return;
      out[i] = await one(repos[i]);
    }
  }),
);
const secs = (Date.now() - t0) / 1000;
console.log(`[probe] done in ${secs.toFixed(1)}s`);

await Bun.write("m0/data/github-probe.json", JSON.stringify(out, null, 2));

const n = out.length;
const live = out.filter((r) => r.status >= 200 && r.status < 300);
const dead = out.filter((r) => r.status >= 400);
const err = out.filter((r) => r.error !== null);
const blocks = live.filter((r) => r.blocksFraming === true);
const title = out.filter((r) => r.hasTitle === true);
const desc = out.filter((r) => r.hasDescription === true);
const pc = (x: number) => `${((x / n) * 100).toFixed(1)}%`;

console.log("\n=== GITHUB-API POPULATION (vs CT-log population) ===");
console.log(`  live (2xx)       ${String(live.length).padStart(4)}  ${pc(live.length)}`);
console.log(`  dead (4xx/5xx)   ${String(dead.length).padStart(4)}  ${pc(dead.length)}`);
console.log(`  network error    ${String(err.length).padStart(4)}  ${pc(err.length)}`);
console.log(`  framing blocked  ${String(blocks.length).padStart(4)}  ${
  live.length ? ((blocks.length / live.length) * 100).toFixed(1) + "% of live" : "n/a"
}`);
console.log(`  has <title>      ${String(title.length).padStart(4)}  ${pc(title.length)}`);
console.log(`  has description  ${String(desc.length).padStart(4)}  ${
  live.length ? ((desc.length / live.length) * 100).toFixed(1) + "% of live" : "n/a"
}`);

const byStatus = new Map<number, number>();
for (const r of out) byStatus.set(r.status, (byStatus.get(r.status) ?? 0) + 1);
console.log("  status codes: " + [...byStatus.entries()].sort((a, b) => b[1] - a[1])
  .map(([s, c]) => `${s || "ERR"}:${c}`).join("  "));

// Do popular repos fare better? Tests whether quality ranking is viable.
const withStars = out.map((r, i) => ({ ...r, stars: repos[i].stars }));
const sorted = withStars.sort((a, b) => b.stars - a.stars);
const top = sorted.slice(0, Math.floor(n * 0.2));
const topLive = top.filter((r) => r.status >= 200 && r.status < 300).length;
console.log(`\n  top-20% by stars (${top.length} sites): ${((topLive / top.length) * 100).toFixed(1)}% live`);
console.log("  -> ranking by popularity is a viable quality signal" +
  (topLive / top.length > live.length / n ? "" : " (no better than random)"));
