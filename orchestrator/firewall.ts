import type { Instance } from "./types";

/**
 * PURE. Extracts the set of file paths touched by a unified diff, from its
 * `diff --git a/X b/Y` headers (falling back to `--- a/X` / `+++ b/X` lines for diffs
 * that lack the `diff --git` header, e.g. hand-assembled test fixtures or
 * `git diff --no-prefix` output). `/dev/null` (the create/delete sentinel) is never
 * added as a path.
 */
export function touchedPaths(patch: string): string[] {
  const paths = new Set<string>();
  for (const line of patch.split("\n")) {
    const gitHeader = line.match(/^diff --git a\/(\S+) b\/(\S+)/);
    if (gitHeader) {
      const [, a, b] = gitHeader;
      if (a) paths.add(a);
      if (b) paths.add(b);
      continue;
    }
    const minus = line.match(/^--- a\/(\S+)/);
    if (minus?.[1]) paths.add(minus[1]);
    const plus = line.match(/^\+\+\+ b\/(\S+)/);
    if (plus?.[1]) paths.add(plus[1]);
  }
  return [...paths];
}

/**
 * PURE. Extracts the set of file paths a unified diff CREATES (i.e. whose pre-image is
 * `/dev/null`) — as opposed to `touchedPaths`, which also includes paths the diff merely
 * modifies or deletes. Detected two ways, matching how git actually emits a new-file diff:
 * (1) a `diff --git a/X b/Y` block containing a `new file mode` line (the git-generated
 * form), or (2) a `--- /dev/null` header immediately followed by a `+++ b/<path>` header
 * (the form used by hand-assembled/SWE-bench-style patches that omit `diff --git`).
 * Modified/deleted paths (pre-image is a real path, not `/dev/null`) are NEVER included —
 * they legitimately pre-exist in `base_commit`.
 */
export function addedPaths(patch: string): string[] {
  const paths = new Set<string>();
  const lines = patch.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (/^new file mode/.test(line)) {
      for (let j = i; j >= 0; j--) {
        const gitHeader = (lines[j] ?? "").match(/^diff --git a\/\S+ b\/(\S+)/);
        if (gitHeader?.[1]) {
          paths.add(gitHeader[1]);
          break;
        }
      }
      continue;
    }
    if (line.trim() === "--- /dev/null") {
      const plus = (lines[i + 1] ?? "").match(/^\+\+\+ b\/(\S+)/);
      if (plus?.[1]) paths.add(plus[1]);
    }
  }
  return [...paths];
}

/**
 * PURE (throws). Guards against a malformed/unparseable patch silently disabling a
 * firewall: `touchedPaths` returning zero paths for a patch that is nevertheless
 * non-empty means the diff didn't match any recognized header shape, NOT that the patch
 * legitimately touches nothing (test_patch/fix_patch always exist and always touch >= 1
 * path in the corpus). Failing OPEN here (treating "couldn't parse" as "nothing held
 * out") would let a held-out file already present in base sail through undetected — so
 * this fails CLOSED instead.
 */
function assertParseable(patch: string, label: string, inst: Instance): void {
  if (patch.trim().length > 0 && touchedPaths(patch).length === 0) {
    throw new Error(
      `assertNoHeldOutPaths/assertNoHeldOut: unparseable patch (${label}, instance '${inst.id}'), refusing to seed.`,
    );
  }
}

/**
 * PURE. FIREWALL (path-level, GitHub seeding): throws if any path in `paths` is a path
 * ADDED (created) by `inst.test_patch` or `inst.fix_patch` — i.e. a held-out regression
 * test or a new fix file. Paths merely MODIFIED by `fix_patch` (the buggy source styre
 * must fix) or appended to by `test_patch` are NOT held-out: they legitimately pre-exist
 * in `base_commit` and must be present in the pushed snapshot. `test_patch` in particular
 * almost always ADDS a brand-new held-out test file that has no business existing in a
 * `base_commit` snapshot — so if one shows up anyway (corpus anomaly, coincidental
 * collision, or a bug upstream of this call), the correct response is a hard fail, not a
 * silent strip. This is stricter than `.claude/` stripping on purpose: `.claude/` is
 * expected to exist in real repos and is safe to remove proactively; a held-out patch path
 * showing up in the tree is never expected and must never be silently tolerated.
 */
export function assertNoHeldOutPaths(paths: Iterable<string>, inst: Instance): void {
  assertParseable(inst.test_patch, "test_patch", inst);
  assertParseable(inst.fix_patch, "fix_patch", inst);
  const heldOut = new Set([...addedPaths(inst.test_patch), ...addedPaths(inst.fix_patch)]);
  if (heldOut.size === 0) return;
  const offenders = [...paths].filter((p) => heldOut.has(p));
  if (offenders.length > 0) {
    throw new Error(
      `assertNoHeldOutPaths: FIREWALL VIOLATION for instance '${inst.id}' — the snapshot about to be pushed contains held-out path(s) ADDED by test_patch/fix_patch: ${offenders.join(", ")}. These must never reach styre; refusing to seed.`,
    );
  }
}

const DEFAULT_MIN_SENTINEL_LEN = 20;

/**
 * PURE. Extracts "non-trivial" ADDED content lines (not diff metadata, hunk headers, or
 * file headers) from a unified diff: lines starting with `+` (but not `+++`), trimmed, at
 * least `minLineLength` characters. Removed (`-`) lines are deliberately NOT included: they
 * are the OLD buggy code already present in `base_commit` and visible to styre — not
 * secret — so treating them as sentinels buys no protection while false-positive-rejecting
 * valid instances whose `problem_statement` legitimately quotes the buggy line or a stack
 * trace built from it. Short/boilerplate lines (blank lines, a single brace, `pass`, ...)
 * are too common to be a trustworthy sentinel and would produce false-positive firewall
 * trips against unrelated text.
 */
function heldOutLines(patch: string, minLineLength: number): string[] {
  const lines: string[] = [];
  for (const raw of patch.split("\n")) {
    if (raw.startsWith("+++")) continue;
    if (!raw.startsWith("+")) continue;
    const content = raw.slice(1).trim();
    if (content.length >= minLineLength) lines.push(content);
  }
  return lines;
}

/**
 * PURE. FIREWALL (content-level, shared by seed-github.ts and seed-linear.ts): throws if
 * `text` contains any non-trivial (>= `minLineLength` chars) line from `inst.fix_patch` or
 * `inst.test_patch`. This is the sentinel-line check for anything the bench places in
 * front of styre — a Linear ticket description, or (defense-in-depth) a pushed snapshot's
 * concatenated file contents — the held-out accepted fix and regression tests must never
 * leak into it.
 */
export function assertNoHeldOut(
  text: string,
  inst: Instance,
  minLineLength = DEFAULT_MIN_SENTINEL_LEN,
): void {
  assertParseable(inst.fix_patch, "fix_patch", inst);
  assertParseable(inst.test_patch, "test_patch", inst);
  const candidates = [
    ...heldOutLines(inst.fix_patch, minLineLength),
    ...heldOutLines(inst.test_patch, minLineLength),
  ];
  for (const line of candidates) {
    if (text.includes(line)) {
      const shown = line.length > 80 ? `${line.slice(0, 80)}…` : line;
      throw new Error(
        `assertNoHeldOut: FIREWALL VIOLATION for instance '${inst.id}' — text contains a ` +
          `line from the held-out fix_patch/test_patch: "${shown}"`,
      );
    }
  }
}

/**
 * What the CORPUS's own issue text already gave away about the accepted fix (ENG-411).
 *
 * Counts, never gates. `sample` carries at most `OVERLAP_SAMPLE_LIMIT` excerpts, truncated
 * the same way `assertNoHeldOut`'s error message truncates — enough to judge a record by,
 * never a reconstructable patch. It reaches `report/out/` (gitignored) and nothing else; it
 * is NEVER placed in front of styre.
 */
export interface TicketFixOverlap {
  /** Distinct non-trivial lines of the accepted fix the ticket already contained. */
  fix_lines: number;
  /** Same, for the held-out regression tests. */
  test_lines: number;
  /** Up to 3 offending lines, each truncated to 80 chars — evidence, not a patch. */
  sample: string[];
}

const OVERLAP_SAMPLE_LIMIT = 3;

/**
 * PURE. MEASUREMENT, not a gate (ENG-411): reports how much of `inst.fix_patch` /
 * `inst.test_patch` the corpus's OWN `problem_statement` already contains.
 *
 * WHY THIS IS NOT `assertNoHeldOut`. That function exists to catch a BENCH BUG — did we
 * compose held-out content into a ticket we wrote? It must stay fail-closed, and it does.
 * But wired over the whole issue body it also fired on 30.8% of SWE-bench Verified, because
 * real GitHub issues routinely contain the fix: in `astropy__astropy-13398` the reporter
 * says "I have put together the makings of a pull request" and pastes the code that was
 * ultimately merged. Nothing leaked there; the corpus is simply built from public issues,
 * and every harness that scores SWE-bench Verified feeds exactly that text. Refusing to run
 * cannot un-write a 2022 issue — it only discards a fifth of the corpus and makes the
 * resolve rate incomparable with published numbers. So: run it, and record what the ticket
 * gave away, so the report can state the rate both ways.
 *
 * Shares `heldOutLines` with `assertNoHeldOut` deliberately — "what counts as a held-out
 * line" must have exactly one definition, or the gate and the measurement drift apart and
 * the clean subset stops meaning what it says.
 */
export function measureTicketOverlap(
  text: string,
  inst: Instance,
  minLineLength = DEFAULT_MIN_SENTINEL_LEN,
): TicketFixOverlap {
  // Fail CLOSED on an unparseable patch for the same reason the gate does: a patch we cannot
  // read yields zero matches, which would render as a reassuring "clean ticket" when the
  // truth is that we did not look. "Not measured" and "measured zero" are different claims.
  assertParseable(inst.fix_patch, "fix_patch", inst);
  assertParseable(inst.test_patch, "test_patch", inst);

  const hits = (patch: string): string[] => [
    ...new Set(heldOutLines(patch, minLineLength).filter((line) => text.includes(line))),
  ];
  const fixHits = hits(inst.fix_patch);
  const testHits = hits(inst.test_patch);

  return {
    fix_lines: fixHits.length,
    test_lines: testHits.length,
    sample: [...fixHits, ...testHits]
      .slice(0, OVERLAP_SAMPLE_LIMIT)
      .map((line) => (line.length > 80 ? `${line.slice(0, 80)}…` : line)),
  };
}
