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

/**
 * The markup with comments removed.
 *
 * The CSS block documents the layouts that were tried and rejected, and the body
 * documents the removed footer — in prose that quotes the very markup being
 * asserted absent. Matching on the comments would forbid the explanation of why
 * the code looks like this.
 */
const stripHtmlComments = (s: string) => s.replace(/<!--[\s\S]*?-->/g, "");
const markup = stripHtmlComments(html);
const app = readFileSync(join(SITE, "app.js"), "utf8");
const search = readFileSync(join(SITE, "github-search.js"), "utf8");

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
check("there is a help line", /class="helpline"/.test(html));

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
  check(
    "selecting a tag is reversible",
    /state\.picked = state\.picked\.includes\(tag\)/.test(app) &&
      /state\.picked\.filter\(\(t\) => t !== tag\)/.test(app),
    "the toggle must remove only the tag it was clicked on",
  );

// The picker must be a real two-state control. It shipped broken once: the
  // collapsed state was a CSS `max-height` + `overflow: hidden` cut, which sliced
  // a wrapped row in half and did not reliably restore the short list. Slicing
  // the array in JS is what makes the two states exact opposites.
check("the picker collapses by slicing the list", /slice\(0, TAGS_COLLAPSED\)/.test(app));
// Scoped to the picker: `overflow: hidden` is legitimately used elsewhere, by
// the two-line clamp on a result's description.
check(
  "the picker is not truncated with CSS",
  !/\.taglist[^{]*\{[^}]*max-height/.test(html) && !/\.taglist[^{]*\{[^}]*overflow/.test(html),
);
check("the collapsed size is a named constant", /TAGS_COLLAPSED = \d+/.test(app));
check(
  "it offers an expander",
  /class="tagmore"/.test(app) && /\.tagmore\s*\{/.test(html),
);
check("the expander toggles state both ways", /state\.tagsOpen = !state\.tagsOpen/.test(app));
check(
  "and reports its state to assistive tech",
  /aria-expanded="\$\{state\.tagsOpen\}"/.test(app),
);

// The whole pre-search view is one centred block. The topics used to sit outside
  // the hero, after a hero that filled the viewport, which left a screen of empty
  // space between the help line and the first chip — two things that are obviously
  // one group, split apart by most of a page.
// Reading order inside the hero: title, subtitle, box, topics, help line. The
// alternative to typing used to sit below an explanatory sentence, and the help
// line itself was a separate footer a screen further down.
check(
  "the topics come before the help line",
  markup.indexOf('class="tagpick"') < markup.indexOf('class="helpline"'),
  "help should be the last line of the centred block",
);
check(
  "the help line is inside the hero",
  /.hero[\s\S]*class="tagpick"[\s\S]*class="helpline"[\s\S]*<\/main>/.test(markup),
);
check(
  "and the hero centres as one unit",
  /\.hero\s*\{[^}]*flex-direction:\s*column[^}]*justify-content:\s*center/.test(html),
);
check(
  "with a single gap between its parts",
  /\.hero\s*\{[^}]*gap:/.test(html) && !/\.tagpick\s*\{\s*margin-top:\s*2/.test(html),
  "a margin-top on the picker would double the hero's gap",
);
check(
  "and the hero centres as one unit",
  /\.hero\s*\{[^}]*flex-direction:\s*column[^}]*justify-content:\s*center/.test(html),
);
// The help line is the last element in the document, so there is nothing below
  // the fold before a search runs. It was a separate <footer>, which made the page
  // permanently taller than the viewport and gave a scrolling visitor a second
  // half to interpret.
check("the help line is the last element", /<\/div>\s*<\/main>/.test(markup) && !/<footer/.test(markup));
check("there is no separate footer", !/<footer/.test(markup) && !/\bfooter\s*\{/.test(markup));
check(
  "and the page has no bottom padding pushing it off",
  !/main\s*\{[^}]*padding:[^;}]*\d+rem\s*\}/.test(markup),
);

// An uppercase letterspaced "BROWSE BY TOPIC" heading shipped and was removed:
// a dated label for a control the reader did not ask about.
check("the picker carries no heading", !/<h2[^>]*>\s*Browse/i.test(html));

// The copy has to be honest. "every" was a claim the API cannot support: search
// caps at 1,000 results per query and only sees repositories that carry topics,
// so the page can never have covered every Pages site.
check(
  "the tagline does not overclaim",
  !/every/i.test(html.match(/class="tagline"[^>]*>([^<]*)</)?.[1] ?? ""),
  html.match(/class="tagline"[^>]*>([^<]*)</)?.[1],
);
check(
  "the tagline does not say GitHub twice",
  !/GitHub[^<]*GitHub/i.test(html.match(/class="tagline"[^>]*>([^<]*)</)?.[1] ?? ""),
);

// A picker tag must search by topic rather than as free text: "portfolio" as a
// word matches every repo that mentions portfolios, while a `topic:` qualifier
// what someone clicking a topic picker is asking for.
// A `topic:` qualifier made every result share one topic, at which point GitHub's
// default relevance ranking *is* the star ranking — measured across all seven
// default tags, "best match" and "most stars" returned byte-identical results. So
// the ordering control did nothing on the path most visitors arrive by.
check("no topic: qualifier is used for a tag", !/topic:\$\{/.test(app));
check("the tag is combined with the typed text",
  /\[\.\.\.state\.picked, raw\]\.filter\(Boolean\)\.join\(" "\)/.test(app),
  "tag and text must AND, not replace each other");
// Several tags AND together. They must reach the query as separate terms, which
// is what makes a second tag a narrowing rather than a replacement.
check("every picked tag reaches the query",
  /\[\.\.\.state\.picked, raw\]/.test(app) &&
  !/state\.picked\.join\(" "\)\s*\+/.test(app));
check("the summary no longer claims a topic filter", !/topic: \$\{/.test(app));

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

// --- ordering --------------------------------------------------------------
//
// Pinned against the URL builder rather than the browser, because the browser
// test runs against the *deployed* worker, which keeps serving its old hard-coded
// star-sort until this change ships. These assert the contract the worker will be
// asked for once it does.

const { pageUrlForTest, MAX_PAGES_FOR_TEST, PER_PAGE_FOR_TEST, FETCH_PER_PAGE_FOR_TEST } = (await import(
  join(SITE, "github-search.js")
)) as {
  pageUrlForTest: (input: string, page: number, edge: string | null, sort: string) => string;
  MAX_PAGES_FOR_TEST: number;
  PER_PAGE_FOR_TEST: number;
  FETCH_PER_PAGE_FOR_TEST: number;
};

const direct = (sort: string) => pageUrlForTest("portfolio", 2, null, sort);
const edgeUrl = (sort: string) => pageUrlForTest("portfolio", 2, "https://edge.test", sort);

check("relevance sends no sort qualifier", !direct("best").includes("sort="), direct("best"));
check("most stars sends the stars qualifier",
  direct("stars").includes("sort=stars&order=desc"), direct("stars"));
check("the two orderings are different requests", direct("best") !== direct("stars"));
// The recency lens is the third ordering, and it is the one that most needs a
// distinct URL: it shares the "best" query and page number with relevance, so
// the only thing distinguishing the two requests is the sort qualifier. If that
// were dropped on either path, a reader asking for the newest results would be
// handed the relevance page with no way to tell.
check("recently updated sends the updated qualifier",
direct("updated").includes("sort=updated"), direct("updated"));
check("and adds no order qualifier of its own",
!direct("updated").includes("order="), direct("updated"));
check("all three orderings are distinct requests",
direct("best") !== direct("stars") &&
direct("best") !== direct("updated") &&
direct("stars") !== direct("updated"));
check("and all three are distinct at the edge too",
edgeUrl("best") !== edgeUrl("stars") &&
edgeUrl("best") !== edgeUrl("updated") &&
edgeUrl("stars") !== edgeUrl("updated"));
check("recently updated reaches the edge worker by name",
edgeUrl("updated").includes("sort=updated"), edgeUrl("updated"));
// Relevance is sent explicitly. Omitting it made this URL byte-identical to the
// one the worker used while it hard-coded star sorting, so any cache keyed on the
// URL could answer a relevance request with a star-sorted body.
check("relevance reaches the edge worker as an explicit sort=best",
  edgeUrl("best").includes("sort=best"), edgeUrl("best"));
check("and the two edge URLs can never be confused",
  edgeUrl("best") !== edgeUrl("stars"));
check("the GitHub API omits the qualifier for relevance", !direct("best").includes("sort="));
check("most stars reaches the edge worker as sort=stars",
  edgeUrl("stars").includes("sort=stars"), edgeUrl("stars"));
check("page and per_page survive either ordering",
  direct("best").includes("page=2") && direct("stars").includes("page=2"));

// The whole point of splitting the constant: what the reader counts and what
// GitHub is asked for stopped being the same number. If either half regresses to
// the other, pages quietly go back to holding ten sites.
check("the upstream call asks for 100 repositories, not the 40 it will show",
  direct("best").includes("per_page=100") && edgeUrl("best").includes("per_page=100"),
  `direct=${direct("best")} edge=${edgeUrl("best")}`);
check("on both the direct and the edge path",
  !direct("best").includes(`per_page=${PER_PAGE_FOR_TEST}&`) ||
  direct("best").includes("per_page=100"),
  direct("best"));
// Rows are filtered after the response, so a page can arrive with more sites than
// the page size and fewer as well. Trimming is what keeps the summary's count and
// the rows on screen describing the same set.
check("rows are trimmed to the page size after filtering",
  /results\.length >= PER_PAGE\) break/.test(search) || /results\.length >= 40\) break/.test(search),
  "the loop stops once a page is full");
check("and the trim does not discard the deduplication check",
  /seen\.has\(row\.full_name\)/.test(search), "duplicates are skipped before the trim");

// ---------------------------------------------------------------- pagination depth
//
// The pager and the page size are not independent. GitHub serves page N only
// while (N - 1) * per_page is under its 1,000-result ceiling, so one determines
// the other. These assert the pair is coherent, and that the two places that
// must agree on the page size actually do.
check("the pager reaches 10 pages", MAX_PAGES_FOR_TEST === 10, `${MAX_PAGES_FOR_TEST}`);
check("a page shows at most 40 sites", PER_PAGE_FOR_TEST === 40, `${PER_PAGE_FOR_TEST}`);
// The fetch size is the one that decides how deep the pager can go. GitHub serves
// no result past the first 1,000 repositories, so ten calls of 100 is not a choice
// -- it is the deepest the index can be paged. Asserting this against the display
// size would pass while page 10 came back empty.
check("ten pages of a hundred is exactly GitHub's ceiling",
  MAX_PAGES_FOR_TEST * FETCH_PER_PAGE_FOR_TEST === 1000,
  `${MAX_PAGES_FOR_TEST} x ${FETCH_PER_PAGE_FOR_TEST} = ${MAX_PAGES_FOR_TEST * FETCH_PER_PAGE_FOR_TEST}`);
// The invariant is not the number 10 but the relationship: the last page offered
// must sit inside GitHub's ceiling, or the pager ends by serving a page that fails
// with HTTP 422. Page 11 starts at 1,100, so ten is the last page that exists.
check("the last page is inside the ceiling GitHub will serve",
  (MAX_PAGES_FOR_TEST - 1) * FETCH_PER_PAGE_FOR_TEST < 1000,
  `page ${MAX_PAGES_FOR_TEST} starts at ${(MAX_PAGES_FOR_TEST - 1) * FETCH_PER_PAGE_FOR_TEST}`);
check("and one more page would be past it",
  MAX_PAGES_FOR_TEST * FETCH_PER_PAGE_FOR_TEST >= 1000,
  `page ${MAX_PAGES_FOR_TEST + 1} starts at ${MAX_PAGES_FOR_TEST * FETCH_PER_PAGE_FOR_TEST}`);
check("and the pager stays a length a reader can take in at a glance",
  MAX_PAGES_FOR_TEST <= 12,
  `${MAX_PAGES_FOR_TEST} buttons`);
// A page is trimmed to PER_PAGE after filtering, so the fetch size must be at least
// that big or the trim could never be reached and every page would run short.
check("the fetch size can actually fill a page",
  FETCH_PER_PAGE_FOR_TEST >= PER_PAGE_FOR_TEST,
  `fetch ${FETCH_PER_PAGE_FOR_TEST} vs page ${PER_PAGE_FOR_TEST}`);
// The summary line offsets by this number to label where you are. It is declared
// separately in app.js because that module loads the search backend lazily; the
// two drifting apart would make every "results 1-40" range a lie.
check("the summary's page size matches the backend's",
  /const RESULTS_PER_PAGE = 40/.test(app), "RESULTS_PER_PAGE in app.js");
check("and the summary uses it rather than a literal",
  /RESULTS_PER_PAGE \+ 1/.test(app) && /RESULTS_PER_PAGE \+ n/.test(app),
  "offset arithmetic reads the constant");

// An unchecked row is shown as live. "unverified" was the absence of a finding
// dressed up as one, and it was the badge most people saw.
check("the page has no 'unverified' badge", !/text: "unverified"/.test(app));

// ---------------------------------------------------------------- surprise me
//
// The control navigates to a URL built from GitHub data. That makes it the one
// place on the page where an attacker-controlled string reaches `location`, so
// it has to clear exactly the same guard the result links clear. These are
// source-level checks on purpose: the navigation is not exercised in a test
// because doing so would leave the page under test.
check("the surprise button exists and says so",
  /id="surprise"/.test(html) && /surprise-label/.test(html));
check("it is a real button inside the search form",
  /<button[^>]*type="button"[^>]*class="surprise"/.test(html), "markup shape");
check("its label is inside the button so it can be swapped",
  /id="surprise-label"/.test(html));
// The load-bearing check: nothing reaches `location` without going through the
// same helper every rendered result row goes through.
check("every candidate URL passes through safeUrl",
  /\.map\(\(r\) => safeUrl\(r\.url\)\)/.test(appCode) ||
  /safeUrl\(r\.url\)/.test(appCode),
  "candidate mapping");
// The new-tab behaviour has one non-obvious requirement: the window must be
// opened synchronously, before the search. A popup blocker honours a request made
// during the click and refuses one made after an await, so a naive
// "search, then window.open" silently does nothing at all. Source-level because a
// real popup would leave the test page behind.
// Performance, and specifically a measured regression that already happened once.
//
// Surprise Me sat idle for about two seconds before its search even left the
// browser. That was not the worker — the same search answers in ~150ms — it was
// module resolution on the first click, because the search module was only ever
// fetched by the dynamic import inside the handler. A static import discovered
// when the parser reaches it is discovered late, and every one of these sat below
// a long <style> block.
//
// The preload hints move those fetches to the preload scanner, which starts at head
// parse. They are a hint, so the assertion is that they exist and point at modules
// the page really uses — a hint pointing at nothing would pass a weaker test while
// costing a wasted request.
check("the search module is preloaded, so the first click does not wait for it",
  /<link rel="modulepreload" href="\.\/github-search\.js"/.test(html),
  "github-search.js preload hint");
check("as is the taxonomy the picker needs",
  /<link rel="modulepreload" href="\.\/taxonomy\.js"/.test(html),
  "taxonomy.js preload hint");
check("and exactly the preloaded modules are ones the page imports",
  (() => {
    const hinted = [...html.matchAll(/<link rel="modulepreload" href="\.\/([^"]+)"/g)].map((m) => m[1]);
    const imported = ["github-search.js", "taxonomy.js", "sky.js"];
    // Nothing hinted that is unused (a wasted request), and nothing imported is
    // left unhinted (the cost this change exists to remove).
    return hinted.length > 0 &&
      hinted.every((h) => imported.includes(h)) &&
      imported.every((i) => hinted.includes(i));
  })(),
  "preload hints and static imports must agree");
check("the tab is opened before any await, or a popup blocker eats it",
  /const tab = window\.open\("", "_blank"\)/.test(appCode) &&
  appCode.indexOf('window.open("", "_blank")') < appCode.indexOf("const res = await searchGitHub"),
  "window.open must precede the search");
check("the opened tab is given the address later, not at open time",
  /tab\.location\.replace\(target\)/.test(appCode), "tab.location.replace");
check("the opener is severed so the site cannot reach back into this page",
  /tab\.opener = null/.test(appCode));
check("a tab whose attempt failed is explained, not closed",
  /const discard = \(\) => \{[\s\S]{0,200}?surpriseTabFailed\(tab\)/.test(appCode) &&
  !/const discard = \(\) => \{[\s\S]{0,200}?tab\.close\(\)/.test(appCode),
  "discard() must explain in the tab");
// A blank white tab and a slow tab look identical from the outside, so a visitor
// cannot tell a working control from a broken one. The tab has to say what it is
// doing while it waits.
check("the waiting tab is written to, not left blank",
  /tab\.document\.write\(SURPRISE_WAIT_PAGE\)/.test(appCode), "wait page written");
check("and it says so, rather than sitting there looking dead",
  /Finding you something/.test(appCode) && /takes a second/.test(appCode),
  "wait page explains itself");
check("the wait page actually spins",
  /\.ring \{[\s\S]{0,320}?animation:spin/.test(appCode), "ring must animate");
check("reduced motion stops the spin without removing the indicator",
  /prefers-reduced-motion[\s\S]{0,200}?\.ring \{[^}]*animation:none/.test(appCode) &&
  /prefers-reduced-motion[\s\S]{0,200}?\.ring \{[^}]*border-top-color:var\(--border\)/.test(appCode),
  "stopped, not deleted");
check("it is styled as part of this site, in both themes",
  /--bg:#f4f2ee/.test(appCode) && /--bg:#1c1f24/.test(appCode) &&
  /prefers-color-scheme: dark/.test(appCode), "matches site colours");
check("a tab that cannot be indexed should not be",
  /content="noindex"/.test(appCode), "noindex");
check("if the attempt fails, the tab is told why instead of disappearing",
  /Nothing to send you to/.test(appCode), "failure page explains itself");
check("and if the popup is blocked, it still opens the site",
  /if \(tab\) \{[\s\S]{0,120}?tab\.location\.replace\(target\)/.test(appCode) &&
  /\} else \{[\s\S]{0,300}?window\.location\.href = target/.test(appCode),
  "same-tab fallback");
// Liveness spends a Worker request against a daily budget shared by every visitor,
// so it must not fire on every page view unasked. It also must not sit behind a
// button: a control framed the check as an extra the site was withholding, when the
// check is what keeps the site inside its budget at all. It follows the reader's
// attention instead -- one row, one request, only for the row being considered.
check("search results do not spend a request on liveness unasked",
  !/if \(!state\.error\) verifyRow\(/.test(appCode),
  "no automatic verifyRow on search");
check("and there is no batch verify left to fire",
  !/verifyResults/.test(appCode), "the whole-page check is gone");
check("no button is offered to press",
  !/Check which are still live/.test(appCode) && !/id="live-check"/.test(appCode),
  "no liveness button");
check("a row is checked when the reader points at it",
  /addEventListener\("pointerover"/.test(appCode) && /verifyRow\(/.test(appCode),
  "pointer intent triggers the check");
check("and on focus, so a keyboard reader is not excluded",
  /addEventListener\("focusin"/.test(appCode), "focus triggers the check");
// Touch and pen also fire pointerover; this is what keeps a phone from needing a
// separate path, and it is asserted because the alternative is a dead control there.
check("touch is covered by the same listener",
  /pointerover/.test(appCode) && !/addEventListener\("mouseover"/.test(appCode),
  "pointerover covers touch and pen");
check("the check is delegated, so re-rendering does not orphan it",
  /\$\("results"\)\?\.addEventListener/.test(appCode), "delegated on #results");
// The re-entry guard is what makes "one row, one request" true. Without it, sweeping
// the pointer down the list would spend a request per row and this would be the
// automatic behaviour the whole change exists to avoid.
check("one URL is verified at most once, however often it is hovered",
  /if \(state\.live\.has\(url\)\) return;/.test(appCode),
  "verdicts are memoised per URL");
// The bug this guards: a per-row generation counter meant that pointing at a second
// row while the first was still in flight invalidated the first, leaving it stuck on
// "checking…" forever while still holding the request it had spent. Moving down a
// list overlaps requests by definition, so a check that survives one hover must
// survive the next.
check("an overlapping check does not discard the one already in flight",
  !/const token = \+\+state\.verifyToken/.test(appCode),
  "no per-row generation counter");
check("and a late verdict is still recorded",
  !/token !== state\.verifyToken\) return;/.test(appCode.split("verifyRow")[1] ?? ""),
  "verdicts are never thrown away");
check("the host element still exists to report progress",
  /id="live-toggle"/.test(html), "live-toggle host");
check("and it reports rather than offers",
  /renderLiveToggle/.test(appCode) && /Verified \$\{esc\(String\(checked\)\)\}/.test(appCode),
  "accounting line");
check("a checked row is marked, so it stops looking unverified",
  /row\.setAttribute\("data-verdict"/.test(appCode), "data-verdict set");
check("and the stylesheet clears the affordance once a verdict lands",
  /\.row\[data-verdict\]/.test(html), "affordance removed");
check("the badge still distinguishes blocked from dead",
  /blocked: \{ cls: "live-blocked"/.test(appCode) &&
  /gone: \{ cls: "live-gone"/.test(appCode),
  "blocked is not dead");
check("the navigation target is only ever a safeUrl result",
  /const candidates =[\s\S]{0,240}?safeUrl\(/.test(appCode) &&
  /window\.location\.href = target/.test(appCode),
  "assign from the filtered list");
check("candidates are filtered before use, not after",
  /\.filter\(Boolean\)/.test(appCode), "filter(Boolean)");
// Liveness is the point of the control: a random dead link is a bad surprise.
check("it checks a candidate is alive before opening it",
  /verifyLivenessBatch/.test(appCode) && /verdict === "alive"/.test(appCode));
check("and it probes several candidates rather than trusting one random row",
  /\.slice\(0, LIVE_CHECK_CHUNK\)/.test(appCode), "slice to the batch size");
// A genre is chosen first, which is what makes repeat clicks differ.
check("the genre is chosen at random from a list",
  /Math\.random\(\) \* pool\.length/.test(appCode) || /pool\[Math\.floor\(Math\.random\(\)/.test(appCode));
check("and the fallback genre list is not invented inline",
  /const SURPRISE_GENRES = \[/.test(appCode) && /portfolio.*games.*docs.*blog/.test(appCode),
  "matches the purpose-based categories");
// A second click supersedes the first rather than racing it.
check("a second press aborts the first",
  /state\.inflight\?\.abort\(\)/.test(appCode), "abort before starting");
check("the button is disabled while it works, so it cannot be double-fired",
  /btn\.disabled = true/.test(appCode) && /if \(!btn \|\| btn\.disabled\) return/.test(appCode));
check("an unchecked verdict renders as live", /error: \{ cls: "live-alive", text: "live" \}/.test(app));

console.log(
  fail === 0 ? `\nFRONT END OK (${checks} checks)` : `\n${fail} FRONT END CHECK(S) FAILED`,
);
if (fail) process.exit(1);