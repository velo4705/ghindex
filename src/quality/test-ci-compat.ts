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
for (const wf of [".github/workflows/ci.yml", ".github/workflows/refresh-index.yml"]) {
  const yml = await Bun.file(wf).text();
  check(`${wf} sets CHROME_PATH`, yml.includes("CHROME_PATH="));
  check(`${wf} fails if no browser`, yml.includes("no Chromium browser"));
  check(`${wf} polls instead of fixed sleep`, /curl -sf/.test(yml));
  check(`${wf} has no bare 'sleep 3'`, !/^\s*sleep 3\s*$/m.test(yml));
}

console.log(`\n${fail === 0 ? "CI COMPATIBILITY OK" : `${fail} CHECK(S) FAILED`}`);
process.exit(fail === 0 ? 0 : 1);
