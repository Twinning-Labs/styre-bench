import type { TicketFixOverlap } from "./firewall";
import type { LeakCheck } from "./leak-contract";

export type Cohort = "web-off" | "web-on";
export type Difficulty = "easy" | "medium" | "hard";
export interface Instance {
  id: string;
  language: "ts" | "python";
  difficulty: Difficulty;
  repo: string;
  base_commit: string;
  problem_statement: string;
  image: string; // pinned Docker image ref
  /** `docker run --platform` value for this instance's image, set by `corpus.ts`'s
   *  normalizers: SWE-bench (Python) uses the host-native arch (`linux/arm64` on Apple
   *  Silicon, else `linux/amd64`) to match its arch-in-the-name image; Multi-SWE-bench (TS)
   *  is always `linux/amd64` (amd64-only images). Optional only so test fixtures needn't set
   *  it — `run-task.ts`'s `buildDockerArgs` defaults an unset value to `linux/amd64`. */
  platform?: string;
  /** Absolute path the eval image has the repo pre-checked-out at, set by `corpus.ts`'s
   *  normalizers: SWE-bench (Python) uses `/testbed`; Multi-SWE-bench (TS) uses
   *  `/home/<repo>` (CONFIRMED against the multi-swe-bench harness — all 230 TS repo classes
   *  `cd /home/{repo}`, none use `/testbed` — and the live darkreader image). The entrypoint
   *  `cd`s here before `styre setup`, so a wrong value dies with "cd: <path>: No such file or
   *  directory". Optional only so fixtures needn't set it — `run-task.ts` defaults an unset
   *  value to `DEFAULT_REPO_DIR_IN_IMAGE` ("/testbed"). */
  repoDirInImage?: string;
  fail_to_pass: string[];
  pass_to_pass: string[];
  merge_date?: string; // ISO; for cutoff split
  fix_patch: string; // FIREWALL: the accepted human fix — scorer/reviewer ONLY, NEVER seeded/mounted into styre's env
  test_patch: string; // FIREWALL: the held-out regression tests — scorer ONLY, NEVER seeded/mounted into styre's env
  /** Multi-SWE-bench only: the raw record's `org`/`repo`/`number` fields, populated by
   *  `orchestrator/corpus.ts`'s `normalizeMultiSweBench` (which already reads all three to
   *  build the image tag) so `scorer/adapters/multiswebench.py`'s `MultiSweBenchAdapter`
   *  can consume them directly instead of fragilely re-parsing `id.rsplit("-", 1)`.
   *  Always `undefined` for SWE-bench (Python) instances — `normalizeSweBench` never sets
   *  them. */
  org?: string;
  repo_name?: string;
  pr_number?: number;
}
export interface OracleProfile {
  id: string;
  minimum_timeout_ms: number;
  image_id: string;
  preload_sha256: string;
  evidence_path: string;
}

/** Evidence from the oracle; null means a required control was not measured. */
export interface OracleControls {
  oracle_profile?: OracleProfile;
  base_preserved?: boolean;
  base_pass_to_pass?: Record<string, boolean>;
  gold_resolved: boolean | null;
  base_fails: boolean | null;
  deterministic: boolean | null;
  base_provenance?: "not-measured" | "independent";
  gold_runs?: OracleScore[];
  base_report_path?: string;
  base_error?: string;
  base_fail_to_pass?: Record<string, "passed" | "failed">;
}

export interface OracleScore {
  oracle_profile?: OracleProfile;
  harness_report_path?: string;
  resolved: boolean | null;
  fail_to_pass: Record<string, boolean>;
  pass_to_pass: Record<string, boolean>;
  measurement_error?: { origin: "unknown"; detail: string };
}

export interface TaskRecord {
  oracle_profile?: OracleProfile;
  instance: string;
  language: "ts" | "python";
  difficulty: Difficulty;
  styre_commit: string;
  cohort: Cohort;
  post_cutoff: boolean | null;
  /** A boolean only after a candidate oracle measurement; null on every unmeasured path. */
  resolved: boolean | null;
  /** GROUND TRUTH (CLAUDE.md move 5): whether a pull request actually exists on the seeded
   *  throwaway repo, read from the forge by `pipeline.ts`'s `lookupPrOpened`.
   *
   *  `null` iff THE LOOKUP COULD NOT FIND OUT (no token, an API failure, or collect threw
   *  before reaching it). That is a different claim from `false` ("we looked; there is no
   *  PR"), and the two must never be collapsed: for two consecutive matrices a failing
   *  `git clone` inside the old lookup was swallowed into `false`, and the report published
   *  a PR-opened rate of 0% and a self-report gap of 0/2 for a run that demonstrably opened
   *  a PR. `report/render.ts` drops `null` from BOTH the numerator and the denominator —
   *  the same rule `ticket_fix_overlap` already follows. */
  pr_opened: boolean | null;
  /** SELF-REPORT: whether styre's own terminal `outcome` claims a PR (`pr-ready` / `done`),
   *  derived in `collect.ts` from the summary event. `null` iff no summary was emitted at
   *  all, so styre made no claim either way.
   *
   *  Kept BESIDE `pr_opened` rather than replacing it: the forge is the ground truth, and
   *  this is the claim being checked against it. Their disagreement is a first-class finding
   *  (`report/render.ts`'s `isPrReportDisagreement`) — had it been reported, the `pr_opened`
   *  defect would have announced itself in matrix #1 instead of being found by hand in #2. */
  pr_self_reported: boolean | null;
  /** Why `pr_opened` is `null` — the swallowed reason, made visible. `null` when the lookup
   *  succeeded. */
  pr_lookup_error: string | null;
  self_authored_test: boolean | null;
  self_test_passed: boolean | null;
  ticks: number;
  cycle_count: number;
  escalation_count: number;
  escalation_reasons: string[];
  outcome: string;
  status: string;
  exit_code: number;
  parked: boolean;
  /** Measured USD, recovered from the run transcript (`usage.ts`, ENG-390). `null` means
   *  UNKNOWN — no transcript, or no `result` event carried a cost. NEVER coerce to `0`:
   *  "not measured" and "free" are different claims, and conflating them is exactly what
   *  let a $11.84 run report $0.50 and made the run budget unable to fire. */
  cost_usd_measured: number | null;
  /** Fallback estimate, charged ONLY when no measured cost could be recovered. Kept separate
   *  so an estimate is never rendered as though it were a measurement. */
  cost_usd_estimated: number;
  tokens_in: number | null;
  tokens_out: number | null;
  /** Absolute path to this attempt's durable evidence dir (ENG-393) — the sot.db/transcript/
   *  profile/ndjson for this run. `null` when the container never ran. */
  evidence_dir: string | null;
  blind_quality: string | null;
  ab_preference: "A(styre)" | "B(human)" | "tie" | "invalid" | null;
  ab_notes: string | null;
  /** Compatibility heuristic flag, never proof of solution exposure; null if not assessed. */
  suspected_leak: boolean | null;
  leak_check?: LeakCheck;
  /** Preserved original assessment when an offline transcript scan supersedes its interpretation. */
  prior_leak_assessment?: { suspected: boolean | null; reasons: string[] };
  reporting_notes?: string[];
  test_configuration?: { status: "declared" | "none"; components: string[] };
  leak_reasons: string[]; // from detect_leak; canonical bare values (exact-match, never a formatted/suffixed variant): "high-similarity" | "high-containment" | "containment-uninformative" | "web-tool-used" | "pr-url-in-transcript" | "url-in-transcript" | "transcript-unavailable" | "transcript-unstructured-scan" | "similarity-unavailable" — Task 10 validity panel needs this to state whether the URL-scan ran. Issue/PR numbers the HARNESS supplied (via `instance_id` or the problem statement, which for MSB is the upstream PR body) are excused — repeating an identifier you were handed is not evidence of looking one up. NOTE: "containment-uninformative" and "transcript-unstructured-scan" report that a signal could not be assessed; like "transcript-unavailable"/"similarity-unavailable" they never set `suspected` on their own
  /** Free string, not a closed union — see `report/render.ts`'s `TAXONOMY_ORDER` /
   *  measurement contracts for the canonical known values: "resolved" |
   *  "opened-but-unresolved" | "loop-exhausted" | "probe" | "parked" | "infra" |
   *  "dropped-gold-unresolved" | "dropped-base-passes" | "dropped-flaky" | "unscored"
   *  (SMOKE=2 Option-B oracle-bypass — a successful bypass run with no oracle verdict;
   *  `resolved` is `null` on these records).
   *
   *  ENG-413: the three `dropped-*` values were one `dropped-flaky`. The controls answer three
   *  unrelated questions and only ONE of them is flakiness, so collapsing them put a false
   *  statement in the record: sphinx-doc__sphinx-7590 was reported flaky when its determinism
   *  control PASSED and the human's own fix simply did not resolve the instance. */
  taxonomy: string;
  /** ENG-443: retain oracle control provenance and repeated results on every qualified/dropped run.
   *  Recovering these after the fact cost a full image build and a re-run, because the
   *  booleans were tested and then discarded. */
  controls?: OracleControls;
  /** A candidate was produced but has no trustworthy score; never silently infra-excluded. */
  oracle_error?: { origin: "unknown"; detail: string };
  /** True once a collected candidate is submitted, regardless of its verdict or run taxonomy. */
  score_attempted?: boolean;
  /** Scorer retries reuse the collected diff and never spend another agent attempt. */
  scorer_retries?: number;
  /** Host-side lexical overlap with added patch lines, not a solution exposure judgment.
   *  The optional method distinguishes historical substring matching from exact-line v2.
   *  null/absent means unmeasured, never zero. Zero matches defines only a lexical subset. */
  ticket_fix_overlap?: TicketFixOverlap | null;
  /** Task 11: count of whole-instance infra-retries consumed before this record was
   *  finalized (0 if none). Optional/additive — pre-Task-11 code (e.g. report.test.ts's
   *  hand-built fixtures) never sets this and remains valid; `renderReport` does not read
   *  it today. */
  infra_retries?: number;
}

/** Coverage is recorded by the detector, never inferred from absence of findings. */
export interface TranscriptScan {
  status: "complete" | "partial" | "unstructured" | "unavailable";
  assistant_messages: number;
  unparsed_lines: number;
  unknown_entries: number;
}
