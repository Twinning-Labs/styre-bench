/**
 * Durable per-run evidence directories (ENG-393).
 *
 * WHY THIS EXISTS: run artifacts used to be written under `os.tmpdir()`, where the OS reclaims
 * them. The 2026-09-08 astropy run's `sot.db`, `transcript.jsonl`, `profile.json` and
 * `run.ndjson` were gone by the next morning, taking with them the only record of why
 * `ac-check-red-first` errored and what an 18-minute failed dispatch was doing. `run-task.ts`
 * captures the SoT precisely because swallowed `merge:push`/`pr_create` forge errors are
 * recorded ONLY there and never reach the NDJSON stream — capturing it into a directory the OS
 * deletes defeated the point, and also made `cleanup.ts`'s retain-on-failure option meaningless.
 *
 * Retention is now the operator's decision (`evidenceKeepRuns`), applied by deliberate pruning
 * rather than incidental OS cleanup.
 */

/** Anything that is not a safe single path segment character. `.` is deliberately EXCLUDED
 *  from the safe set: instance ids come from corpus data, and allowing dots through would let
 *  a `..` survive sanitisation and traverse out of the evidence root. No id needs one. */
const UNSAFE = /[^A-Za-z0-9_-]+/g;

function pad(n: number, width = 2): string {
  return String(n).padStart(width, "0");
}

/**
 * PURE. Builds one evidence directory NAME (not a path) for a run.
 *
 * Shape: `<instance>-<YYYYMMDD>-<HHMMSS>-<suffix>`, using UTC so the name sorts
 * chronologically as a plain string — `selectPrunable` relies on that, and so does anyone
 * listing the directory. The instance id is sanitised to a single safe path segment: it comes
 * from corpus data, so it must never be able to introduce a separator or `..` and escape the
 * evidence root.
 */
export function evidenceDirName(instanceId: string, at: Date, suffix: string): string {
  const safeInstance = instanceId.replace(UNSAFE, "_") || "instance";
  const safeSuffix = suffix.replace(UNSAFE, "_") || "0";
  const date = `${at.getUTCFullYear()}${pad(at.getUTCMonth() + 1)}${pad(at.getUTCDate())}`;
  const time = `${pad(at.getUTCHours())}${pad(at.getUTCMinutes())}${pad(at.getUTCSeconds())}`;
  return `${safeInstance}-${date}-${time}-${safeSuffix}`;
}

/**
 * PURE. Given the evidence root's directory names, returns the ones to delete so that only the
 * `keep` most recent survive. Names sort chronologically (see `evidenceDirName`), so this is a
 * lexicographic sort with the tail retained.
 *
 * A `keep` below zero is clamped to 0 — without the clamp, `slice(0, -n)` would silently
 * retain the OLDEST entries and prune the newest, the exact inverse of the intent.
 */
export function selectPrunable(names: string[], keep: number): string[] {
  const bounded = Math.max(0, Math.floor(keep));
  const sorted = [...names].sort();
  if (sorted.length <= bounded) return [];
  return sorted.slice(0, sorted.length - bounded);
}

/**
 * Prunes the evidence root down to the `keep` most recent runs. Deliberate, operator-controlled
 * retention (`evidenceKeepRuns`) — the point of ENG-393 is that the OS is never the policy.
 *
 * `keep === 0` disables pruning entirely (keep everything) rather than deleting everything:
 * a config knob that silently wipes all history on its zero value is a footgun, and an
 * operator who wants nothing retained simply does not run the bench. Best-effort — a prune
 * failure must never fail a run, since the evidence is a diagnostic aid, not an output.
 */
export async function pruneEvidenceDirs(root: string, keep: number): Promise<string[]> {
  if (keep <= 0) return [];
  const { readdir, rm } = await import("node:fs/promises");
  const path = await import("node:path");
  let entries: string[];
  try {
    entries = (await readdir(root, { withFileTypes: true }))
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return []; // root does not exist yet — nothing to prune
  }
  const doomed = selectPrunable(entries, keep);
  const removed: string[] = [];
  for (const name of doomed) {
    try {
      await rm(path.join(root, name), { recursive: true, force: true });
      removed.push(name);
    } catch {
      // best-effort
    }
  }
  return removed;
}
