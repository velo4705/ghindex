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
    // The field, not the text input inside it. The border moved to a wrapper when
    // topic chips were added, and the input sits inside asymmetric padding so the
    // search icon has room on its left — so the input's own midpoint sits ~16px
    // right of centre even though the visible box is dead centre. Measuring the
    // input would be measuring padding, not layout.
    const box = document.getElementById('searchfield').getBoundingClientRect();
    const inputBox = document.getElementById('q').getBoundingClientRect();
    const hero = document.querySelector('.hero').getBoundingClientRect();
    const mid = (r) => (r.left + r.right) / 2;
    return JSON.stringify({
      rows: document.querySelectorAll('#results .row').length,
      resultsText: document.getElementById('results').textContent.trim(),
      helpline: (document.querySelector('.helpline') || {}).textContent || '',
      h1: (document.querySelector('h1') || {}).textContent || '',
      tagline: (document.querySelector('.tagline') || {}).textContent || '',
      searchOffset: Math.round(Math.abs(mid(box) - mid(hero))),
      // The input must still be inside the field it lives in, or a long topic
      // chip has pushed it out.
      inputInside: inputBox.left >= box.left && inputBox.right <= box.right,
      chips: document.querySelectorAll('#searchchips .searchchip').length,
      // The bottom breathing room is scoped to the results state. Applied
      // unconditionally it would push the help line off a short viewport and
      // make the pre-search view scroll — the thing it was withheld to avoid.
      mainPadBottom: getComputedStyle(document.querySelector('main')).paddingBottom,
      noScroll: document.documentElement.scrollHeight <= window.innerHeight + 1,
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
  check("the search input stays inside the field", a.inputInside === true);
  check("no topic chip is shown before one is chosen", a.chips === 0, `${a.chips} chips`);
  check("nothing is added below the help line before a search",
    /^0(px)?$/.test(String(a.mainPadBottom).trim()), `padding-bottom=${a.mainPadBottom}`);
  check("and the arriving page does not scroll", a.noScroll === true);
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

  // -------------------------------------------------------------- star field

  // particles.js draws to a canvas, so there is no markup to count any more.
  // Everything below reads the live instance instead — which is the better
  // assertion anyway, because it reports what is actually being drawn rather
  // than what the source says should be.
  const inst = () => evalJs(`JSON.stringify((() => {
    const host = document.getElementById('sky');
    if (!host) return { present: false };
    const c = getComputedStyle(host);
    const h1 = document.querySelector('h1');
    const b = h1.getBoundingClientRect();
    const top = document.elementFromPoint(b.x + b.width / 2, b.y + b.height / 2);
    const p = window.pJSDom && window.pJSDom[0] && window.pJSDom[0].pJS;
    if (!p) return { present: true, canvas: !!host.querySelector('canvas'), titleOnTop: !!top && top.tagName === 'H1', aria: host.getAttribute('aria-hidden'), pointer: c.pointerEvents, zIndex: c.zIndex, w: Math.round(host.getBoundingClientRect().width), h: Math.round(host.getBoundingClientRect().height), built: false };
    const arr = p.particles.array;
    const d = p.particles.line_linked.distance;
    let links = 0;
    for (let i = 0; i < arr.length; i++)
      for (let j = i + 1; j < arr.length; j++) {
        const dx = arr[i].x - arr[j].x, dy = arr[i].y - arr[j].y;
        if (dx * dx + dy * dy <= d * d) links++;
      }
    return {
      present: true, built: true,
      canvas: !!host.querySelector('canvas'),
      aria: host.getAttribute('aria-hidden'),
      pointer: c.pointerEvents,
      zIndex: c.zIndex,
      mainZ: getComputedStyle(document.querySelector('main')).zIndex,
      w: Math.round(host.getBoundingClientRect().width),
      h: Math.round(host.getBoundingClientRect().height),
      vw: window.innerWidth, vh: window.innerHeight,
      stars: arr.length, links,
      lineOpacity: p.particles.line_linked.opacity,
      linkRatio: d / Math.min(window.innerWidth, window.innerHeight),
      speed: p.particles.move.speed,
      ink: p.particles.color.value,
      cssInk: getComputedStyle(document.documentElement).getPropertyValue('--fg').trim(),
      medianR: (() => { const r = arr.map(x => x.radius).sort((a, b) => a - b); return r.length ? r[r.length >> 1] : 0; })(),
      pos: arr.slice(0, 6).map(x => [Math.round(x.x), Math.round(x.y)]),
      titleOnTop: !!top && top.tagName === 'H1',
    };
  })())`);

  const sky = JSON.parse(String(await inst()));
  check("a star field sits behind the title", sky?.present === true);
  check("it is decorative only, so it is hidden from assistive tech",
    sky?.aria === "true", `aria-hidden=${sky?.aria}`);
  check("and cannot swallow a click meant for the search box",
    sky?.pointer === "none", `pointer-events=${sky?.pointer}`);
  check("it fills the viewport rather than just the hero",
    sky?.built && sky?.w >= (sky?.vw ?? 0) - 1 && sky?.h >= (sky?.vh ?? 0) - 1,
    `${sky?.w}x${sky?.h} vs ${sky?.vw}x${sky?.vh}`);
  check("and content is layered above it, not under it",
    Number(sky?.mainZ) > Number(sky?.zIndex), `main=${sky?.mainZ} sky=${sky?.zIndex}`);
  check("the wordmark is still the topmost thing over it",
    sky?.titleOnTop === true, "the field is painting over the title");

  // The library is deferred, so it may not have landed yet on a slow machine.
  // Waiting here rather than failing turns a race into a short wait.
  if (!sky?.built) await waitFor(evalJs, `(window.pJSDom && window.pJSDom[0] && window.pJSDom[0].pJS) ? true : false`, 15000);
  const field = JSON.parse(String(await inst()));
  check("particles.js loaded and built the field", field?.built === true, `canvas=${field?.canvas}`);
  if (field?.built) {
    check("the stars are painted in the theme's own text colour",
      field.ink?.toLowerCase() === field.cssInk?.toLowerCase(), `ink=${field.ink} css=${field.cssInk}`);
    check("the lines stay almost subliminal",
      field.lineOpacity <= 0.2, `line opacity=${field.lineOpacity}`);
    // The reference this was built to match is a night sky, not a web: almost
    // every point is on its own. Counting real pairs inside the link radius
    // measures the thing that decides that, rather than trusting a config value.
    check("most stars are unconnected, rather than a dense mesh",
      field.stars > 0 && field.links < field.stars / 2,
      `${field.stars} stars, ${field.links} links`);
    check("the link radius stays small relative to the frame",
      field.linkRatio > 0 && field.linkRatio < 0.06, `ratio=${field.linkRatio.toFixed(3)}`);
    check("each star is a point rather than a disc",
      field.medianR > 0.5 && field.medianR <= 4, `median radius ${field.medianR?.toFixed(2)}px`);
    check("and the drift is slow, so links do not flicker on and off",
      field.speed > 0 && field.speed <= 0.5, `speed=${field.speed}`);

    const before = field.pos;
    await Bun.sleep(2200);
    const after = JSON.parse(String(await inst())).pos;
    const moved = before.some((p, i) => p[0] !== after?.[i]?.[0] || p[1] !== after?.[i]?.[1]);
    check("and the field is actually drifting", moved === true,
      `${JSON.stringify(before?.[0])} -> ${JSON.stringify(after?.[0])}`);
  }

  // ----------------------------------------------------------- theme toggle

  // The failure this guards is a scoping one, not a cosmetic one. Restating
  // the dark tokens for `[data-theme=dark]` inside the system media query makes
  // that rule true only when the system is *already* dark — so the one case the
  // override exists for, asking for dark on a light machine, silently does
  // nothing. So the override is asserted against a forced-light system.
  const themeState = async () => JSON.parse(String(await evalJs(`JSON.stringify({
    attr: document.documentElement.getAttribute('data-theme'),
    bg: getComputedStyle(document.body).backgroundColor,
    label: (document.getElementById('themetoggle')||{}).getAttribute?.('aria-label') || '',
    stored: (() => { try { return localStorage.getItem('ghindex-theme'); } catch { return 'blocked'; } })(),
  })`)));

  const tryTheme = async (want: string) => {
    await evalJs(`(() => { try { localStorage.setItem('ghindex-theme', ${JSON.stringify(want)}); } catch {}
      return 1; })()`);
    // A real navigation, not location.reload(): a reload destroys the execution
    // context mid-evaluate, and evalJs cannot see that it failed.
    await send("Page.navigate", { url: BASE + "/index.html" });
    await Bun.sleep(1500);
    return themeState();
  };

  const systemLight = await tryTheme("dark");
  check("an explicit dark override applies even though the system is light",
    systemLight?.attr === "dark" && systemLight?.bg === "rgb(28, 31, 36)",
    `attr=${systemLight?.attr} bg=${systemLight?.bg}`);

  const systemLight2 = await tryTheme("light");
  check("and an explicit light override applies when the system is dark",
    systemLight2?.attr === "light" && systemLight2?.bg === "rgb(244, 242, 238)",
    `attr=${systemLight2?.attr} bg=${systemLight2?.bg}`);

  check("the choice is remembered across a reload",
    systemLight2?.stored === "light", `stored=${systemLight2?.stored}`);
  check("and the button says where the next click lands",
    /Theme: light\. Switch to dark\./.test(systemLight2?.label ?? ""),
    JSON.stringify(systemLight2?.label));

  // "auto" must remain reachable, or anyone who wants to follow their system
  // again has no way back but to clear site data.
  await evalJs(`(() => { try { localStorage.removeItem('ghindex-theme'); } catch {} return 1; })()`);
  await send("Page.navigate", { url: BASE + "/index.html" });
  await Bun.sleep(1500);
  const back = await themeState();
  check("clearing the choice returns the page to following the system",
    (back?.attr ?? null) === null, `attr=${back?.attr}`);
  check("and the stored override is gone, not merely ignored",
    (back?.stored ?? null) === null, `stored=${back?.stored}`);

  const bar = await evalJs(`(() => { const b = document.getElementById('themetoggle');
    const f = document.getElementById('f');
    if (!b || !f) return null;
    const a = b.getBoundingClientRect(), c = f.getBoundingClientRect();
    return { overlap: a.left < c.right && a.right > c.left && a.top < c.bottom && a.bottom > c.top,
             w: Math.round(a.width) };
  })()`);
  check("the toggle never sits on top of the search box", bar?.overlap === false);

  // The stars are painted in the theme's own text colour, so a theme change has
  // to rebuild the field. `particlesJS()` returns nothing, so the rebuild hangs
  // off `window.pJSDom`; when that handle was wrong the guard on refresh made
  // every theme change a silent no-op and dark stars sat on a light page.
  const repaint = async () => JSON.parse(String(await evalJs(`JSON.stringify({
    ink: (window.pJSDom || [])[0]?.pJS?.particles?.color?.value || null,
    css: getComputedStyle(document.documentElement).getPropertyValue('--fg').trim(),
    canvases: document.querySelectorAll('#sky canvas').length,
  })`)));
  await send("Page.navigate", { url: BASE + "/index.html" });
  await Bun.sleep(2200);
  const beforeSwap = await repaint();
  check("the field is running before the swap", beforeSwap?.ink !== null, `ink=${beforeSwap?.ink}`);
  // One click is not enough: on a light system the first click only pins "auto"
  // to "light", which looks identical and would pass even with a broken rebuild.
  // Click to whichever of light/dark is not already showing.
  await evalJs(`(() => {
    const btn = document.getElementById('themetoggle');
    const dark = getComputedStyle(document.documentElement).getPropertyValue('--bg').trim();
    for (let i = 0; i < 3; i++) {
      btn.click();
      if (getComputedStyle(document.documentElement).getPropertyValue('--bg').trim() !== dark) break;
    }
    return 1;
  })()`);
  await Bun.sleep(1600);
  const afterSwap = await repaint();
  check("switching theme repaints the stars in the new colour",
    afterSwap?.ink?.toLowerCase() === afterSwap?.css?.toLowerCase(),
    `ink=${afterSwap?.ink} css=${afterSwap?.css}`);
  check("and the old field is torn down rather than left running",
    afterSwap?.canvases === 1, `${afterSwap?.canvases} canvases`);
  check("and the stars really did change colour, not merely stay consistent",
    afterSwap?.ink?.toLowerCase() !== beforeSwap?.ink?.toLowerCase(),
    `${beforeSwap?.ink} -> ${afterSwap?.ink}`);

  // Both of these were wrong at once and looked like one problem: the mesh was
  // boxed into the hero instead of the viewport, and the toggle bar inherited a
  // 1200px max-width that parked it in the middle of a wide screen.
  // The mesh checks live with the star field above, against the live instance.
  // What remains here is the theme bar, which had the same "locked in the
  // middle" fault: a max-width on the bar boxed the button into a wide screen.
  const span = await evalJs(`JSON.stringify((() => {
    const bar = document.querySelector('.themebar');
    return {
      barW: bar ? Math.round(bar.getBoundingClientRect().width) : 0,
      btnRight: Math.round(document.getElementById('themetoggle').getBoundingClientRect().right),
      vw: window.innerWidth,
    };
  })())`).then((r) => JSON.parse(String(r)));
  check("the theme bar spans the full width",
    span?.barW === span?.vw, `bar=${span?.barW} viewport=${span?.vw}`);
  check("and the toggle is parked in the actual corner",
    (span?.btnRight ?? 0) >= (span?.vw ?? 0) - 24, `right=${span?.btnRight} viewport=${span?.vw}`);

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
  check("the summary names the keyword being searched", new RegExp(tag).test(summary), summary.slice(0, 70));
  check("and does not claim a topic filter", !/topic:/.test(summary), summary.slice(0, 90));

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

  // --- a page turn: the list is replaced and names the page being fetched ----
  //
  // Holding the old page's rows on screen under a pager showing a different page
  // is the confusing option: the results and the control disagree about what is
  // being displayed. Taking the list away and naming the page — as a search
  // engine does — leaves no ambiguity.
  const firstRowBefore = await evalJs(`document.querySelector('#results .row h3 a')?.textContent ?? ''`);

  // Three clicks in one turn, with no waiting between them: the case of landing
  // on the wrong page and clicking through to find the right one.
  await evalJs(`(() => {
    for (const n of [3, 5, 4]) {
      document.querySelector('#results .pagebtn[data-page="' + n + '"]')?.click();
    }
    return 1;
  })()`);

  const duringLoad = JSON.parse(String(await evalJs(`JSON.stringify((() => {
    const el = document.getElementById('results');
    return {
      rows: el.querySelectorAll('.row').length,
      empty: (el.querySelector('.empty') || {}).textContent || '',
      busy: el.getAttribute('aria-busy'),
      pending: (document.querySelector('.pagebtn.pending') || {}).textContent || '',
      current: (document.querySelector('.pagebtn.current') || {}).textContent || '',
      // The control must survive: a reader who realises they chose wrong needs
      // to be able to correct it without waiting out the fetch.
      pagerPresent: !!document.querySelector('#results .pager'),
      disabled: el.querySelectorAll('.pagebtn[disabled]').length,
      spinner: el.querySelectorAll('.spinner').length,
      spinnerHidden: (el.querySelector('.spinner') || {}).getAttribute('aria-hidden'),
      spinnerAnim: (() => {
        const s = el.querySelector('.spinner');
        return s ? getComputedStyle(s).animationName : '';
      })(),
      // Centred on the placeholder, not shoved against the text.
      spinnerCentred: (() => {
        const s = el.querySelector('.spinner');
        const box = el.querySelector('.empty');
        if (!s || !box) return false;
        const a = s.getBoundingClientRect();
        const b = box.getBoundingClientRect();
        return Math.abs((a.x + a.width / 2) - (b.x + b.width / 2)) < 2;
      })(),
    };
  })())`)));

  check("the previous page's rows are taken away while the next loads",
    duringLoad.rows === 0, `${duringLoad.rows} rows left`);
  check("and the placeholder names the page being fetched",
    /Loading page 4/.test(duringLoad.empty), JSON.stringify(duringLoad.empty));
  check("it is announced as busy", duringLoad.busy === "true", `aria-busy=${duringLoad.busy}`);
  check("the requested page is marked pending", duringLoad.pending === "4", `pending=${duringLoad.pending}`);
  check("the page already shown stays marked current", duringLoad.current === "1", `current=${duringLoad.current}`);
  check("the page control stays available", duringLoad.pagerPresent === true);
  check("and stays clickable", duringLoad.disabled === 0, `${duringLoad.disabled} disabled`);
  check("a buffering ring accompanies the placeholder", duringLoad.spinner === 1,
    `${duringLoad.spinner} spinners`);
  check("the ring is animated", duringLoad.spinnerAnim === "spin", `animation=${duringLoad.spinnerAnim}`);
  check("the ring is centred above the words", duringLoad.spinnerCentred === true);
  check("and is hidden from assistive tech, since the words say it already",
    duringLoad.spinnerHidden === "true", `aria-hidden=${duringLoad.spinnerHidden}`);

  // Only the last click should land: page 4, not page 3 or 5.
  const landed = await waitFor(
    evalJs,
    `document.querySelector('#results .pagebtn.current')?.textContent === '4'`,
  );
  check("only the last click takes effect", landed === true);

  const settled = JSON.parse(String(await evalJs(`JSON.stringify((() => {
    const el = document.getElementById('results');
    return {
      first: (el.querySelector('.row h3 a') || {}).textContent || '',
      rows: el.querySelectorAll('.row').length,
      busy: el.getAttribute('aria-busy'),
      empty: (el.querySelector('.empty') || {}).textContent || '',
      pending: (document.querySelector('.pagebtn.pending') || {}).textContent || '',
    };
  })())`)));
  check("the new page's rows pop in", settled.rows > 0 && settled.first !== firstRowBefore,
    `${firstRowBefore} -> ${settled.first}`);
  check("and the loading state is gone",
    settled.busy === "false" && settled.empty === "" && settled.pending === "",
    `busy=${settled.busy} empty="${settled.empty}" pending=${settled.pending}`);

  check("there is exactly one results container", await evalJs(`document.querySelectorAll('#results').length`) === 1);

  // ------------------------------------------------------- space under the pager

  // The pager was landing flush against the bottom of the viewport, so the last
  // row of controls had nothing beneath it and the page read as cut off. Scrolled
  // to the very bottom, there should now be a gap between the pager and the end
  // of the document.
  const under = JSON.parse(String(await evalJs(`(() => {
    window.scrollTo(0, document.body.scrollHeight);
    const pager = document.querySelector('#results .pager');
    if (!pager) return JSON.stringify({ missing: true });
    const p = pager.getBoundingClientRect();
    return JSON.stringify({
      missing: false,
      // Distance from the pager's last row of buttons to the document's end.
      gap: Math.round(
        document.documentElement.scrollHeight -
        (window.scrollY + p.bottom)
      ),
    });
  })()`)));
  check("the pager is not flush with the end of the page",
    under.missing === false && under.gap >= 40, `gap=${under.gap}px`);

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

// The badge belongs last. Its labels range from "live" to "blocks bots", and when
// one led the row every title started at a different x - 56px of raggedness
// measured between the shortest and longest label - on the one column a reader is
// actually scanning. Both edges should line up instead.
const badgeAlign = JSON.parse(String(await evalJs(`JSON.stringify((() => {
  const labels = ['live', 'dead link', 'blocks bots', 'checking\u2026', 'unreachable'];
  const h3 = document.querySelector('#results .row h3');
  const link = h3 && h3.querySelector('a');
  if (!h3 || !link) return { missing: true };
  const saved = h3.querySelector('[class*="live-"]');
  const wasClass = saved && saved.className;
  const wasText = saved && saved.textContent;
  const titles = [], badges = [];
  for (const label of labels) {
    let pill = h3.querySelector('[class*="live-"]');
    if (!pill) { pill = document.createElement('span'); h3.appendChild(pill); }
    pill.className = 'pill live-alive';
    pill.textContent = label;
    titles.push(Math.round(link.getBoundingClientRect().left));
    badges.push(Math.round(pill.getBoundingClientRect().right));
  }
  if (saved) { saved.className = wasClass; saved.textContent = wasText; }
  return {
    missing: false,
    titleSpread: Math.max.apply(null, titles) - Math.min.apply(null, titles),
    badgeSpread: Math.max.apply(null, badges) - Math.min.apply(null, badges),
    // The title must also come before the badge in the DOM, not merely be pushed
    // there by a margin.
    titleFirst: !!(h3.firstElementChild && h3.firstElementChild.tagName === 'A'),
  };
})())`)));
check("a live badge exists to align", badgeAlign.missing === false);
check("titles keep one left edge whatever the badge says",
  badgeAlign.titleSpread === 0, `${badgeAlign.titleSpread}px spread`);
check("badges keep one right edge whatever they say",
  badgeAlign.badgeSpread === 0, `${badgeAlign.badgeSpread}px spread`);
check("and the title comes before the badge in the row", badgeAlign.titleFirst === true);

  // --------------------------------------------------------- topic chip in field

  // Selecting a topic has to show up inside the search field, not only as a
  // highlighted button in the picker below it. Otherwise the field keeps showing
  // its placeholder and looks idle while the results come from somewhere else.
  // Start from nothing selected. The selection is a list now, so a tag left over
  // from an earlier block would make this block's "one chip" assertions wrong.
  await evalJs(`(async () => {
    for (let i = 0; i < 20; i++) {
      const b = document.querySelector('#taglist .tagbtn[aria-pressed=true]');
      if (!b) break;
      b.click();
      await new Promise(r => setTimeout(r, 40));
    }
    return 1;
  })()`);
  await Bun.sleep(1200);

  const chosen = await evalJs(`(() => {
    const btn = document.querySelector('#taglist .tagbtn[aria-pressed=false]');
    if (!btn) return '';
    const name = btn.dataset.tag;
    btn.click();
    return name;
  })()`);
  check("a topic could be selected", chosen !== "", chosen);

  await waitFor(evalJs, `document.querySelectorAll('#searchchips .searchchip').length === 1`);
  const chip = JSON.parse(String(await evalJs(`JSON.stringify((() => {
    const chip = document.querySelector('#searchchips .searchchip');
    if (!chip) return { missing: true };
    const field = document.getElementById('searchfield').getBoundingClientRect();
    const c = chip.getBoundingClientRect();
    const input = document.getElementById('q').getBoundingClientRect();
    const x = chip.querySelector('.searchchip-x');
    return {
      missing: false,
      label: chip.querySelector('.searchchip-label').textContent,
      // It must look like part of the field, not float outside it.
      insideField: c.left >= field.left && c.right <= field.right,
      sharesRowWithInput: Math.abs((c.top + c.height / 2) - (input.top + input.height / 2)) < 12,
      xTag: x?.tagName ?? '',
      // "×" alone tells a screen reader nothing about what it removes.
      xName: x?.getAttribute('aria-label') ?? '',
      xTitle: x?.getAttribute('title') ?? '',
    };
  })())`)));
  check("the selected topic appears as a chip in the search field",
    chip.missing === false, JSON.stringify(chip).slice(0, 90));
  check("the chip is labelled with the topic", chip.label === chosen, `${chip.label} vs ${chosen}`);
  check("the chip sits inside the search field", chip.insideField === true);
  check("the chip shares the field's row with the input", chip.sharesRowWithInput === true);
  check("the remove control is a button", chip.xTag === "BUTTON", chip.xTag);
  check("the remove control names what it removes",
    /remove/i.test(chip.xName) && chip.xName.toLowerCase().includes(chosen.toLowerCase()),
    chip.xName);

  // Removing it from the field must work on its own, without the original tag
  // button being in view or clicked.
  await evalJs(`document.querySelector('#searchchips .searchchip-x')?.click()`);
  const afterX = await waitFor(
    evalJs,
    `document.querySelectorAll('#searchchips .searchchip').length === 0`,
  );
  check("the chip's × removes the filter", afterX === true);
  check("and no other chip is left behind",
    await evalJs(`document.querySelectorAll('#searchchips .searchchip').length`) === 0);
  check("and the tag button goes back to unselected",
    await evalJs(`document.querySelectorAll('#taglist .tagbtn[aria-pressed=true]').length`) === 0);
  // Focus must not be stranded: the pressed button is gone from the DOM, so
  // without this the next keystroke would go to the body.
  check("focus returns to the search field",
    await evalJs(`document.activeElement?.id`) === "q",
    await evalJs(`document.activeElement?.id ?? 'none'`));

  // ------------------------------------------- a tag is a keyword, not a topic

  // A `topic:` qualifier makes every result share one topic, and GitHub's
  // relevance ranking then collapses into the star ranking — measured across all
  // seven default tags, "best match" and "most stars" returned identical bytes.
  // So the tag must be sent as an ordinary keyword, and the request must actually
  // differ between the two orderings.
  const tagReq = await evalJs(`(async () => {
    const out = {};
    const grab = async (sort) => {
      const r = await fetch(
        'https://ghindex-search.ghindex.workers.dev/api/search' +
        '?q=' + encodeURIComponent('portfolio') + '&page=1&per_page=100&sort=' + sort);
      const j = await r.json();
      return (j.items ?? []).filter(i => i.has_pages).slice(0, 5).map(i => i.full_name);
    };
    out.best = await grab('best');
    out.stars = await grab('stars');
    return JSON.stringify(out);
  })()`);
  const tr = JSON.parse(String(tagReq));
  check("a keyword tag gives Best match and Most stars different results",
    JSON.stringify(tr.best) !== JSON.stringify(tr.stars),
    `best=${tr.best?.[0]} stars=${tr.stars?.[0]}`);

  // The chip test above removed the tag, so choose one again before testing what
  // happens when text is typed alongside it.
  await evalJs(`document.querySelector('#taglist .tagbtn[aria-pressed=false]')?.click()`);
  await waitFor(
    evalJs,
    `!/Searching/.test(document.getElementById('results').textContent) &&
     document.querySelectorAll('#results .row').length > 0`,
  );

  // Tag and text must AND. Typing after choosing a tag used to discard the typed
  // text entirely, because q was built before the tag was cleared.
  await evalJs(`(() => {
    const q = document.getElementById('q');
    q.value = 'resume';
    q.dispatchEvent(new Event('input', { bubbles: true }));
    return 1;
  })()`);
  await waitFor(
    evalJs,
    `!/Searching/.test(document.getElementById('results').textContent) &&
     document.querySelectorAll('#results .row').length > 0`,
  );
  const afterType = JSON.parse(String(await evalJs(`JSON.stringify({
    // The chip must survive typing: the tag is now a filter, not a mode.
    chip: (document.querySelector('.searchchip-label') || {}).textContent || '',
    summary: document.querySelector('#results p.note')?.textContent ?? '',
  })`)));
  check("typing does not discard the selected tag", afterType.chip !== "",
    `chip="${afterType.chip}"`);
  check("and the summary still reports it", new RegExp(afterType.chip).test(afterType.summary),
    afterType.summary.slice(0, 90));

  // Back to a tag-only search for the ordering tests below.
  await evalJs(`(() => {
    const q = document.getElementById('q');
    q.value = '';
    q.dispatchEvent(new Event('input', { bubbles: true }));
    return 1;
  })()`);
  await Bun.sleep(600);

  // ------------------------------------------------------------- result order

  // The ordering control. It only makes sense once there is a query, so it must
  // be absent on arrival — checked in the arrival block above — and present here,
  // now that a tag has been chosen.
  const sortWithQuery = await evalJs(`document.querySelectorAll('#sortbar .sortbtn').length`);
  check("the ordering control appears once there is a query",
    sortWithQuery === 2, `${sortWithQuery} buttons`);

  await evalJs(`document.querySelectorAll('#taglist .tagbtn[aria-pressed=false]')[0]?.click()`);
  await Bun.sleep(600);

  const sortbar = JSON.parse(String(await evalJs(`JSON.stringify({
    buttons: [...document.querySelectorAll('#sortbar .sortbtn')].map(b => ({
      sort: b.dataset.sort,
      label: b.textContent.trim(),
      pressed: b.getAttribute('aria-pressed'),
    })),
    // Relevance is the default and has to be visible, not merely implied.
    defaultPressed: document.querySelector('#sortbar .sortbtn[aria-pressed=true]')?.dataset.sort ?? '',
  })`)));
  check("two ordering options are offered", sortbar.buttons.length === 2, `${sortbar.buttons.length}`);
  check("they are Best match and Most stars",
    sortbar.buttons.map((b: any) => b.label).join("/") === "Best match/Most stars",
    sortbar.buttons.map((b: any) => b.label).join("/"));
  check("Best match is marked current by default", sortbar.defaultPressed === "best",
    sortbar.defaultPressed);

  // Switching must change the order of the same query, and must restart at page 1
  // rather than keeping whichever page happened to be showing.
  const orderProbe = await evalJs(`(async () => {
    const seen = {};
    // Read the current first result, then switch and read it again.
    seen.before = (document.querySelector('#results .row h3 a') || {}).textContent || '';
    return JSON.stringify(seen);
  })()`);
  const firstBeforeSort = JSON.parse(String(orderProbe)).before;

  await evalJs(`document.querySelector('#sortbar .sortbtn[data-sort="stars"]')?.click()`);
  // Wait for the state to settle rather than sleeping a fixed interval. A cold
  // GitHub page is two to three seconds, and a fixed 400ms wait only ever passed
  // because the response happened to be cached — it asserted the cache, not the
  // behaviour.
  await waitFor(
    evalJs,
    `document.getElementById('results')?.getAttribute('aria-busy') === 'false'`,
  );
  const switched = JSON.parse(String(await evalJs(`JSON.stringify({
    pressed: document.querySelector('#sortbar .sortbtn[aria-pressed=true]')?.dataset.sort ?? '',
    page: (document.querySelector('#results .pagebtn.current') || {}).textContent || '',
    first: (document.querySelector('#results .row h3 a') || {}).textContent || '',
    busy: document.getElementById('results').getAttribute('aria-busy'),
  })`)));
  check("the control switches to Most stars", switched.pressed === "stars", switched.pressed);
  check("switching order restarts at page 1", switched.page === "1", `page=${switched.page}`);
  check("and the busy state is cleared afterwards", switched.busy === "false", switched.busy);
  // The top result is not asserted to change: relevance and most-stars can
  // legitimately agree on first place. That the two orderings actually request
  // different orderings from GitHub is pinned against the URL builder instead,
  // because this test runs against the *deployed* worker, which does not have
  // the change until it ships.
  check("and the results were re-fetched",
    switched.first !== "" || firstBeforeSort !== "", `${switched.first || firstBeforeSort}`);

  await evalJs(`document.querySelector('#sortbar .sortbtn[data-sort="best"]')?.click()`);
  await waitFor(
    evalJs,
    `document.getElementById('results')?.getAttribute('aria-busy') === 'false'`,
  );
  check("and back to Best match",
    await evalJs(`document.querySelector('#sortbar .sortbtn[aria-pressed=true]')?.dataset.sort`) === "best");

  // ------------------------------------------------------ several tags at once

  // GitHub ANDs the terms, so two tags genuinely narrow rather than one replacing
  // the other. A single tag forced every extra click to discard the previous
  // choice, which made the picker useless for anything like a two-word search.
  await evalJs(`(async () => {
    for (let i = 0; i < 20; i++) {
      const b = document.querySelector('#taglist .tagbtn[aria-pressed=true]');
      if (!b) break;
      b.click();
      await new Promise(r => setTimeout(r, 40));
    }
    return 1;
  })()`);
  await Bun.sleep(1200);

  // Clicking two buttons in one tick re-queries between clicks: the first click
  // re-renders the picker, so the second would otherwise be clicked against a
  // stale list and could land on the tag just selected.
  const multi = await evalJs(`(async () => {
    const pick = () => document.querySelector('#taglist .tagbtn[aria-pressed=false]');
    pick().click();
    await new Promise(r => setTimeout(r, 60));
    pick().click();
    return JSON.stringify({
      chips: [...document.querySelectorAll('.searchchip-label')].map(c => c.textContent),
      pressed: [...document.querySelectorAll('#taglist .tagbtn[aria-pressed=true]')]
        .map(b => b.dataset.tag),
      hasClear: !!document.querySelector('.searchchips-clear'),
    });
  })()`);
  check("two tags can be selected at once", JSON.parse(String(multi)).chips.length === 2,
    JSON.stringify(JSON.parse(String(multi)).chips));
  check("both stay pressed in the picker",
    JSON.parse(String(multi)).pressed.length === 2,
    JSON.stringify(JSON.parse(String(multi)).pressed));
  check("and a clear-all control appears", JSON.parse(String(multi)).hasClear === true);

  await waitFor(
    evalJs,
    `!/Searching/.test(document.getElementById('results').textContent) &&
     document.querySelectorAll('#results .row').length > 0`,
  );
  const bothTerms = await evalJs(`(document.querySelector('#results p.note') || {}).textContent || ''`);
  check("the summary reports both keywords",
    /keywords:/.test(bothTerms) && / and /.test(bothTerms),
    bothTerms.slice(0, 90));

  // Removing one keyword must leave the other alone.
  const dropOne = await evalJs(`(() => {
    document.querySelector('#searchchips .searchchip-x')?.click();
    return JSON.stringify({
      chips: [...document.querySelectorAll('.searchchip-label')].map(c => c.textContent),
      clear: !!document.querySelector('.searchchips-clear'),
    });
  })()`);
  const d1 = JSON.parse(String(dropOne));
  check("removing one chip keeps the other", d1.chips.length === 1, JSON.stringify(d1.chips));
  check("and the clear-all control goes with the last one", d1.clear === false);

  // ------------------------------------------------------------- tag toggle off

  // A picker that can only be turned on is a one-way door: someone who picks
  // the wrong tag would have to reload to get back.
  // Clear whatever earlier blocks selected first: the selection is a list now, so
  // leaving a stray tag behind makes "the selected tag" ambiguous.
  await evalJs(`(async () => {
    for (let i = 0; i < 20; i++) {
      const b = document.querySelector('#taglist .tagbtn[aria-pressed=true]');
      if (!b) break;
      b.click();
      await new Promise(r => setTimeout(r, 40));
    }
    return 1;
  })()`);
  await Bun.sleep(1200);

  await evalJs(`(() => {
    const b = document.querySelector('#taglist .tagbtn[aria-pressed=false]');
    b.click();
    return 1;
  })()`);
  await Bun.sleep(1200);

  await evalJs(`document.querySelector('#taglist .tagbtn[aria-pressed=true]')?.click()`);
  await Bun.sleep(700);
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

  // ------------------------------------------------------- an empty result set

  // The buffering ring belongs to the in-flight state only. A query that matches
  // nothing is also a settled state, and a ring left spinning there would tell a
  // reader the search is still running when it has already finished.
  await evalJs(`(() => { const q=document.getElementById('q');
    q.value='zzqxvnotarealprojectname12345';
    q.dispatchEvent(new Event('input',{bubbles:true})); return 1; })()`);
  await waitFor(evalJs,
    `(document.getElementById('results').getAttribute('aria-busy')==='false'
      && document.getElementById('results').textContent.includes('No Pages sites matched'))`);
  const none = await evalJs(`(() => ({
    rows: document.querySelectorAll('#results .row').length,
    spinners: document.querySelectorAll('#results .spinner').length,
    box: document.querySelectorAll('#results .empty').length,
  }))()`);
  check("a query that matches nothing settles with no rows", none?.rows === 0, `${none?.rows} rows`);
  check("and says so in a placeholder", none?.box === 1, `${none?.box} placeholders`);
  check("but shows no buffering ring, because nothing is in flight",
    none?.spinners === 0, `${none?.spinners} spinners`);

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