/**
 * Minimal static server for local development.
 *   bun run serve   ->  http://localhost:8099
 *
 * EDGE=<url> rewrites the page's search endpoint before serving index.html.
 *
 * That exists because the endpoint is baked into a <meta> tag in the markup, so
 * without it any browser run pointed at whatever worker was deployed - which is
 * how the test suite ended up spending the production rate-limit budget. Setting
 * EDGE points the page somewhere else, and the test suite sets it to a local
 * fixture worker. Nothing else about the page changes.
 */
import { resolve, sep } from "node:path";
import { PATHS } from "./src/paths";

const ROOT = resolve(PATHS.site);
const PORT = Number(process.env.PORT ?? 8099);
const EDGE = process.env.EDGE?.trim();

const EDGE_META = /(<meta name="ghindex-edge" content=")[^"]*(")/;

const server = Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);
    const rel = url.pathname === "/" ? "/index.html" : url.pathname;
    // Normalize then verify containment, so "../" cannot escape the site dir.
    const target = resolve(ROOT + rel);
    if (target !== ROOT && !target.startsWith(ROOT + sep)) {
      return new Response("forbidden", { status: 403 });
    }

    const file = Bun.file(target);
    if (!(await file.exists())) return new Response("not found", { status: 404 });

    if (EDGE && target === resolve(ROOT, "index.html")) {
      const html = await file.text();
      if (!EDGE_META.test(html)) {
        throw new Error("index.html has no ghindex-edge meta tag to redirect");
      }
      return new Response(html.replace(EDGE_META, `$1${EDGE}$2`), {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }

    return new Response(file);
  },
});

console.log(`ghindex dev server: http://localhost:${server.port}  (serving ${PATHS.site})`);
if (EDGE) console.log(`ghindex edge override: ${EDGE}`);
