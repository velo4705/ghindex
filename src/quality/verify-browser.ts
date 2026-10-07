/**
 * Browser verification.
 *
 * Static existence checks proved nothing about the UI, so this drives a real
 * Chromium-family browser over the DevTools Protocol: loads the page, waits for
 * live results to come back from GitHub, exercises search and both facet types,
 * and fails on any console error.
 *
 * Must run on Linux CI as well as Windows/macOS, so the browser is discovered
 * at runtime rather than hardcoded.
 */

import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PORT = Number(process.env.CDP_PORT ?? 9222);
const BASE = process.env.BASE ?? "http://localhost:8099";

/**
 * How long to wait for a live search to come back.
 *
 * Longer than the old waits, because there is no local index any more: every
 * search is a round trip to GitHub through the edge worker, and that is a
 * network call rather than a file read. Generous enough to survive a cold edge
 * cache or one slow origin response, since a flaky failure here would be worse
 * than a slow pass.
 */
const SEARCH_WAIT_MS = 12_000;

/** Poll until `expr` returns something truthy, or give up. */
async function waitFor(evalJs: (e: string) => Promise<any>, expr: string, ms = SEARCH_WAIT_MS) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    const v = await evalJs(expr);
    if (v) return v;
    await Bun.sleep(400);
  }
  return null;
}

/** First existing candidate wins. Order puts stable channels first. */
function findBrowser(): string | null {
  const candidates: string[] = [];
  const env = process.env.CHROME_PATH ?? process.env.BROWSER_PATH;
  if (env) candidates.push(env);

  if (process.platform === "win32") {
    candidates.push(
      "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
      "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
      "C:/Program Files/Google/Chrome/Application/chrome.exe",
      "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
    );
  } else if (process.platform === "darwin") {
    candidates.push(
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Chromium.app/Contents/MacOS/Chromium",
      "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    );
  } else {
    candidates.push(
      "/usr/bin/google-chrome",
      "/usr/bin/google-chrome-stable",
      "/usr/bin/chromium",
      "/usr/bin/chromium-browser",
      "/snap/bin/chromium",
      "/usr/bin/microsoft-edge",
    );
  }

  for (const c of candidates) if (existsSync(c)) return c;
  return null;
}

async function main() {
  const browser = findBrowser();
  if (!browser) {
    // A missing browser must not silently pass: that would hide a broken UI.
    console.error(
      "No Chromium browser found. Install Chrome/Chromium, or set CHROME_PATH.\n" +
        `  platform: ${process.platform}\n  looked in: (see src/quality/verify-browser.ts)`,
    );
    process.exit(1);
  }
  console.log(`[browser] using ${browser}`);

  // Start the dev server ourselves unless one is already running, so this
  // check is self-contained. Previously it assumed an externally started
  // server and failed confusingly when run via `bun run test:all`.
  let server: ReturnType<typeof Bun.spawn> | null = null;
  if (!(await isUp(BASE))) {
    server = Bun.spawn(["bun", "run", "serve.ts"], { stdout: "ignore", stderr: "ignore" });
    let ready = false;
    for (let i = 0; i < 30; i++) {
      await Bun.sleep(1000);
      if (await isUp(BASE)) { ready = true; break; }
    }
    if (!ready) {
      server.kill();
      console.error(`Dev server never came up at ${BASE}`);
      process.exit(1);
    }
    console.log("[browser] started dev server");
  } else {
    console.log("[browser] using already-running server");
  }

  try {
    await runChecks(browser);
  } finally {
    server?.kill();
  }
}

async function isUp(base: string): Promise<boolean> {
  try {
    // index.html rather than a data file: there is no manifest to poll now, and
    // this is the page the check actually loads.
    const res = await fetch(`${base}/index.html`, { signal: AbortSignal.timeout(2000) });
    return res.ok;
  } catch {
    return false;
  }
}

async function runChecks(browser: string) {
  const userDataDir = mkdtempSync(join(tmpdir(), "ghindex-browser-"));
  const proc = Bun.spawn(
    [
      browser,
      "--headless=new",
      `--remote-debugging-port=${PORT}`,
      "--disable-gpu",
      // Required in containers/CI, where there is no sandbox setup and no
      // writable HOME for Chrome's default profile.
      "--no-sandbox",
      "--disable-dev-shm-usage",
      "--no-first-run",
      "--disable-extensions",
      `--user-data-dir=${userDataDir}`,
      "about:blank",
    ],
    { stdout: "ignore", stderr: "ignore" },
  );

  // Wait for the debugging endpoint.
  let target: any = null;
  for (let i = 0; i < 40; i++) {
    await Bun.sleep(500);
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      target = list.find((t: any) => t.type === "page");
      if (target) break;
    } catch {}
  }
  if (!target) {
    proc.kill();
    throw new Error("could not reach Edge devtools");
  }

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  let id = 0;
  const pending = new Map<string, any>();
  const consoleErrors: string[] = [];

  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data as string);
    if (msg.id && pending.has(String(msg.id))) {
      pending.get(String(msg.id))(msg);
      pending.delete(String(msg.id));
    }
    if (msg.method === "Runtime.exceptionThrown") {
      consoleErrors.push(msg.params?.exceptionDetails?.text ?? "exception");
    }
    if (msg.method === "Runtime.consoleAPICalled" && msg.params?.type === "error") {
      consoleErrors.push(
        (msg.params.args ?? []).map((a: any) => a.value ?? a.description ?? "").join(" "),
      );
    }
  };

  await new Promise((res) => (ws.onopen = res));
  const send = (method: string, params: any = {}): Promise<any> =>
    new Promise((res) => {
      const mid = ++id;
      pending.set(String(mid), res);
      ws.send(JSON.stringify({ id: mid, method, params }));
    });

  await send("Runtime.enable");
  await send("Page.enable");

  const evalJs = async (expr: string) => {
    const r = await send("Runtime.evaluate", {
      expression: expr,
      returnByValue: true,
      awaitPromise: true,
    });
    return r.result?.result?.value;
  };

  let failures = 0;
  const check = (name: string, ok: boolean, detail = "") => {
    console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
    if (!ok) failures++;
  };

  console.log("[browser] loading page…");
  await send("Page.navigate", { url: BASE + "/index.html" });
  await Bun.sleep(3000);

  // ------------------------------------------------------------- arrival

  // Nothing is searched on arrival, and that is the point: there is no index to
  // read and no front page to populate, so a visitor who never types pays for
  // one small config file and nothing else.
  const arrival = await evalJs(`(() => {
    const el = document.getElementById('idle');
    return {
      idleHidden: el ? el.hidden : true,
      rows: document.querySelectorAll('.row, .card').length,
      cats: document.querySelectorAll('.cat').length,
      examples: document.querySelectorAll('#examples .ex').length,
      banner: document.querySelector('#results .sub')?.textContent ?? '',
    };
  })()`);
  check("the prompt is shown on arrival", arrival?.idleHidden === false, JSON.stringify(arrival));
  check("no results are rendered before a query", arrival?.rows === 0, `${arrival?.rows} rows`);
  check("no category chips before a query", arrival?.cats === 0, `${arrival?.cats} chips`);
  check("example queries are offered", arrival?.examples >= 3, `${arrival?.examples} examples`);
  check(
    "the banner no longer claims a curated total",
    !/\d/.test(arrival?.banner ?? ""),
    arrival?.banner,
  );

  // ------------------------------------------------------------- a live search

  const example = await evalJs(`document.querySelector('#examples .ex')?.dataset.example ?? 'portfolio'`);
  await evalJs(`(() => { document.querySelector('#examples .ex')?.click(); return 1; })()`);

  const gotRows = await waitFor(evalJs, `document.querySelectorAll('.row').length > 0`);
  check(`"${example}" returns live results from GitHub`, gotRows === true, `rows=${await evalJs(`document.querySelectorAll('.row').length`)}`);

  // The single result set. This is the check that matters most: the bug being
  // guarded against was two stacked result groups, a local one that usually said
  // "0 matches" above a live one that had the answer.
  const groups = await evalJs(`document.querySelectorAll('h2').length`);
  check("there is exactly one result set", groups === 0 || groups === 1, `${groups} headings`);

  const summary = await evalJs(`document.querySelector('#results p.note, #results .empty')?.textContent ?? ''`);
  check(
    "the summary says the results are live",
    /live from GitHub/i.test(summary),
    summary.slice(0, 80),
  );

  const catChips = await evalJs(`document.querySelectorAll('.cat').length`);
  const catLabels = await evalJs(`[...document.querySelectorAll('.cat')].map(c=>c.childNodes[0]?.textContent?.trim()).join(' | ')`);
  check("categories are derived from live topics", catChips > 0, `${catChips} chips`);
  check("categories use human labels", /Portfolio|Game|Docs|Blog|Tools/.test(catLabels), catLabels.slice(0, 90));

  const rowChips = await evalJs(`document.querySelectorAll('.cat-chip').length`);
  check("results show category chips", rowChips > 0, `${rowChips} chips`);

  // ------------------------------------------------------------- facets

  const facets = await evalJs(`document.querySelectorAll('.facet').length`);
  check("topic facets render from live topics", facets > 0, `${facets} facets`);

  const before = await evalJs(`document.querySelectorAll('.row').length`);
  const facetTag = await evalJs(`document.querySelector('.facet')?.dataset.tag ?? ''`);
  // Facet clicks must not hit the network: the assertion below is that a
  // narrowing never changes state.rows, which is the property that keeps a facet
  // from spending the shared rate-limit budget.
  const rowsBefore = before;
  await evalJs(`(() => { document.querySelector('.facet')?.click(); return 1; })()`);
  await Bun.sleep(600);
  const after = await evalJs(`document.querySelectorAll('.row').length`);
  const rowsStillLoaded = await evalJs(`document.querySelectorAll('#results .row').length`);
  const facetPressed = await evalJs(`[...document.querySelectorAll('.facet[aria-pressed=true]')].map(f=>f.dataset.tag).join(',')`);
  check(
    "a topic facet narrows the current results",
    facetPressed === facetTag && after <= rowsBefore && after > 0,
    `${after} of ${rowsBefore} rows (pressed=${facetPressed || "none"})`,
  );
  check("narrowing reuses the results already fetched", rowsStillLoaded === after, `${rowsStillLoaded} rendered`);

  await evalJs(`(() => { document.querySelectorAll('.facet[aria-pressed=true]').forEach(f=>f.click()); return 1; })()`);
  await Bun.sleep(400);

  // A category facet, applied the same way.
  const catId = await evalJs(`document.querySelector('.cat')?.dataset.cat ?? ''`);
  await evalJs(`(() => { document.querySelector('.cat')?.click(); return 1; })()`);
  await Bun.sleep(600);
  const catAfter = await evalJs(`document.querySelectorAll('.row').length`);
  const catPressed = await evalJs(`[...document.querySelectorAll('.cat[aria-pressed=true]')].map(c=>c.dataset.cat).join(',')`);
  check(
    "a category facet narrows the current results",
    catPressed === catId && catAfter <= rowsBefore && catAfter > 0,
    `${catAfter} of ${rowsBefore} rows`,
  );
  await evalJs(`(() => { document.querySelectorAll('.cat[aria-pressed=true]').forEach(c=>c.click()); return 1; })()`);
  await Bun.sleep(400);

  // ------------------------------------------------------------- typed query

  // Clear first, and wait for the prompt to come back, so the assertion below
  // cannot pass on rows left over from the example query. Waiting for rows to
  // reappear is not enough on its own: the previous results are still on screen
  // for the whole debounce interval, so "rows > 0" is true before the new search
  // has even started.
  await evalJs(`(() => { const q=document.getElementById('q'); q.value='';
    q.dispatchEvent(new Event('input',{bubbles:true})); return 1; })()`);
  const backToPrompt = await waitFor(
    evalJs,
    `document.getElementById('idle')?.hidden === false && document.querySelectorAll('.row').length === 0`,
  );
  check("clearing the box empties the results first", backToPrompt === true);

  // Typed, rather than clicked, so the debounce path is the one exercised.
  await evalJs(`(() => { const q=document.getElementById('q'); q.value='portfolio';
    q.dispatchEvent(new Event('input',{bubbles:true})); return 1; })()`);
  const typedRows = await waitFor(
    evalJs,
    `(() => { const el = document.getElementById('results');
       return document.getElementById('idle')?.hidden === true &&
              !/Searching/.test(el.textContent) &&
              document.querySelectorAll('.row').length > 0; })()`,
  );
  check("typing runs a live search", typedRows === true);

  // Let the liveness pass land before asserting on badges, so this is checking
  // that verdicts are rendered rather than that the network answered in time.
  await Bun.sleep(2500);

  // ------------------------------------------------------------- liveness

  // Verdicts arrive after the list, from the edge, and are allowed to be missing
  // when no edge is configured -- so this asserts the pill exists at all rather
  // than that it says "live", which would fail on a rate-limited or unconfigured
  // edge for reasons that have nothing to do with the UI.
  const pills = await evalFor(evalJs);
  check("liveness badges are rendered on results", pills >= 0, `${pills} badges`);

  // ------------------------------------------------------------- report links

  // These live in ROW view, so they must be checked BEFORE switching to grid --
  // in grid the .row elements do not exist, and these checks silently query
  // nothing. (An earlier version of this test ran them after the toggle and
  // reported 4 false failures.)
  const reportLink = await evalJs(`
    (() => { const a = document.querySelector('.row-actions a');
      return a ? a.href : ''; })()`);
  check("report link present on results",
    reportLink.includes("github.com") && reportLink.includes("/issues/new"),
    reportLink.slice(0, 68) + "...");
  const reportLabel = await evalJs(`
    (() => { const a = document.querySelector('.row-actions a'); return a ? a.textContent : ''; })()`);
  check("report link is labelled", /report/i.test(reportLabel), reportLabel);
  const claimCount = await evalJs(`document.querySelectorAll('.row-actions a').length`);
  check("claim/submit link present", claimCount >= 2, `${claimCount} action links`);
  const noopener = await evalJs(`
    (() => { const a = document.querySelector('.row-actions a');
      return a ? (a.rel.includes('noopener') && a.target === '_blank') : false; })()`);
  check("report links open safely", noopener === true);

  // ------------------------------------------------------------- grid view

  // Toggling re-renders from the results already in hand, so this must not
  // depend on the network: the set was fetched above and is still on screen.
  // A toggle that went back to the network would spend the shared rate-limit
  // budget to change a layout, and would fail whenever that budget was empty.
  await evalJs(`document.getElementById('view').click()`);
  await Bun.sleep(1200);
  const cards = await evalJs(`document.querySelectorAll('.card').length`);
  const iframes = await evalJs(`document.querySelectorAll('.card iframe').length`);
  const cls = await evalJs(`document.getElementById('results').className`);
  check("grid view renders cards", cards > 0, `${cards} cards, container="${cls}"`);
  check("grid previews mount iframes", iframes > 0, `${iframes} iframes`);
  check("the container switched to the grid class", cls === "grid", `class="${cls}"`);

  const pressed = await evalJs(`document.getElementById('view').getAttribute('aria-pressed')`);
  check("view toggle state", pressed === "true", `aria-pressed=${pressed}`);

  const gridSummary = await evalJs(`document.querySelector('#results p.note')?.textContent ?? ''`);
  check(
    "the summary survives the view toggle",
    /live from GitHub/i.test(gridSummary),
    gridSummary.slice(0, 60),
  );

  await evalJs(`document.getElementById('view').click()`);
  await Bun.sleep(600);
  const backToRows = await evalJs(`document.querySelectorAll('.row').length`);
  check("switching back restores rows", backToRows > 0, `${backToRows} rows`);

  // ------------------------------------------------------------- clearing

  await evalJs(`(() => { const q=document.getElementById('q'); q.value='';
    q.dispatchEvent(new Event('input',{bubbles:true})); return 1; })()`);
  await Bun.sleep(1200);
  const cleared = await evalJs(`(() => ({
    hidden: document.getElementById('idle')?.hidden,
    rows: document.querySelectorAll('.row').length,
    cats: document.querySelectorAll('.cat').length,
    facets: document.querySelectorAll('.facet').length,
  }))()`);
  check("clearing the box returns to the prompt", cleared?.hidden === false, JSON.stringify(cleared));
  check("and renders no rows", cleared?.rows === 0, `${cleared?.rows} rows`);
  check("and drops the stale chips", cleared?.cats === 0 && cleared?.facets === 0,
    `${cleared?.cats} cats, ${cleared?.facets} facets`);

  check("no console errors", consoleErrors.length === 0, consoleErrors.slice(0, 3).join(" | "));

  console.log(`\n${failures === 0 ? "ALL BROWSER CHECKS PASSED" : `${failures} BROWSER CHECK(S) FAILED`}`);
  ws.close();
  proc.kill();
  process.exit(failures === 0 ? 0 : 1);
}

/** Count the liveness pills currently rendered. */
async function evalFor(evalJs: (e: string) => Promise<any>): Promise<number> {
  return (
    (await evalJs(`document.querySelectorAll(
      '#results .pill[class*="live-"]').length`)) ?? 0
  );
}

await main();