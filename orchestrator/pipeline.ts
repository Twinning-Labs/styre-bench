import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { $ } from "bun";
import { Octokit } from "octokit";
import type { BENCH_CONFIG } from "../config/bench.config";
import { renderReport } from "../report/render";
import type { RenderReportResult, ReportMeta } from "../report/render";
import type { AbPreference } from "../reviewer/ab-review";
import { abReview } from "../reviewer/ab-review";
import { blindQuality } from "../reviewer/blind-quality";
import { buildStyre } from "./build-styre";
import type { BuildStyreConfig, BuildStyreResult, StyreBinaries } from "./build-styre";
import { cleanup as tearDown } from "./cleanup";
import { collect as collectPure, extractStrippedDiff } from "./collect";
import type { CollectCtx, ProbeProfile } from "./collect";
import type { Family } from "./corpus";
import { loadInstances } from "./corpus";
import { addedPaths } from "./firewall";
import { selectPilot, selectSmoke, tagCutoff } from "./matrix";
import { archFromPlatform, bunLinuxTarget } from "./platform";
import { runStyre } from "./run-task";
import type { RunSeed, RunStyreResult } from "./run-task";
import { seedGithub } from "./seed-github";
import { seedLinear } from "./seed-linear";
import type { Instance, TaskRecord } from "./types";

/** The subset of `BENCH_CONFIG` (plus a few sibling fields the pipeline reads) every stage
 *  here needs — kept as `typeof BENCH_CONFIG` (type-only import, matches `corpus.ts`'s own
 *  convention) rather than a hand-duplicated interface, so a config field rename/addition in
 *  Task 1 is caught by the type checker here too. */
export type PipelineConfig = typeof BENCH_CONFIG;

// ---------------------------------------------------------------------------------------
// Scorer subprocess client (JSON-stdio, per scorer/score.py's / scorer/leak_detect.py's own
// transport contract: a single JSON object on stdin, a single JSON object on stdout, a
// non-zero exit / an `{"error": ...}` payload on ANY failure — a TRANSPORT failure to this
// caller, never a silent false/None result).
// ---------------------------------------------------------------------------------------

const SCORER_SCRIPT = new URL("../scorer/score.py", import.meta.url).pathname;
const LEAK_DETECT_SCRIPT = new URL("../scorer/leak_detect.py", import.meta.url).pathname;

/**
 * Interpreter for the scorer subprocess. The scorer's deps (swebench / multi-swe-bench) are
 * installed in the repo's `.venv` (system python3 is PEP-668 externally-managed), so bare
 * `python3` dies with ModuleNotFoundError → run_controls "unparseable stdout" → every instance
 * infra-fails. Prefer `.venv/bin/python`; allow an explicit `BENCH_PYTHON` override; fall back
 * to `python3` only when no venv exists.
 */
const VENV_PYTHON = new URL("../.venv/bin/python", import.meta.url).pathname;

/** Pure resolver (testable): BENCH_PYTHON override > repo `.venv/bin/python` > bare `python3`. */
export function resolvePythonBin(
  env: Record<string, string | undefined> = process.env,
  venvPath: string = VENV_PYTHON,
  exists: (p: string) => boolean = existsSync,
): string {
  if (env.BENCH_PYTHON) return env.BENCH_PYTHON;
  return exists(venvPath) ? venvPath : "python3";
}

const PYTHON_BIN = resolvePythonBin();

export interface RunControlsResult {
  gold_resolved: boolean;
  base_fails: boolean;
  deterministic: boolean;
}
export interface ScoreResult {
  resolved: boolean;
  fail_to_pass: Record<string, boolean>;
  pass_to_pass: Record<string, boolean>;
}
export interface SelfTestResult {
  passed: boolean | null;
}
export interface LeakResult {
  suspected: boolean;
  reasons: string[];
}

/** Shells out to a python JSON-stdio script (`scorer/score.py <command>` or
 *  `scorer/leak_detect.py`) and parses its single-line JSON response. Throws (never returns
 *  a coerced default) on a non-zero exit, an `{"error": ...}` payload, or unparseable stdout
 *  — matching the python side's own fail-closed transport contract (see `scorer/score.py`'s
 *  and `scorer/leak_detect.py`'s module docstrings: "a TRANSPORT failure to the TS caller
 *  (re-dispatch/investigate), never a silent false/None result"). Callers that have a
 *  documented null-on-transport-error fallback (only `run_self_test`, per the Task-11 brief)
 *  catch this at the call site — this function itself never manufactures a fallback value. */
async function spawnPythonJson<T>(argv: string[], payload: unknown): Promise<T> {
  const proc = Bun.spawn(argv, { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  proc.stdin.write(JSON.stringify(payload));
  await proc.stdin.end();
  const [stdoutText, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);

  let parsed: unknown;
  try {
    parsed = JSON.parse(stdoutText);
  } catch {
    throw new Error(
      `pipeline: ${argv.join(" ")} produced unparseable stdout (exit ${exitCode}): ${stdoutText.slice(0, 500)}`,
    );
  }
  const hasError = typeof parsed === "object" && parsed !== null && "error" in parsed;
  if (exitCode !== 0 || hasError) {
    const detail = hasError
      ? String((parsed as { error: unknown }).error)
      : `exit code ${exitCode}`;
    throw new Error(`pipeline: ${argv.join(" ")} failed: ${detail}`);
  }
  return parsed as T;
}

async function callRunControls(inst: Instance): Promise<RunControlsResult> {
  return spawnPythonJson<RunControlsResult>([PYTHON_BIN, SCORER_SCRIPT, "run_controls"], {
    instance: inst,
  });
}
async function callScore(inst: Instance, candidateDiff: string): Promise<ScoreResult> {
  return spawnPythonJson<ScoreResult>([PYTHON_BIN, SCORER_SCRIPT, "score"], {
    instance: inst,
    candidate_diff: candidateDiff,
  });
}
async function callRunSelfTest(
  inst: Instance,
  candidateDiff: string,
  addedTestPaths: string[],
): Promise<SelfTestResult> {
  return spawnPythonJson<SelfTestResult>([PYTHON_BIN, SCORER_SCRIPT, "run_self_test"], {
    instance: inst,
    candidate_diff: candidateDiff,
    added_test_paths: addedTestPaths,
  });
}
async function callDetectLeak(
  candidateDiff: string,
  fixPatch: string,
  transcript: string,
): Promise<LeakResult> {
  return spawnPythonJson<LeakResult>([PYTHON_BIN, LEAK_DETECT_SCRIPT], {
    candidate_diff: candidateDiff,
    fix_patch: fixPatch,
    transcript,
  });
}

// ---------------------------------------------------------------------------------------
// collect stage: reads the run's on-disk artifacts, computes the BARE TREE DIFF (Global
// Constraint — git diff, never a commit-message-bearing source), and calls the pure
// collect() (Task 7) over it.
// ---------------------------------------------------------------------------------------

export interface CollectStageResult {
  /** Fragment from the pure `collect()` (Task 7) — `self_authored_test`/`self_test_passed`
   *  (approximation)/`ticks`/`outcome`/... /`taxonomy` (only set for parked/probe/
   *  loop-exhausted/infra; `undefined` = "pending", resolved by `runInstance` from the
   *  oracle score). */
  record: Partial<TaskRecord>;
  /** The bare-tree PR diff (`docs/plans/` already stripped via `extractStrippedDiff`) —
   *  fed to `score`/`run_self_test`/`detect_leak`/`blindQuality`/`abReview`. NEVER a source
   *  that carries commit messages/`Co-Authored-By`/`Claude-Session` trailers (Global
   *  Constraint, Task-9 crux): a `git diff <base>..<head>` (or an equivalent PR "files
   *  changed" diff) structurally cannot contain that — it lists file hunks only, never log
   *  history — unlike `git log`/a squash-merge commit body, which does. */
  diff: string;
  /** Paths ADDED by `diff` that match the per-language test-path matcher (`addedPaths` +
   *  `isTestPath`, Task 7) — the set `run_self_test` (Task 3) runs. */
  addedTestPaths: string[];
  /** The `claude` wrapper's teed stream-json transcript (Task 6) — leak-detect's URL-scan
   *  source. Empty string if unavailable (not `null`) — matches `detect_leak`'s own
   *  "transcript-unavailable" handling of falsy input. */
  transcript: string;
  /** Whether styre actually opened a PR (determined by the same PR lookup that produced
   *  `diff` — see `fetchPrDiff` below), independent of `record.self_test_passed`'s
   *  approximation. */
  pr_opened: boolean;
}

function parseOwnerRepoFromUrl(repoUrl: string): { owner: string; repo: string } {
  const match = repoUrl.match(/github\.com[/:]([^/]+)\/([^/.]+?)(?:\.git)?\/?$/);
  if (!match || !match[1] || !match[2]) {
    throw new Error(`pipeline: could not parse owner/repo from repoUrl "${repoUrl}"`);
  }
  return { owner: match[1], repo: match[2] };
}

/**
 * Finds the (by convention, at most one) PR styre opened against `seed.defaultBranch` on the
 * seeded throwaway repo, and computes the BARE TREE DIFF between `inst.base_commit` and the
 * PR's head sha via `git diff <base>..<head>` — never `git log`/a formatted-patch source, so
 * the result structurally cannot carry a commit message or a `Co-Authored-By`/
 * `Claude-Session` trailer (Global Constraint, Task-9 crux).
 *
 * KNOWN-BROKEN-UNTIL-LIVE (no live container/PR was exercised in this session — matching
 * `run-task.ts`'s/`seed-github.ts`'s own KNOWN-BROKEN-UNTIL-LIVE notes on unverified live
 * assumptions): the exact PR shape styre's own github tool produces (feature-branch name;
 * whether it targets `seed.defaultBranch` directly) is unverified against a real run — this
 * reads the MOST RECENT PR (open or closed) with base `seed.defaultBranch`, the natural
 * reading of styre's CL-COMMIT ownership model (CLAUDE.md: "the runner holds creds and
 * commits"), but not yet confirmed live. `runInstance`'s default `collect` dep only calls
 * this when `GITHUB_TOKEN` is set; any failure (network, no PR found, git error) degrades to
 * `{ diff: "", pr_opened: false }` rather than crashing `collect` — this stage's caller
 * (`attemptOnce`) MUST still treat a genuinely no-summary run as `taxonomy: "infra"` via
 * `collectPure` itself, so a diff-lookup failure never masquerades as a false "resolved".
 */
async function fetchPrDiff(
  inst: Instance,
  seed: RunSeed,
  githubToken: string,
): Promise<{ diff: string; pr_opened: boolean }> {
  const { owner, repo } = parseOwnerRepoFromUrl(seed.repoUrl);
  const octokit = new Octokit({ auth: githubToken });
  const prs = await octokit.rest.pulls.list({
    owner,
    repo,
    state: "all",
    base: seed.defaultBranch,
    sort: "created",
    direction: "desc",
    per_page: 1,
  });
  const pr = prs.data[0];
  if (!pr) return { diff: "", pr_opened: false };

  const headSha = pr.head.sha;
  const scratch = await mkdtemp(path.join(tmpdir(), "styre-bench-pipeline-diff-"));
  try {
    await $`git clone --quiet ${seed.repoUrl} ${scratch}`.quiet();
    await $`git -C ${scratch} fetch --quiet origin ${inst.base_commit} ${headSha}`
      .quiet()
      .nothrow();
    // Two-dot (`base..head`), per the Global Constraint (docs/plans/2026-07-02-styre-bench-pilot-rig.md
    // Task-9 crux) — the unambiguous "changes styre made" diff. Three-dot (`base...head`, the
    // merge-base diff) happens to equal this ONLY because `base` is an ancestor of `head` here;
    // that's fragile (rebases/force-pushes on the throwaway branch could break the equivalence),
    // so use the literal two-dot form rather than relying on the coincidence.
    const diff = await $`git -C ${scratch} diff ${inst.base_commit}..${headSha}`.quiet().text();
    return { diff, pr_opened: true };
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

async function defaultCollectStage(
  inst: Instance,
  seed: RunSeed,
  result: RunStyreResult,
): Promise<CollectStageResult> {
  const [ndjson, profileText, transcript] = await Promise.all([
    readFile(result.ndjsonPath, "utf8").catch(() => ""),
    readFile(result.profilePath, "utf8").catch(() => "{}"),
    readFile(result.transcriptPath, "utf8").catch(() => ""),
  ]);
  let profile: ProbeProfile;
  try {
    profile = JSON.parse(profileText || "{}") as ProbeProfile;
  } catch {
    profile = {};
  }

  const githubToken = process.env.GITHUB_TOKEN ?? "";
  const { diff: rawDiff, pr_opened } = githubToken
    ? await fetchPrDiff(inst, seed, githubToken).catch(() => ({ diff: "", pr_opened: false }))
    : { diff: "", pr_opened: false };

  const ctx: CollectCtx = { language: inst.language, pr_opened };
  const record = collectPure(ndjson, rawDiff, profile, ctx);
  const strippedDiff = extractStrippedDiff(rawDiff);
  const addedTestPaths = addedPaths(strippedDiff);

  return { record, diff: strippedDiff, addedTestPaths, transcript, pr_opened };
}

// ---------------------------------------------------------------------------------------
// runInstance: the per-task pipeline (design §6).
// ---------------------------------------------------------------------------------------

export interface PipelineDeps {
  runControls: (inst: Instance) => Promise<RunControlsResult>;
  seed: (inst: Instance, cfg: PipelineConfig) => Promise<RunSeed>;
  run: (
    inst: Instance,
    seed: RunSeed,
    binaryPath: string,
    cfg: PipelineConfig,
  ) => Promise<RunStyreResult>;
  collect: (inst: Instance, seed: RunSeed, result: RunStyreResult) => Promise<CollectStageResult>;
  score: (inst: Instance, diff: string) => Promise<ScoreResult>;
  runSelfTest: (inst: Instance, diff: string, addedTestPaths: string[]) => Promise<SelfTestResult>;
  detectLeak: (diff: string, fixPatch: string, transcript: string) => Promise<LeakResult>;
  blindQuality: (issue: string, diff: string) => Promise<{ verdict: string; notes: string }>;
  abReview: (
    issue: string,
    diff: string,
    fixPatch: string,
    instanceId: string,
    seed: number,
  ) => Promise<{ preference: AbPreference; notes: string }>;
  /** Called once per attempt that got past `seed` (i.e. a `RunSeed` exists to tear down) —
   *  see `attemptOnce`. NOT called when `seed` itself throws (nothing was created). */
  cleanup: (ctx: { seed: RunSeed; failed: boolean }) => Promise<void>;
}

async function defaultSeedStage(inst: Instance, cfg: PipelineConfig): Promise<RunSeed> {
  const gh = await seedGithub(inst, { benchGithubOrg: cfg.benchGithubOrg });
  const li = await seedLinear(inst, { linearProjectId: cfg.linearProjectId });
  return { ...gh, ident: li.ident };
}

async function defaultRunStage(
  inst: Instance,
  seed: RunSeed,
  binaryPath: string,
  cfg: PipelineConfig,
): Promise<RunStyreResult> {
  // Thread cfg.cohort through so `run-task.ts`'s `claude` wrapper (LAYER 2 of the web-off
  // guarantee) knows whether to append --disallowedTools — see build-styre.ts's
  // applyWebOffPatch doc for the two-layer explanation. `repoDirInImage` is per-instance
  // (SWE-bench /testbed vs MSB /home/<repo>) — see Instance.repoDirInImage; run-task defaults
  // an unset value to /testbed.
  return runStyre(inst, seed, binaryPath, {
    cohort: cfg.cohort,
    repoDirInImage: inst.repoDirInImage,
  });
}

/** Selects the styre binary matching an instance's container platform (its `--platform`,
 *  defaulting to linux/amd64 when a fixture leaves it unset). Throws — rather than silently
 *  mounting a wrong-OS/arch binary that dies inside the container with "Cannot run macOS
 *  executable" / "Exec format error" — if `buildStyre` produced no binary for that platform. */
function resolveBinary(binaries: StyreBinaries, inst: Instance): string {
  const platform = inst.platform ?? "linux/amd64";
  const binaryPath = binaries[platform];
  if (!binaryPath) {
    throw new Error(
      `pipeline: no styre binary was built for platform "${platform}" (instance ${inst.id}); ` +
        `built platforms: [${Object.keys(binaries).join(", ") || "none"}]`,
    );
  }
  return binaryPath;
}

/** Builds the production `PipelineDeps` — the only place `cfg.retainOnFailure`-equivalent
 *  wiring happens for `cleanup` (see `RunInstanceOpts.retainOnFailure`; not a `BENCH_CONFIG`
 *  field, matching this codebase's Deps/Opts convention — e.g. `BuildStyreOpts`,
 *  `RunStyreOpts` — of keeping test/debug knobs out of the shared config schema). */
function buildDefaultDeps(retainOnFailure: boolean): PipelineDeps {
  return {
    runControls: callRunControls,
    seed: defaultSeedStage,
    run: (inst, seed, binaryPath, cfg) => defaultRunStage(inst, seed, binaryPath, cfg),
    collect: defaultCollectStage,
    score: callScore,
    runSelfTest: callRunSelfTest,
    detectLeak: callDetectLeak,
    blindQuality: (issue, diff) => blindQuality(issue, diff),
    abReview: (issue, diff, fixPatch, instanceId, seed) =>
      abReview(issue, diff, fixPatch, instanceId, seed),
    cleanup: (ctx) => tearDown(ctx, { retainOnFailure }),
  };
}

const DEFAULT_MAX_INFRA_RETRIES = 2;

/**
 * Fixed per-instance estimate for the mandatory `styre setup` Opus call, which emits NO
 * `summary`/cost telemetry of its own (`run-task.ts`'s entrypoint step 5 — a bare CLI
 * invocation, not a `styre run` that produces a `summary` event). `perTaskCostCapUsd`
 * enforcement below adds this on top of each attempt's OWN measured `cost_usd` (from
 * `styre run`'s summary) — the cap covers the run cost AND this estimate, but this estimate
 * is never claimed to be a measured value (Task-11 brief note).
 */
const SETUP_COST_ESTIMATE_USD = 0.5;

function blankRecord(inst: Instance, cfg: PipelineConfig): TaskRecord {
  return {
    instance: inst.id,
    language: inst.language,
    difficulty: inst.difficulty,
    styre_commit: cfg.styreCommit,
    cohort: cfg.cohort,
    post_cutoff: tagCutoff(inst, cfg.modelCutoff),
    resolved: false,
    pr_opened: false,
    self_authored_test: null,
    self_test_passed: null,
    ticks: 0,
    cycle_count: 0,
    escalation_count: 0,
    escalation_reasons: [],
    outcome: "",
    status: "",
    exit_code: 0,
    parked: false,
    cost_usd: 0,
    tokens_in: 0,
    tokens_out: 0,
    blind_quality: null,
    ab_preference: null,
    ab_notes: null,
    suspected_leak: false,
    leak_reasons: [],
    taxonomy: "",
    infra_retries: 0,
  };
}

function infraStageFromError(err: unknown, where: string): CollectStageResult {
  const message = err instanceof Error ? err.message : String(err);
  return {
    record: { taxonomy: "infra", status: `pipeline-error(${where}): ${message}` },
    diff: "",
    addedTestPaths: [],
    transcript: "",
    pr_opened: false,
  };
}

/**
 * Runs ONE attempt of seed -> run -> collect for `inst`, NEVER throwing (every internal
 * failure is converted to a `taxonomy: "infra"` `CollectStageResult` fragment) — the
 * infra-retry loop in `runInstance` decides whether to retry purely from the returned
 * `stage.record.taxonomy`, never from a caught exception.
 *
 * `cleanup` (Task 11 contract: "always runs per started instance, try/finally") is called
 * iff `seed` succeeded — an attempt that never got a `RunSeed` created nothing to tear down
 * (see `cleanup.ts`'s `CleanupCtx` doc). A `cleanup` failure itself is swallowed (logged via
 * the thrown error's message being dropped here) rather than reclassifying an otherwise-
 * successful attempt as infra — a leaked throwaway repo/ticket is a separately-monitorable
 * resource leak, not a reason to discard a real result.
 */
async function attemptOnce(
  inst: Instance,
  binaries: StyreBinaries,
  cfg: PipelineConfig,
  deps: PipelineDeps,
): Promise<{ seed: RunSeed | undefined; stage: CollectStageResult }> {
  // Resolve the platform-matched binary up front. A missing binary is an infra failure for
  // THIS instance (classified like a seed failure) — never a crash of the whole pool.
  let binaryPath: string;
  try {
    binaryPath = resolveBinary(binaries, inst);
  } catch (err) {
    return { seed: undefined, stage: infraStageFromError(err, "seed") };
  }

  let seed: RunSeed;
  try {
    seed = await deps.seed(inst, cfg);
  } catch (err) {
    return { seed: undefined, stage: infraStageFromError(err, "seed") };
  }

  let attemptFailed = false;
  let stage: CollectStageResult;
  try {
    const runResult = await deps.run(inst, seed, binaryPath, cfg);
    stage = await deps.collect(inst, seed, runResult);
  } catch (err) {
    attemptFailed = true;
    stage = infraStageFromError(err, "run/collect");
  }

  try {
    await deps.cleanup({ seed, failed: attemptFailed || stage.record.taxonomy === "infra" });
  } catch {
    // See doc above: a cleanup failure must not crash the pipeline or mask the attempt's
    // own outcome.
  }

  return { seed, stage };
}

export interface RunInstanceOpts {
  deps?: Partial<PipelineDeps>;
  maxInfraRetries?: number;
  /** See `buildDefaultDeps` doc — a test/debug knob, not a `BENCH_CONFIG` field. */
  retainOnFailure?: boolean;
  /** SMOKE=2 Option-B oracle-bypass: skips `deps.runControls` (the fail-closed drop gate),
   *  `deps.score`, and `deps.runSelfTest` entirely — every one of those shells out to the
   *  Linux-x86_64-only swebench/multi-swe-bench oracle harness, so on macOS they either don't
   *  run or aren't trustworthy. `seed -> run -> collect` (with the normal infra-retry) still
   *  runs, and so do `detectLeak`/`blindQuality`/`abReview` (ANTHROPIC + diffs only, no
   *  oracle). A `collect`-emitted `probe`/`infra` taxonomy is still honored as-is — bypass
   *  never masks a genuine seed/run/collect failure. A successful bypass run's terminal
   *  record is `taxonomy: "unscored"`, `resolved: null` (see `runJudgmentStages` call site
   *  below). Lets the operator validate the whole pipeline minus the oracle on macOS. */
  bypassOracle?: boolean;
}

interface JudgmentStagesResult {
  suspectedLeak: boolean;
  leakReasons: string[];
  blindVerdict: string | null;
  abPreference: TaskRecord["ab_preference"];
  abNotes: string | null;
}

/**
 * Runs `detectLeak` -> `blindQuality` + `abReview`, each independently try/catch'd (Fix 1's
 * JUDGMENT-STAGE-CRASH CONTRACT — a crash in one never loses the others' signal). Shared by
 * BOTH the normal oracle-scored path and the SMOKE=2 bypass-oracle path below, since none of
 * these three stages need an oracle verdict to run (only ANTHROPIC + the bare-tree diff).
 */
async function runJudgmentStages(
  inst: Instance,
  stage: CollectStageResult,
  cfg: PipelineConfig,
  deps: PipelineDeps,
): Promise<JudgmentStagesResult> {
  const issue = inst.problem_statement;

  let suspectedLeak = false;
  let leakReasons: string[] = [];
  try {
    const leak = await deps.detectLeak(stage.diff, inst.fix_patch, stage.transcript);
    suspectedLeak = leak.suspected;
    leakReasons = leak.reasons;
  } catch {
    // See the doc on the equivalent inline try/catch this replaces (in `runInstance`, git
    // blame) — reuses the canonical "transcript-unavailable" `leak_reasons` value rather than
    // inventing a new taxonomy: a crashed detector means the scan did not complete.
    suspectedLeak = false;
    leakReasons = ["transcript-unavailable"];
  }

  let blindVerdict: string | null = null;
  try {
    const blind = await deps.blindQuality(issue, stage.diff);
    blindVerdict = blind.verdict;
  } catch {
    blindVerdict = null;
  }

  let abPreference: TaskRecord["ab_preference"] = null;
  let abNotes: string | null = null;
  try {
    const ab = await deps.abReview(issue, stage.diff, inst.fix_patch, inst.id, cfg.seed);
    abPreference = ab.preference;
    abNotes = ab.notes;
  } catch {
    // render.ts's `AB_EXCLUDED` already excludes `null` from every A/B denominator.
    abPreference = null;
    abNotes = null;
  }

  return { suspectedLeak, leakReasons, blindVerdict, abPreference, abNotes };
}

/**
 * The per-task pipeline (design §6), with every contract the earlier task reviews
 * established ENFORCED here:
 *
 * 1. FAIL-CLOSED DROP (Task-3 crux): `run_controls` FIRST. If
 *    `NOT (gold_resolved && base_fails && deterministic)`, drop the instance —
 *    `taxonomy: "dropped-flaky"`, `resolved: false`, and NONE of seed/run/collect/score are
 *    ever called (a corpus/harness the controls can't validate must never reach a score).
 * 2. seed -> run -> collect, wrapped in a whole-instance infra-retry loop: retried (capped at
 *    `maxInfraRetries`, default 2) ONLY when the attempt's `taxonomy === "infra"` — a quality
 *    outcome (e.g. `opened-but-unresolved`, `loop-exhausted`, `parked`) is a terminal result,
 *    never retried. Each attempt's `cost_usd` (+ the fixed `SETUP_COST_ESTIMATE_USD`) accrues
 *    against `cfg.perTaskCostCapUsd`; once that cap would be exceeded, retrying stops even if
 *    `maxInfraRetries` hasn't been reached yet (enforces `perTaskCostCapUsd`, per the brief).
 * 3. probe short-circuit: if the final attempt's `taxonomy === "probe"` (an unrunnable
 *    `styre setup` profile — Task 7), score/self-test/leak/review are all skipped; the record
 *    is returned as-is.
 * 4. Otherwise: `score` (oracle) -> `run_self_test` (only when `addedTestPaths` is non-empty;
 *    a TRANSPORT ERROR here is caught and recorded as `self_test_passed: null` — NEVER a
 *    crash, NEVER read as passed) -> `detect_leak` -> `blindQuality` + `abReview` (per-
 *    instance A/B order: `abReview(issue, diff, fixPatch, inst.id, cfg.seed)`, never
 *    `cfg.seed` alone — Global Constraint, Task-9 crux) -> the final `TaskRecord`.
 *    `taxonomy` resolves to `resolved`/`opened-but-unresolved` from the oracle score UNLESS
 *    `collect` already assigned a terminal taxonomy (`parked`/`loop-exhausted`), which is
 *    preserved as-is.
 *
 * JUDGMENT-STAGE-CRASH CONTRACT (Task-11 capstone reviews, Fix 1): `score()` is the ONLY
 * stage whose failure means "no trustworthy verdict exists" — it is called INSIDE the
 * infra-retry loop below, so a crash there is treated exactly like a seed/run/collect
 * failure (`taxonomy: "infra"`, retried against the same `maxInfraRetries`/
 * `perTaskCostCapUsd` budget). `run_self_test`/`detect_leak`/`blindQuality`/`abReview` run
 * strictly AFTER `score()` has already produced a `resolved` verdict for this attempt — each
 * is wrapped in its OWN try/catch, so a crash in any one of them degrades ONLY that signal
 * (`self_test_passed: null` / `suspected_leak: false` + `leak_reasons: ["transcript-
 * unavailable"]` / `blind_quality: null` / `ab_preference: null`) and NEVER discards the
 * `resolved` verdict, the diff, or the rest of the record.
 *
 * COST CONTRACT (Task-11 capstone reviews, Fix 2): the returned `cost_usd` is
 * `taskSpentUsd` — the SUM of every attempt's own `cost_usd` plus one
 * `SETUP_COST_ESTIMATE_USD` per attempt (including retried-and-discarded attempts), never
 * just the last attempt's cost alone. This is what `runPool`'s `runBudgetUsd` kill-switch
 * and the report's cost stats sum over, so it must reflect true cumulative spend.
 */
export async function runInstance(
  inst: Instance,
  binaries: StyreBinaries,
  cfg: PipelineConfig,
  opts: RunInstanceOpts = {},
): Promise<TaskRecord> {
  const deps: PipelineDeps = { ...buildDefaultDeps(opts.retainOnFailure ?? false), ...opts.deps };
  const maxInfraRetries = opts.maxInfraRetries ?? DEFAULT_MAX_INFRA_RETRIES;
  const bypassOracle = opts.bypassOracle ?? false;
  const base = blankRecord(inst, cfg);

  // SMOKE=2 Option-B: `runControls` shells out to the Linux-only oracle harness too — skip
  // the fail-closed drop gate entirely rather than call it against a harness that can't run.
  if (!bypassOracle) {
    const controls = await deps.runControls(inst);
    if (!(controls.gold_resolved && controls.base_fails && controls.deterministic)) {
      return { ...base, taxonomy: "dropped-flaky" };
    }
  }

  let infraRetries = 0;
  let taskSpentUsd = 0;
  let stage: CollectStageResult = infraStageFromError(
    new Error("runInstance: internal error — the attempt loop never ran"),
    "internal",
  );
  // Set inside the loop, in the SAME iteration that leaves `stage.record.taxonomy` neither
  // "infra" nor "probe" — i.e. iff `deps.score` returned successfully for the attempt the
  // loop broke on. See the defensive check below for what happens if that invariant is ever
  // violated by a future edit.
  let scoreResult: ScoreResult | undefined;

  for (;;) {
    const attempt = await attemptOnce(inst, binaries, cfg, deps);
    stage = attempt.stage;
    taskSpentUsd += (stage.record.cost_usd ?? 0) + SETUP_COST_ESTIMATE_USD;
    scoreResult = undefined;

    if (!bypassOracle && stage.record.taxonomy !== "infra" && stage.record.taxonomy !== "probe") {
      try {
        scoreResult = await deps.score(inst, stage.diff);
      } catch (err) {
        // score() crash contract (Fix 1): the oracle is ground truth — a crash here means
        // NO trustworthy verdict was produced, so this is a real oracle/infra failure, not
        // a judgment-stage gap. Reclassifying as taxonomy:"infra" routes it through the
        // SAME infra-retry budget as a seed/run/collect failure (`canRetry` below), rather
        // than rejecting `runInstance` and silently discarding the attempt's telemetry (the
        // `runPool` catch's fresh-blank-record failure mode this fix closes).
        const message = err instanceof Error ? err.message : String(err);
        stage = {
          ...stage,
          record: {
            ...stage.record,
            taxonomy: "infra",
            status: `pipeline-error(score): ${message}`,
          },
        };
      }
    }

    const canRetry =
      stage.record.taxonomy === "infra" &&
      infraRetries < maxInfraRetries &&
      taskSpentUsd < cfg.perTaskCostCapUsd;
    if (canRetry) {
      infraRetries++;
      continue;
    }
    break;
  }

  if (stage.record.taxonomy === "infra") {
    return {
      ...base,
      ...stage.record,
      taxonomy: "infra",
      pr_opened: stage.pr_opened,
      infra_retries: infraRetries,
      cost_usd: taskSpentUsd,
    };
  }

  const withCollect: TaskRecord = {
    ...base,
    ...stage.record,
    pr_opened: stage.pr_opened,
    infra_retries: infraRetries,
    taxonomy: stage.record.taxonomy ?? base.taxonomy,
    cost_usd: taskSpentUsd,
  };

  if (stage.record.taxonomy === "probe") {
    return withCollect;
  }

  if (bypassOracle) {
    // SMOKE=2 Option-B: no oracle verdict was ever produced for this attempt (score/
    // run_self_test were both skipped above/below) — `resolved: null`, `taxonomy: "unscored"`
    // UNLESS `collect` already assigned a terminal taxonomy (e.g. "parked"/"loop-exhausted"),
    // which — same as the normal path below — is preserved as-is. detectLeak/blindQuality/
    // abReview still ran normally (they need ANTHROPIC + the diff, not the oracle), and
    // `self_test_passed` keeps collect's own approximation untouched (no `runSelfTest` call).
    const judgment = await runJudgmentStages(inst, stage, cfg, deps);
    return {
      ...withCollect,
      resolved: null,
      taxonomy: stage.record.taxonomy ?? "unscored",
      suspected_leak: judgment.suspectedLeak,
      leak_reasons: judgment.leakReasons,
      blind_quality: judgment.blindVerdict,
      ab_preference: judgment.abPreference,
      ab_notes: judgment.abNotes,
    };
  }

  if (!scoreResult) {
    // Defensive only — unreachable given the loop invariant above (taxonomy is neither
    // "infra" nor "probe" here, which the loop only allows once `deps.score` has already
    // returned successfully in that same iteration). Degrades to an infra record rather
    // than throwing, matching `runInstance`'s "never reject" contract (see `runPool`'s
    // catch, which exists purely as defense-in-depth against this function rejecting).
    return {
      ...withCollect,
      taxonomy: "infra",
      status:
        "pipeline-error(score): internal error — scoreResult missing for a non-infra/probe taxonomy",
    };
  }

  const resolved = scoreResult.resolved;
  const taxonomy = stage.record.taxonomy ?? (resolved ? "resolved" : "opened-but-unresolved");

  let selfTestPassed: boolean | null = withCollect.self_test_passed ?? null;
  if (stage.addedTestPaths.length > 0) {
    try {
      const selfTest = await deps.runSelfTest(inst, stage.diff, stage.addedTestPaths);
      selfTestPassed = selfTest.passed;
    } catch {
      // TRANSPORT ERROR contract (Task-11 crux, brief): never crash the pipeline, never
      // treat as passed. `null` matches run_self_test's own "nothing rigorous to report"
      // semantics for "no added test" — here it means "couldn't find out", not "no test".
      selfTestPassed = null;
    }
  }

  // JUDGMENT-STAGE-CRASH CONTRACT (Fix 1): `resolved`/`taxonomy` above are already final —
  // each judgment call inside `runJudgmentStages` is independently try/catch'd so a crash in
  // ONE never loses the oracle verdict, the diff, or the OTHER judges' signals.
  const judgment = await runJudgmentStages(inst, stage, cfg, deps);

  return {
    ...withCollect,
    resolved,
    taxonomy,
    self_test_passed: selfTestPassed,
    suspected_leak: judgment.suspectedLeak,
    leak_reasons: judgment.leakReasons,
    blind_quality: judgment.blindVerdict,
    ab_preference: judgment.abPreference,
    ab_notes: judgment.abNotes,
  };
}

// ---------------------------------------------------------------------------------------
// runPool: a small concurrency pool over runInstance + the runBudgetUsd kill-switch.
// ---------------------------------------------------------------------------------------

export interface RunPoolResult {
  records: TaskRecord[];
  spentUsd: number;
  budgetExceeded: boolean;
  /** Instances the kill-switch prevented from ever starting. */
  skipped: Instance[];
}

export interface RunPoolOpts {
  runInstance?: (
    inst: Instance,
    binaries: StyreBinaries,
    cfg: PipelineConfig,
    opts?: RunInstanceOpts,
  ) => Promise<TaskRecord>;
  runInstanceOpts?: RunInstanceOpts;
}

/**
 * Runs `instances` through `runInstance` (or `opts.runInstance`, for tests) using
 * `cfg.concurrency` concurrent workers, and respects `cfg.runBudgetUsd` as a KILL-SWITCH:
 * once the running total of `record.cost_usd` across FINISHED instances reaches or exceeds
 * `runBudgetUsd`, no worker starts another instance (in-flight instances still finish; the
 * switch only stops SCHEDULING new ones — matching the brief's "stop scheduling further
 * instances" wording, not an abort-in-flight semantic). A worker that recovers a rejected
 * `runInstance` call is a pure defense-in-depth measure — `runInstance` itself is designed to
 * never reject.
 */
export async function runPool(
  instances: Instance[],
  binaries: StyreBinaries,
  cfg: PipelineConfig,
  opts: RunPoolOpts = {},
): Promise<RunPoolResult> {
  const runInstanceFn = opts.runInstance ?? runInstance;
  const results: (TaskRecord | undefined)[] = new Array(instances.length).fill(undefined);
  let nextIndex = 0;
  let spentUsd = 0;
  let budgetExceeded = false;

  async function worker(): Promise<void> {
    for (;;) {
      if (budgetExceeded) return;
      const idx = nextIndex;
      if (idx >= instances.length) return;
      nextIndex += 1;
      const inst = instances[idx];
      if (!inst) return;

      let record: TaskRecord;
      try {
        record = await runInstanceFn(inst, binaries, cfg, opts.runInstanceOpts);
      } catch (err) {
        record = {
          ...blankRecord(inst, cfg),
          taxonomy: "infra",
          status: `pool-error: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
      results[idx] = record;
      spentUsd += record.cost_usd;
      if (spentUsd >= cfg.runBudgetUsd) budgetExceeded = true;
    }
  }

  const workerCount = Math.max(1, Math.min(cfg.concurrency, instances.length || 1));
  await Promise.all(Array.from({ length: workerCount }, () => worker()));

  const records = results.filter((r): r is TaskRecord => r !== undefined);
  const startedIds = new Set(records.map((r) => r.instance));
  const skipped = instances.filter((i) => !startedIds.has(i.id));

  return { records, spentUsd, budgetExceeded, skipped };
}

// ---------------------------------------------------------------------------------------
// runPilot: selectPilot -> buildStyre -> runPool -> renderReport -> write report/out/.
// ---------------------------------------------------------------------------------------

export interface RunPilotDeps {
  loadInstances: (family: Family, cfg: PipelineConfig) => Promise<Instance[]>;
  selectPilot: (pool: Instance[], seed: number) => Instance[];
  selectSmoke: (pool: Instance[], seed: number) => Instance[];
  buildStyre: (cfg: BuildStyreConfig) => Promise<BuildStyreResult>;
  runPool: (
    instances: Instance[],
    binaries: StyreBinaries,
    cfg: PipelineConfig,
    opts?: RunPoolOpts,
  ) => Promise<RunPoolResult>;
  renderReport: (records: TaskRecord[], meta: ReportMeta) => RenderReportResult;
  writeReport: (result: RenderReportResult, outDir: string) => Promise<void>;
}

async function defaultWriteReport(result: RenderReportResult, outDir: string): Promise<void> {
  await mkdir(outDir, { recursive: true });
  await Promise.all([
    writeFile(path.join(outDir, "report.md"), result.markdown, "utf8"),
    writeFile(path.join(outDir, "report.json"), JSON.stringify(result.json, null, 2), "utf8"),
  ]);
}

const defaultRunPilotDeps: RunPilotDeps = {
  loadInstances: (family, cfg) => loadInstances(family, cfg),
  selectPilot: (pool, seed) => selectPilot(pool, seed),
  selectSmoke: (pool, seed) => selectSmoke(pool, seed),
  buildStyre: (cfg) => buildStyre(cfg),
  runPool: (instances, binaries, cfg, opts) => runPool(instances, binaries, cfg, opts),
  renderReport: (records, meta) => renderReport(records, meta),
  writeReport: defaultWriteReport,
};

export interface RunPilotOpts {
  deps?: Partial<RunPilotDeps>;
  outDir?: string;
  /**
   * SMOKE mode: run exactly one ts + one python instance (easiest difficulty) instead of the
   * full 6-cell pilot. For the FIRST live run — a plumbing test of the Docker/claude/oracle
   * gate before trusting any pilot number. Driven by `SMOKE=1` (or `SMOKE=2`) at the
   * `bin/run-pilot.ts` entry.
   */
  smoke?: boolean;
  /** SMOKE=2 Option-B: threaded straight through to every `runInstance` call's
   *  `RunInstanceOpts.bypassOracle` (via `runPool`'s `runInstanceOpts`) — see that field's doc
   *  for what it skips/still runs. Independent of `smoke`, but `bin/run-pilot.ts` only ever
   *  sets both together (`SMOKE=2` implies smoke selection + bypass). */
  bypassOracle?: boolean;
}

/**
 * `selectPilot(loadInstances(...), cfg.seed)` -> `buildStyre(cfg)` -> `runPool` (map
 * `runInstance` at `cfg.concurrency`, respecting `cfg.runBudgetUsd`) -> `renderReport` ->
 * write to `report/out/` (default `opts.outDir`). The pinned Python corpus is
 * `cfg.pythonCorpus` (via the `"swe-bench"` family) and the TS corpus is `cfg.tsCorpus` (via
 * `"multi-swe-bench"`) — `loadInstances` (Task 2) itself resolves which pinned corpus id that
 * maps to.
 */
export async function runPilot(
  cfg: PipelineConfig,
  opts: RunPilotOpts = {},
): Promise<RenderReportResult> {
  const deps: RunPilotDeps = { ...defaultRunPilotDeps, ...opts.deps };
  const outDir = opts.outDir ?? path.join(process.cwd(), "report", "out");

  const [pythonPool, tsPool] = await Promise.all([
    deps.loadInstances("swe-bench", cfg),
    deps.loadInstances("multi-swe-bench", cfg),
  ]);
  const select = opts.smoke ? deps.selectSmoke : deps.selectPilot;
  const instances = select([...pythonPool, ...tsPool], cfg.seed);

  // Detect the DISTINCT container platforms this run actually needs (SWE-bench on an arm64
  // host -> linux/arm64; MSB -> linux/amd64) and cross-compile a styre binary for each. The
  // binary runs INSIDE the Linux eval container, so it must match that container's arch — a
  // host-arch (macOS) binary dies with "Cannot run macOS executable ... Exec format error".
  const platforms = [...new Set(instances.map((inst) => inst.platform ?? "linux/amd64"))];
  const targets = platforms.map((platform) => ({
    platform,
    bunTarget: bunLinuxTarget(archFromPlatform(platform)),
  }));

  const build = await deps.buildStyre({
    styreRepo: cfg.styreRepo,
    styreCommit: cfg.styreCommit,
    cohort: cfg.cohort,
    targets,
  });

  const poolResult = await deps.runPool(instances, build.binaries, cfg, {
    runInstanceOpts: { bypassOracle: opts.bypassOracle },
  });

  const meta: ReportMeta = {
    styreRef: `${cfg.cohort} @ ${build.commit}`,
    dataset: `${cfg.tsCorpus} + ${cfg.pythonCorpus}`,
    seed: cfg.seed,
    runDate: new Date().toISOString().slice(0, 10),
    budgetUsd: cfg.runBudgetUsd,
    spentUsd: poolResult.spentUsd,
    skippedCount: poolResult.skipped.length,
  };
  const report = deps.renderReport(poolResult.records, meta);
  await deps.writeReport(report, outDir);
  return report;
}
