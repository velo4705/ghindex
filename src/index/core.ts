/**
 * M1 core — types, shard planning, and the dead-link state machine.
 */

/** A repo that GitHub reports as having Pages enabled. */
export interface Repo {
  full_name: string;
  owner: string;
  name: string;
  /** Resolved Pages URL (subpath in ~95% of cases). */
  url: string;
  homepage: string | null;
  topics: string[];
  description: string | null;
  stars: number;
  pushed_at: string;
}

export type Liveness =
  | "unknown"
  | "alive"
  | "suspect"
  | "flaky"
  | "tombstoned";

export interface Record extends Repo {
  discovered_at: string;
  liveness: Liveness;
  http_status: number | null;
  last_checked: string | null;
  last_ok: string | null;
  /** Consecutive failed checks; resets on success. */
  fails: number;
  /** When this record is next due for a probe. */
  next_check: string | null;
  /** Extracted page metadata (from the last successful GET). */
  title: string | null;
  page_description: string | null;
  blocks_framing: boolean | null;
}

/**
 * A Pages site is served at the apex owner.github.io ONLY when the repo is
 * named "<owner>.github.io". Everything else is a subpath. Measured at 4.6%
 * apex / 95.4% subpath — assuming apex produces ~95% broken links.
 *
 * A repo's declared `homepage` is NOT trusted blindly: it is a free-form field
 * and real-world data contains values that are not github.io at all (e.g.
 * "http://jkunst.com/jbkunst.github.io3/" and
 * "https://github.com/user/repo/wiki"). We only accept a homepage that is
 * actually a *.github.io host, and we still require it to belong to the owner.
 */
export function pagesUrlFor(owner: string, name: string, homepage: string | null): string {
  const o = owner.toLowerCase();
  if (homepage) {
    try {
      const u = new URL(homepage);
      const host = u.hostname.toLowerCase();
      // Must be a github.io host owned by this user (or their *.github.io sub).
      if (host.endsWith(".github.io") && (host === `www.${o}.github.io` || host === `${o}.github.io` || host.endsWith(`.${o}.github.io`))) {
        return u.toString();
      }
    } catch {
      // Unparseable homepage: fall through to the derived URL.
    }
  }
  if (name.toLowerCase() === `${o}.github.io`) return `https://${o}.github.io/`;
  return `https://${o}.github.io/${name.toLowerCase()}/`;
}

/** True if the URL looks like a real, visitable *.github.io link. */
export function isValidPagesUrl(u: string): boolean {
  try {
    const url = new URL(u);
    const host = url.hostname.toLowerCase();
    if (host !== "github.io" && !host.endsWith(".github.io")) return false;
    // The bare apex and the shared Pages infrastructure host are not user sites.
    if (host === "github.io") return false;
    if (host === "pages.github.io" || host.endsWith(".pages.github.io")) return false;
    return true;
  } catch {
    return false;
  }
}

const DAY = 86_400_000;

/**
 * Backoff schedule. A site that 404s once is usually a broken deploy, not a
 * dead project, so we retry generously before tombstoning. Tombstoned records
 * are retained in the DB (never deleted) but excluded from published results.
 */
export function nextCheckFor(
  liveness: Liveness,
  fails: number,
  from: number = Date.now(),
): { liveness: Liveness; nextCheck: string; fails: number } {
  if (liveness === "alive") {
    // Healthy sites are cheap but not free: recheck monthly.
    return { liveness, nextCheck: new Date(from + 30 * DAY).toISOString(), fails: 0 };
  }
  if (liveness === "flaky") {
    // 5xx/timeout: likely transient, retry quickly.
    return {
      liveness,
      nextCheck: new Date(from + 2 * DAY).toISOString(),
      fails: fails + 1,
    };
  }
  // suspect (404/410): 30d -> 90d -> 180d, then tombstone.
  const n = fails + 1;
  if (n >= 4) {
    return { liveness: "tombstoned", nextCheck: new Date(from + 365 * DAY).toISOString(), fails: n };
  }
  const days = n === 1 ? 30 : n === 2 ? 90 : 180;
  return { liveness: "suspect", nextCheck: new Date(from + days * DAY).toISOString(), fails: n };
}

export function classify(
  status: number,
  error: string | null,
  now: number = Date.now(),
): { liveness: Liveness; nextCheck: string; fails: number } {
  if (error !== null) {
    // Network error — could be DNS, TLS, or timeout. Treat as flaky.
    return nextCheckFor("flaky", 0, now);
  }
  if (status >= 200 && status < 300) {
    return nextCheckFor("alive", 0, now);
  }
  if (status >= 500) {
    return nextCheckFor("flaky", 0, now);
  }
  if (status === 404 || status === 410) {
    return nextCheckFor("suspect", 0, now);
  }
  // 403/429 and friends: not a verdict on the site's existence.
  return nextCheckFor("flaky", 0, now);
}

/** Records eligible for republication. */
export function isPublishable(r: Record): boolean {
  return r.liveness === "alive";
}

/** Records due for a probe right now. */
export function isDue(r: Record, now: number = Date.now()): boolean {
  if (r.liveness === "tombstoned") return false;
  if (!r.next_check) return true;
  return new Date(r.next_check).getTime() <= now;
}
