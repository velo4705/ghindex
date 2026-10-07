/**
 * "Claim or report" links.
 *
 * GitHub Pages serves static files only, so there is no server to receive a form
 * submission. Rather than pretend otherwise, the flow is built from pre-filled
 * GitHub issue URLs: no backend, no third-party form service, no data collection.
 *
 * This only writes one small config file — which repository receives reports —
 * because the issue templates are built in the browser. There is no published
 * index for them to be generated into any more, and a browser that has to fetch
 * a template per click to open an issue is a worse experience than one that
 * already knows how to write the link.
 */

import { writeFileSync } from "node:fs";
import { PATHS } from "../paths";

/** Repository that receives reports. Overridable for forks. */
const REPO = process.env.REPORT_REPO ?? "velo4705/ghindex";

if (import.meta.main) {
  const config = {
    repo: REPO,
    broken: { labels: "report" },
    submit: { labels: "submission" },
  };
  const out = `${PATHS.site}/data/reports.json`;
  writeFileSync(out, JSON.stringify(config, null, 2));
  console.log(`[reports] wrote ${out} (repo: ${REPO})`);
}