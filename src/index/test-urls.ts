/**
 * M6 — URL resolution + dedupe regression tests.
 *
 * These bugs shipped once already (a repo homepage pointing at jkunst.com, a
 * homepage pointing at github.com/user/repo/wiki, and the same site published
 * five times). They are cheap to test and expensive to rediscover, so they get
 * permanent tests.
 */

import { pagesUrlFor, isValidPagesUrl, decodeEntities } from "./core";

let fail = 0;
const eq = (name: string, got: string, want: string) => {
  const ok = got === want;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}`);
  if (!ok) {
    console.log(`        got:  ${got}`);
    console.log(`        want: ${want}`);
    fail++;
  }
};
const truthy = (name: string, got: boolean, want: boolean) => eq(name, String(got), String(want));

console.log("=== apex vs subpath (95% of sites are subpath) ===");
eq("apex when repo is <owner>.github.io",
  pagesUrlFor("alice", "alice.github.io", null), "https://alice.github.io/");
eq("subpath otherwise",
  pagesUrlFor("alice", "my-portfolio", null), "https://alice.github.io/my-portfolio/");
eq("case-insensitive owner",
  pagesUrlFor("Alice", "Alice.github.io", null), "https://alice.github.io/");
eq("repo case lowercased",
  pagesUrlFor("alice", "My-Portfolio", null), "https://alice.github.io/my-portfolio/");

console.log("=== untrusted homepage values (the real bugs) ===");
eq("homepage on a foreign domain is rejected",
  pagesUrlFor("jkunst", "foo", "http://jkunst.com/jbkunst.github.io3/"),
  "https://jkunst.github.io/foo/");
eq("github.com/wiki homepage is rejected",
  pagesUrlFor("mauriceling", "mauriceling.github.io", "https://github.com/mauriceling/mauriceling.github.io/wiki"),
  "https://mauriceling.github.io/");
eq("homepage pointing at ANOTHER user is rejected",
  pagesUrlFor("GPortfolio", "GPortfolio", "https://oleksiikhr.github.io/"),
  "https://gportfolio.github.io/gportfolio/");
eq("garbage homepage is rejected",
  pagesUrlFor("bob", "site", "not a url at all"),
  "https://bob.github.io/site/");
eq("homepage of a different user subdomain is rejected",
  pagesUrlFor("alice", "site", "https://mallory.github.io/x"),
  "https://alice.github.io/site/");

console.log("=== legitimate homepages are kept ===");
eq("own github.io homepage kept",
  pagesUrlFor("squidfunk", "mkdocs-material", "https://squidfunk.github.io/mkdocs-material/"),
  "https://squidfunk.github.io/mkdocs-material/");
eq("deep subpath homepage kept",
  pagesUrlFor("alphagov", "accessible-autocomplete", "https://alphagov.github.io/accessible-autocomplete/examples/"),
  "https://alphagov.github.io/accessible-autocomplete/examples/");

console.log("=== isValidPagesUrl ===");
truthy("valid subpath", isValidPagesUrl("https://a.github.io/b/"), true);
truthy("valid apex", isValidPagesUrl("https://a.github.io/"), true);
truthy("bare apex rejected", isValidPagesUrl("https://github.io/"), false);
truthy("pages.github.io rejected", isValidPagesUrl("https://x.pages.github.io/"), false);
truthy("foreign domain rejected", isValidPagesUrl("http://jkunst.com/x/"), false);
truthy("github.com rejected", isValidPagesUrl("https://github.com/a/b"), false);
truthy("not a url rejected", isValidPagesUrl("nonsense"), false);

console.log("=== HTML entity decoding (scraped metadata) ===");
eq("hex entity", decodeEntities("The world&#x27;s best"), "The world's best");
eq("decimal entity", decodeEntities("AT&#38;T and T&#38;T"), "AT&T and T&T");
eq("named amp", decodeEntities("Senior Software &amp; Platform Engineer"),
  "Senior Software & Platform Engineer");
// &nbsp; decodes to a space, so "&nbsp;&ndash;&nbsp;" leaves doubled spaces;
// decodeEntities collapses them, which is the intended behaviour.
eq("named nbsp and ndash", decodeEntities("Neonote&nbsp;&ndash;&nbsp;A theme"),
  "Neonote - A theme");
eq("collapsed whitespace is stable",
  decodeEntities(decodeEntities("Neonote&nbsp;&ndash;&nbsp;A theme")),
  "Neonote - A theme");
eq("named quot/lt/gt", decodeEntities("&lt;b&gt;bold&lt;/b&gt; &quot;quoted&quot;"), "<b>bold</b> \"quoted\"");
eq("ellipsis and mdash", decodeEntities("a&hellip;b&mdash;c"), "a...b-c");
eq("multiple in one string", decodeEntities("a &amp; b &amp; c"), "a & b & c");
truthy("idempotent", decodeEntities(decodeEntities("x&#x27;y")) === "x'y", true);
eq("text with no entities is unchanged", decodeEntities("plain text 123"), "plain text 123");

// Must NOT be over-eager: a bare ampersand or unknown entity stays put.
eq("bare ampersand preserved", decodeEntities("Tom & Jerry"), "Tom & Jerry");
eq("unknown entity preserved", decodeEntities("&notrealentity;"), "&notrealentity;");
// Control code points must not be smuggled in through an entity.
eq("control codepoint refused", decodeEntities("a&#0;b"), "a&#0;b");
eq("newline entity refused", decodeEntities("a&#10;b"), "a&#10;b");

console.log(`\n${fail === 0 ? "ALL URL CHECKS PASSED" : `${fail} CHECK(S) FAILED`}`);
process.exit(fail === 0 ? 0 : 1);
