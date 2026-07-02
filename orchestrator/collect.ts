import { touchedPaths } from "./firewall";
import type { Instance, TaskRecord } from "./types";

/** Minimal shape of styre's `profile.json` this module needs — NOT the full styre
 * `ProfileSchema` (the rig is black-box against styre: it consumes the CLI + NDJSON,
 * never imports styre source, per the design doc's "black-box styre" invariant). Mirrors
 * only `components[].commands.test`, which is what the `probe` taxonomy check reads. */
export interface ProbeComponent {
  commands?: Record<string, string | { unavailable: true }>;
}
export interface ProbeProfile {
  components?: ProbeComponent[];
}

/** `isTestPath`'s language axis is deliberately wider than `Instance["language"]`
 * (currently `"ts" | "python"` only, per Task 1): the per-language matcher is written to
 * cover the Multi-SWE-bench language set (go/java/rust) the pilot rig will grow into in a
 * later phase, per design §10. */
export type TestLang = Instance["language"] | "js" | "go" | "java" | "rust";

/** The per-instance context `collect` needs but can't recover from the NDJSON/diff alone:
 * the corpus language (drives the per-language `isTestPath` matcher) and whether styre
 * actually opened a PR (drives the `self_test_passed` approximation). */
export interface CollectCtx {
  language: TestLang;
  pr_opened: boolean;
}

/** The subset of styre's `summary` telemetry event (`src/telemetry/events.ts` /
 * `SummaryEvent`) this module reads. NOTE: styre's summary schema carries NO `parked`
 * field — `outcome` is the union `"pr-ready" | "done" | "blocked" | "no-progress" |
 * "parked"` (`src/daemon/run-ticket.ts`); `parked` on `TaskRecord` is derived from
 * `outcome === "parked"`, not read off the wire. */
interface SummaryEventLike {
  type: "summary";
  outcome: string;
  status: string;
  ticks: number;
  cost_usd: number;
  tokens_in: number;
  tokens_out: number;
  cycle_count: number;
  escalation_count: number;
  escalation_reasons: string[];
}

function isSummaryEvent(v: unknown): v is SummaryEventLike {
  return typeof v === "object" && v !== null && (v as { type?: unknown }).type === "summary";
}

/** PURE. Parses styre's NDJSON stdout and returns the LAST `type==="summary"` event (styre
 * emits at most one per run, but this is robust to a resumed/replayed stream carrying more
 * than one). Lines that aren't valid JSON (stray output mixed into the stream) are skipped
 * rather than throwing — a malformed non-summary line must not crash collection. */
function parseLastSummary(ndjson: string): SummaryEventLike | undefined {
  let last: SummaryEventLike | undefined;
  for (const line of ndjson.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (isSummaryEvent(parsed)) last = parsed;
  }
  return last;
}

/** PURE. Splits a unified diff into one block per `diff --git a/X b/Y` file header (the
 * form `git diff`/GitHub PR diffs emit). A diff with no `diff --git` header at all is
 * returned as a single block — `extractStrippedDiff` then falls back to whole-diff
 * path-scanning via `touchedPaths`. */
function splitDiffBlocks(patch: string): string[] {
  const lines = patch.split("\n");
  const blocks: string[] = [];
  let current: string[] = [];
  for (const line of lines) {
    if (line.startsWith("diff --git ") && current.length > 0) {
      blocks.push(current.join("\n"));
      current = [];
    }
    current.push(line);
  }
  if (current.length > 0) blocks.push(current.join("\n"));
  return blocks;
}

const PLAN_DOC_PREFIX = "docs/plans/";

/** PURE. Strips any file-diff block touching a `docs/plans/` path — styre always commits
 * its own plan doc alongside the code change (build-operations layout), and that plan doc
 * must never count as scope or as a self-authored test. Reused by the Task-6 web-off probe
 * (which stubs its diff-read) and by Task 11's collect/score wiring. */
export function extractStrippedDiff(prDiff: string): string {
  const blocks = splitDiffBlocks(prDiff);
  const kept = blocks.filter((block) => {
    const paths = touchedPaths(block);
    return !paths.some((p) => p.startsWith(PLAN_DOC_PREFIX));
  });
  return kept.join("\n");
}

/** PURE. Per-language test-file path matcher. Extension-anchored on purpose: a directory
 * convention like "lives under a `tests/` dir" only counts for a language if the file also
 * carries that language's extension — otherwise a TS test fixture that happens to sit in a
 * `tests/` directory would count as a "python test" merely by directory name, defeating the
 * point of a PER-LANGUAGE matcher. */
export function isTestPath(path: string, lang: TestLang): boolean {
  const base = path.split("/").pop() ?? path;
  switch (lang) {
    case "python":
      return /^test_.*\.py$/.test(base) || /(^|\/)tests\/.*\.py$/.test(path);
    case "ts":
    case "js":
      return (
        /\.(test|spec)\.(ts|tsx|js)$/.test(base) || /(^|\/)__tests__\/.*\.(ts|tsx|js)$/.test(path)
      );
    case "go":
      return /_test\.go$/.test(base);
    case "java":
      return /(^|\/)src\/test\/java\/.*\.java$/.test(path);
    case "rust":
      return /(^|\/)tests\/.*\.rs$/.test(path);
    default:
      return false;
  }
}

function isUnrunnableTestCommand(component: ProbeComponent | undefined): boolean {
  if (!component) return true; // no components at all -> nothing is runnable
  const test = component.commands?.test;
  if (test === undefined) return true;
  if (typeof test === "object" && test !== null && "unavailable" in test) return true;
  return false;
}

/** PURE. `probe` taxonomy check: true iff the setup profile's sole/first component has no
 * runnable `commands.test` (absent, or the `{unavailable: true}` sentinel `styre setup`
 * writes for a detected-but-unrunnable toolchain — the §4-anticipated Python case). */
function isProbeProfile(profile: ProbeProfile): boolean {
  return isUnrunnableTestCommand(profile.components?.[0]);
}

/** PURE. Derives `taxonomy` from `outcome` — NEVER the process exit code (design §9a: exit
 * codes lie, e.g. `blocked`/`no-progress` both exit 1 but still emit a `summary` first).
 * Checked in this order: `parked` (outcome==="parked", which styre only reaches via the
 * exit-75 park path) > `loop-exhausted` (outcome ∈ {blocked, no-progress}) > `probe` (the
 * setup profile can't run any test at all — an environment failure, not a run failure) >
 * pending (`undefined` — Task 11 resolves this to `resolved`/`opened-but-unresolved` from
 * the score). */
function deriveTaxonomy(outcome: string | undefined, profile: ProbeProfile): string | undefined {
  if (outcome === "parked") return "parked";
  if (outcome === "blocked" || outcome === "no-progress") return "loop-exhausted";
  if (isProbeProfile(profile)) return "probe";
  return undefined;
}

/**
 * PURE. Parses styre's NDJSON stdout into a `TaskRecord` fragment, derives the failure
 * taxonomy, and extracts/strips the PR diff for downstream scoring/review.
 *
 * `self_test_passed` is a documented APPROXIMATION ("passed under styre's own verify"): styre
 * only opens a PR when its own verify step — which runs the test it just wrote — is green, so
 * `self_authored_test && pr_opened` stands in for a rigorous per-test check until the pipeline
 * wires `scorer.run_self_test` (Task 11). `null` when no self-authored test exists at all (the
 * approximation doesn't apply, so it must not silently read as `false`).
 */
export function collect(
  ndjson: string,
  prDiff: string,
  profile: ProbeProfile,
  ctx: CollectCtx,
): Partial<TaskRecord> {
  const summary = parseLastSummary(ndjson);
  const strippedDiff = extractStrippedDiff(prDiff);
  const touched = touchedPaths(strippedDiff);
  const self_authored_test = touched.some((p) => isTestPath(p, ctx.language));
  const self_test_passed = self_authored_test ? ctx.pr_opened : null;

  const result: Partial<TaskRecord> = { self_authored_test, self_test_passed };

  const taxonomy = deriveTaxonomy(summary?.outcome, profile);
  if (taxonomy !== undefined) result.taxonomy = taxonomy;

  if (summary) {
    result.ticks = summary.ticks;
    result.cycle_count = summary.cycle_count;
    result.escalation_count = summary.escalation_count;
    result.escalation_reasons = summary.escalation_reasons;
    result.outcome = summary.outcome;
    result.status = summary.status;
    result.cost_usd = summary.cost_usd;
    result.tokens_in = summary.tokens_in;
    result.tokens_out = summary.tokens_out;
    result.parked = summary.outcome === "parked";
  }

  return result;
}
