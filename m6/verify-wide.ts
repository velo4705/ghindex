/** End-to-end: does the on-demand search find a site the local index lacks? */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { PATHS } from "../src/paths";

const EDGE = "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
const PORT = 9229;

// A site confirmed live and absent from the local index.
const PROBE = "arthursonzogni";

const manifest = JSON.parse(readFileSync(`${PATHS.data}/manifest.json`, "utf8"));
const owners: string[] = [];
for (const s of manifest.shards) {
  const rows = JSON.parse(readFileSync(`${PATHS.data}/${s.file}`, "utf8"));
  for (const r of rows) owners.push(String(r.o).toLowerCase());
}
const inIndex = owners.includes(PROBE);
console.log(`[probe] "${PROBE}" in local index: ${inIndex}`);

const proc = Bun.spawn(
  [EDGE, "--headless=new", `--remote-debugging-port=${PORT}`, "--disable-gpu", "--no-sandbox",
   "--disable-dev-shm-usage", "--no-first-run",
   "--user-data-dir=" + mkdtempSync(join(tmpdir(), "wide-")), "about:blank"],
  { stdout: "ignore", stderr: "ignore" },
);
let target: any = null;
for (let i = 0; i < 40; i++) {
  await Bun.sleep(500);
  try {
    const l = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
    target = l.find((t: any) => t.type === "page");
    if (target) break;
  } catch {}
}
const ws = new WebSocket(target.webSocketDebuggerUrl);
let id = 0; const pending = new Map<string, any>(); const errs: string[] = [];
ws.onmessage = (e) => {
  const m = JSON.parse(e.data as string);
  if (m.id && pending.has(String(m.id))) { pending.get(String(m.id))(m); pending.delete(String(m.id)); }
  if (m.method === "Runtime.consoleAPICalled" && m.params.type === "error") {
    errs.push((m.params.args ?? []).map((a: any) => a.value ?? a.description ?? "").join(" "));
  }
};
await new Promise((r) => (ws.onopen = r));
const send = (m: string, p: any = {}) => new Promise((res) => { const mid = ++id; pending.set(String(mid), res); ws.send(JSON.stringify({ id: mid, method: m, params: p })); });
const ev = async (x: string) => (await send("Runtime.evaluate", { expression: x, returnByValue: true, awaitPromise: true })).result?.result?.value;

await send("Runtime.enable");
await send("Page.enable");
await send("Page.navigate", { url: "http://localhost:8099/index.html" });
await Bun.sleep(3000);

// Type a query and press the wide-search button.
await ev(`(() => { const q=document.getElementById('q'); q.value='${PROBE}';
  q.dispatchEvent(new Event('input',{bubbles:true})); return 1; })()`);
await Bun.sleep(1200);
// Click the TRIGGER button (id="wide"), not the results section
// (id="wide-results") — a bulk rename earlier turned this into a click on a
// section that does not exist yet, so the search never ran.
await ev(`document.getElementById('wide').click()`);
await Bun.sleep(6000);

let fail = 0;
const check = (n: string, ok: boolean, d = "") => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${n}${d ? ` â€” ${d}` : ""}`);
  if (!ok) fail++;
};

check("token row is revealed", await ev(`!document.getElementById('tokenrow').hidden`));
check("wide results section exists", await ev(`!!document.getElementById('wide-results')`));
// Position matters: an earlier version inserted this before #results, which
// rendered it above the results. Assert the real containment: #wide must be a
// child of <main>, and must come after #results in document order.
const placement = await ev(`
  (() => {
    const w = document.getElementById('wide-results');
    const r = document.getElementById('results');
    if (!w || !r) return { error: 'missing' };
    const inMain = w.closest('main') !== null;
    const sameParent = w.parentElement === r.parentElement;
    // DOCUMENT_POSITION_FOLLOWING means r precedes w, i.e. results come first.
    const resultsFirst = !!(r.compareDocumentPosition(w) & Node.DOCUMENT_POSITION_FOLLOWING);
    return { inMain, sameParent, resultsFirst, parent: w.parentElement.tagName,
             resultsParent: r.parentElement.tagName };
  })()`);
const p = typeof placement === "string" ? JSON.parse(placement) : placement;
check("wide section is inside <main>", p.inMain === true, `parent=<${p.parent}>`);
check("wide section shares a parent with #results", p.sameParent === true,
  `results parent=<${p.resultsParent}>`);
check("wide section appears after the results", p.resultsFirst === true);
check("wide section did not land inside the header", await ev(`document.querySelector('header #wide-results') === null`));
check("the search input is still visible", await ev(`
  (() => { const r = document.getElementById('q').getBoundingClientRect();
           return r.width > 100 && r.height > 10; })()`));
const note = await ev(`document.querySelector('#wide-results .note')?.textContent ?? ''`);
check("wide section shows a result summary", note.length > 10, note.slice(0, 100));
const wideRows = await ev(`document.querySelectorAll('#wide-results .row').length`);
check("wide results rendered", wideRows > 0, `${wideRows} rows`);
const pill = await ev(`document.querySelectorAll('#wide-results .pill').length`);
check("results labelled as not indexed", pill > 0, `${pill} pills`);
const hrefs = await ev(`[...document.querySelectorAll('#wide-results .row .url')].map(e=>e.textContent.trim()).slice(0,5).join(' | ')`);
console.log(`  urls: ${hrefs}`);

// The key assertion: it found something our local index does not have.
// Compare owner-by-owner; a substring test over a joined string is unreliable
// because one owner name is a prefix of another.
const wideOwners = await ev(`
  [...document.querySelectorAll('#wide-results .row')]
    .map(r => (r.querySelector('.url')?.textContent || '').trim())
    .map(u => { try { return new URL(u).hostname.split('.')[0].toLowerCase(); } catch { return ''; } })
    .filter(Boolean)
`);
const known = new Set(owners);
const fresh = wideOwners.filter((o: string) => !known.has(o));
console.log(`  wide owners: ${wideOwners.join(", ") || "(none)"}`);
console.log(`  of those, not in the local index: ${fresh.length ? fresh.join(", ") : "(none)"}`);
check("on-demand search found at least one site the local index lacks",
  fresh.length > 0, fresh.join(", "));

check("no console errors", errs.length === 0, errs.slice(0, 2).join(" | "));

const { result } = await send("Page.captureScreenshot", { format: "png" });
if (result?.data) {
  await Bun.write("m6/screenshots/wide-search.png", Buffer.from(result.data, "base64"));
  console.log("  wrote m6/screenshots/wide-search.png");
}

console.log(`\n${fail === 0 ? "ON-DEMAND SEARCH VERIFIED IN BROWSER" : `${fail} CHECK(S) FAILED`}`);
ws.close();
proc.kill();
process.exit(fail === 0 ? 0 : 1);
