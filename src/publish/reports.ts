/**
 * M7 — "claim or report" links.
 *
 * GitHub Pages serves static files only, so there is no server to receive a
 * form submission. Rather than pretend otherwise, the flow is built from
 * pre-filled GitHub issue URLs: no backend, no third-party form service, no
 * data collection, and every report lands in the repo as a reviewable issue
 * that the nightly job can act on.
 *
 * The URLs are generated into the published index so the client can offer
 * "report this site" per result without hardcoding anything.
 */

import { readFileSync, existsSync, writeFileSync } from "node:fs";
import { PATHS } from "../paths";

/** Repository that receives reports. Overridable for forks. */
const REPO = process.env.REPORT_REPO ?? "velo4705/ghindex";

export interface ReportLinks {
  /** Pre-filled issue for a site that appears broken. */
  broken: string;
  /** Pre-filled issue to submit or claim a site. */
  submit: string;
}

function issueUrl(title: string, body: string, labels: string[]): string {
  const p = new URLSearchParams({ title, body });
  if (labels.length) p.set("labels", labels.join(","));
  return `https://github.com/${REPO}/issues/new?${p.toString()}`;
}

/** Report a site in the index that is dead, hijacked, or miscategorised. */
export function reportBroken(url: string, note?: string): ReportLinks {
  const body = [
    "## Report: problem with an indexed site",
    "",
    `- **Site:** ${url}`,
    `- **Observed:** ${note ?? "(dead / 404 / wrong content / miscategorised)"}`,
    `- **Found via:** ghindex search`,
    "",
    "### What should happen",
    "",
    "The nightly job re-probes reported sites on the next run. If the site is",
    "dead it moves through the backoff schedule and is eventually unpublished.",
    "",
    "> This issue was pre-filled by the site. Please add any useful detail above.",
  ].join("\n");
  return { broken: issueUrl(`Dead or incorrect: ${url}`, body, ["report"]), submit: "" };
}

/** Submit a new site, or claim an existing one. */
export function submitSite(url: string, owner: string): ReportLinks {
  const body = [
    "## Submit a site",
    "",
    `- **Site:** ${url}`,
    `- **Owner:** @${owner}`,
    "",
    "### Details",
    "",
    "- What is it?",
    "- Which category does it belong in?",
    "- Is it your site, and do you want it listed?",
    "",
    "> This issue was pre-filled by ghindex. Submissions are reviewed before",
    "> they are added, and the site must be reachable over HTTPS.",
  ].join("\n");
  return { broken: "", submit: issueUrl(`Submit: ${url}`, body, ["submission"]) };
}

if (import.meta.main) {
  // Emit a small JSON map so the client can build links without duplicating
  // the issue template. Keyed by nothing: templates are per-URL, so the client
  // fills in the url/owner at click time.
  const templates = {
    repo: REPO,
    broken: {
      title: (u: string) => `Dead or incorrect: ${u}`,
      labels: "report",
    },
    submit: {
      title: (u: string) => `Submit: ${u}`,
      labels: "submission",
    },
  };
  const out = `${PATHS.site}/data/reports.json`;
  writeFileSync(out, JSON.stringify(templates, null, 2));
  console.log(`[reports] wrote ${out} (repo: ${REPO})`);
  if (!existsSync(`${PATHS.site}/data/manifest.json`)) {
    console.warn("[reports] warning: manifest missing - run build first");
  }
}
