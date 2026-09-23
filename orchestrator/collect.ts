import { z } from "zod";
import { addedPaths, touchedPaths } from "./firewall";
import type { Instance, TaskRecord } from "./types";

/** Minimal shape of styre's `profile.json` this module needs — NOT the full styre
 * `ProfileSchema` (the rig is black-box against styre: it consumes the CLI + NDJSON,
 * never imports styre source, per the design doc's "black-box styre" invariant). Mirrors
 * component roles and test declarations; declarations cannot establish execution or setup failure. */
const ProbeProfileSchema = z.object({
  components: z
    .array(
      z.object({
        name: z.string().optional(),
        role: z.enum(["primary", "fixture", "example", "vendored"]).optional(),
        commands: z
          .record(z.union([z.string(), z.object({ unavailable: z.literal(true) })]))
          .optional(),
        testAction: z
          .object({ framework: z.string().min(1), launcher: z.string().min(1) })
          .optional(),
      }),
    )
    .optional(),
});
export type ProbeProfile = z.infer<typeof ProbeProfileSchema>;
export type ProbeComponent = NonNullable<ProbeProfile["components"]>[number];
export function parseProbeProfile(input: unknown): ProbeProfile {
  return ProbeProfileSchema.parse(input);
}

/** A declared launcher is configuration evidence, not proof that the tests executed. */
export function testConfiguration(
  profile: ProbeProfile,
): NonNullable<TaskRecord["test_configuration"]> {
  const components = (profile.components ?? []).flatMap((c, i) =>
    (c.role === undefined || c.role === "primary") &&
    (c.testAction?.launcher.trim() ||
      (typeof c.commands?.test === "string" && c.commands.test.trim()))
      ? [c.name ?? `component-${i}`]
      : [],
  );
  return { status: components.length ? "declared" : "none", components };
}

/** `isTestPath`'s language axis is deliberately wider than `Instance["language"]`
 * (currently `"ts" | "python"` only, per Task 1): the per-language matcher is written to
 * cover the Multi-SWE-bench language set (go/java/rust) the pilot rig will grow into in a
 * later phase, per design §10. */
export type TestLang = Instance["language"] | "js" | "go" | "java" | "rust";

/** The per-instance context `collect` needs but can't recover from the NDJSON/diff alone:
 * the corpus language (drives the per-language `isTestPath` matcher) and whether styre
 * actually opened a PR (retained for collector callers). */
export interface CollectCtx {
  language: TestLang;
  /** Tri-state forge result; never used as proof of test execution. */
  pr_opened: boolean | null;
}

/** The subset of styre's `summary` telemetry event (`src/telemetry/events.ts` /
 * `SummaryEvent`) this module reads. NOTE: styre's summary schema carries NO `parked`
 * field — `outcome` is the union `"pr-ready" | "done" | "paused" | "abandoned"`
 * (`src/daemon/run-ticket.ts` `RunOutcome`), with `reason` (`"budget" | "needs_you" |
 * "interrupted"`, `PauseReason`) set iff `outcome === "paused"`. `parked` on `TaskRecord`
 * is derived from `outcome === "paused"`, not read off the wire.
 *
 * `reason` is typed `string`, not the `PauseReason` union: it arrives off the wire from a
 * separately-versioned binary, so an unmodelled value must be handled at runtime (it maps
 * to `infra`) rather than assumed away by the type. */
const SummarySchema = z.object({
  type: z.literal("summary"),
  outcome: z.string().min(1),
  reason: z.string().optional(),
  // Optional: older styre builds omit it. `merge` + needs_you marks an undelivered PR.
  stage: z.string().optional(),
  status: z.string(),
  ticks: z.number().int().nonnegative(),
  cycle_count: z.number().int().nonnegative(),
  escalation_count: z.number().int().nonnegative(),
  escalation_reasons: z.array(z.string()),
});

/** Last summary is authoritative; a malformed last one cannot revive an older success. */
function parseLastSummary(ndjson: string): z.infer<typeof SummarySchema> | undefined {
  let last: unknown;
  for (const line of ndjson.split("\n")) {
    if (!line.trim()) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      !("type" in parsed) ||
      parsed.type !== "summary"
    )
      continue;
    last = parsed;
  }
  return last === undefined ? undefined : SummarySchema.parse(last);
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
  const joined = kept.join("\n");
  // A patch MUST end with a newline. `git apply` and `patch` both reject one that does not:
  //   patch: **** malformed patch at line 125
  //   patch unexpectedly ends in middle of line
  //
  // `splitDiffBlocks` splits on "\n", so a diff that ends with a newline yields a trailing
  // EMPTY element, and that element lands in the LAST block. When the last block is the one
  // stripped here — which is the normal case, because styre commits its `docs/plans/` doc last —
  // the trailing newline leaves with it and the result is unterminated.
  //
  // This stayed invisible while candidate diffs were already failing to apply for an unrelated
  // reason (the image's environment hunk, fixed by the run-start baseline). It surfaced on the
  // first diff that was otherwise clean, and cost a $6.64 run's verdict.
  if (joined.length === 0) return "";
  return joined.endsWith("\n") ? joined : `${joined}\n`;
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
      // pytest's default discovery matches BOTH test_*.py and *_test.py. conftest.py and
      // __init__.py are pytest support files, never a self-authored test, even though
      // they commonly live under a tests/ dir (which the directory-convention match
      // below would otherwise false-positive on).
      if (base === "conftest.py" || base === "__init__.py") return false;
      return (
        /^test_.*\.py$/.test(base) || /_test\.py$/.test(base) || /(^|\/)tests\/.*\.py$/.test(path)
      );
    case "ts":
    case "js":
      // Includes the mocha `test/` directory convention (common in Multi-SWE-bench JS
      // corpora) alongside the jest/vitest `.test.`/`.spec.`/`__tests__` conventions.
      return (
        /\.(test|spec)\.(ts|tsx|js)$/.test(base) ||
        /(^|\/)__tests__\/.*\.(ts|tsx|js)$/.test(path) ||
        /(^|\/)test\/.*\.(ts|tsx|js)$/.test(path)
      );
    case "go":
      return /_test\.go$/.test(base);
    case "java":
      return /(^|\/)src\/test\/java\/.*\.java$/.test(path);
    case "rust":
      // TODO(phase-2 rust): also detect #[cfg(test)]-bearing files (inline unit tests) —
      // isTestPath currently only matches tests/*.rs (brief spec gap; rust not in the
      // TS+Python pilot).
      return /(^|\/)tests\/.*\.rs$/.test(path);
    default:
      return false;
  }
}

/** Workflow outcome is independent of command declarations. Only SETUP_FAILED_EXIT in
 * defaultCollectStage establishes a setup failure (`probe`); profile contents cannot. */
function deriveTaxonomy(
  outcome: string,
  reason: string | undefined,
  stage: string | undefined,
): string | undefined {
  if (outcome === "paused" && reason === "budget") return "parked";
  // Styre reaches `merge` only after review passed, and pauses there only when the PR it built was
  // not delivered (forge rejection or exhausted retries): finished work, failed delivery.
  if (outcome === "paused" && reason === "needs_you" && stage === "merge") return "pr-undelivered";
  if (outcome === "paused" && reason === "needs_you") return "loop-exhausted";
  if (outcome === "abandoned") return "loop-exhausted";
  if (outcome === "pr-ready" || outcome === "done") return undefined;
  return "infra";
}

/**
 * PURE. Parses styre's NDJSON stdout into a `TaskRecord` fragment, derives the failure
 * taxonomy, and extracts/strips the PR diff for downstream scoring/review.
 *
 * `self_authored_test` is computed from ADDED test paths only (`addedPaths`, not
 * `touchedPaths`) — reconciled with `scorer.run_self_test` (Task 3), which keys on
 * newly-added test paths. A diff that only MODIFIES an existing test file does not count:
 * it isn't a test styre authored, and counting it would both inflate the headline
 * self-authored-test rate and misrepresent the separate per-test runner's scope.
 *
 * `self_test_passed` stays null here. Only the separate self-test scorer can establish
 * a verdict; neither a declared launcher nor an opened PR proves execution.
 *
 * `taxonomy: "infra"` is set whenever `parseLastSummary` finds no VALID summary event at
 * all — either styre hard-crashed before emitting one, or the only `summary`-typed line
 * was absent. A malformed final summary throws instead of falling back to an earlier one. Per design §9a, a
 * summary-less crash is infra, not a pending/unscored record: returning a fragment with no
 * `outcome`/`taxonomy` would let a later stage mis-score it as something else. This check
 * short-circuits before `deriveTaxonomy` runs, since `deriveTaxonomy` needs a real
 * `outcome` string to work from.
 */
export function collect(
  ndjson: string,
  prDiff: string,
  profile: ProbeProfile,
  ctx: CollectCtx,
): Partial<TaskRecord> {
  const summary = parseLastSummary(ndjson);
  const strippedDiff = extractStrippedDiff(prDiff);
  const added = addedPaths(strippedDiff);
  const self_authored_test = added.some((p) => isTestPath(p, ctx.language));
  const self_test_passed = null; // PR existence cannot establish that an individual test passed.

  const result: Partial<TaskRecord> = {
    self_authored_test,
    self_test_passed,
    test_configuration: testConfiguration(parseProbeProfile(profile)),
  };

  if (!summary) {
    // No summary at all: styre made no claim about a PR either way. `null`, not `false` —
    // "it did not say" is not "it said no", and only the former should stay out of the
    // disagreement check in `report/render.ts`.
    result.pr_self_reported = null;
    result.taxonomy = "infra";
    return result;
  }

  const taxonomy = deriveTaxonomy(summary.outcome, summary.reason, summary.stage);
  if (taxonomy !== undefined) result.taxonomy = taxonomy;

  result.ticks = summary.ticks;
  result.cycle_count = summary.cycle_count;
  result.escalation_count = summary.escalation_count;
  result.escalation_reasons = summary.escalation_reasons;
  result.outcome = summary.outcome;
  result.status = summary.status;
  // styre's OWN claim that it opened a PR: the two terminal outcomes that imply one
  // (`deriveTaxonomy` treats exactly this pair as "ran to completion"). Compared against the
  // forge read in `report/render.ts` — see `TaskRecord.pr_self_reported`.
  result.pr_self_reported = summary.outcome === "pr-ready" || summary.outcome === "done";
  // Cost/tokens are deliberately NOT taken from the summary (ENG-390): the container's
  // `claude` wrapper hands styre plain text, so `summary.cost_usd`/`tokens_*` are null for
  // every dispatch. `defaultCollectStage` measures them from the teed transcript instead.
  result.parked = summary.outcome === "paused";

  return result;
}
