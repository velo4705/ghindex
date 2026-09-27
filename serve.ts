/**
 * Minimal static server for local development.
 *   bun run serve   ->  http://localhost:8099
 */
import { resolve, sep } from "node:path";
import { PATHS } from "./src/paths";

const ROOT = resolve(PATHS.site);
const PORT = Number(process.env.PORT ?? 8099);

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
    return new Response(file);
  },
});

console.log(`ghindex dev server: http://localhost:${server.port}  (serving ${PATHS.site})`);
