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

  // Pin a desktop viewport. The headless shell otherwise opens at 800x600, where
  // every container is clamped to the same width and the layout's proportions
  // cannot be measured at all — the checks below compare a narrow hero against a
  // wide band, which only differ on a screen with room for both.
  const VIEWPORT_W = 1440;
  const VIEWPORT_H = 900;
  await send("Emulation.setDeviceMetricsOverride", {
    width: VIEWPORT_W,
    height: VIEWPORT_H,
    deviceScaleFactor: 1,
    mobile: false,
  });

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
      helpline: (document.querySelector('.helpline') || {}).textContent || '',
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
  check("a help line is shown", /GitHub/.test(a.helpline || ""), (a.helpline || "").slice(0, 60));
  check("the search box is centred under the hero", a.searchOffset <= 2, `${a.searchOffset}px off centre`);
  check("the hero is centred on the page", a.heroOffset <= 2, `${a.heroOffset}px off centre`);

  // "Dead centre" means the middle of the screen, not the middle of a column, and
  // not the top. The box sat 24px high at every desktop size until the hero's
  // top padding was set to cancel the asymmetry between the title above and the
  // one help line below, so this is pinned rather than eyeballed.
  const vcent = JSON.parse(String(await evalJs(`JSON.stringify((() => {
    const b = document.querySelector('.searchbox').getBoundingClientRect();
    const t = document.getElementById('taglist').getBoundingClientRect();
    const h = document.querySelector('h1').getBoundingClientRect();
    const hp = document.querySelector('.helpline').getBoundingClientRect();
    return {
      viewportH: window.innerHeight,
      offset: Math.round((b.top + b.height / 2) - window.innerHeight / 2),
      titleAboveCentre: h.bottom < window.innerHeight / 2,
      tagsBottom: Math.round(t.bottom),
      tagsVisible: t.bottom <= window.innerHeight,
      // The help line is the last line of the centred block, so it sits below
      // the topics and nothing follows it. It was a separate <footer> pinned to
      // the bottom of the document, which left the page taller than the viewport
      // and gave a scrolling visitor a second half they had to interpret.
      gapHelp: Math.round(hp.top - t.bottom),
      helplineBelowTags: hp.top >= t.bottom - 1,
      helplineBottom: Math.round(hp.bottom),
      helplineVisible: hp.bottom <= window.innerHeight,
      // Nothing may extend past the fold before a search runs.
      scrolls: document.documentElement.scrollHeight > window.innerHeight,
    };
  })())`)));
  check(
    "the search box sits on the vertical centre of the screen",
    Math.abs(vcent.offset) <= 8,
    `${vcent.offset}px off the middle`,
  );
  check("the title is above it, not below", vcent.titleAboveCentre === true);
  // Everything the visitor sees before typing has to fit on one screen. It did
  // not for a while: the topics were left outside the hero and the help line came
  // after them, so each was pushed down in turn.
  check(
    "and the topic row still fits on the first screen",
    vcent.tagsVisible === true,
    `tags end at ${vcent.tagsBottom}px of ${vcent.viewportH}px`,
  );
  check(
    "the help line comes after the topics",
    vcent.helplineBelowTags === true,
    "reading order is box -> help -> topics, and the alternative to typing is below the explanation",
  );
  check(
    "and the help line is on the first screen too",
    vcent.helplineVisible === true,
    `help ends at ${vcent.helplineBottom}px of ${vcent.viewportH}px`,
  );
  check(
    "and follows the topics closely",
    vcent.gapHelp <= 60,
    `${vcent.gapHelp}px between the topics and the help line`,
  );
  // The whole point: on arrival there is nothing to scroll to. A second half
  // below the fold read as part of the page and had to be interpreted.
  check(
    "and the page does not scroll before a search",
    vcent.scrolls === false,
    `scrollHeight ${await evalJs(`document.documentElement.scrollHeight`)} > viewport ${vcent.viewportH}`,
  );

  // Widths. The box is centred but narrow, the tag band and the result list are
  // near full-bleed. All three are pinned because "make it wide" and "leave free
  // pixels at the end" are opposite requirements that meet in one place.
  const widths = await evalJs(`JSON.stringify((() => {
    // clientWidth, not innerWidth: innerWidth includes the scrollbar gutter, so
    // centring against it reports a half-scrollbar offset once results make the
    // page scrollable.
    const left = (sel) => {
      const el = document.querySelector(sel);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return JSON.stringify({
        w: Math.round(r.width),
        left: Math.round(r.left),
        right: Math.round(document.documentElement.clientWidth - r.right),
      });
    };
    return {
      box: left('.searchbox'),
      tags: left('.taglist'),
      viewport: document.documentElement.clientWidth,
    };
  })())`);
  const wd = JSON.parse(String(widths));
  const box = JSON.parse(wd.box);
  const tagw = JSON.parse(wd.tags);

  check("the search box has a sane measure", box.w >= 480 && box.w <= 860, `${box.w}px`);
  check(
    "the search box is centred on the viewport",
    Math.abs(box.left - box.right) <= 2,
    `${box.left}px left / ${box.right}px right`,
  );
  check(
    "the tag band is far wider than the search box",
    tagw.w > box.w + 150,
    `tags ${tagw.w}px vs box ${box.w}px`,
  );
  check(
    "but still leaves a margin at both ends",
    tagw.left >= 24 && tagw.right >= 24,
    `${tagw.left}px left / ${tagw.right}px right`,
  );
  check(
    "and uses most of the window",
    tagw.w > wd.viewport * 0.75,
    `${tagw.w}px of ${wd.viewport}px`,
  );
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

  // --- the picker state -------------------------------------------------------

const picker = await evalJs(`JSON.stringify((() => {
  const list = document.getElementById('taglist');
  const more = document.getElementById('tagmore');
  return {
    // Computed here rather than returned as a function: this whole object goes
    // through JSON.stringify, which drops functions on the floor.
    visible: [...list.querySelectorAll('.tagbtn')].map((b) => b.dataset.tag),
    count: list.querySelectorAll('.tagbtn').length,
    listHeight: Math.round(list.getBoundingClientRect().height),
    expanded: more ? more.getAttribute('aria-expanded') : null,
    moreLabel: more ? more.textContent.trim() : '',
  };
})())`);
const p = JSON.parse(String(picker));
const collapsedTags = p.visible;

// Collapsed must show only a few, and those few must be whole chips.
check("the picker starts collapsed", p.expanded === "false", `aria-expanded=${p.expanded}`);
check("collapsed, it shows only a few tags", collapsedTags.length > 0 && collapsedTags.length <= 14, `${collapsedTags.length}: ${collapsedTags.join(", ")}`);
check("collapsed, it fits to roughly one row", p.listHeight <= 60, `${p.listHeight}px`);
check("and offers to show more", /^\+\d+$/.test(p.moreLabel), JSON.stringify(p.moreLabel));

// The reported bug: "+" expanded but "fewer" did not drop back to the short
// list. Both directions are exercised, and both are asserted.
await evalJs(`document.getElementById('tagmore')?.click()`);
await Bun.sleep(250);
const opened = JSON.parse(String(await evalJs(`JSON.stringify((() => {
  const list = document.getElementById('taglist');
  const more = document.getElementById('tagmore');
  return {
    count: list.querySelectorAll('.tagbtn').length,
    expanded: more.getAttribute('aria-expanded'),
    label: more.textContent.trim(),
    height: Math.round(list.getBoundingClientRect().height),
  };
})())`)));
check("+ expands to every tag", opened.count > collapsedTags.length, `${opened.count} tags`);
check("and the control flips to 'fewer'", opened.label === "fewer", JSON.stringify(opened.label));
check("and reports itself expanded", opened.expanded === "true", `aria-expanded=${opened.expanded}`);
check("expanded, it grows", opened.height > p.listHeight, `${opened.height}px vs ${p.listHeight}px`);

await evalJs(`document.getElementById('tagmore')?.click()`);
await Bun.sleep(250);
const reclosed = JSON.parse(String(await evalJs(`JSON.stringify((() => {
  const list = document.getElementById('taglist');
  const more = document.getElementById('tagmore');
  return {
    tags: [...list.querySelectorAll('.tagbtn')].map((b) => b.dataset.tag),
    expanded: more.getAttribute('aria-expanded'),
    label: more.textContent.trim(),
    height: Math.round(list.getBoundingClientRect().height),
  };
})())`)));
check(
  "'fewer' drops back to the short list",
  reclosed.tags.length === collapsedTags.length &&
    reclosed.tags.every((t, i) => t === collapsedTags[i]),
  `${reclosed.tags.length} tags: ${reclosed.tags.slice(0, 5).join(", ")}`,
);
check("and the control flips back to '+N'", /^\+\d+$/.test(reclosed.label), JSON.stringify(reclosed.label));
check("and it returns to its collapsed height", reclosed.height === p.listHeight, `${reclosed.height}px vs ${p.listHeight}px`);

// The list content itself.
const labels = await evalJs(`[...document.querySelectorAll('#taglist .tagbtn')].map(b=>b.textContent).slice(0,6).join(',')`);
check(
  "no technology-only tags in the picker",
  !/^(react|javascript|typescript|css|html|python|vue)(,|$)/.test(String(labels)),
  String(labels),
);
check("the picker carries no heading", await evalJs(`document.querySelectorAll('.tagpick h2, .tagpick h3').length`) === 0);

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
  check("the summary says the results are live", /on this page/.test(summary), summary.slice(0, 70));
  check("the summary names the topic being searched", new RegExp(tag).test(summary), summary.slice(0, 70));

  // One result set. This is the check that matters most: the bug being guarded
  // against was two stacked groups, a local one usually saying "0 matches"
  // above a live one that had the answer.
// ------------------------------------------------------------- pagination

  // "Show more" used to walk pages 1..N and return the union, so paging cost
  // three requests to reach page 3 and three again on the next click. It is
  // numbered pages now, each costing one.
  const pager = await evalJs(`JSON.stringify((() => ({
    buttons: document.querySelectorAll('#results .pagebtn').length,
    current: document.querySelector('#results .pagebtn.current')?.textContent ?? '',
    aria: document.querySelector('#results .pagebtn.current')?.getAttribute('aria-current') ?? '',
    hasMoreButton: !!document.getElementById('more'),
    firstRow: document.querySelector('#results .row h3 a')?.textContent ?? '',
  }))())`);
  const pg = JSON.parse(String(pager));

  check("results are paged with numbered controls", pg.buttons >= 2, `${pg.buttons} page buttons`);
  check("page 1 is marked current", pg.current === "1", `current="${pg.current}"`);
  check("and says so for assistive tech", pg.aria === "page", `aria-current="${pg.aria}"`);
  // The control it replaced. A "show more" implies more is queued behind it,
  // which is exactly the wrong idea when GitHub caps the result set at 1,000.
  check("the old 'show more' button is gone", pg.hasMoreButton === false);

  const before = pg.firstRow;
  await evalJs(`(() => { document.querySelectorAll('#results .pagebtn')[1]?.click(); return 1; })()`);
  const page2 = await waitFor(
    evalJs,
    `(() => { const c = document.querySelector('#results .pagebtn.current');
       return c && c.textContent === '2'; })()`,
  );
  check("clicking page 2 loads it", page2 === true);

  const after = await evalJs(`document.querySelector('#results .row h3 a')?.textContent ?? ''`);
  check("and shows different rows", after !== before && after.length > 0, `${before} -> ${after}`);
  const onPage2 = await evalJs(`JSON.stringify((() => {
    const c = document.querySelector('#results .pagebtn.current');
    return {
      page: c?.textContent ?? '',
      note: document.querySelector('#results p.note')?.textContent ?? '',
    };
  })())`);
  const p2 = JSON.parse(String(onPage2));
  check("the summary reports the position in the result set",
    /results 101/.test(p2.note), p2.note.slice(0, 80));

  // Jumping straight back has to work: with only a "next" control, a reader on
  // page 8 has no way home.
  await evalJs(`(() => { document.querySelector('#results .pagebtn[data-page="1"]')?.click(); return 1; })()`);
  const backTo1 = await waitFor(
    evalJs,
    `document.querySelector('#results .pagebtn.current')?.textContent === '1'`,
  );
  check("and jumping back to page 1 works", backTo1 === true);

  check("there is exactly one results container", await evalJs(`document.querySelectorAll('#results').length`) === 1);

// The result list has to be as wide as the tag band: the "Searching GitHub…"
// placeholder and the rows share this container, so a narrow one would squeeze
// both. Measured on the placeholder, since that is the state before any network
// answer has arrived.
//
// Both widths are read in the same evaluation: the page gains a vertical
// scrollbar once results exist, which shifts centred content by half the
// scrollbar width. Measuring the tag band before results and the results after
// compares two different layouts and reports a phantom offset.
const wide = JSON.parse(String(await evalJs(`JSON.stringify((() => {
  const r = document.getElementById('results').getBoundingClientRect();
  const t = document.getElementById('taglist').getBoundingClientRect();
  return {
    resultsW: Math.round(r.width), resultsLeft: Math.round(r.left),
    tagsW: Math.round(t.width), tagsLeft: Math.round(t.left),
    viewport: window.innerWidth,
    content: document.documentElement.clientWidth,
  };
})())`)));
check(
  "the results container is near full width",
  wide.resultsW > wide.content * 0.75,
  `${wide.resultsW}px of ${wide.content}px`,
);
// The hero gives its height back once there are results, so the answers are not
// a full screen below the fold.
check(
  "the hero collapses once there are results",
  (await evalJs(`Math.round(document.querySelector('.hero').getBoundingClientRect().height)`)) < wide.viewport,
);
check(
  "the results and the tag band are the same width",
  Math.abs(wide.resultsW - wide.tagsW) <= 1,
  `results ${wide.resultsW}px vs tags ${wide.tagsW}px`,
);
check(
  "and share the same margins",
  Math.abs(wide.resultsLeft - wide.tagsLeft) <= 1,
  `results ${wide.resultsLeft}px vs tags ${wide.tagsLeft}px`,
);

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
  check("and the tag picker survives", (cleared?.tags ?? 0) === collapsedTags.length, `${cleared?.tags} tags, expected ${collapsedTags.length}`);

  check("no console errors", consoleErrors.length === 0, consoleErrors.slice(0, 3).join(" | "));

  console.log(`\n${failures === 0 ? "ALL BROWSER CHECKS PASSED" : `${failures} BROWSER CHECK(S) FAILED`}`);
  ws.close();
  proc.kill();
  process.exit(failures === 0 ? 0 : 1);
}

await main();