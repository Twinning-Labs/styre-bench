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

/** Filename the candidate diff is written under, inside a run's evidence dir. Fixed by
 *  convention so a report row's `evidence_dir` is enough to locate it — no extra field. */
export const CANDIDATE_DIFF_NAME = "candidate.diff";

/**
 * Persist the candidate diff alongside the run's other evidence.
 *
 * WHY: the diff previously existed only in the throwaway pull request, and `cleanup` deletes
 * that repo on a successful attempt — so the artifact the oracle needs was destroyed by the
 * success path. Combined with the run dir living in the system temp dir before ENG-393, a
 * completed run left nothing to score, which is why no scored verdict has ever been produced.
 *
 * BEST-EFFORT by design. The diff is evidence and a scoring input, never a run output: a write
 * failure must not fail a run that otherwise succeeded. Returns the path written, or `null`.
 */
export async function persistCandidateDiff(
  evidenceDir: string | null | undefined,
  diff: string,
): Promise<string | null> {
  if (!evidenceDir) return null;
  const { writeFile } = await import("node:fs/promises");
  const path = await import("node:path");
  const target = path.join(evidenceDir, CANDIDATE_DIFF_NAME);
  try {
    await writeFile(target, diff, "utf8");
    return target;
  } catch {
    return null; // evidence capture never fails a run
  }
}

export const SEED_MAPPING_NAME = "seed.json";

export interface SeedMapping {
  instance: string;
  repo_url: string;
  ident: string;
}

/**
 * Best-effort: record which throwaway repo and ticket a run used, beside that run's artifacts.
 *
 * Needed because neither the repo name nor the ticket title names the instance any more — both
 * used to, and both were readable from INSIDE the container (`git remote -v`, the fetched
 * ticket), handing the agent the public benchmark instance it was solving. Removing the id from
 * those two surfaces would otherwise also remove the operator's only way to tie an orphaned
 * `bench-<uuid>` repo back to a run. This file restores that on the HOST side, where the
 * container cannot read it.
 *
 * Mirrors `persistCandidateDiff`: never throws, and a missing `evidenceDir` is a no-op — losing
 * a mapping must never fail a run.
 */
export async function persistSeedMapping(
  evidenceDir: string | null | undefined,
  mapping: SeedMapping,
): Promise<string | null> {
  if (!evidenceDir) return null;
  const { writeFile } = await import("node:fs/promises");
  const path = await import("node:path");
  const target = path.join(evidenceDir, SEED_MAPPING_NAME);
  try {
    await writeFile(target, `${JSON.stringify(mapping, null, 2)}\n`, "utf8");
    return target;
  } catch {
    return null;
  }
}
