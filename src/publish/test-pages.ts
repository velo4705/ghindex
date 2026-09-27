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

// --- 7b. no unescaped source entities in the served text ---
// Scraped titles/descriptions arrive entity-encoded ("the world&#x27;s"). That
// must be DECODED so a reader sees an apostrophe, not the escape sequence.
//
// Note this does not mean "the file contains no '&...;'": the generated HTML
// is correctly attribute-escaped, so a decoded apostrophe is re-encoded as
// "&#39;" on its way into <title>. That is valid HTML and renders as "'". The
// real defect is an entity whose DECODED form is not what a reader should see,
// so this test decodes the extracted text and then checks the result.
const decode = (s: string) =>
  s.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]{1,10});/g, (whole, body: string) => {
    if (body[0] === "#") {
      const code = body[1] === "x" || body[1] === "X"
        ? Number.parseInt(body.slice(2), 16)
        : Number.parseInt(body.slice(1), 10);
      if (!Number.isFinite(code) || code < 0x20 || code > 0x10ffff) return whole;
      try { return String.fromCodePoint(code); } catch { return whole; }
    }
    const named: Record<string, string> = {
      amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
      ndash: "-", mdash: "-", hellip: "...", larr: "<-", rarr: "->",
      eacute: "e", beta: "b", shy: "", macr: "-",
    };
    return named[body.toLowerCase()] ?? whole;
  });

let doubleEncoded = 0;
const samples: string[] = [];
for (const p of pages) {
  const t = await Bun.file(p).text();
  const title = t.match(/<title>([^<]*)<\/title>/)?.[1] ?? "";
  const desc = t.match(/<meta name="description" content="([^"]*)"/)?.[1] ?? "";
  // After one decode, a correctly handled title is plain text. If decoding
  // again still changes it, the source was double-encoded.
  for (const field of [title, desc]) {
    const once = decode(field);
    const twice = decode(once);
    if (once !== twice) {
      doubleEncoded++;
      if (samples.length < 3) samples.push(`"${field.slice(0, 60)}"`);
    }
  }
}
check("title/description are not double-encoded", doubleEncoded === 0,
  doubleEncoded ? `${doubleEncoded} affected, e.g. ${samples[0]}` : "0 affected");

// And a direct spot check on the real-world case. The generator escapes on
// output, so a decoded apostrophe is written as "&#39;" and a browser renders
// it as "'". The original bug produced "&amp;#x27;" (double-encoded), which
// renders as the literal text "&#x27;".
{
  const raw = "Ant Design - The world&#39;s second most popular React UI framework - ghindex";
  check("decoded apostrophe renders as an apostrophe",
    decode(raw) === "Ant Design - The world's second most popular React UI framework - ghindex",
    decode(raw));
  // The failure mode we are guarding against: escaped again after decoding.
  const doubleEncoded = "Ant Design - The world&amp;#x27;s second most popular";
  check("double-encoding is detectable", decode(decode(doubleEncoded)) !== decode(doubleEncoded),
    `detects "${doubleEncoded}"`);
}

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
