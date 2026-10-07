/**
 * Simulate the CI environment for the browser test to prove it no longer
 * depends on the local machine. Checks the things that broke in CI:
 *   1. browser discovery is not hardcoded to one platform's paths
 *   2. the user-data-dir is created under the OS temp dir, which exists in CI
 *   3. a missing browser produces a clear error, not a silent pass
 */

import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let fail = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) fail++;
};

const src = await Bun.file("src/quality/verify-browser.ts").text();

console.log("=== 1. no hardcoded machine-specific paths ===");
check(
  "no C:/Users path",
  !/C:\/Users/i.test(src),
  "the old JOVIAN~1 temp path is gone",
);
check("uses os.tmpdir()", /from "node:os"/.test(src) && /tmpdir\(\)/.test(src));

console.log("=== 2. platform-aware browser discovery ===");
check("handles win32", src.includes('"win32"'));
check("handles darwin", src.includes('"darwin"'));
// Linux is the `else` branch, so assert on the paths it offers instead.
check("has a Linux (else) branch", /google-chrome[\s\S]{0,400}chromium/.test(src));
check("honours CHROME_PATH override", /CHROME_PATH/.test(src));

console.log("=== 3. CI-required chrome flags ===");
for (const flag of ["--no-sandbox", "--disable-dev-shm-usage", "--no-first-run"]) {
  check(`passes ${flag}`, src.includes(flag));
}

console.log("=== 4. missing browser is a hard failure, not a silent pass ===");
const missingBlock = src.slice(src.indexOf("if (!browser)"));
check(
  "exits non-zero when no browser",
  missingBlock.slice(0, 400).includes("process.exit(1)"),
  "so a missing browser cannot hide a broken UI",
);

console.log("=== 5. temp dir is actually creatable here ===");
const dir = mkdtempSync(join(tmpdir(), "ghindex-ci-sim-"));
check("mkdtempSync under tmpdir works", existsSync(dir), dir);
rmSync(dir, { recursive: true, force: true });

console.log("=== 6. workflows pass CHROME_PATH and poll the server ===");
// Only ci.yml drives a browser now. The nightly refresh workflow is gone with
// the index it used to regenerate, so it must not be listed here: a check that
// reads a deleted file fails for a reason that has nothing to do with the UI.
for (const wf of [".github/workflows/ci.yml"]) {
  const yml = await Bun.file(wf).text();
  check(`${wf} sets CHROME_PATH`, yml.includes("CHROME_PATH="));
  check(`${wf} fails if no browser`, yml.includes("no Chromium browser"));
  check(`${wf} polls instead of fixed sleep`, /curl -sf/.test(yml));
  check(`${wf} has no bare 'sleep 3'`, !/^\s*sleep 3\s*$/m.test(yml));
}
{
  // The browser test polls the page now, because there is no manifest left to
  // wait on. Polling a file that was deleted would loop for 30s and then carry
  // on regardless, which is exactly the kind of quiet no-op this catches.
  const yml = await Bun.file(".github/workflows/ci.yml").text();
  check("ci.yml polls a path that exists", /curl -sf http:\/\/localhost:8099\/index\.html/.test(yml));
  check("ci.yml does not poll the deleted manifest", !/manifest\.json/.test(yml));
  const browser = await Bun.file("src/quality/verify-browser.ts").text();
  check(
    "the browser test also probes a path that exists",
    /\/index\.html/.test(browser) && !/manifest\.json/.test(browser),
  );
}

console.log("=== 7. every workflow installs bun via the action, not a shell installer ===");
// The shell installer appends ~/.bun/bin to ~/.bash_profile, which
// non-interactive Actions steps never source, so `bun` stayed "command not
// found" and the deploy workflow failed. Every workflow must use setup-bun.
// Comments are stripped first: the fix is documented in a comment that mentions
// the very paths this check forbids, which is not an actual PATH hack.
const stripYamlComments = (s: string) =>
  s
    .split("\n")
    .map((l) => (/^\s*#/.test(l) ? "" : l))
    .join("\n");

const WORKFLOWS = [
  ".github/workflows/ci.yml",
  ".github/workflows/deploy-pages.yml",
];
for (const wf of WORKFLOWS) {
  const raw = await Bun.file(wf).text();
  const yml = stripYamlComments(raw);
  check(`${wf} uses oven-sh/setup-bun`, yml.includes("oven-sh/setup-bun"));
  check(`${wf} has no bun.sh/install fallback`, !/bun\.sh\/install/.test(yml));
  check(`${wf} has no PATH hack for bun`, !/BUN_INSTALL|\.bun\/bin/.test(yml));
}

// Every workflow this test reads must exist. A stale name here fails as a
// missing file rather than as the check it stands for, which hides the real
// problem.
{
  const listed = [...(await Bun.file(".github/workflows/ci.yml").text()).matchAll(/\S+\.ya?ml/g)]
    .map((m) => m[0]);
  check(
    "no workflow references a deleted workflow",
    !listed.includes("refresh-index.yml"),
    listed.join(", "),
  );
}

console.log("=== 8. deploy workflow uploads the site dir and needs the Pages env ===");
{
  const yml = await Bun.file(".github/workflows/deploy-pages.yml").text();
  check("uploads src/site", /path:\s*src\/site/.test(yml));
  check("uses the github-pages environment", /environment:[\s\S]{0,80}github-pages/.test(yml));
  check("requests pages:write and id-token:write", /pages:\s*write/.test(yml) && /id-token:\s*write/.test(yml));
  check("verifies before deploying", /test-idle\.ts/.test(yml));
  check("does not cancel an in-flight deploy", /cancel-in-progress:\s*false/.test(yml));
  // These gates all described a generated index and died with it.
  check("does not call the deleted page test", !/test-pages\.ts/.test(yml));
  check("does not call the deleted health gate", !/quality\/health\.ts/.test(yml));
  check("does not assert on index freshness", !/max-age-hours/.test(yml));
}

console.log("=== 9. no workflow runs the deleted nightly index refresh ===");
for (const wf of WORKFLOWS) {
  const raw = await Bun.file(wf).text();
  for (const gone of ["harvest.ts", "index/probe.ts", "bun run build", "bun run pages", "quality/perf-budget"]) {
    check(`${wf} does not run ${gone}`, !raw.includes(gone));
  }
}

console.log(`\n${fail === 0 ? "CI COMPATIBILITY OK" : `${fail} CHECK(S) FAILED`}`);
process.exit(fail === 0 ? 0 : 1);
