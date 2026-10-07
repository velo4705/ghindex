/**
 * Tests for the live-only front end.
 *
 * What is being defended
 * ----------------------
 * There is no local index any more, and there is no front page either. Results are
 * asked of GitHub through the edge worker at the moment of the search, so the page
 * costs nothing to arrive at: the only request it makes before you type is for
 * the report-link config.
 *
 * The regression this file exists to prevent is the index quietly coming back.
 * That is easy to reintroduce by accident — it is one fetch of manifest.json —
 * and nothing about the failure is visible from the outside except a slower page
 * and a second set of results that disagrees with the first. So the assertions
 * are about what the page does NOT do, and about the prompt it does offer.
 *
 * The old version of this file drove search-worker.js directly and asserted that
 * an arrival fetched no shards. That is gone along with the shards, and there is
 * nothing left to assert about them.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

const SITE = join(import.meta.dir, "..", "site");

let fail = 0;
let checks = 0;
const eq = (name: string, got: unknown, want: unknown) => {
  checks++;
  if (got === want) {
    console.log(`  PASS  ${name}`);
  } else {
    fail++;
    console.log(`  FAIL  ${name}\n          got:  ${String(got)}\n          want: ${String(want)}`);
  }
};
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

// The single most important check here. If any of these come back, someone has
// reintroduced a pre-built index and the page is about to show two result sets
// ranked differently again.
check("app.js never creates a search worker", !/new Worker\(/.test(app));
check("app.js never fetches the manifest", !/manifest\.json/.test(app));
check("app.js never fetches a shard", !/\.\/data\/[a-z#]\.json|\.\/data\/\$\{/.test(app));
check("app.js reads no index rows", !/row\.(u|o|r|t|g|c)\b/.test(app));
check("app.js has no score() ranking of local rows", !/function score\(/.test(app));
check("the page loads no search-worker", !/search-worker/.test(html));
check("the markup offers no shard links", !/data\/a\.json|data\/z\.json/.test(html));
check("there is no sitemap reference in robots.txt", !/Sitemap/.test(readFileSync(join(SITE, "robots.txt"), "utf8")));

// Nothing in the page should claim to be an index any more: it is a live search,
// and saying otherwise is what made the two result sets look like one product.
check(
  "the page does not claim to be a static index",
  !/An index of GitHub Pages sites|Search the index|not in the index/i.test(html),
);
check("the copy says results are live", /live/i.test(html));

// ------------------------------------------------------------- the prompt

console.log("=== prompt markup ===");

check("the page has no landing shelves", !/id="landing"/.test(html));
check("the page has no shelf styles", !/\.card-mini|\.shelf-strip/.test(html));
check("the prompt exists", /id="idle"/.test(html));

// Read the examples out of the markup rather than a second copy of the list, so
// the test cannot pass on a list the page does not actually offer.
const examples = [...html.matchAll(/data-example="([^"]+)"/g)].map((m) => m[1]);

check("there are example queries to offer", examples.length >= 3, `got ${examples.length}`);
check(
  "example queries are unique",
  new Set(examples).size === examples.length,
  examples.join(", "),
);
check(
  "example queries are lowercase and single words",
  examples.every((e) => /^[a-z][a-z0-9-]*$/.test(e)),
  examples.filter((e) => !/^[a-z][a-z0-9-]*$/.test(e)).join(", "),
);

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

// Categories now come from classify() over the topics in hand. If that import
// went away, browse-by-category silently disappears, which is easy to miss
// because the chips are simply absent.
check("categories are derived in the browser", /taxonomy\.js/.test(app));
check("the taxonomy module ships with the page", readFileSync(join(SITE, "taxonomy.js"), "utf8").includes("export function classify"));

// The taxonomy is a .js file now, and it is loaded by the browser as-is with no
// build step, so any surviving TypeScript annotation is not a type error to be
// caught later -- it is a syntax error that stops the module loading at all. The
// symptom is a silent empty chip row, which is easy to ship without noticing.
//
// Rather than pattern-match the annotations that happen to be here today, parse
// the file as a module. Anything that is not valid JavaScript fails to parse,
// which covers a type keyword and a stray non-null assertion equally well.
const taxonomySrc = readFileSync(join(SITE, "taxonomy.js"), "utf8");
let taxonomyParses = true;
let parseError = "";
try {
  // Bun.build validates the module graph; a syntax error throws rather than
  // producing output, which is what makes this a real check.
  await Bun.build({ entrypoints: [join(SITE, "taxonomy.js")], write: false });
} catch (err) {
  taxonomyParses = false;
  parseError = String(err).split("\n")[0];
}
check("the shipped taxonomy parses as plain JavaScript", taxonomyParses, parseError);
check(
  "and still exports what the page imports",
  /export function classify/.test(taxonomySrc) && /CATEGORY_LABELS/.test(taxonomySrc),
);

// The page's own modules are loaded the same way, so they get the same check.
// app.js previously could not be parsed in isolation without a DOM; this only
// has to prove it is syntactically valid, which is a static question.
for (const f of ["app.js", "github-search.js"]) {
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
  fail === 0 ? `\nPROMPT OK (${checks} checks)` : `\n${fail} PROMPT CHECK(S) FAILED`,
);
if (fail) process.exit(1);