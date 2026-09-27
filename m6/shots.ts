/** Screenshot the redesigned site in both themes and both views. */
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const EDGE = "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
const PORT = 9227;
const OUT = "m6/screenshots";
mkdirSync(OUT, { recursive: true });

const proc = Bun.spawn(
  [EDGE, "--headless=new", `--remote-debugging-port=${PORT}`, "--disable-gpu", "--no-sandbox",
   "--disable-dev-shm-usage", "--no-first-run", "--hide-scrollbars",
   "--user-data-dir=" + mkdtempSync(join(tmpdir(), "shot-")), "about:blank"],
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
let id = 0;
const pending = new Map<string, any>();
ws.onmessage = (e) => {
  const m = JSON.parse(e.data as string);
  if (m.id && pending.has(String(m.id))) { pending.get(String(m.id))(m); pending.delete(String(m.id)); }
};
await new Promise((r) => (ws.onopen = r));
const send = (m: string, p: any = {}) => new Promise((res) => { const mid = ++id; pending.set(String(mid), res); ws.send(JSON.stringify({ id: mid, method: m, params: p })); });
const ev = async (x: string) => (await send("Runtime.evaluate", { expression: x, returnByValue: true, awaitPromise: true })).result?.result?.value;

await send("Page.enable");
await send("Runtime.enable");
await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });

async function capture() {
  const res = await send("Page.captureScreenshot", { format: "png" });
  // CDP replies with { result: { data } }; the helper already unwraps the
  // outer envelope, so read .result.data here.
  const data = res?.result?.data;
  if (!data) throw new Error("captureScreenshot returned no data");
  return Buffer.from(data, "base64");
}

async function shoot(name: string, scheme: "dark" | "light") {
  await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: scheme }] });
  await send("Page.navigate", { url: "http://localhost:8099/index.html" });
  await Bun.sleep(3000);
  await Bun.write(`${OUT}/${name}.png`, await capture());
  console.log(`  wrote ${OUT}/${name}.png`);
}

console.log("[shots] capturing");
await shoot("01-list-dark", "dark");
await shoot("02-list-light", "light");

// Grid view, dark.
await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "dark" }] });
await send("Page.navigate", { url: "http://localhost:8099/index.html" });
await Bun.sleep(3000);
await ev(`document.getElementById('view').click()`);
await Bun.sleep(3000);
await Bun.write(`${OUT}/03-grid-dark.png`, await capture());
console.log(`  wrote ${OUT}/03-grid-dark.png`);

// A search with a category filter applied.
await send("Page.navigate", { url: "http://localhost:8099/index.html" });
await Bun.sleep(3000);
await ev(`(() => { const c=[...document.querySelectorAll('.cat')].find(x=>x.dataset.cat==='portfolio'); if(c) c.click(); return 1; })()`);
await Bun.sleep(2000);
{
  await Bun.write(`${OUT}/04-filtered-dark.png`, await capture());
  console.log(`  wrote ${OUT}/04-filtered-dark.png`);
}

ws.close();
proc.kill();
