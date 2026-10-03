/**
 * M7 — static page generation for search engines.
 *
 * The single-page app is fine for humans but invisible to crawlers: everything
 * renders client-side, so a crawler sees an empty <div>. This generates real
 * HTML for the long tail:
 *
 *   sites/<owner>/<repo>/index.html   one page per site (has <title> + desc)
 *   categories/<id>/index.html        one page per category
 *   404.html                          a real 404 with search, not a blank file
 *   sitemap.xml, robots.txt
 *
 * Two deliberate constraints:
 *
 *  - Only sites with a <title> get a page. A page with no unique content is
 *    worse than no page: it is thin content, and it dilutes the sitemap.
 *  - Descriptions are truncated and escaped. Descriptions come from scraped
 *    third-party HTML and are untrusted, and they routinely contain mojibake
 *    from the source site, so the text is cleaned before it reaches a <meta>.
 *
 * Output stays inside src/site/ so Pages serves it with no extra config.
 */

import { readFileSync, existsSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { classify, CATEGORIES, CATEGORY_LABELS } from "../classify/taxonomy";
import { decodeEntities } from "../index/core";
import { PATHS, sitePath } from "../paths";

const SITE = PATHS.site;
/**
 * Cap per run so a huge corpus cannot blow up the git repo.
 *
 * These pages average ~2.5 KB, so 25,000 is ~62 MB, still comfortably under
 * GitHub Pages' 100,000-file ceiling and small enough to commit. It was 6,000,
 * which the corpus overtook: at 7,813 published records the cap silently threw
 * away ~1,800 pages every run. A cap that is reached in normal operation is not
 * a safety limit, it is a silent data loss bug, so this is set well above the
 * current corpus and the run reports loudly if it is ever reached.
 */
const MAX_PAGES = Number(process.env.MAX_PAGES ?? 25000);

const esc = (s: unknown) =>
  String(s ?? "").replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]),
  );

/**
 * Mojibake signature: a lead byte (U+00C2/U+00C3, the latin-1 rendering of a
 * UTF-8 lead byte) immediately followed by a continuation char.
 *
 * "Joao"/"Etico"/"Cech" are legitimate Portuguese and Czech, and Chinese,
 * Japanese, Korean, Arabic and Cyrillic titles are perfectly legitimate too.
 * A high share of non-ASCII characters is therefore NOT evidence of damage --
 * an earlier version of this rejected 267 real titles (e.g. "数字花园",
 * "論文や技術メモの一覧") purely for being non-English. Only the U+00C2/U+00C3
 * lead-byte pairing is treated as a defect, because that pairing never occurs
 * in correctly decoded text.
 */
const MOJIBAKE_PAIR = /[\u00C2\u00C3][\u0080-\u00BF]/g;
/** C1 controls appear almost exclusively inside mojibake runs. */
const C1_CONTROL = /[\u0080-\u009F]/g;

/**
 * Scrape-sourced text is frequently mojibake (the source site declared the
 * wrong charset), and it is emitted straight into <title> and
 * <meta description>, so it has to be checked rather than trusted.
 */
function cleanText(s: unknown, max = 300): string | null {
  if (typeof s !== "string") return null;

  // Decode BEFORE the mojibake check. An encoded entity such as "&eacute;"
  // contains the U+00C2/U+00C3 lead-byte pattern only after it has been
  // decoded, so checking first would reject legitimate names for no reason.
  const out = decodeEntities(s).replace(C1_CONTROL, " ").replace(/\s+/g, " ").trim();

  // Reject only on the mojibake signature, never on non-ASCII density.
  MOJIBAKE_PAIR.lastIndex = 0;
  if (MOJIBAKE_PAIR.test(out)) {
    MOJIBAKE_PAIR.lastIndex = 0;
    return null;
  }
  MOJIBAKE_PAIR.lastIndex = 0;

  if (out.length > max) return `${out.slice(0, max).trimEnd()}...`;
  return out.length ? out : null;
}

const STYLE = `
  :root{--bg:#0d1117;--panel:#161b22;--fg:#e6edf3;--muted:#8b949e;--line:#30363d;--accent:#58a6ff}
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.6 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif}
  a{color:var(--accent)}
  header{padding:1rem 1.25rem;border-bottom:1px solid var(--line)}
  h1{font-size:1.05rem;margin:0}
  .sub{color:var(--muted);font-size:.8rem;margin-top:.2rem}
  main{padding:1.25rem;max-width:760px}
  h2{font-size:1.3rem;margin:0 0 .3rem;line-height:1.3}
  .url{color:var(--muted);font-size:.85rem;word-break:break-all}
  .desc{margin:1rem 0}
  .meta{color:var(--muted);font-size:.8rem;margin-top:1.5rem;padding-top:1rem;border-top:1px solid var(--line)}
  .chips{display:flex;gap:.35rem;flex-wrap:wrap;margin:.75rem 0}
  .chip{font-size:.72rem;padding:.1rem .5rem;border-radius:999px;background:#21262d;border:1px solid var(--line);color:var(--muted);text-decoration:none}
  ul.plain{list-style:none;padding:0;margin:1rem 0}
  ul.plain li{padding:.5rem 0;border-bottom:1px solid var(--line)}
  ul.plain a{text-decoration:none;font-weight:600}
  ul.plain span{color:var(--muted);font-size:.8rem}
`.trim();

function layout(opts: {
  title: string;
  description: string;
  canonical: string;
  body: string;
  noindex?: boolean;
}): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${esc(opts.title)}</title>
<meta name="description" content="${esc(opts.description)}" />
<link rel="canonical" href="${esc(opts.canonical)}" />
${opts.noindex ? '<meta name="robots" content="noindex" />' : ""}
<meta property="og:title" content="${esc(opts.title)}" />
<meta property="og:description" content="${esc(opts.description)}" />
<meta property="og:type" content="website" />
<style>${STYLE}</style>
</head>
<body>
<header><h1><a href="../../index.html" style="color:inherit;text-decoration:none">ghindex</a></h1>
<div class="sub">An index of GitHub Pages sites</div></header>
<main>
${opts.body}
</main>
</body>
</html>
`;
}

async function main() {
  const manifestPath = `${SITE}/data/manifest.json`;
  if (!existsSync(manifestPath)) {
    console.error("no manifest - run `bun run build` first");
    process.exit(1);
  }
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));

  // Load every shard so we can emit pages from the published data (not the
  // corpus), which guarantees pages and shards can never disagree.
  const rows: any[] = [];
  for (const s of manifest.shards) {
    const p = `${SITE}/data/${s.file}`;
    if (existsSync(p)) rows.push(...JSON.parse(readFileSync(p, "utf8")));
  }
  console.log(`[pages] ${rows.length} published records`);

  // Rebuild the site pages dir so pages for now-dead sites disappear.
  if (existsSync(`${SITE}/sites`)) rmSync(`${SITE}/sites`, { recursive: true, force: true });

  /**
   * Order by stars, not by whatever order the shards happen to load in.
   *
   * This only matters when MAX_PAGES actually binds, but that is the point: it
   * used to bind at 6,000 rows, which is below the current corpus, and the
   * iteration order was alphabetical (shards a/m/s). So when the corpus grew
   * past the cap, ~1,400 perfectly healthy sites silently lost their pages and
   * the casualties were always the same ones: everything alphabetically after
   * roughly "S". A site called "Zelda" kept a page and a 300-star site called
   * "Aardvark" kept a page, while "Zephyr" lost one purely on its name.
   *
   * Truncating by popularity means a dropped site is dropped for being
   * unremarkable rather than for being unlucky with the alphabet.
   */
  const ranked = [...rows].sort((a, b) => (b.s ?? 0) - (a.s ?? 0));

  let written = 0;
  let skippedNoTitle = 0;
  let skippedNoDesc = 0;
  const urls: string[] = ["", "categories/"];

  for (const r of ranked) {
    if (written >= MAX_PAGES) break;
    // Title comes from scraped HTML and may be mojibake; fall back to the repo
    // name so the site still gets a page rather than vanishing from the index.
    const title = cleanText(r.t, 120) ?? `${r.o}/${r.r}`;
    if (!cleanText(r.t, 120)) skippedNoTitle++;
    /**
     * Many sites set their meta description to just their own name ("9am",
     * "Alvin", "true"), which is too thin to be a useful <meta description>.
     * Prefer a scraped description only when it actually says something;
     * otherwise derive one from the title and URL, which is always meaningful.
     */
    const scraped = cleanText(r.d, 200);
    const useScraped = scraped !== null && scraped.length >= 25;
    if (!useScraped) skippedNoDesc++;
    const metaDesc = useScraped
      ? (scraped as string)
      : `${title} - hosted on GitHub Pages at ${r.u}. Browse more GitHub Pages sites on ghindex.`;

    const path = sitePath(r.o, r.r);
    const cats = classify(r.g ?? []).categories;
    const chips = cats
      .map((c) => `<a class="chip" href="../../categories/${c}/index.html">${esc(CATEGORY_LABELS[c] ?? c)}</a>`)
      .join("");

    const body = `
<h2>${esc(title)}</h2>
<div class="url"><a href="${esc(r.u)}" rel="nofollow noopener">${esc(r.u)}</a></div>
${metaDesc ? `<p class="desc">${esc(metaDesc)}</p>` : ""}
${chips ? `<div class="chips">${chips}</div>` : ""}
<div class="meta">
  Published on <a href="../../index.html">ghindex</a>, an index of GitHub Pages sites.
</div>`;

    const dir = `${SITE}/${path}`;
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      `${dir}/index.html`,
      layout({ title: `${title} - ghindex`, description: metaDesc, canonical: path, body }),
    );
    written++;
    urls.push(path);
  }

  console.log(
    `[pages] wrote ${written} site pages (${skippedNoTitle} skipped: no usable title, ` +
      `${skippedNoDesc} had no description and used a derived one)`,
  );

  /**
   * If the cap is ever reached, say so loudly and by how much.
   *
   * This went unnoticed for a whole corpus growth cycle precisely because the
   * cap reported nothing: the run claimed to have written every site, and the
   * only symptom was 1,400 quietly vanishing pages showing up as unrelated
   * deletions in `git status` during an unrelated commit. A silent truncation
   * is indistinguishable from a dead site, so it now prints a WARNING.
   */
  const dropped = rows.length - written;
  if (dropped > 0) {
    console.log(
      `[pages] WARNING: MAX_PAGES=${MAX_PAGES} reached, ${dropped} of ${rows.length} ` +
        `sites got NO page. They are still searchable and in the index, but are ` +
        `absent from the sitemap. Raise MAX_PAGES before publishing this output.`,
    );
  }

  // ---- category pages ----
  let catPages = 0;
  for (const id of CATEGORIES) {
    const label = CATEGORY_LABELS[id];
    const members = rows
      .filter((r) => (r.c ?? []).includes(id))
      .sort((a, b) => (b.s ?? 0) - (a.s ?? 0));
    if (members.length === 0) continue;

    const list = members
      .slice(0, 500)
      .map((r) => {
        const t = cleanText(r.t, 90) ?? r.r;
        return `<li><a href="../../${sitePath(r.o, r.r)}/index.html">${esc(t)}</a><br /><span>${esc(r.u)}</span></li>`;
      })
      .join("\n");

    const body = `
<h2>${esc(label)}</h2>
<p class="sub">${members.length.toLocaleString()} site${members.length === 1 ? "" : "s"} in this category.</p>
<ul class="plain">
${list}
</ul>
${members.length > 500 ? `<p class="meta">Showing the top 500 of ${members.length.toLocaleString()}.</p>` : ""}`;

    const dir = `${SITE}/categories/${id}`;
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      `${dir}/index.html`,
      layout({
        title: `${label} - GitHub Pages sites - ghindex`,
        description: `Browse ${members.length.toLocaleString()} ${label.toLowerCase()} projects hosted on GitHub Pages.`,
        canonical: `categories/${id}`,
        body,
      }),
    );
    catPages++;
  }
  console.log(`[pages] wrote ${catPages} category pages`);

  // ---- 404 ----
  writeFileSync(
    `${SITE}/404.html`,
    layout({
      title: "Not found - ghindex",
      description: "That page does not exist.",
      canonical: "404",
      noindex: true,
      body: `<h2>Page not found</h2>
<p class="desc">The site you are looking for is not in the index, or the page has moved.</p>
<div class="chips"><a class="chip" href="./index.html">Search the index</a></div>`,
    }),
  );

  // ---- sitemap ----
  // Only the pages that actually exist and have content.
  const siteUrls = urls
    .filter((u) => u !== "")
    .map((u) => `  <url><loc>${u}</loc></url>`)
    .join("\n");
  writeFileSync(
    `${SITE}/sitemap.xml`,
    `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc></loc></url>
${siteUrls}
</urlset>
`,
  );

  // ---- robots ----
  // The data shards are an implementation detail, not content.
  writeFileSync(
    `${SITE}/robots.txt`,
    `User-agent: *
Allow: /
Disallow: /data/
Disallow: /sites/*/*/index.html

Sitemap: /sitemap.xml
`,
  );

  console.log(`[pages] wrote 404.html, sitemap.xml (${urls.length - 1} urls), robots.txt`);
}

await main();
