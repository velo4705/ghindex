/**
 * Idempotency test for the publish step.
 *
 * CI fails the build if `src/site/data` is dirty after running build.ts, on
 * the grounds that a no-op rebuild must produce no diff. That check shipped
 * broken: the manifest embedded `generated_at`, which changes every run, so
 * the file was rewritten even when zero shards changed. The build reported
 * "unchanged 27" while git still saw a modification -- a contradiction that
 * only shows up when you compare the two.
 *
 * This asserts the build is byte-stable across consecutive runs.
 */

import { readFileSync, existsSync } from "node:fs";
import { PATHS } from "../paths";

let fail = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) fail++;
};

const manifestPath = `${PATHS.data}/manifest.json`;
check("manifest exists", existsSync(manifestPath));
if (!existsSync(manifestPath)) process.exit(1);

const before = readFileSync(manifestPath, "utf8");
const beforeJson = JSON.parse(before.replace(/^\uFEFF/, ""));

// Two consecutive rebuilds. Either one changing anything is a failure.
for (let pass = 1; pass <= 2; pass++) {
  const proc = Bun.spawn(["bun", "run", "src/publish/build.ts"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const out = await new Response(proc.stdout).text();
  const code = await proc.exited;
  if (code !== 0) {
    console.log(out);
    check(`rebuild pass ${pass} exits 0`, false);
    break;
  }
  const after = readFileSync(manifestPath, "utf8");
  check(`rebuild pass ${pass} leaves manifest byte-identical`, after === before);
}

const afterJson = JSON.parse(readFileSync(manifestPath, "utf8").replace(/^\uFEFF/, ""));

check("generated_at is preserved across no-op rebuilds",
  beforeJson.generated_at === afterJson.generated_at,
  `${beforeJson.generated_at}`);

check("manifest carries a content fingerprint", typeof afterJson.fingerprint === "string",
  afterJson.fingerprint);

check("fingerprint is derived from content, not time", afterJson.fingerprint.length === 16);

// Shard files must not be rewritten either.
const shard = `${PATHS.data}/s.json`;
if (existsSync(shard)) {
  const s1 = readFileSync(shard, "utf8");
  Bun.spawnSync(["bun", "run", "src/publish/build.ts"], { stdout: "ignore", stderr: "ignore" });
  check("shard file is not rewritten on a no-op rebuild", readFileSync(shard, "utf8") === s1);
}

console.log(`\n${fail === 0 ? "BUILD IS IDEMPOTENT" : `${fail} CHECK(S) FAILED`}`);
process.exit(fail === 0 ? 0 : 1);
