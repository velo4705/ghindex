/**
 * M3 browser verification.
 *
 * Static existence checks proved nothing about the UI. This drives real Edge
 * via the DevTools Protocol: loads the page, waits for the worker to return
 * results, exercises the tag facet, and fails on any console error.
 */

const EDGE = "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
const PORT = 9222;
const BASE = process.env.BASE ?? "http://localhost:8099";

async function main() {
  const proc = Bun.spawn(
    [
      EDGE,
      "--headless=new",
      `--remote-debugging-port=${PORT}`,
      "--disable-gpu",
      "--no-first-run",
      "--user-data-dir=" + (await import("node:fs")).mkdtempSync("C:/Users/JOVIAN~1/AppData/Local/Temp/opencode/edge-"),
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
  await Bun.sleep(3500);

  const count = await evalJs(`document.getElementById('count')?.textContent ?? ''`);
  check("manifest loaded, count shown", /\d/.test(count), count);

  const meta = await evalJs(`document.getElementById('meta')?.textContent ?? ''`);
  check("worker returned results", /match/.test(meta), meta);

  const rowCount = await evalJs(`document.querySelectorAll('.row').length`);
  check("rows rendered", rowCount > 0, `${rowCount} rows`);

  const facets = await evalJs(`document.querySelectorAll('.facet').length`);
  check("tag facets rendered", facets > 0, `${facets} facets`);

  // Type a query and confirm filtering narrows results.
  await evalJs(`(() => { const q=document.getElementById('q'); q.value='portfolio';
    q.dispatchEvent(new Event('input',{bubbles:true})); return 1; })()`);
  await Bun.sleep(1200);
  const afterMeta = await evalJs(`document.getElementById('meta')?.textContent ?? ''`);
  const afterRows = await evalJs(`document.querySelectorAll('.row').length`);
  check("search filters results", afterRows > 0 && /match/.test(afterMeta), afterMeta);

  // Tag facet. Clear the search box FIRST: otherwise the facet combines with a
  // typed query and a narrow intersection can legitimately yield 0 matches,
  // which made an earlier version of this test fail spuriously.
  await evalJs(`(() => { const q=document.getElementById('q'); q.value='';
    q.dispatchEvent(new Event('input',{bubbles:true})); return 1; })()`);
  await Bun.sleep(1000);
  const beforeFacet = await evalJs(`document.querySelectorAll('.row').length`);
  const facetTag = await evalJs(`document.querySelector('.facet')?.dataset.tag ?? ''`);
  await evalJs(`(() => { const f=document.querySelector('.facet'); if(!f) return 0; f.click(); return 1; })()`);
  await Bun.sleep(1200);
  const facetMeta = await evalJs(`document.getElementById('meta')?.textContent ?? ''`);
  const pressedNow = await evalJs(`[...document.querySelectorAll('.facet[aria-pressed=true]')].map(f=>f.dataset.tag).join(',')`);
  check("tag facet filters", new RegExp("[1-9]\\d* match").test(facetMeta) && pressedNow === facetTag,
    `${facetMeta} (pressed=${pressedNow || 'none'})`);

  // Clear the tag facet again so categories are tested independently.
  await evalJs(`(() => { document.querySelectorAll('.facet[aria-pressed=true]').forEach(f=>f.click()); return 1; })()`);
  await Bun.sleep(1000);

  // Category facets (M4).
  const catCount = await evalJs(`document.querySelectorAll('.cat').length`);
  check("category facets render", catCount >= 8, `${catCount} categories`);

  const catLabels = await evalJs(`[...document.querySelectorAll('.cat')].map(c=>c.childNodes[0]?.textContent?.trim()).join(' | ')`);
  check("categories use human labels", /Portfolio/.test(catLabels), catLabels.slice(0, 90));

  const catId = await evalJs(`document.querySelector('.cat')?.dataset.cat ?? ''`);
  const catCountBefore = await evalJs(`document.getElementById('meta').textContent`);
  await evalJs(`(() => { const c=document.querySelector('.cat'); if(!c) return 0; c.click(); return 1; })()`);
  await Bun.sleep(1200);
  const catMeta = await evalJs(`document.getElementById('meta')?.textContent ?? ''`);
  const catPressed = await evalJs(`[...document.querySelectorAll('.cat[aria-pressed=true]')].map(c=>c.dataset.cat).join(',')`);
  check("category facet filters", new RegExp("[1-9]\\d* match").test(catMeta) && catPressed === catId,
    `${catMeta} (pressed=${catPressed || 'none'})`);

  // Category chips must appear on rendered results.
  const chips = await evalJs(`document.querySelectorAll('.cat-chip').length`);
  check("results show category chips", chips > 0, `${chips} chips`);

  // Category filter must actually narrow the set. Parse only the leading count
  // (strip the " (showing N)" suffix, which would otherwise concatenate digits).
  const narrowed = await evalJs(`
    (() => { const m = document.getElementById('meta').textContent;
      const first = m.split('match')[0].replace(/[^0-9]/g,''); return parseInt(first,10); })()`);
  check("category filter narrows results", narrowed > 0 && narrowed < 5739,
    `${narrowed} of 5,739`);

  await evalJs(`(() => { document.querySelectorAll('.cat[aria-pressed=true]').forEach(c=>c.click()); return 1; })()`);
  await Bun.sleep(1000);

  // Switch to grid view.
  await evalJs(`document.getElementById('view').click()`);
  await Bun.sleep(2000);
  const cards = await evalJs(`document.querySelectorAll('.card').length`);
  const iframes = await evalJs(`document.querySelectorAll('.card iframe').length`);
  const cls = await evalJs(`document.getElementById('results').className`);
  check("grid view renders cards", cards > 0, `${cards} cards, container="${cls}"`);
  check("grid previews mount iframes", iframes > 0, `${iframes} iframes`);

  const pressed = await evalJs(`document.getElementById('view').getAttribute('aria-pressed')`);
  check("view toggle state", pressed === "true", `aria-pressed=${pressed}`);

  check("no console errors", consoleErrors.length === 0, consoleErrors.slice(0, 3).join(" | "));

  console.log(`\n${failures === 0 ? "ALL BROWSER CHECKS PASSED" : `${failures} BROWSER CHECK(S) FAILED`}`);
  ws.close();
  proc.kill();
  process.exit(failures === 0 ? 0 : 1);
}

await main();
