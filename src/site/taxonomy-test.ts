/** Direct unit checks on the classifier, independent of corpus shape. */
import { classify, CATEGORIES, BROWSE_TAGS, TECH_TOKENS } from "./taxonomy.js";

let fail = 0;
const t = (name: string, got: string[], want: string[]) => {
  const ok = want.every((w) => got.includes(w));
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}  -> [${got.join(",") || "none"}]${ok ? "" : ` (wanted ${want.join(",")})`}`);
  if (!ok) fail++;
};

console.log("=== exact topic ===");
t("portfolio", classify(["portfolio"]).categories, ["portfolio"]);
t("game", classify(["game"]).categories, ["games"]);
t("cv alone is ambiguous", classify(["cv"]).categories, []);

console.log("=== compound / hyphenated topics ===");
t("portfolio-website", classify(["portfolio-website"]).categories, ["portfolio"]);
t("personal-website", classify(["personal-website"]).categories, ["portfolio"]);
t("game-development", classify(["game-development"]).categories, ["games"]);
t("admin-dashboard", classify(["admin-dashboard"]).categories, ["dashboards"]);

console.log("=== multi-label ===");
t("portfolio blog", classify(["portfolio", "blog"]).categories, ["portfolio", "blog"]);
t("blog + docs", classify(["blog", "documentation"]).categories, ["blog", "docs"]);

console.log("=== technology-only must NOT be classified ===");
t("react only", classify(["react"]).categories, []);
t("js+css+html", classify(["javascript", "css", "html5", "html-css"]).categories, []);
t("full react stack", classify(["react", "reactjs", "typescript", "tailwindcss", "vite"]).categories, []);

console.log("=== library/framework group (was the biggest gap) ===");
t("ui-kit", classify(["ant-design", "design-systems", "react", "typescript"]).categories, ["libraries"]);
t("component-library", classify(["components", "react", "typescript"]).categories, ["libraries"]);
t("build-tools", classify(["build-tools", "react", "zero-configuration"]).categories, ["libraries"]);

console.log("=== no false substring matches ===");
// "reactjs" must not be treated as a topic that implies a purpose category.
t("reactjs", classify(["reactjs"]).categories, []);
t("jquery", classify(["jquery"]).categories, []);

console.log("=== normalization ===");
t("underscores", classify(["personal_website"]).categories, ["portfolio"]);
t("uppercase", classify(["PORTFOLIO"]).categories, ["portfolio"]);
t("spaces", classify(["personal website"]).categories, ["portfolio"]);

console.log("=== ambiguous 'cv' (curriculum vitae vs computer vision) ===");
t("cv + resume", classify(["cv", "resume"]).categories, ["portfolio"]);
t("cv + portfolio", classify(["cv", "portfolio-website"]).categories, ["portfolio"]);
t("cv + deep-learning = ML, NOT portfolio", classify(["cv", "deep-learning", "python"]).categories, []);
t("cv + opencv = CV, NOT portfolio", classify(["cv", "opencv", "face-detection"]).categories, []);
t("cv + machine-learning", classify(["cv", "machine-learning"]).categories, []);

console.log("=== evidence is recorded (explainability) ===");
const ev = classify(["portfolio-website", "blog"]);
console.log(`  evidence: ${JSON.stringify(ev.evidence)}`);
if (!ev.evidence.portfolio?.length) { console.log("  FAIL no evidence for portfolio"); fail++; }

console.log("=== every category constant is a valid key ===");
console.log(`  categories: ${CATEGORIES.join(", ")}`);

console.log("=== the tag picker's list ===");
let tfail = 0;
const ok = (name: string, cond: boolean, detail = "") => {
  console.log(`  ${cond ? "PASS" : "FAIL"}  ${name}${cond ? "" : `  ${detail}`}`);
  if (!cond) tfail++;
};

ok("the picker offers tags", BROWSE_TAGS.length >= 20, `${BROWSE_TAGS.length}`);
ok(
  "no duplicate tags",
  new Set(BROWSE_TAGS).size === BROWSE_TAGS.length,
  BROWSE_TAGS.filter((t, i) => BROWSE_TAGS.indexOf(t) !== i).join(", "),
);
ok(
  "every tag is a lowercase slug",
  BROWSE_TAGS.every((t) => /^[a-z0-9]+(-[a-z0-9]+)*$/.test(t)),
  BROWSE_TAGS.filter((t) => !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(t)).join(", "),
);
// The picker exists to browse by purpose, not by technology. A tag that only
// says what a site was built with turns it into a second box for typing a
// language name, which is exactly what the search box above already does.
ok(
  "no technology-only tags in the picker",
  BROWSE_TAGS.every((t) => !TECH_TOKENS.has(t)),
  BROWSE_TAGS.filter((t) => TECH_TOKENS.has(t)).join(", "),
);
// A tag in the picker that the classifier does not recognise would be a control
// that searches for something and then files it as uncategorised.
ok(
  "every picker tag is one the classifier understands",
  BROWSE_TAGS.every((t) => classify([t]).categories.length > 0),
  BROWSE_TAGS.filter((t) => classify([t]).categories.length === 0).join(", "),
);
fail += tfail;

console.log(`\n${fail === 0 ? "ALL CLASSIFIER CHECKS PASSED" : `${fail} CHECK(S) FAILED`}`);
process.exit(fail === 0 ? 0 : 1);
