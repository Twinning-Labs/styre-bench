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
