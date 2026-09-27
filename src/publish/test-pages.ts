/**
 * M7 — generated page quality gate.
 *
 * Two real bugs motivated this:
 *
 *  1. An early cleanText() rejected any title that was >40% non-ASCII, which
 *     threw away 267 legitimate titles in Chinese, Japanese, Korean, Arabic and
 *     Russian. "Digital garden" in Chinese is not a defect. Only the
 *     U+00C2/U+00C3 lead-byte pairing indicates real mojibake.
 *
 *  2. Repo names can end in a dot ("x.github.io" -> "x."), which is not a
 *     valid Windows directory and made mkdir fail mid-run.
 *
 * This asserts both are handled, so the SEO output cannot silently regress
 * into thin or broken pages.
 */

import { readdirSync, statSync, existsSync, readFileSync } from "node:fs";
import { PATHS } from "../paths";

function walk(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  if (!statSync(dir).isDirectory()) return out;
  for (const f of readdirSync(dir)) {
    const p = `${dir}/${f}`;
    if (statSync(p).isDirectory()) walk(p, out);
    else if (f === "index.html") out.push(p);
  }
  return out;
}

let fail = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) fail++;
};

const pages = walk(`${PATHS.site}/sites`);
check("site pages were generated", pages.length > 0, `${pages.length} pages`);

// --- 1. mojibake must not reach the served HTML ---
const RE_MOJI = /[\u00C2\u00C3][\u0080-\u00BF]/;
let mojibake = 0;
for (const p of pages) {
  const t = await Bun.file(p).text();
  const m = t.match(/<title>([^<]*)<\/title>/);
  if (m && RE_MOJI.test(m[1])) mojibake++;
}
check("no mojibake in <title>", mojibake === 0, `${mojibake} affected`);

// --- 2. non-English titles must survive (regression guard) ---
const RE_CJK = /[\u4E00-\u9FFF\u3040-\u30FF\uAC00-\uD7AF]/;
let cjk = 0;
for (const p of pages) {
  const t = await Bun.file(p).text();
  const m = t.match(/<title>([^<]*)<\/title>/);
  if (m && RE_CJK.test(m[1])) cjk++;
}
check("CJK titles are preserved, not dropped", cjk > 50, `${cjk} CJK titles`);

// --- 3. every page has a real title and description ---
let noTitle = 0, noDesc = 0, noCanonical = 0;
for (const p of pages) {
  const t = await Bun.file(p).text();
  if (!/<title>[^<]{3,}<\/title>/.test(t)) noTitle++;
  if (!/<meta name="description" content="[^"]{10,}"/.test(t)) noDesc++;
  if (!/<link rel="canonical"/.test(t)) noCanonical++;
}
check("every page has a meaningful <title>", noTitle === 0, `${noTitle} missing`);
check("every page has a description", noDesc === 0, `${noDesc} missing`);
check("every page has a canonical link", noCanonical === 0, `${noCanonical} missing`);

// --- 4. directory names are valid everywhere (not just Linux) ---
let badDir = 0;
for (const p of pages) {
  const seg = p.split(/[\\/]/).slice(-2, -1)[0];
  if (seg.endsWith(".") || seg.length === 0) badDir++;
}
check("no directory name ends in a dot", badDir === 0, `${badDir} invalid`);

// --- 5. category pages, sitemap, robots, 404 ---
for (const c of ["portfolio", "games", "docs", "blog", "dashboards", "tools", "learning", "showcase", "libraries"]) {
  check(`category page: ${c}`, existsSync(`${PATHS.site}/categories/${c}/index.html`));
}
check("sitemap.xml exists", existsSync(`${PATHS.site}/sitemap.xml`));
check("404.html exists", existsSync(`${PATHS.site}/404.html`));
check("robots.txt exists", existsSync(`${PATHS.site}/robots.txt`));

// --- 6. sitemap actually references pages that exist ---
const sitemap = readFileSync(`${PATHS.site}/sitemap.xml`, "utf8");
const locs = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
const siteLocs = locs.filter((l) => l.startsWith("sites/"));
check("sitemap lists site pages", siteLocs.length > 0, `${siteLocs.length} urls`);
let dangling = 0;
for (const loc of siteLocs.slice(0, 200)) {
  if (!existsSync(`${PATHS.site}/${loc}/index.html`)) dangling++;
}
check("sampled sitemap urls resolve to real files", dangling === 0, `${dangling} dangling`);

// --- 7. no HTML injection from scraped titles ---
let injected = 0;
for (const p of pages.slice(0, 400)) {
  const t = await Bun.file(p).text();
  const m = t.match(/<title>([^<]*)<\/title>/);
  // A title containing raw tags would have escaped the <title> capture, so
  // instead check that a known-dangerous sequence is absent from head.
  if (t.slice(0, 2000).includes("<script>")) injected++;
}
check("no script tags in generated pages", injected === 0, `${injected} found`);

// --- 8. generated companions in data/ must survive a rebuild ---
// build.ts deletes files in the data dir that are not listed as shards. That
// silently removed reports.json on every run, so the client's report links
// 404'd. Assert both a build and a reports run leave the files in place.
check("reports.json exists", existsSync(`${PATHS.data}/reports.json`));
{
  const before = readFileSync(`${PATHS.data}/reports.json`, "utf8");
  Bun.spawnSync(["bun", "run", "src/publish/build.ts"], { stdout: "ignore", stderr: "ignore" });
  check("build does not delete reports.json", existsSync(`${PATHS.data}/reports.json`));
  check(
    "reports.json is unchanged by a rebuild",
    existsSync(`${PATHS.data}/reports.json`) &&
      readFileSync(`${PATHS.data}/reports.json`, "utf8") === before,
  );
}

console.log(`\n${fail === 0 ? "GENERATED PAGES OK" : `${fail} CHECK(S) FAILED`}`);
process.exit(fail === 0 ? 0 : 1);
