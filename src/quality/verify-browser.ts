/**
 * Browser verification.
 *
 * Static existence checks proved nothing about the UI, so this drives a real
 * Chromium-family browser over the DevTools Protocol: loads the page, waits for
 * live results to come back from GitHub, exercises search and the tag picker,
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
 * cache or one slow origin response, since a flaky failure here is worse than a
 * slow pass.
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
  // ReturnByValue serialises this to JSON, so each value must be a plain
  // scalar. Building the object in a second step keeps that explicit and means a
  // new field cannot silently arrive as `undefined` and fail every check at once.
  const arrival = await evalJs(`(() => {
    const box = document.getElementById('q').getBoundingClientRect();
    const hero = document.querySelector('.hero').getBoundingClientRect();
    const mid = (r) => (r.left + r.right) / 2;
    return JSON.stringify({
      rows: document.querySelectorAll('#results .row').length,
      resultsText: document.getElementById('results').textContent.trim(),
      help: (document.querySelector('.help') || {}).textContent || '',
      h1: (document.querySelector('h1') || {}).textContent || '',
      tagline: (document.querySelector('.tagline') || {}).textContent || '',
      searchOffset: Math.round(Math.abs(mid(box) - mid(hero))),
      // clientWidth, not innerWidth: innerWidth includes the scrollbar gutter,
      // so centring against it measures the layout as off-centre by half the
      // scrollbar width on any page tall enough to scroll.
      heroOffset: Math.round(Math.abs(mid(hero) - document.documentElement.clientWidth / 2)),
    });
  })()`);
  const a = JSON.parse(String(arrival));
  check("a title is shown", (a.h1 || "").length > 0, a.h1);
  check("a subtitle is shown", (a.tagline || "").length > 0, a.tagline);
  check("a help line is shown", /GitHub/.test(a.help || ""), (a.help || "").slice(0, 60));
  check("the search box is centred under the hero", a.searchOffset <= 2, `${a.searchOffset}px off centre`);
  check("the hero is centred on the page", a.heroOffset <= 2, `${a.heroOffset}px off centre`);
  check("no results before a query", a.rows === 0, `${a.rows} rows`);
  check("and no empty placeholder either", a.resultsText === "", JSON.stringify(a.resultsText.slice(0, 40)));

  // Nothing that used to be there should still be there.
  const chrome = await evalJs(`(() => ({
    stars: !!document.getElementById('stars'),
    view: !!document.getElementById('view'),
    token: !!document.getElementById('token'),
    workers: typeof Worker,
  }))()`);
  check("no star filter", chrome?.stars === false);
  check("no preview toggle", chrome?.view === false);
  check("no token field", chrome?.token === false);

  // ------------------------------------------------------------- tag picker

  const picker = await evalJs(`JSON.stringify((() => ({
    tags: document.querySelectorAll('#taglist .tagbtn').length,
    labels: [...document.querySelectorAll('#taglist .tagbtn')].map(b=>b.textContent).slice(0,6),
    heading: document.querySelectorAll('.tagpick h2, .tagpick h3').length,
    height: Math.round(document.getElementById('taglist').getBoundingClientRect().height),
  }))())`);
  const p = JSON.parse(String(picker));
  check("the tag picker is populated", p.tags >= 20, `${p.tags} tags`);
  check(
    "the picker is short enough to scan",
    p.tags <= 120,
    `${p.tags} tags`,
  );
  check(
    "no technology-only tags in the picker",
    !/^(react|javascript|typescript|css|html|python|vue)$/.test((p.labels || []).join(",")),
    (p.labels || []).join(", "),
  );

  // An uppercase letterspaced "BROWSE BY TOPIC" heading was tried and removed:
  // a dated label for a control nobody asked about, sitting between the reader
  // and the search box.
  check("the picker carries no heading", p.heading === 0, `${p.heading} headings`);

  // It must stay cheap in vertical terms, or it pushes the results — the thing
  // the visitor came for — down the page. Small chips wrapping into a block is
  // the intended shape; large chips filling half the viewport is not.
  check("the picker stays out of the way vertically", p.height <= 260, `${p.height}px tall`);
  check(
    "and sits above the fold on a laptop",
    await evalJs(`Math.round(document.getElementById('taglist').getBoundingClientRect().bottom)`) <= 760,
  );

  // ------------------------------------------------------------- a live search

  const tag = await evalJs(`document.querySelector('#taglist .tagbtn')?.dataset.tag || ''`);
  await evalJs(`document.querySelector('#taglist .tagbtn')?.click()`);
  const tagRows = await waitFor(
    evalJs,
    `(() => { const el = document.getElementById('results');
       return !/Searching/.test(el.textContent) && document.querySelectorAll('#results .row').length > 0; })()`,
  );
  check(`picking "${tag}" returns live results`, tagRows === true,
    `${await evalJs(`document.querySelectorAll('#results .row').length`)} rows`);

  const pressed = await evalJs(`[...document.querySelectorAll('#taglist .tagbtn[aria-pressed=true]')].map(b=>b.dataset.tag).join(',')`);
  check("the picked tag shows as selected", pressed === tag, `pressed=${pressed || "none"}`);

  const summary = await evalJs(`document.querySelector('#results p.note')?.textContent ?? ''`);
  check("the summary says the results are live", /live from GitHub/i.test(summary), summary.slice(0, 70));
  check("the summary names the topic being searched", new RegExp(tag).test(summary), summary.slice(0, 70));

  // One result set. This is the check that matters most: the bug being guarded
  // against was two stacked groups, a local one usually saying "0 matches"
  // above a live one that had the answer.
  check("there is exactly one results container", await evalJs(`document.querySelectorAll('#results').length`) === 1);

  const pills = await evalJs(`document.querySelectorAll('#results .pill[class*="live-"]').length`);
  check("liveness badges are rendered", pills > 0, `${pills} badges`);

  // ------------------------------------------------------------- tag toggle off

  // A picker that can only be turned on is a one-way door: someone who picks
  // the wrong tag would have to reload to get back.
  await evalJs(`document.querySelector('#taglist .tagbtn[aria-pressed=true]')?.click()`);
  await Bun.sleep(500);
  check(
    "clicking the selected tag clears it",
    await evalJs(`document.querySelectorAll('#taglist .tagbtn[aria-pressed=true]').length`) === 0,
  );
  check(
    "and the results go with it",
    await evalJs(`document.getElementById('results').textContent.trim()`) === "",
  );

  // ------------------------------------------------------------- typed query

  // Typed, rather than clicked, so the debounce path is the one exercised.
  await evalJs(`(() => { const q=document.getElementById('q'); q.value='chess';
    q.dispatchEvent(new Event('input',{bubbles:true})); return 1; })()`);
  const typedRows = await waitFor(
    evalJs,
    `(() => { const el = document.getElementById('results');
       return !/Searching/.test(el.textContent) && document.querySelectorAll('#results .row').length > 0; })()`,
  );
  check("typing runs a live search", typedRows === true,
    `${await evalJs(`document.querySelectorAll('#results .row').length`)} rows`);

  // Rows must be real links out to the site, not placeholders.
  const rowShape = await evalJs(`(() => {
    const r = document.querySelector('#results .row');
    const a = r?.querySelector('h3 a');
    return { href: a?.href ?? '', text: a?.textContent ?? '', url: r?.querySelector('.url')?.textContent ?? '' };
  })()`);
  check("each row links to the site", /^https:\/\/[^/]+\.github\.io/.test(rowShape?.href ?? ""), (rowShape?.href ?? "").slice(0, 60));
  check("each row shows the resolved URL", (rowShape?.url ?? "").includes(".github.io"), (rowShape?.url ?? "").slice(0, 60));
  const safe = await evalJs(`(() => { const a = document.querySelector('#results .row h3 a');
    return a ? (a.rel.includes('noopener') && a.target === '_blank') : false; })()`);
  check("result links open safely", safe === true);

  // ------------------------------------------------------------- clearing

  await evalJs(`(() => { const q=document.getElementById('q'); q.value='';
    q.dispatchEvent(new Event('input',{bubbles:true})); return 1; })()`);
  await Bun.sleep(1200);
  const cleared = await evalJs(`(() => ({
    rows: document.querySelectorAll('#results .row').length,
    text: document.getElementById('results').textContent.trim(),
    tags: document.querySelectorAll('#taglist .tagbtn').length,
  }))()`);
  check("clearing the box empties the results", cleared?.rows === 0, `${cleared?.rows} rows`);
  check("and leaves no placeholder", cleared?.text === "", JSON.stringify(cleared?.text?.slice(0, 40)));
  check("and the tag picker survives", (cleared?.tags ?? 0) >= 20, `${cleared?.tags} tags`);

  check("no console errors", consoleErrors.length === 0, consoleErrors.slice(0, 3).join(" | "));

  console.log(`\n${failures === 0 ? "ALL BROWSER CHECKS PASSED" : `${failures} BROWSER CHECK(S) FAILED`}`);
  ws.close();
  proc.kill();
  process.exit(failures === 0 ? 0 : 1);
}

await main();