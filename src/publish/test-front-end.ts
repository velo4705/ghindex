/**
 * Tests for the live-only front end.
 *
 * What is being defended
 * ----------------------
 * The page is one search box, and there is nothing behind it. Results are asked of
 * GitHub through the edge worker at the moment of the search, so the page costs
 * almost nothing to arrive at and has no snapshot to go stale.
 *
 * Most of this file is about what the page must NOT do, because the regression it
 * guards against is easy to reintroduce by accident and invisible from outside:
 * an index coming back. That is one fetch of manifest.json, and the symptom is a
 * slower page and a second result set that disagrees with the first. It shipped
 * once, in the form of a "0 matches" row stacked above a live row that had the
 * answer, so the shape of the page is asserted here as well as the fetches.
 *
 * The second thing defended is the tag picker. It is the only way to browse
 * without typing, and it is the page's whole second half, so a picker that loads
 * empty looks identical to a page with no picker at all.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

const SITE = join(import.meta.dir, "..", "site");

let fail = 0;
let checks = 0;
const check = (name: string, ok: boolean, detail = "") => {
  checks++;
  if (ok) {
    console.log(`  PASS  ${name}`);
  } else {
    fail++;
    console.log(`  FAIL  ${name}${detail ? `\n          ${detail}` : ""}`);
  }
};

const html = readFileSync(join(SITE, "index.html"), "utf8");
const app = readFileSync(join(SITE, "app.js"), "utf8");

// ------------------------------------------------------------- no index

console.log("=== no local index ===");

// The most important checks here. If any of these come back, someone has
// reintroduced a pre-built index and the page is about to show two result sets
// ranked differently again.
check("app.js never creates a search worker", !/new Worker\(/.test(app));
check("app.js never fetches the manifest", !/manifest\.json/.test(app));
check("app.js never fetches a shard", !/\.\/data\/[a-z#]\.json|\.\/data\/\$\{/.test(app));
check("app.js reads no index rows", !/row\.(u|o|r|t|g|c)\b/.test(app));
check("app.js has no score() ranking of local rows", !/function score\(/.test(app));
check("the page loads no search-worker", !/search-worker/.test(html));
check("the markup offers no shard links", !/data\/a\.json|data\/z\.json/.test(html));
check(
  "there is no sitemap reference in robots.txt",
  !/Sitemap/.test(readFileSync(join(SITE, "robots.txt"), "utf8")),
);

// Nothing should claim to be a stored index any more: it is a live search, and
// saying otherwise is what made the two result sets read as one product.
check(
  "the page does not claim to be a static index",
  !/An index of GitHub Pages sites|Search the index|not in the index/i.test(html),
);
check("the copy says results are live", /live/i.test(html));

// ------------------------------------------------------------- shape

console.log("=== the page is one search box ===");

// The specific bug being guarded against: a result group above another result
// group, which is how "0 matches" was displayed above the answer.
check("there is one results container", (html.match(/id="results"/g) ?? []).length === 1);
// Comments are stripped first: app.js documents the two-result-set bug in its
// header, and matching on the prose would forbid the explanation of why the
// page looks like this.
const stripJsComments = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const appCode = stripJsComments(app);
check(
  "no separate 'also on GitHub' section",
  !/also on github|wide-results/i.test(appCode + html),
);
check("the page renders into #results only", /\$\("results"\)/.test(app));

// A title, a subtitle and the box. These are the whole page.
check("there is a title", /<h1[^>]*>/.test(html));
check("there is a subtitle", /class="tagline"/.test(html));
check("there is a search box", /<input id="q"[^>]*type="search"/.test(html));

// One line of help, because "results appear as you type" is not obvious and a
// visitor who waits for a submit button will think it is broken.
check("there is a help line", /class="help"/.test(html));

// Nothing else. These were all real features that are now gone, and each one
// coming back would put the chrome back between the visitor and the box.
check("no star filter", !/id="stars"|Minimum stars/.test(html));
check("no grid/preview toggle", !/id="view"|Previews/.test(html));
check("no token field", !/id="token"|type="password"/.test(html));
check("no report/claim links per row", !/row-actions|issues\/new/.test(app));

// ------------------------------------------------------------- tag picker

console.log("=== tag picker ===");

check("the picker exists", /id="taglist"/.test(html));
check("app.js populates it", /renderTagPicker\(\)/.test(app));
check("it loads the curated list", /BROWSE_TAGS/.test(app));

// Selecting a tag has to be a toggle, or a visitor who picks the wrong one
  // cannot get back to an unfiltered search without reloading.
  check("selecting a tag is reversible", /state\.tag === tag \? "" : tag/.test(app));

// Selecting a tag must NOT expand the picker. It did, and the screenshot showed
// why that was wrong: the 83 chips reappeared and pushed the results the visitor
// had just asked for a full screen down the page. What tells them the selection
// took effect is the accent on the chip and the "topic: x" line in the summary.
check(
  "selecting a tag leaves the picker collapsed",
  !/classList\.remove\("collapsed"\)/.test(app),
  "expanding on select pushed the results down the page",
);

// A picker tag must search by topic rather than as free text: "portfolio" as a
// word matches every repo that mentions portfolios, while topic:portfolio is
// what someone clicking a topic picker is asking for.
check("a selected tag becomes a topic query", /topic:\$\{state\.tag\}/.test(app));

// ------------------------------------------------------------- live path

console.log("=== live search path ===");

// The page is worthless without this, so its absence has to be a hard failure
// rather than something a reader discovers.
check("app.js imports the live search module", /github-search\.js/.test(app));
check("the page configures an edge endpoint", /name="ghindex-edge"/.test(html));
check("results are link-checked", /verifyLivenessBatch/.test(app));

// A debounce is what keeps a shared rate-limit budget from being spent per
// keystroke, so its absence would be a real regression rather than a style note.
check("typing is debounced before it spends the budget", /DEBOUNCE_MS/.test(app));

// ------------------------------------------------------------- modules parse

console.log("=== the shipped modules parse ===");

// The site has no build step: every file is loaded by the browser exactly as
// written. So a surviving TypeScript annotation is not a type error to be caught
// later, it is a syntax error that stops the module loading at all — and the
// symptom is a silent failure, not a visible one.
//
// Rather than pattern-match the annotations that happen to exist today, build
// each module. Anything that is not valid JavaScript fails to build, which covers
// a type keyword and a stray non-null assertion equally well.
for (const f of ["app.js", "github-search.js", "taxonomy.js"]) {
  let ok = true;
  let err = "";
  try {
    await Bun.build({ entrypoints: [join(SITE, f)], write: false });
  } catch (e) {
    ok = false;
    err = String(e).split("\n")[0];
  }
  check(`${f} parses as plain JavaScript`, ok, err);
}

console.log(
  fail === 0 ? `\nFRONT END OK (${checks} checks)` : `\n${fail} FRONT END CHECK(S) FAILED`,
);
if (fail) process.exit(1);