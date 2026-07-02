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
 * PURE. FIREWALL (path-level, GitHub seeding): throws if any path in `paths` is a path
 * touched by `inst.test_patch` or `inst.fix_patch`. `test_patch` in particular almost
 * always ADDS a brand-new held-out test file that has no business existing in a
 * `base_commit` snapshot — so if one shows up anyway (corpus anomaly, coincidental
 * collision, or a bug upstream of this call), the correct response is a hard fail, not a
 * silent strip. This is stricter than `.claude/` stripping on purpose: `.claude/` is
 * expected to exist in real repos and is safe to remove proactively; a held-out patch path
 * showing up in the tree is never expected and must never be silently tolerated.
 */
export function assertNoHeldOutPaths(paths: Iterable<string>, inst: Instance): void {
  const heldOut = new Set([...touchedPaths(inst.test_patch), ...touchedPaths(inst.fix_patch)]);
  if (heldOut.size === 0) return;
  const offenders = [...paths].filter((p) => heldOut.has(p));
  if (offenders.length > 0) {
    throw new Error(
      `assertNoHeldOutPaths: FIREWALL VIOLATION for instance '${inst.id}' — the snapshot about to be pushed contains held-out path(s) from test_patch/fix_patch: ${offenders.join(", ")}. These must never reach styre; refusing to seed.`,
    );
  }
}

const DEFAULT_MIN_SENTINEL_LEN = 20;

/**
 * PURE. Extracts "non-trivial" content lines (added/removed code lines, not diff metadata,
 * hunk headers, or file headers) from a unified diff: lines starting with `+`/`-` (but not
 * `+++`/`---`), trimmed, at least `minLineLength` characters. Short/boilerplate lines
 * (blank lines, a single brace, `pass`, ...) are too common to be a trustworthy sentinel
 * and would produce false-positive firewall trips against unrelated text.
 */
function heldOutLines(patch: string, minLineLength: number): string[] {
  const lines: string[] = [];
  for (const raw of patch.split("\n")) {
    if (raw.startsWith("+++") || raw.startsWith("---")) continue;
    if (!raw.startsWith("+") && !raw.startsWith("-")) continue;
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

function isUnderClaudeDir(p: string): boolean {
  const norm = p.replace(/^\.\//, "");
  return norm === ".claude" || norm.startsWith(".claude/") || norm.includes("/.claude/");
}

/**
 * PURE. Strips any file whose path is under a `.claude/` directory (at any depth) — a real
 * seeded repo can carry its own `.claude/settings.json` that re-enables `WebFetch`/
 * `WebSearch`, silently breaking the web-off cohort's behavioral guarantee (design §3.1).
 * Unlike the held-out-path firewall, this is an unconditional strip, not an assert: `.claude/`
 * is expected to legitimately exist in real repos, so removing it is a routine safety step,
 * not evidence something has already gone wrong.
 */
export function stripClaudeDir<T extends { path: string }>(files: T[]): T[] {
  return files.filter((f) => !isUnderClaudeDir(f.path));
}
