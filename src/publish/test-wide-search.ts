/**
 * M7 — on-demand GitHub search.
 *
 * The local index cannot be a complete census: the API caps at 1,000 results
 * per query and there is no endpoint that lists all Pages sites. Measured
 * against topics the harvester never used, 96% of Pages-enabled owners found
 * that way were absent from the local index. This module is the escape hatch,
 * so the URL-resolution rules and the filter for has_pages are worth pinning.
 */

import { pagesUrlFor, buildQueryForTest } from "../../src/site/github-search.js";

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

console.log("=== URL resolution matches the crawler (core.ts) ===");
eq("apex when repo is <owner>.github.io",
  pagesUrlFor("alice", "alice.github.io", null), "https://alice.github.io/");
eq("subpath otherwise",
  pagesUrlFor("alice", "my-portfolio", null), "https://alice.github.io/my-portfolio/");
eq("owner github.io homepage kept",
  pagesUrlFor("squidfunk", "mkdocs-material", "https://squidfunk.github.io/mkdocs-material/"),
  "https://squidfunk.github.io/mkdocs-material/");
eq("foreign homepage rejected",
  pagesUrlFor("jkunst", "foo", "http://jkunst.com/jbkunst.github.io3/"),
  "https://jkunst.github.io/foo/");
eq("another user's homepage rejected",
  pagesUrlFor("alice", "site", "https://mallory.github.io/x"),
  "https://alice.github.io/site/");
eq("github.com/wiki rejected",
  pagesUrlFor("mauriceling", "mauriceling.github.io", "https://github.com/mauriceling/mauriceling.github.io/wiki"),
  "https://mauriceling.github.io/");
eq("case-insensitive owner",
  pagesUrlFor("Alice", "Alice.github.io", null), "https://alice.github.io/");

console.log("=== query construction ===");
eq("single word is not over-quoted", buildQueryForTest("portfolio"),
  "portfolio in:name,description,readme");
eq("multi word is quoted as a phrase", buildQueryForTest("react portfolio"),
  '"react portfolio" in:name,description,readme');
eq("quotes in input are stripped", buildQueryForTest('we"ird'),
  "weird in:name,description,readme");
eq("empty input yields empty query", buildQueryForTest("   "), "");
eq("backslashes stripped", buildQueryForTest("a\\b"), "ab in:name,description,readme");

console.log(`\n${fail === 0 ? "ON-DEMAND SEARCH OK" : `${fail} CHECK(S) FAILED`}`);
process.exit(fail === 0 ? 0 : 1);
